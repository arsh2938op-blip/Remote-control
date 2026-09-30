import { useEffect, useRef, useState } from "react";
import { useStore, sendCommand } from "../store.js";
import { COMMANDS } from "../../shared/protocol.js";
import { timeOf } from "./common.js";

export function ChatPanel() {
  const connected = useStore((s) => s.connection === "connected");
  const chat = useStore((s) => s.chat);
  const listening = useStore((s) => s.status?.state === "listening");
  const thinking = useStore((s) => s.status?.state === "thinking");
  const speaking = useStore((s) => s.status?.state === "speaking");
  const [text, setText] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.length]);

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    sendCommand({ command: COMMANDS.ASK, payload: { text: value } });
    setHistory((h) => [value, ...h].slice(0, 10));
    setText("");
  };

  const micState = listening ? "Listening…" : thinking ? "Thinking…" : speaking ? "Speaking…" : null;

  return (
    <div className="card col-7">
      <h2>Talk to WALL-E</h2>

      <div className="chat">
        {chat.length === 0 ? (
          <div className="bubble system">
            Ask WALL-E something, e.g. “Tell me a joke.” The robot handles STT → Gemini → TTS.
          </div>
        ) : (
          chat.map((m) => (
            <div key={m.id} className={`bubble ${m.from}`}>
              {m.text}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <input
          value={text}
          placeholder={connected ? "Message WALL-E…" : "Not connected"}
          disabled={!connected}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <button className="primary" disabled={!connected || !text.trim()} onClick={submit}>
          Send
        </button>
        <button
          disabled={!connected}
          title="Start listening on the robot microphone"
          onClick={() => sendCommand({ command: COMMANDS.LISTEN, payload: {} })}
        >
          {micState ? "…" : "Talk"}
        </button>
      </div>

      {micState ? <p className="hint">{micState}</p> : null}

      {history.length > 0 ? (
        <div className="btn-row" style={{ marginTop: 8 }}>
          {history.slice(0, 4).map((h) => (
            <button key={h} className="ghost" onClick={() => setText(h)}>
              {h}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ActivityPanel() {
  const activity = useStore((s) => s.activity);
  const [showDebug, setShowDebug] = useState(false);

  const rows = activity.filter((a) => showDebug || a.level !== "debug").slice(0, 120);

  return (
    <div className="card col-5">
      <h2>
        Activity{" "}
        <button
          className="ghost"
          style={{ float: "right", padding: "2px 8px", fontSize: 12 }}
          onClick={() => setShowDebug((v) => !v)}
        >
          {showDebug ? "hide low-level" : "show low-level"}
        </button>
      </h2>
      <div className="activity">
        {rows.length === 0 ? (
          <div className="hint">No activity yet.</div>
        ) : (
          rows.map((a) => (
            <div key={a.id} className={`activity-row ${a.level ?? "info"}`}>
              <span className="t">{timeOf(a.at)}</span>
              <span className="k">{a.kind}</span>
              <span className="l">{a.label}</span>
              {a.detail ? <span className="d">{a.detail}</span> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
