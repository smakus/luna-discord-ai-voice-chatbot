#!/usr/bin/env python3
"""
Qwen3-TTS server — the same /v1/audio/speech API as Kokoro/kokoro_server.py,
so Luna talks to both the same way (the server itself is MlxTTS/).

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
  QWEN3_TTS_TEMPERATURE   sampling temperature (0.3). Each sentence is
                          rendered on its own; lower keeps the delivery
                          steadier from one sentence to the next
  QWEN3_TTS_PORT          port (8890)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'MlxTTS'))
from mlx_tts_server import serve  # noqa: E402

VOICES_DIR = os.environ['QWEN3_TTS_VOICES_DIR']


class Qwen3Engine:
    name = 'qwen3-tts'
    model = os.getenv('QWEN3_TTS_MODEL', 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit')
    default_voice = os.getenv('QWEN3_TTS_VOICE', 'luna')
    sample_rate = 24000
    tags = []
    temperature = float(os.getenv('QWEN3_TTS_TEMPERATURE', '0.3'))
    settings = {'temperature': temperature}

    def __init__(self):
        self._model = None
        self._refs = {}

    def voice_names(self) -> list:
        return sorted(f[:-4] for f in os.listdir(VOICES_DIR)
                      if f.endswith('.wav') and os.path.exists(os.path.join(VOICES_DIR, f[:-4] + '.txt')))

    def load(self) -> None:
        from mlx_audio.tts.utils import load_model
        self._model = load_model(self.model)

    def render(self, text: str, voice: str, stream: bool, interval: float):
        from mlx_audio.utils import load_audio
        if voice not in self._refs:
            base = os.path.join(VOICES_DIR, voice)
            with open(base + '.txt') as f:
                self._refs[voice] = (load_audio(base + '.wav', sample_rate=self.sample_rate), f.read().strip())
        ref_audio, ref_text = self._refs[voice]
        for result in self._model.generate(
                text, ref_audio=ref_audio, ref_text=ref_text, lang_code='english',
                temperature=self.temperature,
                # Bounds a runaway generation: ~2.4x the time the text needs.
                max_tokens=min(4096, 50 + 2 * len(text)),
                stream=True, streaming_interval=interval):
            yield result.audio


if __name__ == '__main__':
    serve(Qwen3Engine(), int(os.getenv('QWEN3_TTS_PORT', '8890')))
