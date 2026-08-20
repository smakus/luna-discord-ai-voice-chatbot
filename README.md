# Luna — Discord AI Voice Assistant

Responsibly Vibecoded with Claude. If you find this fun, interesting, or valuable, [buy me a coffee](https://buymeacoffee.com/qgt11lbfad)!

Luna is a locally-hosted AI voice assistant for Discord. She listens for her wake word, transcribes speech using Whisper, generates responses via LM Studio, and speaks back using Kokoro TTS — all running on your own machine with no cloud AI dependencies.

## Features

- 🎤 Wake word detection — say "Luna" to activate (configurable)
- 🧠 Local LLM via LM Studio with conversation memory
- 🔊 Local TTS via Kokoro TTS with streaming audio output
- 🌐 Optional web search via Tavily MCP
- 👥 Multi-user support with per-user audio capture
- ⚡ Low-latency streaming pipeline — LLM response streams sentence-by-sentence directly into TTS, so Luna starts speaking before she's finished generating
- 🔁 Interruptible — say "Luna" at any time to cut her off and ask something new
- 🔇 Configurable ignored users (e.g. music bots)

---

## How It Works

Luna's audio pipeline is designed for low latency at every stage:

```
You speak
    ↓  (1000ms silence detection)
Whisper transcribes locally
    ↓  (wake word check)
LM Studio streams response tokens
    ↓  (sentence boundary detected)
Kokoro streams sentence 1 audio ──► Discord plays sentence 1
    ↓  (sentence 2 already being fetched in parallel)
Kokoro streams sentence 2 audio ──► Discord plays sentence 2
    ...
```

Key design decisions:

- **Sentence-chunked TTS**: the LLM response is split into sentences as tokens arrive. Each sentence is sent to Kokoro immediately — Luna starts speaking the first sentence while the LLM is still generating the rest.
- **Prefetch pipeline**: Kokoro begins generating sentence N+1 while sentence N is still playing, eliminating gaps between sentences.
- **Streaming audio**: Kokoro streams WAV chunks directly to Discord rather than buffering the full audio file first.
- **Interrupt on wake word**: audio capture runs continuously regardless of whether Luna is speaking. A new wake word immediately stops the current response and starts a fresh one.

---

## Requirements

- macOS or Linux
- A Discord bot token
- [LM Studio](https://lmstudio.ai) with a loaded model (required regardless of install method)
- Docker (for the recommended install)
- **Optional but recommended**: A [Tavily](https://tavily.com) API key (free tier, for web search)

---

## Installation

### 1. Clone the repo

```
git clone https://github.com/smakus/luna-discord-bot
cd luna-discord-bot
```

### 2. Docker Installation (recommended)

The repo includes a `Luna-Discord-Bot-Full-Docker/` directory with a Docker Compose setup that runs both Luna and the Kokoro TTS server together.

```
cd Luna-Discord-Bot-Full-Docker
docker compose up --build
```

This builds and starts two containers:

- **luna** — the Discord bot (Node.js)
- **kokoro** — the local TTS server (Python/FastAPI)

### 3. Set up LM Studio

1. Download and install [LM Studio](https://lmstudio.ai)
2. Download a model — recommended: **Qwen3.5 9B** or any instruction-tuned model that fits your RAM
3. Load the model and start the local server (green toggle in the Server tab)
4. Enable authentication in LM Studio settings and copy the bearer token
5. Enable MCP in LM Studio if you want web search (see `.env` setup below)

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

```
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
```
> **Note:** If running outside Docker, replace `host.docker.internal` with `127.0.0.1` and `kokoro` with `localhost`.

**Available Kokoro voices:**

| Voice         | Description                  |
| ------------- | ----------------------------- |
| `af_heart`    | American female (warm)       |
| `af_sarah`    | American female (clear)      |
| `af_bella`    | American female (expressive) |
| `af_sky`      | American female (bright)     |
| `bf_emma`     | British female                |
| `bf_isabella` | British female (formal)      |

### 6. Add a chime sound

Place a file named `chime.mp3` in the `Luna-Discord-Bot-Full-Docker/Luna/` directory. This plays when Luna is activated. Any short MP3 works — keep it under 2 seconds.

---

## Running Luna

1. Start LM Studio, load your model, and ensure the local server is running
2. From the `Luna-Discord-Bot-Full-Docker/` directory:

```
docker compose up --build -d
```

3. Check logs:

```
docker compose logs -f luna
docker compose logs -f kokoro
```

---

## Usage

1. Join a Discord voice channel
2. In any text channel, type `!luna`
3. Luna will join your voice channel
4. Say **"Luna"** followed by your question or command

**Examples:**

- *"Luna, what's the weather today?"* — triggers web search via Tavily
- *"Luna, tell me a joke"* — direct LLM response
- *"Luna, what did I just ask you?"* — uses conversation memory
- *"Luna, play song Bohemian Rhapsody"* — triggers music bot integration

**Interrupting Luna:**

You can say "Luna" at any point while she is speaking to interrupt her and ask a new question. She will stop immediately and respond to the new query.

---

## Tuning

The following constants at the top of `index.js` can be adjusted:

| Constant           | Default             | Description                                          |
| ------------------ | -------------------- | ------------------------------------------------------ |
| `WAKE_WORDS`       | `['luna', 'loona']` | Wake word variants to listen for                     |
| `SILENCE_MS`       | `1000`               | ms of silence before processing utterance            |
| `ENERGY_THRESHOLD` | `300`                | Minimum audio energy level to count as speech        |
| `MIN_SPEECH_MS`    | `300`                | Minimum utterance length (ms) to bother transcribing |

**Tips:**

- If Luna triggers on background noise, **increase** `ENERGY_THRESHOLD`
- If Luna misses soft speech, **decrease** `ENERGY_THRESHOLD`
- If Luna cuts you off too early, **increase** `SILENCE_MS`
- If Luna feels sluggish to respond, **decrease** `SILENCE_MS`

---

## Troubleshooting

**Luna doesn't respond to the wake word** Check Docker logs — you should see `[userId] Processing Xms utterance...` when you speak. If not, `ENERGY_THRESHOLD` may be too high. Try lowering it to `200`.

**Whisper returns empty transcripts** Ensure the model file exists at the path set in `WHISPER_MODEL`. Test manually inside the container:

```
docker exec -it luna-1 whisper-cli -m /opt/whisper/models/ggml-small.en.bin -f /tmp/test.wav
```

**Kokoro TTS not working** Test the server directly:

```
curl -X POST http://localhost:8880/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello, I am Luna.", "stream": false}' \
  --output test.wav && afplay test.wav
```

**LM Studio not responding from Docker** Ensure LM Studio's server is running and bound to `0.0.0.0` (not just `127.0.0.1`) so Docker can reach it via `host.docker.internal`. Test:

```
curl http://host.docker.internal:1234/api/v1/models \
  -H "Authorization: Bearer $LM_STUDIO_MCP_BEARER_TOKEN"
```

**No audio in voice channel** Make sure the bot has **Connect** and **Speak** permissions in your Discord server.

**Sentences with numbers sound split up** This is handled automatically — the sentence splitter ignores periods inside decimal numbers (e.g. `$403.80` won't be split). If you see other edge cases, adjust the `SENTENCE_END` regex in `index.js`.

---

## Advanced — MusicBot Integration

If you run [Just-Some-Bots/MusicBot](https://github.com/Just-Some-Bots/MusicBot) in the same server, Luna can control music playback by saying *"Luna, play song [song name]"*.

Unlike some setups that need a relay cog to get around Discord's bot-to-bot message filtering, this integration works directly: MusicBot's own config supports whitelisting another bot's user ID so it stops ignoring Luna's commands. No extra cog required.

### How it works

Luna detects a "play" phrase in a query (`play`, `play song`, or `play music`, followed by the song name), strips any stray quote marks Whisper sometimes adds around titles, and posts `!play <song>` to the text channel MusicBot is bound to. Luna also checks whether MusicBot is already present in the current voice channel — if not, she sends `!summon` first so MusicBot joins based on her own voice presence rather than failing with "not in the voice channel."

### Setup

**1. Get Luna's Discord user ID**

Right-click Luna in Discord (with Developer Mode enabled) and copy her user ID.

**2. Whitelist Luna in MusicBot's config**

In MusicBot's `config/options.ini`, add Luna's user ID to `BotExceptionIDs` under `[Permissions]` so MusicBot stops ignoring her messages:

```ini
[Permissions]
BotExceptionIDs = <Luna's Discord user ID>
```

**3. Give Luna her own permission group (recommended)**

MusicBot's `[Default]` permission group caps song length (`MaxSongLength`) and other limits for anyone not explicitly assigned elsewhere. Since commands relayed through Luna are attributed to Luna's own bot account, they fall under `[Default]` by default and can hit that cap unexpectedly. Add a dedicated group in `config/permissions.ini`:

```ini
[LunaBot]
UserList = <Luna's Discord user ID>
MaxSongs = 0
MaxSongLength = 0
MaxPlaylistLength = 0
MaxSearchItems = 10
AllowPlaylists = yes
InstaSkip = yes
SkipLooped = no
Remove = no
SkipWhenAbsent = no
BypassKaraokeMode = no
SummonNoVoice = no
Extractors = Bandcamp, generic, soundcloud, spotify:musicbot, youtube
```

**4. Usage**

Say: *"Luna, play song Bohemian Rhapsody"*

Luna summons MusicBot into the channel if needed, posts `!play Bohemian Rhapsody`, and confirms with a short spoken response while the song loads.

### Known issue — YouTube 403 errors / SABR streaming

YouTube has been progressively rolling out server-side adaptive bitrate (SABR) enforcement that blocks some yt-dlp client profiles outright, and increasingly requires a proof-of-origin (PO) token to fetch media even when extraction succeeds. If MusicBot's `!play` commands fail with `HTTP Error 403: Forbidden`, this is almost certainly why — it's an active, ongoing change on YouTube's end, not something specific to this integration, and it can resurface after previously working.

The fix that's currently reliable (as of this writing) requires three changes to MusicBot's own Docker setup, independent of Luna:

1. **A PO token provider.** Add the [`bgutil-ytdlp-pot-provider`](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) plugin to MusicBot's image, along with a Deno runtime it depends on. This requires MusicBot's base image to have real glibc (`python:3.12-slim` works; Alpine's musl libc cannot run Deno even with the `gcompat` compatibility package).
2. **A PO token provider sidecar.** Run `brainicism/bgutil-ytdlp-pot-provider` as a companion container with `network_mode: "service:musicbot"` in `docker-compose.yml`, so it's reachable at the plugin's default `127.0.0.1:4416` with no extra yt-dlp configuration.
3. **A forced yt-dlp client list.** MusicBot has no built-in way to pass `--extractor-args` to yt-dlp, so this requires a small source patch to `musicbot/downloader.py`, forcing `extractor_args: {"youtube": {"player_client": ["android", "ios", "web_safari"]}}`. Some individual videos get served exclusively through YouTube's `android_vr` client, which is currently one of the profiles most consistently hit with 403s — this patch steers yt-dlp away from it in favor of clients that reliably attach a valid PO token.

This is MusicBot-side configuration, not something Luna's code can work around — Luna just relays a plain `!play` command and has no visibility into how MusicBot resolves the download.

---

## License

MIT
