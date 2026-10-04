#!/usr/bin/env python3
"""
VibeVoice-Realtime TTS server — the same /v1/audio/speech API as
Kokoro/kokoro_server.py, so Luna talks to both the same way.

Runs Microsoft's VibeVoice-Realtime-0.5B through mlx-audio on Apple Silicon
(MLX, i.e. Metal). macOS only; start it with scripts/vibevoice-metal.sh.

Environment:
  VIBEVOICE_MODEL_DIR   local model folder (with voices/*.safetensors) — required
  VIBEVOICE_VOICE       default voice (en-Clarissa_woman)
  VIBEVOICE_PORT        port (8890)
  VIBEVOICE_CFG_SCALE   classifier-free guidance (1.5, mlx-audio's default)
"""
import asyncio
import io
import os
import queue
import struct
import threading
import time

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

MODEL_DIR = os.environ['VIBEVOICE_MODEL_DIR']
VOICES_DIR = os.path.join(MODEL_DIR, 'voices')
DEFAULT_VOICE = os.getenv('VIBEVOICE_VOICE', 'en-Clarissa_woman')
PORT = int(os.getenv('VIBEVOICE_PORT', '8890'))
CFG_SCALE = float(os.getenv('VIBEVOICE_CFG_SCALE', '1.5'))

SAMPLE_RATE = 24000
# How much audio mlx-audio renders before handing over a chunk. Smaller means
# Luna starts talking sooner; 0.5 s gave ~0.15 s to first audio in testing.
STREAMING_INTERVAL = 0.5
# The model opens every utterance with ~0.4 s of near-silence (rms ~0.001).
# Leading audio quieter than this is dropped, keeping LEAD_IN_S before speech.
SILENCE_PEAK = 0.02
LEAD_IN_S = 0.05

app = FastAPI()


def voice_names() -> list:
    return sorted(f[:-len('.safetensors')] for f in os.listdir(VOICES_DIR)
                  if f.endswith('.safetensors'))


class TTSRequest(BaseModel):
    input: str
    voice: str = DEFAULT_VOICE
    speed: float = 1.0      # accepted for Kokoro compatibility; VibeVoice has no speed control
    stream: bool = False


def make_wav_header(sample_rate: int, num_channels: int = 1, bits_per_sample: int = 16) -> bytes:
    """WAV header with unknown (max) sizes, so players decode while it streams."""
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    header = struct.pack('<4sI4s', b'RIFF', 0xFFFFFFFF, b'WAVE')
    fmt = struct.pack('<4sIHHIIHH', b'fmt ', 16, 1, num_channels, sample_rate,
                      byte_rate, block_align, bits_per_sample)
    return header + fmt + struct.pack('<4sI', b'data', 0xFFFFFFFF)


def pcm_chunk(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16).tobytes()


# ── The MLX worker ───────────────────────────────────────────────────────────
#
# One model, one thread. MLX inference is not safe to run concurrently on one
# model, and MLX also ties its GPU streams to the thread that created them, so
# every load and synthesis runs on this single long-lived thread. Requests
# queue up and are rendered one at a time; Luna's prefetch (sentence N+1 while
# N plays) still overlaps, because rendering is ~5x faster than real time.

_SENTINEL = object()
_jobs: queue.Queue = queue.Queue()
_ready = threading.Event()
_load_error = []


class _Job:
    def __init__(self, text: str, voice: str):
        self.text = text
        self.voice = voice
        self.out: queue.Queue = queue.Queue(maxsize=16)
        self.cancel = threading.Event()

    def put(self, item) -> bool:
        """Blocking put that gives up once the client has gone away."""
        while not self.cancel.is_set():
            try:
                self.out.put(item, timeout=0.1)
                return True
            except queue.Full:
                pass
        return False


def _render(model, job: _Job) -> None:
    """Streams float32 chunks of one utterance onto job.out, minus the lead-in silence."""
    started = False
    for result in model.generate(job.text, voice=job.voice, cfg_scale=CFG_SCALE,
                                 stream=True, streaming_interval=STREAMING_INTERVAL):
        if job.cancel.is_set():
            return
        audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
        if not started:
            loud = np.flatnonzero(np.abs(audio) >= SILENCE_PEAK)
            if loud.size == 0:
                continue
            audio = audio[max(0, loud[0] - int(LEAD_IN_S * SAMPLE_RATE)):]
            started = True
        if not job.put(audio):
            return


def _worker() -> None:
    try:
        from mlx_audio.tts.utils import load_model
        t0 = time.time()
        model = load_model(MODEL_DIR)
        # Warm-up: the first synthesis pays kernel compilation and voice load.
        for _ in model.generate('Ready.', voice=DEFAULT_VOICE, cfg_scale=CFG_SCALE):
            pass
        print(f'[vibevoice] warm in {time.time() - t0:.1f}s — voice={DEFAULT_VOICE}, '
              f'voices: {", ".join(voice_names())}', flush=True)
    except Exception as exc:                      # noqa: BLE001 — reported by /health
        _load_error.append(exc)
        print(f'[vibevoice] failed to load: {exc}', flush=True)
        _ready.set()
        return
    _ready.set()

    while True:
        job = _jobs.get()
        if job.cancel.is_set():
            continue
        try:
            _render(model, job)
        except Exception as exc:                  # noqa: BLE001 — forwarded to caller
            job.put(exc)
        finally:
            if not job.put(_SENTINEL):
                try:
                    job.out.put_nowait(_SENTINEL)
                except queue.Full:
                    pass


async def _chunks(job: _Job):
    """Yields the job's float32 chunks without blocking the event loop."""
    loop = asyncio.get_running_loop()
    _jobs.put(job)
    try:
        while True:
            item = await loop.run_in_executor(None, job.out.get)
            if item is _SENTINEL:
                return
            if isinstance(item, Exception):
                raise item
            yield item
    finally:
        # Client gone (barge-in, timeout) or done: stop rendering at the next chunk.
        job.cancel.set()


def _check(req: TTSRequest) -> None:
    if _load_error:
        raise HTTPException(status_code=503, detail=f'model failed to load: {_load_error[0]}')
    if not req.input or not req.input.strip():
        raise HTTPException(status_code=400, detail='input is empty')
    # Only names of installed voices: the name becomes part of a file path.
    if req.voice not in voice_names():
        raise HTTPException(status_code=400,
                            detail=f'unknown voice {req.voice!r}; installed: {", ".join(voice_names())}')


@app.post('/v1/audio/speech')
async def text_to_speech(req: TTSRequest):
    _check(req)
    job = _Job(req.input.strip(), req.voice)

    if req.stream:
        async def stream():
            yield make_wav_header(SAMPLE_RATE)
            async for audio in _chunks(job):
                yield pcm_chunk(audio)
        return StreamingResponse(stream(), media_type='audio/wav')

    try:
        parts = [audio async for audio in _chunks(job)]
    except Exception as exc:                      # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
    if not parts:
        raise HTTPException(status_code=500, detail='No audio generated')
    buf = io.BytesIO()
    sf.write(buf, np.concatenate(parts), SAMPLE_RATE, format='WAV')
    return Response(content=buf.getvalue(), media_type='audio/wav')


@app.get('/health')
def health():
    if _load_error:
        raise HTTPException(status_code=503, detail=str(_load_error[0]))
    return {'status': 'ok', 'voice': DEFAULT_VOICE, 'voices': voice_names()}


if __name__ == '__main__':
    import uvicorn
    if DEFAULT_VOICE not in voice_names():
        raise SystemExit(f'VIBEVOICE_VOICE={DEFAULT_VOICE} is not installed in {VOICES_DIR}; '
                         f'installed: {", ".join(voice_names())}')
    threading.Thread(target=_worker, daemon=True, name='mlx').start()
    _ready.wait()       # load + warm up before accepting requests, like Kokoro
    if _load_error:
        raise SystemExit(1)
    print(f'Starting VibeVoice TTS server on http://localhost:{PORT}', flush=True)
    uvicorn.run(app, host='0.0.0.0', port=PORT)
