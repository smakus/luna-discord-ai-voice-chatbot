require('dotenv').config();

const {
  joinVoiceChannel, createAudioResource, StreamType,
  AudioPlayerStatus, VoiceConnectionStatus, createAudioPlayer,
  EndBehaviorType, entersState,
} = require('@discordjs/voice');
const { GatewayIntentBits } = require('discord-api-types/v10');
const { Events, Client } = require('discord.js');
const { OpusEncoder } = require('@discordjs/opus');
const path = require('path');
const { WakeWordEngine } = require('./wakeword');
const { fetchTTS, describeTTS, expressivePrompt } = require('./tts');
const { createAnswerFilter } = require('./answer-filter');
const { loadConfig, parseWaits } = require('./config');
const { takeSentences } = require('./sentences');
const { systemPrompt, SEARCH_PROMPT, QUICK_PROMPT } = require('./prompt');
const {
  stripWakeWord, createPacketDecoder, createWakeFeeder, createSegmenter,
  decideWake, decideUtteranceEnd, confirmWake, decideSilentSpeaker,
} = require('./voice-input');

// ─── Config ───────────────────────────────────────────────────────────────────

// Every setting, parsed and checked in one place (config.js).
const config = loadConfig(process.env, { warn: message => console.warn(message) });

// ─── Wake phrase ──────────────────────────────────────────────────────────────
//
// The spoken wake phrase is "hey luna". A single-word "luna" is a poor wake word
// for openWakeWord — two syllables of common phonemes with no distinctive onset —
// and trains badly. Every official openWakeWord model is 3–4 syllables.
//
// WAKE_RE matches the phrase at the START of a transcript, tolerating Whisper's
// punctuation ("Hey, Luna, ...") and its usual mishearings. It is used for two
// things only:
//   1. the fallback path when the ONNX model is unavailable
//   2. stripping the phrase off the front of a transcript before it reaches
//      the LLM or the music-command parser
// Detection itself is the ONNX model's job.
// (WAKE_RE and the other voice-input stages live in voice-input.js.)

// Text command to summon the bot. Deliberately NOT derived from the spoken
// phrase — "!hey luna" would be an awkward thing to type.
const BOT_COMMAND = '!luna';

// Human-readable phrase for user-facing messages.
const WAKE_LABEL = 'hey Luna';

// ─── openWakeWord ─────────────────────────────────────────────────────────────
//
// When a model is loaded, wake word detection runs on the raw audio stream and
// acts as a gate: only utterances containing a detection are sent to Whisper.
// This is both cheaper (Whisper no longer transcribes every utterance in the
// channel) and more accurate than substring-matching a transcript.
//
// If the model fails to load for any reason, Luna falls back to the original
// behaviour — transcribe everything, then match WAKE_RE against the text.

const OWW_ENABLED   = config.OWW_ENABLED;
const OWW_MODEL     = config.OWW_MODEL_PATH     || path.join(__dirname, 'hey_luna.onnx');
const OWW_MELSPEC   = config.OWW_MELSPEC_PATH   || path.join(__dirname, 'melspectrogram.onnx');
const OWW_EMBEDDING = config.OWW_EMBEDDING_PATH || path.join(__dirname, 'embedding_model.onnx');
const OWW_THRESHOLD = config.OWW_THRESHOLD;
const OWW_TRIGGER_FRAMES = config.OWW_TRIGGER_FRAMES;
const OWW_REFRACTORY_MS  = config.OWW_REFRACTORY_MS;
const OWW_FEATURE_FRAMES = config.OWW_FEATURE_FRAMES;
// How far before an utterance's first speech a detection may land and still
// count for that utterance. Covers the gap between the wake word finishing and
// the energy gate opening.
const OWW_GRACE_MS = config.OWW_GRACE_MS;
// Two-stage detection. The model is trained on "hey Luna" said on its own and
// scores it far lower when the question follows without a pause: in testing
// with 16 voices, run-on "hey Luna what's the weather" reached the threshold
// for only 5 (typical peak 0.41 vs 0.66 with a pause), yet 15 of 16 still
// peaked above 0.1 — while ordinary chat, "lunar" and "tuna" included, peaks
// around 0.001. So an utterance whose peak is at least this high but that
// never triggered is a candidate: it is transcribed, and kept only if Whisper
// heard "Luna" in it. 0 disables (only full detections count).
const OWW_CANDIDATE_THRESHOLD = config.OWW_CANDIDATE_THRESHOLD;
// After a bare "hey Luna" and a pause, how long to wait for the question
// before answering the greeting (decideUtteranceEnd in voice-input.js). She
// waits silently: the chime always means "got it", once the question is in.
// 0 disables (the utterance ends after SILENCE_MS, as before).
const WAKE_LISTEN_MS = config.WAKE_LISTEN_MS;
// Log every score above this value — useful for tuning OWW_THRESHOLD.
const OWW_DEBUG_SCORE = config.OWW_DEBUG_SCORE;
// 'auto' normalises quiet speech up toward a target level before detection,
// 'off' disables it, or give a fixed multiplier like '3'. Detection input only —
// the audio sent to Whisper is untouched. Never attenuates, so it cannot make a
// already-working setup worse.
const OWW_GAIN = config.OWW_GAIN;

let wakeEngine = null; // set during ClientReady; null means fall back to transcript matching

const IGNORED_USERS = new Set(
  config.IGNORED_USER_IDS
);

// ─── Join greetings ───────────────────────────────────────────────────────────
//
// When someone joins the voice channel Luna is in, she announces them by name
// and says hello. The cooldown is per user, so a flaky connection that drops
// and rejoins every few seconds is greeted once, not on every reconnect.
const GREET_ON_JOIN     = config.GREET_ON_JOIN;
const GREET_COOLDOWN_MS = config.GREET_COOLDOWN_MS;
// A joining client takes a moment to connect its audio, and someone who joins
// and immediately leaves (or passes through on the way to another channel)
// should not be greeted at all. The greeting is spoken only if they are still
// in the channel after this delay.
const GREET_DELAY_MS    = config.GREET_DELAY_MS;

// Leave announcements: the same idea in reverse. The delay is longer than the
// join one because a dropped connection typically takes a few seconds to come
// back, and someone who is back by then did not really leave.
const ANNOUNCE_LEAVE    = config.ANNOUNCE_LEAVE;
const LEAVE_COOLDOWN_MS = config.LEAVE_COOLDOWN_MS;
const LEAVE_DELAY_MS    = config.LEAVE_DELAY_MS;

// Custom wording for both announcements: phrases separated by "|", with
// {name} where the person's name goes, e.g.
//   FAREWELL_PHRASES={name} just left. Bye, {name}!|And {name} is gone.
// One is picked at random each time. Unset or empty keeps the built-in lines.
const GREET_PHRASES    = config.GREET_PHRASES;
const FAREWELL_PHRASES = config.FAREWELL_PHRASES;

// Luna introduces herself when she joins a voice channel. INTRO_PHRASES works
// like the two above, with {wake} for the wake phrase instead of {name}.
const ANNOUNCE_SELF = config.ANNOUNCE_SELF;
const INTRO_PHRASES = config.INTRO_PHRASES;

// Spoken heads-up when a question is going to a web search — the slowest kind
// of answer, where silence most reads as Luna not having heard. Audio tags are
// performed by ElevenLabs v3/v4 and stripped for Kokoro.
const ANNOUNCE_SEARCH = config.ANNOUNCE_SEARCH;
const SEARCH_PHRASES  = (() => {
  const custom = config.SEARCH_PHRASES;
  return custom.length ? custom : [
    'Let me search for that.',
    '[curious] Hmm, let me take a look.',
    "One sec, I'll check the web.",
    '[thoughtful] Good question. Let me look that up.',
    'Hang on, let me find out.',
  ];
})();

// "Still thinking" fillers: while no answer has started, Luna says one after a
// random wait, then more, backing off: THINKING_WAITS lists the wait window
// (in seconds) for the 1st, 2nd, ... filler, and the last window repeats.
// The default "15-22,22-30,30-40" means 15-22 s, then 22-30 s, then every
// 30-40 s. Random within each window, because a varied gap sounds less
// mechanical than a fixed beat; backing off, because the longer a wait gets,
// the less a frequent reminder adds. THINKING_MAX > 0 caps the count. They stop the moment the answer's
// first sentence is ready. Big models that reason (and search) before
// answering can be silent for a minute or more, which otherwise sounds exactly
// like being ignored.
//
// A phrase containing {name} is spoken with the asker's name, so mixing a few
// of those into the list makes some fillers personal. They are skipped when
// the name has nothing pronounceable in it.
const ANNOUNCE_THINKING    = config.ANNOUNCE_THINKING;
const THINKING_WAITS       = parseWaits(config.THINKING_WAITS);
const THINKING_MAX         = config.THINKING_MAX; // 0 = no limit

const THINKING_PHRASES     = (() => {
  const custom = config.THINKING_PHRASES;
  return custom.length ? custom : [
    'Still thinking.',
    '[thoughtful] Hmm, give me a moment.',
    'Almost there, bear with me.',
    "This one's taking a bit. Hang tight.",
    'Just a little longer.',
    "Hey {name}, I'm still working on that. I didn't forget about you.",
    'Still on it, {name}. Thanks for your patience.',
  ];
})();

const WHISPER_SERVER_URLS = config.WHISPER_SERVER_URLS;
let whisperRR = 0;
function nextWhisperUrl() {
  const url = WHISPER_SERVER_URLS[whisperRR % WHISPER_SERVER_URLS.length];
  whisperRR++;
  return url;
}
const LM_STUDIO_URL = config.LM_STUDIO_URL;

// The time zone of "today" in the system prompt (see prompt.js). An IANA name;
// containers run in UTC, which turns evenings in the Americas into tomorrow.
const LUNA_TIMEZONE = (() => {
  const tz = config.LUNA_TIMEZONE;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; }
  catch { console.warn(`LUNA_TIMEZONE="${tz}" is not a valid time zone — using UTC`); return 'UTC'; }
})();


  // Optional personality line, injected on a fraction of requests. Keep the base
// prompt above free of "sometimes"/"occasionally" instructions — see below.
const LM_FLAVOR_PROMPT = config.LM_FLAVOR_PROMPT;
const LM_FLAVOR_CHANCE = config.LM_FLAVOR_CHANCE;

// Resolved against this file, not the working directory, so `node Luna/index.js`
// from elsewhere still finds it.
const CHIME_PATH = path.join(__dirname, 'chime.mp3');

// ─── Conversation memory scope ────────────────────────────────────────────────
//
// LM Studio's `previous_response_id` chains a conversation server-side. Two
// consequences follow from how it was used before:
//
//   1. One global id meant every speaker shared one chain. The chain carries no
//      speaker attribution, so the model saw A's and B's turns interleaved as a
//      single user contradicting themselves — and B's follow-up ("what about
//      tomorrow?") resolved against A's question.
//   2. The chain never reset, so context grew for the lifetime of the process.
//      Prefill cost is linear in context, so every turn was measurably slower
//      than the last until the container was restarted.
//
// Now: one chain per speaker, dropped after LM_MEMORY_TTL_MS of silence or
// LM_MEMORY_MAX_TURNS turns, whichever comes first. Both bound prefill.
const LM_MEMORY_TTL_MS    = config.LM_MEMORY_TTL_MS;
const LM_MEMORY_MAX_TURNS = config.LM_MEMORY_MAX_TURNS;

const conversations = new Map(); // userId -> { responseId, turns, lastAt }

function getConversationId(userId) {
  const c = conversations.get(userId);
  if (!c) return null;
  if (Date.now() - c.lastAt > LM_MEMORY_TTL_MS) {
    conversations.delete(userId);
    return null;
  }
  if (c.turns >= LM_MEMORY_MAX_TURNS) {
    console.log(`[${userId}] conversation reset after ${c.turns} turns (context cap)`);
    conversations.delete(userId);
    return null;
  }
  return c.responseId;
}

function rememberConversation(userId, responseId) {
  if (!responseId) return;
  const prev = conversations.get(userId);
  conversations.set(userId, {
    responseId,
    turns:  (prev ? prev.turns : 0) + 1,
    lastAt: Date.now(),
  });
}

// ─── Latency tuning ───────────────────────────────────────────────────────────
// Env-tunable so these can be adjusted with a container recreate rather than a
// rebuild. Defaults are the original hardcoded values.
//
// ENERGY_THRESHOLD gates which audio is buffered for Whisper. It is INDEPENDENT
// of wake word detection — the detector always receives every frame. If the
// model fires but this gate stays shut, the detection is real but there is no
// utterance to transcribe, which feels exactly like a missed wake word.
// Lower it (150-200) for quiet speakers or distant mics.
const SILENCE_MS       = config.SILENCE_MS;
const ENERGY_THRESHOLD = config.ENERGY_THRESHOLD;
const MIN_SPEECH_MS    = config.MIN_SPEECH_MS;

// Audio kept from BEFORE the energy gate opens, and prepended to the utterance.
//
// Without this, everything below ENERGY_THRESHOLD is discarded, so an utterance
// begins on the first frame loud enough to trip the gate. Low-energy onsets —
// unvoiced fricatives and stops ("s", "f", "th", "wh", "h", "k", "p", "t") —
// sit below the threshold for 50-150 ms, so the utterance reaching Whisper
// starts mid-word. Whisper then guesses the missing onset: "what's the score"
// arrives as "the score", "set a timer" as "a timer".
//
// The detector is unaffected (it always saw every frame); this only changes
// what is transcribed. Cost is PREROLL_MS of ring buffer per speaker — 320 ms
// is ~30 KB.
const PREROLL_MS     = config.PREROLL_MS;
const PREROLL_CHUNKS = Math.max(0, Math.round(PREROLL_MS / 20));

// Hard cap on a single buffered utterance. `flushing` stays true for the whole
// LLM + TTS response, during which flushUtterance() early-returns while the
// decoder keeps appending — without this cap, the segmenter's buffer grows for the entire
// duration of Luna's reply (~2.9 MB per 30 s per speaker).
// Request timeouts. Without these a hung Whisper or LM Studio call never
// settles, `flushing` stays true forever, and that speaker goes permanently
// deaf with nothing logged. Generous, because a saturated CPU makes Whisper
// genuinely slow — these are for hangs, not slowness.
const WHISPER_TIMEOUT_MS = config.WHISPER_TIMEOUT_MS;

// The LLM gets two limits, because a single overall timeout cannot tell a
// hung request from a slow one. A large model that reasons and searches before
// answering can legitimately take minutes, and its answer then streams for a
// while longer; an overall 2-minute cap cut such answers off mid-sentence.
//
//   LM_IDLE_TIMEOUT_MS — abort only after this long with NO data from LM
//                        Studio. Reasoning, tool-call and token events all
//                        reset it, so a working model never trips it.
//   LM_TIMEOUT_MS      — overall backstop for a request that keeps trickling.
const LM_IDLE_TIMEOUT_MS = config.LM_IDLE_TIMEOUT_MS;
const LM_TIMEOUT_MS      = config.LM_TIMEOUT_MS;
// TTS timeouts live in tts.js with the providers.

// Reasoning level sent to LM Studio ("off", "low", ... as the model allows;
// empty = the model's own default, which for some models is the maximum).
const LLM_REASONING = config.LLM_REASONING.toLowerCase();

// Thinking limit. Neither timeout above can catch a model that keeps reasoning:
// reasoning streams, so the request is never idle. One question spent over
// seven minutes (3,210 reasoning tokens) before its first word. If, before the
// answer starts, the model has spent LLM_THINK_LIMIT_MS actually *reasoning*,
// the request is cancelled and asked again with reasoning off, which answers
// in seconds. 0 disables.
//
// Only reasoning counts — LM Studio marks it with reasoning.start/.end events.
// Searching and reading the results do not: a searched question can spend a
// minute on those alone (results are read at ~90 tokens/s on this hardware),
// and counting them cancelled healthy searches and redid them from scratch.
const LLM_THINK_LIMIT_MS = config.LLM_THINK_LIMIT_MS;
const QUICK_ANSWER_PHRASES = (() => {
  const custom = config.QUICK_ANSWER_PHRASES;
  return custom.length ? custom : [
    "Sorry, I was overthinking that one. Here's the quick answer.",
    'Okay, let me give you the short version.',
  ];
})();

// How many sentences beyond the one playing are synthesised in advance. Enough
// to keep playback gapless; more only burns TTS work (and ElevenLabs credits)
// on sentences that a barge-in may never let play.
const TTS_LOOKAHEAD = config.TTS_LOOKAHEAD;

// Backstop if something still wedges despite the timeouts above. Must exceed
// the longest legitimate request, or it would release a speaker mid-answer.
const STUCK_FLUSH_MS = WHISPER_TIMEOUT_MS + LM_TIMEOUT_MS + 60000;

const MAX_UTTERANCE_MS    = 30000;
const DECODER_CHUNK_MS    = 20; // 960 samples @ 48 kHz
const MAX_UTTERANCE_CHUNKS = MAX_UTTERANCE_MS / DECODER_CHUNK_MS;

// Longest a single stretch of speech may run without a silence gap before it is
// flushed anyway.
//
// An utterance normally ends after SILENCE_MS of audio below ENERGY_THRESHOLD.
// If the threshold sits below the room's noise floor — or Luna's own voice
// returns through a speaker into the mic — the energy gate is open on every frame,
// the silence timer is reset on every frame, and the utterance never ends. That
// speaker then buffers audio forever and is never heard again.
const MAX_SPEECH_MS = config.MAX_SPEECH_MS;

// Discord stops transmitting Opus during silence, so two consecutive packets
// can be seconds apart in wall-clock time while being adjacent in the sample
// stream. The detector then sees the gap spliced out — "hey ... Luna" spoken
// with a natural pause arrives as a compressed "heyLuna" that matches nothing
// the model was trained on. Re-inserting real silence keeps the feature
// timeline aligned with how the phrase was actually spoken.
//
// Capped because the classifier window is only 1.28 s; beyond that the window
// is fully flushed anyway and further silence is wasted inference.
const MAX_SILENCE_FILL_MS = config.MAX_SILENCE_FILL_MS;

// Sentences are split as the answer streams (sentences.js), so TTS starts on
// the first one while the rest is still being written.

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.Guilds,
  ],
});

let lmStudioModel = null;

// Fatal at startup (nothing works without a model); afterwards it is re-run
// whenever LM Studio rejects a request, so switching or reloading the model in
// LM Studio no longer breaks every query until Luna is restarted.
async function resolveModel({ fatal = true } = {}) {
  try {
    const res = await fetch(
      LM_STUDIO_URL.replace('/api/v1/chat', '/api/v1/models'),
      { headers: { 'Authorization': `Bearer ${config.LM_STUDIO_MCP_BEARER_TOKEN}` } }
    );
    const data = await res.json();
    const loaded = data?.models?.find(m => m.type === 'llm' && m.loaded_instances?.length > 0);
    if (!loaded) throw new Error('No models loaded');
    const id = loaded.loaded_instances[0].id;
    if (id !== lmStudioModel) console.log(`Using LM Studio model: ${id}`);
    lmStudioModel = id;
    return true;
  } catch (err) {
    console.error('Failed to resolve LM Studio model:', err.message);
    if (fatal) process.exit(1);
    return false;
  }
}

async function initWakeWord() {
  if (!OWW_ENABLED) {
    console.log('[oww] disabled via OWW_ENABLED=false — using transcript wake word matching');
    return;
  }
  try {
    wakeEngine = await WakeWordEngine.load({
      modelPath:     OWW_MODEL,
      melspecPath:   OWW_MELSPEC,
      embeddingPath: OWW_EMBEDDING,
      featureFrames: OWW_FEATURE_FRAMES || undefined,
    });
    console.log(`[oww] active — threshold=${OWW_THRESHOLD}, Whisper gated on detection` +
      (OWW_CANDIDATE_THRESHOLD > 0 && OWW_CANDIDATE_THRESHOLD < OWW_THRESHOLD
        ? `; candidates from ${OWW_CANDIDATE_THRESHOLD} confirmed by Whisper` : ''));
  } catch (err) {
    console.warn(`[oww] unavailable (${err.message})`);
    console.warn('[oww] falling back to transcript wake word matching');
    wakeEngine = null;
  }
}

// !luna is refused until startup finishes. A capture created before the wake
// word models load runs without detection until its stream next restarts.
let ready = false;

client.on(Events.ClientReady, async () => {
  await resolveModel();
  await initWakeWord();
  console.log(`[tts] ${describeTTS()}`);
  console.log(`[search] web search: ${describeSearch()}`);
  ready = true;
  console.log(`Ready! Wake phrase: "${WAKE_LABEL}"  •  text command: ${BOT_COMMAND}`);
});

// ─── Voice join ───────────────────────────────────────────────────────────────

let activeConnection   = null;
let activeVoiceChannel = null;
let activeTextChannel  = null;   // where !luna was typed; music commands go here
let activeGuild        = null;   // { id, adapterCreator }, for reconnecting
const listeningUsers   = new Set();

client.on(Events.MessageCreate, async message => {
  if (message.content.toLowerCase().trim() === `${BOT_COMMAND} voicecheck`) return voiceCheck(message);
  if (message.content.toLowerCase().trim() !== BOT_COMMAND) return;
  // .catch: a rejected reply (e.g. no send permission) in an async listener is
  // an unhandled rejection, which terminates Node.
  if (!ready) return message.reply('Still starting up — try again in a few seconds.').catch(() => {});

  const channel = message.member?.voice?.channel;
  if (!channel) return message.reply('You need to join a voice channel first!').catch(() => {});

  const guild = { id: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator };
  // Returns the guild's existing connection if there is one, moving it to
  // `channel` when that differs.
  const connection = joinVoice(channel, guild);

  if (connection === activeConnection) {
    if (activeVoiceChannel?.id === channel.id) {
      message.reply(`Already listening in **${channel.name}**.`).catch(() => {});
      return;
    }
    // !luna from another channel: joinVoiceChannel() just moved Luna there.
    // Listening carries over (it is per connection, not per channel); only
    // the channel she announces and counts members in changes.
    console.log(`[voice] moved to ${channel.name} by !luna`);
    activeVoiceChannel = channel;
    message.reply(`Moved to **${channel.name}**!`).catch(() => {});
    introduceSelf(connection);
    return;
  }

  attachVoice(connection, channel, message.channel, guild, () => {
    message.reply(
      `Joined **${channel.name}**! Say "${WAKE_LABEL}" to wake me up. ` +
      `Also, you can say "${WAKE_LABEL}, play song ___" to play music, ` +
      `or "${WAKE_LABEL}, skip" and "${WAKE_LABEL}, stop" to control it.`
    ).catch(() => {});
    introduceSelf(connection);
  });
});

// `!luna voicecheck`: per-person answer to "can Luna decrypt them?", plus the
// voice privacy code to compare with the one Discord shows in the call's
// encryption details — if they differ, Luna's whole session is out of sync.
function voiceCheck(message) {
  if (!activeConnection || !activeVoiceChannel) return message.reply("I'm not in a voice channel.").catch(() => {});
  const crypto = voiceCryptoState();
  if (!crypto) return message.reply('Encryption details are unavailable (unencrypted call, or the voice library changed).').catch(() => {});
  const lines = [`**Voice encryption:** ${crypto.status}, epoch ${crypto.epoch ?? '-'}` +
    (crypto.privacyCode ? ` — privacy code \`${crypto.privacyCode}\` (should match the code Discord shows for this call)` : '')];
  for (const member of activeVoiceChannel.members.values()) {
    if (member.user.bot) continue;
    const v = cryptoVerdict(crypto, member.id);
    lines.push(`${v.problem ? '⚠️' : '✅'} ${member.displayName}: ${v.text}`);
  }
  console.log(`[voice] voicecheck: ${lines.slice(1).join(' | ')}`);
  return message.reply(lines.join('\n')).catch(() => {});
}

// debug: true so the voice library's encryption (DAVE) messages reach
// logVoiceDebug; everything else it says is filtered out there.
function joinVoice(channel, guild) {
  return joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.adapterCreator,
    debug: true,
  });
}

// Starts listening on a new connection once it is Ready. Shared by !luna and
// the encrypted-session reconnect; `onJoined` runs after setup (reply, intro).
function attachVoice(connection, channel, textChannel, guild, onJoined = null) {
  watchConnection(connection);

  // Once, not on: a connection returns to Ready after every network blip, and
  // re-running this would re-post the join message and stack another
  // speaking listener each time.
  const onReady = () => {
    activeConnection   = connection;
    activeVoiceChannel = channel;
    activeTextChannel  = textChannel;
    activeGuild        = guild;
    startListening(connection, textChannel);

    // Subscribe to users already in the channel at join time
    channel.members.forEach(member => {
      if (member.user.bot)               return;
      if (IGNORED_USERS.has(member.id))  return;
      if (listeningUsers.has(member.id)) return;
      listeningUsers.add(member.id);
      continuousCapture(connection, member.id, textChannel);
    });

    if (onJoined) onJoined();
  };

  if (connection.state.status === VoiceConnectionStatus.Ready) {
    onReady();
  } else {
    connection.once(VoiceConnectionStatus.Ready, onReady);
  }
}

// ─── Voice connection lifecycle ───────────────────────────────────────────────

const watchedConnections = new WeakSet();

function watchConnection(connection) {
  if (watchedConnections.has(connection)) return;
  watchedConnections.add(connection);

  // Kicked, moved, or a network drop. A move or a blip starts reconnecting
  // within seconds; anything else is gone for good, and without this Luna
  // kept believing she was connected — queueing speech into a dead connection
  // and announcing joins for a channel she had left.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      console.warn('[voice] connection lost and did not recover — leaving');
      try { connection.destroy(); } catch (_) {}
    }
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    if (activeConnection === connection) resetVoiceState();
  });

  connection.on('debug', logVoiceDebug);
}

// ─── Encrypted voice (DAVE): logging and self-heal ────────────────────────────
//
// Discord voice is end-to-end encrypted. Occasionally the bot's session loses
// one speaker's keys: Discord keeps reporting them speaking (the voice library
// records that before decrypting), but every packet fails to decrypt and is
// dropped with only a debug message. To Luna that speaker is simply silent —
// it looks exactly like her ignoring the wake word — while everyone else in
// the channel hears them fine. Them rejoining does not fix it; a fresh voice
// session for Luna does. Hence:
//   - logVoiceDebug: the library's [DAVE] messages, decrypt failures counted
//     and summarised at most every 10 s;
//   - a speaker reported speaking for VOICE_RECOVER_MS with no audio arriving
//     makes Luna reconnect (at most once per 5 minutes). 0 disables.
const VOICE_RECOVER_MS     = config.VOICE_RECOVER_MS;
const VOICE_RECOVER_GAP_MS = 5 * 60000;
const silentSpeakers = new Map();   // userId -> when Discord first said they spoke, with no audio since
let lastVoiceRecoveryAt = 0;
let decryptFailures = 0;
let decryptLoggedAt = 0;

function logVoiceDebug(message) {
  if (!message.includes('[DAVE]')) return;
  const text = message.replace(/^.*?\[DAVE\]\s*/, '');
  if (/failed to decrypt/i.test(text)) {
    decryptFailures++;
    const now = Date.now();
    if (now - decryptLoggedAt >= 10000) {
      console.warn(`[voice] encrypted audio: ${decryptFailures} packet(s) failed to decrypt (latest: ${text})`);
      decryptFailures = 0;
      decryptLoggedAt = now;
    }
    return;
  }
  console.log(`[voice] encryption: ${text}`);
}

// Encryption diagnostics. Whether Luna can decrypt a given speaker, read from
// the DAVE session itself rather than inferred from silence: is the speaker in
// her MLS group (no keys otherwise), and how many of their packets decrypted
// or failed. Discord's "speaking" signal fires when packets arrive, before
// decryption, so "speaking + failures + 0 decrypted" is a decryption problem,
// and "speaking + no packets at all" means they never reached decryption.
// Read through the voice library's internal session object (not public API):
// if a library update moves it, this returns null and logs once.
let cryptoDiagWarned = false;
function voiceCryptoState() {
  const conn = activeConnection;
  const dave = conn?.state?.networking?.state?.dave;
  if (!dave) return null;
  const session = dave.session;
  if (!session || typeof session.getUserIds !== 'function' || typeof session.getDecryptionStats !== 'function') {
    if (!cryptoDiagWarned && dave.protocolVersion > 0) {
      cryptoDiagWarned = true;
      console.warn('[voice] encryption diagnostics unavailable — the voice library\'s internals have changed');
    }
    return null;
  }
  let members = null;
  try { members = new Set(session.getUserIds()); } catch (_) {}
  let privacyCode = null;
  try { privacyCode = conn.voicePrivacyCode || null; } catch (_) {}
  return {
    status: ['inactive', 'pending', 'awaiting response', 'active'][session.status] ?? String(session.status),
    epoch: session.epoch != null ? String(session.epoch) : null,
    privacyCode,
    members,
    stats: userId => { try { return session.getDecryptionStats(userId); } catch (_) { return null; } },
  };
}

// One speaker's encryption state: { inGroup, ok, failed, problem, text }.
function cryptoVerdict(state, userId) {
  if (!state) return null;
  const inGroup = state.members ? state.members.has(userId) : null;
  const st = state.stats(userId);
  const ok = st ? st.successes : 0, failed = st ? st.failures : 0;
  const problem = inGroup === false || (failed > 0 && ok === 0);
  const group = inGroup === null ? 'group unknown' : inGroup ? 'in group' : 'NOT in group';
  return { inGroup, ok, failed, problem, text: st ? `${group}, ${ok} decrypted/${failed} failed` : `${group}, no packets yet` };
}

// Discord reported `userId` speaking (receiver 'start').
function noteSpeaking(userId) {
  if (!VOICE_RECOVER_MS || silentSpeakers.has(userId)) return;
  silentSpeakers.set(userId, Date.now());
  setTimeout(() => checkSilentSpeaker(userId), VOICE_RECOVER_MS);
}

// Decoded audio arrived from `userId`: their audio is fine.
function noteAudio(userId) {
  silentSpeakers.delete(userId);
}

function checkSilentSpeaker(userId) {
  const since = silentSpeakers.get(userId);
  if (!since || Date.now() - since < VOICE_RECOVER_MS || !activeConnection) return;
  silentSpeakers.delete(userId);
  const name = activeVoiceChannel?.members?.get(userId)?.displayName || userId;
  const verdict = cryptoVerdict(voiceCryptoState(), userId);
  const why = verdict ? ` (encryption: ${verdict.text})` : '';
  const action = decideSilentSpeaker({ verdict, now: Date.now(), lastReconnectAt: lastVoiceRecoveryAt, gapMs: VOICE_RECOVER_GAP_MS });
  if (action === 'restart-capture') {
    // Encryption is fine, so a reconnect (which disrupts everyone) would not
    // help: restart just this speaker's capture; Discord's next "speaking"
    // starts a fresh one.
    console.warn(`[voice] Discord reports ${name} speaking and their audio is decrypting${why}, ` +
      'but none of it reached Luna — restarting their capture (not an encryption problem)');
    activeConnection.receiver.subscriptions.get(userId)?.destroy();
    return;
  }
  if (action === 'wait') {
    console.warn(`[voice] still no decryptable audio from ${name}${why}; already reconnected recently, not retrying yet`);
    return;
  }
  lastVoiceRecoveryAt = Date.now();
  console.warn(`[voice] Discord reports ${name} speaking, but none of their audio has decrypted in ` +
    `${Math.round(VOICE_RECOVER_MS / 1000)}s${why} — reconnecting for a fresh encrypted session`);
  reconnectVoice();
}

// Leave and rejoin the same channel, quietly (no reply, no intro).
function reconnectVoice() {
  const channel = activeVoiceChannel, textChannel = activeTextChannel, guild = activeGuild;
  if (!channel || !guild) return;
  leaveVoice('reconnecting');
  setTimeout(() => {
    if (activeConnection) return;   // someone ran !luna in the meantime
    const connection = joinVoice(channel, guild);
    attachVoice(connection, channel, textChannel, guild, () => console.log(`[voice] reconnected to ${channel.name}`));
  }, 1500);
}

// Forgets everything tied to the current voice session.
function resetVoiceState() {
  activeConnection   = null;
  activeVoiceChannel = null;
  activeTextChannel  = null;
  activeGuild        = null;
  silentSpeakers.clear();
  listeningUsers.clear();
  captureStates.clear();
  for (const response of spokenResponses.values()) response.cancel();
  spokenResponses.clear();
  for (const request of llmRequests.values()) request.abort();
  llmRequests.clear();
  userGeneration.clear();
  playbackQueue      = Promise.resolve();
  currentPlayer      = null;
  currentPlayerUser  = null;
  conversations.clear();
}

function leaveVoice(reason) {
  const connection = activeConnection;
  if (!connection) return;
  console.log(`[voice] ${reason} — disconnecting.`);
  resetVoiceState();
  // Throws if the connection was already destroyed (e.g. Luna was kicked
  // from the channel), and an exception here escapes into discord.js.
  try { connection.destroy(); } catch (_) {}
}

// ─── Core listening loop ──────────────────────────────────────────────────────

function getRealMemberCount(voiceChannel) {
  if (!voiceChannel) return 0;
  return voiceChannel.members.filter(m => !m.user.bot && !IGNORED_USERS.has(m.id)).size;
}

function startListening(connection, channel) {
  // Self-heal input (see noteSpeaking); separate from the capture start below,
  // which returns early for speakers that already have a capture.
  connection.receiver.speaking.on('start', userId => {
    if (userId === client.user.id || IGNORED_USERS.has(userId)) return;
    noteSpeaking(userId);
  });

  connection.receiver.speaking.on('start', userId => {
    if (listeningUsers.has(userId))   return;
    if (userId === client.user.id)    return; // ignore bot's own audio
    if (IGNORED_USERS.has(userId))    return; // ignore configured bots/users
    listeningUsers.add(userId);
    continuousCapture(connection, userId, channel);
  });
}

// Live view of every active capture, for the health heartbeat below.
const captureStates = new Map();

// Learned audio level per speaker, keyed by user ID. Survives capture restarts,
// which happen on every 60 s idle gap — without this, AGC re-learns each
// speaker's level from scratch while they are saying the wake phrase.
// A few floats per user; never cleared.
const userGainState = new Map();

// Every 30 s, report enough per-speaker state to tell apart the three ways this
// can silently stop working: audio stopped arriving, the detector wedged, or
// `flushing` got stuck holding the gate shut.
setInterval(() => {
  if (captureStates.size === 0) return;

  const now = Date.now();
  const parts = [];
  const crypto = voiceCryptoState();
  if (crypto) parts.push(`enc[${crypto.status}, epoch ${crypto.epoch ?? '-'}, ${crypto.members ? crypto.members.size : '?'} in group]`);
    for (const [uid, s] of captureStates) {
    const ws = s.wakeStream;
    // Snapshot here too, not only on close: a crash or an ungraceful stream
    // teardown would otherwise discard everything learned about this speaker.
    if (ws) userGainState.set(uid, ws.exportGainState());
    parts.push(
      `${uid.slice(-5)}[` +
      `audio ${((now - s.lastData) / 1000).toFixed(0)}s ago, ` +
      `frames ${ws ? ws.chunksProcessed : 'n/a'}, ` +
      `peak30s ${ws ? ws.takeHealthPeak().toFixed(3) : 'n/a'}, ` +
      `qdepth ${ws ? ws.queueDepth : 'n/a'}, ` +
      `flushing ${s.flushing}, ` +
      `buffered ${s.buffered}` +
      (crypto ? `, ${cryptoVerdict(crypto, uid).text}` : '') + ']'
    );
  }
  console.log('[health] ' + parts.join(' '));
}, 30000).unref?.();

function continuousCapture(connection, userId, channel) {
  console.log(`[${userId}] capture started`);
  const audioStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 60000 },
  });

  // The pipeline (see voice-input.js): packets → decoder → PCM frames, which
  // go both to the wake-word model and to the segmenter; each utterance the
  // segmenter cuts is gated on the wake word (flushUtterance) and, if it
  // passes, transcribed and turned into a question (processUtterance).
  let flushing       = false;   // an utterance of this speaker is being processed
  let flushStartedAt = 0;
  let lastDataTime   = Date.now();
  let lastWakeAt     = 0;       // when the model last fired, until an utterance consumes it
  let listening      = false;   // waiting for the question after a bare "hey Luna"
  let listenTimer    = null;    // ends that wait if no question comes

  const segmenter = createSegmenter({
    energyThreshold: ENERGY_THRESHOLD,
    prerollFrames:   PREROLL_CHUNKS,
    frameMs:         DECODER_CHUNK_MS,
    maxFrames:       MAX_UTTERANCE_CHUNKS,
    silenceMs:       SILENCE_MS,
    onSilence:       () => flushUtterance(),
  });

  // Each speaker needs an independent wake-word pipeline — sharing one buffer
  // across users would interleave their audio and corrupt every detection.
  const wakeStream = wakeEngine
    ? wakeEngine.createStream({
        threshold:     OWW_THRESHOLD,
        triggerFrames: OWW_TRIGGER_FRAMES,
        refractoryMs:  OWW_REFRACTORY_MS,
        gain:          OWW_GAIN,
        gainState:     userGainState.get(userId) || null,
        label:         userId,
        onDetect: (score, at) => {
          lastWakeAt = at;
          console.log(`[${userId}] [oww] wake word detected (score=${score.toFixed(3)})`);

          // Barge-in while this speaker's previous question is still with the
          // LLM. Before, `flushing` held the new request back until the old
          // one finished: during a long think the speaker could not get
          // through at all, and by the time the old answer arrived their
          // buffered "hey Luna" was too old and got discarded. Now the old
          // question is cancelled at once, which releases `flushing` in a
          // moment, and the buffer is cut down to the audio around the wake
          // phrase so the new question is not prefixed by whatever was said
          // during the wait.
          if (flushing) {
            console.log(`[${userId}] barge-in — cancelling the previous question`);
            interruptOwnPlayback(userId);
            segmenter.keepLast(Math.ceil((PREROLL_MS + 1500) / DECODER_CHUNK_MS));
          }
        },
      })
    : null;
  const feedWake = wakeStream
    ? createWakeFeeder(wakeStream, { frameMs: DECODER_CHUNK_MS, maxFillMs: MAX_SILENCE_FILL_MS })
    : null;

  const decodePacket = createPacketDecoder(new OpusEncoder(48000, 1), {
    onPcm,
    onUndecodable: count => console.warn(`[${userId}] ${count} audio packet(s) could not be decoded — dropped ` +
      '(normal for a moment while the encryption session is set up)'),
  });
  audioStream.setMaxListeners(20);
  audioStream.on('data', decodePacket);

  captureStates.set(userId, {
    wakeStream,
    get flushing() { return flushing; },
    get buffered() { return segmenter.buffered; },
    get lastData() { return lastDataTime; },
  });

  function onPcm(frame) {
    lastDataTime = Date.now();
    noteAudio(userId);
    // The model hears every frame, quiet ones included.
    if (feedWake) {
      feedWake(frame).then(score => {
        if (OWW_DEBUG_SCORE > 0 && score !== null && score >= OWW_DEBUG_SCORE) {
          console.log(
            `[${userId}] [oww] score=${score.toFixed(3)} ` +
            `gain=${wakeStream.lastGain.toFixed(1)}x rms=${Math.round(wakeStream.lastRms)}`
          );
        }
      }).catch(() => {});
    }
    segmenter.push(frame);
  }

  let blockedWarnAt = 0;

  function flushUtterance() {
    // Being blocked here is how "she only answers once" manifests: `flushing`
    // stays true while a response is in flight, and every utterance in that
    // window is refused. Normally it clears; if it does not, this is the only
    // visible symptom. Rate-limited so it does not flood at 10 Hz.
    if (flushing) {
      const now = Date.now();
      if (now - blockedWarnAt > 10000) {
        blockedWarnAt = now;
        console.warn(
          `[${userId}] flush blocked — still processing a previous request ` +
          `(${Math.round((now - flushStartedAt) / 1000)}s). Speech is buffering, not lost.`
        );
      }
      return;
    }

    if (segmenter.buffered === 0) return;

    // Only the wake phrase so far, then a pause: wait for the question rather
    // than answering "hey Luna" on its own. The question, once spoken, ends
    // the utterance as usual (silence after it); if none comes, the timer
    // ends the wait and the greeting is answered. The timer stands down once
    // the question has begun: firing mid-question cut it off ("…will be like
    // on." — "Saturday" then arrived as an utterance with no wake word).
    const quietMs = Date.now() - segmenter.lastSpeechAt;
    if (wakeStream && decideUtteranceEnd({ quietMs, lastSpeechAt: segmenter.lastSpeechAt,
        wakeAt: lastWakeAt, listenMs: WAKE_LISTEN_MS }) === 'listen') {
      if (!listening) {
        listening = true;
        console.log(`[${userId}] heard "hey Luna" — listening for the question (up to ${WAKE_LISTEN_MS / 1000}s)`);
      }
      clearTimeout(listenTimer);
      listenTimer = setTimeout(() => {
        if (Date.now() - segmenter.lastSpeechAt >= SILENCE_MS) flushUtterance();
      }, WAKE_LISTEN_MS - quietMs + 20);
      return;
    }
    listening = false;
    clearTimeout(listenTimer);

    flushing = true;
    flushStartedAt = Date.now();
    const { pcm, durationMs, speechMs, speechStartedAt } = segmenter.take();

    // Consume the detection up front. Every exit path below must leave
    // lastWakeAt disarmed, otherwise a detection that was dropped by an early
    // return stays armed and silently validates a later, wake-word-free
    // utterance.
    const wakeAt = lastWakeAt;
    lastWakeAt = 0;

    // MIN_SPEECH_MS is measured against speech, not speech plus lead-in, or
    // the lead-in would quietly lower it and let short noise bursts through.
    if (speechMs < MIN_SPEECH_MS) {
      // Too short to transcribe, but the detector sees all audio while the
      // segmenter only keeps frames above ENERGY_THRESHOLD. A quiet speaker
      // can trip the model without clearing the energy gate — re-arm rather
      // than burning the detection and rejecting the query that follows.
      lastWakeAt = wakeAt;
      flushing = false;
      return;
    }

    let verdict = 'detected';   // no model: every utterance goes on, and the transcript decides
    if (wakeStream) {
      const now = Date.now();
      // The peak is read (and reset) once per utterance, whatever the verdict,
      // so a good score cannot leak into a later utterance.
      const peak = wakeStream.takePeak();
      const decision = decideWake({ wakeAt, speechStartedAt, now, durationMs, peak,
        graceMs: OWW_GRACE_MS, candidateThreshold: OWW_CANDIDATE_THRESHOLD });
      verdict = decision.verdict;
      if (verdict === 'candidate') {
        console.log(`[${userId}] [oww] wake candidate (peak score ${peak.toFixed(3)}, ` +
          `threshold ${OWW_THRESHOLD}) — transcribing to confirm`);
      } else if (verdict === 'discard') {
        // The model's best score across the discarded utterance. If you spoke
        // the wake word and this reads 0.2x, the threshold is too high. If it
        // reads 0.00x, the model did not react to your voice at all and no
        // threshold will help.
        console.log(
          `[${userId}] utterance discarded — no wake word ` +
          `(${Math.round(durationMs)}ms, peak score ${peak.toFixed(3)}, ` +
          `threshold ${OWW_THRESHOLD})`
        );
        // A detection that exists but fails the window check is the single
        // most confusing failure mode — the user said the wake word, saw it
        // logged, and got nothing. Say why. (Silence when wakeAt === 0 is
        // normal: that is just ordinary conversation being filtered out.)
        if (wakeAt > 0) {
          console.warn(
            `[${userId}] DISCARDED despite detection — ` +
            `wake was ${now - wakeAt}ms ago, speech began ${now - speechStartedAt}ms ago, ` +
            `utterance ${Math.round(durationMs)}ms, span ${Math.round(decision.span)}ms. ` +
            'Raise OWW_GRACE_MS if this looks wrong.'
          );
        }
        flushing = false;
        return;
      }
    }

    console.log(`[${userId}] Processing ${Math.round(durationMs)}ms utterance...`);
    processUtterance(pcm, userId, connection, channel, wakeStream ? verdict === 'detected' : false, verdict === 'candidate')
      .finally(() => { flushing = false; });
  }

  // Discord stops sending packets during true silence, so the segmenter's
  // silence timer alone can miss the end of speech. Every 100 ms:
  const dataWatchdog = setInterval(() => {
    // …no data for SILENCE_MS while speaking ends the utterance;
    if (segmenter.speaking && Date.now() - lastDataTime > SILENCE_MS) {
      flushUtterance();
    }

    // …an utterance that never sees a silence gap is cut off;
    if (segmenter.speaking && Date.now() - segmenter.speechStartedAt > MAX_SPEECH_MS) {
      console.warn(
        `[${userId}] ${Math.round(MAX_SPEECH_MS / 1000)}s of continuous speech with no ` +
        'silence gap — forcing flush. ENERGY_THRESHOLD is likely below your background ' +
        'noise floor, or Luna is hearing herself through your speakers.'
      );
      segmenter.stopSilenceTimer();
      flushUtterance();
      // If the flush was refused — already flushing, or nothing buffered —
      // reset anyway so this does not re-fire every 100 ms.
      if (segmenter.speaking) segmenter.abandon();
    }

    // …and a request that never returns releases this speaker. `flushing` is
    // cleared in processUtterance's .finally(); if a Whisper or LM Studio call
    // never settles it stays true forever and this user goes permanently deaf
    // with no error logged. Self-heal, and say so loudly.
    if (flushing && Date.now() - flushStartedAt > STUCK_FLUSH_MS) {
      console.error(
        `[${userId}] flush stuck for ${Math.round((Date.now() - flushStartedAt) / 1000)}s ` +
        '— releasing. A Whisper or LM Studio request almost certainly never returned.'
      );
      flushing = false;
      flushStartedAt = 0;
      // processUtterance's own guard is released in the same .finally() that
      // never ran — without this every later utterance is still dropped as
      // "previous one still being processed" and the self-heal heals nothing.
      processingUsers.delete(userId);
    }
  }, 100);

  audioStream.once('close', () => {
    console.log(`[${userId}] capture stream closed — will resume on next speech`);
    clearInterval(dataWatchdog);
    clearTimeout(listenTimer);
    segmenter.close();
    if (wakeStream) {
      userGainState.set(userId, wakeStream.exportGainState());
      wakeStream.close();
    }
    captureStates.delete(userId);
    listeningUsers.delete(userId);
    // Stream closed — speaking.start will re-trigger continuousCapture next time user speaks
  });

  audioStream.once('error', err => {
    console.error(`[${userId}] capture stream error:`, err);
    clearInterval(dataWatchdog);
    clearTimeout(listenTimer);
    segmenter.close();
    if (wakeStream) wakeStream.close();
    captureStates.delete(userId);
    listeningUsers.delete(userId);
  });
}

const processingUsers = new Set(); // tracks who is currently being transcribed/responded to

// ─── Playback queue ───────────────────────────────────────────────────────────
// Serializes TTS sentences within a single response.
//
// Responses from different speakers QUEUE and play in order. Sentences within
// one response are ordered by the same chain.
//
// Each sentence closure captures its speaker and that speaker's generation at
// queue time. On execution it re-checks: if that speaker has since asked
// something newer, the sentence is skipped. Another speaker asking does not
// affect it. This preserves barge-in for the person being answered while
// preventing speakers from cancelling each other.

let playbackQueue     = Promise.resolve();
let currentPlayer     = null;
let currentPlayerUser = null;              // who owns the entry currently playing
const userGeneration  = new Map();         // userId -> that user's latest generation

// Generations are PER USER, not global.
//
// Previously a single global counter meant any new query cancelled every
// pending sentence regardless of who asked. With several people in a channel
// that silently ate questions: A asks, B asks, only B gets an answer and A
// never learns why.
//
// Now each speaker has their own generation. A new query supersedes only that
// speaker's own pending sentences; everyone else's stay queued and play in
// turn.
function nextGeneration(userId) {
  const g = (userGeneration.get(userId) || 0) + 1;
  userGeneration.set(userId, g);
  // Superseded: stop synthesising sentences of their answer that will now
  // never play.
  const superseded = spokenResponses.get(userId);
  if (superseded) {
    superseded.cancel();
    spokenResponses.delete(userId);
  }
  // ...and stop the LLM working on a question nobody is waiting for.
  const request = llmRequests.get(userId);
  if (request) {
    request.abort();
    llmRequests.delete(userId);
  }
  return g;
}

// userId -> AbortController for that speaker's LLM request in flight.
const llmRequests = new Map();

// ─── Spoken responses ─────────────────────────────────────────────────────────
//
// One answer being spoken. Sentences arrive from the LLM; TTS is requested for
// the sentence about to play plus TTS_LOOKAHEAD after it — enough for gapless
// playback, without synthesising a whole long answer up front. cancel() aborts
// requests in flight and discards audio that was fetched but not played: on a
// barge-in, that work used to run to completion (and, on ElevenLabs, be billed)
// for sentences nobody would hear.
const spokenResponses = new Map(); // userId -> their in-progress SpokenResponse

class SpokenResponse {
  constructor() {
    this.sentences  = [];
    this.fetches    = [];   // Promise<stream|null>, by sentence index
    this.next       = 0;    // index of the next sentence to play
    this.controller = new AbortController();
  }

  get size() { return this.sentences.length; }

  add(sentence) {
    this.sentences.push(sentence);
    this._fill();
  }

  // Resolves to the audio stream for sentence `i` (or null if TTS failed) and
  // moves the lookahead window along.
  async take(i) {
    this.next = i + 1;
    this._fill();
    return this.fetches[i];
  }

  _fill() {
    if (this.controller.signal.aborted) return;
    const limit = Math.min(this.sentences.length, this.next + 1 + TTS_LOOKAHEAD);
    for (let i = this.fetches.length; i < limit; i++) {
      this.fetches.push(fetchTTS(this.sentences[i], { signal: this.controller.signal }));
    }
  }

  cancel() {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    for (let i = this.next; i < this.fetches.length; i++) {
      this.fetches[i].then(stream => stream?.destroy()).catch(() => {});
    }
  }
}

function queuePlayback(fn, userId, generation) {
  playbackQueue = playbackQueue.then(async () => {
    // Stale only if THIS user has since asked something newer.
    if (userGeneration.get(userId) !== generation) return;
    currentPlayerUser = userId;
    try {
      await fn();
    } finally {
      currentPlayerUser = null;
    }
  }).catch(() => {});
}

// Barge-in, scoped to one speaker.
//
// Saying the wake word again cuts off *your own* answer — the original intent.
// It no longer stops someone else mid-sentence. Note this deliberately does
// NOT reset playbackQueue: doing so would drop other speakers' queued
// responses, which is the bug this replaces.
function interruptOwnPlayback(userId) {
  const generation = nextGeneration(userId);

  if (currentPlayerUser === userId && currentPlayer) {
    try { currentPlayer.stop(true); } catch (_) {}
    currentPlayer = null;
    currentPlayerUser = null;
  }

  return generation;
}

// ─── WAV helper ───────────────────────────────────────────────────────────────

function buildWavBuffer(pcmData, sampleRate, channels, bitDepth) {
  const byteRate   = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const header     = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1,  20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

// ─── Whisper ──────────────────────────────────────────────────────────────────

async function transcribeWithWhisper(wavBuffer) {
  try {
    const form = new FormData();
    form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'json');

    const res = await fetch(nextWhisperUrl(), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`Whisper server error ${res.status}:`, await res.text());
      return null;
    }
    const data = await res.json();
    return (data.text || '').trim() || null;
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error(`Whisper timed out after ${WHISPER_TIMEOUT_MS}ms — server may be overloaded`);
    } else {
      console.error('Whisper server error:', err.message);
    }
    return null;
  }
}

// ─── Utterance processing ─────────────────────────────────────────────────────

async function processUtterance(pcm, userId, connection, channel, wakeDetected = false, wakeCandidate = false) {
  if (processingUsers.has(userId)) {
    console.warn(`[${userId}] utterance dropped — previous one still being processed`);
    return;
  }
  processingUsers.add(userId);

  const t0 = Date.now(); // timing: clock starts when the utterance is flushed

  try {
    const wavBuffer = buildWavBuffer(pcm, 48000, 1, 16);
    const transcript = await transcribeWithWhisper(wavBuffer);
    console.log(`[${userId}] [timing] Whisper done: ${Date.now() - t0}ms`);

    if (!transcript) return;

    // The question: the wake phrase removed, or nothing if a candidate turns
    // out to have no "Luna" in it (see confirmWake in voice-input.js).
    const confirmed = confirmWake(transcript, { detected: wakeDetected, candidate: wakeCandidate });
    if (!confirmed.accepted) {
      if (wakeCandidate) {
        console.log(`[${userId}] [oww] wake candidate rejected — ${confirmed.reason} ` +
          `(${transcript.split(/\s+/).length} words)`);
      }
      return;
    }
    if (wakeCandidate) console.log(`[${userId}] [oww] wake candidate confirmed by Whisper`);
    const query = confirmed.query;

    console.log(`[${userId}] Query:`, query);
    await handleQuery(query, connection, channel, t0, userId);
  } catch (err) {
    console.error(`[${userId}] Error processing utterance:`, err);
  } finally {
    processingUsers.delete(userId);
  }
}

// ─── Sound effect ─────────────────────────────────────────────────────────────

async function playSound(filePath, connection) {
  try {
    const player   = createAudioPlayer();
    const resource = createAudioResource(filePath, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });
    resource.volume?.setVolume(0.2);
    connection.subscribe(player);
    player.play(resource);
    await new Promise(resolve => {
      player.on(AudioPlayerStatus.Idle, () => { player.stop(); resolve(); });
      player.on('error', () => resolve()); // don't block if file missing
      setTimeout(resolve, 5000);           // safety timeout
    });
  } catch (_) {}
}

// ─── Intent detection ─────────────────────────────────────────────────────────

const SEARCH_KEYWORDS = [
  // factual lookups
  'price', 'cost', 'weather', 'forecast', 'temperature',
  'news', 'score', 'result', 'standing', 'ranking',
  'stock', 'crypto', 'bitcoin', 'market',
  // question patterns that imply real-world data
  'who is', 'who are', 'who won', 'who plays',
  'what happened', 'what time is',
  'when is', 'when does', 'when did',
  'where is', 'where are',
  'how much does', 'how much is',
  'is there a',
  // Unambiguous recency phrases. Each of these is a request for information
  // that changed after training; none of them occur in ordinary chit-chat.
  'the latest', 'latest on', 'any news', 'update on', 'headlines',
  'release date', 'came out', 'coming out',
  'exchange rate', 'earnings report', 'election',
  'open right now', 'still open', 'as of now',
];

// Bare time words are NOT search triggers on their own.
//
// "today", "tonight" and friends are among the most common words in casual
// speech — "how are you doing today?" is a greeting, not a query, and routing
// it through Tavily costs a web round trip plus a whole extra tool-calling turn
// on the LLM for no benefit. They only imply a lookup when paired with a
// subject whose answer actually moves.
const TEMPORAL = [
  'today', 'tonight', 'tomorrow', 'yesterday', 'last night',
  'this week', 'this month', 'this year', 'right now', 'currently',
];

const TOPICAL = [
  'weather', 'forecast', 'temperature', 'rain', 'snow', 'storm',
  'news', 'happening', 'going on', 'score', 'game', 'match',
  'price', 'cost', 'stock', 'market', 'open', 'closed', 'schedule',
  'release', 'launch', 'event', 'traffic', 'flight',
];

// A four-digit year at or after 2020 is a strong recency signal on its own and
// cannot be expressed as a substring match.
const SEARCH_YEAR_RE = /\b20[2-9]\d\b/;

// When the model is offered the web search tool:
//   always   — on every question (default). The model decides for itself
//              whether it needs the internet; the keyword rules below both
//              missed real searches ("did UCLA play football today?" — the
//              model then wrote a tool call as text) and searched for no
//              reason ("is there a way to say this nicer?"). Offering the
//              tool costs ~1-4 s per question (see searchIntegration).
//   keywords — only when needsWebSearch() matches (the old behaviour).
//   off      — never. Also forced when no search server is configured.
//
// Where the tool comes from:
//   SEARCH_MCP_PLUGIN set (e.g. "mcp/tavily") — an MCP server configured in
//     LM Studio's own mcp.json, which LM Studio keeps connected (~1 s faster
//     per question than connecting per request).
//   otherwise — Tavily's hosted MCP server with TAVILY_API_KEY, connected by
//     LM Studio on every request (an "ephemeral" integration).
// Either way the model is shown only SEARCH_TOOLS (default "tavily_search";
// "all" for every tool the server has). Tavily also offers research, crawl,
// map and extract — slower, credit-hungry, and the model chained them (search,
// extract, search again) on a simple weather question; showing one tool also
// cuts the tool definitions the model must read from ~2,300 to ~970 tokens.
const SEARCH_MCP_PLUGIN = config.SEARCH_MCP_PLUGIN;
const SEARCH_TOOLS = (() => {
  const raw = config.SEARCH_TOOLS;
  return raw.toLowerCase() === 'all' ? null : raw.split(',').map(t => t.trim()).filter(Boolean);
})();

// No search server configured → off, whatever WEB_SEARCH says.
const WEB_SEARCH = !SEARCH_MCP_PLUGIN && !config.TAVILY_API_KEY ? 'off' : config.WEB_SEARCH;

function searchIntegration() {
  const allowed = SEARCH_TOOLS ? { allowed_tools: SEARCH_TOOLS } : {};
  return SEARCH_MCP_PLUGIN
    ? { type: 'plugin', id: SEARCH_MCP_PLUGIN, ...allowed }
    : { type: 'ephemeral_mcp', server_label: 'tavily',
        server_url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${config.TAVILY_API_KEY}`, ...allowed };
}

function describeSearch() {
  if (WEB_SEARCH === 'off') {
    return 'off' + (SEARCH_MCP_PLUGIN || config.TAVILY_API_KEY ? '' : ' (no TAVILY_API_KEY or SEARCH_MCP_PLUGIN)');
  }
  return (WEB_SEARCH === 'always' ? 'offered on every question (the model decides)' : 'keywords') +
    ` via ${SEARCH_MCP_PLUGIN ? `LM Studio plugin ${SEARCH_MCP_PLUGIN}` : 'Tavily (connected per request)'}` +
    `, tools: ${SEARCH_TOOLS ? SEARCH_TOOLS.join(', ') : 'all'}`;
}

// Search outage fallback. LM Studio connects to the search server before
// answering, and if it can't (server down, or slow: it gives up after ~20 s)
// it rejects the whole request, so with search offered on every question one
// outage would fail every question. Instead the question is answered without
// search, and search is paused for SEARCH_PAUSE_MS so the following questions
// don't each pay the failed connection attempt.
const SEARCH_PAUSE_MS = config.SEARCH_PAUSE_MS;
let searchPausedUntil = 0;

function pauseSearch(reason) {
  searchPausedUntil = Date.now() + SEARCH_PAUSE_MS;
  console.warn(`[search] ${reason} — answering without search; search paused for ${Math.round(SEARCH_PAUSE_MS / 60000)} min`);
}

function offerSearch(query) {
  if (Date.now() < searchPausedUntil) return false;
  return WEB_SEARCH === 'always' || (WEB_SEARCH === 'keywords' && needsWebSearch(query));
}

function needsWebSearch(query) {
  const lower = query.toLowerCase();
  if (SEARCH_YEAR_RE.test(lower)) return true;
  if (SEARCH_KEYWORDS.some(k => lower.includes(k))) return true;
  return TEMPORAL.some(t => lower.includes(t)) && TOPICAL.some(t => lower.includes(t));
}

// ─── Smakbot commands ─────────────────────────────────────────────────────────
//
// Spoken form → text command posted in the channel. Tried top-down, so
// argument-taking patterns must precede bare verbs.
//
// Every pattern is anchored at both ends against the wake-stripped transcript.
// The start anchor stops "I'll stop by later" being a command; the end anchor
// stops "skip the intro of that song you played" from silently becoming !skip
// instead of reaching the LLM.
//
// The trailing [\s,.!?]* is load-bearing: Whisper punctuates single-word
// utterances, so a spoken "skip" arrives as "Skip." and matches nothing
// without it.
const SMAKBOT_COMMANDS = [
  {
    name:        'play',
    pattern:     /^play(?:\s+(?:the\s+)?(?:song|music|track))?[,.]?\s+(.+)$/i,
    requiresArg: true,
    build:       arg => `!play ${arg}`,
    ack:         arg => `Okay, playing ${arg}.`,
    // Only play summons. !skip and !stop with no music bot in the channel are
    // no-ops, and dragging smakbot in to receive them would be surprising.
    summon:      true,
  },
  {
    name:    'skip',
    pattern: /^skip(?:\s+(?:this|that|the|it))?(?:\s+(?:song|track|one))?[\s,.!?]*$/i,
    build:   () => '!skip',
    ack:     () => 'Skipping.',
  },
  {
    name:    'stop',
    pattern: /^stop(?:\s+(?:the|this|that))?(?:\s+(?:song|music|track|playing))?[\s,.!?]*$/i,
    build:   () => '!stop',
    // Set to () => null if you'd rather "stop" produce silence — some people
    // say "hey Luna, stop" meaning "stop talking", and answering them with
    // speech reads as ignoring them.
    ack:     () => 'Okay, stopping.',
  },
];

// Returns { build, ack, summon, arg } or null. Wake phrase is normally already
// stripped upstream; stripWakeWord here is a no-op safety net for the path
// where openWakeWord gated on audio and Whisper still transcribed the phrase.
function extractSmakbotCommand(query) {
  const after = stripWakeWord(query);

  for (const cmd of SMAKBOT_COMMANDS) {
    const match = after.match(cmd.pattern);
    if (!match) continue;

    const arg = match[1]
      ? match[1]
          .trim()
          .replace(/[,.!?]+$/, '')
          .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')  // strip surrounding quote characters, incl. curly quotes
          .trim()
      : null;

    // A bare "play" with nothing after it is a conversational fragment, not a
    // command — fall through and let the LLM have it.
    if (cmd.requiresArg && !arg) continue;

    return { ...cmd, arg };
  }
  return null;
}

// ─── Query handler ────────────────────────────────────────────────────────────

async function handleQuery(query, connection, channel, t0 = Date.now(), userId = 'unknown') {
  // Check for smakbot commands first
  const musicCommand = extractSmakbotCommand(query);
  if (musicCommand) {
    // Supersede this speaker's own pending audio BEFORE the chime. A
    // VoiceConnection has exactly one subscription, and playSound() creates its
    // own player and subscribes — so an unconditional chime detaches whatever
    // sentence is mid-playback, including another speaker's.
    const musicGeneration = interruptOwnPlayback(userId);
    if (!currentPlayer) {
      playSound(CHIME_PATH, connection).catch(() => {});
    }

    const commandText = musicCommand.build(musicCommand.arg);
    console.log(`Smakbot command: ${commandText}`);

    const musicBotPresent = activeVoiceChannel?.members?.some(
      m => m.user.username.toLowerCase().includes('smakbot')
    );

    if (!musicBotPresent && musicCommand.summon) {
      console.log('smakbot not in channel — summoning first');
      await channel.send('!summon').catch(err =>
        console.error('Failed to send summon command:', err.message)
      );
    }

    await channel.send(commandText).catch(err =>
      console.error(`Failed to send ${commandText}:`, err.message)
    );

    const ack = musicCommand.ack(musicCommand.arg);
    if (ack) {
      queuePlayback(async () => {
        const pt = await fetchTTS(ack);
        if (pt) await playTTS(pt, connection);
      }, userId, musicGeneration);
    }
    return;
  }

  // Supersede only this speaker's own pending response. Anyone else's queued
  // sentences survive and play in turn.
  const myGeneration = interruptOwnPlayback(userId);

  // Fire chime (don't await — let it play while we fetch the LLM response).
  //
  // Skipped while audio is already playing. playSound() creates its own
  // AudioPlayer and calls connection.subscribe(), and a VoiceConnection has
  // exactly one subscription — so an unconditional chime silently detached
  // whichever sentence was mid-playback. With several people in a channel that
  // presented as Luna's answers being randomly truncated.
  // Whether the model is offered the web search tool. It decides itself
  // whether to use it; `let`, because a question it tried to search without
  // the tool is asked again with it (see the pass loop).
  let useSearch = offerSearch(query);

  if (!currentPlayer) {
    playSound(CHIME_PATH, connection).catch(() => {});
  }

  // Not awaited: posting (and later deleting) this message are Discord round
  // trips of 100-300 ms each, and both used to sit directly in front of the
  // LLM request and the first sentence's TTS.
  const statusMsg = channel.send('🤔 *Luna is thinking...*').catch(() => null);
  let statusCleared = false;
  const clearStatus = () => {
    if (statusCleared) return;
    statusCleared = true;
    statusMsg.then(m => m && m.delete()).catch(() => {});
  };

  // A one-off line tied to this question — the search heads-up and the
  // "still thinking" fillers. Each is its own queue entry, ahead of the
  // answer's: making it the answer's first sentence would enqueue the answer
  // immediately, and that entry would then hold the shared queue for the whole
  // wait, blocking other speakers. Same generation as the answer, so a barge-in
  // skips it too, as does `wanted()` turning false while it waits.
  const sayAside = (tag, phrase, wanted = () => true) => {
    console.log(`[${userId}] [${tag}] "${phrase}"`);
    queuePlayback(async () => {
      if (!wanted()) return;
      const pt = await fetchTTS(phrase);
      if (!pt) return;
      if (!wanted() || userGeneration.get(userId) !== myGeneration) { pt.destroy(); return; }
      await playTTS(pt, connection);
    }, userId, myGeneration);
  };

  // Search heads-up, said when the model actually starts a web search (its
  // first tool call), once per question. Predicting it from keywords before
  // the request announced searches that never happened and missed ones that
  // did; this way it is heard if and only if Luna really is searching.
  let searchAnnounced = false;
  const announceSearchNow = () => {
    if (searchAnnounced) return;
    searchAnnounced = true;
    if (!statusCleared) {
      statusMsg.then(m => m && !statusCleared && m.edit('🔍 *Luna is searching the web...*')).catch(() => {});
    }
    // Skipped if the answer has already started: queued behind it, it would
    // only play once the answer had finished.
    if (ANNOUNCE_SEARCH) sayAside('search', fillPhrase(SEARCH_PHRASES, {}), () => firstSentence);
  };

  // "Still thinking" fillers while no answer has started. Each pass through
  // the phrases is freshly shuffled, so nothing repeats until every phrase
  // has been used, and never twice in a row across passes.
  let answerStarted = false;
  let fillerTimer   = null;
  let fillersSaid   = 0;
  const askerName = speakableName(activeVoiceChannel?.members?.get(userId)?.displayName);
  const usable = THINKING_PHRASES.filter(p => askerName || !p.includes('{name}'));
  let deck = [];
  let lastFiller = null;
  const nextFiller = () => {
    if (!deck.length) {
      deck = shuffle(usable);
      if (deck.length > 1 && deck[0] === lastFiller) deck.push(deck.shift());
    }
    return (lastFiller = deck.shift());
  };
  const stopFillers = () => {
    answerStarted = true;
    clearTimeout(fillerTimer);
  };
  const scheduleFiller = () => {
    if (!ANNOUNCE_THINKING || !usable.length) return;
    if (THINKING_MAX > 0 && fillersSaid >= THINKING_MAX) return;
    const [lo, hi] = THINKING_WAITS[Math.min(fillersSaid, THINKING_WAITS.length - 1)];
    const wait = lo + Math.random() * (hi - lo);
    fillerTimer = setTimeout(() => {
      if (answerStarted || userGeneration.get(userId) !== myGeneration) return;
      fillersSaid++;
      // The wait is in the log tag ("[thinking +17.3s]"), so the spacing can
      // be checked from the logs.
      sayAside(`thinking +${(wait / 1000).toFixed(1)}s`,
        nextFiller().replaceAll('{name}', askerName), () => !answerStarted);
      scheduleFiller();
    }, wait);
  };
  scheduleFiller();

  // ── Per-response playback ───────────────────────────────────────────────
  //
  // ONE entry goes on the global chain for the whole response, not one per
  // sentence. With per-sentence entries two speakers' answers braid together
  // — A1, B1, A2, B2 — which is worse than the bug this design replaced.
  //
  // TTS for each sentence is requested as soon as it is within TTS_LOOKAHEAD
  // of playback (see SpokenResponse), so synthesis still overlaps playback.
  // Only playback order is serialised.
  const response = new SpokenResponse();
  spokenResponses.set(userId, response);
  let streamDone = false;
  let wake       = null;    // resolver signalling "more sentences available"

  const signal = () => { if (wake) { wake(); wake = null; } };

  // Enqueued LAZILY, on the first sentence — never at query time.
  //
  // The entry parks at the head of the shared chain while it waits for more
  // sentences. Enqueuing it up front would therefore hold that head for the
  // entire LLM generation (up to LM_TIMEOUT_MS) while producing no
  // audio at all, blocking every other speaker. Ordering is unaffected: the
  // chain still serialises whole responses, just from first audio rather than
  // from first keystroke.
  let queued = false;
  const ensureQueued = () => {
    if (queued) return;
    queued = true;

    queuePlayback(async () => {
      let i = 0;
      let firstAudio = true;

      try {
        while (true) {
          if (i < response.size) {
            if (userGeneration.get(userId) !== myGeneration) return;

            const passThrough = await response.take(i++);

            // Re-check AFTER the await: a barge-in can land while TTS is still
            // rendering, and without this the superseded sentence plays anyway.
            if (userGeneration.get(userId) !== myGeneration) {
              passThrough?.destroy();
              return;
            }

            if (passThrough) {
              if (firstAudio) {
                firstAudio = false;
                console.log(`[${userId}] [timing] First audio start: ${Date.now() - t0}ms`);
              }
              await playTTS(passThrough, connection);
            }
          } else if (streamDone) {
            return;
          } else {
            await new Promise(r => { wake = r; });
          }
        }
      } finally {
        if (spokenResponses.get(userId) === response) spokenResponses.delete(userId);
      }
    }, userId, myGeneration);
  };

  // One LLM request per pass, and at most one retry for each reason:
  //   - the model wrote a tool call as text because it was not offered the
  //     search tool -> ask again with search on (same reasoning);
  //   - it thought past LLM_THINK_LIMIT_MS without starting an answer, or
  //     finished with no words at all (it has answered "." after 50 s of
  //     reasoning) -> ask again with reasoning off, which answers in seconds.
  const superseded = () => userGeneration.get(userId) !== myGeneration;
  let reasoning     = LLM_REASONING;
  let firstSentence = true;
  let reasoningRetried = false;
  // Search results seen so far (tool_call.success), so a quick-answer retry
  // can answer from them instead of searching all over again.
  const searchCalls = [];
  let context = '';

  const speak = sentence => {
    console.log('Luna sentence:', sentence);
    if (firstSentence) {
      firstSentence = false;
      console.log(`[timing] First LLM sentence: ${Date.now() - t0}ms`);
      clearStatus();
      stopFillers();
    }
    ensureQueued();
    response.add(sentence);
    signal();
  };

  try {
    for (;;) {
      let fakeToolCall = false;
      // Search may have been paused by an earlier pass of this question.
      if (useSearch && Date.now() < searchPausedUntil) useSearch = false;
      const cancel = new AbortController();
      llmRequests.set(userId, cancel);
      // Reasoning clock: runs only between reasoning.start and reasoning.end,
      // so time spent searching and reading results is not counted.
      let thinkLimitHit = false;
      let thinkTimer    = null;
      let reasonedMs    = 0;
      let reasoningAt   = 0;
      const limitActive = () => LLM_THINK_LIMIT_MS > 0 && reasoning !== 'off' && firstSentence;
      // What of the answer gets said is the answer filter's job (see
      // answer-filter.js). Reasoning-off passes that may search hold
      // everything until the end: without reasoning the model narrates its
      // way through searches. (Only those: holding every answer until it is
      // complete would delay all of them.)
      const filter = createAnswerFilter({
        reasoning: reasoning !== 'off',
        holdUntilEnd: reasoningRetried && useSearch,
        speak,
        drop: (kind, text) => console.log(kind === 'narration'
          ? `[${userId}] [LLM] dropped narration before a search (not spoken): ${text.slice(0, 160)}`
          : `[${userId}] [LLM] dropped reasoning that leaked into the answer (not spoken): ${text.slice(0, 160)}`),
        cleaned: raw => console.log(`[${userId}] [LLM] cleaned up for speech; as written: ${JSON.stringify(raw.slice(0, 200))}`),
      });
      const onEvent = e => {
        if (e.type === 'reasoning.start' && !reasoningAt) {
          reasoningAt = Date.now();
          if (limitActive()) {
            thinkTimer = setTimeout(() => {
              thinkLimitHit = true;
              cancel.abort(new DOMException(`no answer after ${LLM_THINK_LIMIT_MS / 1000}s of reasoning`, 'AbortError'));
            }, Math.max(0, LLM_THINK_LIMIT_MS - reasonedMs));
          }
        } else if (e.type === 'reasoning.end' && reasoningAt) {
          reasonedMs += Date.now() - reasoningAt;
          reasoningAt = 0;
          clearTimeout(thinkTimer);
        } else if (e.type === 'tool_call.start') {
          announceSearchNow();
        } else if (e.type === 'tool_call.success' && e.output) {
          searchCalls.push({ query: e.arguments?.query || '', output: e.output });
        }
        filter.event(e);
      };

      try {
        const extraSystem = reasoningRetried ? QUICK_PROMPT : '';
        for await (const sentence of getLMStudioResponseStreaming(query, userId, useSearch, { reasoning, signal: cancel.signal, onEvent, context, extraSystem })) {
          // Abort only if THIS speaker asked something newer mid-stream.
          if (superseded()) break;
          const verdict = filter.text(sentence);
          // A tool call written out as text — the model wanted to search but
          // had no search tool. Never spoken; stop this pass and ask again
          // with search on.
          if (verdict === 'tool-call-as-text') {
            fakeToolCall = true;
            console.warn(`[${userId}] [LLM] model wrote a tool call as text (not spoken): ${sentence.replace(/\s+/g, ' ').slice(0, 120)}`);
            break;
          }
          // The answer has started: the thinking limit no longer applies.
          if (verdict === 'ok') clearTimeout(thinkTimer);
        }
        // Whatever is still held was answer. (Not after a tool call written
        // as text: what came before it is narration.)
        if (!superseded() && !fakeToolCall) filter.end();
      } catch (err) {
        // The thinking limit is a planned cancel; anything else (including a
        // supersede) is handled below.
        if (!thinkLimitHit || superseded()) throw err;
      } finally {
        clearTimeout(thinkTimer);
        if (llmRequests.get(userId) === cancel) llmRequests.delete(userId);
      }

      if (superseded()) break;
      if (fakeToolCall && !useSearch && WEB_SEARCH !== 'off' && Date.now() >= searchPausedUntil) {
        console.warn(`[${userId}] [LLM] model tried to search without the search tool — asking again with web search`);
        useSearch = true;
        continue;
      }
      if (!firstSentence || reasoning === 'off' || reasoningRetried) break;
      if (thinkLimitHit) {
        console.warn(`[${userId}] [LLM] no answer after ${LLM_THINK_LIMIT_MS / 1000}s of reasoning — asking again with reasoning off`);
        sayAside('quick', fillPhrase(QUICK_ANSWER_PHRASES, {}), () => firstSentence);
      } else {
        console.warn(`[${userId}] [LLM] answer had ${fakeToolCall ? 'only a tool call written as text' : 'no words'} — asking again with reasoning off`);
      }
      reasoning = 'off';
      reasoningRetried = true;
      if (searchCalls.length) {
        // Answer from what was already found: searching again redid minutes
        // of work, and a reasoning-off model narrates its way through searches.
        context = 'Web search results already found for this question (answer from these; do not search again):\n' +
          condenseSearchResults(searchCalls);
        useSearch = false;
        console.log(`[${userId}] [LLM] quick answer reuses ${searchCalls.length} search result set(s); search not offered again`);
      }
    }

    if (firstSentence && !superseded()) {
      stopFillers();
      ensureQueued();
      response.add('Sorry, I lost my train of thought.');
      signal();
    }
  } catch (err) {
    stopFillers();
    if (superseded()) {
      // Barge-in or a newer question: the cancel is the point, not an error.
      console.log(`[${userId}] previous question cancelled`);
    } else {
      console.error('handleQuery error:', err.message);
      // Only when nothing has been said yet. After part of an answer has
      // played, a tacked-on "I had trouble processing that." makes a merely
      // truncated answer sound like a failure.
      if (response.size === 0) {
        ensureQueued();
        response.add(err.name === 'TimeoutError'
          ? 'Sorry, that took too long to work out.'
          : 'I had trouble processing that.');
        signal();
      }
    }
  } finally {
    clearStatus();
    stopFillers();
    // MUST run on every path. The queue entry above parks on `wake`, and if
    // it is never released it blocks the global playback chain for every
    // speaker, forever.
    streamDone = true;
    signal();
    // Never queued (no sentence, or superseded first): nothing will consume it.
    if (!queued && spokenResponses.get(userId) === response) spokenResponses.delete(userId);
  }
}



// Search results from tool_call.success events, condensed for a quick-answer
// retry: each result's title and snippet (never raw page content), deduplicated,
// capped at maxChars (~1,500 tokens, ~20 s to read on this hardware).
function condenseSearchResults(calls, maxChars = 6000) {
  const seen = new Set();
  const lines = [];
  for (const { query, output } of calls) {
    let results = null;
    try {
      // Tavily via MCP: '[{"type":"text","text":"{\"results\":[...]}"}]'
      const outer = typeof output === 'string' ? JSON.parse(output) : output;
      const text = Array.isArray(outer) ? outer.map(o => (o && o.text) || '').join('') : JSON.stringify(outer);
      const inner = JSON.parse(text);
      results = Array.isArray(inner.results) ? inner.results : [];
      if (inner.answer) lines.push(`- ${inner.answer}`);
    } catch (_) {}
    if (!results) {
      lines.push(`- (${query}) ${String(output ?? '').replace(/\s+/g, ' ').slice(0, 800)}`);
      continue;
    }
    for (const r of results) {
      const key = (r && (r.url || r.title)) || '';
      if (!r || seen.has(key)) continue;
      seen.add(key);
      const snippet = String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (snippet) lines.push(`- ${r.title || r.url}: ${snippet}`);
    }
  }
  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > maxChars) break;
    out += line + '\n';
  }
  return out.trim();
}

// Where a searched answer's time goes: one line per tool call, and per long
// read of a prompt or of tool results (~90 tokens/s on this hardware).
function logLLMPhase(userId, e, phase) {
  if (e.type === 'tool_call.arguments') {
    console.log(`[${userId}] [LLM] tool: ${e.tool} ${JSON.stringify(e.arguments || {}).slice(0, 160)}`);
  } else if (e.type === 'prompt_processing.start') {
    phase.readingAt = Date.now();
  } else if (e.type === 'prompt_processing.end' && phase.readingAt) {
    const ms = Date.now() - phase.readingAt;
    phase.readingAt = 0;
    if (ms >= 2000) console.log(`[${userId}] [LLM] read prompt/results in ${(ms / 1000).toFixed(1)}s`);
  }
}

// One line per answer from LM Studio's own accounting: what is needed to tell
// whether a slow answer was spent reasoning, prefilling a long prompt
// (conversation memory, stored web-search results) or just generating slowly.
function logLLMStats(userId, stats) {
  if (!stats) return;
  const n = v => (typeof v === 'number' ? v.toLocaleString('en-US') : '?');
  const f = v => (typeof v === 'number' ? v.toFixed(1) : '?');
  const turn = (conversations.get(userId)?.turns || 0) + 1;
  console.log(
    `[${userId}] [LLM] stats: memory turn ${turn}, prompt ${n(stats.input_tokens)} tokens, ` +
    `reasoning ${n(stats.reasoning_output_tokens)}, output ${n(stats.total_output_tokens)}, ` +
    `first token ${f(stats.time_to_first_token_seconds)}s, ${f(stats.tokens_per_second)} tok/s`
  );
}

// ─── LLM streaming ───────────────────────────────────────────────────────────
//
// Yields complete sentences as the LLM generates them.
//
// Strategy:
//   1. Try LM Studio's responses API with stream:true (SSE).
//      If it returns SSE data: lines, yield sentences as they arrive.
//   2. If the response is plain JSON (LM Studio ignoring stream:true),
//      fall back to parsing it as a normal response and chunking into
//      sentences ourselves — still faster than the old single speakResponse call.

// `reasoning` overrides LLM_REASONING for this request; aborting `signal`
// cancels it (thinking limit, barge-in, supersede).
async function* getLMStudioResponseStreaming(text, userId, useSearch = offerSearch(text),
                                             { reasoning = LLM_REASONING, signal = null, onEvent = null,
                                               context = '', extraSystem = '' } = {}) {
  const body = {
    model: lmStudioModel,
    input: context ? `${text}\n\n${context}` : text,
    stream: true,
    ...(useSearch && { integrations: [searchIntegration()] }),
  };

  // Sent on EVERY request, not only the first of a chain.
  //
  // LM Studio stores the thread server-side, so in principle a system prompt
  // set on turn 1 persists through previous_response_id. In practice
  // instruction adherence decays as the prompt recedes behind a growing
  // conversation, and nothing here can observe whether the stored thread still
  // carries it. Re-sending costs a few tokens of prefill and removes the doubt.
    // Personality lines are injected probabilistically, not written into the
  // base prompt.
  //
  // A model cannot follow "occasionally do X". Every turn is evaluated
  // independently, with no memory of how often it has already done it, so
  // "occasionally" reliably becomes "every single time". Deciding here — and
  // simply omitting the line most of the time — is the only way to get a rate
  // that is actually a rate.
  const flavor = LM_FLAVOR_PROMPT && Math.random() < LM_FLAVOR_CHANCE ? LM_FLAVOR_PROMPT : '';
  // Audio-tag instruction only while an expressive TTS (ElevenLabs v3/v4) is
  // the one speaking; empty for Kokoro, so it is never told to use tags.
  const expressive = expressivePrompt();
  body.system_prompt = systemPrompt({ config, timeZone: LUNA_TIMEZONE, expressive,
    search: useSearch && ANNOUNCE_SEARCH, extra: extraSystem, flavor });

  const priorId = getConversationId(userId);
  if (priorId) body.previous_response_id = priorId;

  // Idle timeout: aborts only when LM Studio has sent nothing at all for
  // LM_IDLE_TIMEOUT_MS. Every chunk received — reasoning, tool calls, tokens —
  // pushes it back. LM_TIMEOUT_MS remains as an overall backstop.
  const idle = new AbortController();
  let idleTimer = null;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(new DOMException(
      `LM Studio sent nothing for ${LM_IDLE_TIMEOUT_MS / 1000}s`, 'TimeoutError')), LM_IDLE_TIMEOUT_MS);
  };
  const requestSignal = AbortSignal.any([idle.signal, AbortSignal.timeout(LM_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  if (reasoning) body.reasoning = reasoning;

  try {
    let res;
    let retriedModel = false;
    let retriedConversation = false;
    let retriedWithoutSearch = false;
    for (;;) {
      body.model = lmStudioModel;
      console.log(`[LLM] POST ${LM_STUDIO_URL} model=${lmStudioModel} stream=true useSearch=${useSearch} reasoning=${reasoning || 'default'}`);
      resetIdle();
      res = await fetch(LM_STUDIO_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.LM_STUDIO_MCP_BEARER_TOKEN}`,
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
      if (res.ok) break;

      const errText = await res.text();

      // The search server is unreachable (LM Studio rejects the whole request,
      // not just the search). Answer without it and pause search.
      if (!retriedWithoutSearch && body.integrations && /MCP server|plugin|integration/i.test(errText)) {
        retriedWithoutSearch = true;
        pauseSearch(`search server unavailable (${errText.replace(/\s+/g, ' ').slice(0, 120)})`);
        delete body.integrations;
        body.system_prompt = body.system_prompt.replace(' ' + SEARCH_PROMPT, '');
        useSearch = false;
        continue;
      }

      // This speaker's conversation memory no longer exists in LM Studio (it
      // was reset, its data cleared, or the stored response expired). Without
      // this the same dead id was resent on every question, and every answer
      // failed until LM_MEMORY_TTL_MS expired. Start a fresh conversation.
      if (!retriedConversation && body.previous_response_id && /previous_response_id/i.test(errText)) {
        retriedConversation = true;
        console.warn(`[${userId}] [LLM] conversation memory not found in LM Studio — starting a fresh one`);
        conversations.delete(userId);
        delete body.previous_response_id;
        continue;
      }

      // Otherwise a 4xx is most often a model that was switched or unloaded in
      // LM Studio since startup. Look it up again and retry once.
      if (!retriedModel && res.status >= 400 && res.status < 500) {
        retriedModel = true;
        const previous = lmStudioModel;
        if (await resolveModel({ fatal: false }) && lmStudioModel !== previous) {
          console.warn(`[LLM] ${res.status} from LM Studio — model changed, retrying with ${lmStudioModel}`);
          continue;
        }
      }
      throw new Error(`LM Studio ${res.status}: ${errText}`);
    }

    const contentType = res.headers.get('content-type') || '';

    // ── Path A: SSE streaming ─────────────────────────────────────────────────
    if (contentType.includes('text/event-stream')) {
      let buffer     = '';
      let sseBuffer  = '';
      let responseId = null;
      const reader   = res.body.getReader();
      const decoder  = new TextDecoder();

      // Terminal-event handling is load-bearing, not cosmetic.
      //
      // This loop previously ran `while (true)` and treated `data: [DONE]` as a
      // line to skip. If LM Studio finishes the response but does NOT close the
      // HTTP stream, `reader.read()` blocks forever: this generator never
      // returns, so handleQuery never returns, so processUtterance never
      // resolves, so `flushing` stays true — and that speaker is permanently
      // deaf with nothing logged. It presents exactly as "she answers once, then
      // stops responding".
      //
      // So: exit on the terminal markers rather than waiting for the socket.
      let finished = false;
    const phase = { readingAt: 0 };

      try {
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          resetIdle();

          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed === 'data: [DONE]') { finished = true; break; }
            if (!trimmed.startsWith('data: ')) continue;

            let parsed;
            try { parsed = JSON.parse(trimmed.slice(6)); } catch { continue; }
            if (onEvent) onEvent(parsed);
            logLLMPhase(userId, parsed, phase);

            // response_id lives inside chat.end result
            if (parsed.type === 'chat.end') {
              logLLMStats(userId, parsed.result?.stats);
              if (parsed.result?.output) {
                const msg = parsed.result.output.filter(o => o.type === 'message').pop();
                if (msg?.content) responseId = parsed.result?.response_id ?? null;
              }
              finished = true;
              break;
            }

            // A message ends at a tool call or at the end of the answer: either
            // way a sentence boundary, so text before a search is never glued
            // onto the text after it.
            if (parsed.type === 'message.end' && buffer.trim()) {
              const rest = buffer.trim();
              buffer = '';
              yield rest;
              continue;
            }

            // LM Studio SSE format: {type:'message.delta', content:'token'}
            const delta = parsed.type === 'message.delta' ? (parsed.content ?? '') : '';

            if (!delta) continue;
            buffer += delta;

            const split = takeSentences(buffer);
            buffer = split.rest;
            for (const sentence of split.sentences) yield sentence;
          }
        }
      } finally {
        // Cancel rather than only releasing the lock: if we exited on a terminal
        // marker the socket is still open, and without this it leaks until the
        // AbortSignal fires two minutes later.
        try { await reader.cancel(); } catch (_) {}
        try { reader.releaseLock(); } catch (_) {}
      }

      const remainder = buffer.trim();
      if (remainder) yield remainder;
      rememberConversation(userId, responseId);

    // ── Path B: Plain JSON fallback (responses API without true streaming) ─────
    } else {
      console.log('[LLM] Non-streaming JSON mode (unexpected — LM Studio ignored stream:true)');
      // No progress to observe while the whole body arrives; rely on the
      // overall LM_TIMEOUT_MS alone.
      clearTimeout(idleTimer);
      const data = await res.json();

      logLLMStats(userId, data.stats);
      rememberConversation(userId, data.response_id);

      // Extract full reply text from responses API format
      const messageItem = data.output?.filter(o => o.type === 'message').pop();
      const fullText    = messageItem?.content?.trim();

      if (!fullText) {
        console.error('[LLM] No content found in response:', JSON.stringify(data).slice(0, 300));
        throw new Error('No message content in LLM response');
      }

      // Split into sentences and yield each one so TTS starts immediately
      const split = takeSentences(fullText);
      for (const sentence of split.sentences) yield sentence;
      if (split.rest.trim()) yield split.rest.trim();
    }
  } finally {
    clearTimeout(idleTimer);
  }
}

// ─── TTS: fetch and play (split for prefetch pipeline) ──────────────────────
//
// fetchTTS()  — (tts.js) starts synthesis on the configured provider and
//               returns a readable audio stream, falling back between providers.
//               Called as soon as a sentence is ready, even while a previous
//               sentence is still playing, so audio is ready with zero wait.
//
// playTTS()   — subscribes the stream to the Discord player and awaits completion.
//               Called by the playback queue in order.

async function playTTS(passThrough, connection) {
  try {
    const player   = createAudioPlayer();
    const resource = createAudioResource(passThrough, {
      inputType: StreamType.Arbitrary,
    });

    currentPlayer = player; // track so interruptOwnPlayback() can stop it
    connection.subscribe(player);
    player.play(resource);

    await new Promise(resolve => {
      let settled = false;

      const finish = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);              // else it fires mid-way through a LATER
                                          // sentence and nulls that player's handle
        try { player.stop(true); } catch (_) {}
        // Only release the globals if they still refer to THIS player.
        if (currentPlayer === player) currentPlayer = null;
        if (reason) console.error(`playTTS: ${reason}`);
        resolve();
      };

      const timer = setTimeout(() => finish('playback timed out after 30s'), 30000);
      player.on(AudioPlayerStatus.Idle, () => finish());
      player.on('error', err => finish(err.message));
    });
  } catch (err) {
    console.error('playTTS error:', err);
    currentPlayer = null;
  }
}

client.on(Events.Error, console.warn);

// ─── Join greetings ───────────────────────────────────────────────────────────

const lastGreetedAt = new Map(); // userId -> ms timestamp of their last greeting

// {name} is filled in by fillPhrase(). Overridable with GREET_PHRASES.
const GREETINGS = GREET_PHRASES.length ? GREET_PHRASES : [
  '{name} just joined. Hey {name}!',
  "Look who's here, it's {name}. Hi there!",
  '{name} has joined the channel. Hello, {name}!',
  'Heads up, {name} is here. Welcome in, {name}!',
];

// A shuffled copy (Fisher–Yates; sorting on a random comparator is biased).
function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// A random phrase from `phrases` with every {key} in `vars` replaced.
function fillPhrase(phrases, vars) {
  let text = phrases[Math.floor(Math.random() * phrases.length)];
  for (const [key, value] of Object.entries(vars)) text = text.replaceAll(`{${key}}`, value);
  return text;
}

// Turns a display name into something Kokoro can say.
//
// NFKC folds "fancy font" names (𝓢𝓪𝓶, Ｓａｍ) back to plain letters. Emoji and
// symbols are dropped rather than read aloud, separators become spaces, and a
// trailing number tag ("sam_1234") is removed when there is a name before it.
// Returns '' if nothing pronounceable is left.
function speakableName(raw) {
  let name = (raw || '').normalize('NFKC')
    .replace(/[_.]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const withoutTag = name.replace(/[\s-]*\d+$/, '');
  if (/\p{L}/u.test(withoutTag)) name = withoutTag;
  return name.slice(0, 32).trim();
}

function greetMember(member, connection) {
  const now = Date.now();
  if (now - (lastGreetedAt.get(member.id) || 0) < GREET_COOLDOWN_MS) return;
  lastGreetedAt.set(member.id, now);

  const name = speakableName(member.displayName);
  const text = name
    ? fillPhrase(GREETINGS, { name })
    : 'Someone just joined. Hey there, welcome in!';
  console.log(`[greet] ${member.user.tag} joined — "${text}"`);
  announce(member, connection, text);
}

// Queued under the member's own id: if they say the wake word before the
// greeting plays, their query supersedes it (barge-in), and an announcement
// never cuts off an answer someone else is already hearing.
function announce(member, connection, text) {
  const generation = nextGeneration(member.id);
  queuePlayback(async () => {
    if (activeConnection !== connection) return; // Luna left in the meantime
    const pt = await fetchTTS(text);
    if (pt) await playTTS(pt, connection);
  }, member.id, generation);
}

// ─── Self-introduction ────────────────────────────────────────────────────────

// Overridable with INTRO_PHRASES.
const INTROS = INTRO_PHRASES.length ? INTRO_PHRASES : [
  "Hi everyone, Luna here! Just say {wake} whenever you need me.",
  "Hey all, it's Luna. Say {wake} if you want anything.",
  "Luna has arrived! Say {wake} to get my attention.",
];

const INTRO_QUEUE_ID = 'luna:intro';

// Spoken once when Luna joins, so the channel knows she is listening. Queued
// under its own id, so nobody's query can be superseded by it or supersede it
// by accident; whoever speaks first after it is simply answered next.
function introduceSelf(connection) {
  if (!ANNOUNCE_SELF) return;
  const text = fillPhrase(INTROS, { wake: WAKE_LABEL });
  console.log(`[intro] "${text}"`);
  const generation = nextGeneration(INTRO_QUEUE_ID);
  queuePlayback(async () => {
    if (activeConnection !== connection) return;
    const pt = await fetchTTS(text);
    if (pt) await playTTS(pt, connection);
  }, INTRO_QUEUE_ID, generation);
}

// ─── Leave announcements ──────────────────────────────────────────────────────

const lastFarewellAt = new Map(); // userId -> ms timestamp of their last announcement

// Overridable with FAREWELL_PHRASES.
const FAREWELLS = FAREWELL_PHRASES.length ? FAREWELL_PHRASES : [
  '{name} just left. See you later, {name}!',
  '{name} has left the channel.',
  '{name} headed out. Bye, {name}!',
  'And {name} is gone. Catch you next time!',
];

function announceLeave(member, connection) {
  const now = Date.now();
  if (now - (lastFarewellAt.get(member.id) || 0) < LEAVE_COOLDOWN_MS) return;
  lastFarewellAt.set(member.id, now);

  const name = speakableName(member.displayName);
  const text = name
    ? fillPhrase(FAREWELLS, { name })
    : 'Someone just left the channel.';
  console.log(`[farewell] ${member.user.tag} left — "${text}"`);

  // Also supersedes anything still queued for the leaver — an unplayed
  // greeting, or the rest of an answer nobody is there to hear.
  announce(member, connection, text);
}

// Someone left Luna's channel — disconnected from voice, or moved to another
// channel. If they were the last real user, the disconnect handler below
// tears the connection down, and the activeConnection check skips this.
function onVoiceLeave(oldState, newState) {
  if (!ANNOUNCE_LEAVE || !activeVoiceChannel || !activeConnection) return;
  if (oldState.channelId !== activeVoiceChannel.id) return;
  if (oldState.channelId === newState.channelId) return;

  const member = oldState.member;
  if (!member || member.user.bot || IGNORED_USERS.has(member.id)) return;

  const connection = activeConnection;
  setTimeout(() => {
    if (activeConnection !== connection) return;
    if (member.voice.channelId === activeVoiceChannel?.id) return; // came back
    announceLeave(member, connection);
  }, LEAVE_DELAY_MS);
}

// Someone arrived in Luna's channel — from outside voice, or moved in from
// another channel. Mute/deafen/stream toggles also emit VoiceStateUpdate but
// keep the same channelId, so they never match.
function onVoiceJoin(oldState, newState) {
  if (!GREET_ON_JOIN || !activeVoiceChannel || !activeConnection) return;
  if (newState.channelId !== activeVoiceChannel.id) return;
  if (oldState.channelId === newState.channelId) return;

  const member = newState.member;
  if (!member || member.user.bot || IGNORED_USERS.has(member.id)) return;

  const connection = activeConnection;
  setTimeout(() => {
    if (activeConnection !== connection) return;
    if (member.voice.channelId !== activeVoiceChannel?.id) return; // left again
    greetMember(member, connection);
  }, GREET_DELAY_MS);
}

// Tracks Luna being moved, announces joins and leaves, and disconnects when the
// last real user (non-bot, non-ignored) leaves.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  // Luna herself was dragged to another channel by someone. (A kick or a lost
  // connection is handled by watchConnection; !luna updates this itself.)
  if (newState.id === client.user.id) {
    if (activeConnection && newState.channelId && newState.channelId !== activeVoiceChannel?.id) {
      activeVoiceChannel = newState.channel;
      console.log(`[voice] moved to ${activeVoiceChannel.name}`);
      if (getRealMemberCount(activeVoiceChannel) === 0) leaveVoice('Moved into an empty channel');
    }
    return;
  }

  onVoiceJoin(oldState, newState);
  onVoiceLeave(oldState, newState);

  if (!activeVoiceChannel || oldState.channelId !== activeVoiceChannel.id) return;
  if (getRealMemberCount(activeVoiceChannel) === 0) leaveVoice('Last real user left');
});

void client.login(config.DISCORD_TOKEN || undefined);
