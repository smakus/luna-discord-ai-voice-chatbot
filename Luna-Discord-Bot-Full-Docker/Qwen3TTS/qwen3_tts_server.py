#!/usr/bin/env python3
"""
Qwen3-TTS server — the same /v1/audio/speech API as Kokoro/kokoro_server.py,
so Luna talks to both the same way.

Speaks in a cloned voice: Qwen3-TTS's Base model copies the voice in a short
reference clip. A voice is a pair of files in the voices folder:

    <name>.wav   ~5-15 s of clear speech
    <name>.txt   exactly what is said in it

design_voice.py creates such a pair from a written description. Runs on Apple
Silicon through MLX; start it with scripts/qwen3-tts-metal.sh.

Environment:
  QWEN3_TTS_VOICES_DIR    folder with <name>.wav + <name>.txt — required
  QWEN3_TTS_VOICE         default voice (luna)
  QWEN3_TTS_MODEL         mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit; the
                          1.7B Base model clones more closely but is slower
  QWEN3_TTS_TEMPERATURE   sampling temperature (0.6; lower stays closer to
                          the reference voice)
  QWEN3_TTS_PORT          port (8890)
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
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

VOICES_DIR = os.environ['QWEN3_TTS_VOICES_DIR']
DEFAULT_VOICE = os.getenv('QWEN3_TTS_VOICE', 'luna')
MODEL = os.getenv('QWEN3_TTS_MODEL', 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit')
TEMPERATURE = float(os.getenv('QWEN3_TTS_TEMPERATURE', '0.6'))
PORT = int(os.getenv('QWEN3_TTS_PORT', '8890'))

SAMPLE_RATE = 24000
# Rendering always runs in chunks, even for a non-streamed reply, so that a
# client hanging up (Luna interrupted) stops it within one chunk instead of
# after the whole sentence. Streamed replies use small chunks for latency;
# buffered ones bigger chunks, which cost less overhead.
STREAMING_INTERVAL = 0.32   # ~4 codec frames at 12.5 Hz
BUFFERED_INTERVAL = 1.0
# Leading audio quieter than this is dropped, keeping LEAD_IN_S before speech.
SILENCE_PEAK = 0.02
LEAD_IN_S = 0.05

app = FastAPI()


def voice_names() -> list:
    return sorted(f[:-4] for f in os.listdir(VOICES_DIR)
                  if f.endswith('.wav') and os.path.exists(os.path.join(VOICES_DIR, f[:-4] + '.txt')))


class TTSRequest(BaseModel):
    input: str
    voice: str = DEFAULT_VOICE
    speed: float = 1.0      # accepted for Kokoro compatibility; ignored
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
# model, and MLX ties its GPU streams to the thread that created them, so all
# loading and synthesis happens on this single thread. Requests are rendered
# one at a time, in order.

_SENTINEL = object()
_jobs: queue.Queue = queue.Queue()
_ready = threading.Event()
_load_error = []


class _Job:
    def __init__(self, text: str, voice: str, stream: bool):
        self.text = text
        self.voice = voice
        self.stream = stream
        self.out: queue.Queue = queue.Queue(maxsize=64)
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


def _render(model, refs: dict, job: _Job) -> None:
    """Puts float32 chunks of one utterance on job.out, minus leading silence."""
    from mlx_audio.utils import load_audio
    if job.voice not in refs:
        base = os.path.join(VOICES_DIR, job.voice)
        with open(base + '.txt') as f:
            refs[job.voice] = (load_audio(base + '.wav', sample_rate=SAMPLE_RATE), f.read().strip())
    ref_audio, ref_text = refs[job.voice]

    started = False
    for result in model.generate(
            job.text, ref_audio=ref_audio, ref_text=ref_text, lang_code='english',
            temperature=TEMPERATURE,
            # Bounds a runaway generation: ~2.4x the time the text needs.
            max_tokens=min(4096, 50 + 2 * len(job.text)),
            stream=True, streaming_interval=STREAMING_INTERVAL if job.stream else BUFFERED_INTERVAL):
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
    refs = {}
    try:
        from mlx_audio.tts.utils import load_model
        t0 = time.time()
        model = load_model(MODEL)
        # Warm-up: kernel compilation and encoding the default voice's clip.
        warm = _Job('Ready.', DEFAULT_VOICE, stream=False)
        _render(model, refs, warm)
        print(f'[qwen3-tts] warm in {time.time() - t0:.1f}s — model={MODEL}, '
              f'voice={DEFAULT_VOICE}, temperature={TEMPERATURE}, voices: {", ".join(voice_names())}',
              flush=True)
    except Exception as exc:                      # noqa: BLE001 — reported by /health
        _load_error.append(exc)
        print(f'[qwen3-tts] failed to load: {exc}', flush=True)
        _ready.set()
        return
    _ready.set()

    while True:
        job = _jobs.get()
        if job.cancel.is_set():
            continue
        try:
            _render(model, refs, job)
        except Exception as exc:                  # noqa: BLE001 — forwarded to caller
            job.put(exc)
        finally:
            if not job.put(_SENTINEL):
                try:
                    job.out.put_nowait(_SENTINEL)
                except queue.Full:
                    pass


async def _chunks(job: _Job, request: Request):
    """Yields the job's chunks; cancels it if the client disconnects."""
    _jobs.put(job)
    try:
        while True:
            try:
                item = job.out.get_nowait()
            except queue.Empty:
                # Polling (rather than a blocking get in a thread) also lets a
                # non-streaming request notice the client hanging up mid-render.
                if await request.is_disconnected():
                    return
                await asyncio.sleep(0.02)
                continue
            if item is _SENTINEL:
                return
            if isinstance(item, Exception):
                raise item
            yield item
    finally:
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
async def text_to_speech(req: TTSRequest, request: Request):
    _check(req)
    job = _Job(req.input.strip(), req.voice, req.stream)

    if req.stream:
        async def stream():
            yield make_wav_header(SAMPLE_RATE)
            async for audio in _chunks(job, request):
                yield pcm_chunk(audio)
        return StreamingResponse(stream(), media_type='audio/wav')

    try:
        parts = [audio async for audio in _chunks(job, request)]
    except Exception as exc:                      # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
    if not parts:
        raise HTTPException(status_code=500, detail='No audio generated')
    buf = io.BytesIO()
    sf.write(buf, np.concatenate(parts), SAMPLE_RATE, format='WAV', subtype='PCM_16')
    return Response(content=buf.getvalue(), media_type='audio/wav')


@app.get('/health')
def health():
    if _load_error:
        raise HTTPException(status_code=503, detail=str(_load_error[0]))
    return {'status': 'ok', 'model': MODEL, 'voice': DEFAULT_VOICE, 'voices': voice_names()}


if __name__ == '__main__':
    import uvicorn
    if DEFAULT_VOICE not in voice_names():
        raise SystemExit(f'Voice {DEFAULT_VOICE!r} not found in {VOICES_DIR} (needs {DEFAULT_VOICE}.wav '
                         f'and {DEFAULT_VOICE}.txt). Create one with design_voice.py; '
                         f'installed: {", ".join(voice_names()) or "none"}')
    threading.Thread(target=_worker, daemon=True, name='mlx').start()
    _ready.wait()       # load + warm up before accepting requests, like Kokoro
    if _load_error:
        raise SystemExit(1)
    print(f'Starting Qwen3-TTS server on http://localhost:{PORT}', flush=True)
    uvicorn.run(app, host='0.0.0.0', port=PORT)
