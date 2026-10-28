# Luna: Local AI Voice Assistant for Discord

**Luna** is a free, open-source, self-hosted AI voice assistant and chatbot for Discord. She joins your voice channel, listens for **"hey Luna"**, and answers out loud: questions, jokes, the weather, music requests, and whatever else the group throws at her. You can also type to her in a text channel.

Everything that matters runs on your own computer: a local LLM through [LM Studio](https://lmstudio.ai), [Whisper](https://github.com/ggml-org/whisper.cpp) speech-to-text, and Kokoro, Chatterbox or Qwen3-TTS text-to-speech. There are no cloud AI bills and no voices sent to a third party. Web search ([Tavily](https://tavily.com)) and the [ElevenLabs](https://elevenlabs.io) voice are optional extras. Paired with [smakbot](https://github.com/smakus/smakbot-discord-music-bot), she's also a voice-controlled music DJ.

If you find this fun or useful, [buy me a coffee](https://buymeacoffee.com/qgt11lbfad)!

**Contents:** [Features](#features) · [Using Luna](#using-luna) · [Music with smakbot](#music-with-smakbot) · [How it works](#how-it-works) · [Setup](#setup) · [Voices](#text-to-speech-providers) · [Configuration](#configuration) · [Hardware sizing](#hardware-sizing) · [Troubleshooting](#troubleshooting) · [FAQ](#faq) · [Development](#development)

## Features

- 🎤 **"Hey Luna" wake word.** A neural wake-word model ([openWakeWord](https://github.com/dscripka/openWakeWord)) listens to everyone in the channel, so only real requests are transcribed. Say it mid-sentence, or pause after it; both work.
- 🧠 **Runs on your own LLM** in LM Studio (Qwen, Gemma and others), with conversation memory for each person.
- 🔊 **Talks back fast.** She starts speaking her first sentence while the rest of the answer is still being written.
- 🎭 **Expressive voices.** Kokoro by default. Chatterbox Turbo and ElevenLabs laugh, sigh and whisper where it fits, and Qwen3-TTS speaks in a voice you design.
- 🌐 **Web search when it's needed** (optional, Tavily). The model decides when it needs fresh information, and Luna tells you when she's looking something up.
- 👥 **Built for groups.** Each person gets their own wake-word detector and memory. Answers queue instead of cutting each other off, and saying "hey Luna" again interrupts only your own answer.
- 💬 **Text chat.** Type "Luna, …" in a chat channel for a written answer. She can also say something out loud in the voice channel for you.
- 🎵 **Voice-controlled music** with smakbot: play, skip, stop, "play the top 10", "what song is this?", and questions about the song that's playing.
- 👋 **Greets people.** She introduces herself, greets people who join by name (with custom greetings in their own voice if you like), and says goodbye when they leave.
- 🍎 **Apple Silicon acceleration** for Whisper and the voices; on Linux everything runs in Docker.

## Using Luna

### Talking to her

Join a voice channel and type `!luna` in a text channel (or set up [auto-join](#audio-and-memory) so she comes by herself). She joins and introduces herself. Then say **"hey Luna"** and your request:

- **Run it straight into the question** ("hey Luna what's the weather"), **or pause** after "hey Luna": she waits up to 4 seconds for the question. A chime means she's got it.
- **Mid-sentence works:** "…anyway, hey Luna, what's the weather?" Only what follows "hey Luna" is the question.
- **Just "hey Luna" and nothing else?** She asks "did you mean to ask me something?" and takes your next words as the question, no wake word needed.
- **Say "hey Luna" again** to interrupt her answer to you. It doesn't cut off answers to anyone else.

| Say | What happens |
| --- | ------------ |
| "Hey Luna, tell me a joke" | Answered by the LLM |
| "Hey Luna, what's the weather today?" | She searches the web, then answers |
| "Hey Luna, what did I just ask you?" | She remembers your conversation for an hour |
| "Hey Luna, play Bohemian Rhapsody" | Plays it through smakbot (see [Music with smakbot](#music-with-smakbot)) |
| "Hey Luna, play the top 10" | Your server's most played songs |
| "Hey Luna, skip" / "stop the music" | Skips the song / stops the music |
| "Hey Luna, what song is this?" | Says what's playing, who asked for it and what's next |
| "Hey Luna, what's this song about?" | Answers about the song that's playing, no title needed |
| "Hey Luna, leave" / "bye" / "you can go now" | Says goodbye and leaves the channel |

Polite versions work too: "hey Luna, can you play…", "could you skip this song?", "please stop the music, thanks".

### What you'll hear while she works

- **"Hmm, let me take a look."** She's searching the web. The Discord message changes to "searching the web" too.
- **"Still thinking."** An answer is taking a while: the first filler comes after 15–22 seconds, then every 22–40 seconds. Some are personal: *"Hey Sam, I'm still working on that. I didn't forget about you."*
- **"Sorry, I was overthinking that one. Here's the quick answer."** The model spent over a minute reasoning, so she asked again with reasoning off.

She leaves the voice channel by herself when the last person does.

### Typing to her

With `TEXT_CHAT_CHANNELS` set, type in one of those channels. A message that starts with "Luna" or @mentions her gets a written reply, e.g. *"Luna, what's the weather in Irvine?"* She doesn't need to be in a voice channel for this.

- She shows "Luna is typing…" while she works and reacts with 🔍 when she searches the web.
- Everyone in a channel shares one conversation, each message labelled with its writer's name, so *"Luna, and in Newport?"* follows on from someone else's question. It's separate from voice, and forgotten after an hour of quiet (`LM_MEMORY_TTL_MS`).
- Answers can use Discord formatting (bold, a short list, links) and are split if longer than Discord's 2,000-character limit. They can't ping anyone.
- Music works the same way: *"Luna, play …"*, *"skip"*, *"stop"*, *"play the top 10"*, *"what song is this?"*
- **She can say things out loud for you:** *"Luna, say hello in Chinese in the voice channel"*, *"Luna, tell everyone in vc that dinner is ready"*. Requests like these ("say / tell / announce … in the voice channel / vc / voice") have the LLM write just the line. Luna speaks it in her voice channel and posts *"🔊 Said in Talk Soup: 你好！"*. Other phrasings ("give Joel a warm welcome out loud") go through the LLM's `say_in_voice` tool. Lines are capped at 400 characters and wait their turn behind whatever she's saying. With Chatterbox (English only) as the voice, other languages won't sound right.

### Text commands

| Command | What it does |
| ------- | ------------ |
| `!luna` | Joins the voice channel you're in, or moves there if she's elsewhere |
| `!luna leave` | Leaves the voice channel. With auto-join on, she stays away until the channel has emptied once, or someone types `!luna` |
| `!luna say <text>` | Says exactly that text out loud in her voice channel, with no LLM involved, and reacts 🔊 |
| `!luna voicecheck` | Shows, for each person, whether Luna can decrypt their voice (see [Troubleshooting](#troubleshooting)) |
| `!luna wakestats` | How well the wake word worked for each person over the last day: how many of their "hey Luna"s she answered, and how (the model, the near-threshold check or the backup), their typical score and near misses. `!luna wakestats 7d` or `12h` for another span. Read from [the wake-word log](#the-wake-word-log) |

### Music with smakbot

Luna doesn't play music herself. She drives [smakbot](https://github.com/smakus/smakbot-discord-music-bot), a self-hosted Discord music bot built to work with her, by posting its commands in the text channel. You can always type smakbot's own commands too (`!queue`, `!pause`, `!volume 50`, …); see [its command list](https://github.com/smakus/smakbot-discord-music-bot#commands).

| You say (or type "Luna, …") | Luna sends to smakbot |
| --------------------------- | -------------------- |
| "play Crazy by Seal" | `!summon` if smakbot isn't in the channel, then `!play Crazy by Seal --for=@you` |
| "play the top 10" / "play the top twenty songs" / "play our top three hits" / "play our most played" / "play my favorites" | `!playtop 10` (or 20; at most 50), your server's most played songs |
| "skip" / "skip this song" | `!skip` |
| "stop" / "stop the music" | `!stop` (smakbot stops and leaves) |
| "put on something chill" / "play the Lord of the Rings soundtrack" | Her LLM picks the search and sends `!play …` |
| "what song is this?" / "what's playing?" | She asks smakbot directly and answers: *"This is Crazy by Seal, requested by smakus. Up next: Kiss From a Rose."* |
| "what's this song about?" / "when did it come out?" | The LLM is told what's playing, so she answers about that song |

- **`--for=@you`** credits the song to you instead of Luna, in smakbot's "Now playing", its status and Luna's own "what song is this?". It's sent without pinging you.
- **"Play top of the world"** is still a song search. Only "the top N" / "most played" / "my favorites" mean the top-songs list.
- **When smakbot joins or leaves,** Luna says so briefly: *"smakbot has joined."*

Setting the two bots up to talk to each other is covered in [MusicBot integration](#musicbot-integration).

### Custom greetings

A few people can get their own join greeting, optionally in their own ElevenLabs voice. Copy `Luna/greetings.example.json` to `Luna/local/greetings.json` and edit it:

```json
{
  "371034505349169152": {
    "name": "User X",
    "voice": "OUBnvvuqEKdDWtapoJFn",
    "phrases": ["Oh my, look who is here, {user}. [excited] Welcome in!"]
  }
}
```

- Keys are Discord user IDs (Developer Mode → right-click the person → Copy User ID), so renames don't matter. `name` is only a label for you.
- `{user}` (or `{name}`) is their current display name, made speakable. With several phrases, one is picked at random. ElevenLabs audio tags work.
- `voice` is an ElevenLabs voice ID (in ElevenLabs, open the voice → copy its ID). The voice must be in your own ElevenLabs voices: add Voice Library voices to "My Voices" first. Leave it out to use Luna's normal voice.
- `GREET_ON_JOIN=regular` gives everyone the regular greeting without touching the file; `off` turns join greetings off.
- Same cooldown and switches as the normal greeting. If their voice can't be used (ElevenLabs down, out of credits, unknown voice), they get the normal greeting in the normal voice.
- `Luna/local/` is mounted into the container and ignored by git: edit the file and restart Luna, no rebuild. The startup log lists who has a custom greeting and warns about voice IDs ElevenLabs doesn't know (checking costs no credits).

### Announcements

- **Intro:** when Luna joins, she says something like *"Hi everyone, Luna here! Just say hey Luna whenever you need me."*
- **Greetings:** when someone joins her channel, she says something like *"Sam just joined. Hey Sam!"*
- **Farewells:** when someone leaves or moves to another channel, she says something like *"Sam just left. See you later, Sam!"*
- **Bots:** bots (smakbot) and `IGNORED_USER_IDS` get a short line instead: *"smakbot has joined."* and *"smakbot has left."*

Mute/deafen changes are ignored. Each person is announced at most once per cooldown, and a connection that drops and comes back within a few seconds isn't announced at all. Display names are cleaned up so they can be spoken: fancy Unicode fonts become plain letters, emoji are dropped, and `sam_1234` becomes "sam". Names a voice says wrong can be respelled with `NAME_PRONUNCIATIONS` (`smakus=smack-us`).

To use your own wording, list phrases in `.env` separated by `|`. `{name}` is replaced with the person's name and `{wake}` with the wake phrase:

```env
GREET_PHRASES={name} just joined. Hey {name}!|Welcome in, {name}!
FAREWELL_PHRASES={name} just left. Bye, {name}!|And {name} is gone.
BOT_JOIN_PHRASES={name} has joined.
BOT_LEAVE_PHRASES={name} has left.
INTRO_PHRASES=Luna reporting for duty. Say {wake} if you need me.
```

---

## How it works

```
You speak ─► openWakeWord (on the raw audio) ─► detection opens the gate
          ─► Whisper transcribes ─► fixed commands (music, leave, "what song is this?")
                                   or LM Studio streams a reply (with web search and tools)
          ─► each finished sentence goes to the voice ─► Discord plays it
             (sentence N+1 is synthesized while N plays)
```

If the wake word models fail to load, Luna falls back to transcribing everything and matching "hey Luna" in the text.

Luna offers the model web search on every question, and the model decides when it needs current information; you'll hear the heads-up whenever it actually searches. Set `WEB_SEARCH=keywords` to go back to keyword-triggered search, or `off` to disable it. If the search server is unreachable, Luna answers without it and pauses search for a few minutes. If Tavily is already set up in LM Studio's MCP settings (`mcp.json`), set `SEARCH_MCP_PLUGIN=mcp/tavily`, and LM Studio keeps that connection open instead of Luna connecting on every question.

## Requirements

| | **Apple Silicon Mac** (M1 or later) | **Linux PC** |
| --- | --- | --- |
| Recommended for | The best experience | Works well |
| Speech-to-text and voice | On the Mac's GPU | In Docker, on the CPU |
| Recommended free voice | **Chatterbox** (laughs, sighs, whispers) | Kokoro |
| RAM | 16 GB minimum, 32 GB+ recommended | 16 GB+ |

- **Both:** [Docker](https://www.docker.com/products/docker-desktop/), [LM Studio](https://lmstudio.ai) and a Discord account.
- **Optional:** a [Tavily](https://tavily.com) key for web search (free tier), and an [ElevenLabs](https://elevenlabs.io) key for the best (paid) voice.
- **Not supported:** Intel Macs (LM Studio needs Apple Silicon). Windows isn't tested.

## Setup

### 1. Install

Install and open [Docker](https://www.docker.com/products/docker-desktop/) and [LM Studio](https://lmstudio.ai). On a Mac, also install [Homebrew](https://brew.sh), then:

```bash
xcode-select --install; brew install cmake
```

Then download Luna:

```bash
git clone https://github.com/smakus/luna-discord-ai-voice-chatbot
cd luna-discord-ai-voice-chatbot/Luna-Discord-Bot-Full-Docker
cp Luna/example.env Luna/.env
```

### 2. Set up LM Studio

1. Download a model that fits your RAM ([Hardware sizing](#hardware-sizing)) and load it with GPU offload at maximum and a context length of 16,000.
2. In the **Developer** tab, start the server, bound to `0.0.0.0`, with **authentication on** (and **MCP on** if you'll use web search). Copy the token.

### 3. Create the Discord bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application, add a bot and copy its token.
2. Turn on **Message Content Intent** (under Privileged Gateway Intents).
3. Invite it to your server with **View Channels**, **Send Messages**, **Add Reactions**, **Read Message History**, **Connect**, **Speak** and **Use Voice Activity**.

### 4. Fill in `Luna/.env`

Open it (`open -e Luna/.env` on a Mac, `nano Luna/.env` on Linux) and set:

```env
DISCORD_TOKEN=your_bot_token
LM_STUDIO_MCP_BEARER_TOKEN=your_lm_studio_token
TAVILY_API_KEY=your_tavily_key
```

`TAVILY_API_KEY` is optional (web search).

Then pick **one** voice. You need one local voice server, or none at all with ElevenLabs:

**Chatterbox** (Mac, free, laughs and sighs; recommended):

```env
TTS_PROVIDER=chatterbox
```

**Kokoro** (any computer, free, plain): leave `TTS_PROVIDER=kokoro` as it is.

**ElevenLabs** (paid, the most expressive; no local voice server):

```env
TTS_PROVIDER=elevenlabs
TTS_FALLBACK=none
ELEVENLABS_API_KEY=your_key
ELEVENLABS_VOICE_ID=your_voice_id
```

A backup voice is only needed with ElevenLabs, and only if you might run out of credits: without one, she goes quiet until ElevenLabs works again. For a backup on a Mac, change `TTS_FALLBACK=none` to `TTS_FALLBACK=chatterbox` (or `kokoro`) and also start that server in step 5. On Linux, Kokoro already runs in Docker, so just delete the `TTS_FALLBACK=none` line.

The voices are compared in [Text-to-speech providers](#text-to-speech-providers).

### 5. Start Luna

**Mac:** open a terminal tab for each step in `Luna-Discord-Bot-Full-Docker/`, and wait for each to finish starting before the next. The first run of each downloads and builds for a few minutes.

1. Whisper (always), ready when it says it's listening on port 8081:

   ```bash
   ./scripts/whisper-metal.sh
   ```

2. Your voice server: the **one** you picked in step 4. Skip this with ElevenLabs and no backup.

   ```bash
   ./scripts/chatterbox-metal.sh
   ```

   or

   ```bash
   ./scripts/kokoro-metal.sh
   ```

   Ready at `Starting … server`.

3. Luna:

   ```bash
   docker compose -f docker-compose.metal.yml up --build
   ```

**Linux:**

```bash
docker compose up --build
```

### 6. Try it

Luna is ready when her log shows `Ready! Wake phrase: "hey Luna"`. Join a voice channel and type `!luna` in a text channel. When she has introduced herself, say **"Hey Luna, what's two plus two?"** If she doesn't answer, see [Troubleshooting](#troubleshooting).

### Stop, restart and update

| To | Run |
| --- | --- |
| Stop | `Ctrl-C` in each tab |
| Apply a `.env` change | Run the `docker compose … up --build` line again |
| Update Luna | `git pull`, then the `docker compose … up --build` line |

Custom greetings (`Luna/local/`), the wake-word log (`Luna/logs/`) and cached phrases (`Luna/cache/`) are kept when you rebuild.

---

## MusicBot integration

How to connect Luna to [smakbot](https://github.com/smakus/smakbot-discord-music-bot) (or upstream [MusicBot](https://github.com/Just-Some-Bots/MusicBot)). What you can then say is in [Music with smakbot](#music-with-smakbot).

1. **Let smakbot take commands from Luna.** MusicBot ignores other bots, so add Luna to its `config/options.ini`:

   ```ini
   [Permissions]
   BotExceptionIDs = <Luna's Discord user ID>
   ```

2. **Give Luna a permission group without per-person limits**, since everyone's requests arrive as hers. In smakbot's `config/permissions.ini`:

   ```ini
   [LunaBot]
   UserList = <Luna's Discord user ID>
   MaxSongs = 0
   MaxSongLength = 0
   MaxPlaylistLength = 0
   AllowPlaylists = yes
   ```

3. **Let the LLM use the music tools** (`play_music`, `play_top_songs`, `skip_song`, `stop_music`, and `leave_channel`). Luna serves them from her container over MCP on port 8895, published on `127.0.0.1` only. LM Studio only connects to local MCP servers listed in its `mcp.json`, so add this there once (Program → Install → Edit mcp.json, or `~/.lmstudio/mcp.json`), next to any other servers:

   ```json
   "luna": { "url": "http://127.0.0.1:8895/mcp" }
   ```

   When the model calls a tool, Luna posts the smakbot command and the model confirms out loud; a `[music] the LLM called …` line in the log shows each call. If LM Studio can't reach the tools, Luna answers without them and logs a warning. `LLM_TOOLS=false` turns them off.

4. **"What song is this?"** needs smakbot's now playing API (`StatusApiPort = 8896` in smakbot, on by default there) and `MUSIC_STATUS_URL` in Luna (set in `docker-compose.metal.yml`).

Fixed commands ("play …", "skip", "stop", "play the top 10") need none of steps 3–4. Songs Luna queues end in `--for=@name` so smakbot credits whoever asked; upstream MusicBot doesn't know `--for` and would include it in the search, so it's smakbot-only. If `!play` fails with `HTTP Error 403`, that's YouTube's anti-download changes, not Luna; smakbot already includes the usual fix ([bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)).

---

## Text-to-speech providers

| Voice | Runs on | Expressive? | Cost | Best for |
| --- | --- | --- | --- | --- |
| **ElevenLabs** | Cloud | The most: any emotion or delivery, combined freely | Paid, per character | The best voice, if you'll pay for it |
| **Chatterbox Turbo** | Apple Silicon | Yes: 8 emotions and 9 sounds (laughs, sighs, whispers …) | Free | **The recommended free voice on a Mac** |
| **Qwen3-TTS** | Apple Silicon | No, but in a voice you design | Free | A unique voice; expect short pauses between sentences |
| **Kokoro** | Everywhere | No | Free | Linux, or the simplest setup |

`TTS_PROVIDER` picks the voice. You only need that one running; `TTS_FALLBACK` adds an optional backup for when it fails (then Kokoro, if it's running; `TTS_FALLBACK=none` for no backup at all). Lines she says again and again (greetings, the search heads-up, fillers) are kept once rendered (`TTS_CACHE_DIR`), so with ElevenLabs they only cost credits the first time.

### Chatterbox Turbo (Apple Silicon)

[Chatterbox Turbo](https://huggingface.co/ResembleAI/chatterbox-turbo) (Resemble AI, MIT license) runs on the Mac's GPU through MLX and performs audio tags in the text: emotions that set the tone of what follows (`[happy]`, `[sarcastic]`, `[surprised]`, `[whispering]`, `[angry]`, `[fear]`, `[crying]`, `[dramatic]`) and sounds (`[laugh]`, `[chuckle]`, `[sigh]`, `[gasp]`, `[groan]`, `[sniff]`, `[cough]`, `[clear throat]`, `[shush]`). While it is speaking, the LLM is told exactly these tags and uses them wherever they fit: none on plain facts, and laughs only for things that are actually funny.

```bash
./scripts/chatterbox-metal.sh
```

The first run creates a venv in `~/.luna/chatterbox-venv` and downloads the model (about 3 GB). Then set this in `.env` and recreate Luna:

```env
TTS_PROVIDER=chatterbox
```

- **Speed and memory:** a whole sentence renders about 2.6× faster than real time, 1.7× while a Gemma-class LLM is writing, using about 4.2 GB of GPU memory. `CHATTERBOX_MODEL=mlx-community/chatterbox-turbo-8bit` is faster and needs 2.5 GB, but sounds rougher. Sentences are rendered whole before playing, so the next one is ready before the current one ends.
- **Leave `CHATTERBOX_STREAM` off.** Streaming renders in small pieces, which is far slower (0.6× real time while the LLM writes): playback runs out of audio and Discord's player ends the sentence early, so words are lost.
- **Voices:** `default` is the voice built into the model. Any `<name>.wav` in `~/.luna/chatterbox-voices` (10–20 seconds of clear speech by one speaker, no transcript needed) is a clone; pick one with `CHATTERBOX_VOICE`. `curl localhost:8891/health` lists the voices and tags.
- **Tags it doesn't know** are dropped before it speaks; ElevenLabs spellings such as `[laughs]` or `[whispers]` are mapped to its own.
- **Fallback:** none needed. If Kokoro happens to be running, it covers for a failed sentence, with tags removed.

### Qwen3-TTS (Apple Silicon)

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
- **Fallback:** none needed. If Kokoro happens to be running, it covers for a failed sentence.

### ElevenLabs

To use ElevenLabs, set this in `.env`:

```env
TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=your_key
ELEVENLABS_VOICE_ID=voice_id_from_your_voice_library
```

- **Fallback (optional):** no local voice server is needed. A backup only matters if you might run out of credits; set `TTS_FALLBACK` to `chatterbox` or `kokoro` and run that server (on Linux, Kokoro already runs in Docker). With a backup:
  - When ElevenLabs runs out of credits, Luna switches to the backup for 12 hours (`TTS_CREDITS_RETRY_MS`). If the key, voice or plan is rejected, she switches for 30 minutes (`TTS_PROVIDER_RETRY_MS`). Either way she then tries ElevenLabs again, so topping up or fixing the account brings it back without a restart.
  - Rate limits, outages and timeouts only move the affected sentence to the backup.
  - Lines she has said before (greetings, fillers, the search heads-up) still play in the ElevenLabs voice from the [phrase cache](#voices-tts-and-timeouts), backup or not.
- **Expressiveness:** with `eleven_v4_turbo` (the default model), the LLM is told it may add audio tags wherever they fit: emotions (`[curious]`, `[warm]`, `[playful]`, `[worried]` …), reactions (`[laughs]`, `[sighs]`, `[gasps]` …), delivery (`[whispers]`, `[pause]`, `[hesitates]` …) and combined directions like `[warm, laughing softly]`. Kokoro and Qwen3-TTS never get that instruction, and any tag that does reach them is removed, so they never read "[laughs]" aloud. `TTS_EXPRESSIVE=false` turns this off.
- **Cost and privacy:** ElevenLabs is billed per character, and the text Luna speaks is sent to their servers.

With `TTS_FALLBACK=chatterbox` (or `qwen3`), Luna tries ElevenLabs, then that voice, then Kokoro if it's running.

The startup log shows the active setup, for example `[tts] ElevenLabs (eleven_v4_turbo) → fallback Kokoro, expressive`.

---

## Configuration

Everything is set in `Luna/.env`. Most changes only need a container recreate (`docker compose up -d --force-recreate luna`), not a rebuild.

Luna checks her settings at startup, and every setting is listed in [`config.js`](Luna-Discord-Bot-Full-Docker/Luna/config.js) with its type and default:
- **An invalid value** is reported and the default is used: `[config] OWW_THRESHOLD="abc" is invalid (expected a number) — using the default (0.5)`.
- **A misspelled name** is reported with the closest real one: `[config] OWW_THRESHHOLD is not one of Luna's settings and is ignored — did you mean OWW_THRESHOLD?`.
- **On/off settings** accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`.

The addresses of LM Studio, Whisper and Kokoro (`LM_STUDIO_URL`, `WHISPER_SERVER_URLS`, `KOKORO_URL`) are set by the compose file and override `.env`; change them there if yours run elsewhere.

### Announcement settings

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `ANNOUNCE_SELF` | `true` | Intro when Luna joins |
| `GREET_ON_JOIN` | `custom` | Greet people who join: `custom` (custom greetings where set, see [Custom greetings](#custom-greetings), the regular one for everyone else), `regular` (the regular one for everyone) or `off`. `true`/`false` still work and mean `custom`/`off` |
| `ANNOUNCE_LEAVE` | `true` | Announce people who leave |
| `GREET_COOLDOWN_MS` / `LEAVE_COOLDOWN_MS` | `600000` | Per-person cooldown |
| `GREET_DELAY_MS` / `LEAVE_DELAY_MS` | `1500` / `3000` | Only announce if they're still joined or still gone after this delay |
| `INTRO_PHRASES` / `GREET_PHRASES` / `FAREWELL_PHRASES` | built-in | Custom wording (see [Announcements](#announcements)) |
| `BOT_JOIN_PHRASES` / `BOT_LEAVE_PHRASES` | `{name} has joined.` / `{name} has left.` | Wording for bots and `IGNORED_USER_IDS` joining and leaving (on with `GREET_ON_JOIN` / `ANNOUNCE_LEAVE`) |
| `GREETINGS_FILE` | `local/greetings.json` | Per-person join greetings and voices (see [Custom greetings](#custom-greetings)) |
| `WEB_SEARCH` | `always` | `always`: offer search on every question and let the model decide. `keywords`: only when keyword rules match. `off`: never (also used when no search server is configured) |
| `SEARCH_MCP_PLUGIN` | unset | Use an MCP server configured in LM Studio's own `mcp.json` instead of connecting to Tavily per request, e.g. `mcp/tavily`. About 1 s faster per question, and no `TAVILY_API_KEY` needed in Luna |
| `LLM_TOOLS` | `true` | Let the LLM play, skip and stop music through smakbot (see [MusicBot integration](#musicbot-integration)) and leave the voice channel when asked; needs `"luna"` in LM Studio's `mcp.json` |
| `LUNA_MCP_PORT` | `8895` | Port of Luna's own MCP server (the LLM's tools). Change it in `docker-compose.metal.yml` and `mcp.json` too |
| `MUSIC_STATUS_URL` | unset (`docker-compose.metal.yml`: `http://host.docker.internal:8896/now-playing`) | smakbot's now-playing endpoint (its `StatusApiPort`): answers "what song is this?" and tells the LLM what is playing. Unset: off |
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
| `WAKE_LISTEN_MS` | `4000` | After a bare "hey Luna" and a pause, how long she waits for the question before answering the greeting. `0` ends the utterance after `SILENCE_MS`, as before |
| `WAKE_FOLLOWUP_MS` | `8000` | After a bare "hey Luna" with no question even after `WAKE_LISTEN_MS`, she asks "did you mean to ask me something?" and that person's next words, if they start within this long of her finishing, are taken as the question without the wake word. `0` answers the bare "hey Luna" as a greeting instead |
| `WAKE_SHADOW` | `false` | A measurement: also transcribe every utterance the wake-word model rejected, and log the ones where Whisper heard "hey Luna" (`[wake] Whisper heard "hey Luna" … that the model missed`). Nothing else anyone says is logged, and she doesn't act on them. See [Measuring missed wake words](#measuring-missed-wake-words) |
| `WAKE_WHISPER_BACKUP` | `false` | A second chance for the wake word: Whisper also transcribes every utterance the wake-word model rejected, and when it hears "hey Luna" she answers, about 0.3 s behind a normal detection. Catches the model's misses (for some voices a third or more of their "hey Luna"s). Costs Whisper time: about 10% of it with 4–5 people talking. See [Measuring missed wake words](#measuring-missed-wake-words) |
| `WAKE_SHADOW_REPORT_MS` | `1800000` | How often the shadow check logs its summary (30 minutes) |
| `WAKE_LOG_FILE` | `logs/wake.jsonl` | The wake-word log: one line per wake-word event, kept across rebuilds. Empty turns it off. See [The wake-word log](#the-wake-word-log) |
| `WAKE_LOG_MAX_MB` | `20` | When the wake-word log passes this size it's renamed to `wake.jsonl.1` (replacing the previous one) and a new one started |
| `WAKE_REPROMPT_PHRASES` | built-in | What she says then, separated by a pipe character; `{name}` is the speaker |
| `OWW_REFRACTORY_MS` | `1500` | Ignore repeat detections for this long |
| `OWW_GRACE_MS` | `2000` | How long before an utterance a detection still counts |
| `OWW_GAIN` | `auto` | `auto`, `off`, or a fixed multiplier |
| `OWW_DEBUG_SCORE` | `0` | Log every score at or above this value |
| `OWW_MELSPEC_PATH` / `OWW_EMBEDDING_PATH` | bundled files | The two openWakeWord feature models, if you replace them |
| `OWW_FEATURE_FRAMES` | `0` | How many feature frames the wake-word model reads; `0` takes it from the model |
| `OWW_AGC_TARGET_RMS` | `4000` | Level the automatic gain boosts quiet speakers towards, for wake-word detection only |

### Audio and memory

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `ENERGY_THRESHOLD` | `300` | Minimum level that counts as speech |
| `SILENCE_MS` | `1000` | Silence that ends an utterance; the biggest fixed latency. About 700 is worth trying |
| `MIN_SPEECH_MS` | `300` | Shorter utterances are ignored |
| `MAX_SPEECH_MS` | `15000` | Force-end an utterance after this much unbroken speech |
| `PREROLL_MS` | `320` | Audio kept from just before speech starts, so first syllables aren't clipped |
| `MAX_SILENCE_FILL_MS` | `2000` | Longest silence re-inserted for the wake-word model when Discord stops sending audio mid-phrase |
| `LM_MEMORY_TTL_MS` | `3600000` | Forget a conversation (a speaker's, or a text channel's) after this much silence: 60 minutes. `LM_MEMORY_MAX_TURNS` still caps how long one grows |
| `LM_MEMORY_MAX_TURNS` | `12` | …or after this many turns |
| `LM_PERSONALITY` | `helpful` | How Luna is described to the model: "You are Luna, a *…* voice assistant". E.g. `fun, bubbly, friendly and helpful` |
| `LM_CONCISE` | `true` | Ask for concise answers. `false` lets her talk more |
| `LM_USE_NAMES` | `true` | Tell the model who is asking (their Discord display name, made speakable) so she can use their name now and then |
| `LM_FLAVOR_PROMPT` / `LM_FLAVOR_CHANCE` | unset / `0.15` | An occasional personality aside, and how often it's added |
| `AUTO_JOIN_CHANNELS` | | Voice channels (names or IDs, comma-separated) Luna joins by herself when someone is in one and she isn't in a channel: at startup, or when someone joins. With people in several, the busiest. She still leaves when the last person does |
| `TEXT_CHAT_CHANNELS` | | Text channels (names or IDs, comma-separated) where you can type to Luna: a message that @mentions her or starts with "Luna" gets a written answer. Everyone in a channel shares one conversation |
| `AUTO_JOIN_TEXT_CHANNEL` | | Text channel (name or ID) she posts in after auto-joining: status messages and smakbot commands. Unset: the voice channel's own chat. Names that match nothing are logged at startup with the channels that do exist |
| `IGNORED_USER_IDS` | | Comma-separated user IDs to ignore (e.g. music bots) |

### Voices, TTS and timeouts

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `TTS_PROVIDER` | `kokoro` | `kokoro`, `qwen3`, `chatterbox` or `elevenlabs` |
| `TTS_FALLBACK` | `kokoro` | Tried after `TTS_PROVIDER`, before Kokoro. `none` disables falling back |
| `TTS_CREDITS_RETRY_MS` | `43200000` | How long ElevenLabs is skipped after running out of credits (12 h) |
| `TTS_PROVIDER_RETRY_MS` | `1800000` | How long ElevenLabs is skipped after a key, voice or plan error |
| `TTS_CACHE_DIR` | `cache/tts` | Where lines she says again and again (greetings, farewells, her intro, the search heads-up, "still thinking" fillers, "did you mean to ask me something?") are kept once rendered, so repeats cost no ElevenLabs credits and start at once. Answers are never cached. A changed voice, model or pronunciation renders afresh; a cached line still plays in the ElevenLabs voice while ElevenLabs is out of credits. Empty turns it off |
| `TTS_CACHE_MAX_MB` | `200` | Past this, the cached lines played least recently are deleted (a line is roughly 20–60 KB) |
| `TTS_EXPRESSIVE` | `true` | Let the LLM add audio tags while a voice that performs them (Chatterbox, an expressive ElevenLabs model) is speaking |
| `TTS_EXPRESSIVE_PROMPT` | per voice | Replaces the audio-tag instruction given to the LLM (each expressive voice has its own, listing its tags) |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | | Required for ElevenLabs |
| `ELEVENLABS_MODEL` | `eleven_v4_turbo` | `eleven_flash_v2_5` is faster but ignores audio tags |
| `ELEVENLABS_OUTPUT_FORMAT` | `mp3_44100_128` | PCM formats need a Pro plan |
| `ELEVENLABS_TIMEOUT_MS` | `10000` | Falls back to Kokoro after this |
| `ELEVENLABS_MAX_CONCURRENCY` | `3` | ElevenLabs requests in progress at once. Plans cap this (3 on the lower tiers); a request over the cap is rejected and that sentence would go to the fallback voice, so extra sentences wait for a free slot instead. Match it to your plan |
| `ELEVENLABS_BASE_URL` | `https://api.elevenlabs.io` | ElevenLabs API address |
| `NAME_PRONUNCIATIONS` | | Names the voice says wrong, respelled the way they sound, separated by a pipe character: `smakus=smack-us\|appa=ah-pah`. Applied to everything she says (whole words, any capitalisation); the LLM still sees the real name |
| `KOKORO_VOICE` | `af_heart` | Also `af_sarah`, `af_bella`, `af_sky`, `bf_emma`, `bf_isabella` |
| `KOKORO_THREADS` / `KOKORO_MAX_CONCURRENCY` | `2` (`4` on Metal) | Set in the compose file, or when running `kokoro-metal.sh` |
| `KOKORO_DEVICE` | `auto` | `cuda`, `mps` or `cpu` |
| `QWEN3_TTS_URL` | set by `docker-compose.metal.yml` | Outside Docker: `http://localhost:8890/v1/audio/speech` |
| `QWEN3_TTS_VOICE` | server default (`luna`) | Any voice in the voices folder |
| `QWEN3_TTS_STREAM` | `false` | `true` plays each sentence while it renders: no pauses, but it stutters when rendering falls behind |
| `CHATTERBOX_URL` | set by `docker-compose.metal.yml` | Outside Docker: `http://localhost:8891/v1/audio/speech` |
| `CHATTERBOX_VOICE` | server default (`default`) | `default` is the built-in voice; any other name is a clone in the voices folder |
| `CHATTERBOX_STREAM` | `false` | `true` plays each sentence while it renders. Too slow for Chatterbox while the LLM writes: sentences get cut off |
| `CHATTERBOX_MODEL` / `CHATTERBOX_TEMPERATURE` / `CHATTERBOX_VOICES_DIR` | `mlx-community/chatterbox-turbo-fp16` / `1.1` / `~/.luna/chatterbox-voices` | Set when starting `chatterbox-metal.sh` (`CHATTERBOX_PORT`, default 8891, too). A higher temperature sounds livelier; 1.1 was preferred by ear over 0.8 and 1.0 |
| `QWEN3_TTS_MODEL` / `QWEN3_TTS_TEMPERATURE` | `…0.6B-Base-8bit` / `0.3` | Set when starting `qwen3-tts-metal.sh`. Each sentence is rendered on its own; a lower temperature keeps the delivery steadier from one sentence to the next, a higher one varies it more |
| `LM_IDLE_TIMEOUT_MS` | `90000` | Give up on the LLM only after this long with no output at all; reasoning, searching and streaming all count as output |
| `LM_TIMEOUT_MS` | `600000` | Overall limit for one LLM request |
| `VOICE_RECOVER_MS` | `20000` | If Discord reports someone speaking but none of their audio can be decrypted for this long, Luna reconnects her voice session (at most every 5 minutes). `0` disables |
| `LUNA_TIMEZONE` | `TZ`, else `UTC` | Time zone used to tell the model today's date (an IANA name, e.g. `America/Los_Angeles`) |
| `LLM_REASONING` | model default | Reasoning level sent to LM Studio: `off`, `low`, `medium`, … as the model allows. Unset uses the model's own default, which can be its maximum |
| `LLM_THINK_LIMIT_MS` | `60000` | If the model has spent this long *reasoning* before the answer starts, ask again with reasoning off. Time spent searching and reading results doesn't count. `0` disables |
| `QUICK_ANSWER_PHRASES` | built-in | What Luna says when she switches to the quick answer, separated by a pipe character |
| `TTS_LOOKAHEAD` | `2` | Sentences synthesized ahead of the one playing |
| `WHISPER_TIMEOUT_MS` / `KOKORO_TIMEOUT_MS` / `QWEN3_TTS_TIMEOUT_MS` / `CHATTERBOX_TIMEOUT_MS` | `60000` / `30000` / `60000` / `60000` | Request timeouts |

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

### Measuring missed wake words

The model's misses don't show up in the logs: a "hey Luna" it scores 0.001 is discarded like any chatter. `WAKE_SHADOW=true` measures them. Every rejected utterance is also sent to Whisper, one at a time, and the ones where Whisper heard "hey Luna" are logged:

```
[wake] Whisper heard "hey Luna" from appa that the model missed (scored 0.004; 2.1s utterance, Whisper 310ms, waited 0ms)
[shadow] last 30 min: 412 discarded clips transcribed (21.3 min of speech), Whisper busy 7.4% (avg 320ms, max 1210ms), longest wait 2.3s, dropped 0, failed 0, backlog 0. Missed "hey Luna": smakus 3, appa 1. Other "Luna" mentions: joel 2.
```

The summary also answers whether Whisper could transcribe everyone all the time: "busy" well under 100% with no drops means it keeps up. Measured with 4–5 people talking for almost 4 hours: at most 10% busy (about 0.27 s per clip), nothing dropped, and the model missed about 3% of one person's "hey Luna"s but a third or more of everyone else's. `WAKE_WHISPER_BACKUP=true` then answers the misses instead of only logging them (the log line ends in "— answering"). A clip that waits more than 30 s is dropped rather than piling up, and only one shadow clip is ever with Whisper at a time, so a real question waits behind at most one.

With the backup on, Whisper also spots near misses: a greeting followed by a word close to "Luna" ("hey Lena", "hi Luma"). It logs just those two words and doesn't answer them. A mishearing that keeps coming up can be added to the wake patterns in `voice-input.js`.

```
[wake] near miss from Fevering: Whisper heard "hey Lena" — not counted as "hey Luna" (model scored 0.006)
```

#### The wake-word log

Docker's log is wiped every time Luna is rebuilt. The wake-word log (`WAKE_LOG_FILE`, `Luna/logs/wake.jsonl` on the host with the Docker Compose setup) is kept, so detection can be looked at per person over days. It has one JSON line per event: `detected` (score), `candidate` and then `confirmed` or `rejected`, `discarded` (ordinary speech: peak score and length), `missed` (caught by the backup; `answered` is `yes`, `late` or `no`) and `near-miss` (`heard`). Every line has the time, the person's display name and their Discord ID. What people said is never written, except a near miss's two words. Writes are small and asynchronous, so they don't slow listening.

```
{"t":"2026-10-26T21:04:11.902Z","event":"discarded","who":"appa","id":"225160648877801472","peak":0.004,"ms":2140}
{"t":"2026-10-26T21:04:12.231Z","event":"missed","who":"appa","id":"225160648877801472","peak":0.004,"ms":2140,"answered":"yes"}
```

To train your own model, use the openWakeWord [Colab notebook](https://colab.research.google.com/drive/1q1oe2zOyZp7UsB3jJiQ1IFn8z5YfjwEb?usp=sharing). It takes about an hour with synthetic data. Export it as ONNX and save it as `Luna/hey_luna.onnx`. Use a phrase of 3–4 syllables; a bare "luna" trains poorly. More detail is in [`openWakeWordNotes.md`](Luna-Discord-Bot-Full-Docker/Luna/openWakeWordNotes.md).

---

## Hardware sizing

**The LLM is almost always the bottleneck.** Whisper and Kokoro are sub-second; a model that doesn't fit in memory can take 25 seconds to reply. On Macs, the GPU can only use about two thirds of total RAM.

| Total RAM | Realistic LLM | Voice |
| --------- | ------------- | ----- |
| 16 GB | 7–8B at Q4 | Kokoro or ElevenLabs. Chatterbox's extra 4 GB doesn't fit comfortably |
| 24 GB | 12–14B at Q4 | Any |
| 32 GB+ | 24–27B at Q4, or a mixture-of-experts model like Qwen3.6 35B-A3B | Any |

Leave roughly 5–6 GB for the OS, Docker, Whisper and a voice, or about 4 GB more if that voice is Chatterbox. Mixture-of-experts models (names ending in something like `A3B`) write much faster than their size suggests, but still need the memory of their full size. Luna was developed on Qwen3.6 35B-A3B on a 32 GB Mac. It fits, but the first answer after a quiet spell can be slow while macOS swaps it back in. For spoken two-sentence replies, a smaller model that answers in 2 seconds beats a larger one that takes 25.

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
| `qwen3-tts-metal.sh` reports port 8890 in use (`chatterbox-metal.sh`: 8891) | Another copy of the script is running in a different terminal |
| `kokoro-metal.sh` reports port 8880 in use | Another Kokoro is running: a leftover container (`docker compose down`) or a second copy of the script |
| `MPS available: False` | Metal needs macOS 12.3+ on Apple Silicon; otherwise Kokoro runs on CPU |
| Slow Whisper or Kokoro on a Mac | You're on the Docker path. Use the Metal scripts instead |
| Voice switches to the backup mid-session, or goes quiet with no backup | ElevenLabs ran out of credits or rejected the key or voice. The `[tts]` log line says which |

Both Metal scripts repair themselves in the usual failure cases. `whisper-metal.sh` rebuilds a build that can't start (for example after the folder was moved). Kokoro works around espeak-ng's path-length limit when its venv sits in a deeply nested folder.

---

## Development

### Code layout

`Luna/` is plain files, one job each. A file only uses files in its own row or the rows below it:

| Layer | Files |
| ----- | ----- |
| Startup and Discord events | `index.js` (wiring, `!luna` commands, auto-join) |
| Where questions come from and go | `voice-session.js` (joining, reconnecting, encrypted-voice recovery), `voice-listen.js` (per-speaker capture and wake word), `voice-answer.js` (utterance → spoken answer), `text-chat.js` (typed questions), `announce.js` (intro, greetings, farewells) |
| Doing things | `answer-llm.js` (LM Studio: prompt, memory, search and tool offers, streaming, what tool calls mean), `commands.js` (fixed commands, routing, smakbot), `voice-playback.js` (the speaking queue), `now-playing.js` (what smakbot is playing), `wake-backup.js` (answering wake words the model missed), `wake-log.js` (the wake-word log), `tts.js` and `tts-cache.js` (rendered phrases), `whisper.js`, `mcp-server.js` |
| Pure helpers | `config.js`, `prompt.js`, `answer-filter.js`, `sentences.js`, `voice-input.js`, `phrases.js`, `llm-tools.js`, `greetings.js`, `wakeword.js` |

Modules that need a library, `fetch`, timers or each other get them as arguments (`createX({ ... })`), which is how the test harness swaps in fakes.

### Tests

Luna's tests live in `Luna/test/` and run without Discord, LM Studio, Whisper or a TTS server: every outside service is faked. They need only Node 22. Without Node on your machine, run them in Docker:

From the repository's top folder:

```bash
docker run --rm -v "$PWD":/repo:ro -w /repo/Luna-Discord-Bot-Full-Docker/Luna node:22-slim npm test
```

With Node installed, `npm test` in `Luna/` does the same. A full run takes about a minute and a quarter.

| File | Covers |
| ---- | ------ |
| `luna.test.js` | Capture, wake word (including two-stage detection), the LLM stream (thinking limit, quick answers, leaked reasoning, search), playback, interruptions, encrypted-voice diagnostics and recovery |
| `tts.test.js` | TTS providers and the fallback chain |
| `announce.test.js` | Intro, join greetings, leave farewells, speakable names |
| `answer-filter.test.js` | What of the LLM's answer Luna says, holds or drops (`answer-filter.js`): each rule, plus LM Studio streams in `test/fixtures/` replayed through the real pipeline |
| `voice-input.test.js` | The voice-input stages (`voice-input.js`) one by one: packet decoding, filling silent gaps for the wake-word model, cutting speech into utterances, the wake decision, finding the question in a transcript, and what to do about a speaker who is never heard |
| `sentences.test.js` | Where the streamed answer is cut into sentences for TTS (`sentences.js`): abbreviations like "St." and "U.S.", decimals and initials are not sentence ends |
| `config.test.js` | Settings (`config.js`): parsing, invalid values, misspelled names, and that the README and `example.env` match the list of settings |
| `bench-score.test.js` | The LLM benchmark's scoring (below), its question file, and the system prompt (`prompt.js`) |
| `harness.js` | Loads `index.js` with Discord, LM Studio, Whisper, TTS and the wake-word engine faked |

The tests are excluded from the Docker image.

### LLM benchmark

`Luna/bench/` compares the models in LM Studio on what matters to Luna: how soon she starts speaking, whether she is right, whether the answer can be read aloud as is, and whether she sounds like herself. It asks the model that is loaded in LM Studio 21 questions (`bench/questions.json`): small talk, facts, mental math, searches, opinions, a "hey Luna" left in the question, and today's weekday. The model gets the exact system prompt Luna sends (`prompt.js`), built from the personality and time zone in `Luna/.env`, and the same search plugin. Each question is a fresh conversation, asked 3 times with reasoning off and 3 times with it on.

Load a model in LM Studio, then from `Luna/`:

```bash
docker run --rm -v "$PWD":/app -w /app node:22-slim node bench/run.js
```

That takes about 15–30 minutes for a fast model. Options: `--takes N`, `--reasoning off` (or `on`), `--only weather,joke`, `--model ID`. Results are saved in `bench/results/`, which git ignores. Repeat for each model you want to compare.

Rate personality blind: answers to the small-talk and opinion questions are shown shuffled, without the model's name, for a score from 1 to 5. Ratings are saved, so you can stop and continue later:

```bash
docker run --rm -it -v "$PWD":/app -w /app node:22-slim node bench/rate.js
```

Then the comparison, one row per model from its latest run (`--all` combines every run of a model):

```bash
docker run --rm -v "$PWD":/app:ro -w /app node:22-slim node bench/report.js
```

| Column | Meaning |
| ------ | ------- |
| Mode | Reasoning `off` (Luna's usual setting); `on` for a model that can't turn it off |
| First word | Median seconds until the first word of the answer — the wait Luna's listeners hear |
| Total, Tok/s | Median seconds for the whole answer, and writing speed |
| Accuracy | Answers that match the answer key and search when they should (and not for math or the date) |
| Voice | Answers fit to read aloud: no markdown, lists, emoji, links, leaked reasoning, follow-up question, or more than 150 words |
| Personality | Mean blind rating, with how many answers were rated |
| Thinking: delay | Extra seconds before the first word with reasoning on (mean over questions); `n/a` if the model can't switch |
| Thinking: accuracy | Change in accuracy with reasoning on |

Below the table, each model's problems are listed by question. The answers are scored as the model wrote them, before Luna's answer filter cleans them up. The occasional flavor line and the ElevenLabs audio-tag instruction are left out of the prompt. Search answers (weather, gold) are checked only for a number, since the right value changes.

---

## FAQ

**Is Luna free? Does she need the cloud?**
Yes, she's free and open source (MIT). The language model, speech-to-text and the default voices all run on your own computer, so there's nothing to pay per question. Web search (Tavily's free tier is enough) and the ElevenLabs voice are optional and use those services.

**What hardware do I need?**
A computer that can run a local LLM: an Apple Silicon Mac with 16 GB or more, or a Linux PC with a decent GPU. The LLM sets the pace; see [Hardware sizing](#hardware-sizing).

**Which LLM should I use?**
Any instruction-tuned model LM Studio can load that fits your RAM. Smaller models answer faster, and for short spoken answers a quick 8–14B model often beats a slow big one. The [LLM benchmark](#llm-benchmark) compares models on speed, accuracy and personality.

**Can several people talk to her at once?**
Yes. Each person has their own wake-word detector and conversation memory, and answers queue so nobody's question cancels someone else's.

**Can she play music?**
Yes, with [smakbot](https://github.com/smakus/smakbot-discord-music-bot): "hey Luna, play …", "skip", "play the top 10", "what song is this?". See [Music with smakbot](#music-with-smakbot).

**Can I change her name, personality or voice?**
Her personality is a setting (`LM_PERSONALITY`, e.g. "fun, friendly and helpful"), and so is the voice (see [Text-to-speech providers](#text-to-speech-providers)). The wake word is a trained model; you can [train your own](#tuning-the-wake-word) for a different phrase.

**Does she work in other languages?**
She listens and answers in English. The LLM can write other languages, and an ElevenLabs voice can speak them ("Luna, say hello in Chinese in the voice channel").

**Why is the first answer after a quiet spell slow?**
If the LLM doesn't comfortably fit in memory, the operating system squeezes it out while it's idle, and the next question waits while it's loaded back. A smaller model, or freeing memory, fixes it; see [Hardware sizing](#hardware-sizing).

## Known limitations

- In voice, memory is per speaker, so Luna can't follow up on what someone *else* asked. (Text channels share one conversation.)
- She listens in English only. The LLM and an ElevenLabs voice can speak other languages.

## Licensing note

openWakeWord's code and its two feature models are Apache-2.0. Its pre-trained phrase models (`hey_jarvis`, `alexa`, `hey_mycroft`) are **CC BY-NC-SA 4.0, non-commercial only**. A model you train yourself has no such restriction.

## License

MIT
