#!/usr/bin/env bash
#
# Run Kokoro TTS natively on macOS with Metal (MPS), instead of in Docker.
#
# WHY THIS EXISTS
#
# Docker Desktop on Apple Silicon runs a Linux VM with no access to Metal, no
# access to CoreML, and no access to the Neural Engine — the same limitation
# this repo's scripts/whisper-metal.sh already works around for Whisper.
# Kokoro hits it too: torch.cuda.is_available() is always False inside that
# VM, so every synthesis falls back to CPU no matter how KOKORO_THREADS is
# tuned. On top of that, docker-compose.yml deliberately caps Kokoro at 2
# threads / 2 concurrent syntheses so it doesn't starve Whisper and LM Studio
# for CPU cycles — a limit that only exists because Kokoro is stuck sharing
# CPU cores in the first place.
#
# Running kokoro_server.py natively with PYTORCH_ENABLE_MPS_FALLBACK=1 lets
# PyTorch dispatch to the GPU via MPS (the handful of ops without an MPS
# kernel silently fall back to CPU instead of erroring). That takes Kokoro
# off the CPU entirely, freeing those cores back up for Whisper and the
# wake-word detector, on top of whatever raw synthesis speedup MPS gives.
#
# Luna stays in Docker; only Kokoro moves out. Run this alongside
# whisper-metal.sh to get both off the Docker VM.
#
# USAGE
#
#   ./scripts/kokoro-metal.sh                     # first run: venv + deps
#   KOKORO_VOICE=af_sarah ./scripts/kokoro-metal.sh
#
# Then, in another terminal, with docker-compose.metal.yml's kokoro service
# removed and KOKORO_URL pointed at host.docker.internal (see README):
#
#   docker compose -f docker-compose.metal.yml up --build
#
set -euo pipefail

KOKORO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/Kokoro"
VENV_DIR=${VENV_DIR:-"$HOME/.luna/kokoro-venv"}

# kokoro_server.py binds port 8880 directly (not env-configurable), matching
# what the Docker service and Luna's example.env both already expect.
export KOKORO_VOICE=${KOKORO_VOICE:-af_heart}
export KOKORO_THREADS=${KOKORO_THREADS:-4}
export KOKORO_MAX_CONCURRENCY=${KOKORO_MAX_CONCURRENCY:-4}
export PYTORCH_ENABLE_MPS_FALLBACK=1

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS. On Linux, look at GPU passthrough for the" >&2
  echo "Docker Kokoro service instead (nvidia-container-toolkit)." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Warning: not running on Apple Silicon (arm64) — MPS will not be available." >&2
fi

# A stale dockerized `kokoro` container (from before switching to this
# script) or a second copy of this script in another tab is the usual cause
# of "address already in use" on 8880 — check for both up front rather than
# letting it surface as a uvicorn stack trace after the model has loaded.
if lsof -i :8880 >/dev/null 2>&1; then
  echo "==> Port 8880 is already in use. Likely culprits:" >&2
  echo "    - a leftover dockerized kokoro container:" >&2
  echo "        docker compose -f docker-compose.metal.yml ps" >&2
  echo "        docker compose -f docker-compose.metal.yml down" >&2
  echo "    - another kokoro-metal.sh already running in a different terminal" >&2
  echo "    Details: lsof -i :8880" >&2
  exit 1
fi

command -v brew >/dev/null || { echo "Homebrew not found: https://brew.sh" >&2; exit 1; }
command -v espeak-ng >/dev/null || { echo "==> Installing espeak-ng"; brew install espeak-ng; }

# kokoro's PyPI releases cap out below Python 3.13 (the Docker image sidesteps
# this by pinning python:3.11-slim). Pick the newest interpreter that still
# qualifies rather than whatever `python3` happens to resolve to system-wide.
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
  echo "==> No Python 3.10-3.12 found, installing python@3.11 via Homebrew"
  brew install python@3.11
  PYTHON_BIN="$(brew --prefix python@3.11)/bin/python3.11"
fi

echo "==> Using $($PYTHON_BIN --version) at $(command -v "$PYTHON_BIN")"

if [[ ! -d "$VENV_DIR" ]]; then
  echo "==> Creating venv at $VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

echo "==> Installing/updating dependencies"
pip install --quiet --upgrade pip
pip install --quiet -r "$KOKORO_DIR/requirements.txt"

echo "==> Checking MPS availability"
python3 -c "
import torch
built = torch.backends.mps.is_built()
available = torch.backends.mps.is_available()
print(f'MPS built:     {built}')
print(f'MPS available: {available}')
if not available:
    print('MPS is not available on this machine — Kokoro will run on CPU.')
    print('Check that you are on macOS 12.3+ with an Apple Silicon chip.')
"

echo "==> Starting Kokoro on http://127.0.0.1:8880  voice=$KOKORO_VOICE"
echo "    (warmup runs before the server reports ready — watch for"
echo "    'Starting Kokoro TTS server' below, that's the readiness signal)"
echo "    Point Luna at it with KOKORO_URL=http://host.docker.internal:8880/v1/audio/speech"

cd "$KOKORO_DIR"
exec python3 kokoro_server.py
