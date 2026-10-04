#!/usr/bin/env python3
"""
Installs Microsoft's experimental VibeVoice-Realtime English voices (Breeze,
Clarissa, Snarkling, Soother, and the men's voices) into an MLX model folder.

The MLX model's English voices are only Emma, Grace and four men's voices.
Microsoft publishes more as "experimental" packs, but as PyTorch .pt files
(pickled transformers objects) rather than the .safetensors voice caches that
mlx-audio loads. This converts them.

Safety: a .pt file is a pickle, and unpickling can run arbitrary code. These
files are read with a strict allowlist instead of torch.load: only the five
globals they are known to contain are resolved, each to a plain local
stand-in, and anything else aborts the conversion. PyTorch and transformers
are not needed at all.

    python convert_voices.py <model_dir>      # writes <model_dir>/voices/*.safetensors
"""
import io
import os
import pickle
import sys
import tarfile
import urllib.request
import zipfile
from collections import OrderedDict

import numpy as np

# From microsoft/VibeVoice demo/download_experimental_voices.sh.
PACKS = {
    'en1': 'https://github.com/user-attachments/files/24189272/experimental_voices_en1.tar.gz',
    'en2': 'https://github.com/user-attachments/files/24189273/experimental_voices_en2.tar.gz',
}
PREFIXES = ('lm', 'tts_lm', 'neg_lm', 'neg_tts_lm')


class _OutputWithPast(OrderedDict):
    """Stand-in for transformers.modeling_outputs.BaseModelOutputWithPast.

    Pickled as its dataclass fields, positionally, in this order."""
    FIELDS = ('last_hidden_state', 'past_key_values', 'hidden_states', 'attentions')

    def __init__(self, *args, **kwargs):
        super().__init__()
        for name, value in [*zip(self.FIELDS, args), *kwargs.items()]:
            if value is not None:
                self[name] = value


class _Cache:
    """Stand-in for transformers.cache_utils.DynamicCache (just its __dict__)."""


class _BFloat16Storage:
    """Marker for torch.BFloat16Storage."""


def _rebuild_tensor(storage, offset, size, stride, *_):
    # storage is a flat float32 array; build the (strided) view and copy it.
    itemsize = storage.itemsize
    return np.lib.stride_tricks.as_strided(
        storage[offset:], shape=tuple(size), strides=tuple(s * itemsize for s in stride)).copy()


ALLOWED = {
    ('transformers.modeling_outputs', 'BaseModelOutputWithPast'): _OutputWithPast,
    ('transformers.cache_utils', 'DynamicCache'): _Cache,
    ('collections', 'OrderedDict'): OrderedDict,
    ('torch._utils', '_rebuild_tensor_v2'): _rebuild_tensor,
    ('torch', 'BFloat16Storage'): _BFloat16Storage,
}


def load_voice_pt(data: bytes) -> dict:
    archive = zipfile.ZipFile(io.BytesIO(data))
    root = archive.namelist()[0].split('/')[0]

    class Unpickler(pickle.Unpickler):
        def find_class(self, module, name):
            try:
                return ALLOWED[(module, name)]
            except KeyError:
                raise pickle.UnpicklingError(f'refusing to load {module}.{name}') from None

        def persistent_load(self, pid):
            kind, storage_type, key, _location, _numel = pid
            if kind != 'storage' or storage_type is not _BFloat16Storage:
                raise pickle.UnpicklingError(f'unexpected storage {pid!r}')
            raw = np.frombuffer(archive.read(f'{root}/data/{key}'), dtype='<u2')
            # bfloat16 is the top half of a float32.
            return (raw.astype(np.uint32) << 16).view(np.float32)

    return Unpickler(io.BytesIO(archive.read(f'{root}/data.pkl'))).load()


def to_voice_cache(obj: dict) -> dict:
    """Microsoft's layout -> mlx-audio's voice-cache key names."""
    out = {}
    for prefix in PREFIXES:
        o = obj[prefix]
        out[f'{prefix}_hidden'] = o['last_hidden_state']
        cache = o['past_key_values']
        for i, (k, v) in enumerate(zip(cache.key_cache, cache.value_cache)):
            out[f'{prefix}_key_{i}'] = k
            out[f'{prefix}_value_{i}'] = v
    return out


def main(model_dir: str) -> None:
    import mlx.core as mx  # only needed for writing bfloat16 safetensors

    voices_dir = os.path.join(model_dir, 'voices')
    os.makedirs(voices_dir, exist_ok=True)
    for pack, url in PACKS.items():
        marker = os.path.join(voices_dir, f'.experimental-{pack}')
        if os.path.exists(marker):
            continue  # already installed; don't download the pack again
        with urllib.request.urlopen(url, timeout=120) as resp:
            tar = tarfile.open(fileobj=io.BytesIO(resp.read()), mode='r:gz')
        for member in tar.getmembers():
            if not (member.isfile() and member.name.endswith('.pt')):
                continue
            name = os.path.basename(member.name)[:-3]
            target = os.path.join(voices_dir, f'{name}.safetensors')
            if os.path.exists(target):
                continue
            cache = to_voice_cache(load_voice_pt(tar.extractfile(member).read()))
            mx.save_safetensors(target, {k: mx.array(v).astype(mx.bfloat16) for k, v in cache.items()})
            print(f'[vibevoice] installed voice {name}', flush=True)
        open(marker, 'w').close()


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
