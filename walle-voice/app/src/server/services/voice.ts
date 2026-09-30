/**
 * Speech services for the WALL-E remote.
 *
 * The robot firmware deliberately has no microphone and no speaker (the I2S
 * pins were freed on the S3), so voice lives on the ESP32-WROOM remote
 * instead. The remote has no room for a speech model, and no business
 * holding an API key, so it uploads raw PCM here and this service does the
 * work. Same rule as the Gemini key: it never leaves the server process.
 *
 * Two services, deliberately separate, because they are separate providers:
 *   - SttService  speech -> text   (Groq Whisper, or OpenAI Whisper)
 *   - TtsService  text  -> speech  (OpenAI only; Groq has no speech endpoint)
 *
 * Both are built to the ESP32's ability to receive audio, not a browser's:
 * raw signed 16-bit little-endian PCM, so the firmware can hand the bytes
 * straight to i2s_write() without decoding MP3 or WAV.
 */

import type { RobotStatus } from "../../shared/protocol.js";

/** Recording format: what the remote's INMP441 produces. */
export const STT_SAMPLE_RATE = 16000;
/** Playback format: what OpenAI `response_format: "pcm"` returns. */
export const TTS_SAMPLE_RATE = 24000;

/** One second of 16 kHz mono PCM16, the floor for any usable utterance. */
const MIN_SAMPLES = STT_SAMPLE_RATE;

/** Below this peak amplitude we treat a clip as silence. See isSilent(). */
const SILENCE_PEAK = 300;

export interface SttResult {
  text: string;
  provider: string;
  ms: number;
}

export interface TtsResult {
  /** Raw PCM16 chunks, ready to stream to the speaker. */
  audio: Buffer;
  sampleRate: number;
  voice: string;
  provider: string;
}

/**
 * Peak amplitude of a PCM16 buffer.
 *
 * Reads a strided sample of the clip rather than every byte: a peak check
 * only needs to be representative, and scanning 256 kB per request in JS
 * is wasteful.
 */
export function peakAmplitude(pcm: Buffer): number {
  if (pcm.length < 2) return 0;
  const samples = Math.floor(pcm.length / 2);
  const step = Math.max(1, Math.floor(samples / 4000));
  let peak = 0;
  for (let i = 0; i < samples; i += step) {
    const v = pcm.readInt16LE(i * 2);
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * True when the clip is effectively digital silence.
 *
 * Whisper will happily invent a confident, fluent sentence out of near
 * silence, which is far worse than saying nothing: the robot would drive off
 * talking to a hallucination. The firmware's own voice-activity check is the
 * first gate, this is the second.
 */
export function isSilent(pcm: Buffer): boolean {
  return peakAmplitude(pcm) < SILENCE_PEAK;
}

/**
 * Wrap raw little-endian PCM16 in a minimal 44-byte WAV container.
 *
 * The transcription APIs only accept a real audio file, and building the
 * header here avoids pulling in a dependency for a fixed-size struct.
 */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/* ------------------------------------------------------------------ *
 * Speech to text
 * ------------------------------------------------------------------ */

export interface SttOptions {
  /** "groq" or "openai". */
  provider: string;
  groqApiKey?: string;
  openaiApiKey?: string;
  model: string;
  timeoutMs: number;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class SttService {
  constructor(private readonly opts: SttOptions) {}

  get available(): boolean {
    return this.opts.provider === "groq" ? Boolean(this.opts.groqApiKey) : Boolean(this.opts.openaiApiKey);
  }

  async transcribe(pcm: Buffer, sampleRate = STT_SAMPLE_RATE): Promise<SttResult> {
    const started = Date.now();
    const key = this.opts.provider === "groq" ? this.opts.groqApiKey : this.opts.openaiApiKey;
    if (!key) {
      throw new Error(
        this.opts.provider === "groq"
          ? "STT_PROVIDER is groq but GROQ_API_KEY is empty"
          : "STT_PROVIDER is openai but OPENAI_API_KEY is empty",
      );
    }

    const doFetch = this.opts.fetchImpl ?? fetch;
    const base = this.opts.provider === "groq" ? "https://api.groq.com/openai/v1" : "https://api.openai.com/v1";
    const wav = pcmToWav(pcm, sampleRate);

    const form = new FormData();
    // The Blob has to be labelled audio/wav or the provider rejects it.
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
    form.append("model", this.opts.model);
    form.append("language", "en");

    const res = await doFetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const body = (await res.json()) as { text?: string };
    return {
      text: (body.text ?? "").trim(),
      provider: this.opts.provider,
      ms: Date.now() - started,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Text to speech
 * ------------------------------------------------------------------ */

export interface TtsOptions {
  model: string;
  voice: string;
  openaiApiKey?: string;
  speed: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class TtsService {
  constructor(private readonly opts: TtsOptions) {}

  get available(): boolean {
    return Boolean(this.opts.openaiApiKey);
  }

  async synthesize(text: string): Promise<TtsResult> {
    if (!this.opts.openaiApiKey) {
      throw new Error("TTS needs OPENAI_API_KEY. GROQ_API_KEY alone only covers speech-to-text.");
    }
    const doFetch = this.opts.fetchImpl ?? fetch;

    const res = await doFetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.openaiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.opts.model,
        voice: this.opts.voice,
        input: text,
        // 24 kHz mono PCM16, which is exactly what the remote's I2S
        // driver wants. MP3 would mean an MP3 decoder on the firmware.
        response_format: "pcm",
        speed: this.opts.speed,
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    return {
      audio: Buffer.from(await res.arrayBuffer()),
      sampleRate: TTS_SAMPLE_RATE,
      voice: this.opts.voice,
      provider: "openai",
    };
  }
}

/* ------------------------------------------------------------------ *
 * The conversation turn
 * ------------------------------------------------------------------ */

export interface VoiceTurn {
  transcript: string;
  reply: string;
  provider: string;
  ms: number;
}

/**
 * What the remote asks for: "hear this, say something back".
 *
 * The reply is produced by the same Gemini service the web UI uses, so the
 * robot keeps one personality no matter whether the question arrived from a
 * browser or from the handheld remote.
 */
export async function runVoiceTurn(
  stt: SttService,
  ask: (transcript: string, status?: Partial<RobotStatus>) => Promise<string>,
  pcm: Buffer,
  sampleRate = STT_SAMPLE_RATE,
): Promise<VoiceTurn> {
  const started = Date.now();
  const { text, provider } = await stt.transcribe(pcm, sampleRate);
  if (!text) {
    throw new Error("no speech recognised");
  }
  const reply = await ask(text);
  return { transcript: text, reply, provider, ms: Date.now() - started };
}

export { MIN_SAMPLES };
