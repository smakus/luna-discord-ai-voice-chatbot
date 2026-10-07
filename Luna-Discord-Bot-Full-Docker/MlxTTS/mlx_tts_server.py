"""
The server shared by Luna's MLX voices (Qwen3TTS/, Chatterbox/): Kokoro's
/v1/audio/speech API, so Luna talks to all of them the same way.

Each voice server is a small "engine" — how to load its model, which voices
it has, and how to render one sentence — passed to serve(). Everything else
lives here: one MLX thread, rendering in chunks so a client hanging up stops
it, trimming leading silence, streamed or buffered WAV replies, and /health.

An engine has:
  name           shown in logs and /health, e.g. "Qwen3-TTS"
  model          the model id, for logs and /health
  default_voice  the voice used when a request names none
  sample_rate    of the audio render() yields
  tags           audio tags the model performs, e.g. ["[laugh]"]; [] for none
  settings       dict of other settings, for the startup log
  load()         loads the model; runs on the MLX thread
  voice_names()  installed voices
  render(text, voice, stream, interval)
                 yields float32 audio chunks of about `interval` seconds;
                 runs on the MLX thread
"""
import asyncio
import io
import queue
import struct
import threading
import time

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

# Rendering always runs in chunks, even for a non-streamed reply, so that a
# client hanging up (Luna interrupted) stops it within one chunk instead of
# after the whole sentence. Streamed replies use small chunks for latency;
# buffered ones bigger chunks, which cost less overhead.
STREAMING_INTERVAL = 0.32
BUFFERED_INTERVAL = 1.0
# Leading audio quieter than this is dropped, keeping LEAD_IN_S before speech.
SILENCE_PEAK = 0.02
LEAD_IN_S = 0.05


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


_SENTINEL = object()


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


class TTSRequest(BaseModel):
    input: str
    voice: str = ''
    speed: float = 1.0      # accepted for Kokoro compatibility; ignored
    stream: bool = False


def serve(engine, port: int) -> None:
    """Loads the engine's model, then serves it on `port` until stopped."""
    import uvicorn

    if engine.default_voice not in engine.voice_names():
        raise SystemExit(f'Voice {engine.default_voice!r} not found; '
                         f'installed: {", ".join(engine.voice_names()) or "none"}')

    # ── The MLX worker ──────────────────────────────────────────────────────
    #
    # One model, one thread. MLX inference is not safe to run concurrently on
    # one model, and MLX ties its GPU streams to the thread that created them,
    # so all loading and synthesis happens on this single thread. Requests are
    # rendered one at a time, in order.
    jobs: queue.Queue = queue.Queue()
    ready = threading.Event()
    load_error = []

    def render(job: _Job) -> None:
        """Puts float32 chunks of one utterance on job.out, minus leading silence."""
        started = False
        interval = STREAMING_INTERVAL if job.stream else BUFFERED_INTERVAL
        for audio in engine.render(job.text, job.voice, job.stream, interval):
            if job.cancel.is_set():
                return
            audio = np.asarray(audio, dtype=np.float32).reshape(-1)
            if not started:
                loud = np.flatnonzero(np.abs(audio) >= SILENCE_PEAK)
                if loud.size == 0:
                    continue
                audio = audio[max(0, loud[0] - int(LEAD_IN_S * engine.sample_rate)):]
                started = True
            if not job.put(audio):
                return

    def worker() -> None:
        try:
            t0 = time.time()
            engine.load()
            # Warm-up: kernel compilation and preparing the default voice.
            render(_Job('Ready.', engine.default_voice, stream=False))
            settings = ''.join(f', {k}={v}' for k, v in engine.settings.items())
            print(f'[{engine.name}] warm in {time.time() - t0:.1f}s — model={engine.model}, '
                  f'voice={engine.default_voice}{settings}, voices: {", ".join(engine.voice_names())}',
                  flush=True)
        except Exception as exc:                  # noqa: BLE001 — reported by /health
            load_error.append(exc)
            print(f'[{engine.name}] failed to load: {exc}', flush=True)
            ready.set()
            return
        ready.set()

        while True:
            job = jobs.get()
            if job.cancel.is_set():
                continue
            try:
                render(job)
            except Exception as exc:              # noqa: BLE001 — forwarded to caller
                job.put(exc)
            finally:
                if not job.put(_SENTINEL):
                    try:
                        job.out.put_nowait(_SENTINEL)
                    except queue.Full:
                        pass

    async def chunks(job: _Job, request: Request):
        """Yields the job's chunks; cancels it if the client disconnects."""
        jobs.put(job)
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

    app = FastAPI()

    @app.post('/v1/audio/speech')
    async def text_to_speech(req: TTSRequest, request: Request):
        if load_error:
            raise HTTPException(status_code=503, detail=f'model failed to load: {load_error[0]}')
        if not req.input or not req.input.strip():
            raise HTTPException(status_code=400, detail='input is empty')
        voice = req.voice or engine.default_voice
        # Only names of installed voices: a name can become part of a file path.
        if voice not in engine.voice_names():
            raise HTTPException(status_code=400,
                                detail=f'unknown voice {voice!r}; installed: {", ".join(engine.voice_names())}')
        job = _Job(req.input.strip(), voice, req.stream)

        if req.stream:
            async def stream():
                yield make_wav_header(engine.sample_rate)
                async for audio in chunks(job, request):
                    yield pcm_chunk(audio)
            return StreamingResponse(stream(), media_type='audio/wav')

        try:
            parts = [audio async for audio in chunks(job, request)]
        except Exception as exc:                  # noqa: BLE001
            raise HTTPException(status_code=500, detail=str(exc))
        if not parts:
            raise HTTPException(status_code=500, detail='No audio generated')
        buf = io.BytesIO()
        sf.write(buf, np.concatenate(parts), engine.sample_rate, format='WAV', subtype='PCM_16')
        return Response(content=buf.getvalue(), media_type='audio/wav')

    @app.get('/health')
    def health():
        if load_error:
            raise HTTPException(status_code=503, detail=str(load_error[0]))
        return {'status': 'ok', 'engine': engine.name, 'model': engine.model,
                'voice': engine.default_voice, 'voices': engine.voice_names(), 'tags': engine.tags}

    threading.Thread(target=worker, daemon=True, name='mlx').start()
    ready.wait()        # load + warm up before accepting requests, like Kokoro
    if load_error:
        raise SystemExit(1)
    print(f'Starting {engine.name} server on http://localhost:{port}', flush=True)
    uvicorn.run(app, host='0.0.0.0', port=port)
