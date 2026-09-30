# WALL-E — Companion App

Control centre for the WALL-E Innovation Day robot (ESP32-C3 + camera, OLED,
microphone, speaker, 4 motors, Gemini AI, STT, TTS).

> **This repository is the APP only.** The ESP32 firmware lives in a separate
> repository. The two meet through a documented contract:
> **[WALL-E Robot API v1](docs/WALL-E_ROBOT_API.md)**. Nothing here modifies or
> depends on firmware internals.

---

## Quick start

```bash
npm install

# Terminal 1 — companion server (discovery, command broker, Gemini proxy)
npm run dev:server

# Terminal 2 — UI
npm run dev:client
```

Open <http://localhost:5173> and press **Demo Mode** to drive the simulated
robot. No hardware needed.

To run against the real robot: both the laptop and the ESP32 must be on the
same Wi-Fi. Press **Scan for WALL-E** (or enter the IP manually and press
**Connect**).

### Production build

```bash
npm run build   # typecheck + bundle the client
npm start       # serves API, WebSocket and the built UI on :8787
```

---

## Architecture

```
src/
  shared/        protocol + validation, imported by BOTH sides
    protocol.ts        ← single source of truth for commands, events, messages
    validate.ts        ← validates every inbound robot message
    validateCommand.ts ← allowlist + range checks on every outbound command
  server/
    index.ts           entry point
    appServer.ts       broker: HTTP API, app WebSocket, command routing
    config.ts          env/.env config; the only place secrets are read
    discovery.ts       mDNS browse for _walle._tcp.local
    connection/
      robotLink.ts     WebSocket to the ESP32: reconnect, requestId
                       correlation, timeouts, inbound validation
    services/
      gemini.ts        server-side Gemini calls + offline fallback
    storage/
      settingsStore.ts persisted settings (.walle/settings.json)
  client/
    App.tsx            three tabs: control / connect / settings
    store.ts           app socket, state, optimistic activity
    ui/                controls, chat, camera, settings, activity
  mock/
    mockRobot.ts       reference implementation of Robot API v1
tests/                 83 tests over the protocol, link and server
docs/WALL-E_ROBOT_API.md
```

### Why a Node server in the middle?

The browser cannot do three of the things this app needs:

1. **mDNS discovery** — a browser has no access to multicast.
2. **Hiding the Gemini key** — a key in frontend code is a published key.
3. **Validating the robot's messages** — one chokepoint, one audit point.

So the app is a browser UI + a local Node companion server. The server is the
only thing that talks to the ESP32. This is also what keeps the connection layer
light enough for an ESP32-C3: a single WebSocket carrying small JSON frames.

---

## Features

| Area | What it does |
|---|---|
| Connection | mDNS scan, manual IP, last-known address, connect/disconnect |
| Status | name, firmware, IP, Wi-Fi RSSI, state, expression, mode, heap, battery (only if reported) |
| Movement | D-pad, rotate L/R, instant STOP, releases send `stop` in manual mode |
| Expressions | 7 test expressions with live face preview |
| Modes | Dance, Explore, Autonomous Mode toggle, Idle |
| Chat | Ask WALL-E, see the STT → Gemini → TTS chain in the activity feed |
| Camera | Stream URL if the firmware offers one, else JPEG frames, else a clear placeholder |
| Activity | Compact event log with a low-level toggle |
| Settings | name, connection method, motor speed, volume, auto-reconnect, Gemini key |
| Offline | "WALL-E offline" banner, backoff reconnect, timeouts surfaced as errors |
| Demo mode | Full simulated robot, clearly labelled |

---

## Demo mode

Demo mode is a **real WebSocket server implementing Robot API v1**, started
in-process by the companion server. The app code path is identical — the same
`RobotLink`, the same validation, the same protocol — so a green demo also
exercises the real integration.

It is always labelled with a **DEMO MODE** banner so it is never confused with
the physical robot.

```bash
# In-process, via the UI toggle
npm run mock              # standalone, for testing the real app against it
MOCK_ADVERTISE=1 npm run mock   # also advertises over mDNS
WALLE_DEMO=1 npm run dev:server  # start the whole app in demo mode
```

The mock simulates: connection, movement, expressions, STT, Gemini, TTS, dance,
explore, autonomous mode, camera-ready, and status updates.

---

## Security

- The Gemini key is read only by the server (`src/server/config.ts`) and is
  never bundled into the client or sent to the ESP32. A test asserts it never
  appears in any app-facing payload or HTTP response.
- Every inbound robot frame is parsed and validated before reaching the UI.
  Malformed JSON, oversized frames, unknown events and newer protocol versions
  are dropped and reported.
- Every outbound command passes an allowlist and range check. The app will not
  forward a command it did not construct itself.
- Inbound `command` frames from the robot are ignored — the robot cannot drive
  the app.
- The app WebSocket requires a token; the robot WebSocket supports an optional
  `Authorization: Bearer` secret.
- Commands are rate limited server-side.

---

## Testing

```bash
npm test        # 83 tests
npm run typecheck
```

Coverage against the brief's checklist:

| # | Requirement | Where |
|---|---|---|
| 1 | App starts | `npm run dev` — companion server + Vite |
| 2 | Demo mode works | `appServer.test.ts` — full suite runs in demo mode |
| 3 | Discovery works | `discovery.test.ts` — mDNS publish/browse (skippable via `WALLE_TEST_MDNS=0`) |
| 4 | Manual IP connection | `appServer.test.ts` — `/api/connect`, plus `discovery.test.ts` |
| 5 | Connection status updates | `appServer.test.ts` — connected / offline / reconnected |
| 6 | Movement commands sent | `robotLink.test.ts` — `movement_started` with matching `requestId` |
| 7 | Stop works | `robotLink.test.ts` + `appServer.test.ts` — `movement_stopped` reason `command` |
| 8 | Expression commands | `robotLink.test.ts` — `expression_changed` |
| 9 | Dance command | `robotLink.test.ts` + `appServer.test.ts` — start and finish |
| 10 | Autonomous toggle | `robotLink.test.ts` + `appServer.test.ts` — `autonomous_changed` + status |
| 11 | Chat messages | `appServer.test.ts` — offline reply through the server path |
| 12 | Events appear | `appServer.test.ts` — activity stream assertions |
| 13 | Disconnect/reconnect | `appServer.test.ts` — robot killed and restarted |
| 14 | Invalid messages handled | `protocol.test.ts` + `robotLink.test.ts` — 15 hostile-input cases |

---

## Configuration

Copy `.env.example` to `.env`. Everything is optional.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Companion server port |
| `WALLE_APP_TOKEN` | random per boot | Token the browser must present |
| `WALLE_ROBOT_TOKEN` | — | Shared secret the ESP32 requires |
| `GEMINI_API_KEY` | — | Server-side only; offline replies without it |
| `GEMINI_MODEL` | `gemini-2.0-flash` | |
| `WALLE_ROBOT_HOST` | — | Auto-connect target at startup |
| `WALLE_DEMO` | `0` | Start in demo mode |
| `WALLE_DISCOVERY` | `1` | Enable mDNS |
| `WALLE_RECONNECT` | `1` | Auto-reconnect on drop |
| `WALLE_RATE_MAX` | `25` | Commands per second per client |

Settings edited in the UI persist to `.walle/settings.json`.

---

## How the ESP32 should connect

Full details in [`docs/WALL-E_ROBOT_API.md`](docs/WALL-E_ROBOT_API.md). In short:

1. Run a **WebSocket server on port 8080**.
2. On connect, send `robot_ready` with a full `RobotStatus`.
3. Advertise mDNS `_walle._tcp.local.` with TXT `name`, `fw`, `model`.
4. Accept `Authorization: Bearer <token>` if a secret is configured.
5. Parse each frame; reply with exactly one `response` carrying the same
   `requestId`.
6. Emit events for every state change, and `status` after any status update.
7. Implement the camera path — **JPEG `camera_frame` events are recommended**
   over streaming for an ESP32-C3.
8. Omit `battery` unless a real sensor exists.
9. **Work standalone.** The app is optional; the robot must run on its own.

A per-firmware implementation checklist is in §10 of the API document.

---

## Remaining hardware-dependent work

Blocked on the physical robot, not on the app:

- **Camera transport.** The app supports both stream-URL and JPEG-frame modes,
  but which one is used depends on firmware. JPEG frames are the low-risk path
  for a C3; expect to tune resolution and frame rate.
- **Battery display.** Hidden until the firmware reports a real sensor.
- **Microphone latency.** The app shows STT events as they arrive; the actual
  capture quality is a firmware concern.
- **Motor feel.** Speed/duration values in the app map to whatever the
  firmware's `set_motor_speed` accepts. PID tuning is firmware-side.
- **mDNS on Windows.** Often blocked. The manual IP path is fully supported and
  the address is remembered, so this is a fallback rather than a blocker.
