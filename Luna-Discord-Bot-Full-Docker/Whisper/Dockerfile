FROM alpine:3.19

RUN apk add --no-cache cmake make g++ git curl

WORKDIR /whisper

# Pinned, not tracking master.
#
# `git clone` of the default branch made every rebuild a different build, and
# the server's CLI has changed across releases (`-fa` gained a `-nfa` partner,
# `/health` was added). An unpinned clone can turn a working image into one that
# exits on an unknown argument months after the last code change here. Bump
# this deliberately.
#
# v1.9.2 also enables flash attention by default, which the v1.7.x builds did
# not — a free encoder speedup on any backend that implements it.
ARG WHISPER_REF=v1.9.2
RUN git clone --depth 1 --branch ${WHISPER_REF} \
      https://github.com/ggerganov/whisper.cpp . && \
    cmake -B build -DCMAKE_BUILD_TYPE=Release && \
    cmake --build build --target whisper-server -j "$(nproc)"

# Model as a build arg so swapping sizes is a one-line change.
#
# small.en-q5_1 (~180 MB) is roughly 3-5x faster than medium.en-q5_0 (~540 MB)
# with modest accuracy loss on clear speech — a good trade when the CPU is also
# running Kokoro and a 12B LLM. Drop to ggml-base.en-q5_1.bin if still CPU-bound,
# or go back to ggml-medium.en-q5_0.bin if you have headroom and want accuracy.
ARG WHISPER_MODEL=ggml-small.en-q5_1.bin
ENV WHISPER_MODEL=${WHISPER_MODEL}

# -f so a bad model name fails the build instead of silently writing an HTML
# error page that later dies as a confusing model-load error.
RUN mkdir -p /opt/whisper/models && \
    curl -fL https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL} \
    -o /opt/whisper/models/${WHISPER_MODEL}

EXPOSE 8080

# Threads overridable at runtime; see docker-compose.yml.
#
# -nt (no timestamps): Luna reads only the `text` field, and suppressing
# timestamp tokens removes roughly one decoded token per word from a decode
# that is already the latency-critical path.
CMD ["sh", "-c", "./build/bin/whisper-server \
     -m /opt/whisper/models/${WHISPER_MODEL} \
     --host 0.0.0.0 --port 8080 \
     -t ${WHISPER_THREADS:-4} -bs 1 -bo 1 -nt"]
