import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createAppServer } from "../src/server/appServer.js";
import { loadConfig, type AppConfig } from "../src/server/config.js";
import { SettingsStore, DEFAULT_SETTINGS } from "../src/server/storage/settingsStore.js";
import { GEMINI_KEY_SENTINEL } from "./helpers.js";
import WebSocket from "ws";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../src/shared/protocol.js";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig(),
    port: 0,
    host: "127.0.0.1",
    appToken: "test-token",
    robotToken: undefined,
    geminiApiKey: undefined,
    stt: { provider: "openai", model: "whisper-1", timeoutMs: 2000 },
    tts: { model: "tts-1", voice: "onyx", speed: 1, timeoutMs: 2000 },
    groqApiKey: undefined,
    voiceToken: undefined,
    requestTimeoutMs: 2000,
    discovery: { enabled: false, timeoutMs: 100 },
    rateLimit: { windowMs: 1000, maxCommands: 200 },
    demoMode: false,
    lastKnownHost: null,
    ...overrides,
  };
}

/**
 * Connect an app client to the server's /ws endpoint.
 *
 * The message listener is attached synchronously at construction so the
 * server's immediate state/robots/activity frames are never missed — the app
 * does not wait for a client to announce itself before pushing.
 */
function openAppSocket(port: number, token = "test-token"): Promise<{ ws: WebSocket; msgs: ServerMessage[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const msgs = collect(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, msgs }));
    ws.once("error", reject);
  });
}

function collect(ws: WebSocket): ServerMessage[] {
  const msgs: ServerMessage[] = [];
  ws.on("message", (raw) => {
    try {
      msgs.push(JSON.parse(raw.toString()) as ServerMessage);
    } catch {
      /* ignore */
    }
  });
  return msgs;
}

async function until<T>(fn: () => T | undefined | false, timeoutMs = 4000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

describe("AppServer in demo mode", () => {
  let server: ReturnType<typeof createAppServer>;
  let port: number;
  let tmp: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "walle-test-"));
    const config = testConfig();
    // Point settings at a temp dir so tests never touch the real .walle folder.
    process.env.WALLE_APP_TOKEN = "test-token";
    server = createAppServer(config);
    (server as unknown as { settings: SettingsStore }).settings = new SettingsStore(join(tmp, "settings.json"));
    await server.start();
    await server.startDemoMode();
    port = (server as unknown as { http: { address(): { port: number } } }).http.address().port;
  });

  afterAll(async () => {
    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects an app socket with the wrong token", async () => {
    await expect(openAppSocket(port, "wrong")).rejects.toBeTruthy();
  });

  it("connects an app client and reports robot state", async () => {
    const { ws, msgs } = await openAppSocket(port);
    await until(() => msgs.find((m) => m.type === "server_state"));
    const state = msgs.find((m) => m.type === "server_state");
    expect(state).toBeDefined();
    if (state?.type !== "server_state") return;
    expect(state.demoMode).toBe(true);
    expect(state.target?.source).toBe("demo");
    ws.close();
  });

  it("reaches connected state against the simulated robot", async () => {
    const { ws, msgs } = await openAppSocket(port);
    const state = await until(() => {
      const s = [...msgs].reverse().find((m) => m.type === "server_state");
      return s && s.type === "server_state" && s.connection === "connected" ? s : undefined;
    }, 6000);
    expect(state).toBeDefined();
    ws.close();
  });

  it("sends a movement command and receives movement events", async () => {
    const { ws, msgs } = await openAppSocket(port);
    await until(() => {
      const s = [...msgs].reverse().find((m) => m.type === "server_state");
      return s?.type === "server_state" && s.connection === "connected";
    }, 6000);

    ws.send(
      JSON.stringify({
        type: "command",
        v: 1,
        command: "move_forward",
        requestId: "t-move-1",
        payload: { duration: 200, speed: 0.5 },
        timestamp: Date.now(),
      }),
    );

    const started = await until(
      () => msgs.find((m) => m.type === "activity" && m.entry.label === "movement_started"),
      5000,
    );
    expect(started).toBeDefined();
    if (started?.type !== "activity") return;
    expect(started.entry.requestId).toBe("t-move-1");
    ws.close();
  });

  it("stops movement on the stop command", async () => {
    const { ws, msgs } = await openAppSocket(port);
    await until(() => {
      const s = [...msgs].reverse().find((m) => m.type === "server_state");
      return s?.type === "server_state" && s.connection === "connected";
    }, 6000);

    ws.send(
      JSON.stringify({
        type: "command",
        v: 1,
        command: "move_forward",
        requestId: "t-move-2",
        payload: { duration: 5000 },
        timestamp: Date.now(),
      }),
    );
    await until(() => msgs.find((m) => m.type === "activity" && m.entry.label === "movement_started"), 4000);

    ws.send(
      JSON.stringify({
        type: "command",
        v: 1,
        command: "stop",
        requestId: "t-stop-1",
        payload: {},
        timestamp: Date.now(),
      }),
    );
    const stopped = await until(() => {
      const stops = msgs.filter((m) => m.type === "activity" && m.entry.label === "movement_stopped");
      return stops.find((s) => s.type === "activity" && s.entry.detail === "command");
    }, 4000);
    expect(stopped).toBeDefined();
    ws.close();
  });

  it("triggers a dance and reports the events", async () => {
    const { ws, msgs } = await openAppSocket(port);
    await until(() => {
      const s = [...msgs].reverse().find((m) => m.type === "server_state");
      return s?.type === "server_state" && s.connection === "connected";
    }, 6000);

    ws.send(
      JSON.stringify({
        type: "command",
        v: 1,
        command: "dance",
        requestId: "t-dance-1",
        payload: {},
        timestamp: Date.now(),
      }),
    );
    expect(await until(() => msgs.find((m) => m.type === "activity" && m.entry.label === "dance_started"), 4000)).toBeDefined();
    expect(await until(() => msgs.find((m) => m.type === "activity" && m.entry.label === "dance_finished"), 6000)).toBeDefined();
    ws.close();
  });

  it("toggles autonomous mode", async () => {
    const { ws, msgs } = await openAppSocket(port);
    await until(() => {
      const s = [...msgs].reverse().find((m) => m.type === "server_state");
      return s?.type === "server_state" && s.connection === "connected";
    }, 6000);

    ws.send(
      JSON.stringify({
        type: "command",
        v: 1,
        command: "set_autonomous",
        requestId: "t-auto-1",
        payload: { enabled: true },
        timestamp: Date.now(),
      }),
    );
    const ev = await until(() => msgs.find((m) => m.type === "activity" && m.entry.label === "autonomous_changed"), 4000);
    expect(ev).toBeDefined();

    const state = await until(() => {
      const s = [...msgs].reverse().find((m) => m.type === "server_state");
      return s?.type === "server_state" && s.status?.autonomous === true ? s : undefined;
    }, 4000);
    expect(state).toBeDefined();
    ws.close();
  });

  it("answers chat with an offline reply when no key is configured", async () => {
    const { ws, msgs } = await openAppSocket(port);

    ws.send(
      JSON.stringify({
        type: "command",
        v: 1,
        command: "ask",
        requestId: "t-ask-1",
        payload: { text: "Tell me a joke." },
        timestamp: Date.now(),
      }),
    );
    // `ask` is answered by the companion server, so it must not require a
    // connected robot.
    const reply = await until(
      () => msgs.find((m) => m.type === "activity" && m.entry.label === "WALL-E" && m.entry.detail),
      5000,
    );
    expect(reply).toBeDefined();
    if (reply?.type !== "activity") return;
    expect(reply.entry.detail).toMatch(/cross the road|Beep boop/i);
    ws.close();
  });

  it("rejects an unknown command and does not forward it", async () => {
    const { ws, msgs } = await openAppSocket(port);
    ws.send(
      JSON.stringify({
        type: "command",
        v: 1,
        command: "self_destruct",
        requestId: "t-bad-1",
        payload: {},
        timestamp: Date.now(),
      }),
    );
    const err = await until(
      () => msgs.find((m) => m.type === "activity" && m.entry.level === "error"),
      3000,
    );
    expect(err).toBeDefined();
    ws.close();
  });

  it("ignores a malformed client frame instead of crashing", async () => {
    const { ws } = await openAppSocket(port);
    expect(() => ws.send("{{{ not json")).not.toThrow();
    await new Promise((r) => setTimeout(r, 200));
    ws.send(
      JSON.stringify({
        type: "command",
        v: 1,
        command: "ping",
        requestId: "t-after-junk",
        payload: {},
        timestamp: Date.now(),
      }),
    );
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("reconnects after the robot goes away", async () => {
    const { ws, msgs } = await openAppSocket(port);
    await until(() => {
      const s = [...msgs].reverse().find((m) => m.type === "server_state");
      return s?.type === "server_state" && s.connection === "connected";
    }, 6000);

    // Kill the simulated robot out from under the link.
    await server.stopDemoMode();
    const offline = await until(() => {
      const s = [...msgs].reverse().find((m) => m.type === "server_state");
      return s?.type === "server_state" && s.connection === "disconnected" ? s : undefined;
    }, 5000);
    expect(offline).toBeDefined();

    await server.startDemoMode();
    const back = await until(() => {
      const s = [...msgs].reverse().find((m) => m.type === "server_state");
      return s?.type === "server_state" && s.connection === "connected" ? s : undefined;
    }, 8000);
    expect(back).toBeDefined();
    ws.close();
  });
});

describe("API key isolation", () => {
  let server: ReturnType<typeof createAppServer>;
  let base: string;
  let tmp: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "walle-key-"));
    server = createAppServer(testConfig({ geminiApiKey: GEMINI_KEY_SENTINEL }));
    (server as unknown as { settings: SettingsStore }).settings = new SettingsStore(join(tmp, "settings.json"));
    await server.start();
    await server.startDemoMode();
    const port = (server as unknown as { http: { address(): { port: number } } }).http.address().port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps the Gemini key out of every app-facing payload", async () => {
    const { ws, msgs } = await openAppSocket(Number(new URL(base).port));

    for (const cmd of [
      { command: "ask", payload: { text: "Tell me a joke." } },
      { command: "get_status", payload: {} },
      { command: "set_autonomous", payload: { enabled: true } },
      { command: "dance", payload: {} },
    ]) {
      ws.send(
        JSON.stringify({
          type: "command",
          v: 1,
          ...cmd,
          requestId: `k-${cmd.command}`,
          timestamp: Date.now(),
        }),
      );
    }
    await new Promise((r) => setTimeout(r, 1200));
    expect(JSON.stringify(msgs)).not.toContain(GEMINI_KEY_SENTINEL);

    for (const path of ["/api/state", "/api/settings", "/api/config", "/api/activity", "/api/health"]) {
      const text = await (await fetch(`${base}${path}`)).text();
      expect(text, `leak in ${path}`).not.toContain(GEMINI_KEY_SENTINEL);
    }
    ws.close();
  });
});

describe("AppServer HTTP surface", () => {
  let server: ReturnType<typeof createAppServer>;
  let base: string;
  let tmp: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "walle-http-"));
    server = createAppServer(testConfig());
    (server as unknown as { settings: SettingsStore }).settings = new SettingsStore(join(tmp, "settings.json"));
    await server.start();
    const port = (server as unknown as { http: { address(): { port: number } } }).http.address().port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports health", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.ok).toBe(true);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("issues an app socket token to a same-origin request", async () => {
    const res = await fetch(`${base}/api/session`, { headers: { origin: base } });
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBe("test-token");
  });

  it("refuses a cross-origin session request", async () => {
    const res = await fetch(`${base}/api/session`, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("accepts a WebSocket upgrade carrying the issued token", async () => {
    const { token } = (await (await fetch(`${base}/api/session`)).json()) as { token: string };
    const { ws } = await openAppSocket(Number(new URL(base).port), token);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("returns settings and never exposes a key", async () => {
    const res = await fetch(`${base}/api/settings`);
    const body = await res.json();
    expect(body.robotName).toBe("WALL-E");
    expect(body.geminiApiKey).toBeUndefined();
    expect(body.geminiConfigured).toBe(false);
  });

  it("saves settings and clamps out-of-range values", async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ motorSpeed: 5, robotName: "  WALLE  " }),
    });
    const body = await res.json();
    expect(body.motorSpeed).toBe(1);
    expect(body.robotName).toBe("WALLE");
  });

  it("rejects a connect request with no host", async () => {
    const res = await fetch(`${base}/api/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("reports no robots when discovery is disabled", async () => {
    const res = await fetch(`${base}/api/discover`);
    const body = await res.json();
    expect(body.robots).toEqual([]);
  });

  it("exposes activity history", async () => {
    const res = await fetch(`${base}/api/activity`);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
  });
});

describe("SettingsStore", () => {
  it("returns defaults when the file is missing", () => {
    const store = new SettingsStore(join(mkdtempSync(join(tmpdir(), "walle-s-")), "none.json"));
    expect(store.get()).toMatchObject(DEFAULT_SETTINGS);
  });

  it("round-trips an update through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "walle-s-"));
    const file = join(dir, "settings.json");
    new SettingsStore(file).update({ robotName: "WALL-E", motorSpeed: 0.9 });
    expect(new SettingsStore(file).get().motorSpeed).toBe(0.9);
  });

  it("survives a corrupt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "walle-s-"));
    const file = join(dir, "settings.json");
    writeFileSync(file, "{{{ not json", "utf8");
    expect(() => new SettingsStore(file).get()).not.toThrow();
  });
});
