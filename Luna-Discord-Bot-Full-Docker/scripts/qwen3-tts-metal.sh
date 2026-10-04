#!/usr/bin/env bash
#
# Run Qwen3-TTS natively on macOS (Apple Silicon, MLX/Metal) in a cloned voice.
#
# An alternative voice to Kokoro. Qwen3-TTS clones the voice in a short
# reference clip, so Luna can sound like any voice you design from a written
# description. It needs Metal, so like kokoro-metal.sh it runs here, outside
# Docker, and Luna reaches it over host.docker.internal.
#
# It is slower than Kokoro: ~2-3x real time on its own, and slower than real
# time while a large LLM generates on the same GPU. Luna therefore waits for
# each sentence to finish rendering before playing it (QWEN3_TTS_STREAM=false),
# which costs a pause between sentences but never stutters.
#
# FIRST RUN: create the voice (renders a few takes to choose from):
#
#   ./scripts/qwen3-tts-metal.sh design --name luna \
#       --description "A warm American woman in her thirties with a low, smooth voice."
#   ./scripts/qwen3-tts-metal.sh design --keep luna-take2 --as luna
#
# Then start the server:
#
#   ./scripts/qwen3-tts-metal.sh
#   QWEN3_TTS_VOICE=other ./scripts/qwen3-tts-metal.sh
#
# and set TTS_PROVIDER=qwen3 (or TTS_FALLBACK=qwen3) in Luna/.env.
#
set -euo pipefail

QWEN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/Qwen3TTS"
VENV_DIR=${VENV_DIR:-"$HOME/.luna/qwen3-tts-venv"}
export QWEN3_TTS_VOICES_DIR=${QWEN3_TTS_VOICES_DIR:-"$HOME/.luna/qwen3-tts-voices"}
export QWEN3_TTS_VOICE=${QWEN3_TTS_VOICE:-luna}
export QWEN3_TTS_PORT=${QWEN3_TTS_PORT:-8890}

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Qwen3-TTS here runs on MLX, which needs an Apple Silicon Mac." >&2
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
pip install --quiet -r "$QWEN_DIR/requirements.txt"

if [[ "${1:-}" == "design" ]]; then
  shift
  exec python3 "$QWEN_DIR/design_voice.py" "$QWEN3_TTS_VOICES_DIR" "$@"
fi

if [[ ! -f "$QWEN3_TTS_VOICES_DIR/$QWEN3_TTS_VOICE.wav" ]]; then
  echo "==> No voice '$QWEN3_TTS_VOICE' in $QWEN3_TTS_VOICES_DIR yet. Create one first:" >&2
  echo "    $0 design --name $QWEN3_TTS_VOICE --description \"A warm American woman ...\"" >&2
  exit 1
fi

if lsof -i ":$QWEN3_TTS_PORT" >/dev/null 2>&1; then
  echo "==> Port $QWEN3_TTS_PORT is already in use — probably another" >&2
  echo "    qwen3-tts-metal.sh in a different terminal. Details: lsof -i :$QWEN3_TTS_PORT" >&2
  exit 1
fi

echo "==> Starting Qwen3-TTS on http://127.0.0.1:$QWEN3_TTS_PORT  voice=$QWEN3_TTS_VOICE"
echo "    (the first run downloads the model, ~2 GB; wait for 'Starting Qwen3-TTS server')"
echo "    Point Luna at it with QWEN3_TTS_URL=http://host.docker.internal:$QWEN3_TTS_PORT/v1/audio/speech"

cd "$QWEN_DIR"
exec python3 qwen3_tts_server.py
