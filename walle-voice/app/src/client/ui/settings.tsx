import { useEffect, useState } from "react";
import { api, useStore, sendCommand, type AppSettings } from "../store.js";
import { COMMANDS, DEFAULT_ROBOT_PORT, type DiscoveredRobot } from "../../shared/protocol.js";

export function RobotInfoPanel() {
  const status = useStore((s) => s.status);
  const target = useStore((s) => s.target);
  const demoMode = useStore((s) => s.demoMode);
  const connection = useStore((s) => s.connection);
  const name = useStore((s) => s.robotName);

  const rows: [string, React.ReactNode][] = [
    ["Robot name", name],
    ["Connection", connection],
    ["IP", demoMode ? "demo (simulated)" : (status?.ip ?? target?.host ?? "—")],
    ["Firmware", status?.firmwareVersion ?? "—"],
    ["Wi-Fi", status?.wifiRssi !== undefined ? `${status.wifiRssi} dBm` : "—"],
    ["State", status?.state ?? "—"],
    ["Mode", status?.mode ?? "—"],
    ["Autonomous", status?.autonomous ? "ON" : "OFF"],
    // Shown only when the firmware actually reports a battery sensor.
    ...(status?.battery
      ? ([
          [
            "Battery",
            `${status.battery.percent}%${status.battery.charging ? " (charging)" : ""}${
              status.battery.millivolts ? ` · ${status.battery.millivolts} mV` : ""
            }`,
          ],
        ] as [string, React.ReactNode][])
      : []),
    ["Heap free", status?.freeHeap ? `${(status.freeHeap / 1024).toFixed(1)} KB` : "—"],
  ];

  return (
    <div className="card col-4">
      <h2>Robot</h2>
      {rows.map(([k, v]) => (
        <div className="stat-row" key={k}>
          <span>{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}

export function ConnectionPanel({ notify }: { notify: (m: string, k?: "ok" | "err") => void }) {
  const connection = useStore((s) => s.connection);
  const robots = useStore((s) => s.robots);
  const demoMode = useStore((s) => s.demoMode);
  const target = useStore((s) => s.target);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(DEFAULT_ROBOT_PORT);
  const [scanning, setScanning] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    void api
      .settings()
      .then((s) => {
        setSettings(s);
        if (s.host) setHost(s.host);
        setPort(s.port);
      })
      .catch(() => {});
  }, []);

  const scan = async () => {
    setScanning(true);
    try {
      const { robots: found } = await api.discover();
      if (found.length === 0) notify("No WALL-E found on this network. Use manual IP entry.");
      else notify(`Found ${found.length} robot(s).`);
    } catch (err) {
      notify((err as Error).message, "err");
    } finally {
      setScanning(false);
    }
  };

  const connectManual = async () => {
    if (!host.trim()) return notify("Enter an IP address or hostname", "err");
    try {
      await api.connect(host.trim(), Number(port) || DEFAULT_ROBOT_PORT);
      notify("Connecting…");
    } catch (err) {
      notify((err as Error).message, "err");
    }
  };

  const useRobot = (robot: DiscoveredRobot) => {
    setHost(robot.host);
    setPort(robot.port);
    void api
      .connect(robot.host, robot.port)
      .then(() => notify(`Connecting to ${robot.name}…`))
      .catch((err: Error) => notify(err.message, "err"));
  };

  const toggleDemo = async () => {
    try {
      const { demoMode: now } = await api.demo(!demoMode);
      notify(now ? "Demo mode ON — simulated robot" : "Demo mode OFF");
    } catch (err) {
      notify((err as Error).message, "err");
    }
  };

  return (
    <div className="card col-8">
      <h2>Connection</h2>

      <div className="btn-row">
        <button onClick={scan} disabled={scanning}>
          {scanning ? "Scanning…" : "Scan for WALL-E"}
        </button>
        <button
          onClick={() => void api.connectMdns().then(() => notify("Connecting to discovered robot…")).catch((e: Error) => notify(e.message, "err"))}
        >
          Auto-connect
        </button>
        <button className={demoMode ? "on" : ""} onClick={toggleDemo}>
          {demoMode ? "Demo mode: ON" : "Demo mode: OFF"}
        </button>
        <button className="danger" disabled={connection === "disconnected"} onClick={() => void api.disconnect()}>
          Disconnect
        </button>
      </div>

      {robots.length > 0 ? (
        <div className="discovered" style={{ marginTop: 10 }}>
          {robots.map((r) => (
            <button key={r.id} onClick={() => useRobot(r)}>
              <span>
                <strong>{r.name}</strong> <span className="addr">{r.host}</span>
              </span>
              <span className="addr">connect →</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="form-grid" style={{ marginTop: 12 }}>
        <div className="form-row">
          <label htmlFor="ip">IP address or hostname</label>
          <input
            id="ip"
            value={host}
            placeholder="192.168.1.42 or wall-e.local"
            onChange={(e) => setHost(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connectManual()}
          />
        </div>
        <div className="form-row">
          <label htmlFor="port">Port</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              id="port"
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
            />
            <button className="primary" onClick={connectManual}>
              Connect
            </button>
          </div>
        </div>
      </div>

      {target ? (
        <p className="hint" style={{ margin: 0 }}>
          Target: {target.host}:{target.port} ({target.source})
        </p>
      ) : null}
      {settings ? <p className="hint" style={{ margin: 0 }}>Saved host: {settings.host ?? "none yet"}</p> : null}
    </div>
  );
}

export function SettingsPanel({ notify }: { notify: (m: string, k?: "ok" | "err") => void }) {
  const connected = useStore((s) => s.connection === "connected");
  const status = useStore((s) => s.status);
  const [s, setS] = useState<AppSettings | null>(null);
  const [key, setKey] = useState("");

  useEffect(() => {
    void api.settings().then(setS).catch(() => {});
  }, []);

  if (!s) return <div className="card col-6"><h2>Settings</h2><div className="hint">Loading…</div></div>;

  const patch = async (next: Partial<AppSettings>) => {
    try {
      const saved = await api.saveSettings(next);
      setS(saved);
    } catch (err) {
      notify((err as Error).message, "err");
    }
  };

  const saveKey = async () => {
    if (!key.trim()) return;
    // Sent once to the local companion server over loopback/LAN; stored in the
    // server process env, never in the browser bundle and never sent to the robot.
    const saved = await api.saveSettings({ geminiApiKey: key.trim() } as Partial<AppSettings>);
    setS(saved);
    setKey("");
    notify("API key saved on the companion server");
  };

  return (
    <div className="card col-6">
      <h2>Settings</h2>

      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="name">Robot name</label>
          <input
            id="name"
            defaultValue={s.robotName}
            onBlur={(e) => e.target.value !== s.robotName && patch({ robotName: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label htmlFor="cm">Connection method</label>
          <select
            id="cm"
            value={s.connectionMethod}
            onChange={(e) => patch({ connectionMethod: e.target.value as AppSettings["connectionMethod"] })}
          >
            <option value="mdns">Auto (mDNS)</option>
            <option value="manual">Manual IP</option>
            <option value="demo">Demo only</option>
          </select>
        </div>
      </div>

      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="ms">Motor speed — {(s.motorSpeed * 100).toFixed(0)}%</label>
          <input
            id="ms"
            type="range"
            min={0}
            max={1}
            step={0.05}
            defaultValue={s.motorSpeed}
            onChange={(e) => {
              const v = Number(e.target.value);
              setS({ ...s, motorSpeed: v });
              if (connected) sendCommand({ command: COMMANDS.SET_MOTOR_SPEED, payload: { speed: v } });
            }}
            onMouseUp={() => void patch({ motorSpeed: s.motorSpeed })}
            onTouchEnd={() => void patch({ motorSpeed: s.motorSpeed })}
          />
        </div>
        <div className="form-row">
          <label htmlFor="vol">Volume — {((s.volume ?? 0.7) * 100).toFixed(0)}%</label>
          <input
            id="vol"
            type="range"
            min={0}
            max={1}
            step={0.05}
            defaultValue={s.volume}
            onChange={(e) => {
              const v = Number(e.target.value);
              setS({ ...s, volume: v });
              if (connected) sendCommand({ command: COMMANDS.SET_VOLUME, payload: { volume: v } });
            }}
            onMouseUp={() => void patch({ volume: s.volume })}
            onTouchEnd={() => void patch({ volume: s.volume })}
          />
        </div>
      </div>

      <div className="switch-row">
        <div>
          <strong>Auto reconnect</strong>
          <div className="hint">Retry with backoff if WALL-E reboots or Wi-Fi drops</div>
        </div>
        <button
          className="switch"
          role="switch"
          aria-checked={s.autoReconnect}
          aria-label="Auto reconnect"
          onClick={() => patch({ autoReconnect: !s.autoReconnect })}
        />
      </div>

      <div className="form-row">
        <label htmlFor="gk">Gemini API key {s.geminiConfigured ? "— configured on server" : "— not set"}</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="gk"
            type="password"
            value={key}
            placeholder="paste key to store server-side"
            onChange={(e) => setKey(e.target.value)}
          />
          <button onClick={saveKey} disabled={!key.trim()}>
            Save
          </button>
        </div>
        <span className="hint">
          Held by the companion server only. Without a key the app answers from a small
          offline reply set, so demos still work.
        </span>
      </div>

      <p className="hint" style={{ marginBottom: 0 }}>
        STT and TTS run on the robot itself; the app only shows their status
        {status ? ` (currently ${status.state})` : ""}.
      </p>
    </div>
  );
}
