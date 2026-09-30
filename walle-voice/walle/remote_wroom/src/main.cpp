// ============================================================
//  WALL-E remote controller (ESP32-WROOM)
//  ------------------------------------------------------------
//  A handheld, battery-powered remote for the WALL-E robot. It
//  reads buttons, translates them into WALL-E commands and sends
//  them to the ESP32-S3 over ESP-NOW.
//
//  It contains NO robot logic. There is no motor code here, no
//  behaviour, no OLED face: the robot executes everything and owns
//  the motors. The remote only names intents
//  (shared/walle_protocol.h -> WalleCommand).
//
//  main.cpp is deliberately small:
//    setup()  -> buttons, wireless link, optional LED
//    loop()   -> sample buttons, act on edges, refresh held presses
// ============================================================
#include <Arduino.h>
#include "config.h"
#include "walle_protocol.h"
#include "remote_input.h"
#include "remote_link.h"
#include "voice_link.h"
#include "voice_audio.h"

static const char* TAG = "WROOM";

// The direction most recently sent, so a held button re-sends the
// same command instead of re-deriving it and risking a flip.
static uint8_t  gHeldDirection = WALLE_CMD_NONE;
static uint32_t gLastDirectionMs = 0;
static bool     gAutonomous = true;

// ------------------------------------------------------------
//  Voice
// ------------------------------------------------------------
//  A voice turn takes a second or two: it records, waits on the
//  app, then plays the answer. Running that inside loop() would
//  stop the remote feeding ESP-NOW, and the robot's 400 ms
//  REMOTE_TIMEOUT_MS watchdog would cut the motors mid-turn.
//
//  So the turn runs as a task, and loop() keeps doing its job.
//  gTalkBusy is the handshake between the two: loop() watches the
//  button, the task watches gTalkHeld to know it was cancelled.
static TaskHandle_t gVoiceTask = nullptr;
static volatile bool gTalkHeld = false;
static volatile bool gTalkBusy = false;

static void voiceTask(void* param) {
    (void)param;
    while (gTalkHeld) {          // wait for the press to start
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    voiceLink.voiceTurn("listening...");

    gTalkBusy = false;
    gTalkHeld = false;
    vTaskDelete(nullptr);
}

/**
 * The talk button: press to ask, press again to cancel.
 *
 * The second press is a real cancel, not just a stop-recording: it
 * sets gTalkHeld, which the upload and the download both poll, so
 * cancelling works even while the remote is waiting on the app.
 */
static void updateTalkButton(uint32_t now) {
    if (REMOTE_PIN_IS_UNSET(BTN_TALK_PIN)) return;

    static bool wasDown = false;
    const bool down = (digitalRead(BTN_TALK_PIN) == LOW);

    if (down && !wasDown) {
        wasDown = true;
        if (gTalkBusy) {
            // Second press: cancel whatever is in flight.
            gTalkHeld = true;
            Serial.println("[WROOM] voice cancelled");
        } else if (remoteLink.status() == RS_SEARCHING && !voiceLink.wifiConnected()) {
            Serial.println("[WROOM] voice ignored: no network");
        } else {
            gTalkHeld = false;
            gTalkBusy = true;
            // A fresh one-shot task per turn. The previous task deleted
            // itself, so gVoiceTask is a stale handle here and is simply
            // overwritten; gTalkBusy is what actually prevents overlap.
            xTaskCreate(voiceTask, "voice", 8192, nullptr, 1, &gVoiceTask);
        }
    }
    if (!down) wasDown = false;
}

// Optional link LED. -1 disables it.
static void updateLed() {
    if (REMOTE_PIN_IS_UNSET(REMOTE_LED_PIN)) return;

    bool on;
    switch (remoteLink.status()) {
        case RS_CONNECTED: on = true;  break;   // solid
        case RS_LOST:      on = false; break;   // off
        default:           on = true;  break;   // searching: solid, we
    }                                         // have nothing better
    digitalWrite(REMOTE_LED_PIN, on ? HIGH : LOW);
}

void setup() {
    Serial.begin(REMOTE_SERIAL_SPEED);
    delay(150);
    Serial.println();
    Serial.println("=== WALL-E remote (ESP32-WROOM) ===");

    // ---- buttons ----
    remoteInput.begin();

    // ---- optional LED ----
    if (!REMOTE_PIN_IS_UNSET(REMOTE_LED_PIN)) {
        pinMode(REMOTE_LED_PIN, OUTPUT);
    }

    // ---- wireless ----
    if (!remoteLink.begin()) {
        Serial.println("[WROOM] FATAL: could not start ESP-NOW");
    }

    // ---- voice (optional) ----
    // Started last, and allowed to fail: the buttons work over ESP-NOW
    // with no network at all, so a missing Wi-Fi config must not stop the
    // remote from driving the robot.
    if (!REMOTE_PIN_IS_UNSET(BTN_TALK_PIN)) {
        pinMode(BTN_TALK_PIN, INPUT_PULLUP);
    }
    pinMode(VOICE_SPK_EN_PIN, OUTPUT);
    digitalWrite(VOICE_SPK_EN_PIN, LOW);

    voiceLink.setAbortFlag(&gTalkHeld);
    voiceLink.begin();

    // ---- honest boot report ----
    if (remoteInput.anyConfigured()) {
        Serial.printf("[WROOM] Buttons on GPIO: %s\n", remoteInput.describe().c_str());
    } else {
        Serial.println("[WROOM] NO BUTTONS CONFIGURED");
        Serial.println("[WROOM] Every pin is still TODO_CONFIGURE_REMOTE_GPIO (-1).");
        Serial.println("[WROOM] Set them in remote_wroom/include/config.h and flash again.");
    }

    // Honest report on voice, the same way: say what is not set up.
    if (REMOTE_PIN_IS_UNSET(BTN_TALK_PIN)) {
        Serial.println("[WROOM] VOICE OFF: BTN_TALK_PIN is unset in config.h");
    } else if (strcmp(VOICE_WIFI_SSID, "your-wifi-name") == 0) {
        Serial.println("[WROOM] VOICE NOT CONFIGURED");
        Serial.println("[WROOM] Set VOICE_WIFI_SSID, VOICE_WIFI_PASSWORD and");
        Serial.println("[WROOM] VOICE_SERVER_HOST in remote_wroom/include/config.h");
        Serial.println("[WROOM] The buttons work regardless - they use ESP-NOW.");
    } else {
        Serial.printf("[WROOM] Voice: %s, stt %s, tts %s\n",
                      VoiceLink::stateName(voiceLink.state()),
                      voiceLink.sttAvailable() ? "yes" : "no",
                      voiceLink.ttsAvailable() ? "yes" : "no");
    }

    Serial.println("[WROOM] Ready - press a button on the remote");
}

void loop() {
    const uint32_t now = millis();

    remoteInput.update(now);
    remoteLink.update(now);
    updateLed();

    // ---- voice ----
    // updateTalkButton() only reads the pin, so it stays responsive. The
    // long part of a voice turn happens in gVoiceTask, and the checks below
    // are what keep the ESP-NOW link alive while that task is busy.
    updateTalkButton(now);
    voiceLink.update(now);

    // ---- STOP beats everything, always ----
    // Checked first and unconditionally, so an emergency stop can
    // never be lost to a direction button that is also held.
    if (remoteInput.justPressed(RBTN_STOP)) {
        remoteLink.sendCommand(WALLE_CMD_STOP, false);
        gHeldDirection = WALLE_CMD_NONE;
    }

    // ---- dance (tap) ----
    if (remoteInput.justPressed(RBTN_DANCE)) {
        remoteLink.sendCommand(WALLE_CMD_DANCE, false);
    }

    // ---- autonomy toggle (momentary, self-releasing) ----
    // A toggle on a latching switch would need edge detection per
    // direction; a momentary button is simpler and matches STOP.
    if (remoteInput.justReleased(RBTN_MODE)) {
        gAutonomous = !gAutonomous;
        remoteLink.sendCommand(gAutonomous ? WALLE_CMD_AUTONOMOUS_ON
                                           : WALLE_CMD_AUTONOMOUS_OFF, false);
        Serial.printf("[WROOM] Autonomous %s\n", gAutonomous ? "ON" : "OFF");
    }

    // ---- expressions ----
    if (remoteInput.justPressed(RBTN_EXPR)) {
        remoteLink.sendCommand(WALLE_CMD_EXPR_HAPPY, false);
    }
    if (remoteInput.justPressed(RBTN_SURPRISE)) {
        remoteLink.sendCommand(WALLE_CMD_EXPR_SURPRISED, false);
    }

    // ---- movement: send on the press edge ----
    const uint8_t direction = remoteInput.heldDirection();

    if (direction != WALLE_CMD_NONE) {
        if (direction != gHeldDirection) {
            // A new direction was pressed.
            gHeldDirection = direction;
            gLastDirectionMs = now;
            remoteLink.sendCommand(direction, true);
        } else if ((now - gLastDirectionMs) >= REMOTE_HOLD_REPEAT_MS) {
            // Still held: refresh. This is what stops the robot's
            // REMOTE_TIMEOUT_MS watchdog from firing mid-drive, and
            // it repairs any packet lost to interference.
            gLastDirectionMs = now;
            remoteLink.sendCommand(direction, true);
        }
    } else if (gHeldDirection != WALLE_CMD_NONE) {
        // Every direction released: tell the robot to stop.
        gHeldDirection = WALLE_CMD_NONE;
        remoteLink.sendCommand(WALLE_CMD_STOP, false);
    }

    delay(2);   // keeps the ESP-NOW task fed without burning the radio
}
