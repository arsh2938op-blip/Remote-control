import { describe, expect, it } from "vitest";
import {
  COMMAND_NAMES,
  EVENT_NAMES,
  EXPRESSIONS,
  PROTOCOL_VERSION,
  isCommandName,
  isEventName,
  makeCommand,
  makeEvent,
  newRequestId,
  type CommandEnvelope,
} from "../src/shared/protocol.js";
import { parseWireMessage } from "../src/shared/validate.js";
import { validateCommand } from "../src/shared/validateCommand.js";

describe("requestId generation", () => {
  it("is unique across rapid calls", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newRequestId()));
    expect(ids.size).toBe(5000);
  });

  it("is a non-empty string", () => {
    expect(newRequestId()).toMatch(/^req-/);
  });
});

describe("envelope construction", () => {
  it("builds a v1 command envelope", () => {
    const env = makeCommand({ command: "move_forward", payload: { speed: 0.5 } }, "r1");
    expect(env).toMatchObject({
      type: "command",
      v: PROTOCOL_VERSION,
      command: "move_forward",
      requestId: "r1",
      payload: { speed: 0.5 },
    });
    const json = JSON.parse(JSON.stringify(env));
    expect(json.type).toBe("command");
    expect(json.requestId).toBe("r1");
  });

  it("builds an event envelope that round-trips validation", () => {
    const env = makeEvent(
      { event: "movement_started", payload: { direction: "forward", speed: 0.6 } },
      "r2",
    );
    const parsed = parseWireMessage(JSON.stringify(env));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.type).toBe("event");
    if (parsed.value.type !== "event") return;
    expect(parsed.value.event).toBe("movement_started");
    expect(parsed.value.requestId).toBe("r2");
  });
});

describe("command name helpers", () => {
  it("recognises every defined command", () => {
    for (const name of COMMAND_NAMES) expect(isCommandName(name)).toBe(true);
  });

  it("rejects unknown commands", () => {
    expect(isCommandName("self_destruct")).toBe(false);
    expect(isCommandName(42)).toBe(false);
    expect(isCommandName(null)).toBe(false);
  });

  it("recognises every defined event", () => {
    for (const name of EVENT_NAMES) expect(isEventName(name)).toBe(true);
  });
});

describe("outbound command validation", () => {
  it("accepts a well-formed movement command", () => {
    const r = validateCommand({ command: "move_forward", payload: { speed: 0.7, duration: 500 } });
    expect(r.ok).toBe(true);
  });

  it("accepts stop with any payload shape", () => {
    expect(validateCommand({ command: "stop", payload: {} }).ok).toBe(true);
    expect(validateCommand({ command: "stop" }).ok).toBe(true);
  });

  it("rejects unknown commands", () => {
    const r = validateCommand({ command: "launch_missiles", payload: {} });
    expect(r.ok).toBe(false);
  });

  it("rejects out-of-range speed", () => {
    expect(validateCommand({ command: "move_forward", payload: { speed: 5 } }).ok).toBe(false);
    expect(validateCommand({ command: "move_forward", payload: { speed: -1 } }).ok).toBe(false);
    expect(validateCommand({ command: "set_motor_speed", payload: { speed: 2 } }).ok).toBe(false);
  });

  it("rejects out-of-range duration", () => {
    expect(validateCommand({ command: "move_forward", payload: { duration: 999_999 } }).ok).toBe(false);
  });

  it("requires text for ask and speak", () => {
    expect(validateCommand({ command: "ask", payload: {} }).ok).toBe(false);
    expect(validateCommand({ command: "ask", payload: { text: "   " } }).ok).toBe(false);
    expect(validateCommand({ command: "speak", payload: { text: "hello" } }).ok).toBe(true);
  });

  it("caps text length", () => {
    expect(validateCommand({ command: "ask", payload: { text: "x".repeat(501) } }).ok).toBe(false);
  });

  it("only allows known expressions", () => {
    expect(validateCommand({ command: "set_expression", payload: { expression: "happy" } }).ok).toBe(true);
    expect(validateCommand({ command: "set_expression", payload: { expression: "grumpy" } }).ok).toBe(false);
  });

  it("requires a boolean for autonomous mode", () => {
    expect(validateCommand({ command: "set_autonomous", payload: { enabled: true } }).ok).toBe(true);
    expect(validateCommand({ command: "set_autonomous", payload: { enabled: "yes" } }).ok).toBe(false);
  });

  it("bounds volume and pid", () => {
    expect(validateCommand({ command: "set_volume", payload: { volume: 1 } }).ok).toBe(true);
    expect(validateCommand({ command: "set_volume", payload: { volume: 1.1 } }).ok).toBe(false);
    expect(validateCommand({ command: "set_pid", payload: { kp: 1, kd: 0.5 } }).ok).toBe(true);
    expect(validateCommand({ command: "set_pid", payload: { kp: 500, kd: 0.5 } }).ok).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(validateCommand(null).ok).toBe(false);
    expect(validateCommand("stop").ok).toBe(false);
    expect(validateCommand([1, 2]).ok).toBe(false);
  });
});

describe("inbound message validation", () => {
  it("parses a valid response", () => {
    const r = parseWireMessage(
      JSON.stringify({ type: "response", v: 1, requestId: "r1", success: true, timestamp: 1 }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.type !== "response") return;
    expect(r.value.success).toBe(true);
  });

  it("rejects malformed JSON", () => {
    const r = parseWireMessage("{not json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_BAD_JSON");
  });

  it("rejects a non-object payload", () => {
    expect(parseWireMessage("[]").ok).toBe(false);
    expect(parseWireMessage("42").ok).toBe(false);
    expect(parseWireMessage('"hello"').ok).toBe(false);
  });

  it("rejects a missing version", () => {
    const r = parseWireMessage(JSON.stringify({ type: "event", event: "status", payload: {} }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_UNSUPPORTED_VERSION");
  });

  it("rejects a newer protocol version", () => {
    const r = parseWireMessage(
      JSON.stringify({ type: "event", v: 99, event: "status", payload: {} }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_UNSUPPORTED_VERSION");
  });

  it("rejects unknown event names", () => {
    const r = parseWireMessage(
      JSON.stringify({ type: "event", v: 1, event: "nuclear_launch", payload: {} }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_UNKNOWN_TYPE");
  });

  it("rejects an event with no payload", () => {
    expect(
      parseWireMessage(JSON.stringify({ type: "event", v: 1, event: "status" })).ok,
    ).toBe(false);
  });

  it("rejects a response with no requestId", () => {
    const r = parseWireMessage(JSON.stringify({ type: "response", v: 1, success: true }));
    expect(r.ok).toBe(false);
  });

  it("rejects a response whose success flag is not boolean", () => {
    const r = parseWireMessage(
      JSON.stringify({ type: "response", v: 1, requestId: "r", success: "yes" }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown message type", () => {
    const r = parseWireMessage(JSON.stringify({ type: "telepathy", v: 1 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_UNKNOWN_TYPE");
  });

  it("rejects an oversized message", () => {
    const huge = "x".repeat(600 * 1024);
    const r = parseWireMessage(huge);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/too large/i);
  });

  it("never lets a malformed payload through as usable state", () => {
    // A hostile robot sending a bogus expression must not reach the UI.
    const r = parseWireMessage(
      JSON.stringify({
        type: "event",
        v: 1,
        event: "expression_changed",
        payload: { expression: "<script>" },
      }),
    );
    expect(r.ok).toBe(true);
    const expr = (r.ok && r.value.type === "event" ? r.value.payload : {}) as {
      expression: string;
    };
    expect(EXPRESSIONS).not.toContain(expr.expression);
  });

  it("accepts a valid camera frame", () => {
    const r = parseWireMessage(
      JSON.stringify({
        type: "event",
        v: 1,
        event: "camera_frame",
        payload: { mime: "image/jpeg", data: "AAAA" },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("validates a command envelope from the robot side", () => {
    const env: CommandEnvelope = makeCommand({ command: "stop", payload: {} }, "r9");
    const r = parseWireMessage(JSON.stringify(env));
    expect(r.ok).toBe(true);
  });
});
