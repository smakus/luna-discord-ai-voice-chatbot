#!/usr/bin/env python3
"""
Chatterbox Turbo server — the same /v1/audio/speech API as Kokoro and
Qwen3-TTS (the server itself is MlxTTS/).

Chatterbox Turbo (Resemble AI, MIT) performs audio tags written in the text:
emotions such as [happy] or [whispering] and sounds such as [laugh] or [sigh]
(TAGS below). Any other bracketed text is removed before rendering, so a tag
it doesn't know is never read out.

Voices:
  default       the voice built into the model
  <name>        a clone of <name>.wav in CHATTERBOX_VOICES_DIR: 10-20 s of
                clear speech by one speaker (no transcript needed)

Runs on Apple Silicon through MLX, about 4x faster than real time next to a
Gemma-class LLM; start it with scripts/chatterbox-metal.sh.

Environment:
  CHATTERBOX_VOICES_DIR    folder of <name>.wav clones (optional)
  CHATTERBOX_VOICE         default voice (default)
  CHATTERBOX_MODEL         mlx-community/chatterbox-turbo-8bit
  CHATTERBOX_TEMPERATURE   sampling temperature (0.8)
  CHATTERBOX_PORT          port (8891)
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'MlxTTS'))
from mlx_tts_server import serve  # noqa: E402

VOICES_DIR = os.getenv('CHATTERBOX_VOICES_DIR', '')
BUILTIN = 'default'

# The tags the model was trained on (its tokenizer's added tokens), minus
# [advertisement] and [narration], which are reading styles, not expressions.
TAGS = ['[angry]', '[chuckle]', '[clear throat]', '[cough]', '[crying]', '[dramatic]', '[fear]',
        '[gasp]', '[groan]', '[happy]', '[laugh]', '[sarcastic]', '[shush]', '[sigh]', '[sniff]',
        '[surprised]', '[whispering]']
_BRACKETS = re.compile(r'\[[^\[\]\n]{1,40}\]')


def keep_known_tags(text: str) -> str:
    text = _BRACKETS.sub(lambda m: m.group(0) if m.group(0).lower() in TAGS else ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


class ChatterboxEngine:
    name = 'chatterbox'
    model = os.getenv('CHATTERBOX_MODEL', 'mlx-community/chatterbox-turbo-8bit')
    default_voice = os.getenv('CHATTERBOX_VOICE', BUILTIN)
    sample_rate = 24000
    tags = TAGS
    temperature = float(os.getenv('CHATTERBOX_TEMPERATURE', '0.8'))
    settings = {'temperature': temperature}

    def __init__(self):
        self._model = None
        # Conditioning per voice. The model holds one at a time — cloning a
        # voice replaces the built-in one — so each is kept and swapped in.
        self._conds = {}

    def voice_names(self) -> list:
        clones = []
        if VOICES_DIR and os.path.isdir(VOICES_DIR):
            clones = [f[:-4] for f in os.listdir(VOICES_DIR) if f.endswith('.wav') and f[:-4] != BUILTIN]
        return [BUILTIN] + sorted(clones)

    def load(self) -> None:
        from mlx_audio.tts.utils import load_model
        self._model = load_model(self.model)
        self._conds[BUILTIN] = self._model._conds

    def render(self, text: str, voice: str, stream: bool, interval: float):
        if voice not in self._conds:
            self._model.prepare_conditionals(os.path.join(VOICES_DIR, voice + '.wav'))
            self._conds[voice] = self._model._conds
        self._model._conds = self._conds[voice]
        text = keep_known_tags(text)
        if not text:        # only unknown tags: nothing to say
            return
        for result in self._model.generate(text, temperature=self.temperature,
                                           stream=True, streaming_interval=interval):
            yield result.audio


if __name__ == '__main__':
    serve(ChatterboxEngine(), int(os.getenv('CHATTERBOX_PORT', '8891')))
