import { useEffect, useState } from "react";
import { useStore, sendCommand } from "../store.js";
import { COMMANDS, type ExpressionName } from "../../shared/protocol.js";
import { HoldButton } from "./common.js";

const EXPRESSION_EMOJI: Record<string, string> = {
  neutral: "😐",
  happy: "😄",
  sad: "🙁",
  confused: "😕",
  surprised: "😲",
  thinking: "🤔",
  listening: "👂",
  speaking: "🗣️",
  idle: "😌",
};

const TEST_EXPRESSIONS: ExpressionName[] = [
  "happy",
  "confused",
  "surprised",
  "thinking",
  "listening",
  "speaking",
  "idle",
];

export function MovementPanel() {
  const connected = useStore((s) => s.connection === "connected");
  const moving = useStore((s) => s.moving);
  const motorSpeed = useStore((s) => s.status?.motorSpeed ?? 0.6);
  const autonomous = useStore((s) => s.status?.autonomous ?? false);

  // In manual mode a held direction must end in an explicit stop, otherwise
  // the robot drives off the table. In autonomous mode WALL-E owns movement.
  const stopOnRelease = !autonomous;

  const stop = () => sendCommand({ command: COMMANDS.STOP, payload: {} });
  const drive = (command: typeof COMMANDS.MOVE_FORWARD | typeof COMMANDS.MOVE_BACKWARD | typeof COMMANDS.TURN_LEFT | typeof COMMANDS.TURN_RIGHT | typeof COMMANDS.ROTATE_LEFT | typeof COMMANDS.ROTATE_RIGHT) =>
    sendCommand({ command, payload: { speed: motorSpeed } });

  return (
    <div className="card col-6">
      <h2>Movement</h2>
      <div className="dpad">
        <div className="spacer" />
        <HoldButton
          label="Forward"
          disabled={!connected}
          onPress={() => drive(COMMANDS.MOVE_FORWARD)}
          onHold={() => {}}
          onRelease={() => stopOnRelease && stop()}
        />
        <div className="spacer" />

        <HoldButton
          label="Left"
          disabled={!connected}
          onPress={() => drive(COMMANDS.TURN_LEFT)}
          onHold={() => {}}
          onRelease={() => stopOnRelease && stop()}
        />
        <button className="stop" disabled={!connected} onClick={stop}>
          STOP
        </button>
        <HoldButton
          label="Right"
          disabled={!connected}
          onPress={() => drive(COMMANDS.TURN_RIGHT)}
          onHold={() => {}}
          onRelease={() => stopOnRelease && stop()}
        />

        <div className="spacer" />
        <HoldButton
          label="Back"
          disabled={!connected}
          onPress={() => drive(COMMANDS.MOVE_BACKWARD)}
          onHold={() => {}}
          onRelease={() => stopOnRelease && stop()}
        />
        <div className="spacer" />
      </div>

      <div className="hold-row">
        <HoldButton
          label="↺ Rotate Left"
          disabled={!connected}
          onPress={() => drive(COMMANDS.ROTATE_LEFT)}
          onHold={() => {}}
          onRelease={() => stopOnRelease && stop()}
        />
        <HoldButton
          label="↻ Rotate Right"
          disabled={!connected}
          onPress={() => drive(COMMANDS.ROTATE_RIGHT)}
          onHold={() => {}}
          onRelease={() => stopOnRelease && stop()}
        />
      </div>

      <p className="hint" style={{ marginBottom: 0 }}>
        {autonomous
          ? "Autonomous Mode is on — WALL-E chooses its own movements."
          : moving
            ? "Moving — release a direction to stop."
            : "Hold a direction to drive, release to stop."}
      </p>
    </div>
  );
}

export function ExpressionPanel() {
  const connected = useStore((s) => s.connection === "connected");
  const current = useStore((s) => s.status?.expression ?? "neutral");

  return (
    <div className="card col-6">
      <h2>Expression</h2>
      <div className="expr-face" aria-hidden>
        {EXPRESSION_EMOJI[current] ?? "😐"}
      </div>
      <div className="expressions">
        {TEST_EXPRESSIONS.map((expression) => (
          <button
            key={expression}
            disabled={!connected}
            aria-pressed={current === expression}
            onClick={() => sendCommand({ command: COMMANDS.SET_EXPRESSION, payload: { expression } })}
          >
            <span aria-hidden>{EXPRESSION_EMOJI[expression] ?? ""}</span> {expression}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ModesPanel() {
  const connected = useStore((s) => s.connection === "connected");
  const status = useStore((s) => s.status);
  const autonomous = status?.autonomous ?? false;

  // Local mirror so the button reacts on tap; the robot's own events correct it.
  const [danceLatched, setDanceLatched] = useState(false);
  const [exploreLatched, setExploreLatched] = useState(false);

  useEffect(() => {
    setDanceLatched(status?.state === "dancing");
    setExploreLatched(status?.state === "exploring");
  }, [status?.state]);

  return (
    <div className="card col-6">
      <h2>Modes</h2>
      <div className="modes">
        <button
          className="primary"
          disabled={!connected || danceLatched}
          onClick={() => {
            setDanceLatched(true);
            sendCommand({ command: COMMANDS.DANCE, payload: {} });
          }}
        >
          {danceLatched ? "Dancing…" : "Dance"}
        </button>

        <button
          disabled={!connected || exploreLatched}
          onClick={() => {
            setExploreLatched(true);
            sendCommand({ command: COMMANDS.EXPLORE, payload: {} });
          }}
        >
          {exploreLatched ? "Exploring…" : "Explore"}
        </button>

        <div className="switch-row">
          <div>
            <strong>Autonomous Mode</strong>
            <div className="hint">WALL-E decides its own movements</div>
          </div>
          <button
            className="switch"
            role="switch"
            aria-checked={autonomous}
            aria-label="Autonomous mode"
            disabled={!connected}
            onClick={() =>
              sendCommand({
                command: COMMANDS.SET_AUTONOMOUS,
                payload: { enabled: !autonomous },
              })
            }
          />
        </div>

        <button
          className="ghost"
          disabled={!connected}
          onClick={() => sendCommand({ command: COMMANDS.IDLE, payload: {} })}
        >
          Idle
        </button>
      </div>
    </div>
  );
}
