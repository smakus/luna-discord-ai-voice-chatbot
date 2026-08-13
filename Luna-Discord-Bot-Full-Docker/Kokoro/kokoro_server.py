#!/usr/bin/env python3
"""
Kokoro TTS server — OpenAI-compatible /v1/audio/speech endpoint

Setup:
  source ~/kokoro-env/bin/activate
  pip install kokoro>=0.9.4 soundfile fastapi uvicorn
  apt-get install espeak-ng  # or: brew install espeak-ng
Run: python3 kokoro_server.py

Environment:
  KOKORO_VOICE            default voice (af_heart)
  KOKORO_THREADS          torch intra-op threads (default 2)
  KOKORO_MAX_CONCURRENCY  simultaneous syntheses (default 2)
"""
import asyncio
import io
import os
import queue
import struct
import threading

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from kokoro import KPipeline
from pydantic import BaseModel

# ── CPU budget ────────────────────────────────────────────────────────────────
#
# torch defaults to one thread per core. On a machine also running an LLM, a
# Whisper server and the bot itself, that means every TTS request briefly tries
# to own the whole CPU — and because TTS is prefetched (sentence N+1 renders
# while N plays) this collides with the LLM still generating sentence N+2.
# Capping here costs a little single-request latency and buys a lot of
# system-wide predictability.
#
# Set before any inference runs; torch ignores later changes in some builds.
torch.set_num_threads(int(os.getenv("KOKORO_THREADS", "2")))
try:
    torch.set_num_interop_threads(1)
except RuntimeError:
    pass  # already initialised; harmless

app = FastAPI()

# 'a' = American English, 'b' = British English
pipeline = KPipeline(lang_code='a')

# Good female voices to try:
# af_bella, af_sarah, af_sky, af_nicole, af_heart
DEFAULT_VOICE = os.getenv("KOKORO_VOICE", "af_heart")

SAMPLE_RATE = 24000

# Bounds how many syntheses run at once. Without it, N speakers each prefetching
# sentence N+1 can put an unbounded number of torch graphs in flight, and every
# one of them gets slower — including the sentence that is about to play.
MAX_CONCURRENCY = int(os.getenv("KOKORO_MAX_CONCURRENCY", "2"))
_sem = asyncio.Semaphore(MAX_CONCURRENCY)


class TTSRequest(BaseModel):
    input: str
    voice: str = DEFAULT_VOICE
    speed: float = 1.0
    stream: bool = False


def make_wav_header(sample_rate: int, num_channels: int = 1, bits_per_sample: int = 16) -> bytes:
    """
    Build a WAV header with an unknown data size (0xFFFFFFFF).
    This is the standard trick for streaming WAV — players start decoding
    immediately without needing to know the total file size up front.
    """
    byte_rate    = sample_rate * num_channels * bits_per_sample // 8
    block_align  = num_channels * bits_per_sample // 8
    # Use max uint32 for sizes since we don't know them yet
    data_size    = 0xFFFFFFFF
    riff_size    = 0xFFFFFFFF

    header = struct.pack('<4sI4s', b'RIFF', riff_size, b'WAVE')
    fmt    = struct.pack('<4sIHHIIHH',
        b'fmt ', 16,            # chunk size
        1,                      # PCM format
        num_channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
    )
    data   = struct.pack('<4sI', b'data', data_size)
    return header + fmt + data


def pcm_chunk(audio) -> bytes:
    """Convert float32 Tensor or numpy array to int16 PCM bytes."""
    if isinstance(audio, torch.Tensor):
        audio = audio.detach().cpu().numpy()
    clipped = np.clip(audio, -1.0, 1.0)
    return (clipped * 32767).astype(np.int16).tobytes()


_SENTINEL = object()


def _synthesize_into(q, text: str, voice: str, speed: float) -> None:
    """
    Runs the Kokoro generator on a worker thread, pushing PCM chunks onto `q`.

    This exists because `pipeline(...)` is a SYNCHRONOUS generator doing torch
    inference. Iterating it inside an `async def` — as this server previously
    did — runs that inference *on the event loop*. For the duration of every
    synthesis the server accepts no connections, streams no other response and
    answers no health check. The client's prefetch pipeline therefore did not
    actually overlap: sentence N+1 could not start until N finished, and a
    second speaker's request waited behind both.
    """
    try:
        for _, _, audio in pipeline(text, voice=voice, speed=speed):
            if audio is not None:
                q.put(pcm_chunk(audio))
    except Exception as exc:                      # noqa: BLE001 — forwarded to caller
        q.put(exc)
    finally:
        q.put(_SENTINEL)


async def stream_audio(input_text: str, voice: str, speed: float):
    """
    Async generator: WAV header, then PCM chunks as the worker thread produces
    them. The event loop stays free between chunks.
    """
    async with _sem:
        yield make_wav_header(SAMPLE_RATE)

        # maxsize applies backpressure: if Discord playback is slower than
        # synthesis, the worker parks instead of buffering a whole utterance.
        q = queue.Queue(maxsize=8)
        loop = asyncio.get_running_loop()

        worker = threading.Thread(
            target=_synthesize_into,
            args=(q, input_text, voice, speed),
            daemon=True,
        )
        worker.start()

        try:
            while True:
                item = await loop.run_in_executor(None, q.get)
                if item is _SENTINEL:
                    break
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            # Drain, so a client that disconnects mid-sentence cannot leave the
            # worker blocked forever on a full queue.
            while worker.is_alive():
                try:
                    if q.get(timeout=0.1) is _SENTINEL:
                        break
                except queue.Empty:
                    pass


@app.post("/v1/audio/speech")
async def text_to_speech(req: TTSRequest):
    if not req.input or not req.input.strip():
        raise HTTPException(status_code=400, detail="input is empty")

    # ── Streaming mode ────────────────────────────────────────────────────────
    # Returns WAV header + PCM chunks as they're generated.
    # Node.js receives and plays audio before generation is complete,
    # eliminating the wait-for-full-audio latency.
    if req.stream:
        return StreamingResponse(
            stream_audio(req.input, req.voice, req.speed),
            media_type="audio/wav",
        )

    # ── Non-streaming mode (original behaviour) ───────────────────────────────
    def _render():
        chunks = [a for _, _, a in pipeline(req.input, voice=req.voice, speed=req.speed)
                  if a is not None]
        if not chunks:
            return None
        buf = io.BytesIO()
        sf.write(buf, np.concatenate(chunks), SAMPLE_RATE, format='WAV')
        return buf.getvalue()

    try:
        # Off the event loop, for the same reason as the streaming path.
        async with _sem:
            data = await asyncio.to_thread(_render)
    except Exception as exc:                      # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))

    if data is None:
        raise HTTPException(status_code=500, detail="No audio generated")
    return Response(content=data, media_type="audio/wav")


@app.get("/health")
def health():
    return {"status": "ok", "voice": DEFAULT_VOICE}


def warmup() -> None:
    """
    Render one short phrase at import time.

    The Dockerfile pre-downloads the model, but the first *inference* still pays
    lazy weight materialisation, allocator warm-up and espeak-ng dictionary
    load — on the order of a second or two. Paying it here means the container
    is not reported healthy until it can actually answer fast, so the first
    thing a user says is not also the slowest thing Luna ever says.
    """
    try:
        for _ in pipeline("Ready.", voice=DEFAULT_VOICE, speed=1.0):
            pass
        print(f"[kokoro] warm — threads={torch.get_num_threads()}, "
              f"concurrency={MAX_CONCURRENCY}, voice={DEFAULT_VOICE}", flush=True)
    except Exception as exc:                      # noqa: BLE001
        print(f"[kokoro] warmup failed (continuing): {exc}", flush=True)


warmup()


if __name__ == "__main__":
    import uvicorn
    print("Starting Kokoro TTS server on http://localhost:8880")
    print(f"Default voice: {DEFAULT_VOICE}")
    uvicorn.run(app, host="0.0.0.0", port=8880)
