// ============================================================
//  Voice capture and playback — ESP32-WROOM remote
//  ------------------------------------------------------------
//  The robot (ESP32-S3) has no microphone and no speaker: its
//  STT/TTS code was deliberately removed to free the I2S pins.
//  Voice therefore lives here, on the remote, next to the
//  buttons that already drive the robot over ESP-NOW.
//
//  Audio hardware:
//    INMP441   I2S microphone  -> 16 kHz mono PCM16
//    MAX98357A I2S DAC         <- 24 kHz mono PCM16
//
//  Both rates are fixed by the companion server's contract and
//  must not be changed here without changing voice.ts too.
//
//  I2S_NUM_0 records, I2S_NUM_1 plays. They are independent, so
//  playback does not have to wait for capture to be torn down.
// ============================================================
#pragma once

#include <Arduino.h>

// Recording: 16 kHz mono PCM16, the format /api/voice/stt expects.
static const uint32_t VOICE_SAMPLE_RATE   = 16000;

// Playback: 24 kHz mono PCM16, what OpenAI `response_format: pcm` returns.
static const uint32_t VOICE_PLAY_RATE     = 24000;

// Longest clip we will record. 8 s is 256 kB of PCM, which is
// about a full sentence and fits comfortably in a POST.
static const uint32_t VOICE_MAX_RECORD_MS = 8000;

// Recording ends on its own after this much silence.
static const uint32_t VOICE_SILENCE_MS    = 1200;

// Ignore anything shorter than this: a press is not an utterance.
static const uint32_t VOICE_MIN_RECORD_MS = 1200;

// Peak amplitude above which we consider the user to be speaking.
static const int16_t  VOICE_VAD_PEAK      = 600;

// ----------------------------------------------------------
//  API
// ----------------------------------------------------------

/** Start the microphone. Returns false if the I2S driver refused. */
bool voiceAudioBegin();

/** Stop the microphone and release it. Safe to call if never begun. */
void voiceAudioEnd();

/**
 * Record until silence, `maxMs`, or the user presses the talk
 * button again. Returns the clip as raw PCM16 in `outPcm`.
 *
 * Returns false if nothing usable was captured, so the caller can
 * skip the upload rather than pay for a transcription of a click.
 */
bool voiceAudioRecord(String& outPcm, uint32_t maxMs, uint32_t silenceMs, bool (*stillTalking)());

/** Open the speaker. Returns false if the I2S driver refused. */
bool voicePlaybackBegin();

/** Close the speaker. */
void voicePlaybackEnd();

/**
 * Play raw PCM16. Returns false if the user aborted playback
 * (the talk button pressed again), which the caller reports.
 */
bool voicePlaybackPcm(const uint8_t* data, size_t bytes);

/**
 * Feed one chunk of PCM16 to the speaker, without waiting for the clip to
 * finish downloading.
 *
 * This is what lets a long answer play: at 24 kHz mono a spoken sentence is
 * tens of kilobytes per second, so buffering the whole response would need
 * more memory than a WROOM has. Call it repeatedly with whatever has
 * arrived, then voicePlaybackEnd().
 */
bool voicePlaybackFeed(const uint8_t* data, size_t bytes);
