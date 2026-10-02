# NOTE: this image is Debian-based, not Alpine.
#
# onnxruntime-node ships prebuilt native binaries linked against glibc and
# publishes no musl build, so it cannot load on node:*-alpine. Switching the
# base image is a hard requirement for openWakeWord support.
#
# Node 22, not 20: @discordjs/voice@0.19.2 declares `engines.node >=22.12.0`.
# On Node 20 npm only warns (EBADENGINE) and installs anyway, leaving the voice
# stack running on an unsupported runtime.
#
# Two stages, so nothing used only for installing ends up in the image Luna
# runs from (2.04 GB → 1.01 GB).

# ── Stage 1: install dependencies ─────────────────────────────────────────────
FROM node:22-slim AS deps

# python3/make/g++ are only needed as a fallback if a native dependency
# (@discordjs/opus) has no prebuilt binary for this platform. They stay in this
# stage; the runtime image never sees them.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./

# - npm's download cache is dead weight once installed.
# - onnxruntime-node ships native binaries for every platform it supports
#   (~260 MB); only the one for this image's platform/arch is ever loaded.
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && node -e " \
      const fs = require('fs'), path = require('path'); \
      const base = 'node_modules/onnxruntime-node/bin'; \
      for (const napi of fs.readdirSync(base)) \
        for (const plat of fs.readdirSync(path.join(base, napi))) \
          for (const arch of fs.readdirSync(path.join(base, napi, plat))) \
            if (plat !== process.platform || arch !== process.arch) \
              fs.rmSync(path.join(base, napi, plat, arch), { recursive: true, force: true });"

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-slim

# ffmpeg decodes the TTS audio (Kokoro WAV, ElevenLabs MP3) for Discord.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

CMD ["node", "index.js"]
