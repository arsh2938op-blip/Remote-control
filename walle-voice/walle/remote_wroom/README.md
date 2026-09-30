# WALL-E Remote — ESP32-WROOM 🎮

A handheld, battery-powered **remote control** for the WALL-E robot.

This is a **separate firmware** from the robot. It reads buttons, translates
them into WALL-E commands, and sends them to the ESP32-S3 over **ESP-NOW**.
It contains **no robot logic**: no motor code, no behaviour, no face. The robot
executes everything and owns the wheels — the remote only names intents.

```
ESP32-WROOM (this)  ──ESP-NOW──▶  ESP32-S3 robot  ──▶  motors / OLED / behaviour
```

---

## 1. Build & flash

```bash
# from the remote_wroom/ folder
pio run                 # build
pio run -t upload       # build + flash over USB
pio device monitor      # serial log at 115200 baud
```

Target board is `esp32dev` in `platformio.ini` — the standard ESP32-WROOM
dev board. Change `board =` if yours differs.

There are **no `lib_deps`**. ESP-NOW and Wi-Fi are part of the ESP-IDF core
inside the Arduino framework, so this firmware builds in a few seconds. That
matters: the remote is the battery-powered half of the system and should stay
tiny.

> The robot firmware is built from `../robot_s3/` and is a **different
> PlatformIO project**. The two share only the constants in
> `../shared/walle_protocol.h`, so neither can accidentally compile the
> other's code.

---

## 2. ⚠️ Configure your buttons first

**The physical remote has not been built yet, so every button pin is still a
placeholder.** Open [`include/config.h`](include/config.h) and replace the
`TODO_CONFIGURE_REMOTE_GPIO` (`-1`) values:

```c
#define BTN_FORWARD_PIN   TODO_CONFIGURE_REMOTE_GPIO   //  <- set these
#define BTN_BACK_PIN      TODO_CONFIGURE_REMOTE_GPIO
#define BTN_LEFT_PIN      TODO_CONFIGURE_REMOTE_GPIO
#define BTN_RIGHT_PIN     TODO_CONFIGURE_REMOTE_GPIO
#define BTN_STOP_PIN      TODO_CONFIGURE_REMOTE_GPIO
#define BTN_DANCE_PIN     TODO_CONFIGURE_REMOTE_GPIO
#define BTN_MODE_PIN      TODO_CONFIGURE_REMOTE_GPIO
```

That is the **only** file you edit. No GPIO number appears anywhere else in
this project.

Until you do, the firmware still flashes and boots, and says so honestly:

```
[WROOM] NO BUTTONS CONFIGURED
[WROOM] Every pin is still TODO_CONFIGURE_REMOTE_GPIO (-1).
```

### Buttons available

| Button | Command | Notes |
|--------|---------|-------|
| `BTN_FORWARD_PIN` | `move_forward` | held button, re-sends while down |
| `BTN_BACK_PIN` | `move_backward` | held |
| `BTN_LEFT_PIN` | `turn_left` | held |
| `BTN_RIGHT_PIN` | `turn_right` | held |
| `BTN_STOP_PIN` | `stop` | **tap = emergency stop**, beats everything |
| `BTN_DANCE_PIN` | `dance` | tap |
| `BTN_MODE_PIN` | `autonomous_on` / `autonomous_off` | **tap toggles** autonomy |
| `BTN_EXPR_PIN` | `expression_happy` | optional |
| `BTN_SURPRISE_PIN` | `expression_surprised` | optional |

Wiring: connect each button between its GPIO and **GND**. The internal
pull-ups are enabled, so no external resistor is needed. Flip
`REMOTE_ACTIVE_LOW` to `0` if your buttons read backwards.

`REMOTE_LED_PIN` is optional; set it to drive a link LED (solid when
connected).

### Pins to avoid on the classic ESP32 (WROOM)

* **GPIO 6–11** — wired to the SPI flash, unusable.
* **GPIO 34, 35, 36, 39** — input only, no internal pull-up.
* **GPIO 0, 2, 12, 15** — strapping pins: anything that pulls at boot time can
  stop the board booting. Keep them off anything load-bearing.
* **GPIO 1, 3** — UART0, used by the serial monitor.

---

## 3. Matching the robot's channel

ESP-NOW peers must share a channel. With the default
`REMOTE_CHANNEL = 0` this just works, because the robot broadcasts and the
remote listens for it while scanning `REMOTE_FALLBACK_CHANNEL`.

The robot prints the channel it chose at boot:

```
[S3] ESP-NOW channel 6
```

If your robot is on a different channel (because it is joined to your router
on a different channel), set `REMOTE_CHANNEL` in this `config.h` to the same
number.

---

## 4. Connection

No MAC addresses, no pairing, no bonding:

1. The remote broadcasts `HELLO` every 500 ms until it hears anything.
2. The robot replies unicast and remembers that MAC.
3. From then on the remote sends straight to the robot.

So the remote works whether it boots before or after the robot, and a
re-flashed remote is picked up automatically.

States, printed on the serial log and shown by the optional LED:

| State | Meaning |
|-------|---------|
| `searching` | powered on, no robot heard yet |
| `connected` | the robot is answering |
| `lost` | had a robot, stopped hearing it (after `REMOTE_LOST_TIMEOUT_MS`) |

The remote also sends a `PING` every 150 ms as a keepalive. That is far below
the robot's `REMOTE_TIMEOUT_MS`, so an idle remote never trips the robot's
watchdog.

---

## 5. Latency and safety

A held direction button sends its command on the **press edge**, then re-sends
every `REMOTE_HOLD_REPEAT_MS` (50 ms) while it is held. Releasing every
direction button sends `stop`.

That refresh buys two things:

* The robot's `REMOTE_TIMEOUT_MS` (400 ms) watchdog is refreshed continuously,
  so a long drive never trips it.
* A packet lost to interference costs 50 ms of motion instead of causing a stop.

**If the remote disappears — flat battery, out of range, crashed — the robot
stops itself within `REMOTE_TIMEOUT_MS`.** The remote relies on that: it is
the safety net, and the robot implements it.

`stop` is checked first in the loop, every iteration, so an emergency stop can
never be lost to a direction button that happens to be held at the same time.

---

## 6. Project structure

```
remote_wroom/
├── platformio.ini        # board + the shared include path
├── include/
│   └── config.h          # ★ ALL button pins, timings and channel live here
├── src/
│   ├── main.cpp          # tiny: setup + loop
│   ├── remote_input.*    # debounce, edge detect, hold-repeat
│   └── remote_link.*     # ESP-NOW TX/RX + link state
└── README.md
```

---

## 7. Adding another controller later

The command vocabulary lives in
[`../shared/walle_protocol.h`](../shared/walle_protocol.h) and is transport
agnostic. A second remote, a phone bridge, a desktop tool or a web page can all
speak the same 10-byte packet to the same dispatcher.

To add a new button: add a `BTN_*_PIN` to `config.h`, add an entry to the table
in `remote_input.cpp::begin()` and to `commandFor()`. The robot side needs
**no changes at all** as long as the command already exists in
`WalleCommand`.
