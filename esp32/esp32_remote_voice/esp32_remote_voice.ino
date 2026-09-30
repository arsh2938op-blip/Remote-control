/* =====================================================================
 * ESP32 Remote Voice Control  -  STT + TTS over WiFi
 * ---------------------------------------------------------------------
 * Board   : ESP32 DevKit v1 / ESP32-WROOM-32
 * Mic     : INMP441  I2S digital microphone
 * Speaker : MAX98357A I2S DAC  ->  speaker
 * Button  : BOOT button (GPIO0)  =  press and talk
 *
 * Flow    : press button  ->  record up to 8 s of 16 kHz mono PCM
 *           -> POST /stt  ->  server returns {"text": "..."}
 *           -> GET /tts?text=...  ->  stream 24 kHz PCM to the speaker
 *           -> press the button again to interrupt playback
 *
 * WiFi    : credentials live in NVS. If missing, or a connection cannot
 *           be made, the ESP32 starts its own AP "ESP32-Voice" and serves
 *           a setup page at http://192.168.4.1
 *
 * Needs   : ESP32 Arduino core 2.0.x or 3.0.x, no extra libraries.
 * ===================================================================== */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <Preferences.h>
#include <driver/i2s.h>

/* =====================================================================
 * 1. USER SETTINGS
 * ===================================================================== */

static const char *DEVICE_NAME = "esp32-voice-01";

// PC that runs server.py  (use the IP from "ipconfig", not localhost)
static const char *SERVER_HOST = "192.168.1.50";
static const uint16_t SERVER_PORT = 8000;

// Optional compile-time WiFi. Leave empty to use the setup portal instead.
static const char *WIFI_SSID = "";        // "MyHomeWiFi"
static const char *WIFI_PASS = "";        // "hunter2000"

// Fallback access point used for configuration (password needs >= 8 chars)
static const char *AP_SSID = "ESP32-Voice";
static const char *AP_PASS = "esp32voice";

/* =====================================================================
 * 2. PIN DEFINITIONS   (change if you wire it differently)
 * ===================================================================== */

// INMP441 I2S microphone
static const int PIN_MIC_SCK = 14;   // BCLK
static const int PIN_MIC_WS  = 15;   // LRCK / WS
static const int PIN_MIC_SD  = 13;   // DOUT -> ESP32

// MAX98357A I2S DAC
static const int PIN_DAC_BCLK = 26;
static const int PIN_DAC_LRC  = 27;
static const int PIN_DAC_DIN  = 22;
static const int PIN_DAC_EN   = 23;  // SD pin, HIGH = amplifier on

// User interface
static const int PIN_BUTTON = 0;    // BOOT button, INPUT_PULLUP, active LOW
static const int PIN_LED    = 2;    // on-board LED

/* =====================================================================
 * 3. AUDIO FORMAT  (must match server.py)
 * ===================================================================== */

static const uint32_t SAMPLE_RATE_MIC = 16000;   // recorded / uploaded
static const uint32_t SAMPLE_RATE_DAC = 24000;   // played back

#define MIC_CHUNK_SAMPLES 512                       // 32 ms @ 16 kHz
static int16_t       sMicChunk[MIC_CHUNK_SAMPLES];
static int16_t       sDacChunk[1024];

// Lock-free ring buffer between the I2S DMA callback and the main loop
#define MIC_RING_SAMPLES (SAMPLE_RATE_MIC / 2)      // 0.5 s of headroom
static int16_t        sMicRing[MIC_RING_SAMPLES];
static volatile size_t sMicRingW = 0;
static volatile size_t sMicRingR = 0;

static volatile bool sMicRunning = false;

/* =====================================================================
 * 4. STATE
 * ===================================================================== */

enum State { ST_IDLE, ST_RECORDING, ST_THINKING, ST_SPEAKING, ST_NOWIFI };

static State        g_state = ST_IDLE;
static String       g_wifiSsid, g_wifiPass;
static Preferences  g_prefs;
static WebServer    g_apServer(80);

// Recording tuning
static const unsigned long REC_MAX_MS  = 8000;   // hard clip length
static const unsigned long REC_SIL_MS  = 1200;   // auto stop on silence
static const unsigned long REC_MIN_MS  = 1200;   // ignore clicks
static const int16_t       VAD_THRESH  = 600;    // peak amplitude = "speaking"

/* =====================================================================
 * 5. SMALL HELPERS
 * ===================================================================== */

static void ledOn()  { digitalWrite(PIN_LED, HIGH); }
static void ledOff() { digitalWrite(PIN_LED, LOW); }

static void setState(State s)
{
  g_state = s;
  ledOff();
  if (s == ST_RECORDING || s == ST_NOWIFI) ledOn();
  Serial.print(F("[state] "));
  Serial.println((int)s);
}

static void blink(unsigned times, unsigned ms)
{
  for (unsigned i = 0; i < times; i++) { ledOn(); delay(ms); ledOff(); delay(ms); }
}

static size_t micRingUsed()
{
  return (sMicRingW + MIC_RING_SAMPLES - sMicRingR) % MIC_RING_SAMPLES;
}

static void micRingReset() { sMicRingW = sMicRingR = 0; }

static bool buttonDown() { return digitalRead(PIN_BUTTON) == LOW; }

/* ---- INMP441 sample conversion ------------------------------------
 * The INMP441 is a 24 bit device inside a 32 bit I2S frame. With
 * I2S_COMM_FORMAT_I2S the payload is left justified in the 32 bit word
 * we receive, so shifting right by 16 leaves the top 16 data bits.
 * If playback/recording sounds wrong try MIC_RIGHT_SHIFT 14..17.
 * ------------------------------------------------------------------- */
static const uint8_t MIC_RIGHT_SHIFT = 16;

static inline int16_t micToS16(int32_t raw) { return (int16_t)(raw >> MIC_RIGHT_SHIFT); }

/* =====================================================================
 * 6. I2S MICROPHONE
 * ===================================================================== */

static void i2sMicRxCallback(void *param)
{
  (void)param;
  if (!sMicRunning) return;

  int32_t raw[MIC_CHUNK_SAMPLES];
  size_t bytes = 0;
  if (i2s_read(I2S_NUM_0, raw, sizeof(raw), &bytes, portMAX_DELAY) != ESP_OK) return;

  size_t n = bytes / sizeof(int32_t);
  for (size_t i = 0; i < n; i++) {
    if (micRingUsed() >= MIC_RING_SAMPLES) break;    // drop, never block DMA
    sMicRing[sMicRingW] = micToS16(raw[i]);
    sMicRingW = (sMicRingW + 1) % MIC_RING_SAMPLES;
  }
}

static bool i2sMicStart()
{
  i2s_config_t cfg = {};
  cfg.mode              = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX);
  cfg.sample_rate       = SAMPLE_RATE_MIC;
  cfg.bits_per_sample   = I2S_BITS_PER_SAMPLE_32BIT;
  cfg.channel_fmt       = I2S_CHANNEL_FMT_ALL_RIGHT;   // INMP441 L/R -> GND
  cfg.communication_format = I2S_COMM_FORMAT_I2S;
  cfg.intr_alloc_flags  = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count     = 4;
  cfg.dma_buf_len       = MIC_CHUNK_SAMPLES;
  cfg.tx_desc_auto_clear = false;
  cfg.fixed_mclk        = 0;

  if (i2s_driver_install(I2S_NUM_0, &cfg, 0, NULL) != ESP_OK) {
    Serial.println(F("[i2s] mic driver install failed"));
    return false;
  }

  i2s_pin_config_t pins = {};
  pins.bck_io_num   = PIN_MIC_SCK;
  pins.ws_io_num    = PIN_MIC_WS;
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num  = PIN_MIC_SD;

  if (i2s_set_pin(I2S_NUM_0, &pins) != ESP_OK) {
    Serial.println(F("[i2s] mic pin config failed"));
    i2s_driver_uninstall(I2S_NUM_0);
    return false;
  }

  i2s_zero_dma_buffer(I2S_NUM_0);

  sMicRunning = true;
  micRingReset();
  i2s_set_rx_callback(I2S_NUM_0, &i2sMicRxCallback);
  return true;
}

static void i2sMicStop()
{
  sMicRunning = false;
  i2s_set_rx_callback(I2S_NUM_0, NULL);
  i2s_stop(I2S_NUM_0);
  i2s_driver_uninstall(I2S_NUM_0);
}

/* =====================================================================
 * 7. I2S SPEAKER
 * ===================================================================== */

static bool i2sDacStart()
{
  digitalWrite(PIN_DAC_EN, HIGH);

  i2s_config_t cfg = {};
  cfg.mode              = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
  cfg.sample_rate       = SAMPLE_RATE_DAC;
  cfg.bits_per_sample   = I2S_BITS_PER_SAMPLE_16BIT;
  cfg.channel_fmt       = I2S_CHANNEL_FMT_RIGHT_ONLY;   // mono
  cfg.communication_format = I2S_COMM_FORMAT_I2S;
  cfg.intr_alloc_flags  = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count     = 8;
  cfg.dma_buf_len       = 512;
  cfg.tx_desc_auto_clear = true;
  cfg.fixed_mclk        = 0;

  if (i2s_driver_install(I2S_NUM_1, &cfg, 0, NULL) != ESP_OK) {
    Serial.println(F("[i2s] dac driver install failed"));
    digitalWrite(PIN_DAC_EN, LOW);
    return false;
  }

  i2s_pin_config_t pins = {};
  pins.bck_io_num   = PIN_DAC_BCLK;
  pins.ws_io_num    = PIN_DAC_LRC;
  pins.data_out_num = PIN_DAC_DIN;
  pins.data_in_num  = I2S_PIN_NO_CHANGE;

  if (i2s_set_pin(I2S_NUM_1, &pins) != ESP_OK) {
    Serial.println(F("[i2s] dac pin config failed"));
    i2s_driver_uninstall(I2S_NUM_1);
    digitalWrite(PIN_DAC_EN, LOW);
    return false;
  }

  i2s_zero_dma_buffer(I2S_NUM_1);
  return true;
}

static void i2sDacStop()
{
  i2s_stop(I2S_NUM_1);
  i2s_driver_uninstall(I2S_NUM_1);
  digitalWrite(PIN_DAC_EN, LOW);
}

/* =====================================================================
 * 8. TINY JSON PARSER  (keeps the ArduinoJson dependency away)
 * ===================================================================== */

static String jsonStringField(const String &json, const char *key)
{
  String needle = String("\"") + key + "\"";
  int k = json.indexOf(needle);
  if (k < 0) return "";

  int i = json.indexOf(':', k + needle.length());
  if (i < 0) return "";

  i++;
  while (i < (int)json.length() && isspace((uint8_t)json[i])) i++;
  if (i >= (int)json.length()) return "";

  if (json[i] != '"') {                       // number / bool / null
    int end = i;
    while (end < (int)json.length() && json[end] != ',' && json[end] != '}' && json[end] != ']') end++;
    return json.substring(i, end);
  }

  i++;
  String out;
  while (i < (int)json.length() && json[i] != '"') {
    if (json[i] == '\\' && i + 1 < (int)json.length()) {
      i++;
      switch (json[i]) {
        case 'n':  out += '\n'; break;
        case 't':  out += '\t'; break;
        case 'r':  break;
        case 'u':  i += 4;    break;   // skip \uXXXX
        default:   out += json[i];
      }
    } else {
      out += json[i];
    }
    i++;
  }
  return out;
}

static String urlEncode(const String &s)
{
  String out;
  out.reserve(s.length() * 3);
  for (size_t i = 0; i < s.length(); i++) {
    uint8_t c = (uint8_t)s[i];
    bool safe = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == ' ' ||
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

/* =====================================================================
 * 9. WIFI  +  SETUP PORTAL      (the "connection thing")
 * ===================================================================== */

static void loadCredentials()
{
  g_prefs.begin("wifi", true);
  g_wifiSsid = g_prefs.getString("ssid", WIFI_SSID);
  g_wifiPass = g_prefs.getString("pass", WIFI_PASS);
  g_prefs.end();
}

static void saveCredentials(const String &ssid, const String &pass)
{
  g_prefs.begin("wifi", false);
  g_prefs.putString("ssid", ssid);
  g_prefs.putString("pass", pass);
  g_prefs.end();
}

static bool wifiConnect(uint8_t maxTries)
{
  if (g_wifiSsid.length() == 0) return false;

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(DEVICE_NAME);
  WiFi.begin(g_wifiSsid.c_str(), g_wifiPass.c_str());

  Serial.print(F("[wifi] joining "));
  Serial.print(g_wifiSsid);
  Serial.print(" ...");

  for (uint8_t i = 0; i < maxTries; i++) {
    if (WiFi.status() == WL_CONNECTED) break;
    setState(ST_NOWIFI);
    delay(500);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(F("[wifi] online, IP = "));
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.println(F("[wifi] no connection"));
  return false;
}

static void handleApRoot()
{
  String page =
    "<!doctype html><html><head><meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>ESP32 Voice setup</title><style>"
    "body{font-family:sans-serif;margin:2rem;max-width:26rem}"
    "label{display:block;margin:.9rem 0 .2rem}"
    "input{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box}"
    "button{margin-top:1.2rem;padding:.7rem 1.2rem;font-size:1rem;"
    "background:#1769aa;color:#fff;border:0;border-radius:6px}"
    "</style></head><body><h2>ESP32 Remote Voice</h2>"
    "<p>No WiFi connection yet. Enter your network details, then reboot.</p>"
    "<form method='GET' action='/save'>"
    "<label>WiFi SSID</label><input name='ssid' required>"
    "<label>WiFi password</label><input name='pass' type='password'>"
    "<label>Server IP (PC running server.py)</label><input name='host' value='";
  page += SERVER_HOST;
  page += "'><button type='submit'>Save &amp; reboot</button></form></body></html>";

  g_apServer.send(200, "text/html", page);
}

static void handleApSave()
{
  saveCredentials(g_apServer.arg("ssid"), g_apServer.arg("pass"));
  g_apServer.send(200, "text/html",
    "<h3>Saved - rebooting</h3><p>Open the Serial monitor at 115200 baud "
    "to see the assigned IP address.</p>");
  Serial.println(F("[wifi] credentials stored, rebooting"));
  delay(1200);
  ESP.restart();
}

static void startAccessPoint()
{
  Serial.println(F("[wifi] AP setup mode"));
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASS);

  g_apServer.on("/", HTTP_GET, handleApRoot);
  g_apServer.on("/save", HTTP_GET, handleApSave);
  g_apServer.onNotFound(handleApRoot);
  g_apServer.begin();

  Serial.print(F("[wifi] connect to "));
  Serial.print(AP_SSID);
  Serial.print(F("  ->  http://"));
  Serial.println(WiFi.softAPIP());

  setState(ST_NOWIFI);
  while (true) {
    g_apServer.handleClient();
    blink(1, 120);
    delay(600);
  }
}

/* =====================================================================
 * 10. VOICE PIPELINE
 * ===================================================================== */

// Record until silence, a second button press, or REC_MAX_MS.
static bool recordClip(String &rawPcm)
{
  rawPcm = "";
  if (!i2sMicStart()) return false;

  delay(100);                       // let the DMA settle
  setState(ST_RECORDING);

  unsigned long startMs     = millis();
  unsigned long lastVoiceMs = startMs;
  bool          wasDown     = buttonDown();

  while (millis() - startMs < REC_MAX_MS) {
    size_t avail = micRingUsed();
    if (avail > 0) {
      int32_t peak = 0;
      for (size_t i = 0; i < avail; i++) {
        int16_t s = sMicRing[(sMicRingR + i) % MIC_RING_SAMPLES];
        int32_t a = (s < 0) ? -s : s;
        if (a > peak) peak = a;
        // little endian 16 bit PCM, exactly what the server expects
        rawPcm += (char)(uint8_t)(s & 0xFF);
        rawPcm += (char)(uint8_t)((s >> 8) & 0xFF);
      }
      sMicRingR = (sMicRingR + avail) % MIC_RING_SAMPLES;
      if (peak > VAD_THRESH) lastVoiceMs = millis();
    }

    bool down = buttonDown();
    if (down && !wasDown) { wasDown = down; break; }   // user stopped it
    if (!down) wasDown = false;

    if (millis() - lastVoiceMs > REC_SIL_MS && millis() - startMs > REC_MIN_MS) break;
    delay(5);
  }

  i2sMicStop();

  size_t samples = rawPcm.length() / 2;
  Serial.print(F("[mic] "));
  Serial.print(samples);
  Serial.print(F(" samples ("));
  Serial.print((float)samples / SAMPLE_RATE_MIC);
  Serial.println(F(" s)"));

  return samples > SAMPLE_RATE_MIC;      // need at least 1 second of audio
}

static bool sendStt(const String &rawPcm, String &transcript)
{
  HTTPClient http;
  String url = String("http://") + SERVER_HOST + ":" + SERVER_PORT + "/stt";
  http.setConnectTimeout(5000);
  http.setTimeout(30000);

  if (!http.begin(url, "POST", "Content-Type: audio/pcm;rate=16000;channels=1;bits=16")) {
    Serial.println(F("[stt] http.begin failed"));
    return false;
  }

  int code = http.POST((const uint8_t *)rawPcm.c_str(), rawPcm.length());
  if (code != 200) {
    Serial.print(F("[stt] HTTP "));
    Serial.print(code);
    Serial.print(F(" -> "));
    Serial.println(http.getString());
    http.end();
    return false;
  }

  String body = http.getString();
  http.end();

  transcript = jsonStringField(body, "text");
  if (transcript.isEmpty()) {
    Serial.print(F("[stt] unexpected reply: "));
    Serial.println(body);
  }
  return !transcript.isEmpty();
}

// Streams the TTS reply straight into the I2S DMA while it downloads.
static bool speak(const String &text)
{
  if (text.isEmpty()) return false;
  if (!i2sDacStart()) return false;

  setState(ST_SPEAKING);

  HTTPClient http;
  String url = String("http://") + SERVER_HOST + ":" + SERVER_PORT + "/tts?text=" + urlEncode(text);
  http.setConnectTimeout(5000);
  http.setTimeout(90000);

  if (!http.begin(url)) { i2sDacStop(); return false; }

  int code = http.GET();
  if (code != 200) {
    Serial.print(F("[tts] HTTP "));
    Serial.println(code);
    http.end();
    i2sDacStop();
    return false;
  }

  WiFiClient      *stream   = http.getStreamPtr();
  size_t           pending  = 0;
  unsigned long    lastLed  = millis();
  bool             aborted  = false;
  bool             wasDown  = buttonDown();

  while (http.connected() && !aborted) {
    size_t n = stream->available();
    if (n == 0) { delay(2); continue; }

    uint8_t buf[512];
    int r = stream->readBytes(buf, n < sizeof(buf) ? n : sizeof(buf));
    for (int i = 0; i + 1 < r; i += 2) {
      sDacChunk[pending++] = (int16_t)((uint16_t)buf[i] | ((uint16_t)buf[i + 1] << 8));
      if (pending >= 1024) {
        size_t written = 0;
        i2s_write(I2S_NUM_1, sDacChunk, pending * sizeof(int16_t), &written, portMAX_DELAY);
        pending = 0;

        bool down = buttonDown();
        if (down && !wasDown) { wasDown = down; aborted = true; break; }
        if (!down) wasDown = false;
      }
    }

    if (millis() - lastLed > 300) { ledOff(); delay(40); ledOn(); lastLed = millis(); }
  }

  if (pending > 0 && !aborted) {                 // flush the tail
    size_t written = 0;
    i2s_write(I2S_NUM_1, sDacChunk, pending * sizeof(int16_t), &written, 2000);
  }

  delay(120);                                     // drain the DMA buffers
  i2sDacStop();
  http.end();

  Serial.println(aborted ? F("[tts] playback interrupted") : F("[tts] playback done"));
  return !aborted;
}

static void voiceRoundTrip()
{
  Serial.println(F("--- listening ---"));
  String pcm, text;

  if (recordClip(pcm) && sendStt(pcm, text)) {
    Serial.print(F("[you] "));
    Serial.println(text);

    setState(ST_THINKING);
    delay(150);
    speak(text);
  } else {
    Serial.println(F("[error] nothing heard, or the STT request failed"));
    blink(4, 90);
  }

  setState(ST_IDLE);
  delay(400);
}

/* =====================================================================
 * 11. SETUP / LOOP
 * ===================================================================== */

void setup()
{
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println(F("====================================="));
  Serial.println(F(" ESP32 Remote Voice  (STT + TTS)"));
  Serial.println(F("====================================="));

  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_DAC_EN, OUTPUT);
  digitalWrite(PIN_DAC_EN, LOW);
  ledOff();

  loadCredentials();

  /* ---- the connection step ---- */
  if (WiFi.status() != WL_CONNECTED) {
    if (!wifiConnect(3) && !wifiConnect(10)) {
      startAccessPoint();          // does not return
    }
  }

  Serial.print(F("[server] "));
  Serial.print(SERVER_HOST);
  Serial.print(':');
  Serial.println(SERVER_PORT);
  Serial.println(F("Ready - press the BOOT button and talk."));

  setState(ST_IDLE);
}

void loop()
{
  if (g_state != ST_IDLE) return;

  static unsigned long lastBlink = 0;
  if (millis() - lastBlink > 2000) { blink(1, 60); lastBlink = millis(); }

  static bool wasDown = false;
  bool down = buttonDown();

  if (down && !wasDown) {
    wasDown = true;
    delay(60);                                    // debounce
    while (buttonDown()) delay(10);               // wait for release
    voiceRoundTrip();
  }
  if (!down) wasDown = false;
}
