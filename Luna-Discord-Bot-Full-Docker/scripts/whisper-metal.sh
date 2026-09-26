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

# Same pre-flight as kokoro-metal.sh: fail clearly instead of after the build.
if lsof -i :"$WHISPER_PORT" >/dev/null 2>&1; then
  echo "==> Port $WHISPER_PORT is already in use (another whisper-metal.sh, or a" >&2
  echo "    leftover dockerized whisper). Details: lsof -i :$WHISPER_PORT" >&2
  exit 1
fi

if [[ ! -d "$WHISPER_DIR/.git" ]]; then
  echo "==> Cloning whisper.cpp $WHISPER_REF"
  mkdir -p "$(dirname "$WHISPER_DIR")"
  git clone --depth 1 --branch "$WHISPER_REF" \
    https://github.com/ggerganov/whisper.cpp "$WHISPER_DIR"
fi

cd "$WHISPER_DIR"

# Bumping WHISPER_REF must actually change the build. Previously an existing
# clone and binary were reused forever, so the pin above only applied on the
# very first run.
CURRENT_REF=$(git describe --tags --exact-match 2>/dev/null || echo "unknown")
if [[ "$CURRENT_REF" != "$WHISPER_REF" ]]; then
  echo "==> Switching whisper.cpp $CURRENT_REF -> $WHISPER_REF"
  git fetch --depth 1 origin tag "$WHISPER_REF"
  git checkout -q "$WHISPER_REF"
  rm -rf build
fi

# An existing binary is only reusable if it can actually start. Builds made
# before BUILD_SHARED_LIBS=OFF below link libwhisper/libggml via an absolute
# rpath into the build tree, so moving WHISPER_DIR left a binary that dyld
# aborts on ("Library not loaded: @rpath/libwhisper.1.dylib") — and the
# existence check alone reused it forever.
# Subshell with its own redirect: otherwise bash reports the dyld abort itself
# ("Abort trap: 6"), which reads like a failure of this script.
if [[ -x build/bin/whisper-server ]] && ! (build/bin/whisper-server --help) >/dev/null 2>&1; then
  echo "==> Existing whisper-server build cannot start (moved since it was built?) — rebuilding"
  rm -rf build
fi

if [[ ! -x build/bin/whisper-server ]]; then
  echo "==> Building whisper-server with Metal"
  # Static libraries: the binary then has no dylib dependencies on the build
  # tree and keeps working if WHISPER_DIR is moved or renamed.
  cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON -DBUILD_SHARED_LIBS=OFF
  cmake --build build --target whisper-server -j "$(sysctl -n hw.ncpu)"
fi

mkdir -p models
if [[ ! -f "models/$WHISPER_MODEL" ]]; then
  echo "==> Downloading $WHISPER_MODEL"
  # -f so a bad model name fails here rather than as a confusing model-load
  # error after an HTML 404 page is saved as a .bin.
  #
  # Download to .part and rename on success: an interrupted download otherwise
  # leaves a truncated .bin that the existence check above skips forever.
  curl -fL --progress-bar \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WHISPER_MODEL" \
    -o "models/$WHISPER_MODEL.part"
  mv "models/$WHISPER_MODEL.part" "models/$WHISPER_MODEL"
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
