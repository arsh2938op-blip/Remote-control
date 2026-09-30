"""
ESP32 Remote Voice - STT / TTS bridge
=====================================

Tiny HTTP server that the ESP32 talks to. It converts the microphone audio
into text and the text back into speaker audio using cloud AI services.

    ESP32 --POST /stt (16kHz mono PCM)--> this server --> Whisper  --> text
    ESP32 <--GET  /tts (24kHz mono PCM)-- this server <-- TTS     <-- text

Endpoints
    GET  /health          -> {"status": "ok", ...}
    POST /stt             -> {"text": "...", "provider": "groq", "ms": 412}
    GET  /tts?text=hello  -> raw 24kHz 16-bit mono PCM (the ESP32 plays it)
    GET  /say?text=hello  -> same as /tts but also prints the transcript

Audio contract (must match esp32_remote_voice.ino)
    recording : 16000 Hz, mono, signed 16-bit little endian
    playback  : 24000 Hz, mono, signed 16-bit little endian

Run
    python -m venv .venv
    .venv\\Scripts\\activate
    pip install -r requirements.txt
    copy .env.example .env      # then edit .env with your API key
    python server.py
"""

from __future__ import annotations

import io
import os
import time
import wave
from itertools import chain
from typing import Iterator

import requests
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request

load_dotenv()

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()

# "groq" (fast + free tier) or "openai"
STT_PROVIDER = os.getenv("STT_PROVIDER", "groq" if GROQ_API_KEY else "openai").lower()
STT_MODEL = os.getenv("STT_MODEL", "").strip() or {
    "groq": "whisper-large-v3-turbo",
    "openai": "whisper-1",
}.get(STT_PROVIDER, "whisper-1")

# Speech is OpenAI only. Groq does not serve /audio/speech, so a Groq-only
# setup needs OPENAI_API_KEY too.
TTS_MODEL = os.getenv("TTS_MODEL", "tts-1")
TTS_VOICE = os.getenv("TTS_VOICE", "alloy")
TTS_SPEED = float(os.getenv("TTS_SPEED", "1.0"))

STT_TIMEOUT = float(os.getenv("STT_TIMEOUT", "30"))
TTS_TIMEOUT = float(os.getenv("TTS_TIMEOUT", "60"))

# LLM reply generated from the transcript. Set to "" for plain read-aloud.
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")
LLM_SYSTEM_PROMPT = os.getenv(
    "LLM_SYSTEM_PROMPT",
    "You are a helpful voice assistant. Answer in one or two short spoken "
    "sentences. No markdown, no lists, no emoji.",
)
USE_LLM = os.getenv("USE_LLM", "1") not in ("0", "false", "no", "")

# Returns canned answers so you can test the hardware without any API key.
DEMO_MODE = os.getenv("DEMO_MODE", "0") in ("1", "true", "yes")

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

STT_RATE = 16000      # Hz, what the ESP32 records
TTS_RATE = 24000      # Hz, what the ESP32 plays

app = Flask(__name__)


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


# --------------------------------------------------------------------------
# Speech to text
# --------------------------------------------------------------------------

def pcm_to_wav(pcm: bytes, rate: int = STT_RATE) -> bytes:
    """Wrap raw little-endian PCM16 in a WAV container."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm)
    return buf.getvalue()


def is_silent(pcm: bytes, threshold: int = 300) -> bool:
    """True when the clip is effectively digital silence.

    Whisper models hallucinate a confident but invented sentence when fed
    near-silent audio, so the firmware's voice-activity check gets a second
    pass here before we spend an API call on it.
    """
    samples = memoryview(pcm).cast("h")
    if not len(samples):
        return True
    step = max(1, len(samples) // 4000)          # sample the clip, not all of it
    peak = max(abs(samples[i]) for i in range(0, len(samples), step))
    return peak < threshold


def transcribe(pcm: bytes, rate: int = STT_RATE) -> str:
    """Send raw PCM to the speech-to-text provider and return the text."""
    wav = pcm_to_wav(pcm, rate)

    if DEMO_MODE:
        log("DEMO_MODE: not calling a real STT service")
        return os.getenv("DEMO_TRANSCRIPT", "this is a demo transcript from the server")

    if STT_PROVIDER == "groq":
        if not GROQ_API_KEY:
            raise RuntimeError("STT_PROVIDER=groq but GROQ_API_KEY is empty")
        response = requests.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            files={"file": ("speech.wav", wav, "audio/wav")},
            data={"model": STT_MODEL, "language": "en", "response_format": "json"},
            timeout=STT_TIMEOUT,
        )
    else:
        if not OPENAI_API_KEY:
            raise RuntimeError("STT_PROVIDER=openai but OPENAI_API_KEY is empty")
        response = requests.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            files={"file": ("speech.wav", wav, "audio/wav")},
            data={"model": STT_MODEL, "language": "en"},
            timeout=STT_TIMEOUT,
        )

    if response.status_code != 200:
        raise RuntimeError(f"STT HTTP {response.status_code}: {response.text[:400]}")

    return (response.json().get("text") or "").strip()


# --------------------------------------------------------------------------
# Optional: turn the transcript into an answer
# --------------------------------------------------------------------------

def ask_llm(text: str) -> str:
    """Answer the transcript. Returns the transcript itself on failure."""
    if not USE_LLM or not OPENAI_API_KEY:
        return text

    try:
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            json={
                "model": LLM_MODEL,
                "messages": [
                    {"role": "system", "content": LLM_SYSTEM_PROMPT},
                    {"role": "user", "content": text},
                ],
                "max_tokens": 160,
            },
            timeout=STT_TIMEOUT,
        )
        if response.status_code == 200:
            return response.json()["choices"][0]["message"]["content"].strip()
        log(f"LLM HTTP {response.status_code}: {response.text[:200]}")
    except requests.RequestException as exc:
        log(f"LLM failed: {exc}")
    return text


# --------------------------------------------------------------------------
# Text to speech
# --------------------------------------------------------------------------

def _speech_api() -> tuple[str, str]:
    """Resolve (base_url, key) eagerly, so config errors surface at once.

    TTS is OpenAI only - Groq has no speech endpoint, so falling back to it
    would just produce a confusing 404 from the API.
    """
    if not OPENAI_API_KEY:
        raise RuntimeError(
            "TTS needs OPENAI_API_KEY. Groq handles speech-to-text only, "
            "so it cannot be used for /tts."
        )
    return "https://api.openai.com/v1", OPENAI_API_KEY


def stream_openai_pcm(text: str, base: str, key: str) -> Iterator[bytes]:
    """Call the speech API and stream raw 24 kHz mono PCM16."""
    with requests.post(
        f"{base}/audio/speech",
        headers={"Authorization": f"Bearer {key}"},
        json={
            "model": TTS_MODEL,
            "voice": TTS_VOICE,
            "input": text,
            "response_format": "pcm",   # 24 kHz signed 16-bit little endian
            "speed": TTS_SPEED,
        },
        stream=True,
        timeout=TTS_TIMEOUT,
    ) as response:
        if response.status_code != 200:
            raise RuntimeError(f"TTS HTTP {response.status_code}: {response.text[:400]}")

        for chunk in response.iter_content(chunk_size=4096):
            if chunk:
                yield chunk


def synth_pcm(text: str) -> Iterator[bytes]:
    """Return an iterator of raw PCM16 chunks, whatever the mode.

    The first chunk is fetched here on purpose. Once the HTTP 200 headers
    are sent we can no longer change the status code, so a failed TTS call
    would reach the ESP32 as a 200 with no audio and play back as noise.
    """
    if DEMO_MODE:
        # 1.5 s of silence, comfortably over the 1 s minimum for /stt
        return iter([b"\x00\x00" * (TTS_RATE * 3 // 2)])

    base, key = _speech_api()
    stream = stream_openai_pcm(text, base, key)
    first = next(stream, b"")            # raises here if the request failed
    return chain([first], stream)


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

@app.get("/health")
def health():
    return jsonify(
        status="ok",
        stt_provider=STT_PROVIDER,
        stt_model=STT_MODEL,
        tts_model=TTS_MODEL,
        tts_voice=TTS_VOICE,
        llm=USE_LLM,
        demo=DEMO_MODE,
    )


@app.post("/stt")
def stt():
    pcm = request.get_data(cache=False)
    rate = int(request.args.get("rate", STT_RATE))   # ESP32 sends 16000

    if len(pcm) < rate * 2:                         # need >= 1 s of audio
        return jsonify(error=f"too little audio ({len(pcm) // 2} samples)"), 400

    if is_silent(pcm):
        log(f"silence only ({len(pcm) // 2} samples), skipping the API call")
        return jsonify(error="silence, nothing to transcribe"), 422

    started = time.perf_counter()
    try:
        text = transcribe(pcm, rate)
    except Exception as exc:                       # noqa: BLE001
        log(f"STT error: {exc}")
        return jsonify(error=str(exc)), 502

    if not text:
        log(f"nothing recognised ({len(pcm) // 2} samples)")
        return jsonify(error="no speech recognised"), 422

    elapsed = int((time.perf_counter() - started) * 1000)
    log(f"STT {elapsed} ms: {text!r}")

    try:
        reply = ask_llm(text)
    except Exception as exc:                       # noqa: BLE001
        log(f"LLM error: {exc}")
        reply = text

    return jsonify(text=text, reply=reply, provider=STT_PROVIDER, ms=elapsed)


@app.get("/tts")
def tts():
    text = (request.args.get("text") or "").strip()
    if not text:
        return Response("missing ?text=", status=400, mimetype="text/plain")
    if len(text) > 2000:
        text = text[:2000]

    try:
        stream = synth_pcm(text)
    except Exception as exc:                       # noqa: BLE001
        log(f"TTS error: {exc}")
        return Response(str(exc), status=502, mimetype="text/plain")

    log(f"TTS: {text!r}")
    # no mimetype= on purpose: it would overwrite our audio/pcm Content-Type
    return Response(
        stream,
        headers={
            "Content-Type": f"audio/pcm;srate={TTS_RATE};channels=1;bits=16",
            "X-Sample-Rate": str(TTS_RATE),
        },
    )


@app.get("/say")
def say():
    """Same audio as /tts, but the text also lands in the server console."""
    return tts()


# --------------------------------------------------------------------------

if __name__ == "__main__":
    log(f"STT : {STT_PROVIDER}/{STT_MODEL}")
    log(f"TTS : {TTS_MODEL} voice={TTS_VOICE}")
    log(f"LLM : {LLM_MODEL if USE_LLM else 'off'}")
    if DEMO_MODE:
        log("DEMO_MODE is on - no API calls will be made")
    if not DEMO_MODE:
        if not (GROQ_API_KEY or OPENAI_API_KEY):
            log("WARNING: no API key found. Copy .env.example to .env and add one.")
        if not OPENAI_API_KEY:
            log("WARNING: OPENAI_API_KEY is empty, so /tts and the LLM will fail. "
                "GROQ_API_KEY alone only covers speech-to-text.")
        if STT_PROVIDER == "groq" and not GROQ_API_KEY:
            log("WARNING: STT_PROVIDER=groq but GROQ_API_KEY is empty.")

    log(f"listening on http://{HOST}:{PORT}")
    app.run(host=HOST, port=PORT, threaded=True)
