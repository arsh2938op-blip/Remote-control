/**
 * WebSocket link to the physical ESP32-C3.
 *
 * Responsibilities:
 *  - connect to ws://<host>:<port>/ with backoff reconnect
 *  - surface connection state changes
 *  - validate EVERY inbound frame before it reaches the app
 *  - correlate `requestId` -> response, and time out unanswered commands
 *
 * It knows nothing about UI, HTTP or React.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { parseWireMessage } from "../../shared/validate.js";
import {
  DEFAULT_ROBOT_PORT,
  makeResponse,
  type CommandEnvelope,
  type ConnectionState,
  type EventEnvelope,
  type ResponseEnvelope,
  type RobotEvent,
  type RobotStatus,
  type WireError,
} from "../../shared/protocol.js";

export interface RobotLinkOptions {
  requestTimeoutMs: number;
  reconnect: { enabled: boolean; minDelayMs: number; maxDelayMs: number };
  token?: string;
  /** Injected in tests; defaults to the real `ws` client. */
  createSocket?: (url: string, token?: string) => WebSocketLike;
  /** Default WebSocket port to reach the ESP32 on. */
  defaultPort?: number;
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: (code: number, reason: unknown) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

export interface RobotLinkEvents {
  state: (state: ConnectionState, error?: WireError) => void;
  event: (event: EventEnvelope) => void;
  response: (response: ResponseEnvelope) => void;
  log: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  status: (status: RobotStatus) => void;
}

function realSocketFactory(url: string, token?: string): WebSocketLike {
  const headers: Record<string, string> = {};
  // The shared secret travels in a header, never in the URL (URLs end up in logs).
  if (token) headers.authorization = `Bearer ${token}`;
  const ws = new WebSocket(url, { headers, handshakeTimeout: 5000 });
  return ws as unknown as WebSocketLike;
}

export declare interface RobotLink {
  on<K extends keyof RobotLinkEvents>(event: K, listener: RobotLinkEvents[K]): this;
  emit<K extends keyof RobotLinkEvents>(event: K, ...args: Parameters<RobotLinkEvents[K]>): boolean;
}

export class RobotLink extends EventEmitter {
  private socket: WebSocketLike | null = null;
  private state: ConnectionState = "disconnected";
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private host: string | null = null;
  private port = DEFAULT_ROBOT_PORT;

  private readonly pending = new Map<
    string,
    { resolve: (r: ResponseEnvelope) => void; timer: NodeJS.Timeout }
  >();

  private latestStatus: RobotStatus | null = null;

  constructor(private readonly opts: RobotLinkOptions) {
    super();
    this.setMaxListeners(50);
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get status(): RobotStatus | null {
    return this.latestStatus;
  }

  get target(): { host: string; port: number } | null {
    return this.host ? { host: this.host, port: this.port } : null;
  }

  connect(host: string, port: number = DEFAULT_ROBOT_PORT): void {
    this.host = host;
    this.port = port;
    this.stopped = false;
    this.attempts = 0;
    this.clearReconnect();
    this.open();
  }

  /** Drops the link without forgetting the target (used to force a retry). */
  disconnect(reason = "client requested"): void {
    this.stopped = true;
    this.clearReconnect();
    this.teardownSocket();
    this.failPending({ code: "E_INTERNAL", message: `disconnected: ${reason}` });
    this.setState("disconnected");
  }

  private open(): void {
    if (!this.host) return;
    if (this.socket) return;

    const port = this.port || this.opts.defaultPort || DEFAULT_ROBOT_PORT;
    const url = `ws://${this.host}:${port}/`;
    this.setState(this.attempts === 0 ? "connecting" : "reconnecting");

    const factory = this.opts.createSocket ?? realSocketFactory;
    let socket: WebSocketLike;
    try {
      socket = factory(url, this.opts.token);
    } catch (err) {
      this.emit("log", "error", `socket creation failed: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on("open", () => {
      this.attempts = 0;
      this.emit("log", "info", `connected to ${url}`);
      this.setState("connected");
    });

    socket.on("message", (data) => this.handleFrame(data));

    socket.on("error", (err) => {
      this.emit("log", "error", `socket error: ${err.message}`);
      this.setState("error", { code: "E_INTERNAL", message: err.message });
    });

    socket.on("close", (code, reason) => {
      const text = typeof reason === "string" ? reason : reason?.toString?.() ?? "";
      this.emit("log", "warn", `socket closed (${code}) ${text}`);
      this.teardownSocket();
      this.failPending({ code: "E_INTERNAL", message: "connection lost" });
      this.setState("disconnected");
      this.scheduleReconnect();
    });
  }

  private teardownSocket(): void {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    try {
      // Detach first so our own close handler does not schedule a reconnect.
      s.on("open", () => {});
      s.on("message", () => {});
      s.on("error", () => {});
      s.on("close", () => {});
      s.close();
    } catch {
      /* already closing */
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.opts.reconnect.enabled || !this.host) return;
    this.clearReconnect();
    const delay = Math.min(
      this.opts.reconnect.maxDelayMs,
      this.opts.reconnect.minDelayMs * 2 ** this.attempts,
    );
    this.attempts += 1;
    this.emit("log", "info", `reconnecting in ${delay}ms (attempt ${this.attempts})`);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleFrame(data: unknown): void {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data as Buffer[]).toString("utf8")
            : String(data);

    const parsed = parseWireMessage(text);
    if (!parsed.ok) {
      // Malformed input is reported and dropped; it never reaches the UI as state.
      this.emit("log", "warn", `dropped malformed message: ${parsed.message}`);
      this.emit("event", {
        type: "event",
        v: 1,
        event: "error" as RobotEvent["event"],
        payload: { code: parsed.code, message: parsed.message },
        timestamp: Date.now(),
      } as EventEnvelope);
      return;
    }

    const msg = parsed.value;
    if (msg.type === "event") {
      if (msg.event === "status" || msg.event === "robot_ready") {
        const status =
          msg.event === "status" ? (msg.payload as { status: RobotStatus }).status : undefined;
        if (status) {
          this.latestStatus = status;
          this.emit("status", status);
        }
      }
      this.emit("event", msg);
    } else if (msg.type === "response") {
      this.settle(msg);
    }
    // Inbound `command` frames are not expected; parseWireMessage already
    // validated the shape, and we deliberately ignore the contents.
  }

  private settle(response: ResponseEnvelope): void {
    const entry = this.pending.get(response.requestId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(response.requestId);
      entry.resolve(response);
    }
    this.emit("response", response);
  }

  private failPending(error: WireError): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(makeResponse("unknown", false, undefined, error));
    }
    this.pending.clear();
  }

  /**
   * Sends a validated command and resolves with the robot's response.
   * Always resolves — transport failures come back as an error response, so
   * callers never need a try/catch around the demo UI's fire-and-forget calls.
   */
  send(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!this.socket || this.state !== "connected") {
      return Promise.resolve(
        makeResponse(command.requestId, false, undefined, {
          code: "E_INTERNAL",
          message: "robot not connected",
        }),
      );
    }
    return new Promise<ResponseEnvelope>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.requestId);
        resolve(
          makeResponse(command.requestId, false, undefined, {
            code: "E_TIMEOUT",
            message: `no response within ${this.opts.requestTimeoutMs}ms`,
          }),
        );
      }, this.opts.requestTimeoutMs);

      this.pending.set(command.requestId, { resolve, timer });
      try {
        this.socket!.send(JSON.stringify(command));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(command.requestId);
        resolve(
          makeResponse(command.requestId, false, undefined, {
            code: "E_INTERNAL",
            message: (err as Error).message,
          }),
        );
      }
    });
  }

  /** Fire-and-forget for `stop`, where waiting on a reply would be unsafe. */
  sendNowait(command: CommandEnvelope): boolean {
    if (!this.socket || this.state !== "connected") return false;
    try {
      this.socket.send(JSON.stringify(command));
      return true;
    } catch {
      return false;
    }
  }

  private setState(state: ConnectionState, error?: WireError): void {
    if (this.state === state && !error) return;
    this.state = state;
    this.emit("state", state, error);
  }
}
