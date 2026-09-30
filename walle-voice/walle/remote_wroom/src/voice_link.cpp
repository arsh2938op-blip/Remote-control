// ============================================================
//  Voice link — ESP32-WROOM remote
//  See voice_link.h for the shape of this and why the app is the
//  endpoint rather than the robot.
// ============================================================
#include "voice_link.h"

#include <WiFi.h>
#include <HTTPClient.h>

#include "config.h"
#include "voice_audio.h"

VoiceLink voiceLink;

/**
 * Set by main.cpp's talk button. While it is true the whole turn unwinds:
 * recording stops, the upload is abandoned, the download is dropped and
 * the speaker is silenced. One flag covers every stage.
 *
 * File scope rather than a member, because stillTalking() is handed to
 * voiceAudioRecord() as a plain function pointer.
 */
static volatile bool* sAbortFlag = nullptr;

namespace {

/**
 * Passed to voiceAudioRecord() as a plain function pointer: a capturing
 * lambda would not convert, and the flag has to be read wherever it lives.
 */
bool stillTalking() {
    return !(sAbortFlag && *sAbortFlag);
}

// A reply longer than this is either a runaway model or someone pasting a
// web page in. 500 characters is a long spoken answer.
constexpr size_t MAX_REPLY_CHARS = 500;

// Escape one code point for a query string. Deliberately conservative:
// anything outside a small safe set is percent-encoded.
String urlEncode(const String& in) {
    String out;
    out.reserve(in.length() * 2);
    for (size_t i = 0; i < in.length(); i++) {
        const uint8_t c = (uint8_t)in[i];
        const bool safe =
            (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
            c == '-' || c == '_' || c == '.' || c == '~' || c == ' ' ||
            c == ',' || c == '?' || c == '!' || c == '\'';
        if (safe) {
            out += (char)c;
        } else {
            char buf[4];
            snprintf(buf, sizeof(buf), "%%%02X", c);
            out += buf;
        }
    }
    return out;
}

// Pull a string field out of a flat JSON object. The server returns
// {text, reply, provider, ms}; avoiding ArduinoJson keeps this
// firmware at zero dependencies, like the rest of the remote.
String jsonField(const String& json, const char* key) {
    const String needle = String("\"") + key + "\"";
    int i = json.indexOf(needle);
    if (i < 0) return "";
    i = json.indexOf(':', i + needle.length());
    if (i < 0) return "";
    i++;
    while (i < (int)json.length() && isspace((uint8_t)json[i])) i++;
    if (i >= (int)json.length() || json[i] != '"') return "";

    i++;
    String out;
    while (i < (int)json.length() && json[i] != '"') {
        if (json[i] == '\\' && i + 1 < (int)json.length()) {
            i++;
            switch (json[i]) {
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': break;
                case 'u': i += 4; break;   // skip \uXXXX
                default:  out += json[i];
            }
        } else {
            out += json[i];
        }
        i++;
    }
    return out;
}

}  // namespace

void VoiceLink::setAbortFlag(volatile bool* flag) {
    sAbortFlag = flag;
}

const char* VoiceLink::stateName(VoiceLinkState s) {
    switch (s) {
        case VOICE_OFF:        return "off";
        case VOICE_CONNECTING: return "connecting";
        case VOICE_READY:      return "ready";
        case VOICE_NO_WIFI:    return "no-wifi";
        case VOICE_NO_SERVER:  return "no-server";
        default:               return "?";
    }
}

String VoiceLink::baseUrl() const {
    return String("http://") + VOICE_SERVER_HOST + ":" + String(VOICE_SERVER_PORT);
}

bool VoiceLink::begin() {
    if (_state != VOICE_OFF) return true;

    Serial.println();
    Serial.println(F("[VOICE] === voice link ==="));
    Serial.printf("[VOICE] server %s:%d\n", VOICE_SERVER_HOST, VOICE_SERVER_PORT);

    if (WiFi.getMode() == WIFI_OFF) {
        // ESP-NOW is already initialised and owns the radio channel. Joining
        // Wi-Fi here moves the radio onto the router's channel, which is
        // exactly what the ESP-NOW peer (the robot) is sitting on, so the
        // button link keeps working across a voice turn.
        WiFi.mode(WIFI_STA);
    }
    WiFi.setHostname("walle-voice-remote");
    WiFi.setSleep(false);   // never sleep mid-conversation

    if (WiFi.status() == WL_CONNECTED) {
        Serial.print(F("[VOICE] already on the network, IP "));
        Serial.println(WiFi.localIP());
    } else if (!joinWifi()) {
        Serial.println(F("[VOICE] no Wi-Fi; buttons still work over ESP-NOW"));
        _state = VOICE_NO_WIFI;
        return false;
    }

    _state = VOICE_CONNECTING;
    probeServer();
    return _state == VOICE_READY;
}

bool VoiceLink::joinWifi() {
    if (VOICE_WIFI_SSID[0] == '\0') {
        Serial.println(F("[VOICE] VOICE_WIFI_SSID is not set in config.h"));
        return false;
    }

    Serial.print(F("[VOICE] joining "));
    Serial.print(VOICE_WIFI_SSID);
    Serial.print(" ...");

    WiFi.begin(VOICE_WIFI_SSID, VOICE_WIFI_PASSWORD);

    const uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < VOICE_WIFI_TIMEOUT_MS) {
        delay(250);
        Serial.print('.');
    }
    Serial.println();

    if (WiFi.status() != WL_CONNECTED) return false;

    Serial.print(F("[VOICE] online, IP "));
    Serial.println(WiFi.localIP());
    return true;
}

bool VoiceLink::probeServer() {
    HTTPClient http;
    http.setConnectTimeout(3000);
    http.setTimeout(4000);

    if (!http.begin(baseUrl() + "/api/voice/capabilities")) {
        Serial.println(F("[VOICE] cannot build capabilities URL"));
        return false;
    }
    if (VOICE_TOKEN[0] != '\0') {
        http.addHeader("x-walle-voice-token", VOICE_TOKEN);
    }

    const int code = http.GET();
    if (code != 200) {
        Serial.printf("[VOICE] server said HTTP %d\n", code);
        http.end();
        _state = VOICE_NO_SERVER;
        return false;
    }

    const String body = http.getString();
    http.end();

    _sttAvailable = body.indexOf("\"available\":true") >= 0;
    _ttsAvailable = body.indexOf("\"available\":true", body.indexOf("\"tts\"")) >= 0;

    Serial.printf("[VOICE] server ready - stt %s, tts %s\n",
                  _sttAvailable ? "yes" : "NO",
                  _ttsAvailable ? "yes" : "NO");

    if (!_sttAvailable) {
        Serial.println(F("[VOICE] speech-to-text is not configured on the server"));
        Serial.println(F("[VOICE] set GROQ_API_KEY or OPENAI_API_KEY in the app's .env"));
    }
    if (!_ttsAvailable) {
        Serial.println(F("[VOICE] text-to-speech is not configured on the server"));
        Serial.println(F("[VOICE] Groq has no speech endpoint: set OPENAI_API_KEY"));
    }

    _state = VOICE_READY;
    return true;
}

void VoiceLink::update(uint32_t now) {
    if (_state == VOICE_OFF) return;
    if (_state == VOICE_READY) {
        // A long silence can mean the router dropped us. Check occasionally
        // rather than on every loop so a working link costs almost nothing.
        if (now - _lastProbeMs > VOICE_KEEPALIVE_MS) {
            _lastProbeMs = now;
            if (WiFi.status() != WL_CONNECTED) {
                Serial.println(F("[VOICE] Wi-Fi dropped"));
                WiFi.disconnect();
                _state = VOICE_NO_WIFI;
            } else if (!probeServer() && now - _lastReconnectMs > VOICE_RECONNECT_MS) {
                _lastReconnectMs = now;
            }
        }
        return;
    }

    if (now - _lastReconnectMs < VOICE_RECONNECT_MS) return;
    _lastReconnectMs = now;

    Serial.println(F("[VOICE] retrying"));
    if (WiFi.status() != WL_CONNECTED) {
        WiFi.disconnect();
        if (!joinWifi()) {
            _state = VOICE_NO_WIFI;
            return;
        }
    }
    probeServer();
}

bool VoiceLink::sendStt(const String& pcm, String& outJson) {
    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(30000);

    // begin(url, method, headers) only exists in newer cores; setting the
    // header after begin() works on every core 2.x, so use that form.
    if (!http.begin(baseUrl() + "/api/voice/stt?rate=16000", "POST")) {
        Serial.println(F("[VOICE] stt: bad URL"));
        return false;
    }
    http.addHeader("Content-Type", "audio/pcm;rate=16000;channels=1;bits=16");
    if (VOICE_TOKEN[0] != '\0') {
        http.addHeader("x-walle-voice-token", VOICE_TOKEN);
    }

    // POST(uint8_t*, size_t) is not const-correct, hence the cast.
    const int code = http.POST((uint8_t*)pcm.c_str(), pcm.length());
    _lastHttpStatus = code;

    if (code != 200) {
        // 422 is the server refusing silence or an unintelligible clip, and
        // 502 is the provider failing. Both are worth showing in full: they
        // are the two errors a new user actually hits.
        Serial.printf("[VOICE] stt HTTP %d: %s\n", code, http.getString().c_str());
        http.end();
        return false;
    }

    outJson = http.getString();
    http.end();
    return true;
}

bool VoiceLink::speakText(const String& text) {
    if (text.length() == 0) return false;

    if (!voicePlaybackBegin()) return false;

    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(60000);

    String url = baseUrl() + "/api/voice/tts?text=" + urlEncode(text);
    if (!http.begin(url)) {
        voicePlaybackEnd();
        return false;
    }
    if (VOICE_TOKEN[0] != '\0') {
        http.addHeader("x-walle-voice-token", VOICE_TOKEN);
    }

    const int code = http.GET();
    _lastHttpStatus = code;
    if (code != 200) {
        Serial.printf("[VOICE] tts HTTP %d: %s\n", code, http.errorToString(code).c_str());
        http.end();
        voicePlaybackEnd();
        return false;
    }

    // STREAMED, NOT BUFFERED. 24 kHz mono PCM16 is 48 kB per second, so a
    // 500 character answer is around 17 seconds and roughly 816 kB - far
    // more than the ~250 kB of heap a WROOM has once Wi-Fi is up. Buffering
    // the whole response and calling i2s_write() at the end would fail on
    // any answer longer than about five seconds.
    //
    // So the bytes go straight from the socket into the I2S DMA as they
    // arrive, and only a small I2S-sized staging buffer is ever held.
    WiFiClient* stream = http.getStreamPtr();
    const int total = http.getSize();

    static uint8_t stage[2048];
    size_t staged = 0;
    int received = 0;
    bool ok = true;
    const uint32_t start = millis();

    while (http.connected() && millis() - start < 60000) {
        // Done when the server has sent everything, or has closed cleanly.
        if (total > 0 && received >= total) break;

        const int avail = stream->available();
        if (avail > 0) {
            int chunk = stream->readBytes(stage + staged, sizeof(stage) - staged);
            if (chunk > 0) {
                received += chunk;
                staged += chunk;
                // PCM16 samples, so never flush a lone trailing byte.
                if (staged >= sizeof(stage) - 1) {
                    if (!voicePlaybackFeed(stage, staged)) { ok = false; break; }
                    staged = 0;
                }
            }
        } else {
            delay(2);
        }

        // A second press cancels the whole turn, mid-download.
        if (sAbortFlag && *sAbortFlag) {
            Serial.println(F("[VOICE] tts: aborted by user"));
            ok = false;
            break;
        }
    }

    // Flush the tail, which is where the last syllable lives.
    if (ok && staged > 1) ok = voicePlaybackFeed(stage, staged);

    http.end();
    voicePlaybackEnd();

    if (ok && total > 0 && received < total) {
        Serial.printf("[VOICE] tts: truncated, %d of %d bytes\n", received, total);
        ok = false;
    }
    return ok;
}

bool VoiceLink::voiceTurn(const String& prompt) {
    _lastTranscript = "";
    _lastReply = "";

    if (WiFi.status() != WL_CONNECTED) {
        Serial.println(F("[VOICE] not on Wi-Fi; press is ignored (buttons still work)"));
        return false;
    }
    if (!probeServer()) {
        Serial.println(F("[VOICE] the app is not answering; is it running?"));
        return false;
    }
    if (!_sttAvailable) {
        Serial.println(F("[VOICE] no speech-to-text configured on the server"));
        return false;
    }

    Serial.println();
    Serial.printf("[VOICE] %s\n", prompt.c_str());

    // ---- 1. record ----
    // voiceAudioRecord() takes a plain function pointer so it stays free
    // of C++ lambdas, which have a different calling convention on Xtensa.
    String pcm;
    if (!voiceAudioRecord(pcm, VOICE_MAX_RECORD_MS, VOICE_SILENCE_MS, &stillTalking)) {
        Serial.println(F("[VOICE] nothing heard, skipping the upload"));
        return false;
    }

    // ---- 2. transcribe + answer ----
    Serial.println(F("[VOICE] transcribing..."));
    String json;
    if (!sendStt(pcm, json)) return false;

    _lastTranscript = jsonField(json, "text");
    _lastReply = jsonField(json, "reply");
    if (_lastReply.length() > MAX_REPLY_CHARS) {
        _lastReply = _lastReply.substring(0, MAX_REPLY_CHARS);
    }
    pcm = "";   // release the clip before we allocate the reply

    if (_lastTranscript.length() == 0) {
        Serial.println(F("[VOICE] empty transcript"));
        return false;
    }

    Serial.print(F("[VOICE] you: "));
    Serial.println(_lastTranscript);

    // ---- 3. speak ----
    if (!_ttsAvailable) {
        Serial.print(F("[VOICE] WALL-E: "));
        Serial.println(_lastReply);
        Serial.println(F("[VOICE] (no TTS configured, so this is text only)"));
        return true;
    }

    Serial.println(F("[VOICE] speaking"));
    if (!speakText(_lastReply)) {
        Serial.println(F("[VOICE] playback failed"));
        return false;
    }
    return true;
}
