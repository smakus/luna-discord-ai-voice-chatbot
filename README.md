# Luna — Discord AI Voice Assistant

Luna is a locally hosted AI voice assistant for Discord. She joins your voice channel, listens for **"hey Luna"**, and answers out loud. Speech-to-text (Whisper), the LLM (LM Studio) and text-to-speech (Kokoro) all run on your own machine, so there are no cloud AI costs. The exceptions are opt-in: Tavily web search, and ElevenLabs as an alternative voice.

If you find this fun or useful, [buy me a coffee](https://buymeacoffee.com/qgt11lbfad)!

## Features

- 🎤 **Neural wake word.** Say "hey Luna" to activate. [openWakeWord](https://github.com/dscripka/openWakeWord) runs on the raw audio, so only real requests get transcribed.
- 🧠 **Local LLM** via LM Studio, with separate conversation memory for each speaker.
- 🔊 **Streaming TTS** via Kokoro. Luna starts speaking her first sentence while the rest is still being generated.
- 🗣️ **Optional cloned voice** on Apple Silicon with Qwen3-TTS: describe a voice in words, pick a take you like, and Luna speaks in it.
- 🎭 **Optional ElevenLabs voice** (v4 Turbo), with expressive audio tags like `[laughs]` and `[whispers]`. Luna falls back to Kokoro automatically when credits run out. See [Text-to-speech providers](#text-to-speech-providers).
- 👥 **Multi-user.** Every speaker gets their own audio capture and wake word detector, and answers queue so no one's question cancels someone else's.
- 🔁 **Interruptible.** Say "hey Luna" again to cut off *your own* answer, even while she's still thinking about it.
- 👋 **Voice-channel announcements.** Luna introduces herself when she joins, greets people who join the channel by name, and announces who left. The wording is customizable.
- 🎵 **Music control.** "Hey Luna, play…", "skip" and "stop" are relayed to a music bot.
- 🌐 **Optional web search** via Tavily. The model decides when it needs current information, and Luna tells you whenever she's searching.
- 🍎 **Metal acceleration** for Whisper and Kokoro on Apple Silicon.

## How it works

```
You speak ─► openWakeWord (on the raw audio) ─► detection opens the gate
          ─► Whisper transcribes ─► LM Studio streams a reply
          ─► each finished sentence goes to Kokoro ─► Discord plays it
             (sentence N+1 is synthesized while N plays)
```

If the wake word models fail to load, Luna falls back to transcribing everything and matching "hey Luna" in the text.

---

## Requirements

- macOS or Linux, with Docker
- [LM Studio](https://lmstudio.ai) with a model loaded. See [Hardware sizing](#hardware-sizing); a model too big for your RAM is the most common cause of slow replies.
- A Discord bot token
- Optional: a [Tavily](https://tavily.com) API key (the free tier is enough) for web search
- Apple Silicon only: Homebrew, `cmake` (`brew install cmake`) and the Xcode command line tools (`xcode-select --install`)

## Setup

### 1. Clone

```bash
git clone https://github.com/smakus/luna-discord-ai-voice-chatbot
cd luna-discord-ai-voice-chatbot/Luna-Discord-Bot-Full-Docker
```

The wake word models (`hey_luna.onnx` plus openWakeWord's two feature models) and the activation chime are already included in `Luna/`.

### 2. LM Studio

1. Download an instruction-tuned model sized for your machine, and load it with GPU offload at maximum and a context length of about 4096.
2. Start the local server, bound to `0.0.0.0` so Docker can reach it.
3. Enable authentication and copy the bearer token. Enable MCP too if you want web search.

### 3. Discord bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and add a bot.
2. Under **Privileged Gateway Intents**, enable **Message Content Intent**. It's the only privileged intent Luna needs.
3. Invite the bot with these permissions: **View Channels**, **Send Messages**, **Connect**, **Speak**, **Use Voice Activity**.

### 4. Configure `.env`

```bash
cp Luna/example.env Luna/.env
```

Fill in at least `DISCORD_TOKEN` and `LM_STUDIO_MCP_BEARER_TOKEN`, and add `TAVILY_API_KEY` if you want web search. Under Docker Compose, `LM_STUDIO_URL`, `KOKORO_URL` and `WHISPER_SERVER_URLS` come from the compose file, which overrides whatever `.env` says. `.env` is kept out of the Docker image, so your tokens are never baked into it.

### 5. Start it

**Apple Silicon (recommended on any M-series Mac).** Whisper and Kokoro run natively on the GPU; only Luna runs in Docker. Docker's Linux VM can't use Metal, so running them in containers would leave them CPU-only.

Use three terminals, all in `Luna-Discord-Bot-Full-Docker/`, and start them in this order:

```bash
./scripts/whisper-metal.sh      # 1. first run builds whisper.cpp and downloads the model
./scripts/kokoro-metal.sh       # 2. first run creates a venv; wait for "Starting Kokoro TTS server"
docker compose -f docker-compose.metal.yml up --build   # 3. Luna
```

Luna has no health check to wait on for the native services, so start terminal 3 only after the first two report they're ready. In terminal 2, `[kokoro] warm — device=mps` confirms Kokoro is actually on the GPU.

To use a Qwen3-TTS voice (see [Text-to-speech providers](#text-to-speech-providers)), also run `./scripts/qwen3-tts-metal.sh` in a fourth terminal and wait for "Starting Qwen3-TTS server".

**Linux or Intel Mac ONLY:** Everything runs in containers:

```bash
docker compose up --build
```

Add `--build` whenever you've changed a source file. To stop, press `Ctrl-C` and run `docker compose down` (with `-f docker-compose.metal.yml` on Apple Silicon).

A healthy start looks like:

```
Using LM Studio model: <your-model>
[oww] seeded feature buffer with 50 noise embeddings (baseline score 0.0009)
[oww] active — threshold=0.15, Whisper gated on detection
Ready! Wake phrase: "hey Luna"  •  text command: !luna
```

---

## Usage

1. Join a voice channel and type `!luna` in any text channel. Luna joins and introduces herself.
2. Say **"hey Luna"** followed by your request, as one continuous phrase. Discord doesn't transmit pauses, so "hey… Luna" is harder to detect.

| Say | What happens |
| --- | ------------ |
| "Hey Luna, tell me a joke" | LLM answer |
| "Hey Luna, what's the weather today?" | Web search, then answer |
| "Hey Luna, what did I just ask you?" | Uses your conversation memory |
| "Hey Luna, play Bohemian Rhapsody" / "skip" / "stop" | Music bot commands (see [MusicBot](#musicbot-integration)) |

When Luna starts searching the web, she says a short heads-up such as *"Hmm, let me take a look."* at that moment, so you always know when she's using the internet, and the Discord status changes to "searching the web". If an answer still hasn't started after 15–22 seconds, she adds a filler like *"Still thinking."* or, now and then, a personal one like *"Hey Sam, I'm still working on that. I didn't forget about you."* The next filler comes 22–30 seconds later, then one every 30–40 seconds until the answer starts.

If the model spends more than a minute thinking (searching and reading results don't count), Luna stops it and asks again with reasoning switched off, saying something like *"Sorry, I was overthinking that one. Here's the quick answer."* She does the same if an answer comes back with no words in it.

Luna offers the model web search on every question, and the model decides when it needs current information; you'll hear the heads-up whenever it actually searches. Set `WEB_SEARCH=keywords` to go back to keyword-triggered search, or `off` to disable it. If the search server is unreachable, Luna answers without it and pauses search for a few minutes.

If Tavily is already set up in LM Studio's MCP settings (`mcp.json`), set `SEARCH_MCP_PLUGIN=mcp/tavily`. LM Studio then keeps that connection open instead of Luna connecting on every question.

Luna leaves the voice channel automatically when the last person does.

### Announcements

- **Intro:** when Luna joins, she says something like *"Hi everyone, Luna here! Just say hey Luna whenever you need me."*
- **Greetings:** when someone joins her channel, she says something like *"Sam just joined. Hey Sam!"*
- **Farewells:** when someone leaves or moves to another channel, she says something like *"Sam just left. See you later, Sam!"*

Bots, `IGNORED_USER_IDS` and mute/deafen changes are ignored. Each person is announced at most once per cooldown, and a connection that drops and comes back within a few seconds isn't announced at all. Display names are cleaned up so they can be spoken: fancy Unicode fonts become plain letters, emoji are dropped, and `sam_1234` becomes "sam".

To use your own wording, list phrases in `.env` separated by `|`. `{name}` is replaced with the person's name and `{wake}` with the wake phrase:

```env
GREET_PHRASES={name} just joined. Hey {name}!|Welcome in, {name}!
FAREWELL_PHRASES={name} just left. Bye, {name}!|And {name} is gone.
INTRO_PHRASES=Luna reporting for duty. Say {wake} if you need me.
```

### Text-to-speech providers

Kokoro is the default. There are two alternatives: Qwen3-TTS, a local voice of your own design for Apple Silicon Macs, and ElevenLabs, a paid cloud service.

#### Qwen3-TTS (Apple Silicon)

[Qwen3-TTS](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base) runs on the Mac's GPU through MLX and speaks in a voice cloned from a short reference clip. You create that clip from a written description:

```bash
./scripts/qwen3-tts-metal.sh design --name luna \
    --description "A warm, cozy American woman in her early thirties with a low alto voice, smooth and slightly husky."
```

This renders three takes of the same description into `~/.luna/qwen3-tts-voices` (each run invents a slightly different voice, which is why the clip is cloned instead of reusing the description). Listen, keep the one you like, and start the server:

```bash
./scripts/qwen3-tts-metal.sh design --keep luna-take2 --as luna
./scripts/qwen3-tts-metal.sh
```

The first run creates a venv in `~/.luna/qwen3-tts-venv` and downloads the models (about 3 GB to design, 2 GB to speak). Then set this in `.env` and recreate Luna:

```env
TTS_PROVIDER=qwen3
```

- **Pauses:** Qwen3-TTS renders about 3× faster than real time on its own, but slower than real time while a large LLM is generating on the same GPU. So Luna waits for each sentence to finish rendering before playing it. Audio stays clean, but expect short pauses between sentences while Luna is still writing her answer. `QWEN3_TTS_STREAM=true` removes the pauses but stutters whenever rendering falls behind.
- **Voices:** any `<name>.wav` + `<name>.txt` pair in the voices folder is a voice: about 10 seconds of clear speech and exactly what it says. Pick one with `QWEN3_TTS_VOICE` in `.env`, or set the server's default when starting the script. `curl localhost:8890/health` lists them.
- **Closer clones:** `QWEN3_TTS_MODEL=mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit` when starting the script clones more closely but is slower, so the pauses get longer.
- **No audio tags:** like Kokoro, it doesn't perform `[laughs]`-style tags; they're removed before it speaks.
- **Fallback:** Kokoro still covers for it, so keep Kokoro running. If the Qwen3-TTS server isn't running, each sentence goes to Kokoro instead.

#### ElevenLabs

To use ElevenLabs, set this in `.env`:

```env
TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=your_key
ELEVENLABS_VOICE_ID=voice_id_from_your_voice_library
```

- **Fallback:** keep Kokoro running, because it's the fallback.
  - When ElevenLabs runs out of credits, Luna switches to Kokoro for 12 hours (`TTS_CREDITS_RETRY_MS`). If the key, voice or plan is rejected, she switches for 30 minutes (`TTS_PROVIDER_RETRY_MS`). Either way she then tries ElevenLabs again, so topping up or fixing the account brings it back without a restart.
  - Rate limits, outages and timeouts only move the affected sentence to Kokoro.
- **Expressiveness:** with `eleven_v4_turbo` (the default model), the LLM is told it may add one audio tag where it fits, such as `[laughs]`, `[sighs]` or `[whispers]`. Kokoro never gets that instruction, and any tag that does reach it is removed, so it never reads "[laughs]" aloud. `TTS_EXPRESSIVE=false` turns this off.
- **Cost and privacy:** ElevenLabs is billed per character, and the text Luna speaks is sent to their servers.

To fall back to Qwen3-TTS before Kokoro, add `TTS_FALLBACK=qwen3`. Luna then tries ElevenLabs, then Qwen3-TTS, then Kokoro.

The startup log shows the active setup, for example `[tts] ElevenLabs (eleven_v4_turbo) → fallback Kokoro, expressive`.

---

## Configuration

Everything is set in `Luna/.env`. Most changes only need a container recreate (`docker compose up -d --force-recreate luna`), not a rebuild.

### Announcement settings

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `ANNOUNCE_SELF` | `true` | Intro when Luna joins |
| `GREET_ON_JOIN` | `true` | Greet people who join |
| `ANNOUNCE_LEAVE` | `true` | Announce people who leave |
| `GREET_COOLDOWN_MS` / `LEAVE_COOLDOWN_MS` | `600000` | Per-person cooldown |
| `GREET_DELAY_MS` / `LEAVE_DELAY_MS` | `1500` / `3000` | Only announce if they're still joined or still gone after this delay |
| `INTRO_PHRASES` / `GREET_PHRASES` / `FAREWELL_PHRASES` | built-in | Custom wording (see [Announcements](#announcements)) |
| `WEB_SEARCH` | `always` | `always`: offer search on every question and let the model decide. `keywords`: only when keyword rules match. `off`: never (also used when no search server is configured) |
| `SEARCH_MCP_PLUGIN` | unset | Use an MCP server configured in LM Studio's own `mcp.json` instead of connecting to Tavily per request, e.g. `mcp/tavily`. About 1 s faster per question, and no `TAVILY_API_KEY` needed in Luna |
| `SEARCH_TOOLS` | `tavily_search` | Which of the server's tools the model may use, comma-separated, or `all`. Tavily's research, crawl and extract tools are slower and use more credits |
| `SEARCH_PAUSE_MS` | `300000` | If the search server can't be reached, answer without search and pause search for this long |
| `ANNOUNCE_SEARCH` | `true` | Say a heads-up phrase when a web search starts |
| `SEARCH_PHRASES` | built-in | Custom heads-up phrases, separated by a pipe character |
| `ANNOUNCE_THINKING` | `true` | Say "still thinking" fillers while an answer is slow to start |
| `THINKING_WAITS` | `15-22,22-30,30-40` | Wait windows in seconds for the 1st, 2nd, … filler; the last window repeats |
| `THINKING_MAX` | `0` | Maximum fillers per question; `0` means no limit |
| `THINKING_PHRASES` | built-in | Custom filler phrases, separated by a pipe character; `{name}` is the asker's name |

### Wake word

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `OWW_ENABLED` | `true` | `false` falls back to matching "hey Luna" in the transcript |
| `OWW_MODEL_PATH` | `hey_luna.onnx` | Wake word classifier |
| `OWW_THRESHOLD` | `0.5` | Detection confidence; tune it against real scores |
| `OWW_TRIGGER_FRAMES` | `1` | Consecutive frames above threshold required |
| `OWW_CANDIDATE_THRESHOLD` | `0.1` | Two-stage detection: an utterance that peaks at or above this but never reaches `OWW_THRESHOLD` is transcribed anyway, and kept only if Whisper hears "Luna" in it. Catches "hey Luna" run straight into the question, which the model scores low. `0` turns it off; it has no effect when it isn't below `OWW_THRESHOLD` |
| `OWW_REFRACTORY_MS` | `1500` | Ignore repeat detections for this long |
| `OWW_GRACE_MS` | `2000` | How long before an utterance a detection still counts |
| `OWW_GAIN` | `auto` | `auto`, `off`, or a fixed multiplier |
| `OWW_DEBUG_SCORE` | `0` | Log every score at or above this value |

### Audio and memory

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `ENERGY_THRESHOLD` | `300` | Minimum level that counts as speech |
| `SILENCE_MS` | `1000` | Silence that ends an utterance; the biggest fixed latency. About 700 is worth trying |
| `MIN_SPEECH_MS` | `300` | Shorter utterances are ignored |
| `MAX_SPEECH_MS` | `15000` | Force-end an utterance after this much unbroken speech |
| `PREROLL_MS` | `320` | Audio kept from just before speech starts, so first syllables aren't clipped |
| `LM_MEMORY_TTL_MS` | `600000` | Forget a speaker's conversation after this much silence |
| `LM_MEMORY_MAX_TURNS` | `12` | …or after this many turns |
| `LM_FLAVOR_PROMPT` / `LM_FLAVOR_CHANCE` | unset / `0.15` | An occasional personality aside, and how often it's added |
| `IGNORED_USER_IDS` | | Comma-separated user IDs to ignore (e.g. music bots) |

### Voices, TTS and timeouts

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `TTS_PROVIDER` | `kokoro` | `kokoro`, `qwen3` or `elevenlabs` |
| `TTS_FALLBACK` | `kokoro` | Tried after `TTS_PROVIDER`, before Kokoro. `none` disables falling back |
| `TTS_CREDITS_RETRY_MS` | `43200000` | How long ElevenLabs is skipped after running out of credits (12 h) |
| `TTS_PROVIDER_RETRY_MS` | `1800000` | How long ElevenLabs is skipped after a key, voice or plan error |
| `TTS_EXPRESSIVE` | `true` | Let the LLM add audio tags when an expressive ElevenLabs model is speaking |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | | Required for ElevenLabs |
| `ELEVENLABS_MODEL` | `eleven_v4_turbo` | `eleven_flash_v2_5` is faster but ignores audio tags |
| `ELEVENLABS_OUTPUT_FORMAT` | `mp3_44100_128` | PCM formats need a Pro plan |
| `ELEVENLABS_TIMEOUT_MS` | `10000` | Falls back to Kokoro after this |
| `KOKORO_VOICE` | `af_heart` | Also `af_sarah`, `af_bella`, `af_sky`, `bf_emma`, `bf_isabella` |
| `KOKORO_THREADS` / `KOKORO_MAX_CONCURRENCY` | `2` (`4` on Metal) | Set in the compose file, or when running `kokoro-metal.sh` |
| `KOKORO_DEVICE` | `auto` | `cuda`, `mps` or `cpu` |
| `QWEN3_TTS_URL` | set by `docker-compose.metal.yml` | Outside Docker: `http://localhost:8890/v1/audio/speech` |
| `QWEN3_TTS_VOICE` | server default (`luna`) | Any voice in the voices folder |
| `QWEN3_TTS_STREAM` | `false` | `true` plays each sentence while it renders: no pauses, but it stutters when rendering falls behind |
| `QWEN3_TTS_MODEL` / `QWEN3_TTS_TEMPERATURE` | `…0.6B-Base-8bit` / `0.3` | Set when starting `qwen3-tts-metal.sh`. Each sentence is rendered on its own; a lower temperature keeps the delivery steadier from one sentence to the next, a higher one varies it more |
| `LM_IDLE_TIMEOUT_MS` | `90000` | Give up on the LLM only after this long with no output at all; reasoning, searching and streaming all count as output |
| `LM_TIMEOUT_MS` | `600000` | Overall limit for one LLM request |
| `VOICE_RECOVER_MS` | `20000` | If Discord reports someone speaking but none of their audio can be decrypted for this long, Luna reconnects her voice session (at most every 5 minutes). `0` disables |
| `LUNA_TIMEZONE` | `UTC` | Time zone used to tell the model today's date (an IANA name, e.g. `America/Los_Angeles`) |
| `LLM_REASONING` | model default | Reasoning level sent to LM Studio: `off`, `low`, `medium`, … as the model allows. Unset uses the model's own default, which can be its maximum |
| `LLM_THINK_LIMIT_MS` | `60000` | If the model has spent this long *reasoning* before the answer starts, ask again with reasoning off. Time spent searching and reading results doesn't count. `0` disables |
| `QUICK_ANSWER_PHRASES` | built-in | What Luna says when she switches to the quick answer, separated by a pipe character |
| `TTS_LOOKAHEAD` | `2` | Sentences synthesized ahead of the one playing |
| `WHISPER_TIMEOUT_MS` / `KOKORO_TIMEOUT_MS` / `QWEN3_TTS_TIMEOUT_MS` | `60000` / `30000` / `60000` | Request timeouts |

The Whisper model is `ggml-small.en-q5_1.bin` by default. On Apple Silicon you can afford a more accurate one: `WHISPER_MODEL=ggml-medium.en-q5_0.bin ./scripts/whisper-metal.sh` (or `ggml-large-v3-turbo-q5_0.bin`). On the Docker path it's a build arg in `docker-compose.yml`.

### Tuning the wake word

Set `OWW_DEBUG_SCORE=0.05` and watch the logs as you speak. Every ignored utterance reports its best score:

```
utterance discarded — no wake word (2100ms, peak score 0.234, threshold 0.15)
```

- **Peak just under the threshold:** lower `OWW_THRESHOLD`.
- **"Hey Luna" only works with a pause after it:** the model is trained on the phrase said on its own, so run-on "hey Luna what's the weather" scores lower (in testing, 0.28–0.41 typical instead of 0.7). Two-stage detection (`OWW_CANDIDATE_THRESHOLD`, on by default) catches these: look for `wake candidate … confirmed by Whisper` in the logs.
- **Peak around `0.00x`:** the model didn't react at all. Retrain it rather than tuning.
- **Triggers on background noise:** raise `OWW_THRESHOLD`. Compare against the baseline score printed at startup.

To train your own model, use the openWakeWord [Colab notebook](https://colab.research.google.com/drive/1q1oe2zOyZp7UsB3jJiQ1IFn8z5YfjwEb?usp=sharing). It takes about an hour with synthetic data. Export it as ONNX and save it as `Luna/hey_luna.onnx`. Use a phrase of 3–4 syllables; a bare "luna" trains poorly. More detail is in [`openWakeWordNotes.md`](Luna-Discord-Bot-Full-Docker/Luna/openWakeWordNotes.md).

---

## Hardware sizing

**The LLM is almost always the bottleneck.** Whisper and Kokoro are sub-second; a model that doesn't fit in memory can take 25 seconds to reply. On Macs, the GPU can only use about two thirds of total RAM.

| Total RAM | Realistic LLM |
| --------- | ------------- |
| 16 GB | 7–8B at Q4 |
| 24 GB | 12–14B at Q4 |
| 32 GB+ | 24–27B at Q4 |

Leave roughly 5–6 GB for the OS, Docker, Whisper and Kokoro. For spoken two-sentence replies, a smaller model that answers in 2 seconds beats a larger one that takes 25.

---

## Troubleshooting

Luna logs timings for every exchange; whichever is largest is your bottleneck:

```
[timing] Whisper done: 843ms
[timing] First LLM sentence: 2100ms
[timing] First audio start: 2560ms
```

When the LLM is the slow part, the `[LLM] stats` line that follows each answer shows why:

```
[LLM] stats: memory turn 4, prompt 3,812 tokens, reasoning 412, output 96, first token 41.2s, 6.9 tok/s
```

- **Lots of reasoning tokens** means the model is thinking before it speaks.
- **A large prompt that grows with the memory turn** means conversation memory, including stored web-search results, is getting expensive. Lower `LM_MEMORY_MAX_TURNS`.
- **Low tok/s** means the model is too big for your machine.

She also logs a `[health]` line per speaker every 30 seconds. `flushing` stuck at `true`, or `buffered` climbing into the hundreds, means that speaker's audio is stuck. Each speaker's entry also shows whether Luna can decrypt them: `in group, 812 decrypted/0 failed` is healthy.

**Checking whether Luna can hear someone.** Discord voice is end-to-end encrypted, and Luna can lose one person's keys while everyone else hears them fine. Type `!luna voicecheck` in the text channel for a definitive answer per person:

```
Voice encryption: active, epoch 7 — privacy code `12345 67890 …`
✅ smakus: in group, 812 decrypted/0 failed
⚠️ appa: NOT in group, 0 decrypted/37 failed
```

- **NOT in group:** Luna has no keys for that person.
- **0 decrypted with failures:** their audio arrives but can't be decrypted.
- **No packets yet:** nothing has arrived from them. That's normal if they haven't spoken.
- **Privacy code:** compare it with the one Discord shows in the call's encryption details. If they differ, Luna's whole session is out of sync; restarting her fixes it.

| Symptom | Fix |
| ------- | --- |
| Replies take 20+ seconds | The model is too big for your RAM; see [Hardware sizing](#hardware-sizing) |
| Doesn't respond to "hey Luna" | Check the peak score; see [Tuning the wake word](#tuning-the-wake-word) |
| Answers once, then stops responding | Luna is probably hearing herself through your speakers. Use headphones, or raise `ENERGY_THRESHOLD` |
| Luna ignores one person while everyone else hears them | Her encrypted voice session lost that person's keys; `!luna voicecheck` confirms it. She reconnects by herself after ~20 s of it (look for `[voice]` lines); restarting her fixes it too |
| Have to speak loudly to trigger it | Turn off Discord's Noise Suppression and Automatic Gain Control |
| LM Studio not reachable from Docker | Bind its server to `0.0.0.0`, not `127.0.0.1` |
| No audio in the voice channel | Give the bot **Connect** and **Speak** permissions |
| `qwen3-tts-metal.sh` reports port 8890 in use | Another copy of the script is running in a different terminal |
| `kokoro-metal.sh` reports port 8880 in use | Another Kokoro is running: a leftover container (`docker compose down`) or a second copy of the script |
| `MPS available: False` | Metal needs macOS 12.3+ on Apple Silicon; otherwise Kokoro runs on CPU |
| Slow Whisper or Kokoro on a Mac | You're on the Docker path. Use the Metal scripts instead |
| Voice switches to Kokoro mid-session | ElevenLabs ran out of credits or rejected the key or voice. The `[tts]` log line says which |

Both Metal scripts repair themselves in the usual failure cases. `whisper-metal.sh` rebuilds a build that can't start (for example after the folder was moved). Kokoro works around espeak-ng's path-length limit when its venv sits in a deeply nested folder.

---

## Development

Luna's tests live in `Luna/test/` and run without Discord, LM Studio, Whisper or a TTS server: every outside service is faked. They need only Node 22. Without Node on your machine, run them in Docker:

```bash
cd Luna-Discord-Bot-Full-Docker/Luna
docker run --rm -v "$PWD":/app:ro -w /app node:22-slim npm test
```

With Node installed, `npm test` in `Luna/` does the same. A full run takes about a minute and a quarter.

| File | Covers |
| ---- | ------ |
| `luna.test.js` | Capture, wake word (including two-stage detection), the LLM stream (thinking limit, quick answers, leaked reasoning, search), playback, interruptions, encrypted-voice diagnostics and recovery |
| `tts.test.js` | TTS providers and the fallback chain |
| `announce.test.js` | Intro, join greetings, leave farewells, speakable names |
| `answer-filter.test.js` | What of the LLM's answer Luna says, holds or drops (`answer-filter.js`): each rule, plus LM Studio streams in `test/fixtures/` replayed through the real pipeline |
| `voice-input.test.js` | The voice-input stages (`voice-input.js`) one by one: packet decoding, filling silent gaps for the wake-word model, cutting speech into utterances, the wake decision, finding the question in a transcript, and what to do about a speaker who is never heard |
| `harness.js` | Loads `index.js` with Discord, LM Studio, Whisper, TTS and the wake-word engine faked |

The tests are excluded from the Docker image.

---

## MusicBot integration

Luna can control [Just-Some-Bots/MusicBot](https://github.com/Just-Some-Bots/MusicBot) running in the same server.  I've created my own version called [smakbot](https://github.com/smakus/smakbot-discord-music-bot) that runs in Docker and works great.  Smakbot and Luna are designed to work together. "Hey Luna, play *song*" posts `!play <song>` to the text channel, and sends `!summon` first if MusicBot isn't in the voice channel yet. "Skip" and "stop" post `!skip` and `!stop`.

MusicBot normally ignores messages from other bots, so whitelist Luna in its config. In `config/options.ini`:

```ini
[Permissions]
BotExceptionIDs = <Luna's Discord user ID>
```

Commands relayed through Luna count as Luna's, so give her a permission group in `config/permissions.ini` without MusicBot's default song-length cap:

```ini
[LunaBot]
UserList = <Luna's Discord user ID>
MaxSongs = 0
MaxSongLength = 0
MaxPlaylistLength = 0
AllowPlaylists = yes
```

If `!play` fails with `HTTP Error 403`, that's YouTube's ongoing anti-download changes, not Luna. The usual fix, on MusicBot's side, is the [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) plugin and sidecar.

---

## Known limitations

- Memory is per speaker, so Luna can't follow a question about what someone *else* asked.
- English only.

## Licensing note

openWakeWord's code and its two feature models are Apache-2.0. Its pre-trained phrase models (`hey_jarvis`, `alexa`, `hey_mycroft`) are **CC BY-NC-SA 4.0, non-commercial only**. A model you train yourself has no such restriction.

## License

MIT
