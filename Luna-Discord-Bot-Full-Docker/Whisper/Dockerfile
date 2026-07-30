FROM alpine:3.19

RUN apk add --no-cache cmake make g++ git curl

WORKDIR /whisper

RUN git clone https://github.com/ggerganov/whisper.cpp . && \
    cmake -B build && cmake --build build --target whisper-server -j4

RUN mkdir -p /opt/whisper/models && \
    curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en-q5_0.bin \
    -o /opt/whisper/models/ggml-medium.en-q5_0.bin

EXPOSE 8080

CMD ["./build/bin/whisper-server", "-m", "/opt/whisper/models/ggml-medium.en-q5_0.bin", \
     "--host", "0.0.0.0", "--port", "8080", "-t", "8", "-bs", "1", "-bo", "1"]
