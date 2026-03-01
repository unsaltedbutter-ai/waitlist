"""
TTS Service: Kokoro-82M text-to-speech via MLX on Apple Silicon.

FastAPI server on port 8424. Receives text, synthesizes speech using
Kokoro-82M, returns MP3 bytes.

Pipeline:
  1. Text chunked at sentence boundaries (target ~250 tokens/chunk)
  2. Each chunk synthesized via Kokoro (24kHz 16-bit mono WAV)
  3. Chunks stitched into a single WAV
  4. WAV encoded to MP3 via ffmpeg (bitrate configurable, default 64k CBR)
  5. MP3 bytes returned in response
"""

from __future__ import annotations

import io
import logging
import os
import struct
import subprocess
import tempfile
import time
import wave
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

log = logging.getLogger(__name__)

app = FastAPI(title="UnsaltedButter TTS Service", version="0.1.0")

# Lazy-loaded model
_pipeline = None
_voices: dict[str, object] = {}

SAMPLE_RATE = 24000
ALLOWED_VOICES: list[str] = []
DEFAULT_VOICE = "af_heart"


def _get_allowed_voices() -> list[str]:
    """Parse AUDIO_TTS_VOICES env var."""
    raw = os.environ.get("AUDIO_TTS_VOICES", "af_heart,am_adam")
    return [v.strip() for v in raw.split(",") if v.strip()]


def _get_pipeline():
    """Lazy-load the Kokoro model. First call takes ~5s."""
    global _pipeline, ALLOWED_VOICES, DEFAULT_VOICE

    if _pipeline is not None:
        return _pipeline

    log.info("Loading Kokoro model...")
    start = time.monotonic()

    try:
        from kokoro import KPipeline

        lang_code = "a"  # American English
        _pipeline = KPipeline(lang_code=lang_code)
    except ImportError:
        log.error(
            "kokoro package not installed. Install with: pip install kokoro"
        )
        raise

    elapsed = time.monotonic() - start
    log.info("Kokoro model loaded in %.1fs", elapsed)

    ALLOWED_VOICES = _get_allowed_voices()
    DEFAULT_VOICE = os.environ.get("AUDIO_TTS_DEFAULT_VOICE", "af_heart").strip()

    return _pipeline


class TTSRequest(BaseModel):
    text: str
    voice: str = "af_heart"
    speed: float = 1.0


@app.post("/v1/tts")
async def synthesize(req: TTSRequest) -> Response:
    """Synthesize text to MP3 audio."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Empty text")

    allowed = _get_allowed_voices()
    if req.voice not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Voice '{req.voice}' not allowed. Available: {allowed}",
        )

    if req.speed < 0.5 or req.speed > 2.0:
        raise HTTPException(status_code=400, detail="Speed must be between 0.5 and 2.0")

    start = time.monotonic()
    pipeline = _get_pipeline()

    # Kokoro's generate() handles chunking internally and yields
    # (graphemes, phonemes, audio_chunk) tuples
    all_audio = []
    try:
        for _gs, _ps, audio in pipeline(req.text, voice=req.voice, speed=req.speed):
            all_audio.append(audio)
    except Exception:
        log.exception("Kokoro synthesis failed")
        raise HTTPException(status_code=500, detail="TTS synthesis failed")

    if not all_audio:
        raise HTTPException(status_code=500, detail="No audio generated")

    # Concatenate audio chunks (numpy arrays)
    import numpy as np
    combined = np.concatenate(all_audio)

    synth_elapsed = time.monotonic() - start
    duration_seconds = len(combined) / SAMPLE_RATE

    log.info(
        "Synthesized %.1fs audio in %.1fs (%.1fx realtime), voice=%s",
        duration_seconds, synth_elapsed,
        duration_seconds / synth_elapsed if synth_elapsed > 0 else 0,
        req.voice,
    )

    # Convert to WAV bytes
    wav_bytes = _numpy_to_wav(combined)

    # Encode to MP3 via ffmpeg
    mp3_bytes = _wav_to_mp3(wav_bytes)

    return Response(
        content=mp3_bytes,
        media_type="audio/mpeg",
        headers={
            "X-Audio-Duration": str(int(duration_seconds)),
            "X-Synth-Time": f"{synth_elapsed:.1f}",
        },
    )


@app.get("/health")
async def health():
    """Liveness check."""
    model_loaded = _pipeline is not None
    return {
        "ok": True,
        "model_loaded": model_loaded,
        "voices": _get_allowed_voices(),
        "default_voice": os.environ.get("AUDIO_TTS_DEFAULT_VOICE", "af_heart"),
        "mp3_bitrate": _get_mp3_bitrate(),
    }


def _numpy_to_wav(audio: "np.ndarray") -> bytes:
    """Convert float32 numpy audio to 16-bit WAV bytes."""
    import numpy as np

    # Clip and convert to int16
    audio_int16 = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(audio_int16.tobytes())

    return buf.getvalue()


def _get_mp3_bitrate() -> str:
    """Get MP3 bitrate from env. Default 64k (CBR, optimal for mono speech)."""
    return os.environ.get("AUDIO_MP3_BITRATE", "64k").strip()


def _wav_to_mp3(wav_bytes: bytes) -> bytes:
    """Encode WAV to MP3 via ffmpeg (CBR, bitrate from AUDIO_MP3_BITRATE)."""
    bitrate = _get_mp3_bitrate()
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f", "wav",
            "-i", "pipe:0",
            "-codec:a", "libmp3lame",
            "-b:a", bitrate,
            "-f", "mp3",
            "pipe:1",
        ],
        input=wav_bytes,
        capture_output=True,
        timeout=300,
    )

    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace")[-500:]
        log.error("ffmpeg failed: %s", stderr)
        raise RuntimeError(f"ffmpeg encoding failed: {stderr}")

    return result.stdout


def main() -> None:
    """Entry point: load env, start uvicorn."""
    import uvicorn

    ub_dir = Path.home() / ".unsaltedbutter"
    shared_env = ub_dir / "shared.env"
    component_env = ub_dir / "tts.env"
    if shared_env.exists():
        load_dotenv(str(shared_env))
    if component_env.exists():
        load_dotenv(str(component_env), override=True)

    log_level = os.environ.get("LOG_LEVEL", "INFO").strip().lower()
    logging.basicConfig(
        level=getattr(logging, log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    port = int(os.environ.get("TTS_PORT", "8424"))
    host = os.environ.get("TTS_HOST", "0.0.0.0")

    uvicorn.run(app, host=host, port=port, log_level=log_level)


if __name__ == "__main__":
    main()
