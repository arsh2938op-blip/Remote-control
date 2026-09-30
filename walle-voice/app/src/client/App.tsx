import { useState } from "react";
import { useStore } from "./store.js";
import { useToast } from "./ui/common.js";
import { RobotInfoPanel, ConnectionPanel, SettingsPanel } from "./ui/settings.js";
import { MovementPanel, ExpressionPanel, ModesPanel } from "./ui/controls.js";
import { ChatPanel, ActivityPanel } from "./ui/chat.js";
import { CameraPanel } from "./ui/camera.js";

type Tab = "control" | "connect" | "settings";

const CONNECTION_LABEL: Record<string, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  error: "Error",
};

export function App() {
  const connection = useStore((s) => s.connection);
  const demoMode = useStore((s) => s.demoMode);
  const robotName = useStore((s) => s.robotName);
  const status = useStore((s) => s.status);
  const target = useStore((s) => s.target);
  const lastError = useStore((s) => s.lastError);
  const [tab, setTab] = useState<Tab>("control");
  const [toast, notify] = useToast();

  const offline = connection === "disconnected";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden>
            ▣
          </div>
          <div>
            <h1>{robotName}</h1>
            <div className="hint">
              {target ? `${target.host}:${target.port}` : "no target"} · fw{" "}
              {status?.firmwareVersion ?? "—"}
            </div>
          </div>
        </div>

        <div className="conn">
          <span className={`dot ${connection}`} />
          <span>
            {demoMode && connection !== "connected" ? "Demo — " : ""}
            {CONNECTION_LABEL[connection] ?? connection}
          </span>
        </div>

        <nav className="tabs" role="tablist">
          {(["control", "connect", "settings"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              style={{ textTransform: "capitalize" }}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>

      {demoMode ? <div className="demo-banner">DEMO MODE — simulated robot, no hardware</div> : null}

      {offline && lastError ? (
        <div className="demo-banner" style={{ background: "rgb(229 72 77 / 0.12)", borderColor: "#5c2a2d", color: "#ff9a9e" }}>
          WALL-E offline — {lastError.message}
          {tab !== "connect" ? (
            <button className="ghost" style={{ marginLeft: 10 }} onClick={() => setTab("connect")}>
              Reconnect
            </button>
          ) : null}
        </div>
      ) : null}

      {tab === "control" ? (
        <main className="grid">
          <CameraPanel />
          <RobotInfoPanel />
          <MovementPanel />
          <ModesPanel />
          <ExpressionPanel />
          <ChatPanel />
          <ActivityPanel />
        </main>
      ) : null}

      {tab === "connect" ? (
        <main className="grid">
          <ConnectionPanel notify={notify} />
          <RobotInfoPanel />
        </main>
      ) : null}

      {tab === "settings" ? (
        <main className="grid">
          <SettingsPanel notify={notify} />
          <RobotInfoPanel />
        </main>
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.msg}</div> : null}
    </div>
  );
}
