import { useEffect, useRef, useState } from "react";
import { useStore, sendCommand } from "../store.js";
import { COMMANDS } from "../../shared/protocol.js";

/**
 * Camera view.
 *
 * The firmware decides the transport. Two are supported, in priority order:
 *   1. a stream URL advertised via the `camera_ready` event
 *   2. individual JPEG `camera_frame` events (snapshot mode)
 *
 * The app never assumes a video protocol the ESP32 has not confirmed — it
 * renders what arrives and shows a placeholder otherwise.
 */
export function CameraPanel() {
  const connected = useStore((s) => s.connection === "connected");
  const camera = useStore((s) => s.camera);
  const frame = useStore((s) => s.frame);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    setVideoFailed(false);
    if (camera.streamUrl && videoRef.current) {
      videoRef.current.src = camera.streamUrl;
      void videoRef.current.play().catch(() => setVideoFailed(true));
    }
  }, [camera.streamUrl]);

  const start = () => sendCommand({ command: COMMANDS.CAMERA_START, payload: {} });
  const stop = () => sendCommand({ command: COMMANDS.CAMERA_STOP, payload: {} });

  const { status } = camera;
  const live = status === "live" && !!camera.streamUrl && !videoFailed;

  return (
    <div className="card col-7">
      <h2>Camera</h2>
      <div className="camera">
        {live ? (
          <video ref={videoRef} playsInline muted autoPlay />
        ) : frame ? (
          <img src={frame} alt="WALL-E camera view" />
        ) : (
          <div className="placeholder">
            {status === "error"
              ? camera.error ?? "Camera error reported by WALL-E."
              : !connected
                ? "Connect to WALL-E to use the camera."
                : status === "live"
                  ? "Stream URL offered but not playable in this browser."
                  : "Camera is off. Press Start to open the ESP32-C3 camera."}
          </div>
        )}
      </div>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <button className="primary" disabled={!connected || status === "live" || status === "snapshots"} onClick={start}>
          Start
        </button>
        <button disabled={!connected || status === "idle"} onClick={stop}>
          Stop
        </button>
        <span className="hint" style={{ alignSelf: "center" }}>
          {live ? "Streaming" : status === "snapshots" ? "Snapshot mode" : ""}
        </span>
      </div>
    </div>
  );
}
