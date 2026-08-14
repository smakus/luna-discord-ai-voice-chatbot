# Luna — Discord AI Voice Assistant

Want a real AI voice chatbot in your Discord voice channel ready to answer questions or give advice (for entertainment purposes only)?  Then Luna is the AI assistant for you.

Responsibly coded with assitance from Claude for some audio conversion heavy lifting. If you find this fun, interesting, or valuable, [buy me a coffee](https://buymeacoffee.com/qgt11lbfad)!

Luna is a locally-hosted AI voice assistant for Discord. She listens for her wake word using a neural wake word model, transcribes speech using Whisper, generates responses via LM Studio, and speaks back using Kokoro TTS — all running on your own machine with no cloud AI dependencies.

## Features

- 🎤 Neural wake word detection — say "hey Luna" to activate, via [openWakeWord](https://github.com/dscripka/openWakeWord) running on the raw audio stream
- 🧠 Local LLM via LM Studio, with per-speaker conversation memory
- 🔊 Local TTS via Kokoro TTS with streaming audio output
- 🌐 Optional web search via Tavily MCP
- 👥 Multi-user support with per-user audio capture and per-user wake word detection
- ⚡ Low-latency streaming pipeline — LLM response streams sentence-by-sentence directly into TTS, so Luna starts speaking before she's finished generating
- 🔁 Interruptible — say "hey Luna" at any time to cut off *your own* answer, without interrupting someone else's
- 🗣️ Responses queue — with several people in a channel, a new question no longer cancels someone else's answer
- 🍎 Metal-accelerated Whisper on Apple Silicon
- 🔇 Configurable ignored users (e.g. music bots)

---

## How It Works

Wake word detection runs on the **raw audio stream**, before Whisper, and acts as a gate. Only utterances containing a detection are transcribed — cheaper than transcribing everything, and far more accurate than substring-matching a transcript:

```
You speak
    ↓  48kHz Opus from Discord
    ↓  anti-aliased decimation to 16kHz + automatic gain control
openWakeWord  (melspectrogram → embedding → classifier, one score per 80ms)
    ↓  (score ≥ threshold — gate opens)
    ↓  (1000ms silence detection)
Whisper transcribes locally          ← only runs after a detection
    ↓
LM Studio streams response tokens
    ↓  (sentence boundary detected)
Kokoro streams sentence 1 audio ──► Discord plays sentence 1
    ↓  (sentence 2 already being fetched in parallel)
Kokoro streams sentence 2 audio ──► Discord plays sentence 2
    ...
```

Key design decisions:

- **Wake word gates Whisper**: detection happens on the audio itself, so Whisper no longer transcribes every utterance in the channel. If the models fail to load, Luna falls back to the original behaviour — transcribe everything, then match the wake word in the text.
- **Per-speaker detectors**: each user gets an independent feature pipeline. Sharing one would interleave their audio and corrupt every detection. The ONNX sessions themselves are shared.
- **Pre-roll buffer**: the energy gate discards audio below `ENERGY_THRESHOLD`, which clips quiet word onsets — `s`, `f`, `th`, `wh`, `k`, `p`. Luna keeps the last `PREROLL_MS` of sub-threshold audio and prepends it, so Whisper receives the start of the word rather than guessing it.
- **Sentence-chunked TTS**: the LLM response is split into sentences as tokens arrive. Each sentence is sent to Kokoro immediately — Luna starts speaking the first sentence while the LLM is still generating the rest.
- **Prefetch pipeline**: Kokoro begins generating sentence N+1 while sentence N is still playing, eliminating gaps between sentences. Kokoro runs synthesis on a worker thread so this actually overlaps rather than serialising on the event loop.
- **Per-speaker conversation memory**: each speaker gets their own LM Studio chain, dropped after an idle timeout or a turn cap. A single shared chain carries no speaker attribution, so the model reads several people's turns as one self-contradicting user — and unbounded chains make every turn slower than the last.
- **Interrupt on wake word, scoped per speaker**: audio capture runs continuously regardless of whether Luna is speaking. A new wake word stops *that speaker's* current response; other speakers' queued responses are unaffected.

---

## Requirements

- macOS or Linux
- A Discord bot token
- [LM Studio](https://lmstudio.ai) with a loaded model (required regardless of install method)
- Docker
- A trained openWakeWord model (a basic trained version of 'hey luna' is provided, and works reasonably well) plus the two shared feature models (see step 2)
- **Optional but recommended**: A [Tavily](https://tavily.com) API key (free tier, for web search)

**Before you go further, read [Hardware sizing](#hardware-sizing).** Picking a model that doesn't fit your RAM is by far the most common way to end up with a 25-second voice assistant, and no amount of tuning elsewhere compensates for it.

---

## Installation

### 1. Clone the repo

```bash
git clone https://github.com/smakus/luna-discord-bot
cd luna-discord-bot
```

### 2. Wake word models

openWakeWord is a **three-model chain**, and a trained wake word model is only the last stage. It consumes speech embeddings, not audio — it cannot process a waveform on its own:

| Model | Input | Output | Where from |
| ----- | ----- | ------ | ---------- |
| `melspectrogram.onnx` | 16kHz PCM | 32-bin mel frames | shared, download below |
| `embedding_model.onnx` | 76 mel frames | 96-dim embedding | shared, download below |
| `hey_luna.onnx` | 16 embeddings | score 0–1 | **you train this yourself if the provided model isn't good enough** |

Download the two shared models into `Luna-Discord-Bot-Full-Docker/Luna/`:

```bash
cd Luna-Discord-Bot-Full-Docker/Luna
curl -LO https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx
curl -LO https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx
ls -la *.onnx     # both should be ~1MB+, not a few KB
```

Train your own wake word model with the official [Google Colab notebook](https://colab.research.google.com/drive/1q1oe2zOyZp7UsB3jJiQ1IFn8z5YfjwEb?usp=sharing) — about an hour, fully synthetic training data, no recording required. Use the phrase **"hey luna"**, export **ONNX**, and save it as `Luna/hey_luna.onnx`.

> **Use a multi-syllable phrase.** A single-word "luna" trains poorly — two syllables of common phonemes with no distinctive onset. Every official openWakeWord model is 3–4 syllables (`hey_jarvis`, `hey_mycroft`, `alexa`) for exactly this reason.

To check the model is working, set `OWW_DEBUG_SCORE=0.05` in `.env` and watch the logs while you speak. A healthy model peaks above 0.9 on the wake phrase and sits near 0.000 otherwise — see [Reading the scores](#reading-the-scores).

### 3. Set up LM Studio

1. Download and install [LM Studio](https://lmstudio.ai)
2. Download an instruction-tuned model sized for your machine — see [Hardware sizing](#hardware-sizing). LM Studio flags whether a model is fully GPU-offloadable on your hardware; trust that indicator.
3. Load the model, set GPU offload to maximum, and set context length to ~4096. Luna's prompts are short, and KV cache competes with the weights for the same memory.
4. Start the local server (green toggle in the Server tab). Bind to `0.0.0.0`, not just `127.0.0.1`, so Docker can reach it.
5. Enable authentication in LM Studio settings and copy the bearer token
6. Enable MCP in LM Studio if you want web search

### 4. Create a Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application and add a bot
3. Under **Privileged Gateway Intents**, enable:
   - Server Members Intent
   - Message Content Intent
   - Voice States
4. Copy the bot token
5. Invite the bot to your server with these permissions:
   - Read Messages / View Channels
   - Send Messages
   - Connect
   - Speak
   - Use Voice Activity

### 5. Configure environment variables

Create a `.env` file in `Luna-Discord-Bot-Full-Docker/Luna/` (see `example.env`):

```env
# Discord
DISCORD_TOKEN=your_discord_bot_token

# LM Studio — use host.docker.internal when running in Docker
LM_STUDIO_URL=http://host.docker.internal:1234/api/v1/chat
LM_STUDIO_MCP_BEARER_TOKEN=your_lm_studio_bearer_token

# Kokoro TTS — use the Docker service name when running in Docker Compose
KOKORO_URL=http://kokoro:8880/v1/audio/speech
KOKORO_VOICE=af_heart

# Tavily web search (optional)
TAVILY_API_KEY=your_tavily_api_key

# Comma-separated Discord user IDs to ignore (e.g. music bots)
IGNORED_USER_IDS=

# Wake word detection confidence. openWakeWord's default is 0.5; the right value
# depends entirely on your model — tune it against real scores, see Tuning below.
OWW_THRESHOLD=0.15

# Minimum audio energy to buffer speech for Whisper. Independent of wake word
# detection: the detector always sees every frame regardless of this.
ENERGY_THRESHOLD=175

# Audio kept from before the energy gate opens, so quiet word onsets survive.
PREROLL_MS=320
```

> **Note:** If running outside Docker, replace `host.docker.internal` with `127.0.0.1` and `kokoro` with `localhost`. Under Docker Compose, `LM_STUDIO_URL`, `KOKORO_URL` and `WHISPER_SERVER_URLS` are also set in the compose file, and those values take precedence over `.env`.

`.env` is excluded from the Docker build context, so your tokens are never baked into an image layer. Compose reads it from the host at runtime.

**Available Kokoro voices:**

| Voice         | Description                  |
| ------------- | ---------------------------- |
| `af_heart`    | American female (warm)       |
| `af_sarah`    | American female (clear)      |
| `af_bella`    | American female (expressive) |
| `af_sky`      | American female (bright)     |
| `bf_emma`     | British female               |
| `bf_isabella` | British female (formal)      |

### 6. Add a chime sound

Place a file named `chime.mp3` in `Luna-Discord-Bot-Full-Docker/Luna/`. This plays when Luna is activated. Any short MP3 works — keep it under 2 seconds.

### 7. Build

Two supported layouts. Pick one based on your hardware.

#### Apple Silicon (recommended on any M-series Mac)

Whisper runs natively with Metal; Kokoro and Luna run in containers.

Docker Desktop on Apple Silicon runs a Linux VM with no access to Metal, CoreML or the Neural Engine — it gets a slice of your CPU cores and nothing else. Whisper's encoder is exactly the workload the GPU exists for, so running it in a container on this hardware gives up the machine's main advantage.

```bash
cd Luna-Discord-Bot-Full-Docker

# Builds whisper.cpp with Metal and downloads the model. First run takes
# a few minutes; afterwards it starts immediately.
./scripts/whisper-metal.sh
```

Requires `cmake` (`brew install cmake`) and the Xcode command line tools (`xcode-select --install`).

Leave that running, and in a second terminal:

```bash
cd Luna-Discord-Bot-Full-Docker
docker compose -f docker-compose.metal.yml up --build
```

#### Linux, or Intel Mac

Everything in containers.

```bash
cd Luna-Discord-Bot-Full-Docker
docker compose up --build
```

This builds and starts three containers: **luna** (the Discord bot), **kokoro** (TTS), and **whisper** (speech-to-text).

> `npm install` is not required before building. The image runs `npm ci` against the committed lockfile, and `node_modules` is excluded from the build context. You only need a local install if you change `package.json`.

---

## Running Luna

Once the above is set up, day-to-day startup is:

**1.** Start LM Studio and load your model.

**2. Apple Silicon** — terminal 1:

```bash
cd Luna-Discord-Bot-Full-Docker
./scripts/whisper-metal.sh
```

Terminal 2:

```bash
cd Luna-Discord-Bot-Full-Docker
docker compose -f docker-compose.metal.yml up
```

**Linux / Intel Mac** — one terminal:

```bash
cd Luna-Discord-Bot-Full-Docker
docker compose up
```

Add `--build` to the compose command whenever you've edited a source file.

**Startup takes a minute or two, and that's intentional.** Kokoro renders a warm-up phrase before it reports healthy, and Luna waits for that. Luna then sends a warm-up request to LM Studio so the model's weights are resident before anyone asks a question — otherwise that entire cost lands on whoever speaks first.

A healthy start looks like:

```
[kokoro] warm — threads=2, concurrency=2, voice=af_heart
Using LM Studio model: <your-model>
[oww] loaded hey_luna.onnx (input="onnx::Flatten_0", window=16 frames)
[oww] seeded feature buffer with 50 noise embeddings (baseline score 0.0009)
[oww] active — threshold=0.15, Whisper gated on detection
[LLM] warm — first inference took 4200ms. ...
Ready! Wake phrase: "hey Luna"  •  text command: !luna
```

Things to check in that output:

- **baseline score** is your model scoring pure noise. If it is anywhere near your threshold, the model will false-fire constantly — fix that before debugging anything else.
- **`[oww] unavailable (...)`** means the models aren't in place and Luna has fallen back to transcript matching. Still functional, just less accurate and more expensive.
- **`[LLM] warm`** reports how long the first inference took. If that number is tens of seconds, your model is too large for your RAM — see [Hardware sizing](#hardware-sizing).

To shut down: `Ctrl-C`, then `docker compose down` (add `-f docker-compose.metal.yml` on the Metal path), then `Ctrl-C` in the Whisper terminal.

### Optional: shell aliases

```bash
# ~/.zshrc or ~/.bashrc
alias luna-whisper='cd ~/luna-discord-bot/Luna-Discord-Bot-Full-Docker && ./scripts/whisper-metal.sh'
alias luna-up='cd ~/luna-discord-bot/Luna-Discord-Bot-Full-Docker && docker compose -f docker-compose.metal.yml up'
```

---

## Usage

1. Join a Discord voice channel
2. In any text channel, type `!luna`
3. Luna will join your voice channel
4. Say **"hey Luna"** followed by your question or command

**Examples:**

- *"Hey Luna, what's the weather today?"* — triggers web search via Tavily
- *"Hey Luna, tell me a joke"* — direct LLM response
- *"Hey Luna, what did I just ask you?"* — uses conversation memory
- *"Hey Luna, play Bohemian Rhapsody"* — triggers music bot integration

**Say the wake phrase as one continuous run.** Discord only transmits while you are speaking, so a deliberate pause between "hey" and "Luna" gets dropped from the stream entirely. Luna reconstructs that silence from packet timings, but a natural delivery still works best.

**Interrupting Luna:** say "hey Luna" at any point while she is answering *you* to interrupt and ask something new. This is scoped per speaker — interrupting no longer cancels an answer Luna is giving to someone else. Barge-in only takes effect once the LLM has finished generating; utterances during generation are buffered, not lost.

**Web search** fires when the query looks like it needs current information. Entity terms (`price`, `weather`, `score`) and unambiguous recency phrases (`the latest`, `any news`, `release date`) trigger it on their own. Bare time words like "today" only count when paired with a subject whose answer changes — so *"what's the weather today"* searches and *"how are you doing today"* does not.

---

## Hardware sizing

**The LLM is almost always your latency.** Once Whisper and Kokoro are set up correctly they are sub-second; a model that doesn't fit your RAM will take 25 seconds to produce eight tokens. On unified-memory Macs, macOS also caps how much memory the GPU may wire — roughly two thirds of total — so a model larger than that ceiling cannot be fully offloaded no matter what LM Studio says.

Rough budget, since the LLM shares the machine with everything else:

| Consumer | Approx |
| -------- | ------ |
| OS + apps | ~4 GB |
| Docker (Kokoro's torch + Luna) | ~3–4 GB |
| Whisper | ~0.5–1 GB |

Whatever's left is your LLM budget, weights plus KV cache:

| Total RAM | Realistic LLM |
| --------- | ------------- |
| 16 GB | 7–8B at Q4 |
| 24 GB | 12–14B at Q4 |
| 32 GB+ | 24–27B at Q4 |

If you're unsure whether your model fits, watch memory while Luna answers. On macOS, Activity Monitor → Memory: yellow or red pressure, or swap in the gigabytes, means it doesn't. On Linux, `vmstat 1` and watch `si`/`so`.

For a voice assistant producing two-sentence spoken replies, a smaller model that answers in 2 seconds beats a larger one that answers in 25 — you will notice the latency constantly and the capability difference almost never.

### Whisper tuning

On the Metal path the model is an env var:

```bash
WHISPER_MODEL=ggml-small.en-q5_1.bin ./scripts/whisper-metal.sh
```

| Model | Size | Notes |
| ----- | ---- | ----- |
| `ggml-base.en-q5_1.bin` | ~60 MB | Fastest, least accurate |
| `ggml-small.en-q5_1.bin` | ~180 MB | Good default when memory is tight |
| `ggml-medium.en-q5_0.bin` | ~540 MB | Noticeably more accurate; the Metal default |
| `ggml-large-v3-turbo-q5_0.bin` | ~570 MB | Most accurate; needs headroom |

On the Docker path it's a build arg in `docker-compose.yml`, and `WHISPER_THREADS` sets CPU threads. `-bs 1 -bo 1` (greedy decoding) favours speed; raising them improves accuracy at real latency cost.

whisper.cpp is pinned to a specific release in `Whisper/Dockerfile` and `scripts/whisper-metal.sh`. Bump it deliberately — server CLI flags have changed between versions.

---

## Tuning

Environment variables in `Luna/.env`. Most take effect with a container recreate (`docker compose up -d --force-recreate luna`) rather than a full rebuild.

### Wake word

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `OWW_ENABLED` | `true` | `false` reverts to transcript matching |
| `OWW_MODEL_PATH` | `./hey_luna.onnx` | Your trained classifier |
| `OWW_MELSPEC_PATH` | `./melspectrogram.onnx` | Shared feature model |
| `OWW_EMBEDDING_PATH` | `./embedding_model.onnx` | Shared feature model |
| `OWW_THRESHOLD` | `0.5` | Detection confidence |
| `OWW_TRIGGER_FRAMES` | `1` | Consecutive frames above threshold required |
| `OWW_REFRACTORY_MS` | `1500` | Ignore re-fires after a detection |
| `OWW_GRACE_MS` | `2000` | How far before an utterance a detection still counts |
| `OWW_GAIN` | `auto` | `auto`, `off`, or a fixed multiplier |
| `OWW_AGC_TARGET_RMS` | `4000` | Level the AGC normalises toward |
| `OWW_DEBUG_SCORE` | `0` | Log every score at or above this |

### Audio gate

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `ENERGY_THRESHOLD` | `300` | Minimum audio energy level to count as speech |
| `SILENCE_MS` | `1000` | ms of silence before processing utterance |
| `MIN_SPEECH_MS` | `300` | Minimum utterance length to bother transcribing |
| `MAX_SPEECH_MS` | `15000` | Force-flush after this much unbroken speech |
| `MAX_SILENCE_FILL_MS` | `2000` | Max silence reconstructed across packet gaps |
| `PREROLL_MS` | `320` | Audio kept from *before* the gate opens |

`PREROLL_MS` exists because `ENERGY_THRESHOLD` clips word onsets. Unvoiced consonants sit below the threshold for 50–150 ms, so without pre-roll the audio Whisper receives starts mid-word and Whisper guesses the rest: *"what's the score"* arrives as *"the score"*. Raise it if first words still go missing; `0` restores the old behaviour. `MIN_SPEECH_MS` is measured against real speech only, so pre-roll doesn't weaken that gate.

`SILENCE_MS` is a flat second added to every interaction and is usually the largest remaining fixed latency. Lowering it to ~700 is worth trying; too low and Luna cuts you off mid-thought.

### Conversation memory

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `LM_MEMORY_TTL_MS` | `600000` | Drop a speaker's chain after this much silence |
| `LM_MEMORY_MAX_TURNS` | `12` | Drop a speaker's chain after this many turns |
| `LM_WARMUP` | `true` | Send a warm-up request at startup |

Memory is per speaker. Both caps bound prefill: the chain grows with every turn and prefill cost is linear in context, so an unbounded chain makes each answer slower than the last.

### TTS server

Set in the compose file, not `.env`.

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `KOKORO_THREADS` | `2` | torch intra-op threads |
| `KOKORO_MAX_CONCURRENCY` | `2` | Simultaneous syntheses |

torch otherwise takes one thread per core, and because sentence N+1 is prefetched while N plays, that collides with the LLM still generating sentence N+2.

### Timeouts

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `WHISPER_TIMEOUT_MS` | `60000` | |
| `LM_TIMEOUT_MS` | `120000` | |
| `KOKORO_TIMEOUT_MS` | `30000` | Awaited inside the shared playback chain |

**Tips:**

- If Luna triggers on background noise, **increase** `OWW_THRESHOLD`
- If Luna misses the wake word, **decrease** `OWW_THRESHOLD` — but check the peak scores first
- If Luna cuts you off too early, **increase** `SILENCE_MS`
- **Setting `ENERGY_THRESHOLD` too low is worse than too high** — see Troubleshooting

### Reading the scores

Set `OWW_DEBUG_SCORE=0.05` and watch the logs while speaking normally:

```
[oww] score=0.646 gain=1.7x rms=2108
```

Every discarded utterance also reports the model's best score across it:

```
utterance discarded — no wake word (2100ms, peak score 0.234, threshold 0.15)
```

That peak is the fastest diagnostic available:

| Peak on a missed attempt | Meaning | Action |
| ------------------------ | ------- | ------ |
| Just under threshold | Threshold too high | Lower `OWW_THRESHOLD` |
| `0.00x` | Model didn't react at all | Tuning won't help — retrain |
| No line logged | Audio never reached the gate | Problem is upstream |

Compare against the baseline printed at startup. If noise scores 0.001 and your wake word scores 0.6, you have a wide margin and can lower the threshold safely. If detections fire at 0.23 while ordinary conversation reaches 0.10, the margin is thin — and neither raising the threshold nor `OWW_TRIGGER_FRAMES=2` is safe. Retrain instead.

Deeper detail on the openWakeWord port: [`Luna/openWakeWordNotes.md`](Luna-Discord-Bot-Full-Docker/Luna/openWakeWordNotes.md).

---

## Troubleshooting

Luna logs a `[health]` line every 30 seconds per speaker, which is where most diagnosis starts:

```
[health] 73473[audio 0s ago, frames 254, peak30s 0.937, qdepth 0, flushing false, buffered 0]
```

| Field | Meaning | Bad sign |
| ----- | ------- | -------- |
| `audio Ns ago` | Last packet received | Frozen while you're speaking |
| `frames` | Chunks the detector processed | Not increasing |
| `peak30s` | Best score in the last 30s | `0.00x` while saying the wake phrase |
| `qdepth` | Inference backlog | Climbing toward 25 — CPU starved |
| `flushing` | A request is in flight | Stuck `true` for minutes |
| `buffered` | Chunks awaiting flush | Hundreds while `flushing false` |

Luna also logs three timings per exchange. Whichever dominates is your bottleneck:

```
[timing] Whisper done: 843ms
[timing] First LLM sentence: 2100ms
[timing] First audio start: 2560ms
```

**Responses take 20+ seconds** — the model is too large for your RAM. See [Hardware sizing](#hardware-sizing). Nothing else will fix this.

**Luna doesn't respond to the wake word** — check the peak score on the discarded utterance. Near your threshold, lower `OWW_THRESHOLD`. If it's `0.00x`, the model didn't recognise the phrase and no threshold will help.

**Luna answers once, then stops responding** — `buffered` climbing into the hundreds while `flushing` reads `false` means the energy gate never closed: an utterance only ends after `SILENCE_MS` of audio below `ENERGY_THRESHOLD`. If that sits under your room's noise floor, the utterance never ends and that speaker buffers audio indefinitely. Raise `ENERGY_THRESHOLD`. The most common cause is Luna hearing herself through your speakers. **Headphones fix this outright.**

**Wake word fires inconsistently** — bimodal scores (≈0.9 or ≈0.001, nothing between) are never a threshold problem. Usually the phrase was spoken with a pause Discord dropped from the stream, so the detector received a compressed "heyLuna". Say it as one continuous run.

**I have to speak loudly for it to trigger** — `OWW_GAIN=auto` normalises detector input toward `OWW_AGC_TARGET_RMS`; it only ever boosts, so it cannot regress a working setup. If `gain` reads `1.0x` while you speak, raise the target. Also turn off Discord's **Noise Suppression** and **Automatic Gain Control**, both of which work against wake word models.

**Whisper returns empty transcripts** — Whisper runs as its own server. On the Metal path, check the terminal running `whisper-metal.sh`. In Docker, `docker compose logs -f whisper`.

**Whisper is slow** — on Apple Silicon, use the Metal path; a containerised Whisper has no GPU access. On Linux, lower `WHISPER_THREADS` before adding containers; the bottleneck is total core contention, not parallelism.

**Kokoro is slow on the first request** — the warm-up failed. Check for `[kokoro] warm` in the logs; the failure message says why.

**LM Studio not reachable from Docker** — ensure its server is bound to `0.0.0.0`, not just `127.0.0.1`.

**No audio in voice channel** — check the bot has **Connect** and **Speak** permissions.

**Answers get truncated when several people are talking** — should no longer happen; the activation chime is suppressed while audio is playing. If you still see it, file an issue with the surrounding logs.

---

## Licensing note

The openWakeWord **code** is Apache-2.0, and so are the two feature models (`melspectrogram.onnx`, `embedding_model.onnx`). Those are fine to ship.

The **pre-trained wake word models** — `hey_jarvis`, `alexa`, `hey_mycroft` — are **CC BY-NC-SA 4.0 (non-commercial)**, because their training data includes datasets with restrictive licensing. They're excellent for validating your pipeline, but don't ship them in a commercial deployment. A model you train yourself carries no such restriction.

---

## Advanced — Red-DiscordBot Music Integration (VoiceBridge)

If you run [Red-DiscordBot](https://github.com/Cog-Creators/Red-DiscordBot) with the Audio cog in the same server, you can give Luna the ability to control music playback by saying *"hey Luna, play [song name]"*.

Luna detects "play", "play song", or "play music" immediately following the wake word, extracts the song name, and posts `!play <song>` to the text channel. Because Discord bots ignore messages from other bots by default, a small Red cog called **VoiceBridge** whitelists Luna's user ID and relays the command to Red's Audio cog.

**1.** Right-click Luna in Discord (with Developer Mode enabled) and copy her user ID.

**2.** Copy the cog into your Red-DiscordBot cogs directory:

```bash
cp -r voicebridge/ /path/to/redbot/cogs/voicebridge/
```

**3.** In `voicebridge.py`, replace `AI_BOT_ID` with Luna's actual Discord user ID:

```python
AI_BOT_ID = 123456789012345678  # Luna's Discord user ID
```

**4.** Load it in Red:

```
[p]load voicebridge
```

**5.** Say *"Hey Luna, play Bohemian Rhapsody"*. Luna posts `!play Bohemian Rhapsody`, VoiceBridge intercepts it and invokes Red's Audio cog.

---

## Known limitations

- Detection lags audio by up to ~160ms (80ms accumulation granularity plus inference).
- Barge-in only works once the LLM has finished generating; utterances during generation are buffered.
- Conversation memory is per speaker, so Luna can't follow a question that refers to what someone *else* just asked.
- `SILENCE_MS` adds a flat ~1s of endpointing latency to every interaction.
- English only — openWakeWord's synthetic training data is English-based.

## License

MIT
