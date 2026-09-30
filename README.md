# ESP32 Remote Voice Control (STT + TTS)

An ESP32 DevKit v1 / ESP32-WROOM-32 that listens, transcribes what you say,
and speaks the answer back out of a speaker. WiFi is handled with saved
credentials and a built-in access point setup portal.

```
   press BOOT button
          |
          v
  [INMP441 mic] --16k PCM--> ESP32 --HTTP POST /stt--> server.py --> Whisper
                                                                      |
                              text  <--------------------------------- +
                               |
        +----------------------+----------------------+
        |                                             |
   (read back, if USE_LLM=0)              [MAX98357A DAC] <--GET /tts-- server.py <-- TTS
        |                                     |
    <answer text>                        [ speaker ]
```

## Hardware

| Part                | Connects to ESP32         | Notes                                     |
| ------------------- | ------------------------- | ----------------------------------------- |
| INMP441 I2S mic     | SCK 14, WS 15, SD 13      | L/R pin to GND, VDD 3.3V                  |
| MAX98357A I2S DAC   | BCLK 26, LRC 27, DIN 22   | GAIN left floating, EN 23 to a GPIO       |
| speaker             | MAX98357A OUT+ / OUT-     | 4-8 ohm, add 100 uF if it cracks          |
| BOOT button         | GPIO0                     | on board, no wiring needed                |
| on-board LED        | GPIO2                     | recording / talking / error indicator     |

Breadboard layout:

```
INMP441                    MAX98357A
  VDD  -> 3V3               VDD  -> 5V (Vin pin, not 3V3)
  GND  -> GND               GND  -> GND
  SCK  -> GPIO14             BCLK -> GPIO26
  WS   -> GPIO15             LRC  -> GPIO27
  SD   -> GPIO13             DIN  -> GPIO22
  L/R  -> GND               EN   -> GPIO23
                              GAIN -> (floating)
```

## Part 1 - the server (runs on your PC)

```powershell
cd server
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Edit `.env` and add keys:

- `GROQ_API_KEY` - transcription only. Fast, has a free tier. Use this.
- `OPENAI_API_KEY` - **required for speech output.** Groq has no `/audio/speech`
  endpoint, so `/tts` and the LLM answer will fail without an OpenAI key.
  Transcription alone works fine with just the Groq key.
- `DEMO_MODE=1` - no key at all, fakes every response so you can test wiring.

Start it:

```powershell
python server.py
```

Check it works without the ESP32:

```powershell
python test_client.py
```

It synthesises a sentence, feeds the audio back into `/stt`, prints the
transcript and writes `test_tts.wav` you can play. It needs `OPENAI_API_KEY`;
with only a Groq key you can test transcription on its own:

```powershell
python test_client.py --stt-only .\my_voice_16k_mono.wav
```

Any 16-bit mono WAV works for that, so you can check the mic path before
wiring the speaker.

> The ESP32 needs your PC's LAN address, not `localhost`. Find it with
> `ipconfig` (e.g. `192.168.1.50`) and keep that machine awake, or use
> a phone hotspot with a static IP.

## Part 2 - the firmware

1. Arduino IDE -> Boards Manager -> install **ESP32 by Espressif Systems** (2.0.x or 3.0.x).
2. Board: **ESP32 Dev Module**. Flash size 4MB, partition default.
3. Open `esp32/esp32_remote_voice/esp32_remote_voice.ino` (open the folder containing it).
4. Edit the settings at the top of the file:

```cpp
static const char *SERVER_HOST = "192.168.1.50";   // your PC
static const uint16_t SERVER_PORT = 8000;
```

5. Upload, then open the Serial monitor at **115200 baud**.

### The connection step

Credentials are kept in NVS, so you only set them once.

- If you filled in `WIFI_SSID` / `WIFI_PASS` before uploading, the ESP32
  joins that network on boot.
- Otherwise, or if the join fails, it starts its own access point:

```
SSID     : ESP32-Voice
password : esp32voice
address  : http://192.168.4.1
```

Connect a phone or laptop to that AP, open `192.168.4.1`, enter your WiFi
SSID, password and the server IP, and the ESP32 saves them and reboots.
On the next boot it joins your network and prints its IP on the serial
monitor.

To wipe the stored network: hold BOOT during reset and upload again
(the settings block re-seeds NVS), or erase the flash.

## Part 3 - use it

Press the BOOT button, wait a moment, then talk. Recording stops on its
own after ~1.2 s of silence, on a second button press, or at 8 s. The
answer plays back through the speaker. Press the button again to cut it off.

LED feedback:

| LED              | Meaning                                |
| ---------------- | -------------------------------------- |
| slow single blink| idle, waiting for you                  |
| solid            | recording                              |
| fast blink       | transcribing / generating              |
| slow blink       | speaking                               |
| 4 quick blinks   | nothing heard, or the server refused  |

## Troubleshooting

- **No response, HTTP -1** - the ESP32 cannot reach the PC. Same WiFi
  network, and allow Python through the firewall
  (`New-NetFirewallRule -DisplayName "voice server" -Direction Inbound -LocalPort 8000 -Protocol TCP`).
- **Server says `422 silence, nothing to transcribe`** - the mic picked up
  nothing. Whisper models confidently invent a sentence out of silence, so the
  server checks the peak level first and refuses the clip. Treat this as a
  mic problem, not a server one.
- **Server says `TTS needs OPENAI_API_KEY`** - speech output needs an OpenAI
  key. Groq only does speech-to-text.
- **Answer plays as noise or a click** - the TTS request failed after the
  200 was sent. The server now reads the first audio chunk before replying, so
  this should show up as a clean error on the ESP32 serial monitor instead.
- **Loud hiss or no mic input** - check the INMP441 `L/R` pin is grounded and
  `Vdd` is 3.3V, not 5V. Then try `MIC_RIGHT_SHIFT` values 14 to 17.
- **Crackling speaker** - the MAX98357A `Vin` needs 5V; add 100 uF across
  the speaker, and use 4 ohm rather than 8.
- **Speech too slow** - 24 kHz mono PCM is about 48 kB per second, so a
  four second answer is a 192 kB download. Lower `REC_MAX_MS` in the sketch
  to speed up the turn-around.
- **Audio is too quiet** - `TTS_SPEED` or a louder `TTS_VOICE` (`echo`,
  `fable`, `onyx`, `nova`, `shimmer`) in `.env`.
- **i2s driver install failed** - the sketch uses the legacy I2S driver,
  which Arduino core 3.3 and newer started to hide. Either use core 3.0.x
  or switch the includes to `driver/i2s_legacy.h`.

## Files

```
esp32/esp32_remote_voice/esp32_remote_voice.ino   firmware
server/server.py                                  STT / TTS bridge
server/test_client.py                             end to end test
server/requirements.txt
server/.env.example
```

## Wiring the audio contract

If you ever change these, change them on both sides:

| Direction | Rate        | Channels | Format                  |
| --------- | ----------- | -------- | ----------------------- |
| ESP32 -> `/stt` | 16000 Hz | 1        | signed 16-bit little endian |
| `/tts` -> ESP32 | 24000 Hz | 1        | signed 16-bit little endian |
