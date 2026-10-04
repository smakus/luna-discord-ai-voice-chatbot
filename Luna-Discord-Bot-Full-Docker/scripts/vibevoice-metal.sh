#!/usr/bin/env bash
#
# Run VibeVoice-Realtime TTS natively on macOS (Apple Silicon, MLX/Metal).
#
# An alternative voice to Kokoro: Microsoft's VibeVoice-Realtime-0.5B, run
# through mlx-audio. In testing on an M-series Mac it starts speaking ~0.15 s
# after a request and renders ~5x faster than real time (Kokoro: ~20x), using
# ~1.6 GB. It cannot run in Docker (MLX needs Metal), so like
# kokoro-metal.sh it runs here and Luna reaches it over host.docker.internal.
#
# First run creates a venv, downloads the model (~1 GB) and installs
# Microsoft's experimental English voices (Breeze, Clarissa, Snarkling,
# Soother and more) next to the built-in ones (Emma, Grace, Carter, ...).
#
# USAGE
#
#   ./scripts/vibevoice-metal.sh
#   VIBEVOICE_VOICE=en-Grace_woman ./scripts/vibevoice-metal.sh
#
# Then set TTS_PROVIDER=vibevoice in Luna/.env (the docker-compose.metal.yml
# service already points VIBEVOICE_URL at port 8890).
#
set -euo pipefail

VIBEVOICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/VibeVoice"
VENV_DIR=${VENV_DIR:-"$HOME/.luna/vibevoice-venv"}
MODEL_REPO=${VIBEVOICE_MODEL_REPO:-mlx-community/VibeVoice-Realtime-0.5B-8bit}
export VIBEVOICE_MODEL_DIR=${VIBEVOICE_MODEL_DIR:-"$HOME/.luna/vibevoice-model"}
export VIBEVOICE_VOICE=${VIBEVOICE_VOICE:-en-Clarissa_woman}
export VIBEVOICE_PORT=${VIBEVOICE_PORT:-8890}

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "VibeVoice here runs on MLX, which needs an Apple Silicon Mac." >&2
  echo "Use Kokoro (TTS_PROVIDER=kokoro) on other machines." >&2
  exit 1
fi

if lsof -i ":$VIBEVOICE_PORT" >/dev/null 2>&1; then
  echo "==> Port $VIBEVOICE_PORT is already in use — probably another" >&2
  echo "    vibevoice-metal.sh in a different terminal. Details: lsof -i :$VIBEVOICE_PORT" >&2
  exit 1
fi

# MLX wheels need Python 3.10+; prefer a version known to work.
PYTHON_BIN=${PYTHON_BIN:-}
if [[ -z "$PYTHON_BIN" ]]; then
  for candidate in python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi
if [[ -z "$PYTHON_BIN" ]]; then
  command -v brew >/dev/null || { echo "Homebrew not found: https://brew.sh" >&2; exit 1; }
  echo "==> No Python 3.10-3.12 found, installing python@3.11 via Homebrew"
  brew install python@3.11
  PYTHON_BIN="$(brew --prefix python@3.11)/bin/python3.11"
fi

if [[ ! -d "$VENV_DIR" ]]; then
  echo "==> Creating venv at $VENV_DIR with $($PYTHON_BIN --version)"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

echo "==> Installing/updating dependencies"
pip install --quiet --upgrade pip
pip install --quiet -r "$VIBEVOICE_DIR/requirements.txt"

if [[ ! -f "$VIBEVOICE_MODEL_DIR/config.json" ]]; then
  echo "==> Downloading $MODEL_REPO -> $VIBEVOICE_MODEL_DIR"
  python3 -c "
import sys
from huggingface_hub import snapshot_download
snapshot_download(sys.argv[1], local_dir=sys.argv[2])
" "$MODEL_REPO" "$VIBEVOICE_MODEL_DIR"
fi

echo "==> Installing experimental voices (first run only)"
python3 "$VIBEVOICE_DIR/convert_voices.py" "$VIBEVOICE_MODEL_DIR"

echo "==> Starting VibeVoice on http://127.0.0.1:$VIBEVOICE_PORT  voice=$VIBEVOICE_VOICE"
echo "    (wait for 'Starting VibeVoice TTS server' — that's the readiness signal)"
echo "    Point Luna at it with VIBEVOICE_URL=http://host.docker.internal:$VIBEVOICE_PORT/v1/audio/speech"

cd "$VIBEVOICE_DIR"
exec python3 vibevoice_server.py
