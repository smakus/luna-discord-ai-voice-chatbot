# NOTE: this image is Debian-based, not Alpine.
#
# onnxruntime-node ships prebuilt native binaries linked against glibc and
# publishes no musl build, so it cannot load on node:*-alpine. Switching the
# base image is a hard requirement for openWakeWord support.
#
# Node 22, not 20: @discordjs/voice@0.19.2 declares `engines.node >=22.12.0`.
# On Node 20 npm only warns (EBADENGINE) and installs anyway, leaving the voice
# stack running on an unsupported runtime.
FROM node:22-slim

# python3/make/g++ are only needed as a fallback if a native dependency
# (@discordjs/opus) has no prebuilt binary for this platform. Safe to drop if
# your builds always resolve prebuilds.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      curl \
      ca-certificates \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "index.js"]
