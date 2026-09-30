/**
 * In-process mock of the ESP32-C3 firmware.
 *
 * Speaks the exact WALL-E Robot API v1 wire format over a real WebSocket
 * server, so the app can be developed, demoed and tested with no hardware.
 * This is the reference implementation the firmware is validated against.
 */

import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  COMMANDS,
  DEFAULT_ROBOT_PORT,
  ERROR_CODES,
  EXPRESSIONS,
  makeCommand,
  makeEvent,
  makeResponse,
  type CommandEnvelope,
  type ExpressionName,
  type RobotState,
  type RobotStatus,
} from "../shared/protocol.js";
import { parseWireMessage } from "../shared/validate.js";

const DEMO_TRANSCRIPTS = [
  "Tell me a joke.",
  "What can you do?",
  "Who are you?",
  "Do you see anything?",
];

const DEMO_REPLIES = [
  "Why did the robot cross the road? To reach the other charging station! Ha ha!",
  "I can drive, dance, tell expressions, and talk. Pick any button on the screen!",
  "I am WALL-E. I am a compacting robot with a camera and a very curious mind!",
  "I see a floor, a wall, and one very interesting dustbin.",
];

export interface MockRobotOptions {
  port?: number;
  host?: string;
  /** Advertise over mDNS so discovery can be exercised too. */
  advertise?: boolean;
  name?: string;
  firmwareVersion?: string;
  onCommand?: (cmd: CommandEnvelope) => void;
}

export class MockRobot {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private bonjour: { destroy: () => void } | null = null;
  private client: WebSocket | null = null;

  private readonly status: RobotStatus;
  private state: RobotState = "idle";
  private expression: ExpressionName = "neutral";
  private autonomous = false;
  private danceTimer: NodeJS.Timeout | null = null;
  private exploreTimer: NodeJS.Timeout | null = null;
  private movementTimer: NodeJS.Timeout | null = null;
  private transcriptIndex = 0;
  private readonly started = Date.now();
  private readonly opts: Required<Pick<MockRobotOptions, "port" | "host" | "name" | "firmwareVersion">> &
    MockRobotOptions;

  constructor(opts: MockRobotOptions = {}) {
    this.opts = {
      port: opts.port ?? DEFAULT_ROBOT_PORT,
      host: opts.host ?? "0.0.0.0",
      name: opts.name ?? "WALL-E",
      firmwareVersion: opts.firmwareVersion ?? "1.0.0-mock",
      advertise: opts.advertise ?? false,
      onCommand: opts.onCommand,
    };
    this.status = {
      name: this.opts.name,
      firmwareVersion: this.opts.firmwareVersion,
      ip: "127.0.0.1",
      mac: "AA:BB:CC:DD:EE:FF",
      wifiRssi: -48,
      uptimeMs: 0,
      state: "idle",
      expression: "neutral",
      mode: "manual",
      autonomous: false,
      motorSpeed: 0.6,
      volume: 0.7,
      freeHeap: 142_336,
      cameraAvailable: true,
    };
  }

  async start(): Promise<number> {
    this.http = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("WALL-E mock robot\n");
    });
    this.wss = new WebSocketServer({ server: this.http });

    this.wss.on("connection", (socket) => {
      this.client = socket;
      this.pushEvent(makeEvent({ event: "robot_booted", payload: { firmwareVersion: this.opts.firmwareVersion } }));
      this.pushEvent(makeEvent({ event: "robot_ready", payload: { status: this.snapshot() } }));

      socket.on("message", (raw) => this.handleFrame(raw.toString()));
      socket.on("close", () => {
        if (this.client === socket) this.client = null;
        this.stopMovement();
      });
      socket.on("error", () => this.stopMovement());
    });

    await new Promise<void>((done) => this.http!.listen(this.opts.port, this.opts.host, done));
    const addr = this.http.address();
    const port = typeof addr === "object" && addr ? addr.port : this.opts.port;
    this.status.ip = this.opts.host === "0.0.0.0" ? "127.0.0.1" : this.opts.host;

    if (this.opts.advertise) this.advertise(port);
    return port;
  }

  private advertise(port: number): void {
    // Imported lazily so the mock stays usable in environments without mdns.
    import("bonjour-service")
      .then(({ Bonjour }) => {
        const bonjour = new Bonjour();
        bonjour.publish({
          name: this.opts.name,
          type: "walle",
          port,
          txt: { name: this.opts.name, fw: this.opts.firmwareVersion, model: "esp32-c3" },
        });
        this.bonjour = bonjour;
      })
      .catch(() => {
        /* discovery is optional */
      });
  }

  private handleFrame(text: string): void {
    const parsed = parseWireMessage(text);
    if (!parsed.ok) {
      // Even a rejected frame gets a reply, correlated to the sender's own
      // requestId where one can be recovered.
      this.push(
        makeResponse(extractRequestId(text) ?? "unknown", false, undefined, {
          code: parsed.code as (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
          message: parsed.message,
        }),
      );
      return;
    }
    if (parsed.value.type !== "command") return;
    const cmd = parsed.value as CommandEnvelope;
    this.opts.onCommand?.(cmd);
    this.execute(cmd);
  }

  private execute(cmd: CommandEnvelope): void {
    const { command: name, requestId, payload } = cmd as CommandEnvelope & {
      payload: Record<string, unknown>;
    };
    const ok = () => {
      this.push(makeResponse(requestId, true));
      this.pushStatus();
    };
    const fail = (code: string, message: string) =>
      this.push(makeResponse(requestId, false, undefined, { code, message }));

    switch (name) {
      case COMMANDS.MOVE_FORWARD:
      case COMMANDS.MOVE_BACKWARD:
      case COMMANDS.TURN_LEFT:
      case COMMANDS.TURN_RIGHT:
      case COMMANDS.ROTATE_LEFT:
      case COMMANDS.ROTATE_RIGHT: {
        const duration = typeof payload.duration === "number" ? payload.duration : 600;
        const speed = typeof payload.speed === "number" ? payload.speed : this.status.motorSpeed;
        this.stopMovement();
        this.setState("moving");
        this.pushEvent(
          makeEvent(
            { event: "movement_started", payload: { direction: name, speed } },
            requestId,
          ),
        );
        this.movementTimer = setTimeout(() => {
          this.movementTimer = null;
          this.pushEvent(makeEvent({ event: "movement_stopped", payload: { reason: "duration_elapsed" } }, requestId));
          this.setState(this.autonomous ? "autonomous" : "idle");
        }, Math.max(50, Math.min(duration, 10_000)));
        return ok();
      }

      case COMMANDS.STOP:
        this.stopMovement();
        this.pushEvent(makeEvent({ event: "movement_stopped", payload: { reason: "command" } }, requestId));
        this.setState(this.autonomous ? "autonomous" : "idle");
        return ok();

      case COMMANDS.DANCE: {
        this.stopMovement();
        this.setState("dancing");
        this.pushEvent(makeEvent({ event: "dance_started", payload: { style: "wiggle" } }, requestId));
        this.danceTimer = setTimeout(() => {
          this.danceTimer = null;
          this.pushEvent(makeEvent({ event: "dance_finished", payload: {} }, requestId));
          this.setState("idle");
        }, 3000);
        return ok();
      }

      case COMMANDS.EXPLORE: {
        this.stopMovement();
        this.setState("exploring");
        this.pushEvent(makeEvent({ event: "exploration_started", payload: {} }, requestId));
        this.exploreTimer = setTimeout(() => {
          this.exploreTimer = null;
          this.pushEvent(makeEvent({ event: "exploration_finished", payload: {} }, requestId));
          this.setState("idle");
        }, 4000);
        return ok();
      }

      case COMMANDS.IDLE:
        this.stopMovement();
        this.setState("idle");
        return ok();

      case COMMANDS.SET_EXPRESSION: {
        const expression = payload.expression as ExpressionName;
        if (!EXPRESSIONS.includes(expression)) {
          return fail(ERROR_CODES.INVALID_PAYLOAD, `unknown expression '${String(expression)}'`);
        }
        const previous = this.expression;
        this.expression = expression;
        this.pushEvent(
          makeEvent(
            { event: "expression_changed", payload: { expression, previous } },
            requestId,
          ),
        );
        return ok();
      }

      case COMMANDS.SPEAK: {
        const text = String(payload.text ?? "");
        this.pushEvent(makeEvent({ event: "tts_started", payload: { text } }, requestId));
        this.expression = "speaking";
        this.setState("speaking");
        setTimeout(() => {
          this.pushEvent(makeEvent({ event: "tts_finished", payload: {} }, requestId));
          this.setState("idle");
        }, Math.min(1200, 250 + text.length * 25));
        return ok();
      }

      case COMMANDS.ASK: {
        const text = String(payload.text ?? "");
        this.expression = "thinking";
        this.setState("thinking");
        this.pushEvent(makeEvent({ event: "stt_started", payload: {} }, requestId));
        setTimeout(() => {
          this.pushEvent(makeEvent({ event: "stt_finished", payload: { transcript: text, confidence: 0.94 } }, requestId));
          this.pushEvent(makeEvent({ event: "gemini_started", payload: { prompt: text } }, requestId));
        }, 250);
        setTimeout(() => {
          this.pushEvent(makeEvent({ event: "gemini_finished", payload: { text: this.replyFor(text) } }, requestId));
          this.pushEvent(makeEvent({ event: "tts_started", payload: { text: this.replyFor(text) } }, requestId));
        }, 700);
        setTimeout(() => {
          this.pushEvent(makeEvent({ event: "tts_finished", payload: {} }, requestId));
          this.setState("idle");
        }, 1600);
        return ok();
      }

      case COMMANDS.LISTEN:
        this.pushEvent(makeEvent({ event: "listening_started", payload: {} }, requestId));
        this.setState("listening");
        setTimeout(() => {
          const transcript = DEMO_TRANSCRIPTS[this.transcriptIndex % DEMO_TRANSCRIPTS.length]!;
          this.transcriptIndex += 1;
          this.pushEvent(
            makeEvent({ event: "listening_finished", payload: { transcript } }, requestId),
          );
          this.setState("idle");
        }, 900);
        return ok();

      case COMMANDS.INTERRUPT:
        this.stopMovement();
        this.setState("idle");
        return ok();

      case COMMANDS.SET_AUTONOMOUS: {
        this.autonomous = Boolean(payload.enabled);
        this.status.autonomous = this.autonomous;
        this.status.mode = this.autonomous ? "autonomous" : "manual";
        this.pushEvent(
          makeEvent({ event: "autonomous_changed", payload: { enabled: this.autonomous } }, requestId),
        );
        this.pushEvent(
          makeEvent({ event: "mode_changed", payload: { mode: this.status.mode } }, requestId),
        );
        if (!this.autonomous && this.state === "autonomous") this.setState("idle");
        return ok();
      }

      case COMMANDS.SET_MOTOR_SPEED: {
        const speed = Number(payload.speed);
        if (!Number.isFinite(speed) || speed < 0 || speed > 1) {
          return fail(ERROR_CODES.INVALID_PAYLOAD, "speed must be 0..1");
        }
        this.status.motorSpeed = speed;
        return ok();
      }

      case COMMANDS.SET_VOLUME: {
        const volume = Number(payload.volume);
        if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
          return fail(ERROR_CODES.INVALID_PAYLOAD, "volume must be 0..1");
        }
        this.status.volume = volume;
        return ok();
      }

      case COMMANDS.SET_PID:
        // Accepted for protocol compliance; the mock has no motor tuning loop.
        return ok();

      case COMMANDS.CAMERA_START:
        this.pushEvent(
          makeEvent(
            {
              event: "camera_ready",
              payload: { width: 160, height: 120 },
            },
            requestId,
          ),
        );
        return ok();

      case COMMANDS.CAMERA_STOP:
        return ok();

      case COMMANDS.PING:
        return this.push(
          makeResponse(requestId, true, { pong: true, at: Date.now(), status: this.snapshot() }),
        );

      case COMMANDS.GET_STATUS:
        return this.push(makeResponse(requestId, true, { status: this.snapshot() }));

      default:
        return fail(ERROR_CODES.UNKNOWN_COMMAND, `unknown command '${String(name)}'`);
    }
  }

  private replyFor(prompt: string): string {
    const p = prompt.toLowerCase();
    const idx = DEMO_REPLIES.findIndex((r) => {
      if (p.includes("joke")) return r.includes("joke") || r.includes("cross the road");
      if (p.includes("who")) return r.includes("WALL-E");
      if (p.includes("camera") || p.includes("see")) return r.includes("camera") || r.includes("floor");
      return false;
    });
    return idx >= 0 ? DEMO_REPLIES[idx]! : DEMO_REPLIES[this.transcriptIndex++ % DEMO_REPLIES.length]!;
  }

  private stopMovement(): void {
    if (this.movementTimer) {
      clearTimeout(this.movementTimer);
      this.movementTimer = null;
      this.pushEvent(makeEvent({ event: "movement_stopped", payload: { reason: "interrupted" } }));
    }
    if (this.danceTimer) {
      clearTimeout(this.danceTimer);
      this.danceTimer = null;
      this.pushEvent(makeEvent({ event: "dance_finished", payload: {} }));
    }
    if (this.exploreTimer) {
      clearTimeout(this.exploreTimer);
      this.exploreTimer = null;
      this.pushEvent(makeEvent({ event: "exploration_finished", payload: {} }));
    }
  }

  private setState(state: RobotState): void {
    if (this.state === state) return;
    const previous = this.state;
    this.state = state;
    this.pushEvent(makeEvent({ event: "state_changed", payload: { state, previous } }));
  }

  private snapshot(): RobotStatus {
    return {
      ...this.status,
      uptimeMs: Date.now() - this.started,
      state: this.state,
      expression: this.expression,
      autonomous: this.autonomous,
      mode: this.autonomous ? "autonomous" : "manual",
    };
  }

  private pushEvent(event: ReturnType<typeof makeEvent>): void {
    this.push(event);
    if (event.event === "state_changed") this.pushStatus();
  }

  /** Status is pushed after every accepted command so the UI never goes stale. */
  private pushStatus(): void {
    this.push(makeEvent({ event: "status", payload: { status: this.snapshot() } }));
  }

  private push(msg: unknown): void {
    if (this.client && this.client.readyState === 1) {
      this.client.send(JSON.stringify(msg));
    }
  }

  async stop(): Promise<void> {
    this.stopMovement();
    this.bonjour?.destroy();
    this.client?.close();
    this.wss?.close();
    await new Promise<void>((done) => {
      if (!this.http) return done();
      this.http.close(() => done());
    });
    this.http = null;
    this.wss = null;
  }
}

// Convenience: emit a single canned command into the mock (used by tests).
export function demoCommand(command: CommandEnvelope["command"], payload: unknown) {
  return makeCommand({ command, payload } as never, "demo-test");
}

/** Best-effort requestId recovery from a frame that failed validation. */
function extractRequestId(text: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw === "object" && raw !== null) {
      const id = (raw as { requestId?: unknown }).requestId;
      if (typeof id === "string" && id.length > 0) return id;
    }
  } catch {
    /* unparseable: no id to recover */
  }
  return undefined;
}
