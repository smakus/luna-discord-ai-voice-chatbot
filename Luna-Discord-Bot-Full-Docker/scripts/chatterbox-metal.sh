#!/usr/bin/env bash
#
# Run Chatterbox Turbo natively on macOS (Apple Silicon, MLX/Metal).
#
# An expressive voice: it performs audio tags in the text, emotions such as
# [happy] or [whispering] and sounds such as [laugh] or [sigh], and Luna tells
# the LLM which ones it can use. It has a built-in voice ("default") and can
# clone others from a short clip. It needs Metal, so like qwen3-tts-metal.sh it
# runs here, outside Docker, and Luna reaches it over host.docker.internal.
#
# Renders about 2.7x faster than real time even while an LLM generates
# (the full-precision model; CHATTERBOX_MODEL=mlx-community/chatterbox-turbo-8bit
# is faster and needs less memory, but sounds rougher).
#
#   ./scripts/chatterbox-metal.sh
#   CHATTERBOX_VOICE=myclone ./scripts/chatterbox-metal.sh
#
# Clones: put <name>.wav (10-20 s of clear speech by one speaker) in
# ~/.luna/chatterbox-voices. Set TTS_PROVIDER=chatterbox (or
# TTS_FALLBACK=chatterbox) in Luna/.env.
#
set -euo pipefail

CB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/Chatterbox"
VENV_DIR=${VENV_DIR:-"$HOME/.luna/chatterbox-venv"}
export CHATTERBOX_VOICES_DIR=${CHATTERBOX_VOICES_DIR:-"$HOME/.luna/chatterbox-voices"}
export CHATTERBOX_PORT=${CHATTERBOX_PORT:-8891}

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Chatterbox here runs on MLX, which needs an Apple Silicon Mac." >&2
  echo "Use Kokoro (TTS_PROVIDER=kokoro) on other machines." >&2
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
pip install --quiet -r "$CB_DIR/requirements.txt"

mkdir -p "$CHATTERBOX_VOICES_DIR"

if lsof -i ":$CHATTERBOX_PORT" >/dev/null 2>&1; then
  echo "==> Port $CHATTERBOX_PORT is already in use — probably another" >&2
  echo "    chatterbox-metal.sh in a different terminal. Details: lsof -i :$CHATTERBOX_PORT" >&2
  exit 1
fi

echo "==> Starting Chatterbox on http://127.0.0.1:$CHATTERBOX_PORT  voice=${CHATTERBOX_VOICE:-default}"
echo "    (the first run downloads the model, ~3 GB; wait for 'Starting chatterbox server')"
echo "    Point Luna at it with CHATTERBOX_URL=http://host.docker.internal:$CHATTERBOX_PORT/v1/audio/speech"

cd "$CB_DIR"
exec python3 chatterbox_server.py
