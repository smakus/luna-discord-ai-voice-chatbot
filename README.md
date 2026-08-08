
Running on this device
Claude finished the response
Restart your computer to finish setup.

Searched the web
Searched the web
That's more detailed than the rendered version I saw earlier — it has the Whisper server tuning table and updated troubleshooting I'd have dropped. Rewriting against the real source, preserving your structure and only changing what actually changed:


Created a file, read a file
Created a file, read a file
Rebuilt from your actual README — same voice, same section order, same tables. Your Whisper flags table, the whisper-container troubleshooting, the VoiceBridge walkthrough and the .env block format are all preserved rather than rewritten.

Changed only where the code changed:

Features / How It Works — wake word is now neural and gates Whisper; pipeline diagram shows the gate
New step 2 — the three-model chain, downloads, training notebook, test-wakeword.js validation
New step 3 — npm install before first build, since npm ci fails on a stale lockfile
Step 4 — three containers, with a note on why the second Whisper instance was removed
.env — added OWW_THRESHOLD and ENERGY_THRESHOLD inline, kept your existing block intact
Tuning — moved from "constants in index.js" to env var tables, plus how to read the scores
Troubleshooting — kept all your entries, updated the wake word one, added the failure modes we hit
Whisper tuning table — kept, updated for the build arg and WHISPER_THREADS
Two additions worth calling out since they weren't in the original: a Licensing note about the CC BY-NC-SA pre-trained models, and Known limitations stating the barge-in and shared-memory constraints plainly.

One correction to your existing text: the .env note now mentions that LM_STUDIO_URL and KOKORO_URL set in docker-compose.yml take precedence over .env under Compose. The old wording implied .env was authoritative, which would be confusing for anyone who edited it and saw no effect.


C:\Users\smak\Downloads\claude\README.md
Document 

C:\Users\smak\Downloads\claude\Luna-Discord-Bot-Full-Docker\Luna\example.env
 
do we need test-wakeword.js?  or can we remove it


Thought process
Thought process
Keep it — it's the only way to test a model without a full rebuild cycle, and you'll want that if you retrain. It costs about 5KB and nothing at runtime; index.js never imports it.

It earned its keep twice already: it's how you'd have caught the missing feature models before a build, and it's the cross-check against Python openWakeWord if you ever suspect the port rather than the model.

The one legitimate objection is that it ships inside the Docker image, where it's dead weight. Fixing that instead:


Read 2 files, created a file
Read 2 files, created a file
Now it stays in the repo for development but doesn't ship in the image. I also excluded OPENWAKEWORD.md and example.env for the same reason, and added .DS_Store since you're on a Mac and it was getting copied in.

You run it on the host, where node_modules already exists from npm install:

cd Luna-Discord-Bot-Full-Docker/Luna
node test-wakeword.js recording.wav --all
If you'd still rather delete it, the only real cost is that validating a retrained model means a Docker rebuild and a live Discord test each time, instead of a two-second command — and you'd want to drop the reference in README step 2.


C:\Users\smak\Downloads\claude\Luna-Discord-Bot-Full-Docker\Luna\.dockerignore
 
ok let's drop it. i prefer live tests.  Please update the readme


Loaded tools, searched code
Loaded tools, searched code
Five references across the two docs. Updating all of them.


Edited 6 files, read a file
Edited 6 files, read a file
All five references are gone, replaced with the live-log equivalent (OWW_DEBUG_SCORE=0.05) — which you were using in practice anyway.

Delete the file yourself, since the shell isn't available on this machine:

rm Luna-Discord-Bot-Full-Docker/Luna/test-wakeword.js
What changed:

README step 2 — the offline validation block is now a pointer to score-reading in the logs
OPENWAKEWORD.md — validation section, post-retrain check, and the file table all updated
Known limitations — reworded the resampler note, which only existed to explain how to cross-check against Python
.dockerignore — dropped the entry, kept OPENWAKEWORD.md and example.env excluded
npm install is still required before your first build (step 3) — that's the lockfile requirement for npm ci, unrelated to the test harness.


C:\Users\smak\Downloads\claude\README.md
Document 

C:\Users\smak\Downloads\claude\Luna-Discord-Bot-Full-Docker\Luna\OPENWAKEWORD.md
Document 

C:\Users\smak\Downloads\claude\Luna-Discord-Bot-Full-Docker\Luna\.dockerignore
 




Claude is AI and can make mistakes. Please double-check responses.


Readme · MD
# Luna — Discord AI Voice Assistant
 
Responsibly Vibecoded with Claude.  If you find this fun, interesting, or valuable, [buy me a coffee](https://buymeacoffee.com/qgt11lbfad)!
 
Luna is a locally-hosted AI voice assistant for Discord. She listens for her wake word using a neural wake word model, transcribes speech using Whisper, generates responses via LM Studio, and speaks back using Kokoro TTS — all running on your own machine with no cloud AI dependencies.
 
## Features
 
- 🎤 Neural wake word detection — say "hey Luna" to activate, via [openWakeWord](https://github.com/dscripka/openWakeWord) running on the raw audio stream
- 🧠 Local LLM via LM Studio with conversation memory
- 🔊 Local TTS via Kokoro TTS with streaming audio output
- 🌐 Optional web search via Tavily MCP
- 👥 Multi-user support with per-user audio capture and per-user wake word detection
- ⚡ Low-latency streaming pipeline — LLM response streams sentence-by-sentence directly into TTS, so Luna starts speaking before she's finished generating
- 🔁 Interruptible — say "hey Luna" at any time to cut off *your own* answer, without interrupting someone else's
- 🗣️ Responses queue — with several people in a channel, a new question no longer cancels someone else's answer
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
- **Sentence-chunked TTS**: the LLM response is split into sentences as tokens arrive. Each sentence is sent to Kokoro immediately — Luna starts speaking the first sentence while the LLM is still generating the rest.
- **Prefetch pipeline**: Kokoro begins generating sentence N+1 while sentence N is still playing, eliminating gaps between sentences.
- **Streaming audio**: Kokoro streams WAV chunks directly to Discord rather than buffering the full audio file first.
- **Interrupt on wake word, scoped per speaker**: audio capture runs continuously regardless of whether Luna is speaking. A new wake word stops *that speaker's* current response; other speakers' queued responses are unaffected.
---
 
## Requirements
 
- macOS or Linux
- A Discord bot token
- [LM Studio](https://lmstudio.ai) with a loaded model (required regardless of install method)
- Docker (for the recommended install)
- A trained openWakeWord model plus the two shared feature models (see step 2)
- **Optional but recommended**: A [Tavily](https://tavily.com) API key (free tier, for web search)
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
| `hey_luna.onnx` | 16 embeddings | score 0–1 | **you train this** |
 
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
 
### 3. Install Node dependencies
 
```bash
cd Luna-Discord-Bot-Full-Docker/Luna
npm install
```
 
Required before the first Docker build: the image uses `npm ci`, which fails on a lockfile that doesn't match `package.json`.
 
### 4. Docker Installation (recommended)
 
The repo includes a `Luna-Discord-Bot-Full-Docker/` directory with a Docker Compose setup that runs Luna, Whisper, and the Kokoro TTS server together.
 
```bash
cd Luna-Discord-Bot-Full-Docker
docker compose up --build
```
 
This builds and starts three containers:
- **luna** — the Discord bot (Node.js)
- **kokoro** — the local TTS server (Python/FastAPI)
- **whisper** — the local Whisper speech-to-text server (whisper.cpp)
> **Note:** earlier versions ran two Whisper instances for parallelism. That turned out to starve LM Studio of cores on a single machine — transcription of a 2s clip was taking 9–11s. One container on a smaller model is substantially faster overall. See [Performance](#performance).
 
### 5. Set up LM Studio
 
1. Download and install [LM Studio](https://lmstudio.ai)
2. Download a model — recommended: **Qwen3.5 9B** or any instruction-tuned model that fits your RAM
3. Load the model and start the local server (green toggle in the Server tab)
4. Enable authentication in LM Studio settings and copy the bearer token
5. Enable MCP in LM Studio if you want web search (see `.env` setup below)
### 6. Create a Discord bot
 
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
### 7. Configure environment variables
 
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
ENERGY_THRESHOLD=150
```
 
> **Note:** If running outside Docker, replace `host.docker.internal` with `127.0.0.1` and `kokoro` with `localhost`. Under Docker Compose, `LM_STUDIO_URL`, `KOKORO_URL` and `WHISPER_SERVER_URLS` are also set in `docker-compose.yml`, and those values take precedence over `.env`.
 
**Available Kokoro voices:**
 
| Voice         | Description                  |
| ------------- | ---------------------------- |
| `af_heart`    | American female (warm)       |
| `af_sarah`    | American female (clear)      |
| `af_bella`    | American female (expressive) |
| `af_sky`      | American female (bright)     |
| `bf_emma`     | British female               |
| `bf_isabella` | British female (formal)      |
 
### 8. Add a chime sound
 
Place a file named `chime.mp3` in the `Luna-Discord-Bot-Full-Docker/Luna/` directory. This plays when Luna is activated. Any short MP3 works — keep it under 2 seconds.
 
---
 
## Running Luna
 
1. Start LM Studio, load your model, and ensure the local server is running
2. From the `Luna-Discord-Bot-Full-Docker/` directory:
```bash
docker compose up --build -d
```
 
3. Check logs:
```bash
docker compose logs -f luna
docker compose logs -f kokoro
docker compose logs -f whisper
```
 
A healthy start looks like:
 
```
[oww] loaded hey_luna.onnx (input="onnx::Flatten_0", window=16 frames)
[oww] seeded feature buffer with 50 noise embeddings (baseline score 0.0009)
[oww] active — threshold=0.15, Whisper gated on detection
Ready! Wake phrase: "hey Luna"  •  text command: !luna
```
 
That **baseline score** is your model scoring pure noise. If it is anywhere near your threshold, the model will false-fire constantly — fix that before debugging anything else.
 
If you see `[oww] unavailable (...)` instead, the models aren't in place and Luna has fallen back to transcript matching. Still functional, just less accurate and more expensive.
 
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
 
**Interrupting Luna:**
 
You can say "hey Luna" at any point while she is answering *you* to interrupt and ask something new. This is scoped per speaker — interrupting no longer cancels an answer Luna is giving to someone else. Note that barge-in only takes effect once the LLM has finished generating; utterances during generation are buffered, not lost.
 
---
 
## Tuning
 
Everything below is an environment variable set in `Luna/.env`. Most take effect with a container recreate (`docker compose up -d --force-recreate luna`) rather than a full rebuild.
 
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
| `MIN_SPEECH_MS` | `300` | Minimum utterance length (ms) to bother transcribing |
| `MAX_SPEECH_MS` | `15000` | Force-flush after this much unbroken speech |
| `MAX_SILENCE_FILL_MS` | `2000` | Max silence reconstructed across packet gaps |
 
### Timeouts
 
| Variable | Default | Description |
| -------- | ------- | ----------- |
| `WHISPER_TIMEOUT_MS` | `60000` | |
| `LM_TIMEOUT_MS` | `120000` | |
| `KOKORO_TIMEOUT_MS` | `30000` | Awaited inside the shared playback chain |
 
**Tips:**
- If Luna triggers on background noise, **increase** `OWW_THRESHOLD`
- If Luna misses the wake word, **decrease** `OWW_THRESHOLD` — but check the peak scores first (below)
- If Luna cuts you off too early, **increase** `SILENCE_MS`
- If Luna feels sluggish to respond, **decrease** `SILENCE_MS`
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
 
Deeper detail, including the internals of the port: [`Luna/OPENWAKEWORD.md`](Luna-Discord-Bot-Full-Docker/Luna/OPENWAKEWORD.md).
 
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
 
**Luna doesn't respond to the wake word**
Check the peak score on the discarded utterance (see Tuning). If it's near your threshold, lower `OWW_THRESHOLD`. If it's `0.00x`, the model didn't recognise the phrase and no threshold will help.
 
**Luna answers once, then stops responding**
`buffered` climbing into the hundreds while `flushing` reads `false` means the energy gate never closed: an utterance only ends after `SILENCE_MS` of audio *below* `ENERGY_THRESHOLD`. If that sits under your room's noise floor, the utterance never ends and that speaker buffers audio indefinitely. Raise `ENERGY_THRESHOLD`.
 
The most common cause is Luna hearing herself — her voice plays through your speakers, back into your mic, and the loop never closes. **Headphones fix this outright.**
 
If `flushing` is stuck `true` instead, a request never returned; the timeouts will surface it in the logs within a couple of minutes.
 
**Wake word fires inconsistently — great sometimes, nothing other times**
Bimodal scores (≈0.9 or ≈0.001, nothing between) are never a threshold problem. Usually the phrase was spoken with a pause that Discord dropped from the stream, so the detector received a compressed "heyLuna". Say it as one continuous run.
 
**I have to speak loudly for it to trigger**
Models trained on synthetic TTS without volume augmentation are often level-sensitive. `OWW_GAIN=auto` normalises the detector input toward `OWW_AGC_TARGET_RMS`; it only ever boosts, so it cannot regress a working setup. If `gain` reads `1.0x` while you speak, your target is at or below your natural level — raise it. Also turn off Discord's **Noise Suppression** and **Automatic Gain Control**, both of which work against wake word models.
 
**Whisper returns empty transcripts**
Whisper runs as its own persistent server (the `whisper` container), not inside `luna`. Check its logs first — you should see `whisper_model_load: loading model` once at startup:
```bash
docker compose logs -f whisper
```
Test the server directly:
```bash
curl -X POST http://localhost:8081/inference \
  -F file="@/tmp/test.wav" \
  -F response_format="json"
```
 
**Whisper is slow**
Transcription should take 2–3s. If it takes 9–11s the machine is oversubscribed — Whisper is competing with Kokoro and LM Studio for the same cores. Lower `WHISPER_THREADS` in `docker-compose.yml` before adding containers.
 
**Kokoro TTS not working**
Test the server directly:
```bash
curl -X POST http://localhost:8880/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello, I am Luna.", "stream": false}' \
  --output test.wav && afplay test.wav
```
 
**LM Studio not responding from Docker**
Ensure LM Studio's server is running and bound to `0.0.0.0` (not just `127.0.0.1`) so Docker can reach it via `host.docker.internal`. Test:
```bash
curl http://host.docker.internal:1234/api/v1/models \
  -H "Authorization: Bearer $LM_STUDIO_MCP_BEARER_TOKEN"
```
 
**No audio in voice channel**
Make sure the bot has **Connect** and **Speak** permissions in your Discord server.
 
**Sentences with numbers sound split up**
This is handled automatically — the sentence splitter ignores periods inside decimal numbers (e.g. `$403.80` won't be split) and single-letter initials (e.g. "George W. Bush"). Multi-letter abbreviations like "Mr." still split; adjust the `SENTENCE_END` regex in `index.js` if they become audible.
 
---
 
## Performance
 
Everything here shares one machine with LM Studio, and total core contention — not lack of parallelism — is the usual bottleneck.
 
**Whisper server tuning:**
 
The model is a build arg in `Whisper/Dockerfile`, and threads are set in `docker-compose.yml`:
 
| Setting | Default | Description |
| ------- | ------- | ----------- |
| `WHISPER_MODEL` | `ggml-small.en-q5_1.bin` | Build arg. `ggml-base.en-q5_1.bin` is faster, `ggml-medium.en-q5_0.bin` more accurate |
| `WHISPER_THREADS` | `4` | CPU threads to use for inference |
| `-bs` | `1` | Beam size (1 = greedy decoding, fastest) |
| `-bo` | `1` | Best-of candidates (1 = fastest, least accurate) |
 
Increasing `-bs`/`-bo` improves accuracy at the cost of latency — the defaults favor speed for a low-latency voice assistant.
 
**LM Studio** is typically the largest single consumer. If responses take 15–45s, a smaller model will do more than any other tuning.
 
**Base image**: `node:22-slim`, not Alpine. `onnxruntime-node` ships glibc-only binaries and cannot load on musl. Node 22 because `@discordjs/voice` requires `>=22.12.0`.
 
---
 
## Licensing note
 
The openWakeWord **code** is Apache-2.0, and so are the two feature models (`melspectrogram.onnx`, `embedding_model.onnx`). Those are fine to ship.
 
The **pre-trained wake word models** — `hey_jarvis`, `alexa`, `hey_mycroft` — are **CC BY-NC-SA 4.0 (non-commercial)**, because their training data includes datasets with restrictive licensing. They're excellent for validating your pipeline, but don't ship them in a commercial deployment. A model you train yourself carries no such restriction.
 
---
 
## Advanced — Red-DiscordBot Music Integration (VoiceBridge)
 
If you run [Red-DiscordBot](https://github.com/Cog-Creators/Red-DiscordBot) with the Audio cog in the same server, you can give Luna the ability to control music playback by saying *"hey Luna, play [song name]"*.
 
### How it works
 
Luna detects "play", "play song", or "play music" immediately following the wake word, extracts the song name, and posts `!play <song>` to the text channel. Because Discord bots ignore messages from other bots by default, a small Red cog called **VoiceBridge** bridges the gap — it whitelists Luna's user ID and relays the command to Red's Audio cog.
 
### Setup
 
**1. Get Luna's Discord user ID**
 
Right-click Luna in Discord (with Developer Mode enabled) and copy her user ID.
 
**2. Install the VoiceBridge cog**
 
Copy the `voicebridge/` folder into your Red-DiscordBot cogs directory:
 
```bash
cp -r voicebridge/ /path/to/redbot/cogs/voicebridge/
```
 
**3. Update the bot ID**
 
In `voicebridge.py`, replace `AI_BOT_ID` with Luna's actual Discord user ID:
 
```python
AI_BOT_ID = 123456789012345678  # Luna's Discord user ID
```
 
**4. Load the cog in Red**
 
```
[p]load voicebridge
```
 
**5. Usage**
 
Say: *"Hey Luna, play Bohemian Rhapsody"*
 
Luna will post `!play Bohemian Rhapsody` to the text channel, VoiceBridge intercepts it and invokes Red's Audio cog, and music starts playing.
 
---
 
## Known limitations
 
- Detection lags audio by up to ~160ms (80ms accumulation granularity plus inference).
- Barge-in only works once the LLM has finished generating; utterances during generation are buffered.
- Conversation memory is global — all speakers share one context window.
- English only — openWakeWord's synthetic training data is English-based.
## License
 
MIT
 

