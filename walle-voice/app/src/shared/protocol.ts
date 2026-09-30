/**
 * WALL-E Robot API v1 — shared protocol definitions.
 *
 * This file is the single source of truth for the wire format used between:
 *   WALL-E APP  <->  Node companion server  <->  ESP32-C3 firmware
 *
 * The ESP32 firmware repository implements the OTHER side of this contract.
 * Never inline command/event strings anywhere else in the codebase.
 */

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** Default WebSocket port exposed by the ESP32-C3 firmware. */
export const DEFAULT_ROBOT_PORT = 8080;

/** mDNS service type the firmware advertises (see docs/WALL-E_ROBOT_API.md). */
export const MDNS_SERVICE_TYPE = "walle" as const;
export const MDNS_SERVICE_PORT = DEFAULT_ROBOT_PORT;

/* ------------------------------------------------------------------ *
 * Commands (app -> robot)
 * ------------------------------------------------------------------ */

export const COMMANDS = {
  /* Movement */
  MOVE_FORWARD: "move_forward",
  MOVE_BACKWARD: "move_backward",
  TURN_LEFT: "turn_left",
  TURN_RIGHT: "turn_right",
  STOP: "stop",
  ROTATE_LEFT: "rotate_left",
  ROTATE_RIGHT: "rotate_right",

  /* Behaviour */
  DANCE: "dance",
  EXPLORE: "explore",
  IDLE: "idle",

  /* Expression */
  SET_EXPRESSION: "set_expression",

  /* Voice / AI */
  SPEAK: "speak",
  ASK: "ask",
  LISTEN: "listen",
  SET_VOLUME: "set_volume",
  INTERRUPT: "interrupt",

  /* Camera */
  CAMERA_START: "camera_start",
  CAMERA_STOP: "camera_stop",

  /* Autonomous mode */
  SET_AUTONOMOUS: "set_autonomous",

  /* Configuration */
  SET_MOTOR_SPEED: "set_motor_speed",
  SET_PID: "set_pid",
  PING: "ping",
  GET_STATUS: "get_status",
} as const;

export type CommandName = (typeof COMMANDS)[keyof typeof COMMANDS];

export const COMMAND_NAMES: readonly CommandName[] = Object.values(COMMANDS);

/**
 * Command payload schemas. `duration` is optional everywhere a movement
 * command exists: 0/omitted means "run until an explicit stop".
 */
export interface CommandPayloads {
  move_forward: { duration?: number; speed?: number };
  move_backward: { duration?: number; speed?: number };
  turn_left: { duration?: number; speed?: number };
  turn_right: { duration?: number; speed?: number };
  stop: Record<string, never>;
  rotate_left: { duration?: number; speed?: number };
  rotate_right: { duration?: number; speed?: number };

  dance: { style?: string };
  explore: Record<string, never>;
  idle: Record<string, never>;

  set_expression: { expression: ExpressionName };

  speak: { text: string };
  ask: { text: string };
  listen: { duration?: number };
  set_volume: { volume: number };
  interrupt: Record<string, never>;

  camera_start: Record<string, never>;
  camera_stop: Record<string, never>;

  set_autonomous: { enabled: boolean };

  set_motor_speed: { speed: number };
  set_pid: { kp: number; kd: number; kp_distance?: number };
  ping: Record<string, never>;
  get_status: Record<string, never>;
}

export type Command = {
  [K in CommandName]: { command: K; payload: CommandPayloads[K] };
}[CommandName];

/* ------------------------------------------------------------------ *
 * Expressions / states / modes
 * ------------------------------------------------------------------ */

export const EXPRESSIONS = [
  "neutral",
  "happy",
  "sad",
  "confused",
  "surprised",
  "thinking",
  "listening",
  "speaking",
  "idle",
] as const;
export type ExpressionName = (typeof EXPRESSIONS)[number];

export const ROBOT_STATES = [
  "booting",
  "idle",
  "moving",
  "dancing",
  "exploring",
  "listening",
  "thinking",
  "speaking",
  "autonomous",
  "charging",
  "error",
] as const;
export type RobotState = (typeof ROBOT_STATES)[number];

export const ROBOT_MODES = ["manual", "autonomous", "demo"] as const;
export type RobotMode = (typeof ROBOT_MODES)[number];

/* ------------------------------------------------------------------ *
 * Events (robot -> app)
 * ------------------------------------------------------------------ */

export const EVENTS = {
  ROBOT_BOOTED: "robot_booted",
  ROBOT_READY: "robot_ready",
  ROBOT_DISCONNECTED: "robot_disconnected",

  STATE_CHANGED: "state_changed",
  MOVEMENT_STARTED: "movement_started",
  MOVEMENT_STOPPED: "movement_stopped",

  EXPRESSION_CHANGED: "expression_changed",
  MODE_CHANGED: "mode_changed",
  AUTONOMOUS_CHANGED: "autonomous_changed",

  LISTENING_STARTED: "listening_started",
  LISTENING_FINISHED: "listening_finished",
  STT_STARTED: "stt_started",
  STT_FINISHED: "stt_finished",
  GEMINI_STARTED: "gemini_started",
  GEMINI_FINISHED: "gemini_finished",
  TTS_STARTED: "tts_started",
  TTS_FINISHED: "tts_finished",

  DANCE_STARTED: "dance_started",
  DANCE_FINISHED: "dance_finished",
  EXPLORATION_STARTED: "exploration_started",
  EXPLORATION_FINISHED: "exploration_finished",

  CAMERA_FRAME: "camera_frame",
  CAMERA_READY: "camera_ready",
  CAMERA_ERROR: "camera_error",

  STATUS: "status",
  LOG: "log",
  ERROR: "error",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
export const EVENT_NAMES: readonly EventName[] = Object.values(EVENTS);

export interface RobotStatus {
  name: string;
  firmwareVersion: string;
  ip?: string;
  mac?: string;
  wifiRssi?: number;
  uptimeMs?: number;
  state: RobotState;
  expression: ExpressionName;
  mode: RobotMode;
  autonomous: boolean;
  motorSpeed?: number;
  volume?: number;
  freeHeap?: number;
  cameraAvailable?: boolean;
  /** Only present if the firmware actually reports a battery sensor. */
  battery?: { percent: number; millivolts?: number; charging?: boolean };
}

export interface EventPayloads {
  robot_booted: { firmwareVersion: string };
  robot_ready: { status: RobotStatus };
  robot_disconnected: { reason?: string };
  state_changed: { state: RobotState; previous?: RobotState };
  movement_started: { direction: string; speed?: number };
  movement_stopped: { reason?: string };
  expression_changed: { expression: ExpressionName; previous?: ExpressionName };
  mode_changed: { mode: RobotMode };
  autonomous_changed: { enabled: boolean };
  listening_started: Record<string, never>;
  listening_finished: { transcript?: string };
  stt_started: Record<string, never>;
  stt_finished: { transcript: string; confidence?: number };
  gemini_started: { prompt: string };
  gemini_finished: { text: string; requestId?: string };
  tts_started: { text: string };
  tts_finished: Record<string, never>;
  dance_started: { style?: string };
  dance_finished: Record<string, never>;
  exploration_started: Record<string, never>;
  exploration_finished: Record<string, never>;
  camera_frame: { mime: string; data: string; width?: number; height?: number };
  camera_ready: { streamUrl?: string; width?: number; height?: number };
  camera_error: { message: string };
  status: { status: RobotStatus };
  log: { level: "debug" | "info" | "warn" | "error"; message: string };
  error: { code: string; message: string; detail?: string };
}

export type RobotEvent = {
  [K in EventName]: { event: K; payload: EventPayloads[K] };
}[EventName];

/* ------------------------------------------------------------------ *
 * Envelopes
 * ------------------------------------------------------------------ */

export interface CommandEnvelope<C extends Command = Command> {
  type: "command";
  v: ProtocolVersion;
  command: C["command"];
  requestId: string;
  payload: C["payload"];
  timestamp: number;
}

export interface ResponseEnvelope {
  type: "response";
  v: ProtocolVersion;
  requestId: string;
  success: boolean;
  error?: WireError;
  /** Optional echo of the resulting state, e.g. for get_status. */
  data?: unknown;
  timestamp: number;
}

export interface EventEnvelope<E extends RobotEvent = RobotEvent> {
  type: "event";
  v: ProtocolVersion;
  event: E["event"];
  requestId?: string;
  payload: E["payload"];
  timestamp: number;
}

export type WireMessage = CommandEnvelope | ResponseEnvelope | EventEnvelope;

export interface WireError {
  code: string;
  message: string;
  detail?: string;
}

export const ERROR_CODES = {
  BAD_JSON: "E_BAD_JSON",
  UNSUPPORTED_VERSION: "E_UNSUPPORTED_VERSION",
  UNKNOWN_TYPE: "E_UNKNOWN_TYPE",
  UNKNOWN_COMMAND: "E_UNKNOWN_COMMAND",
  INVALID_PAYLOAD: "E_INVALID_PAYLOAD",
  UNAUTHORIZED: "E_UNAUTHORIZED",
  RATE_LIMITED: "E_RATE_LIMITED",
  BUSY: "E_BUSY",
  NOT_SUPPORTED: "E_NOT_SUPPORTED",
  TIMEOUT: "E_TIMEOUT",
  INTERNAL: "E_INTERNAL",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/* ------------------------------------------------------------------ *
 * App <-> companion server messages (browser side, not the robot wire)
 * ------------------------------------------------------------------ */

export const SERVER_MSG = {
  STATE: "server_state",
  ACTIVITY: "activity",
  ROBOTS: "robots",
  CAMERA: "camera",
} as const;

/**
 * Camera transport is firmware-decided. The app renders whichever of these the
 * ESP32 actually provides and shows a placeholder otherwise, rather than
 * assuming a video protocol that may not exist.
 */
export type CameraMessage =
  | { type: typeof SERVER_MSG.CAMERA; camera: { status: "idle" | "starting" | "live"; streamUrl?: string } }
  | { type: typeof SERVER_MSG.CAMERA; camera: { status: "snapshots" }; frame: { mime: string; data: string } }
  | { type: typeof SERVER_MSG.CAMERA; camera: { status: "error"; error?: string } };

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface ServerStateMessage {
  type: typeof SERVER_MSG.STATE;
  connection: ConnectionState;
  demoMode: boolean;
  robotName: string;
  target: { host: string; port: number; source: "manual" | "mdns" | "demo" } | null;
  status: RobotStatus | null;
  lastError: { code: string; message: string } | null;
}

export interface ActivityEntry {
  id: string;
  at: number;
  kind: "event" | "command" | "response" | "error" | "system";
  label: string;
  detail?: string;
  level?: "debug" | "info" | "warn" | "error";
  requestId?: string;
}

export interface ActivityMessage {
  type: typeof SERVER_MSG.ACTIVITY;
  entry: ActivityEntry;
}

export interface RobotsMessage {
  type: typeof SERVER_MSG.ROBOTS;
  robots: DiscoveredRobot[];
}

export type ServerMessage = ServerStateMessage | ActivityMessage | RobotsMessage | CameraMessage;

export interface DiscoveredRobot {
  id: string;
  name: string;
  host: string;
  port: number;
  addresses: string[];
  txt?: Record<string, string>;
}

/* ------------------------------------------------------------------ *
 * Constructors + helpers
 * ------------------------------------------------------------------ */

let counter = 0;

/** Monotonic, collision-resistant enough for a single client session. */
export function newRequestId(prefix = "req"): string {
  counter = (counter + 1) % 0xffff;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${rand}`;
}

export function makeCommand<C extends Command>(c: C, requestId = newRequestId()): CommandEnvelope<C> {
  return {
    type: "command",
    v: PROTOCOL_VERSION,
    command: c.command,
    requestId,
    payload: c.payload,
    timestamp: Date.now(),
  };
}

export function makeResponse(
  requestId: string,
  success: boolean,
  data?: unknown,
  error?: WireError,
): ResponseEnvelope {
  return {
    type: "response",
    v: PROTOCOL_VERSION,
    requestId,
    success,
    data,
    error,
    timestamp: Date.now(),
  };
}

export function makeEvent<E extends RobotEvent>(
  e: E,
  requestId?: string,
): EventEnvelope<E> {
  return {
    type: "event",
    v: PROTOCOL_VERSION,
    event: e.event,
    requestId,
    payload: e.payload,
    timestamp: Date.now(),
  };
}

export function makeError(
  requestId: string,
  code: ErrorCode,
  message: string,
  detail?: string,
): ResponseEnvelope {
  return makeResponse(requestId, false, undefined, { code, message, detail });
}

export function isCommandName(v: unknown): v is CommandName {
  return typeof v === "string" && (COMMAND_NAMES as readonly string[]).includes(v);
}

export function isEventName(v: unknown): v is EventName {
  return typeof v === "string" && (EVENT_NAMES as readonly string[]).includes(v);
}

export function isExpressionName(v: unknown): v is ExpressionName {
  return typeof v === "string" && (EXPRESSIONS as readonly string[]).includes(v);
}

/** Human-readable label for an event, used by the activity feed. */
export function describeEvent(event: EventName): string {
  return event
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
