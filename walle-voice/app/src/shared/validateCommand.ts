/**
 * Outbound command validation.
 *
 * The app never forwards a command it has not itself constructed and checked,
 * so a compromised browser client cannot smuggle arbitrary actions to the robot.
 */

import { ERROR_CODES, isCommandName, type Command, type CommandEnvelope } from "./protocol.js";

const MAX_TEXT_LENGTH = 500;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  if (v < min || v > max) return undefined;
  return v;
}

/**
 * Validates and normalises a command before it goes on the wire.
 * Returns either a sanitised envelope or a reason it was rejected.
 */
export function validateCommand(
  command: unknown,
): { ok: true; command: Command } | { ok: false; code: string; message: string } {
  if (!isObject(command)) {
    return { ok: false, code: ERROR_CODES.UNKNOWN_COMMAND, message: "command must be an object" };
  }
  const name = command.command;
  if (!isCommandName(name)) {
    return { ok: false, code: ERROR_CODES.UNKNOWN_COMMAND, message: `unknown command '${String(name)}'` };
  }
  const p = isObject(command.payload) ? command.payload : {};

  const reject = (message: string) =>
    ({ ok: false, code: ERROR_CODES.INVALID_PAYLOAD, message }) as const;

  const duration = num(p.duration, 0, 60_000);
  const speed = num(p.speed, 0, 1);

  switch (name) {
    case "move_forward":
    case "move_backward":
    case "turn_left":
    case "turn_right":
    case "rotate_left":
    case "rotate_right":
      if (p.duration !== undefined && duration === undefined) return reject("duration must be 0..60000 ms");
      if (p.speed !== undefined && speed === undefined) return reject("speed must be 0..1");
      return { ok: true, command: { command: name, payload: { duration, speed } } };

    case "stop":
    case "explore":
    case "idle":
    case "camera_start":
    case "camera_stop":
    case "interrupt":
    case "ping":
    case "get_status":
      return { ok: true, command: { command: name, payload: {} } };

    case "dance":
      if (p.style !== undefined && (typeof p.style !== "string" || p.style.length > 32)) {
        return reject("style must be a string of at most 32 chars");
      }
      return { ok: true, command: { command: name, payload: { style: p.style as string | undefined } } };

    case "set_expression": {
      const allowed = [
        "neutral","happy","sad","confused","surprised","thinking","listening","speaking","idle",
      ];
      if (typeof p.expression !== "string" || !allowed.includes(p.expression)) {
        return reject(`expression must be one of: ${allowed.join(", ")}`);
      }
      return {
        ok: true,
        command: { command: name, payload: { expression: p.expression as never } },
      };
    }

    case "speak":
    case "ask": {
      if (typeof p.text !== "string" || p.text.trim().length === 0) {
        return reject("text is required");
      }
      if (p.text.length > MAX_TEXT_LENGTH) {
        return reject(`text must be at most ${MAX_TEXT_LENGTH} characters`);
      }
      return { ok: true, command: { command: name, payload: { text: p.text } } };
    }

    case "listen":
      if (p.duration !== undefined && duration === undefined) return reject("duration must be 0..60000 ms");
      return { ok: true, command: { command: name, payload: { duration } } };

    case "set_volume": {
      const v = num(p.volume, 0, 1);
      if (v === undefined) return reject("volume must be 0..1");
      return { ok: true, command: { command: name, payload: { volume: v } } };
    }

    case "set_autonomous": {
      if (typeof p.enabled !== "boolean") return reject("enabled must be a boolean");
      return { ok: true, command: { command: name, payload: { enabled: p.enabled } } };
    }

    case "set_motor_speed": {
      const v = num(p.speed, 0, 1);
      if (v === undefined) return reject("speed must be 0..1");
      return { ok: true, command: { command: name, payload: { speed: v } } };
    }

    case "set_pid": {
      const kp = num(p.kp, 0, 100);
      const kd = num(p.kd, 0, 100);
      const kpDistance = p.kp_distance === undefined ? undefined : num(p.kp_distance, 0, 100);
      if (kp === undefined || kd === undefined) return reject("kp and kd must be 0..100");
      if (p.kp_distance !== undefined && kpDistance === undefined) {
        return reject("kp_distance must be 0..100");
      }
      return { ok: true, command: { command: name, payload: { kp, kd, kp_distance: kpDistance } } };
    }

    default:
      // Exhaustiveness guard: a new command added to the protocol must be
      // handled here explicitly rather than slipping through unvalidated.
      return { ok: false, code: ERROR_CODES.UNKNOWN_COMMAND, message: `unhandled command '${name}'` };
  }
}

/**
 * Commands that can never be relayed to a robot that is not the configured
 * local device. Purely defensive; the real control is the allowlist above.
 */
export function isEmergencyCommand(c: CommandEnvelope): boolean {
  return c.command === "stop";
}
