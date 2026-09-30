"""
End-to-end check of the voice endpoints, as the ESP32-WROOM remote uses them.

Talks to a running companion server the same way the firmware does:
  1. GET  /api/voice/capabilities   - what can the server do?
  2. POST /api/voice/stt?rate=...    - raw PCM16 in, {text, reply} out
  3. GET  /api/voice/tts?text=...    - 24 kHz mono PCM16 back
  4. error cases: silence, short clip, missing text, bad token

Usage
    python voice_client.py                       # synthesise speech, then test
    python voice_client.py my_clip.wav           # use a real recording
    python voice_client.py --stt-only my.wav     # skip the TTS step
"""

import argparse
import os
import struct
import sys
import wave

import requests

BASE = os.getenv("WALLE_BASE", "http://127.0.0.1:8787")
TOKEN = os.getenv("WALLE_VOICE_TOKEN", "")

FAILURES = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global FAILURES
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f" - {detail}" if detail else ""))
    if not ok:
        FAILURES += 1


def auth() -> dict:
    return {"x-walle-voice-token": TOKEN} if TOKEN else {}


def synth_speech(text: str) -> tuple[bytes, int]:
    """Render text to 16 kHz mono PCM16 with the Windows voice."""
    import tempfile
    import subprocess

    ps = (
        "Add-Type -AssemblyName System.Speech;"
        "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$s.Rate=0;"
        f"$s.SetOutputToWaveFile('{os.path.join(tempfile.gettempdir(), 'vc.wav')}');"
        f"$s.Speak('{text}');"
        "$s.SetOutputToNull()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True, capture_output=True)

    with wave.open(os.path.join(tempfile.gettempdir(), "vc.wav"), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise SystemExit("expected 16-bit mono from System.Speech")
        return wav.readframes(wav.getnframes()), wav.getframerate()


def load_wav(path: str) -> tuple[bytes, int]:
    with wave.open(path, "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise SystemExit(f"{path}: need 16-bit mono")
        return wav.readframes(wav.getnframes()), wav.getframerate()


def main() -> int:
    ap = argparse.ArgumentParser(description="Exercise the WALL-E voice endpoints.")
    ap.add_argument("wav", nargs="?", help="16-bit mono WAV to transcribe")
    ap.add_argument("--stt-only", action="store_true", help="skip the TTS step")
    ap.add_argument("--text", default="What is your name", help="phrase to synthesise")
    args = ap.parse_args()

    # ---- 1. capabilities ----
    print("1. capabilities")
    try:
        caps = requests.get(f"{BASE}/api/voice/capabilities", headers=auth(), timeout=10)
        caps.raise_for_status()
        body = caps.json()
        check("reachable", True, f"stt={body['stt']['provider']} sttReady={body['stt']['available']} "
                                 f"ttsReady={body['tts']['available']}")
        check("stt rate is 16000", body["sttSampleRate"] == 16000, str(body["sttSampleRate"]))
        check("tts rate is 24000", body["ttsSampleRate"] == 24000, str(body["ttsSampleRate"]))
    except requests.RequestException as exc:
        print(f"  [FAIL] server not reachable at {BASE} - {exc}")
        print("  start it with: npm start")
        return 1

    # ---- 2. transcribe ----
    print("\n2. POST /api/voice/stt")
    if args.wav:
        pcm, rate = load_wav(args.wav)
        source = args.wav
    else:
        pcm, rate = synth_speech(args.text)
        source = f"synthesised: {args.text!r}"
    print(f"     {source} -> {len(pcm) // 2} samples @ {rate} Hz")

    stt = requests.post(
        f"{BASE}/api/voice/stt?rate={rate}",
        data=pcm,
        headers={**auth(), "Content-Type": f"audio/pcm;rate={rate};channels=1;bits=16"},
        timeout=60,
    )
    if stt.status_code == 200:
        body = stt.json()
        print(f"     transcript: {body['text']!r}")
        print(f"     reply    : {body['reply']!r}")
        print(f"     provider : {body['provider']} in {body['ms']} ms")
        check("transcribed something", len(body["text"].strip()) > 1, repr(body["text"]))
        check("got a reply to speak", len(body["reply"].strip()) > 0)
    else:
        check("STT succeeded", False, f"HTTP {stt.status_code}: {stt.text[:200]}")
        return 1

    # ---- 3. error cases ----
    print("\n3. error handling")
    silence = requests.post(
        f"{BASE}/api/voice/stt?rate=16000",
        data=bytes(16000 * 2),
        headers={**auth(), "Content-Type": "audio/pcm"},
        timeout=30,
    )
    check("silence rejected with 422", silence.status_code == 422, f"got {silence.status_code}")

    tiny = requests.post(
        f"{BASE}/api/voice/stt?rate=16000",
        data=bytes(1000),
        headers={**auth(), "Content-Type": "audio/pcm"},
        timeout=30,
    )
    check("short clip rejected with 400", tiny.status_code == 400, f"got {tiny.status_code}")

    notext = requests.get(f"{BASE}/api/voice/tts", headers=auth(), timeout=30)
    check("missing text rejected with 400", notext.status_code == 400, f"got {notext.status_code}")

    if TOKEN:
        bad = requests.get(f"{BASE}/api/voice/tts?text=hi", headers={"x-walle-voice-token": "wrong"}, timeout=30)
        check("bad token rejected with 401", bad.status_code == 401, f"got {bad.status_code}")

    # ---- 4. speech ----
    if args.stt_only:
        print("\n4. skipped (--stt-only)")
    else:
        print("\n4. GET /api/voice/tts")
        tts = requests.get(f"{BASE}/api/voice/tts", params={"text": stt.json()["reply"]},
                           headers=auth(), timeout=90)
        if tts.status_code == 200:
            audio = tts.content
            seconds = len(audio) / 2 / 24000
            print(f"     got {len(audio)} bytes = {seconds:.1f} s of 24 kHz audio")
            check("synth type is pcm", "audio/pcm" in tts.headers.get("Content-Type", ""),
                  tts.headers.get("Content-Type", ""))
            check("length is a whole number of samples", len(audio) % 2 == 0, f"{len(audio)} bytes")
            check("audio is a sane length", 0.2 < seconds < 30, f"{seconds:.1f}s")
            with wave.open("test_voice.wav", "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(24000)
                wav.writeframes(audio)
            print("     saved test_voice.wav - play it to check the speaker path")
        else:
            check("TTS succeeded", False, f"HTTP {tts.status_code}: {tts.text[:200]}")

    print()
    if FAILURES:
        print(f"{FAILURES} check(s) FAILED")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
