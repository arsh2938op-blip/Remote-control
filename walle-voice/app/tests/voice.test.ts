import { describe, expect, it, vi } from "vitest";
import {
  SttService,
  TtsService,
  pcmToWav,
  isSilent,
  peakAmplitude,
  runVoiceTurn,
  STT_SAMPLE_RATE,
  TTS_SAMPLE_RATE,
} from "../src/server/services/voice.js";

/** One second of PCM16 at 16 kHz, `amplitude` peak or silence. */
function pcm(seconds: number, amplitude: number, rate = STT_SAMPLE_RATE): Buffer {
  const n = Math.floor(rate * seconds);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    // a slow triangle so it is not a pure DC block
    const v = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / rate));
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("pcmToWav", () => {
  it("writes a valid 44 byte RIFF/WAVE header", () => {
    const data = pcm(0.5, 8000);
    const wav = pcmToWav(data, STT_SAMPLE_RATE);

    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(wav.readUInt32LE(16)).toBe(16); // PCM fmt chunk
    expect(wav.readUInt16LE(20)).toBe(1); // uncompressed PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(STT_SAMPLE_RATE);
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
  });

  it("declares sizes that match the payload it carries", () => {
    const data = pcm(0.5, 8000);
    const wav = pcmToWav(data, STT_SAMPLE_RATE);

    expect(wav.readUInt32LE(4)).toBe(36 + data.length); // RIFF size
    expect(wav.readUInt32LE(40)).toBe(data.length); // data size
    expect(wav.length).toBe(44 + data.length);
  });
});

describe("silence detection", () => {
  it("treats digital silence as silence", () => {
    expect(isSilent(Buffer.alloc(16000 * 2))).toBe(true);
  });

  it("treats real speech level audio as speech", () => {
    expect(isSilent(pcm(1, 8000))).toBe(false);
  });

  it("treats a very quiet clip as silence", () => {
    // Whisper invents a confident sentence from near-silence, which is far
    // worse than refusing, so the gate has to catch low-level noise too.
    expect(isSilent(pcm(1, 40))).toBe(true);
  });

  it("reports the peak amplitude", () => {
    expect(peakAmplitude(pcm(1, 5000))).toBeGreaterThan(4500);
    expect(peakAmplitude(Buffer.alloc(0))).toBe(0);
  });
});

describe("SttService", () => {
  it("posts the audio as a wav and returns the transcript", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: "  hello wall-e  " }));
    const stt = new SttService({
      provider: "groq",
      groqApiKey: "test-key",
      model: "whisper-large-v3-turbo",
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await stt.transcribe(pcm(1, 8000));

    expect(result.text).toBe("hello wall-e"); // trimmed
    expect(result.provider).toBe("groq");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("api.groq.com");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    const form = init.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("speech.wav");
    expect(file.type).toBe("audio/wav");
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
  });

  it("surfaces the provider error rather than returning empty text", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const stt = new SttService({
      provider: "groq",
      groqApiKey: "test-key",
      model: "whisper-large-v3-turbo",
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(stt.transcribe(pcm(1, 8000))).rejects.toThrow(/STT HTTP 429/);
  });

  it("refuses to run without a key instead of calling out", async () => {
    const stt = new SttService({ provider: "groq", model: "whisper-large-v3-turbo", timeoutMs: 1000 });
    expect(stt.available).toBe(false);
    await expect(stt.transcribe(pcm(1, 8000))).rejects.toThrow(/GROQ_API_KEY is empty/);
  });
});

describe("TtsService", () => {
  it("asks for raw pcm and returns the audio", async () => {
    const audio = Buffer.alloc(4800 * 2, 7);
    const fetchImpl = vi.fn(async () => new Response(audio, { status: 200 }));
    const tts = new TtsService({
      model: "tts-1",
      voice: "onyx",
      openaiApiKey: "test-key",
      speed: 1,
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await tts.synthesize("beep boop");

    expect(result.audio.equals(audio)).toBe(true);
    expect(result.sampleRate).toBe(TTS_SAMPLE_RATE);

    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    // PCM, not MP3: the firmware has no MP3 decoder and feeds I2S directly.
    expect(body.response_format).toBe("pcm");
    expect(body.voice).toBe("onyx");
    expect(body.input).toBe("beep boop");
  });

  it("explains that Groq cannot do speech", async () => {
    const tts = new TtsService({ model: "tts-1", voice: "onyx", speed: 1, timeoutMs: 1000 });
    expect(tts.available).toBe(false);
    await expect(tts.synthesize("hi")).rejects.toThrow(/OPENAI_API_KEY/);
  });
});

describe("runVoiceTurn", () => {
  it("transcribes, then answers with the transcript's reply", async () => {
    const stt = new SttService({
      provider: "groq",
      groqApiKey: "test-key",
      model: "whisper-large-v3-turbo",
      timeoutMs: 1000,
      fetchImpl: (async () => jsonResponse({ text: "what is your name" })) as unknown as typeof fetch,
    });

    const turn = await runVoiceTurn(stt, async (t) => `heard: ${t}`, pcm(1, 8000));

    expect(turn.transcript).toBe("what is your name");
    expect(turn.reply).toBe("heard: what is your name");
  });

  it("fails loudly when nothing was recognised", async () => {
    const stt = new SttService({
      provider: "groq",
      groqApiKey: "test-key",
      model: "whisper-large-v3-turbo",
      timeoutMs: 1000,
      fetchImpl: (async () => jsonResponse({ text: "   " })) as unknown as typeof fetch,
    });

    // An empty transcript must not become a fabricated answer.
    await expect(runVoiceTurn(stt, async () => "should not run", pcm(1, 8000))).rejects.toThrow(
      /no speech recognised/,
    );
  });
});
