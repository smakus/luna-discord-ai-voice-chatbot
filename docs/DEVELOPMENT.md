# Working on Luna

For the setup and settings, see the [README](../README.md).

## Code layout

`Luna/` is plain files, one job each. A file only uses files in its own row or the rows below it:

| Layer | Files |
| ----- | ----- |
| Startup and Discord events | `index.js` (wiring: creates everything and connects Discord's events to it), `text-commands.js` (the `!luna` commands), `auto-join.js` (joining voice channels by herself), `tools-server.js` (serving Luna's tools to LM Studio) |
| Where questions come from and go | `voice-session.js` (joining, reconnecting, encrypted-voice recovery), `voice-listen.js` (per-speaker capture and wake word), `voice-answer.js` (utterance → spoken answer: fixed answers, the asides while waiting, the answer's place in the playback queue, one LLM pass), `text-chat.js` (typed questions), `actions.js` (what both of those do the same way: music commands, smakbot's answers, tool calls, the music follow-up), `announce.js` (intro, greetings, farewells) |
| Doing things | `answer-llm.js` (LM Studio: prompt, memory, search and tool offers, streaming, what tool calls mean), `commands.js` (fixed commands, routing, smakbot), `voice-playback.js` (the speaking queue), `now-playing.js` (what smakbot is playing), `wake-backup.js` (answering wake words the model missed), `wake-log.js` (the wake-word log), `tts.js` and `tts-cache.js` (rendered phrases), `whisper.js`, `mcp-server.js` |
| Pure helpers | `config.js`, `prompt.js`, `answer-filter.js`, `answer-retry.js` (whether to ask the LLM again), `sentences.js`, `voice-input.js`, `phrases.js`, `llm-tools.js`, `greetings.js`, `wakeword.js` |

Modules that need a library, `fetch`, timers or each other get them as arguments (`createX({ ... })`), which is how the test harness swaps in fakes.

## Tests

Luna's tests live in `Luna/test/` and run without Discord, LM Studio, Whisper or a TTS server: every outside service is faked. They need only Node 22. Without Node on your machine, run them in Docker:

From the repository's top folder:

```bash
docker run --rm -v "$PWD":/repo:ro -w /repo/Luna-Discord-Bot-Full-Docker/Luna node:22-slim npm test
```

With Node installed, `npm test` in `Luna/` does the same. A full run takes under a minute: the files run in parallel.

| File | Covers |
| ---- | ------ |
| `voice-session.test.js` | Joining, moving and leaving voice channels, lost connections, undecodable packets, encrypted voice (DAVE) diagnostics and recovery |
| `answers.test.js` | Spoken answers: the status message, TTS lookahead and interrupts, LLM timeouts, the model, personality, empty and broken-down answers, sampling, audio tags, memory, stats |
| `search.test.js` | Web search: the spoken heads-up, `WEB_SEARCH` modes, the search integration and its outage fallback |
| `fillers.test.js` | "Still thinking" fillers: timing, how many, which, personal ones |
| `thinking.test.js` | The thinking limit and the quick answer, leaked reasoning, narration before searches |
| `wake.test.js` | Hearing "hey Luna": barge-in, two-stage detection, a bare "hey Luna", follow-up windows, the Whisper backup, the wake-word log |
| `music.test.js` | Music with smakbot: the LLM's music tools, polite commands, "adding … to the queue", the music follow-up, now playing, top songs and requests |
| `text.test.js` | Typing to Luna: text chat, pictures, saying things in the voice channel |
| `voice-command.test.js` | `!luna voices` and `!luna voice [name] <text> [--file]`: picking the voice, the default voice, the .wav file, and the problems said plainly |
| `help.test.js` | `!luna help`, and that what it says about where requests go still matches the routing (`commands.js`) |
| `answer-retry.test.js` | When a spoken answer is asked again (`answer-retry.js`): with search, quick (reasoning off), in a fresh conversation, or not |
| `actions.test.js` | What voice and text do the same way (`actions.js`): music commands, smakbot's answers, tool calls, the music follow-up |
| `tts.test.js` | TTS providers and the fallback chain |
| `announce.test.js` | Intro, join greetings, leave farewells, speakable names |
| `answer-filter.test.js` | What of the LLM's answer Luna says, holds or drops (`answer-filter.js`): each rule, plus LM Studio streams in `test/fixtures/` replayed through the real pipeline |
| `voice-input.test.js` | The voice-input stages (`voice-input.js`) one by one: packet decoding, filling silent gaps for the wake-word model, cutting speech into utterances, the wake decision, finding the question in a transcript, and what to do about a speaker who is never heard |
| `sentences.test.js` | Where the streamed answer is cut into sentences for TTS (`sentences.js`): abbreviations like "St." and "U.S.", decimals and initials are not sentence ends |
| `config.test.js` | Settings (`config.js`): parsing, invalid values, misspelled names, and that the README and `example.env` match the list of settings |
| `bench-score.test.js` | The LLM benchmark's scoring (below), its question file, and the system prompt (`prompt.js`) |
| `harness.js` | Loads `index.js` with Discord, LM Studio, Whisper, TTS and the wake-word engine faked |
| `helpers.js` | What the integration tests above share: fake LLM streams (answers, searches, tool calls) and the rigs each feature's tests start from |

The tests are excluded from the Docker image.

## LLM benchmark

`Luna/bench/` compares the models in LM Studio on what matters to Luna: how soon she starts speaking, whether she is right, whether the answer can be read aloud as is, and whether she sounds like herself. It asks the model that is loaded in LM Studio 21 questions (`bench/questions.json`): small talk, facts, mental math, searches, opinions, a "hey Luna" left in the question, and today's weekday. The model gets the exact system prompt Luna sends (`prompt.js`), built from the personality and time zone in `Luna/.env`, the same search plugin, and the sampling settings she sends (`LM_TEMPERATURE` …, when set). Each question is a fresh conversation, asked 3 times with reasoning off and 3 times with it on.

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
