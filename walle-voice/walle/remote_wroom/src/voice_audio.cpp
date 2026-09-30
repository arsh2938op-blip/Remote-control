// ============================================================
//  Voice capture and playback — ESP32-WROOM remote
//  ------------------------------------------------------------
//  The robot (ESP32-S3) has no microphone and no speaker: its
//  STT/TTS code was deliberately removed to free the I2S pins.
//  Voice therefore lives here, on the remote.
//
//  Audio hardware:
//    INMP441   I2S microphone  -> 16 kHz mono PCM16
//    MAX98357A I2S DAC         <- 24 kHz mono PCM16
//
//  Both rates are fixed by the companion server's contract and
//  must not be changed here without changing voice.ts too.
//
//  I2S_NUM_0 records, I2S_NUM_1 plays, so playback never has to
//  wait for capture to be torn down.
//
//  WHY A TASK INSTEAD OF A DMA CALLBACK
//  ------------------------------------
//  The legacy i2s_set_rx_callback() DMA callback is gone from the
//  current ESP32 Arduino core, so the recorder runs as its own
//  FreeRTOS task doing blocking i2s_read() into a ring buffer.
//  That is also the better shape here: the task owns the mic
//  completely, the main loop never touches the driver, and there
//  is no shared-state locking between an ISR and loop().
//
//  Compiled and linked against Arduino core 2.0.17 / IDF 3.3-style
//  driver, where the field is `channel_format` and the non-deprecated
//  format constant is I2S_COMM_FORMAT_STAND_I2S.
// ============================================================
#include "voice_audio.h"

#include <driver/i2s.h>
#include "config.h"

// How many samples the task reads per iteration. 512 is 32 ms at
// 16 kHz: short enough that the ring buffer never starves the
// upload, long enough to keep the wakeups down.
#define MIC_CHUNK_SAMPLES  512

// Half a second of slack between the reader task and whoever is
// draining the ring buffer.
#define MIC_RING_SAMPLES   (VOICE_SAMPLE_RATE / 2)

static int16_t       sMicRing[MIC_RING_SAMPLES];
static volatile size_t sMicRingW = 0;
static volatile size_t sMicRingR = 0;
static volatile bool    sMicRunning = false;
static bool         sMicBegun = false;
static bool         sSpkBegun = false;
static TaskHandle_t sMicTask = nullptr;

/**
 * INMP441 sample conversion.
 *
 * The INMP441 is a 24 bit device inside a 32 bit I2S frame. With
 * I2S_COMM_FORMAT_STAND_I2S the payload is left justified in the
 * 32 bit word the driver hands us, so shifting right by 16 leaves
 * the top 16 data bits. If a particular module sounds wrong or
 * clips, this is the first thing to try: 14..17 all appear in the
 * wild.
 */
#ifndef VOICE_MIC_RIGHT_SHIFT
#define VOICE_MIC_RIGHT_SHIFT 16
#endif

static inline int16_t micToS16(int32_t raw) {
    return (int16_t)(raw >> VOICE_MIC_RIGHT_SHIFT);
}

// ----------------------------------------------------------
//  Ring buffer
//
//  Single producer (the reader task) and single consumer
//  (the recording loop). Each advances one index, and both are
//  32-bit aligned reads/writes on this target, so no lock is
//  needed and no interrupt is involved at all.
// ----------------------------------------------------------

static inline size_t micRingUsed() {
    return (sMicRingW + MIC_RING_SAMPLES - sMicRingR) % MIC_RING_SAMPLES;
}

static inline void micRingReset() {
    sMicRingW = sMicRingR = 0;
}

/** Copy up to `max` samples out. Returns how many were taken. */
static size_t micRingDrain(int16_t* dst, size_t max) {
    const size_t avail = micRingUsed();
    const size_t n = (avail < max) ? avail : max;
    for (size_t i = 0; i < n; i++) {
        dst[i] = sMicRing[(sMicRingR + i) % MIC_RING_SAMPLES];
    }
    sMicRingR = (sMicRingR + n) % MIC_RING_SAMPLES;
    return n;
}

/**
 * The recorder. Reads the mic forever until sMicRunning goes false.
 *
 * Runs at a higher priority than the app task so the ring buffer keeps
 * filling even while the main loop is busy on Wi-Fi, and drops
 * samples rather than blocking when the consumer falls behind.
 */
static void micTask(void* param) {
    (void)param;
    int32_t raw[MIC_CHUNK_SAMPLES];
    size_t got = 0;

    while (sMicRunning) {
        if (i2s_read(I2S_NUM_0, raw, sizeof(raw), &got, 100 / portTICK_PERIOD_MS) != ESP_OK) {
            continue;
        }

        const size_t n = got / sizeof(int32_t);
        for (size_t i = 0; i < n; i++) {
            if (micRingUsed() >= MIC_RING_SAMPLES) break;   // drop, never block
            sMicRing[sMicRingW] = micToS16(raw[i]);
            sMicRingW = (sMicRingW + 1) % MIC_RING_SAMPLES;
        }
    }

    // Drain whatever is left so the last samples are not lost.
    (void)i2s_read(I2S_NUM_0, raw, sizeof(raw), &got, 0);

    sMicTask = nullptr;
    vTaskDelete(nullptr);
}

bool voiceAudioBegin() {
    if (sMicBegun) return true;

    i2s_config_t cfg = {};
    cfg.mode                = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX);
    cfg.sample_rate         = VOICE_SAMPLE_RATE;
    cfg.bits_per_sample     = I2S_BITS_PER_SAMPLE_32BIT;
    // The INMP441's L/R pin is grounded, so it drives the right slot.
    cfg.channel_format      = I2S_CHANNEL_FMT_ALL_RIGHT;
    cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    cfg.intr_alloc_flags    = ESP_INTR_FLAG_LEVEL1;
    cfg.dma_buf_count       = 4;
    cfg.dma_buf_len         = MIC_CHUNK_SAMPLES;
    cfg.use_apll            = false;
    cfg.tx_desc_auto_clear  = false;

    if (i2s_driver_install(I2S_NUM_0, &cfg, 0, NULL) != ESP_OK) {
        Serial.println(F("[VOICE] mic driver install failed"));
        return false;
    }

    i2s_pin_config_t pins = {};
    pins.bck_io_num   = VOICE_MIC_SCK_PIN;
    pins.ws_io_num    = VOICE_MIC_WS_PIN;
    pins.data_out_num = I2S_PIN_NO_CHANGE;
    pins.data_in_num  = VOICE_MIC_SD_PIN;

    if (i2s_set_pin(I2S_NUM_0, &pins) != ESP_OK) {
        Serial.println(F("[VOICE] mic pin config failed"));
        i2s_driver_uninstall(I2S_NUM_0);
        return false;
    }

    i2s_zero_dma_buffer(I2S_NUM_0);

    micRingReset();
    sMicRunning = true;
    sMicBegun = true;

    // Priority 4 puts the recorder above the Arduino loopTask (1).
    if (xTaskCreate(micTask, "mic", 4096, NULL, 4, &sMicTask) != pdPASS) {
        Serial.println(F("[VOICE] could not start the mic task"));
        sMicRunning = false;
        sMicBegun = false;
        i2s_driver_uninstall(I2S_NUM_0);
        return false;
    }

    Serial.println(F("[VOICE] microphone ready"));
    return true;
}

void voiceAudioEnd() {
    if (!sMicBegun) return;
    sMicRunning = false;

    // Give the task a moment to notice and delete itself, so we never
    // uninstall the driver while it is still reading from it.
    for (int i = 0; i < 50 && sMicTask != nullptr; i++) {
        delay(10);
    }

    i2s_stop(I2S_NUM_0);
    i2s_driver_uninstall(I2S_NUM_0);
    sMicBegun = false;
    Serial.println(F("[VOICE] microphone stopped"));
}

bool voiceAudioRecord(String& outPcm, uint32_t maxMs, uint32_t silenceMs,
                      bool (*stillTalking)()) {
    outPcm = "";

    if (maxMs == 0) maxMs = VOICE_MAX_RECORD_MS;
    if (silenceMs == 0) silenceMs = VOICE_SILENCE_MS;

    if (!voiceAudioBegin()) return false;

    // Let the task fill the ring before we judge "silence", or the first
    // iterations always look like silence and cut the clip short.
    delay(150);

    const uint32_t startMs = millis();
    uint32_t lastVoiceMs = startMs;

    while (millis() - startMs < maxMs) {
        int16_t block[MIC_CHUNK_SAMPLES];
        const size_t n = micRingDrain(block, MIC_CHUNK_SAMPLES);

        if (n > 0) {
            int16_t peak = 0;
            // Reserve once per block: growing a String byte by byte
            // reallocates constantly and fragments the heap.
            outPcm.reserve(outPcm.length() + n * 2);
            for (size_t i = 0; i < n; i++) {
                const int16_t s = block[i];
                const int16_t a = (s < 0) ? -s : s;
                if (a > peak) peak = a;
                outPcm += (char)(uint8_t)(s & 0xFF);
                outPcm += (char)(uint8_t)((s >> 8) & 0xFF);
            }
            if (peak > VOICE_VAD_PEAK) lastVoiceMs = millis();
        }

        if (stillTalking && !stillTalking()) break;

        const uint32_t elapsed = millis() - startMs;
        if (elapsed > VOICE_MIN_RECORD_MS && millis() - lastVoiceMs > silenceMs) break;

        delay(5);
    }

    voiceAudioEnd();

    const size_t samples = outPcm.length() / 2;
    Serial.printf("[VOICE] captured %u samples (%.1f s)\n",
                  (unsigned)samples, samples / (float)VOICE_SAMPLE_RATE);

    // One second of real audio, otherwise this was a button press.
    return samples > VOICE_SAMPLE_RATE;
}

// ----------------------------------------------------------
//  Speaker
// ----------------------------------------------------------

bool voicePlaybackBegin() {
    if (sSpkBegun) return true;

    digitalWrite(VOICE_SPK_EN_PIN, HIGH);

    i2s_config_t cfg = {};
    cfg.mode                = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
    cfg.sample_rate         = VOICE_PLAY_RATE;
    cfg.bits_per_sample     = I2S_BITS_PER_SAMPLE_16BIT;
    cfg.channel_format      = I2S_CHANNEL_FMT_ONLY_RIGHT;   // mono
    cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    cfg.intr_alloc_flags    = ESP_INTR_FLAG_LEVEL1;
    cfg.dma_buf_count       = 8;
    cfg.dma_buf_len         = 512;
    cfg.use_apll            = false;
    cfg.tx_desc_auto_clear  = true;

    if (i2s_driver_install(I2S_NUM_1, &cfg, 0, NULL) != ESP_OK) {
        Serial.println(F("[VOICE] speaker driver install failed"));
        digitalWrite(VOICE_SPK_EN_PIN, LOW);
        return false;
    }

    i2s_pin_config_t pins = {};
    pins.bck_io_num   = VOICE_SPK_BCLK_PIN;
    pins.ws_io_num    = VOICE_SPK_LRC_PIN;
    pins.data_out_num = VOICE_SPK_DIN_PIN;
    pins.data_in_num  = I2S_PIN_NO_CHANGE;

    if (i2s_set_pin(I2S_NUM_1, &pins) != ESP_OK) {
        Serial.println(F("[VOICE] speaker pin config failed"));
        i2s_driver_uninstall(I2S_NUM_1);
        digitalWrite(VOICE_SPK_EN_PIN, LOW);
        return false;
    }

    i2s_zero_dma_buffer(I2S_NUM_1);
    sSpkBegun = true;
    Serial.println(F("[VOICE] speaker ready"));
    return true;
}

void voicePlaybackEnd() {
    if (!sSpkBegun) return;

    // Give the DMA a moment to drain the last few hundred ms, otherwise
    // the closing syllable is cut off by the teardown.
    delay(150);

    i2s_stop(I2S_NUM_1);
    i2s_driver_uninstall(I2S_NUM_1);
    digitalWrite(VOICE_SPK_EN_PIN, LOW);
    sSpkBegun = false;
    Serial.println(F("[VOICE] speaker stopped"));
}

bool voicePlaybackFeed(const uint8_t* data, size_t bytes) {
    if (!sSpkBegun || bytes < 2) return true;

    size_t offset = 0;
    while (offset < bytes) {
        // Slice the write so the watchdog is fed and so a cancel between
        // chunks is noticed promptly rather than after a long write.
        const size_t remaining = bytes - offset;
        const size_t n = (remaining > 2048) ? 2048 : remaining;
        size_t written = 0;
        if (i2s_write(I2S_NUM_1, data + offset, n, &written, 1000 / portTICK_PERIOD_MS) != ESP_OK) {
            Serial.println(F("[VOICE] playback write failed"));
            return false;
        }
        offset += written;
    }
    return true;
}

bool voicePlaybackPcm(const uint8_t* data, size_t bytes) {
    if (!sSpkBegun || bytes < 2) return false;

    if (!voicePlaybackFeed(data, bytes)) return false;

    // Let the last samples drain out of the DMA buffers, otherwise the
    // final syllable is clipped by the teardown.
    delay(150);
    return true;
}
