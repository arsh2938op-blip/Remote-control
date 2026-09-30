/**
 * Runtime validation of inbound robot messages.
 *
 * Everything arriving from the network (robot -> app) passes through here
 * before it reaches the UI, so a malformed or hostile ESP32 can never drive
 * app behaviour with an unexpected shape.
 */

import {
  EVENT_NAMES,
  PROTOCOL_VERSION,
  COMMAND_NAMES,
  isCommandName,
  isEventName,
  ERROR_CODES,
  type CommandEnvelope,
  type EventEnvelope,
  type ResponseEnvelope,
  type WireMessage,
  type WireError,
} from "./protocol.js";

export interface ParseOk<T> {
  ok: true;
  value: T;
}
export interface ParseErr {
  ok: false;
  code: string;
  message: string;
}
export type ParseResult<T> = ParseOk<T> | ParseErr;

const MAX_MESSAGE_BYTES = 512 * 1024; // camera frames are the big ones

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseError(code: string, message: string): ParseErr {
  return { ok: false, code, message };
}

export function parseWireMessage(input: string | Buffer): ParseResult<WireMessage> {
  if (typeof input === "string" && input.length > MAX_MESSAGE_BYTES) {
    return parseError(ERROR_CODES.BAD_JSON, "message too large");
  }
  if (Buffer.isBuffer(input) && input.byteLength > MAX_MESSAGE_BYTES) {
    return parseError(ERROR_CODES.BAD_JSON, "message too large");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(typeof input === "string" ? input : input.toString("utf8"));
  } catch (err) {
    return parseError(ERROR_CODES.BAD_JSON, `invalid JSON: ${(err as Error).message}`);
  }

  if (!isObject(raw)) {
    return parseError(ERROR_CODES.BAD_JSON, "message must be a JSON object");
  }
  if (typeof raw.v !== "number") {
    return parseError(ERROR_CODES.UNSUPPORTED_VERSION, "missing protocol version 'v'");
  }
  if (raw.v > PROTOCOL_VERSION) {
    return parseError(
      ERROR_CODES.UNSUPPORTED_VERSION,
      `protocol v${raw.v} is newer than supported v${PROTOCOL_VERSION}`,
    );
  }

  switch (raw.type) {
    case "event":
      return parseEvent(raw);
    case "response":
      return parseResponse(raw);
    case "command":
      return parseCommand(raw);
    default:
      return parseError(ERROR_CODES.UNKNOWN_TYPE, `unknown message type '${String(raw.type)}'`);
  }
}

function parseEvent(raw: Record<string, unknown>): ParseResult<EventEnvelope> {
  if (!isEventName(raw.event)) {
    return parseError(ERROR_CODES.UNKNOWN_TYPE, `unknown event '${String(raw.event)}'`);
  }
  if (!isObject(raw.payload)) {
    return parseError(ERROR_CODES.INVALID_PAYLOAD, `event '${raw.event}' missing payload`);
  }
  return {
    ok: true,
    value: {
      type: "event",
      v: PROTOCOL_VERSION,
      event: raw.event,
      requestId: typeof raw.requestId === "string" ? raw.requestId : undefined,
      payload: raw.payload,
      timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.now(),
    } as EventEnvelope,
  };
}

function parseResponse(raw: Record<string, unknown>): ParseResult<ResponseEnvelope> {
  if (typeof raw.requestId !== "string" || raw.requestId.length === 0) {
    return parseError(ERROR_CODES.INVALID_PAYLOAD, "response missing requestId");
  }
  if (typeof raw.success !== "boolean") {
    return parseError(ERROR_CODES.INVALID_PAYLOAD, "response missing boolean 'success'");
  }
  return {
    ok: true,
    value: {
      type: "response",
      v: PROTOCOL_VERSION,
      requestId: raw.requestId,
      success: raw.success,
      error: parseWireError(raw.error),
      data: raw.data,
      timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.now(),
    },
  };
}

function parseCommand(raw: Record<string, unknown>): ParseResult<CommandEnvelope> {
  if (!isCommandName(raw.command)) {
    return parseError(
      ERROR_CODES.UNKNOWN_COMMAND,
      `unknown command '${String(raw.command)}'`,
    );
  }
  if (typeof raw.requestId !== "string" || raw.requestId.length === 0) {
    return parseError(ERROR_CODES.INVALID_PAYLOAD, "command missing requestId");
  }
  if (!isObject(raw.payload)) {
    return parseError(
      ERROR_CODES.INVALID_PAYLOAD,
      `command '${raw.command}' requires an object payload`,
    );
  }
  return {
    ok: true,
    value: {
      type: "command",
      v: PROTOCOL_VERSION,
      command: raw.command,
      requestId: raw.requestId,
      payload: raw.payload,
      timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.now(),
    } as CommandEnvelope,
  };
}

function parseWireError(v: unknown): WireError | undefined {
  if (!isObject(v)) return undefined;
  if (typeof v.code !== "string" || typeof v.message !== "string") return undefined;
  return {
    code: v.code,
    message: v.message,
    detail: typeof v.detail === "string" ? v.detail : undefined,
  };
}

export { EVENT_NAMES, COMMAND_NAMES };
