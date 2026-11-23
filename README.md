# Luna: Local AI Voice Assistant for Discord

**Luna** is a free, self-hosted AI voice assistant for Discord. She sits in your voice channel, listens for **"hey Luna"**, and answers out loud: questions, jokes, the weather, music requests. You can also type to her in a text channel.

She runs on your own computer: the AI model, the speech recognition and her voice. There are no per-question bills, and your voices aren't sent to anyone. Web search and a premium cloud voice are optional extras.

If you find this fun or useful, [buy me a coffee](https://buymeacoffee.com/qgt11lbfad)!

**Contents:** [What she can do](#what-she-can-do) · [What you need](#what-you-need) · [Quick start](#quick-start) · [Talking to Luna](#talking-to-luna) · [Optional extras](#optional-extras) · [If something isn't working](#if-something-isnt-working) · [Advanced](#advanced)

## What she can do

- 🎤 **Answers "hey Luna" from anyone in the channel**, out loud, usually within a couple of seconds.
- 🧠 **Remembers the conversation** with each person for an hour, so follow-up questions work.
- 🌐 **Looks things up on the web** when she needs fresh information (optional).
- 🎵 **Plays music on request** together with [smakbot](https://github.com/smakus/smakbot-discord-music-bot), our music bot: "hey Luna, play Crazy by Seal".
- 💬 **Chats in a text channel** too, and can post pictures there.
- 👋 **Greets people** who join, by name, and says goodbye when they leave.

## What you need

- **A computer to run her on**, ideally always on while you use her:
  - **A Mac with Apple Silicon** (M1 or newer) and at least 16 GB of memory (32 GB is better). This is the best experience.
  - **Or a Linux PC** with 16 GB or more. It works, a bit slower.
  - Intel Macs and Windows aren't supported.
- **A Discord server** where you're allowed to add bots.
- **About 30–45 minutes.** Most of it is waiting for downloads.

You don't need to know how to program. You'll copy a few commands into the Terminal and paste a few values into a settings file.

## Quick start

These steps set up the recommended version: Chatterbox, an expressive free voice, on a Mac, or Kokoro, a simpler free voice, on Linux. Other voices and features can be added later ([Optional extras](#optional-extras)).

### 1. Install the tools

Install and open these two apps:

- [**Docker Desktop**](https://www.docker.com/products/docker-desktop/): runs Luna herself.
- [**LM Studio**](https://lmstudio.ai): runs the AI model that writes her answers.

**On a Mac,** also install [Homebrew](https://brew.sh) (follow the one-line install on its home page), then open the **Terminal** app and run:

```bash
xcode-select --install; brew install cmake
```

✅ **You should see:** Docker's whale icon in the menu bar, and LM Studio open.

### 2. Set up LM Studio

1. **Download a model.** In LM Studio's search, pick one that fits your computer's memory:

   | Your computer's memory | Search for |
   | --- | --- |
   | 16 GB | `qwen3-8b` |
   | 24 GB | `qwen3-14b` |
   | 32 GB or more | `qwen3.6-35b-a3b` (what Luna is developed on) |

   A smaller model answers faster. For short spoken answers, fast beats big.

2. **Load it** with **GPU offload** set to the maximum and **context length** set to about 16,000.
3. **Start LM Studio's server.** Open the **Developer** tab and turn the server on. In its settings:
   - set it to serve on the local network (`0.0.0.0`), so Docker can reach it,
   - turn **Require authentication** on, and copy the **API token** it shows. You'll need it in step 4.
   - turn on **MCP** (allows web search and Luna's tools; see [Optional extras](#optional-extras)).

✅ **You should see:** the server status says **Running**, on port 1234.

### 3. Create Luna's Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Call it Luna.
2. Open **Bot**, click **Reset Token**, and copy the token. You'll need it in step 4. Keep it secret: anyone with it can control the bot.
3. On the same page, turn on **Message Content Intent** and save.
4. Open **OAuth2 → URL Generator**. Tick **bot**, then these permissions: **View Channels**, **Send Messages**, **Attach Files**, **Add Reactions**, **Read Message History**, **Connect**, **Speak** and **Use Voice Activity**. Open the link it makes and add the bot to your server.

✅ **You should see:** Luna in your server's member list, offline for now.

### 4. Download Luna and fill in her settings

In the Terminal:

```bash
git clone https://github.com/smakus/luna-discord-ai-voice-chatbot
cd luna-discord-ai-voice-chatbot/Luna-Discord-Bot-Full-Docker
cp Luna/example.env Luna/.env
open -e Luna/.env
```

(On Linux, use `nano Luna/.env` instead of the last line.)

That opens her settings file. Fill in the two tokens you copied:

```env
DISCORD_TOKEN=the bot token from step 3
LM_STUDIO_MCP_BEARER_TOKEN=the LM Studio token from step 2
```

**On a Mac,** also change the voice line to:

```env
TTS_PROVIDER=chatterbox
```

Then find these three lines, remove the `#` at the start of each, and put in your own channel names:

```env
# The voice channel she joins by herself when someone's in it
AUTO_JOIN_CHANNELS=General
# The text channel she posts in (music commands, status)
AUTO_JOIN_TEXT_CHANNEL=general
# Text channels where people can type "Luna, …" to her
TEXT_CHAT_CHANNELS=general
```

Everything else in the file is already set to what we recommend. You can change her personality on the `LM_PERSONALITY` line, e.g. `LM_PERSONALITY=sarcastic, witty and helpful`. Save the file.

✅ **You should see:** your two tokens in `Luna/.env`, with no spaces around the `=`.

### 5. Start Luna

**On a Mac,** Luna runs as three parts, each in its own Terminal window or tab. Open them in this order, from the `Luna-Discord-Bot-Full-Docker` folder, and wait for each to say it's ready before starting the next. The first start of each one downloads and builds for a few minutes.

1. **Speech recognition:**

   ```bash
   ./scripts/whisper-metal.sh
   ```

   ✅ Ready when it says it's listening on port 8081.

2. **Her voice:**

   ```bash
   ./scripts/chatterbox-metal.sh
   ```

   ✅ Ready when it says `Starting … server`.

3. **Luna:**

   ```bash
   docker compose -f docker-compose.metal.yml up --build
   ```

**On Linux,** one command starts everything:

```bash
docker compose up --build
```

✅ **You should see:** `Ready! Wake phrase: "hey Luna"` in Luna's window, and Luna online in Discord.

### 6. Say hello

Join the voice channel you set in step 4; she joins you by herself. (Or type `!luna` in a text channel to call her into the channel you're in.) Once she's introduced herself, say:

> **"Hey Luna, what's two plus two?"**

She plays a chime when she's heard you, then answers. 🎉 If she doesn't, see [If something isn't working](#if-something-isnt-working).

### Stopping, restarting and updating

| To | Do |
| --- | --- |
| Stop her | Press `Ctrl-C` in each Terminal window |
| Start her again | Run the commands from step 5 again |
| Apply a change to `Luna/.env` | Press `Ctrl-C` in Luna's window and run its step 5 command again |
| Update to the latest version | `git pull`, then restart as above |

Your settings, custom greetings and logs are kept when you update.

## Talking to Luna

Say **"hey Luna"** and your request, in one go or with a pause after "hey Luna". She waits a few seconds for the question. Saying "hey Luna" again interrupts her answer to you.

| Try saying | What happens |
| --- | --- |
| "Hey Luna, tell me a joke" | She answers |
| "Hey Luna, what's the weather tomorrow?" | She searches the web, then answers (needs [web search](#web-search)) |
| "Hey Luna, and what about Saturday?" | She remembers your conversation for an hour |
| "Hey Luna, play Bohemian Rhapsody" | Plays it (needs [smakbot](#music)) |
| "Hey Luna, skip" / "pause" / "stop the music" | Controls the music |
| "Hey Luna, what song is this?" | Says what's playing and who asked for it |
| "Hey Luna, show me a picture of a capybara" | Posts one in the text channel (needs [web search](#web-search)) |
| "Hey Luna, you can go now" | Says goodbye and leaves |

In a text channel from `TEXT_CHAT_CHANNELS`, start a message with **"Luna,"** or @mention her: *"Luna, what's the capital of Peru?"* She replies in writing.

**Commands you can type:**

| Command | What it does |
| --- | --- |
| `!luna` | Joins the voice channel you're in |
| `!luna leave` | Leaves the voice channel |
| `!luna say <text>` | Says exactly that text out loud |
| `!luna voicecheck` | Checks that she can hear everyone (see [If something isn't working](#if-something-isnt-working)) |

More examples are in [Using Luna in depth](#using-luna-in-depth).

## Optional extras

Each one is independent: add any of them whenever you like.

### Web search

Lets her answer questions about the news, the weather, prices and scores, and post pictures. Get a free key at [tavily.com](https://tavily.com) and add it to `Luna/.env`:

```env
TAVILY_API_KEY=your key
```

### Let her use tools

Lets the AI model do things itself, not just talk: play music from requests like "put on something chill", post pictures, and leave when told to. In LM Studio, open **Program → Install → Edit mcp.json** and add this inside `"mcpServers"`, next to anything already there:

```json
"luna": { "url": "http://127.0.0.1:8895/mcp" }
```

### Music

Luna doesn't play music herself: she asks [smakbot](https://github.com/smakus/smakbot-discord-music-bot), our Discord music bot. Set smakbot up from its own guide, then connect the two as described in [MusicBot integration](#musicbot-integration).

### A different voice

The [voice options](#her-voice) include **ElevenLabs**, a paid cloud voice and the most expressive, and **Qwen3-TTS**, a free Mac voice you design from a description. Chatterbox can also clone a voice from a 15-second clip.

### Personal welcomes

Give particular people their own welcome line, even in their own voice. See [Custom greetings](#custom-greetings).

### A model that isn't Qwen

`Luna/.env` comes tuned for the Qwen models in step 2: reasoning off, and the sampling settings Qwen recommends (`LM_TEMPERATURE`, `LM_TOP_P`, `LM_TOP_K`, `LM_MIN_P`, `LM_REPEAT_PENALTY`). For another model, use the values from its model card, or delete those five lines to use LM Studio's own settings for it.

## If something isn't working

| Problem | Try this |
| --- | --- |
| She doesn't join | Check that her window shows `Ready!`, then type `!luna` while you're in a voice channel |
| She joins but never answers "hey Luna" | Type `!luna voicecheck`. If it shows 0 for you while you talk, restart Luna (`Ctrl-C`, then step 5 again) |
| Her answers take 20+ seconds | The model is too big for your computer's memory: pick a smaller one in step 2 |
| She answers once, then stops | She's hearing herself through your speakers. Use headphones |
| She doesn't reply in the text channel | Check `TEXT_CHAT_CHANNELS` matches the channel's name, and that **Message Content Intent** is on (step 3) |
| Her window says LM Studio can't be reached | Check LM Studio's server is running and serving on the local network (step 2) |

More in [Troubleshooting](#troubleshooting).

---

# Advanced

Everything below is for when you want to change how Luna behaves, understand what she's doing, or fix something. Each part starts with the common changes in plain words; the full list of settings is folded away underneath (click to open it).

**Contents:** [Changing settings](#changing-settings) · [Using Luna in depth](#using-luna-in-depth) · [Personality and answers](#personality-and-answers) · [Her voice](#her-voice) · [Listening and the wake word](#listening-and-the-wake-word) · [Channels, greetings and announcements](#channels-greetings-and-announcements) · [Web search, pictures and tools](#web-search-pictures-and-tools) · [Music with smakbot](#music-with-smakbot) · [How it works](#how-it-works) · [Hardware sizing](#hardware-sizing) · [Troubleshooting](#troubleshooting) · [FAQ](#faq) · [Working on Luna's code](#working-on-lunas-code)

## Changing settings

Everything is set in `Luna/.env`. After changing it, restart Luna: press `Ctrl-C` in her window and run her start command again (`docker compose -f docker-compose.metal.yml up --build` on a Mac, `docker compose up --build` on Linux).

Luna checks her settings at startup, and every setting is listed in [`config.js`](Luna-Discord-Bot-Full-Docker/Luna/config.js) with its type and default:
- **An invalid value** is reported and the default is used: `[config] OWW_THRESHOLD="abc" is invalid (expected a number) — using the default (0.5)`.
- **A misspelled name** is reported with the closest real one: `[config] OWW_THRESHHOLD is not one of Luna's settings and is ignored — did you mean OWW_THRESHOLD?`.
- **On/off settings** accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`.

The addresses of LM Studio, Whisper and Kokoro (`LM_STUDIO_URL`, `WHISPER_SERVER_URLS`, `KOKORO_URL`) are set by the compose file and override `.env`; change them there if yours run elsewhere.

## Using Luna in depth

### Talking to her

Join a voice channel and type `!luna` in a text channel (or set up [auto-join](#channels-greetings-and-announcements) so she comes by herself). She joins and introduces herself. Then say **"hey Luna"** and your request:

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
- Music works the same way: *"Luna, play …"*, *"skip"*, *"stop"*, *"play the top 10"*, *"what song is this?"*, *"what are our top songs?"*
- **She can say things out loud for you:** *"Luna, say hello in Chinese in the voice channel"*, *"Luna, tell everyone in vc that dinner is ready"*. Requests like these ("say / tell / announce … in the voice channel / vc / voice") have the LLM write just the line. Luna speaks it in her voice channel and posts *"🔊 Said in Talk Soup: 你好！"*. Other phrasings ("give Joel a warm welcome out loud") go through the LLM's `say_in_voice` tool. Lines are capped at 400 characters and wait their turn behind whatever she's saying. With Chatterbox (English only) as the voice, other languages won't sound right.

### Text commands

| Command | What it does |
| ------- | ------------ |
| `!luna` | Joins the voice channel you're in, or moves there if she's elsewhere |
| `!luna leave` | Leaves the voice channel. With auto-join on, she stays away until the channel has emptied once, or someone types `!luna` |
| `!luna say <text>` | Says exactly that text out loud in her voice channel, with no LLM involved, and reacts 🔊 |
| `!luna voicecheck` | Shows, for each person, whether Luna can decrypt their voice (see [Troubleshooting](#troubleshooting)) |
| `!luna wakestats` | How well the wake word worked for each person over the last day: how many of their "hey Luna"s she answered, and how (the model, the near-threshold check or the backup), their typical score and near misses. `!luna wakestats 7d` or `12h` for another span. Read from [the wake-word log](#the-wake-word-log) |

## Personality and answers

- **Her personality:** `LM_PERSONALITY` is how she's described to the model: "You are Luna, a *fun, friendly and helpful* voice assistant". A few words change her tone a lot.
- **Longer or shorter answers:** `LM_CONCISE=true` asks for short answers; `false` lets her talk more.
- **An occasional running joke:** `LM_FLAVOR_PROMPT` is an aside added to some answers (`LM_FLAVOR_CHANCE`, 15% by default), e.g. a fondness for a restaurant.
- **How long she remembers:** each person's conversation is forgotten after an hour of quiet (`LM_MEMORY_TTL_MS`) or 12 exchanges (`LM_MEMORY_MAX_TURNS`). Shorter memory keeps answers fast.
- **The model's settings:** `LLM_REASONING=off` makes reasoning models answer straight away instead of thinking first. The `LM_TEMPERATURE` group overrides the sampling settings saved in LM Studio; `Luna/.env` comes with Qwen's.
- **"Still thinking" fillers** while a slow answer starts: when (`THINKING_WAITS`), how many (`THINKING_MAX`) and what she says (`THINKING_PHRASES`), or none (`ANNOUNCE_THINKING=false`).
- **Today's date:** `LUNA_TIMEZONE` (e.g. `America/Los_Angeles`) so "what day is it?" is right where you are.

<details>
<summary><b>All personality and answer settings</b></summary>

| Setting | Default | What it does |
| --- | --- | --- |
| `LM_PERSONALITY` | `helpful` | How Luna is described to the model: "You are Luna, a *…* voice assistant". E.g. `fun, bubbly, friendly and helpful` |
| `LM_CONCISE` | `true` | Ask for concise answers. `false` lets her talk more |
| `LM_USE_NAMES` | `true` | Tell the model who is asking (their Discord display name, made speakable) so she can use their name now and then |
| `LM_FLAVOR_PROMPT` / `LM_FLAVOR_CHANCE` | unset / `0.15` | An occasional personality aside, and how often it's added |
| `LM_MEMORY_TTL_MS` | `3600000` | Forget a conversation (a speaker's, or a text channel's) after this much silence: 60 minutes. `LM_MEMORY_MAX_TURNS` still caps how long one grows |
| `LM_MEMORY_MAX_TURNS` | `12` | …or after this many turns |
| `LLM_REASONING` | model default | Reasoning level sent to LM Studio: `off`, `low`, `medium`, … as the model allows. Unset uses the model's own default, which can be its maximum |
| `LM_TEMPERATURE` / `LM_TOP_P` / `LM_TOP_K` / `LM_MIN_P` / `LM_REPEAT_PENALTY` | unset | Sampling settings sent with every request, overriding what LM Studio has saved for the model (each one only if set). Use the model card's values for its non-thinking mode, e.g. Qwen 0.7 / 0.8 / 20 / 0, and a repeat penalty around 1.05 against endless repetition. Sent with the request they can't be lost to an LM Studio update, and LM Studio's request history shows them |
| `LLM_THINK_LIMIT_MS` | `60000` | If the model has spent this long *reasoning* before the answer starts, ask again with reasoning off. Time spent searching and reading results doesn't count. `0` disables |
| `QUICK_ANSWER_PHRASES` | built-in | What Luna says when she switches to the quick answer, separated by a pipe character |
| `ANNOUNCE_THINKING` | `true` | Say "still thinking" fillers while an answer is slow to start |
| `THINKING_WAITS` | `15-22,22-30,30-40` | Wait windows in seconds for the 1st, 2nd, … filler; the last window repeats |
| `THINKING_MAX` | `0` | Maximum fillers per question; `0` means no limit |
| `THINKING_PHRASES` | built-in | Custom filler phrases, separated by a pipe character; `{name}` is the asker's name |
| `LUNA_TIMEZONE` | `TZ`, else `UTC` | Time zone used to tell the model today's date (an IANA name, e.g. `America/Los_Angeles`) |
| `LM_IDLE_TIMEOUT_MS` | `90000` | Give up on the LLM only after this long with no output at all; reasoning, searching and streaming all count as output |
| `LM_TIMEOUT_MS` | `600000` | Overall limit for one LLM request |

</details>

## Her voice

| Voice | Runs on | Expressive? | Cost | Best for |
| --- | --- | --- | --- | --- |
| **ElevenLabs** | Cloud | The most: any emotion or delivery, combined freely | Paid, per character | The best voice, if you'll pay for it |
| **Chatterbox Turbo** | Apple Silicon | Yes: 8 emotions and 9 sounds (laughs, sighs, whispers …) | Free | **The recommended free voice on a Mac** |
| **Qwen3-TTS** | Apple Silicon | No, but in a voice you design | Free | A unique voice; expect short pauses between sentences |
| **Kokoro** | Everywhere | No | Free | Linux, or the simplest setup |

`TTS_PROVIDER` picks the voice. You only need that one running; `TTS_FALLBACK` adds an optional backup for when it fails (then Kokoro, if it's running; `TTS_FALLBACK=none` for no backup at all). Lines she says again and again (greetings, the search heads-up, fillers) are kept once rendered (`TTS_CACHE_DIR`), so with ElevenLabs they only cost credits the first time.

**Common changes:**

- **Switch voice:** set `TTS_PROVIDER` (`kokoro`, `chatterbox`, `qwen3` or `elevenlabs`) and start that voice's server; see the voices below.
- **A backup voice** for when the main one fails (useful with ElevenLabs, in case credits run out): `TTS_FALLBACK`.
- **Names she says wrong:** `NAME_PRONUNCIATIONS=smakus=smack-us|appa=ah-pah` respells them for the voice only; the model still sees the real name.
- **A different Kokoro voice:** `KOKORO_VOICE` (`af_heart`, `af_sarah`, `af_bella`, `af_sky`, `bf_emma`, `bf_isabella`).
- **A cloned Chatterbox voice:** `CHATTERBOX_VOICE`; see [Chatterbox Turbo](#chatterbox-turbo-apple-silicon).

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
  - Lines she has said before (greetings, fillers, the search heads-up) still play in the ElevenLabs voice from the [phrase cache](#her-voice), backup or not.
- **Expressiveness:** with `eleven_v4_turbo` (the default model), the LLM is told it may add audio tags wherever they fit: emotions (`[curious]`, `[warm]`, `[playful]`, `[worried]` …), reactions (`[laughs]`, `[sighs]`, `[gasps]` …), delivery (`[whispers]`, `[pause]`, `[hesitates]` …) and combined directions like `[warm, laughing softly]`. Kokoro and Qwen3-TTS never get that instruction, and any tag that does reach them is removed, so they never read "[laughs]" aloud. `TTS_EXPRESSIVE=false` turns this off.
- **Cost and privacy:** ElevenLabs is billed per character, and the text Luna speaks is sent to their servers.

With `TTS_FALLBACK=chatterbox` (or `qwen3`), Luna tries ElevenLabs, then that voice, then Kokoro if it's running.

The startup log shows the active setup, for example `[tts] ElevenLabs (eleven_v4_turbo) → fallback Kokoro, expressive`.

<details>
<summary><b>All voice settings</b></summary>

| Setting | Default | What it does |
| --- | --- | --- |
| `TTS_PROVIDER` | `kokoro` | `kokoro`, `qwen3`, `chatterbox` or `elevenlabs` |
| `TTS_FALLBACK` | `kokoro` | Tried after `TTS_PROVIDER`, before Kokoro. `none` disables falling back |
| `TTS_CREDITS_RETRY_MS` | `43200000` | How long ElevenLabs is skipped after running out of credits (12 h) |
| `TTS_PROVIDER_RETRY_MS` | `1800000` | How long ElevenLabs is skipped after a key, voice or plan error |
| `TTS_CACHE_DIR` | `cache/tts` | Where lines she says again and again (greetings, farewells, her intro, the search heads-up, "still thinking" fillers, "did you mean to ask me something?") are kept once rendered, so repeats cost no ElevenLabs credits and start at once. Answers are never cached. A changed voice, model or pronunciation renders afresh; a cached line still plays in the ElevenLabs voice while ElevenLabs is out of credits. Empty turns it off |
| `TTS_CACHE_MAX_MB` | `200` | Past this, the cached lines played least recently are deleted (a line is roughly 20–60 KB) |
| `TTS_EXPRESSIVE` | `true` | Let the LLM add audio tags while a voice that performs them (Chatterbox, an expressive ElevenLabs model) is speaking |
| `TTS_EXPRESSIVE_PROMPT` | per voice | Replaces the audio-tag instruction given to the LLM (each expressive voice has its own, listing its tags) |
| `NAME_PRONUNCIATIONS` | | Names the voice says wrong, respelled the way they sound, separated by a pipe character: `smakus=smack-us\|appa=ah-pah`. Applied to everything she says (whole words, any capitalisation); the LLM still sees the real name |
| `TTS_LOOKAHEAD` | `2` | Sentences synthesized ahead of the one playing |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | | Required for ElevenLabs |
| `ELEVENLABS_MODEL` | `eleven_v4_turbo` | `eleven_flash_v2_5` is faster but ignores audio tags |
| `ELEVENLABS_OUTPUT_FORMAT` | `mp3_44100_128` | PCM formats need a Pro plan |
| `ELEVENLABS_TIMEOUT_MS` | `10000` | Falls back to Kokoro after this |
| `ELEVENLABS_MAX_CONCURRENCY` | `3` | ElevenLabs requests in progress at once. Plans cap this (3 on the lower tiers); a request over the cap is rejected and that sentence would go to the fallback voice, so extra sentences wait for a free slot instead. Match it to your plan |
| `ELEVENLABS_BASE_URL` | `https://api.elevenlabs.io` | ElevenLabs API address |
| `CHATTERBOX_URL` | set by `docker-compose.metal.yml` | Outside Docker: `http://localhost:8891/v1/audio/speech` |
| `CHATTERBOX_VOICE` | server default (`default`) | `default` is the built-in voice; any other name is a clone in the voices folder |
| `CHATTERBOX_STREAM` | `false` | `true` plays each sentence while it renders. Too slow for Chatterbox while the LLM writes: sentences get cut off |
| `CHATTERBOX_MODEL` / `CHATTERBOX_TEMPERATURE` / `CHATTERBOX_VOICES_DIR` | `mlx-community/chatterbox-turbo-fp16` / `0.6` / `~/.luna/chatterbox-voices` | Set when starting `chatterbox-metal.sh` (`CHATTERBOX_PORT`, default 8891, too). A higher temperature sounds livelier but warbles and drifts, cloned voices most; 0.6 won a blind comparison with 1.1 |
| `QWEN3_TTS_URL` | set by `docker-compose.metal.yml` | Outside Docker: `http://localhost:8890/v1/audio/speech` |
| `QWEN3_TTS_VOICE` | server default (`luna`) | Any voice in the voices folder |
| `QWEN3_TTS_STREAM` | `false` | `true` plays each sentence while it renders: no pauses, but it stutters when rendering falls behind |
| `QWEN3_TTS_MODEL` / `QWEN3_TTS_TEMPERATURE` | `…0.6B-Base-8bit` / `0.3` | Set when starting `qwen3-tts-metal.sh`. Each sentence is rendered on its own; a lower temperature keeps the delivery steadier from one sentence to the next, a higher one varies it more |
| `KOKORO_VOICE` | `af_heart` | Also `af_sarah`, `af_bella`, `af_sky`, `bf_emma`, `bf_isabella` |
| `KOKORO_THREADS` / `KOKORO_MAX_CONCURRENCY` | `2` (`4` on Metal) | Set in the compose file, or when running `kokoro-metal.sh` |
| `KOKORO_DEVICE` | `auto` | `cuda`, `mps` or `cpu` |
| `WHISPER_TIMEOUT_MS` / `KOKORO_TIMEOUT_MS` / `QWEN3_TTS_TIMEOUT_MS` / `CHATTERBOX_TIMEOUT_MS` | `60000` / `30000` / `60000` / `60000` | Request timeouts |

</details>

## Listening and the wake word

Luna listens to each person separately. A small wake-word model scores everything said for "hey Luna"; when it's confident, she transcribes what follows with Whisper and answers.

- **She misses "hey Luna":** keep `WAKE_WHISPER_BACKUP=true` (on in `Luna/.env`): Whisper double-checks what the model rejected and catches most misses. Check how she's doing per person with `!luna wakestats`.
- **She triggers when nobody said it:** raise `OWW_THRESHOLD` a little (0.35 → 0.45).
- **She cuts people off, or waits too long after they stop:** `SILENCE_MS` is the pause that ends a question (1 second).
- **Quiet people aren't heard:** lower `ENERGY_THRESHOLD`, the level that counts as speech. Also ask them to turn off Discord's noise suppression.
- **A more accurate speech recognizer** on a Mac: start Whisper with `WHISPER_MODEL=ggml-medium.en-q5_0.bin ./scripts/whisper-metal.sh`.

<details>
<summary><b>All listening and wake-word settings</b></summary>

| Setting | Default | What it does |
| --- | --- | --- |
| `OWW_ENABLED` | `true` | `false` falls back to matching "hey Luna" in the transcript |
| `OWW_MODEL_PATH` | `hey_luna.onnx` | Wake word classifier |
| `OWW_THRESHOLD` | `0.5` | Detection confidence; tune it against real scores |
| `OWW_TRIGGER_FRAMES` | `1` | Consecutive frames above threshold required |
| `OWW_CANDIDATE_THRESHOLD` | `0.1` | Two-stage detection: an utterance that peaks at or above this but never reaches `OWW_THRESHOLD` is transcribed anyway, and kept only if Whisper hears "Luna" in it. Catches "hey Luna" run straight into the question, which the model scores low. `0` turns it off; it has no effect when it isn't below `OWW_THRESHOLD` |
| `WAKE_LISTEN_MS` | `4000` | After a bare "hey Luna" and a pause, how long she waits for the question before answering the greeting. `0` ends the utterance after `SILENCE_MS`, as before |
| `WAKE_FOLLOWUP_MS` | `8000` | After a bare "hey Luna" with no question even after `WAKE_LISTEN_MS`, she asks "did you mean to ask me something?" and that person's next words, if they start within this long of her finishing, are taken as the question without the wake word. `0` answers the bare "hey Luna" as a greeting instead |
| `WAKE_REPROMPT_PHRASES` | built-in | What she says then, separated by a pipe character; `{name}` is the speaker |
| `WAKE_WHISPER_BACKUP` | `false` | A second chance for the wake word: Whisper also transcribes every utterance the wake-word model rejected, and when it hears "hey Luna" she answers, about 0.3 s behind a normal detection. Catches the model's misses (for some voices a third or more of their "hey Luna"s). Costs Whisper time: about 10% of it with 4–5 people talking. See [Measuring missed wake words](#measuring-missed-wake-words) |
| `WAKE_SHADOW` | `false` | A measurement: also transcribe every utterance the wake-word model rejected, and log the ones where Whisper heard "hey Luna" (`[wake] Whisper heard "hey Luna" … that the model missed`). Nothing else anyone says is logged, and she doesn't act on them. See [Measuring missed wake words](#measuring-missed-wake-words) |
| `WAKE_SHADOW_REPORT_MS` | `1800000` | How often the shadow check logs its summary (30 minutes) |
| `WAKE_LOG_FILE` | `logs/wake.jsonl` | The wake-word log: one line per wake-word event, kept across rebuilds. Empty turns it off. See [The wake-word log](#the-wake-word-log) |
| `WAKE_LOG_MAX_MB` | `20` | When the wake-word log passes this size it's renamed to `wake.jsonl.1` (replacing the previous one) and a new one started |
| `OWW_REFRACTORY_MS` | `1500` | Ignore repeat detections for this long |
| `OWW_GRACE_MS` | `2000` | How long before an utterance a detection still counts |
| `OWW_GAIN` | `auto` | `auto`, `off`, or a fixed multiplier |
| `OWW_AGC_TARGET_RMS` | `4000` | Level the automatic gain boosts quiet speakers towards, for wake-word detection only |
| `OWW_DEBUG_SCORE` | `0` | Log every score at or above this value |
| `OWW_MELSPEC_PATH` / `OWW_EMBEDDING_PATH` | bundled files | The two openWakeWord feature models, if you replace them |
| `OWW_FEATURE_FRAMES` | `0` | How many feature frames the wake-word model reads; `0` takes it from the model |
| `ENERGY_THRESHOLD` | `300` | Minimum level that counts as speech |
| `SILENCE_MS` | `1000` | Silence that ends an utterance; the biggest fixed latency. About 700 is worth trying |
| `MIN_SPEECH_MS` | `300` | Shorter utterances are ignored |
| `MAX_SPEECH_MS` | `15000` | Force-end an utterance after this much unbroken speech |
| `PREROLL_MS` | `320` | Audio kept from just before speech starts, so first syllables aren't clipped |
| `MAX_SILENCE_FILL_MS` | `2000` | Longest silence re-inserted for the wake-word model when Discord stops sending audio mid-phrase |
| `VOICE_RECOVER_MS` | `20000` | If Discord reports someone speaking but none of their audio can be decrypted for this long, Luna reconnects her voice session (at most every 5 minutes). `0` disables |

</details>

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

Docker's log is wiped every time Luna is rebuilt. The wake-word log (`WAKE_LOG_FILE`, `Luna/logs/wake.jsonl` on the host with the Docker Compose setup) is kept, so detection can be looked at per person over days. It has one JSON line per event: `detected` (score), `candidate` and then `confirmed` or `rejected` (with what Whisper heard where "hey Luna" should be: a near miss like "hey Lina", else the first three words), `discarded` (ordinary speech: peak score and length), `missed` (caught by the backup; `answered` is `yes`, `late` or `no`) and `near-miss` (`heard`). Every line has the time, the person's display name and their Discord ID. What people said is never written, except a near miss's two words and the first three words of a rejected near-threshold clip. Writes are small and asynchronous, so they don't slow listening.

```
{"t":"2026-10-26T21:04:11.902Z","event":"discarded","who":"appa","id":"225160648877801472","peak":0.004,"ms":2140}
{"t":"2026-10-26T21:04:12.231Z","event":"missed","who":"appa","id":"225160648877801472","peak":0.004,"ms":2140,"answered":"yes"}
```

To train your own model, use the openWakeWord [Colab notebook](https://colab.research.google.com/drive/1q1oe2zOyZp7UsB3jJiQ1IFn8z5YfjwEb?usp=sharing). It takes about an hour with synthetic data. Export it as ONNX and save it as `Luna/hey_luna.onnx`. Use a phrase of 3–4 syllables; a bare "luna" trains poorly. More detail is in [`openWakeWordNotes.md`](Luna-Discord-Bot-Full-Docker/Luna/openWakeWordNotes.md).

## Channels, greetings and announcements

- **Join by herself:** `AUTO_JOIN_CHANNELS` lists voice channels she joins when someone is in one; she leaves when the last person does. `AUTO_JOIN_TEXT_CHANNEL` is where she then posts (music commands, status).
- **Text chat:** `TEXT_CHAT_CHANNELS` lists the channels where "Luna, …" or an @mention gets a written answer.
- **Ignore someone** (another bot, say): `IGNORED_USER_IDS`.
- **Greetings and goodbyes:** on by default; change the wording, give people their own, or turn them off (below).

### Custom greetings

A few people can get their own join greeting, optionally in their own voice (ElevenLabs, or a Chatterbox clone). Copy `Luna/greetings.example.json` to `Luna/local/greetings.json` and edit it:

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
- Or `"voice": "chatterbox:<name>"` for a [Chatterbox](#chatterbox-turbo-apple-silicon) clone: put 10–20 seconds of clear speech as `<name>.wav` in Chatterbox's voices folder (no restart needed). It works with or without ElevenLabs, as long as Chatterbox is running.
- A phrase can also have a voice of its own: `{ "text": "Make it so, {user}. Engage!", "voice": "chatterbox:stewart" }` among the other phrases. Phrases without one use the person's `voice`.
- `GREET_ON_JOIN=regular` gives everyone the regular greeting without touching the file; `off` turns join greetings off.
- Same cooldown and switches as the normal greeting. If the picked phrase's voice can't be used (ElevenLabs down or out of credits, Chatterbox not running, unknown voice), they get the normal greeting in the normal voice.
- `Luna/local/` is mounted into the container and ignored by git: edit the file and restart Luna, no rebuild. The startup log lists who has a custom greeting and warns about voices ElevenLabs or Chatterbox doesn't know (checking costs no credits).

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

<details>
<summary><b>All channel, greeting and announcement settings</b></summary>

| Setting | Default | What it does |
| --- | --- | --- |
| `AUTO_JOIN_CHANNELS` | | Voice channels (names or IDs, comma-separated) Luna joins by herself when someone is in one and she isn't in a channel: at startup, or when someone joins. With people in several, the busiest. She still leaves when the last person does |
| `AUTO_JOIN_TEXT_CHANNEL` | | Text channel (name or ID) she posts in after auto-joining: status messages and smakbot commands. Unset: the voice channel's own chat. Names that match nothing are logged at startup with the channels that do exist |
| `TEXT_CHAT_CHANNELS` | | Text channels (names or IDs, comma-separated) where you can type to Luna: a message that @mentions her or starts with "Luna" gets a written answer. Everyone in a channel shares one conversation |
| `IGNORED_USER_IDS` | | Comma-separated user IDs to ignore (e.g. music bots) |
| `ANNOUNCE_SELF` | `true` | Intro when Luna joins |
| `GREET_ON_JOIN` | `custom` | Greet people who join: `custom` (custom greetings where set, see [Custom greetings](#custom-greetings), the regular one for everyone else), `regular` (the regular one for everyone) or `off`. `true`/`false` still work and mean `custom`/`off` |
| `ANNOUNCE_LEAVE` | `true` | Announce people who leave |
| `GREET_COOLDOWN_MS` / `LEAVE_COOLDOWN_MS` | `600000` | Per-person cooldown |
| `GREET_DELAY_MS` / `LEAVE_DELAY_MS` | `1500` / `3000` | Only announce if they're still joined or still gone after this delay |
| `INTRO_PHRASES` / `GREET_PHRASES` / `FAREWELL_PHRASES` | built-in | Custom wording (see [Announcements](#announcements)) |
| `BOT_JOIN_PHRASES` / `BOT_LEAVE_PHRASES` | `{name} has joined.` / `{name} has left.` | Wording for bots and `IGNORED_USER_IDS` joining and leaving (on with `GREET_ON_JOIN` / `ANNOUNCE_LEAVE`) |
| `GREETINGS_FILE` | `local/greetings.json` | Per-person join greetings and voices (see [Custom greetings](#custom-greetings)) |

</details>

## Web search, pictures and tools

**Web search** needs a free [Tavily](https://tavily.com) key (`TAVILY_API_KEY`). The model decides when a question needs fresh information, and she says so out loud ("let me take a look") while she searches. The same key lets her [post pictures](#using-luna-in-depth) in the text channel.

Luna offers the model web search on every question, and the model decides when it needs current information; you'll hear the heads-up whenever it actually searches. Set `WEB_SEARCH=keywords` to go back to keyword-triggered search, or `off` to disable it. If the search server is unreachable, Luna answers without it and pauses search for a few minutes. If Tavily is already set up in LM Studio's MCP settings (`mcp.json`), set `SEARCH_MCP_PLUGIN=mcp/tavily`, and LM Studio keeps that connection open instead of Luna connecting on every question.

**Tools** let the model act, not just talk: queue music (`play_music`, `play_top_songs`), skip, pause, resume or stop it, look up the most played and most requested songs (`list_top_songs`, `list_top_requesters`), post a picture (`post_image`), leave the channel (`leave_channel`) and, from text chat, say something in the voice channel (`say_in_voice`). Luna serves them to LM Studio on port 8895; LM Studio only uses them once `"luna": { "url": "http://127.0.0.1:8895/mcp" }` is in its `mcp.json` (see [Optional extras](#let-her-use-tools)). If she ever says she queued music without calling the tool, she quietly asks the model once more to make the calls.

<details>
<summary><b>All web search and tool settings</b></summary>

| Setting | Default | What it does |
| --- | --- | --- |
| `WEB_SEARCH` | `always` | `always`: offer search on every question and let the model decide. `keywords`: only when keyword rules match. `off`: never (also used when no search server is configured) |
| `SEARCH_MCP_PLUGIN` | unset | Use an MCP server configured in LM Studio's own `mcp.json` instead of connecting to Tavily per request, e.g. `mcp/tavily`. About 1 s faster per question, and no `TAVILY_API_KEY` needed in Luna |
| `SEARCH_TOOLS` | `tavily_search` | Which of the server's tools the model may use, comma-separated, or `all`. Tavily's research, crawl and extract tools are slower and use more credits |
| `SEARCH_PAUSE_MS` | `300000` | If the search server can't be reached, answer without search and pause search for this long |
| `ANNOUNCE_SEARCH` | `true` | Say a heads-up phrase when a web search starts |
| `SEARCH_PHRASES` | built-in | Custom heads-up phrases, separated by a pipe character |
| `LLM_TOOLS` | `true` | Let the LLM play, skip and stop music through smakbot (see [MusicBot integration](#musicbot-integration)) and leave the voice channel when asked; needs `"luna"` in LM Studio's `mcp.json` |
| `LUNA_MCP_PORT` | `8895` | Port of Luna's own MCP server (the LLM's tools). Change it in `docker-compose.metal.yml` and `mcp.json` too |

</details>

## Music with smakbot

Luna doesn't play music herself. She drives [smakbot](https://github.com/smakus/smakbot-discord-music-bot), a self-hosted Discord music bot built to work with her, by posting its commands in the text channel. You can always type smakbot's own commands too (`!queue`, `!pause`, `!volume 50`, …); see [its command list](https://github.com/smakus/smakbot-discord-music-bot#commands).

| You say (or type "Luna, …") | Luna sends to smakbot |
| --------------------------- | -------------------- |
| "play Crazy by Seal" | `!summon` if smakbot isn't in the channel, then `!play Crazy by Seal --for=@you` |
| "play the top 10" / "play the top twenty songs" / "play our top three hits" / "play our most played" / "play my favorites" | `!playtop 10` (or 20; at most 50), your server's most played songs |
| "skip" / "skip this song" | `!skip` |
| "pause" / "pause the music" | `!pause` |
| "resume" / "unpause" / "keep playing" | `!resume` |
| "stop" / "stop the music" | `!stop` (smakbot stops and leaves) |
| "put on something chill" / "play the Lord of the Rings soundtrack" | Her LLM picks the search and sends `!play …` |
| "what song is this?" / "what's playing?" | She asks smakbot directly and answers: *"This is Crazy by Seal, requested by smakus. Up next: Kiss From a Rose."* |
| "what's this song about?" / "when did it come out?" | The LLM is told what's playing, so she answers about that song |
| "what are our top songs?" / "what are the top 3 hits?" / "what's our top song?" | Nothing is played: she reads smakbot's most played list (5 unless you say how many): *"Your top 3: One Chain to Rule Them All, 13 plays. Shock My Dog, 9. Money for Nothing, 4."* |
| "what are my top songs?" / "what's my top song?" | Nothing is played: she reads the songs **you** asked smakbot for most (its request history): *"Your top 2 requests: Heart of Gold, 4 requests. Sledgehammer, 2."* Someone else's (*"what are kenbeans' top songs?"*, online or not) goes to the LLM, which looks them up with `list_top_songs` |
| "who requests the most songs?" / "give me the top 4 requesters and their counts" | The LLM ranks people by songs requested with `list_top_requesters` (smakbot's `/top-requesters`) |
| "show me a picture of a baby capybara" / "what does a Del Taco crunchwrap look like?" | The LLM calls `post_image`: Luna finds a picture with Tavily's image search (`TAVILY_API_KEY`), downloads the first real JPEG, PNG, GIF or WebP under 8 MB, and uploads it, so it shows inline. In text it comes with her reply; asked by voice, it goes in the text channel (`AUTO_JOIN_TEXT_CHANNEL`) as "📷 capybara (for Sam)" |
| "is Tom Sawyer in our top ten?" / "what do we listen to most?" | Her LLM looks up the most played list and answers |

- **When music is already playing,** she says *"Adding … to the queue"* instead of *"Okay, playing …"*, since smakbot plays it after what's on now.
- **`--for=@you`** credits the song to you instead of Luna, in smakbot's "Now playing", its status and Luna's own "what song is this?". It's sent without pinging you.
- **"Play top of the world"** is still a song search. Only "the top N" / "most played" / "my favorites" mean the top-songs list.
- **When smakbot joins or leaves,** Luna says so briefly: *"smakbot has joined."*

Setting the two bots up to talk to each other is covered in [MusicBot integration](#musicbot-integration).

### MusicBot integration

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

3. **Let the LLM use the music tools** (`play_music`, `play_top_songs`, `skip_song`, `pause_music`, `resume_music`, `stop_music`, `list_top_songs`, `list_top_requesters`, `post_image` and `leave_channel`). Luna serves them from her container over MCP on port 8895, published on `127.0.0.1` only. LM Studio only connects to local MCP servers listed in its `mcp.json`, so add this there once (Program → Install → Edit mcp.json, or `~/.lmstudio/mcp.json`), next to any other servers:

   ```json
   "luna": { "url": "http://127.0.0.1:8895/mcp" }
   ```

   When the model calls a tool, Luna posts the smakbot command and the model confirms out loud; a `[music] the LLM called …` line in the log shows each call. If LM Studio can't reach the tools, Luna answers without them and logs a warning. `LLM_TOOLS=false` turns them off.

4. **"What song is this?" and "what are our top songs?"** need smakbot's status API (`StatusApiPort = 8896` in smakbot, on by default there) and `MUSIC_STATUS_URL` in Luna (set in `docker-compose.metal.yml`).

Fixed commands ("play …", "skip", "stop", "play the top 10") need none of steps 3–4. Songs Luna queues end in `--for=@name` so smakbot credits whoever asked; upstream MusicBot doesn't know `--for` and would include it in the search, so it's smakbot-only. If `!play` fails with `HTTP Error 403`, that's YouTube's anti-download changes, not Luna; smakbot already includes the usual fix ([bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)).

<details>
<summary><b>Music settings</b></summary>

| Setting | Default | What it does |
| --- | --- | --- |
| `MUSIC_STATUS_URL` | unset (`docker-compose.metal.yml`: `http://host.docker.internal:8896/now-playing`) | smakbot's now-playing endpoint (its `StatusApiPort`): answers "what song is this?" and tells the LLM what is playing. Its `/top-songs`, next to it, answers "what are our top songs?" and, with `?user=`, one person's most requested songs. Unset: off |

</details>

## How it works

```
You speak ─► openWakeWord (on the raw audio) ─► detection opens the gate
          ─► Whisper transcribes ─► fixed commands (music, leave, "what song is this?")
                                   or LM Studio streams a reply (with web search and tools)
          ─► each finished sentence goes to the voice ─► Discord plays it
             (sentence N+1 is synthesized while N plays)
```

If the wake word models fail to load, Luna falls back to transcribing everything and matching "hey Luna" in the text.

## Hardware sizing

**The LLM is almost always the bottleneck.** Whisper and Kokoro are sub-second; a model that doesn't fit in memory can take 25 seconds to reply. On Macs, the GPU can only use about two thirds of total RAM.

| Total RAM | Realistic LLM | Voice |
| --------- | ------------- | ----- |
| 16 GB | 7–8B at Q4 | Kokoro or ElevenLabs. Chatterbox's extra 4 GB doesn't fit comfortably |
| 24 GB | 12–14B at Q4 | Any |
| 32 GB+ | 24–27B at Q4, or a mixture-of-experts model like Qwen3.6 35B-A3B | Any |

Leave roughly 5–6 GB for the OS, Docker, Whisper and a voice, or about 4 GB more if that voice is Chatterbox. Mixture-of-experts models (names ending in something like `A3B`) write much faster than their size suggests, but still need the memory of their full size. Luna was developed on Qwen3.6 35B-A3B on a 32 GB Mac. It fits, but the first answer after a quiet spell can be slow while macOS swaps it back in. For spoken two-sentence replies, a smaller model that answers in 2 seconds beats a larger one that takes 25.

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

## Working on Luna's code

How the code is laid out, the test suite, and the LLM benchmark for comparing models are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## FAQ

**Is Luna free? Does she need the cloud?**
Yes, she's free and open source (MIT). The language model, speech-to-text and the default voices all run on your own computer, so there's nothing to pay per question. Web search (Tavily's free tier is enough) and the ElevenLabs voice are optional and use those services.

**What hardware do I need?**
A computer that can run a local LLM: an Apple Silicon Mac with 16 GB or more, or a Linux PC with a decent GPU. The LLM sets the pace; see [Hardware sizing](#hardware-sizing).

**Which LLM should I use?**
Any instruction-tuned model LM Studio can load that fits your RAM. Smaller models answer faster, and for short spoken answers a quick 8–14B model often beats a slow big one. The [LLM benchmark](docs/DEVELOPMENT.md#llm-benchmark) compares models on speed, accuracy and personality.

**Can several people talk to her at once?**
Yes. Each person has their own wake-word detector and conversation memory, and answers queue so nobody's question cancels someone else's.

**Can she play music?**
Yes, with [smakbot](https://github.com/smakus/smakbot-discord-music-bot): "hey Luna, play …", "skip", "play the top 10", "what song is this?". See [Music with smakbot](#music-with-smakbot).

**Can I change her name, personality or voice?**
Her personality is a setting (`LM_PERSONALITY`, e.g. "fun, friendly and helpful"), and so is the voice (see [Text-to-speech providers](#her-voice)). The wake word is a trained model; you can [train your own](#tuning-the-wake-word) for a different phrase.

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
