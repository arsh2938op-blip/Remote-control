"""
Self test for server.py - no ESP32 required.

Two modes:

  full round trip (needs OPENAI_API_KEY)
      python test_client.py
      python test_client.py "what is the weather in Delhi"
    -> GET /tts to synthesise audio, save it as test_tts.wav, then POST it
       back to /stt and print the transcript.

  transcription only (a Groq key is enough)
      python test_client.py --stt-only my_voice.wav
    -> POST a 16-bit mono WAV to /stt and print the transcript. Useful for
       checking the microphone path before the speaker is wired up.
"""

import argparse
import sys
import wave

import requests

BASE = "http://127.0.0.1:8000"
TTS_RATE = 24000


def read_wav(path: str) -> tuple[bytes, int]:
    """Return (raw PCM16, sample rate) from a WAV file."""
    with wave.open(path, "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise SystemExit(
                f"{path}: need 16-bit mono, got {wav.getsampwidth() * 8}-bit "
                f"{wav.getnchannels()} channel(s)"
            )
        return wav.readframes(wav.getnframes()), wav.getframerate()


def post_stt(pcm: bytes, rate: int) -> int:
    result = requests.post(
        f"{BASE}/stt",
        params={"rate": rate},
        data=pcm,
        headers={"Content-Type": f"audio/pcm;rate={rate};channels=1;bits=16"},
        timeout=90,
    )
    if result.status_code != 200:
        print(f"     FAILED: HTTP {result.status_code} {result.text[:300]}")
        return 1

    body = result.json()
    print(f'     transcript : "{body["text"]}"')
    print(f'     reply      : "{body.get("reply", "-")}"')
    print(f'     provider   : {body.get("provider")}  in {body.get("ms")} ms')
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Test the ESP32 voice server.")
    parser.add_argument("--stt-only", metavar="WAV",
                        help="transcribe this WAV instead of the full round trip")
    parser.add_argument("text", nargs="*", help="phrase to synthesise")
    args = parser.parse_args()

    if args.stt_only:
        pcm, rate = read_wav(args.stt_only)
        print(f"POST {BASE}/stt  ({len(pcm) // 2} samples @ {rate} Hz)")
        return post_stt(pcm, rate)

    phrase = " ".join(args.text) or "Hello, this is a test of the voice system."

    print(f"GET  {BASE}/health")
    health = requests.get(f"{BASE}/health", timeout=10)
    health.raise_for_status()
    print(f"     {health.json()}\n")

    print(f'GET  /tts?text="{phrase}"')
    audio = requests.get(f"{BASE}/tts", params={"text": phrase}, timeout=90)
    if audio.status_code != 200:
        print(f"     FAILED: HTTP {audio.status_code} {audio.text[:300]}")
        return 1
    pcm = audio.content
    print(f"     got {len(pcm)} bytes = {len(pcm) / 2 / TTS_RATE:.1f} s of audio\n")

    with wave.open("test_tts.wav", "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(TTS_RATE)
        wav.writeframes(pcm)
    print("     saved test_tts.wav - play it to check the speaker path\n")

    print("POST /stt")
    return post_stt(pcm, TTS_RATE)


if __name__ == "__main__":
    raise SystemExit(main())
