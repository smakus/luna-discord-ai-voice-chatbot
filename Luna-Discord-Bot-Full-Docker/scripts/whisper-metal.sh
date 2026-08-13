#!/usr/bin/env bash
#
# Run whisper.cpp natively on macOS with Metal, instead of in Docker.
#
# WHY THIS EXISTS
#
# Docker Desktop on Apple Silicon runs a Linux VM. That VM has no access to
# Metal, no access to CoreML, and no access to the Neural Engine — it gets a
# slice of the CPU cores and nothing else. Whisper's encoder is exactly the kind
# of dense matmul workload the GPU is for, so containerising it on this hardware
# gives up the machine's main advantage. Running the same whisper.cpp build
# natively with -DGGML_METAL=ON typically transcribes several times faster on
# the same model, and the headroom is large enough to move up a model size and
# gain accuracy at the same time.
#
# Kokoro and Luna stay in Docker; only Whisper moves out.
#
# USAGE
#
#   ./scripts/whisper-metal.sh                       # build (once) and run
#   WHISPER_MODEL=ggml-large-v3-turbo-q5_0.bin ./scripts/whisper-metal.sh
#
# Then, in a second terminal:
#
#   docker compose -f docker-compose.metal.yml up --build
#
set -euo pipefail

WHISPER_REF=${WHISPER_REF:-v1.9.2}
WHISPER_DIR=${WHISPER_DIR:-"$HOME/.luna/whisper.cpp"}
WHISPER_PORT=${WHISPER_PORT:-8081}
WHISPER_THREADS=${WHISPER_THREADS:-4}

# Metal makes a bigger model affordable, and model size is the single largest
# lever on transcription accuracy.
#
#   ggml-medium.en-q5_0.bin        (~540 MB) — solid default here
#   ggml-large-v3-turbo-q5_0.bin   (~570 MB) — more accurate again, similar speed
#   ggml-small.en-q5_1.bin         (~180 MB) — what the Docker path uses
# WHISPER_MODEL=${WHISPER_MODEL:-ggml-medium.en-q5_0.bin}
WHISPER_MODEL=${WHISPER_MODEL:-ggml-small.en-q5_1.bin}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS. On Linux use the bundled Docker Whisper service." >&2
  exit 1
fi

command -v cmake >/dev/null || { echo "cmake not found: brew install cmake" >&2; exit 1; }

if [[ ! -d "$WHISPER_DIR/.git" ]]; then
  echo "==> Cloning whisper.cpp $WHISPER_REF"
  mkdir -p "$(dirname "$WHISPER_DIR")"
  git clone --depth 1 --branch "$WHISPER_REF" \
    https://github.com/ggerganov/whisper.cpp "$WHISPER_DIR"
fi

cd "$WHISPER_DIR"

if [[ ! -x build/bin/whisper-server ]]; then
  echo "==> Building whisper-server with Metal"
  cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON
  cmake --build build --target whisper-server -j "$(sysctl -n hw.ncpu)"
fi

mkdir -p models
if [[ ! -f "models/$WHISPER_MODEL" ]]; then
  echo "==> Downloading $WHISPER_MODEL"
  # -f so a bad model name fails here rather than as a confusing model-load
  # error after an HTML 404 page is saved as a .bin.
  curl -fL --progress-bar \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WHISPER_MODEL" \
    -o "models/$WHISPER_MODEL"
fi

echo "==> whisper-server (Metal) on http://127.0.0.1:$WHISPER_PORT  model=$WHISPER_MODEL"
echo "    Point Luna at it with WHISPER_SERVER_URLS=http://host.docker.internal:$WHISPER_PORT/inference"

# Binds to 0.0.0.0 so the Docker VM can reach it via host.docker.internal.
#
# -fa  flash attention — a real speedup on the Metal backend (a no-op on CPU,
#      which is why the Docker build does not bother).
# -nt  no timestamps — Luna reads only `text`; suppressing timestamp tokens
#      removes about one decoded token per word from the critical path.
exec ./build/bin/whisper-server \
  -m "models/$WHISPER_MODEL" \
  --host 0.0.0.0 --port "$WHISPER_PORT" \
  -t "$WHISPER_THREADS" -bs 1 -bo 1 -fa -nt
