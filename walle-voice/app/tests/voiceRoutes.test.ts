import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createAppServer } from "../src/server/appServer.js";
import { loadConfig, type AppConfig } from "../src/server/config.js";
import type { AppServer } from "../src/server/appServer.js";

/**
 * HTTP-level tests for the voice endpoints the ESP32-WROOM remote calls.
 *
 * These exist because the unit tests in voice.test.ts only cover the
 * service objects. A handler registered as a bare method reference
 * (`this.app.post(p, this.handler)`) loses its `this` binding and throws
 * a TypeError on the first real request - which typechecking does not
 * catch and a service-level test never reaches. So these go over real
 * HTTP against a listening server.
 */

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig(),
    port: 0,
    host: "127.0.0.1",
    appToken: "test-token",
    robotToken: undefined,
    geminiApiKey: undefined,
    stt: { provider: "openai", model: "whisper-1", timeoutMs: 500 },
    tts: { model: "tts-1", voice: "onyx", speed: 1, timeoutMs: 500 },
    groqApiKey: undefined,
    voiceToken: undefined,
    requestTimeoutMs: 1000,
    discovery: { enabled: false, timeoutMs: 50 },
    rateLimit: { windowMs: 1000, maxCommands: 500 },
    demoMode: false,
    lastKnownHost: null,
    ...overrides,
  };
}

/** One second of 16 kHz PCM16 with a real waveform in it. */
function speechPcm(seconds = 1, amplitude = 8000): Buffer {
  const n = 16000 * seconds;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / 16000)), i * 2);
  }
  return buf;
}

/**
 * fetch()'s BodyInit does not accept a Node Buffer, and a Uint8Array over
 * a SharedArrayBuffer is still rejected by the type. Copying into a plain
 * ArrayBuffer sidesteps both, and these payloads are small.
 */
function asBody(buf: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return copy;
}

describe("voice HTTP endpoints", () => {
  let server: AppServer;
  let base: string;

  beforeAll(async () => {
    server = createAppServer(testConfig());
    await server.start();
    base = `http://127.0.0.1:${server.boundPort}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  it("serves capabilities so the remote can check before talking", async () => {
    const res = await fetch(`${base}/api/voice/capabilities`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      stt: { sampleRate?: number; available: boolean };
      sttSampleRate: number;
      ttsSampleRate: number;
      authRequired: boolean;
    };
    // These two rates are the contract with the firmware's I2S config.
    expect(body.sttSampleRate).toBe(16000);
    expect(body.ttsSampleRate).toBe(24000);
    expect(body.authRequired).toBe(false);
  });

  it("answers /api/voice/stt instead of crashing on `this`", async () => {
    // With no keys configured this cannot succeed, but it MUST come back as
    // a well-formed 502. A TypeError here means the handler lost its
    // binding and the process would have died.
    const res = await fetch(`${base}/api/voice/stt?rate=16000`, {
      method: "POST",
      headers: { "content-type": "audio/pcm" },
      body: asBody(speechPcm()),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/API_KEY/);
  });

  it("rejects too little audio with 400", async () => {
    const res = await fetch(`${base}/api/voice/stt?rate=16000`, {
      method: "POST",
      headers: { "content-type": "audio/pcm" },
      body: asBody(Buffer.alloc(1000)),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/too little audio/);
  });

  it("rejects silence with 422 before spending an API call", async () => {
    const res = await fetch(`${base}/api/voice/stt?rate=16000`, {
      method: "POST",
      headers: { "content-type": "audio/pcm" },
      body: asBody(Buffer.alloc(16000 * 2)), // a full second of zeros
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/silence/);
  });

  it("requires the token when one is configured", async () => {
    const guarded = createAppServer(testConfig({ voiceToken: "s3cret" }));
    await guarded.start();
    const url = `http://127.0.0.1:${guarded.boundPort}`;

    const denied = await fetch(`${url}/api/voice/stt`, {
      method: "POST",
      headers: { "content-type": "audio/pcm" },
      body: asBody(speechPcm()),
    });
    expect(denied.status).toBe(401);

    const allowed = await fetch(`${url}/api/voice/stt`, {
      method: "POST",
      headers: { "content-type": "audio/pcm", "x-walle-voice-token": "s3cret" },
      body: asBody(speechPcm()),
    });
    // Past the auth check now, so it fails later, on the missing key.
    expect(allowed.status).toBe(502);

    await guarded.stop();
  });

  it("requires text on /api/voice/tts", async () => {
    const res = await fetch(`${base}/api/voice/tts`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/missing \?text=/);
  });

  it("reports the missing TTS key as 502 with a clear message", async () => {
    const res = await fetch(`${base}/api/voice/tts?text=hello`);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/OPENAI_API_KEY/);
  });
});

