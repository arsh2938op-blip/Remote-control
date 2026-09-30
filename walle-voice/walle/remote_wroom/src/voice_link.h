// ============================================================
//  Voice link — ESP32-WROOM remote
//  ------------------------------------------------------------
//  Talks to the WALL-E companion server (the "app"), not to the
//  robot. Two HTTP calls:
//
//    POST /api/voice/stt   16 kHz mono PCM  -> { text, reply }
//    GET  /api/voice/tts?text=...           -> 24 kHz mono PCM
//
//  Why the server and not the robot: the ESP32-S3 firmware has no
//  audio hardware (it was removed to free the I2S pins) and no
//  room for a speech model, and no firmware should hold a speech
//  API key. The server already brokers everything else, and already
//  holds GEMINI_API_KEY, so WALL-E's personality is the same
//  whether you talk to the remote or to the web UI.
//
//  One radio, two jobs: this link uses Wi-Fi while the button
//  link to the robot uses ESP-NOW. They share the radio, so both
//  must sit on the same channel (see config.h section 3).
//
//  Non-blocking by design. setup() brings the interface up and
//  loop() calls update(), which owns the Wi-Fi reconnect. The
//  blocking work only happens inside voiceTurn(), which is
//  called from a button edge and is expected to take a second or
//  two while it uploads and downloads.
// ============================================================
#pragma once

#include <Arduino.h>

enum VoiceLinkState {
    VOICE_OFF = 0,     // not started
    VOICE_CONNECTING,  // joining the network
    VOICE_READY,       // online, server reachable
    VOICE_NO_WIFI,     // could not join
    VOICE_NO_SERVER,   // online, but the app is not answering
};

class VoiceLink {
public:
    bool begin();

    /** Call every loop(): reconnect, and refresh the server state. */
    void update(uint32_t now);

    /** True once Wi-Fi is up and the app answered /api/voice/capabilities. */
    bool ready() const { return _state == VOICE_READY; }
    bool wifiConnected() const { return _state != VOICE_OFF && _state != VOICE_NO_WIFI; }

    VoiceLinkState state() const { return _state; }
    static const char* stateName(VoiceLinkState s);

    /** True when the talk button is held, used to abort a turn. */
    void setAbortFlag(volatile bool* flag);

    /**
     * The whole conversation: record, transcribe, answer, speak.
     * Blocking for a second or two. Returns false if it failed or
     * the user aborted, and reports why on the serial monitor.
     */
    bool voiceTurn(const String& prompt);

    // ---- testing / diagnostics ----
    bool sttAvailable() const { return _sttAvailable; }
    bool ttsAvailable() const { return _ttsAvailable; }
    int  lastHttpStatus() const { return _lastHttpStatus; }
    const String& lastTranscript() const { return _lastTranscript; }
    const String& lastReply() const { return _lastReply; }

private:
    bool joinWifi();
    bool probeServer();
    bool sendStt(const String& pcm, String& outJson);
    bool speakText(const String& text);
    String baseUrl() const;

    VoiceLinkState _state = VOICE_OFF;
    bool     _sttAvailable = false;
    bool     _ttsAvailable = false;
    int      _lastHttpStatus = 0;
    String   _lastTranscript;
    String   _lastReply;
    uint32_t _lastReconnectMs = 0;
    uint32_t _lastProbeMs = 0;
};

/** Where the talk button's cancel flag lives, read by stillTalking(). */
void setVoiceAbortFlag(volatile bool* flag);

extern VoiceLink voiceLink;
