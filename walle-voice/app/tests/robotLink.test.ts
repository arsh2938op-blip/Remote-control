import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockRobot } from "../src/mock/mockRobot.js";
import { RobotLink } from "../src/server/connection/robotLink.js";
import {
  COMMANDS,
  makeCommand,
  makeEvent,
  makeResponse,
  type CommandEnvelope,
  type EventEnvelope,
  type ResponseEnvelope,
} from "../src/shared/protocol.js";
import WebSocket from "ws";

/** A RobotLink whose socket is driven by the test, not the network. */
function fakeLink(overrides: Partial<ConstructorParameters<typeof RobotLink>[0]> = {}) {
  const sent: CommandEnvelope[] = [];
  let handlers: Record<string, (...a: unknown[]) => void> = {};

  const socket = {
    send: (d: string) => sent.push(JSON.parse(d) as CommandEnvelope),
    close: () => {},
    on: ((event: string, cb: (...a: unknown[]) => void) => {
      handlers[event] = cb;
    }) as never,
  };

  const link = new RobotLink({
    requestTimeoutMs: 500,
    reconnect: { enabled: false, minDelayMs: 10, maxDelayMs: 20 },
    createSocket: () => socket,
    ...overrides,
  });

  // Drive a real open cycle so the link's internal state is genuinely connected.
  link.connect("127.0.0.1", 1);
  handlers.open?.();

  const fire = (event: string, ...args: unknown[]) => handlers[event]?.(...args);
  return { link, sent, fire };
}

describe("RobotLink: command/response correlation", () => {
  it("resolves a command when the matching response arrives", async () => {
    const { link, sent, fire } = fakeLink();
    const cmd = makeCommand({ command: COMMANDS.MOVE_FORWARD, payload: { speed: 0.5 } }, "req-1");

    const promise = link.send(cmd);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.requestId).toBe("req-1");

    fire("message", JSON.stringify(makeResponse("req-1", true)));
    const res = await promise;
    expect(res.success).toBe(true);
    expect(res.requestId).toBe("req-1");
  });

  it("resolves unrelated responses without settling the wrong promise", async () => {
    const { link, fire } = fakeLink();
    const promise = link.send(makeCommand({ command: COMMANDS.STOP, payload: {} }, "mine"));

    fire("message", JSON.stringify(makeResponse("someone-else", true)));
    fire("message", JSON.stringify(makeResponse("mine", true)));
    expect((await promise).requestId).toBe("mine");
  });

  it("times out a command the robot never answers", async () => {
    const { link } = fakeLink({ requestTimeoutMs: 120 });
    const res = await link.send(makeCommand({ command: COMMANDS.STOP, payload: {} }, "slow"));
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe("E_TIMEOUT");
  });

  it("fails immediately when not connected", async () => {
    const link = new RobotLink({
      requestTimeoutMs: 100,
      reconnect: { enabled: false, minDelayMs: 10, maxDelayMs: 20 },
    });
    const res = await link.send(makeCommand({ command: COMMANDS.STOP, payload: {} }, "x"));
    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/not connected/i);
  });

  it("sendNowait does not wait for a response", () => {
    const { link, sent } = fakeLink();
    expect(link.sendNowait(makeCommand({ command: COMMANDS.STOP, payload: {} }, "fast"))).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("sendNowait returns false when offline", () => {
    const link = new RobotLink({
      requestTimeoutMs: 100,
      reconnect: { enabled: false, minDelayMs: 10, maxDelayMs: 20 },
    });
    expect(link.sendNowait(makeCommand({ command: COMMANDS.STOP, payload: {} }, "x"))).toBe(false);
  });
});

describe("RobotLink: inbound message safety", () => {
  it("drops malformed frames and reports an error event", () => {
    const { link, fire } = fakeLink();
    const events: EventEnvelope[] = [];
    link.on("event", (e) => events.push(e));

    fire("message", "{{{ not json");

    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("error");
    if (events[0]!.event !== "error") return;
    expect((events[0]!.payload as { code: string }).code).toBe("E_BAD_JSON");
  });

  it("ignores an oversized frame", () => {
    const { link, fire } = fakeLink();
    const events: EventEnvelope[] = [];
    link.on("event", (e) => events.push(e));
    fire("message", "x".repeat(600 * 1024));
    expect(events[0]!.event).toBe("error");
  });

  it("ignores a newer protocol version", () => {
    const { link, fire } = fakeLink();
    const events: EventEnvelope[] = [];
    link.on("event", (e) => events.push(e));
    fire("message", JSON.stringify({ type: "event", v: 2, event: "status", payload: {} }));
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("error");
  });

  it("ignores a robot trying to push commands at the app", () => {
    const { link, fire } = fakeLink();
    const events: EventEnvelope[] = [];
    link.on("event", (e) => events.push(e));
    fire(
      "message",
      JSON.stringify({
        type: "command",
        v: 1,
        command: "set_autonomous",
        requestId: "x",
        payload: { enabled: true },
      }),
    );
    expect(events).toHaveLength(0);
  });

  it("tracks the latest status from a status event", () => {
    const { link, fire } = fakeLink();
    fire(
      "message",
      JSON.stringify(
        makeEvent({
          event: "status",
          payload: {
            status: {
              name: "WALL-E",
              firmwareVersion: "1.2.3",
              state: "idle",
              expression: "happy",
              mode: "manual",
              autonomous: false,
            },
          },
        }),
      ),
    );
    expect(link.status?.firmwareVersion).toBe("1.2.3");
    expect(link.status?.expression).toBe("happy");
  });

  it("accepts a Buffer frame", () => {
    const { link, fire } = fakeLink();
    const events: EventEnvelope[] = [];
    link.on("event", (e) => events.push(e));
    fire("message", Buffer.from(JSON.stringify(makeEvent({ event: "dance_started", payload: {} }))));
    expect(events[0]!.event).toBe("dance_started");
  });
});

describe("RobotLink: connection lifecycle", () => {
  it("reports connecting then connected and keeps the target on disconnect", () => {
    const link = new RobotLink({
      requestTimeoutMs: 200,
      reconnect: { enabled: false, minDelayMs: 5, maxDelayMs: 10 },
    });
    const states: string[] = [];
    link.on("state", (s) => states.push(s));

    link.connect("127.0.0.1", 9);
    expect(link.connectionState).toBe("connecting");

    link.disconnect();
    expect(states).toContain("disconnected");
    expect(link.target).toEqual({ host: "127.0.0.1", port: 9 });
  });

  it("fails pending commands when the socket drops", async () => {
    let handlers: Record<string, (...a: unknown[]) => void> = {};
    const link = new RobotLink({
      requestTimeoutMs: 5000,
      reconnect: { enabled: false, minDelayMs: 5, maxDelayMs: 10 },
      createSocket: () => {
        handlers = {};
        return {
          send: () => {},
          close: () => {},
          on: ((e: string, cb: (...a: unknown[]) => void) => {
            handlers[e] = cb;
          }) as never,
        };
      },
    });

    link.connect("127.0.0.1", 1);
    handlers.open?.();
    const promise = link.send(makeCommand({ command: COMMANDS.MOVE_FORWARD, payload: {} }, "r"));
    handlers.close?.(1006, "gone");

    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/connection lost/i);
  });
});

describe("MockRobot end-to-end over a real WebSocket", () => {
  let robot: MockRobot;
  let port: number;
  const received: CommandEnvelope[] = [];

  beforeEach(async () => {
    received.length = 0;
    robot = new MockRobot({ port: 0, host: "127.0.0.1", onCommand: (c) => received.push(c) });
    port = await robot.start();
  });

  afterEach(async () => {
    await robot.stop();
  });

  async function connect(): Promise<{ link: RobotLink; seen: EventEnvelope[]; res: ResponseEnvelope[] }> {
    const link = new RobotLink({
      requestTimeoutMs: 2000,
      reconnect: { enabled: false, minDelayMs: 5, maxDelayMs: 10 },
    });
    const seen: EventEnvelope[] = [];
    const res: ResponseEnvelope[] = [];
    link.on("event", (e) => seen.push(e));
    link.on("response", (r) => res.push(r));
    link.connect("127.0.0.1", port);
    await waitFor(() => link.connectionState === "connected", 3000);
    return { link, seen, res };
  }

  it("sends robot_ready on connect", async () => {
    const { seen } = await connect();
    await waitFor(() => seen.some((e) => e.event === "robot_ready"), 2000);
    const ready = seen.find((e) => e.event === "robot_ready");
    expect(ready).toBeDefined();
    if (ready?.event !== "robot_ready") return;
    expect((ready.payload as { status: { name: string } }).status.name).toBe("WALL-E");
  });

  it("acks a movement command and emits started/stopped", async () => {
    const { link, seen } = await connect();
    const res = await link.send(
      makeCommand({ command: COMMANDS.MOVE_FORWARD, payload: { duration: 150, speed: 0.5 } }, "m1"),
    );
    expect(res.success).toBe(true);
    await waitFor(() => seen.some((e) => e.event === "movement_started"), 1500);
    await waitFor(() => seen.some((e) => e.event === "movement_stopped"), 2500);
    const started = seen.find((e) => e.event === "movement_started");
    expect(started?.requestId).toBe("m1");
  });

  it("stops immediately on the stop command", async () => {
    const { link, seen } = await connect();
    await link.send(makeCommand({ command: COMMANDS.MOVE_FORWARD, payload: { duration: 5000 } }, "m2"));
    const res = await link.send(makeCommand({ command: COMMANDS.STOP, payload: {} }, "s2"));
    expect(res.success).toBe(true);
    await waitFor(() => seen.some((e) => e.event === "movement_stopped"), 1500);
    const stopped = seen.filter((e) => e.event === "movement_stopped").pop();
    if (stopped?.event !== "movement_stopped") return;
    expect((stopped.payload as { reason: string }).reason).toBe("command");
  });

  it("runs a dance and reports the start", async () => {
    const { link, seen } = await connect();
    await link.send(makeCommand({ command: COMMANDS.DANCE, payload: {} }, "d1"));
    await waitFor(() => seen.some((e) => e.event === "dance_started"), 1500);
    expect(seen.some((e) => e.event === "dance_started")).toBe(true);
  });

  it("changes expression and emits expression_changed", async () => {
    const { link, seen } = await connect();
    const res = await link.send(
      makeCommand({ command: COMMANDS.SET_EXPRESSION, payload: { expression: "surprised" } }, "e1"),
    );
    expect(res.success).toBe(true);
    const ev = await waitFor(() => seen.find((e) => e.event === "expression_changed"), 1500);
    if (ev?.event !== "expression_changed") return;
    expect((ev.payload as { expression: string }).expression).toBe("surprised");
  });

  it("toggles autonomous mode and reports it", async () => {
    const { link, seen } = await connect();
    const res = await link.send(
      makeCommand({ command: COMMANDS.SET_AUTONOMOUS, payload: { enabled: true } }, "a1"),
    );
    expect(res.success).toBe(true);
    const ev = await waitFor(() => seen.find((e) => e.event === "autonomous_changed"), 1500);
    if (ev?.event !== "autonomous_changed") return;
    expect((ev.payload as { enabled: boolean }).enabled).toBe(true);
  });

  it("runs the full STT -> Gemini -> TTS chain for ask", async () => {
    const { link, seen } = await connect();
    await link.send(makeCommand({ command: COMMANDS.ASK, payload: { text: "Tell me a joke." } }, "q1"));
    await waitFor(() => seen.some((e) => e.event === "gemini_finished"), 3000);
    for (const stage of ["stt_started", "stt_finished", "gemini_started", "gemini_finished", "tts_started"]) {
      expect(seen.some((e) => e.event === stage), `missing ${stage}`).toBe(true);
    }
    const reply = seen.find((e) => e.event === "gemini_finished");
    if (reply?.event !== "gemini_finished") return;
    expect((reply.payload as { text: string }).text.length).toBeGreaterThan(0);
  });

  it("returns a status payload for get_status", async () => {
    const { link } = await connect();
    const res = await link.send(makeCommand({ command: COMMANDS.GET_STATUS, payload: {} }, "g1"));
    expect(res.success).toBe(true);
    const data = res.data as { status: { state: string } };
    expect(data.status.state).toBeTruthy();
  });

  it("rejects an unknown command with a correlated error response", async () => {
    const { link } = await connect();
    const res = await link.send(makeCommand({ command: "self_destruct" as never, payload: {} }, "bad"));
    expect(res.success).toBe(false);
    // The mock recovers the requestId from the raw frame so the sender can
    // correlate the rejection instead of timing out.
    expect(res.error?.code).toBe("E_UNKNOWN_COMMAND");
    expect(res.requestId).toBe("bad");
  });

  /** Waits for a response frame, ignoring the boot events sent on connect. */
  function nextResponse(ws: WebSocket, act: () => void): Promise<ResponseEnvelope> {
    return new Promise<ResponseEnvelope>((done) => {
      const onMessage = (raw: { toString(): string }) => {
        const msg = JSON.parse(raw.toString()) as ResponseEnvelope;
        if (msg.type !== "response") return;
        ws.off("message", onMessage);
        done(msg);
      };
      ws.on("message", onMessage);
      ws.on("open", act);
    });
  }

  it("rejects a malformed frame with a parseable error response", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const reply = await nextResponse(ws, () => ws.send("this is not json"));
    expect(reply.success).toBe(false);
    expect(reply.error?.code).toBe("E_BAD_JSON");
    ws.close();
  });

  it("rejects a command with no requestId", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const reply = await nextResponse(ws, () =>
      ws.send(JSON.stringify({ type: "command", v: 1, command: "stop", payload: {} })),
    );
    expect(reply.success).toBe(false);
    ws.close();
  });

  it("survives a burst of commands without dropping the connection", async () => {
    const { link } = await connect();
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        link.send(
          makeCommand(
            { command: COMMANDS.SET_EXPRESSION, payload: { expression: "happy" } },
            `burst-${i}`,
          ),
        ),
      ),
    );
    expect(results.every((r: ResponseEnvelope) => r.success)).toBe(true);
    expect(received.filter((c) => c.requestId?.startsWith("burst-"))).toHaveLength(40);
  });
});

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
}
