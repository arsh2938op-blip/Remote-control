/**
 * Browser-side app socket + store.
 *
 * The UI never talks to the ESP32 directly: it sends commands over this
 * socket and receives a stream of state / activity messages. React reads
 * `useStore` and re-renders on change.
 */

import { useSyncExternalStore } from "react";
import type {
  ActivityEntry,
  Command,
  ConnectionState,
  DiscoveredRobot,
  RobotStatus,
  ServerMessage,
  ServerStateMessage,
} from "../shared/protocol.js";

export interface ChatMessage {
  id: string;
  from: "user" | "robot" | "system";
  text: string;
  at: number;
}

export interface AppStore {
  connected: boolean;
  connection: ConnectionState;
  demoMode: boolean;
  robotName: string;
  target: ServerStateMessage["target"];
  status: RobotStatus | null;
  lastError: { code: string; message: string } | null;
  robots: DiscoveredRobot[];
  activity: ActivityEntry[];
  chat: ChatMessage[];
  /** True while a movement command is latched, so the UI can show STOP. */
  moving: boolean;
  busy: boolean;
  camera: { status: "idle" | "starting" | "live" | "snapshots" | "error"; streamUrl?: string; error?: string };
  frame: string | null;
}

const ACTIVITY_LIMIT = 200;
const CHAT_LIMIT = 100;

let state: AppStore = {
  connected: false,
  connection: "disconnected",
  demoMode: false,
  robotName: "WALL-E",
  target: null,
  status: null,
  lastError: null,
  robots: [],
  activity: [],
  chat: [],
  moving: false,
  busy: false,
  camera: { status: "idle" },
  frame: null,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setState(patch: Partial<AppStore>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useStore<T>(selector: (s: AppStore) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

export function getState(): AppStore {
  return state;
}

/* ------------------------------------------------------------------ *
 * Socket
 * ------------------------------------------------------------------ */

let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let tokenPromise: Promise<string> | null = null;

/**
 * The app socket is authenticated with a per-boot token. It is fetched from
 * the companion server on the same origin rather than baked into the bundle,
 * so nothing secret ships to the browser.
 */
function appToken(): Promise<string> {
  tokenPromise ??= fetch("/api/session")
    .then((r) => (r.ok ? r.json() : { token: "" }))
    .then((b: { token?: string }) => b.token ?? "")
    .catch(() => "");
  return tokenPromise;
}

export function connectAppSocket(): () => void {
  if (socket && socket.readyState <= WebSocket.OPEN) return () => {};

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const base = `${proto}://${location.host}/ws`;

  const open = (token: string) => {
    const url = token ? `${base}?token=${encodeURIComponent(token)}` : base;
    const ws = new WebSocket(url);
    socket = ws;
    wireSocket(ws);
  };

  void appToken().then(open);

  return () => {
    window.clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
  };
}

function wireSocket(ws: WebSocket): void {

  ws.onopen = () => setState({ connected: true });
  ws.onclose = () => {
    setState({ connected: false, connection: "disconnected", moving: false, busy: false });
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connectAppSocket, 1500);
  };
  ws.onerror = () => {
    /* onclose follows and drives the retry */
  };
  ws.onmessage = (ev) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data as string) as ServerMessage;
    } catch {
      return; // ignore junk from the socket
    }
    applyMessage(msg);
  };
}

function applyMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "server_state": {
      const status: RobotStatus | null = msg.status;
      setState({
        connection: msg.connection,
        demoMode: msg.demoMode,
        robotName: msg.robotName,
        target: msg.target,
        status,
        lastError: msg.lastError,
        // The link owns truth about movement; reflect it rather than guessing.
        moving: status ? status.state === "moving" : state.moving,
        busy: false,
      });
      break;
    }
    case "robots":
      setState({ robots: msg.robots });
      break;
    case "camera": {
      const cam = msg.camera;
      setState({
        camera: {
          status: cam.status,
          streamUrl: "streamUrl" in cam ? cam.streamUrl : undefined,
          error: "error" in cam ? cam.error : undefined,
        },
        frame:
          "frame" in msg && msg.frame
            ? `data:${msg.frame.mime};base64,${msg.frame.data}`
            : cam.status === "live"
              ? null
              : state.frame,
      });
      break;
    }
    case "activity": {
      const entry = msg.entry;
      const activity = [entry, ...state.activity].slice(0, ACTIVITY_LIMIT);
      let chat = state.chat;
      if (entry.kind === "command" && (entry.label === "ask" || entry.label === "speak")) {
        chat = [
          ...chat,
          { id: entry.id, from: "user" as const, text: entry.detail ?? "", at: entry.at },
        ].slice(-CHAT_LIMIT);
      }
      if (entry.kind === "event" && entry.label === "WALL-E" && entry.detail) {
        chat = [
          ...chat,
          { id: entry.id, from: "robot" as const, text: entry.detail, at: entry.at },
        ].slice(-CHAT_LIMIT);
      }
      setState({ activity, chat });
      break;
    }
  }
}

export function sendCommand(command: Command, requestId?: string): void {
  const id = requestId ?? `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const envelope = {
    type: "command",
    v: 1,
    command: command.command,
    payload: command.payload,
    requestId: id,
    timestamp: Date.now(),
  };
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(envelope));
  }
  const optimistic = makeOptimisticActivity(command, id);
  if (optimistic) {
    setState({ activity: [optimistic, ...state.activity].slice(0, ACTIVITY_LIMIT) });
  }
}

/** Echo the user's own message immediately; the robot reply comes via events. */
function makeOptimisticActivity(command: Command, requestId: string): ActivityEntry | null {
  const at = Date.now();
  if (command.command === "ask" || command.command === "speak") {
    const text = command.payload.text;
    if (!text) return null;
    return { id: requestId, at, kind: "command", label: "ask", detail: text, level: "debug", requestId };
  }
  return { id: requestId, at, kind: "command", label: command.command, level: "debug", requestId };
}

/* ------------------------------------------------------------------ *
 * REST helpers
 * ------------------------------------------------------------------ */

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  state: () => req<ServerStateMessage>("/api/state"),
  settings: () => req<AppSettings>("/api/settings"),
  saveSettings: (patch: Partial<AppSettings>) =>
    req<AppSettings>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
  connect: (host: string, port: number) =>
    req<{ connected: boolean }>("/api/connect", {
      method: "POST",
      body: JSON.stringify({ host, port, method: "manual" }),
    }),
  discover: () => req<{ robots: DiscoveredRobot[] }>("/api/discover"),
  connectMdns: () => req<{ connected: boolean }>("/api/connect", { method: "POST", body: JSON.stringify({ method: "mdns" }) }),
  disconnect: () => req<{ ok: boolean }>("/api/disconnect", { method: "POST" }),
  demo: (enabled: boolean) =>
    req<{ demoMode: boolean }>("/api/demo", { method: "POST", body: JSON.stringify({ enabled }) }),
  activity: () => req<{ entries: ActivityEntry[] }>("/api/activity"),
};

export interface AppSettings {
  robotName: string;
  host: string | null;
  port: number;
  connectionMethod: "mdns" | "manual" | "demo";
  autoReconnect: boolean;
  motorSpeed: number;
  volume: number;
  demoMode: boolean;
  cameraEnabled: boolean;
  geminiConfigured: boolean;
}
