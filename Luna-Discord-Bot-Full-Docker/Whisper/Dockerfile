FROM alpine:3.19

RUN apk add --no-cache cmake make g++ git curl

WORKDIR /whisper

RUN git clone https://github.com/ggerganov/whisper.cpp . && \
    cmake -B build && cmake --build build --target whisper-server -j4

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
CMD ["sh", "-c", "./build/bin/whisper-server \
     -m /opt/whisper/models/${WHISPER_MODEL} \
     --host 0.0.0.0 --port 8080 \
     -t ${WHISPER_THREADS:-4} -bs 1 -bo 1"]
