# WALL-E Robot API v1

The communication contract between the **WALL-E App** and the **ESP32-C3 firmware**.

The two projects are developed in separate repositories and meet *only* through
this document. Nothing in the app repo may be assumed about firmware internals,
and nothing in the firmware repo may be assumed about the UI.

- Contract version: **1**
- Transport: **WebSocket**, JSON text frames
- Default endpoint: `ws://<robot-ip>:8080/`
- Discovery: **mDNS / DNS-SD**, service type `_walle._tcp.local`
- Reference implementation: [`src/mock/mockRobot.ts`](../src/mock/mockRobot.ts)

---

## 1. Connecting

The firmware runs a WebSocket server on port **8080** and accepts one or more
app connections. The app is the client.

```
WALL-E App (browser)
      │  WebSocket
      ▼
Companion server (Node)  ── mDNS browse ──▶  ESP32-C3
      │  WebSocket  ws://<ip>:8080/
      ▼
   ESP32-C3 firmware
```

The companion server exists because browsers cannot do mDNS and because the
Gemini API key must never reach the browser or the robot.

### 1.1 Handshake

On a successful WebSocket upgrade the firmware **must** send:

```json
{ "type": "event", "v": 1, "event": "robot_ready",
  "payload": { "status": { "…": "RobotStatus" } } }
```

`robot_booted` may be sent immediately before it. A client that receives
neither within ~5 s should treat the connection as unusable.

### 1.2 Optional shared secret

If the firmware is configured with a token, it must reject the upgrade unless
the client sends:

```
Authorization: Bearer <WALLE_ROBOT_TOKEN>
```

The app reads `WALLE_ROBOT_TOKEN` from its own environment and sends it as a
header. **Never** in the query string — URLs end up in logs.

### 1.3 Connection states

| State | Meaning |
|---|---|
| `disconnected` | No socket. Initial state, and after a clean close. |
| `connecting` | First attempt at the current target. |
| `connected` | Socket open. Commands may be sent. |
| `reconnecting` | A retry is scheduled after a drop. |
| `error` | The last attempt failed. |

The app shows **“WALL-E offline”** on `disconnected` / `error`, and retries with
exponential backoff (0.5 s → 10 s) when auto-reconnect is enabled.

---

## 2. Discovery

The firmware advertises itself over mDNS so the user never types an IP.

| Field | Value |
|---|---|
| Service type | `_walle._tcp.local.` |
| Service name | `WALL-E` |
| Port | `8080` |

### TXT record

| Key | Example | Meaning |
|---|---|---|
| `name` | `WALL-E` | Display name shown in the app |
| `fw` | `1.0.0` | Firmware version |
| `model` | `esp32-c3` | Hardware id |

The firmware may also register `wall-e.local` as an mDNS hostname, so
`ws://wall-e.local:8080/` works as a manual fallback.

**Manual connection must always work.** mDNS is frequently blocked on Windows
and some enterprise Wi-Fi; the app therefore keeps a manual IP field and stores
the last successful address.

---

## 3. Message format

Every frame in both directions is a single JSON object. Three envelope types:

### 3.1 Command — app → robot

```json
{
  "type": "command",
  "v": 1,
  "command": "move_forward",
  "requestId": "req-m1a2b3-1-9xk2",
  "payload": { "speed": 0.6, "duration": 600 },
  "timestamp": 1730000000000
}
```

### 3.2 Response — robot → app

Sent exactly once per command, carrying the same `requestId`.

```json
{
  "type": "response",
  "v": 1,
  "requestId": "req-m1a2b3-1-9xk2",
  "success": true,
  "data": { "…": "optional command-specific result" },
  "timestamp": 1730000000123
}
```

On failure:

```json
{
  "type": "response",
  "v": 1,
  "requestId": "req-m1a2b3-1-9xk2",
  "success": false,
  "error": { "code": "E_NOT_SUPPORTED", "message": "camera not configured" },
  "timestamp": 1730000000123
}
```

### 3.3 Event — robot → app

Unsolicited, or correlated to the action that caused it.

```json
{
  "type": "event",
  "v": 1,
  "event": "movement_started",
  "requestId": "req-m1a2b3-1-9xk2",
  "payload": { "direction": "move_forward", "speed": 0.6 },
  "timestamp": 1730000000005
}
```

### 3.4 Rules

1. `v` is required on every frame. The app accepts `v <= 1` and rejects newer
   versions rather than guessing.
2. `requestId` is required on `command` and `response`. A `command` without one
   is rejected with `E_INVALID_PAYLOAD`.
3. Frames above 512 KB are dropped (`E_BAD_JSON`, “message too large”).
4. The app **ignores** inbound `command` frames. A robot cannot instruct the app.
5. `timestamp` is milliseconds since the Unix epoch and is advisory only.

---

## 4. Commands

`payload` is always an object, possibly empty. Out-of-range values are rejected
by the app before transmission.

### Movement

| Command | Payload | Notes |
|---|---|---|
| `move_forward` | `{ duration?, speed? }` | `duration` ms, `speed` 0–1 |
| `move_backward` | `{ duration?, speed? }` | |
| `turn_left` | `{ duration?, speed? }` | differential turn |
| `turn_right` | `{ duration?, speed? }` | |
| `rotate_left` | `{ duration?, speed? }` | in-place |
| `rotate_right` | `{ duration?, speed? }` | in-place |
| `stop` | `{}` | **highest priority.** Ends any movement immediately |

Omitting `duration` means “run until an explicit `stop`”. The app always sends
`stop` on pointer release in manual mode, so the firmware must treat `stop` as
safe to receive at any time, including while already stopped.

### Behaviour

| Command | Payload | Notes |
|---|---|---|
| `dance` | `{ style? }` | Local routine. Firmware picks a sensible duration. |
| `explore` | `{}` | Local autonomous excursion. |
| `idle` | `{}` | Cancel dance/explore, return to rest. |

### Expression

| Command | Payload |
|---|---|
| `set_expression` | `{ "expression": "happy" }` |

Allowed: `neutral`, `happy`, `sad`, `confused`, `surprised`, `thinking`,
`listening`, `speaking`, `idle`.

### Voice / AI

| Command | Payload | Notes |
|---|---|---|
| `speak` | `{ text }` | ≤ 500 chars, TTS on the robot |
| `ask` | `{ text }` | Full STT → Gemini → TTS chain |
| `listen` | `{ duration? }` | Open the mic, emit the transcript |
| `set_volume` | `{ volume }` | 0–1 |
| `interrupt` | `{}` | Abort speech/listening immediately |

`ask` is the only AI command. The app does **not** run Gemini locally: it sends
`ask`, the firmware owns the pipeline, and the app renders the resulting
`gemini_finished` event. The ESP32 must therefore work standalone.

### Camera

| Command | Payload | Notes |
|---|---|---|
| `camera_start` | `{}` | Begins the camera transport the firmware supports |
| `camera_stop` | `{}` | Stops it |

See §7.

### Configuration

| Command | Payload |
|---|---|
| `set_autonomous` | `{ "enabled": true }` |
| `set_motor_speed` | `{ "speed": 0.6 }` |
| `set_pid` | `{ "kp": 8.0, "kd": 0.5, "kp_distance": 2.0 }` |
| `ping` | `{}` |
| `get_status` | `{}` |

`set_autonomous` is the only switch that hands control back to the robot. When
autonomous is `true` the app shows a hint and stops appending `stop` on
release, because WALL-E owns its own movement.

---

## 5. Events

| Event | Payload |
|---|---|
| `robot_booted` | `{ firmwareVersion }` |
| `robot_ready` | `{ status }` |
| `robot_disconnected` | `{ reason? }` |
| `state_changed` | `{ state, previous? }` |
| `movement_started` | `{ direction, speed? }` |
| `movement_stopped` | `{ reason? }` |
| `expression_changed` | `{ expression, previous? }` |
| `mode_changed` | `{ mode }` |
| `autonomous_changed` | `{ enabled }` |
| `listening_started` | `{}` |
| `listening_finished` | `{ transcript? }` |
| `stt_started` | `{}` |
| `stt_finished` | `{ transcript, confidence? }` |
| `gemini_started` | `{ prompt }` |
| `gemini_finished` | `{ text }` |
| `tts_started` | `{ text }` |
| `tts_finished` | `{}` |
| `dance_started` | `{ style? }` |
| `dance_finished` | `{}` |
| `exploration_started` | `{}` |
| `exploration_finished` | `{}` |
| `camera_frame` | `{ mime, data }` |
| `camera_ready` | `{ streamUrl?, width?, height? }` |
| `camera_error` | `{ message }` |
| `status` | `{ status }` |
| `log` | `{ level, message }` |
| `error` | `{ code, message, detail? }` |

The firmware **should** emit `status` after any change to `state`, `expression`,
`mode`, `autonomous`, `motorSpeed` or `volume`, so the app's status panel is
never stale.

### RobotStatus

```json
{
  "name": "WALL-E",
  "firmwareVersion": "1.0.0",
  "ip": "192.168.1.42",
  "mac": "AA:BB:CC:DD:EE:FF",
  "wifiRssi": -52,
  "uptimeMs": 128400,
  "state": "idle",
  "expression": "happy",
  "mode": "manual",
  "autonomous": false,
  "motorSpeed": 0.6,
  "volume": 0.7,
  "freeHeap": 142336,
  "cameraAvailable": true
}
```

`state` ∈ `booting`, `idle`, `moving`, `dancing`, `exploring`, `listening`,
`thinking`, `speaking`, `autonomous`, `charging`, `error`.
`mode` ∈ `manual`, `autonomous`, `demo`.

**`battery` is optional and must be omitted unless a real sensor exists.** The
app hides the row entirely when it is absent, rather than showing a fake 100 %.

---

## 6. Error codes

| Code | Meaning |
|---|---|
| `E_BAD_JSON` | Frame is not parseable JSON, or too large |
| `E_UNSUPPORTED_VERSION` | Missing or newer-than-supported `v` |
| `E_UNKNOWN_TYPE` | Unrecognised `type` or `event` |
| `E_UNKNOWN_COMMAND` | Command not implemented |
| `E_INVALID_PAYLOAD` | Payload missing or out of range |
| `E_UNAUTHORIZED` | Bad or missing shared secret |
| `E_RATE_LIMITED` | Too many commands |
| `E_BUSY` | Robot cannot accept the command right now |
| `E_NOT_SUPPORTED` | Feature absent on this hardware build |
| `E_TIMEOUT` | No response in time |
| `E_INTERNAL` | Firmware fault |

---

## 7. Camera transport

The camera interface is **firmware-decided**. The app renders what it receives
and shows a placeholder otherwise — it does not assume a video codec the
ESP32-C3 has not confirmed.

**Option A — stream URL (preferred if the firmware can sustain it).**

`camera_start` → `camera_ready` with `streamUrl`:

```json
{ "type": "event", "v": 1, "event": "camera_ready",
  "payload": { "streamUrl": "http://192.168.1.42:8081/stream", "width": 160, "height": 120 } }
```

The app hands the URL to a native `<video>` element, which handles MJPEG and
H.264 without a custom demuxer.

**Option B — discrete JPEG frames (recommended for the C3).**

Emit `camera_frame` events at a modest rate, base64-encoded:

```json
{ "type": "event", "v": 1, "event": "camera_frame",
  "payload": { "mime": "image/jpeg", "data": "<base64>", "width": 160, "height": 120 } }
```

Keep the resolution low (QQVGA 160×120 is a reasonable starting point for an
ESP32-C3) and cap the frame rate — 5–10 fps is plenty for a demo and keeps the
WebSocket and heap manageable. The app renders each frame as an `<img>`.

**Option C — no camera.** Reply `camera_start` with
`success: false, error: { code: "E_NOT_SUPPORTED" }`. The app shows
“Camera is not available on this build”.

**Recommendation:** implement Option B first. Streaming video from an ESP32-C3
is expensive in RAM and bandwidth and is the most likely part of this project
to need tuning; discrete frames prove the whole path with far less risk.

---

## 8. Security

- **The Gemini API key never reaches the ESP32 or the browser bundle.** The
  companion server holds it and, for app-initiated `ask`, calls the API itself.
  The robot's own `ask` path uses a key configured in firmware only.
- **The app never executes arbitrary network input.** Every inbound frame is
  parsed and validated (`src/shared/validate.ts`); every outbound command is
  checked against an allowlist (`src/shared/validateCommand.ts`) before it is
  forwarded.
- **The robot cannot drive the app.** Inbound `command` frames are discarded.
- **Rate limiting** — the server caps commands per second per client.
- **Shared secret optional.** `WALLE_ROBOT_TOKEN` adds a bearer check on the
  WebSocket upgrade. On an open Innovation Day network it can be skipped, but
  any deployment on shared Wi-Fi should use it.
- **No destructive commands exist in v1.** `stop` is the only safety-critical
  one and is always transmitted without awaiting a response.

---

## 9. Versioning

- `v` is a single integer. The app accepts `v <= 1`.
- Additive changes (new optional payload fields, new events) keep `v` at 1.
- Breaking changes bump `v`. The app then reports
  `E_UNSUPPORTED_VERSION` instead of misinterpreting frames.
- Unknown fields inside a payload **must be ignored** by both sides.
- Unknown commands and events **must** be rejected/ignored, never crash the peer.

---

## 10. Firmware implementation checklist

- [ ] WebSocket server on port 8080
- [ ] Send `robot_ready` with a full `RobotStatus` on connect
- [ ] mDNS advertise `_walle._tcp.local.` with `name`, `fw`, `model` TXT keys
- [ ] Accept `Authorization: Bearer …` when a token is configured
- [ ] Parse each frame, reply with exactly one `response` per `command`
- [ ] Honour `requestId` on every response
- [ ] Implement all 7 movement commands, with `stop` always safe
- [ ] Implement `dance`, `explore`, `idle`
- [ ] Implement `set_expression` for all 9 expressions
- [ ] Implement `speak`, `ask`, `listen`, `set_volume`, `interrupt`
- [ ] Implement `set_autonomous`, `set_motor_speed`, `set_pid`
- [ ] Implement `ping` and `get_status`
- [ ] Emit `state_changed`, `movement_started`, `movement_stopped`
- [ ] Emit the STT → Gemini → TTS event chain for `ask`
- [ ] Emit `dance_started` / `dance_finished`, `exploration_started` / `_finished`
- [ ] Emit `status` after any status change
- [ ] Implement the camera path (Option B recommended) or fail with `E_NOT_SUPPORTED`
- [ ] Omit `battery` unless a real sensor exists
- [ ] Run standalone: the robot must work with no app connected

---

## 11. Conformance testing

The mock in `src/mock/mockRobot.ts` implements this contract and is exercised
by `tests/robotLink.test.ts`. It is the fastest way for the firmware author to
validate a build:

1. Start the mock: `npm run mock` (add `MOCK_ADVERTISE=1` for mDNS).
2. Start the app: `npm run dev`, enable Demo Mode.
3. Point the real app at the firmware: Connect → enter `<ip>` → `8080`.

For a conformance suite that runs against either implementation, the firmware
side should be able to satisfy the same test file by exposing an identical
WebSocket surface. Every test in `tests/robotLink.test.ts` uses only the wire
protocol — no mock-specific hooks except the optional `onCommand` observer.
