# WALL-E Voice — STT + TTS on the ESP32-WROOM remote

Adds talking and listening to the WALL-E system, wired into both existing
projects:

- **`app/`** — the companion app (Node/Express). Gains the speech endpoints
  and keeps holding the API keys.
- **`walle/remote_wroom/`** — the handheld remote firmware. Gains a mic, a
  speaker and a talk button, and keeps driving the robot over ESP-NOW.

---

## Why the remote, and why the app

Two findings from reading both projects shaped this:

**STT/TTS was deliberately removed from the robot.** `robot_s3/include/config.h`
section 6 says so explicitly — the I2S mic and speaker pins were freed for the
motors, OLED and camera, and the robot now shows answers on its face instead of
speaking. So putting voice back on the S3 would mean re-adding hardware that was
removed on purpose.

The remote is the natural home for it: you hold it, you speak into it, you hear
the answer from it. Its buttons already drive the robot, so one device now does
both.

**The app is where the keys and the personality already live.** `GeminiService`
keeps `GEMINI_API_KEY` in the server process and never sends it to the browser
or the ESP32. The voice endpoints follow exactly that rule, so WALL-E sounds the
same whether you talk to the handheld remote or the web UI.

```
  ┌──────────────────┐  ESP-NOW (10-byte packets, no router needed)
  │  remote_wroom    │ ──────────────────────────────▶  robot_s3
  │  ESP32-WROOM     │                                   ESP32-S3
  │  buttons + mic   │                                   motors, OLED, camera
  │  + speaker       │                                   (no mic, no speaker)
  └────────┬────────┘
           │  Wi-Fi (same radio, same channel)
           │  POST /api/voice/stt   16 kHz PCM16
           │  GET  /api/voice/tts   24 kHz PCM16
           ▼
  ┌──────────────────┐
  │  app  (Node)     │  Groq Whisper → GEMINI_API_KEY → OpenAI speech
  │  companion server│  keys never leave this process
  └──────────────────┘
```

**Connection is the app**, as asked. The remote needs no MQTT, no cloud
credentials of its own and no direct route to the robot: it needs the app's LAN
address.

---

## What you need to set

### 1. The app

`app/.env` — everything is off by default, so add what you have:

```bash
# Speech-to-text. Groq is fast and free-tier. Auto-selected when set.
GROQ_API_KEY=

# Text-to-speech. OpenAI ONLY - Groq has no /audio/speech endpoint, so with
# only GROQ_API_KEY the remote hears you but stays silent.
OPENAI_API_KEY=

# Optional shared secret. If set here, put the same string in the remote's
# VOICE_TOKEN. Leave both unset to disable the check.
# WALLE_VOICE_TOKEN=
```

Then:

```bash
cd app
npm install
npm start
```

### 2. The remote

`walle/remote_wroom/include/config.h`, section 5:

```c
#define VOICE_WIFI_SSID      "your-wifi"
#define VOICE_WIFI_PASSWORD  "your-password"
#define VOICE_SERVER_HOST    "192.168.1.50"   // the PC running the app
#define VOICE_SERVER_PORT    8787
#define BTN_TALK_PIN         0                // 0 = the on-board BOOT button
```

`VOICE_SERVER_HOST` must be the app PC's **LAN address** (`ipconfig`), not
`localhost`. The port is `8787` unless you changed `PORT` in `.env`.

```bash
cd walle/remote_wroom
pio run --upload
monitor_device = 115200
```

---

## Hardware

| Part               | ESP32 pin            | Notes                                    |
| ------------------ | -------------------- | ---------------------------------------- |
| INMP441 mic        | SCK 14, WS 15, SD 13 | **3V3 not 5V**; L/R → GND                |
| MAX98357A DAC      | BCLK 26, LRC 27, DIN 22, EN 23 | Vin **5V**; GAIN floating    |
| speaker            | MAX98357A OUT+/OUT-  | 4–8 Ω, add 100 µF if it cracks           |
| talk button        | GPIO 0               | on-board BOOT button, nothing to wire    |

The pins are valid WROOM GPIOs and nothing is flashed onto them, but check them
against your own wiring. On the classic ESP32 avoid GPIO 6–11 (flash), 34/35/36/39
(input only) and 1/3 (serial).

---

## Using it

- **Drive** — unchanged. Every button still works over ESP-NOW.
- **Talk** — press the talk button and speak. Recording stops after ~1.2 s of
  silence, at 8 s, or on a second press. The answer plays out of the speaker.
- **Cancel** — press talk again mid-turn. Works during recording, the upload
  and playback.
- Serial shows the transcript, the reply and each stage, e.g.

```
[WROOM] Voice: ready, stt yes, tts yes
[VOICE] listening...
[VOICE] captured 41200 samples (2.6 s)
[VOICE] you: what is your name
[VOICE] speaking
```

Every transcript and reply also lands in the app's activity feed and chat
window, so you can see what the remote heard.

---

## One radio, two jobs — read this once

The buttons use **ESP-NOW**; voice uses **Wi-Fi**. Both are the same radio, so
both must sit on the **same channel**. That happens automatically: the robot is
joined to your router so it sits on the router's channel, and the remote joins
the same router, so it does too.

If the buttons go dead while voice is on, the two are on different channels.
Either put the robot on Wi-Fi, or pin the remote with
`#define REMOTE_CHANNEL <your router's channel>` (1–13).

---

## Verifying without the hardware

```bash
cd app
python voice_client.py              # synthesises speech, runs the whole chain
python voice_client.py my.wav      # transcribe a real recording
python voice_client.py --stt-only my.wav
npm test                           # 106 tests, no hardware or API key needed
```

`voice_client.py` checks capabilities, transcribes, confirms the reply, and
exercises the error paths (silence → 422, short clip → 400, missing text → 400,
bad token → 401).

---

## API

| Endpoint                     | Body / query          | Returns                        |
| ---------------------------- | --------------------- | ------------------------------ |
| `GET /api/voice/capabilities`| —                     | what STT/TTS are configured    |
| `POST /api/voice/stt?rate=N` | raw PCM16 body        | `{text, reply, provider, ms}`  |
| `GET /api/voice/tts?text=`   | —                     | `audio/pcm` 24 kHz mono PCM16  |

Auth: optional `x-walle-voice-token` header, enforced only when
`WALLE_VOICE_TOKEN` is set.

**The audio contract.** These rates are fixed on both sides — changing one means
changing `voice.ts` and `voice_audio.h`:

| Direction            | Rate    | Channels | Format                  |
| -------------------- | ------- | -------- | ----------------------- |
| remote → `/stt`      | 16000 Hz | 1       | signed 16-bit LE PCM    |
| `/tts` → remote      | 24000 Hz | 1       | signed 16-bit LE PCM    |

Raw PCM, not MP3 or WAV, because the ESP32 has no audio codec to decode
anything else and can hand the bytes straight to I2S.

---

## Implementation notes

**Streaming, not buffering.** 24 kHz mono PCM is 48 kB/s, so a 500-character
answer is ~17 s and ~816 kB. The WROOM has roughly 250 kB free once Wi-Fi is up,
so buffering the response would fail on any answer longer than about five
seconds. `voice_link.cpp` feeds bytes from the socket straight into the I2S DMA
as they arrive, holding only a 2 kB staging buffer.

**A task, not a DMA callback.** The legacy `i2s_set_rx_callback()` is gone from
the current ESP32 Arduino core, so the recorder is a FreeRTOS task doing
blocking `i2s_read()` into a ring buffer. It also runs at priority 4, above
`loopTask`, so the mic keeps filling while the main loop is busy on Wi-Fi.

**A voice turn never blocks the buttons.** A turn takes a second or two, and
the robot's watchdog is 400 ms, so a blocking `loop()` would cut the motors
mid-turn. The turn runs as a task; `loop()` keeps feeding ESP-NOW throughout.
`gTalkBusy` prevents overlapping turns and `gTalkHeld` cancels the current one.

**Silence is refused, not transcribed.** Whisper will invent a confident,
fluent sentence out of near-silence — the robot would drive off talking to a
hallucination. The firmware checks peak amplitude while recording, and
`voice.ts` checks again server-side before spending an API call.

**One personality.** The reply comes from the same `GeminiService` the web UI
uses, so the robot's character is identical on both paths. With no key it falls
back to the existing offline reply set, so demos work with no keys at all.

**Flash and RAM.** The remote is 72.7% of the 1.31 MB app partition (952 kB,
~344 kB spare) and 19.9% RAM, up from 56.2% without voice. Wi-Fi and HTTPClient
are the bulk of the increase; there are no new library dependencies.

---

## Files

**Added to `app/`**

| File                        | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `src/server/services/voice.ts` | STT, TTS, WAV packing, silence gate         |
| `tests/voice.test.ts`       | 13 unit tests                                  |
| `tests/voiceRoutes.test.ts` | 7 HTTP-level tests                             |
| `voice_client.py`           | end-to-end checker, no hardware needed         |

**Modified in `app/`**

- `src/server/appServer.ts` — the two voice routes, auth, activity feed, `boundPort`
- `src/server/config.ts` — `stt`, `tts`, `groqApiKey`, `voiceToken`
- `.env` — documented voice settings, all commented out
- `tests/appServer.test.ts` — the new config fields

**Added to `walle/remote_wroom/`**

| File                  | Purpose                                        |
| --------------------- | ---------------------------------------------- |
| `src/voice_audio.h/.cpp` | I2S capture and playback                    |
| `src/voice_link.h/.cpp`  | Wi-Fi, HTTP, the conversation turn           |

**Modified in `walle/remote_wroom/`**

- `include/config.h` — section 5, all voice settings
- `src/main.cpp` — talk button, the voice task, an honest boot report

`shared/walle_protocol.h` is **untouched**. The voice path is additive and uses
the app's HTTP API, so the ESP-NOW protocol and both firmwares' command
vocabularies are exactly as they were.

---

## Troubleshooting

**`[VOICE] no Wi-Fi` / buttons fine** — voice needs the app, buttons do not.
Check `VOICE_WIFI_SSID`/`VOICE_SERVER_HOST` in `config.h`.

**`HTTP 422 silence`** — the mic heard nothing. Check the INMP441 is on 3V3 and
its L/R pin is grounded. If it hears you but sounds wrong, adjust
`VOICE_MIC_RIGHT_SHIFT` (14–17).

**Remote silent, transcript correct** — no `OPENAI_API_KEY`. Groq cannot do
speech; the transcript still appears on the serial monitor and in the app.

**`no speech recognised` from Groq** — usually too short or too quiet. Raise
`VOICE_VAD_PEAK` in `config.h` if you are being cut off mid-sentence.

**Crackling speaker** — `Vin` must be 5V. Try 4 Ω rather than 8 Ω and add 100 µF
across the speaker.

**Buttons die when voice starts** — channel mismatch. See the radio note above.

**Firmware will not compile on `i2s` fields** — this was written and verified
against Arduino core 2.0.17, where the field is `channel_format` and the
non-deprecated constant is `I2S_COMM_FORMAT_STAND_I2S`. Core 3.x uses the new
`driver/i2s_std.h` channel API and needs `voice_audio.cpp` ported.

**Port 8787 in use** — set `PORT` in `app/.env` and `VOICE_SERVER_PORT` in
`config.h` to the same number.
