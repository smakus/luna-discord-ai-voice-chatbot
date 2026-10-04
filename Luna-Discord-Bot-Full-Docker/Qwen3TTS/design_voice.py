#!/usr/bin/env python3
"""
Creates a voice for qwen3_tts_server.py from a written description.

Qwen3-TTS's VoiceDesign model invents a voice that fits the description — a
different one every run — so this renders several takes for you to choose
from. Each take is a reference clip plus its transcript:

    <voices_dir>/<name>-take1.wav  <name>-take1.txt
    <voices_dir>/<name>-take2.wav  ...

Listen, then keep the one you like under the voice's name:

    python design_voice.py <voices_dir> --keep <name>-take2 --as <name>

The server then speaks every sentence in that one voice by cloning the clip.
(Using the description directly would change the voice from sentence to
sentence.)

    python design_voice.py <voices_dir> --name luna \\
        --description "A warm American woman in her thirties with a low, smooth voice." \\
        [--takes 3] [--text "What the clip says"]
"""
import argparse
import os
import shutil

# Long enough (~10 s) and varied enough to clone well.
DEFAULT_TEXT = ("Hi, I'm Luna! It's really nice to meet you. I can look things up, answer "
                "questions, or just chat for a while. So, what's on your mind today?")
DESIGN_MODEL = 'mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit'


def design(voices_dir, name, description, takes, text):
    import numpy as np
    import soundfile as sf
    from mlx_audio.tts.utils import load_model

    os.makedirs(voices_dir, exist_ok=True)
    model = load_model(DESIGN_MODEL)
    for i in range(1, takes + 1):
        audio = np.concatenate([np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in
                                model.generate(text, instruct=description, lang_code='english')])
        base = os.path.join(voices_dir, f'{name}-take{i}')
        sf.write(base + '.wav', audio, 24000)
        with open(base + '.txt', 'w') as f:
            f.write(text + '\n')
        print(f'[qwen3-tts] wrote {base}.wav ({len(audio) / 24000:.1f}s)', flush=True)
    print(f'Listen to the takes in {voices_dir}, then keep one:\n'
          f'  ./scripts/qwen3-tts-metal.sh design --keep {name}-take1 --as {name}')


def keep(voices_dir, take, name):
    for ext in ('.wav', '.txt'):
        shutil.copyfile(os.path.join(voices_dir, take + ext), os.path.join(voices_dir, name + ext))
    print(f'[qwen3-tts] voice {name!r} is now {take}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('voices_dir')
    ap.add_argument('--name')
    ap.add_argument('--description')
    ap.add_argument('--takes', type=int, default=3)
    ap.add_argument('--text', default=DEFAULT_TEXT)
    ap.add_argument('--keep', metavar='TAKE')
    ap.add_argument('--as', dest='as_name', metavar='NAME')
    a = ap.parse_args()
    if a.keep:
        if not a.as_name:
            ap.error('--keep needs --as NAME')
        keep(a.voices_dir, a.keep, a.as_name)
    elif a.name and a.description:
        design(a.voices_dir, a.name, a.description, a.takes, a.text)
    else:
        ap.error('give --name and --description, or --keep TAKE --as NAME')
