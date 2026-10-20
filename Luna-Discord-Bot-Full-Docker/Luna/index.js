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
const http = require('http');
const { WakeWordEngine } = require('./wakeword');
const { createMcpServer } = require('./mcp-server');
const { createTextChat, SAY_MAX_CHARS } = require('./text-chat');
const { route, sendSmakbotCommand: postSmakbotCommand, LEAVE_PHRASES } = require('./commands');
const { LLM_TOOLS, LLM_TOOL_NAMES } = require('./llm-tools');
const { fetchTTS, fetchTTSInVoice, checkElevenLabsVoice, describeTTS, expressivePrompt } = require('./tts');
const { loadCustomGreetings } = require('./greetings');
const { createAnswerFilter } = require('./answer-filter');
const { loadConfig, parseWaits } = require('./config');
const { QUICK_PROMPT } = require('./prompt');
const { createLlm, condenseSearchResults, TOOLS_PLUGIN_ID } = require('./answer-llm');
const {
  isBareWake, createPacketDecoder, createWakeFeeder, createSegmenter,
  decideWake, decideUtteranceEnd, confirmWake, decideSilentSpeaker,
} = require('./voice-input');

// ─── Config ───────────────────────────────────────────────────────────────────

// Every setting, parsed and checked in one place (config.js).
const config = loadConfig(process.env, { warn: message => console.warn(message) });

// Talking to LM Studio: model, prompt, memory, search and tool offers (answer-llm.js).
const llm = createLlm({ config, fetch, console, expressivePrompt });

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
// A bare "hey Luna" (nothing followed, even after WAKE_LISTEN_MS): she asks
// what they wanted (WAKE_REPROMPT_PHRASES) instead of answering a greeting,
// then that speaker has WAKE_FOLLOWUP_MS after she finishes to start the
// question, without the wake word. 0 answers the greeting, as before.
const WAKE_FOLLOWUP_MS = config.WAKE_FOLLOWUP_MS;
const REPROMPTS = config.WAKE_REPROMPT_PHRASES.length ? config.WAKE_REPROMPT_PHRASES : [
  "Hey {name}, I didn't catch that. Did you mean to ask me something?",
  "Sorry {name}, I missed that. What did you want to ask?",
  "Hey, I didn't catch that. Did you mean to ask me something?",
];
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
// like the two above, with {wake} for the wake phrase and {names} for the
// people in the channel ("smakus, joel, and kenbeans") instead of {name}.
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
// Resolved against this file, not the working directory, so `node Luna/index.js`
// from elsewhere still finds it.
const CHIME_PATH = path.join(__dirname, 'chime.mp3');

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

// Thinking limit. The LLM's own timeouts (answer-llm.js) can't catch a model
// that keeps reasoning: reasoning streams, so the request is never idle. One question spent over
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
const STUCK_FLUSH_MS = WHISPER_TIMEOUT_MS + config.LM_TIMEOUT_MS + 60000;

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
  if (!await llm.resolveModel()) process.exit(1);
  await initWakeWord();
  console.log(`[tts] ${describeTTS()}`);
  describeCustomGreetings();
  console.log(`[search] web search: ${llm.describeSearch()}`);
  if (LLM_TOOLS_ON) startLlmTools();
  ready = true;
  checkAutoJoin();
  scheduleAutoJoin();
  console.log(`Ready! Wake phrase: "${WAKE_LABEL}"  •  text command: ${BOT_COMMAND}`);
});

// ─── Voice join ───────────────────────────────────────────────────────────────

let activeConnection   = null;
let activeVoiceChannel = null;
let activeTextChannel  = null;   // where !luna was typed; music commands go here
let activeGuild        = null;   // { id, adapterCreator }, for reconnecting
const listeningUsers   = new Set();

client.on(Events.MessageCreate, async message => {
  if (textChat.onMessage(message)) return;
  if (message.content.toLowerCase().trim() === `${BOT_COMMAND} voicecheck`) return voiceCheck(message);
  // "!luna say <text>": exactly those words, out loud, no LLM.
  const sayMatch = message.content.trim().match(new RegExp(`^${BOT_COMMAND}\\s+say\\s+([\\s\\S]+)$`, 'i'));
  if (sayMatch && !message.author?.bot) {
    const who = message.member?.displayName || message.author?.username || 'someone';
    if (!sayInVoice(sayMatch[1], message.author?.id || 'text', who)) {
      message.reply("I'm not in a voice channel.").catch(() => {});
    } else {
      message.react('🔊').catch(() => {});
    }
    return;
  }
  if (message.content.toLowerCase().trim() === `${BOT_COMMAND} leave`) {
    if (!activeConnection) return message.reply("I'm not in a voice channel.").catch(() => {});
    message.reply('Bye!').catch(() => {});
    return leaveOnRequest(message.author?.id);
  }
  if (message.content.toLowerCase().trim() !== BOT_COMMAND) return;
  // .catch: a rejected reply (e.g. no send permission) in an async listener is
  // an unhandled rejection, which terminates Node.
  if (!ready) return message.reply('Still starting up — try again in a few seconds.').catch(() => {});

  const channel = message.member?.voice?.channel;
  if (!channel) return message.reply('You need to join a voice channel first!').catch(() => {});

  autoJoinPaused = false;   // asked to join: auto-join may follow people again
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
  if (!since || !activeConnection) return;
  // Timers can fire a millisecond early. Returning then left the speaker in
  // silentSpeakers, so noteSpeaking never scheduled another check and
  // recovery for them silently never ran: check again when it is time.
  const early = VOICE_RECOVER_MS - (Date.now() - since);
  if (early > 0) { setTimeout(() => checkSilentSpeaker(userId), early + 1); return; }
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
  llm.forgetConversations();
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
  let followUpUntil  = 0;       // after "did you mean to ask me something?": answer without the wake word until then

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
    expectQuestion(ms) { followUpUntil = Date.now() + ms; },
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

    // The answer to "did you mean to ask me something?": no wake word needed.
    const followUp = Date.now() < followUpUntil;
    followUpUntil = 0;
    if (followUp) {
      wakeStream?.takePeak();
      console.log(`[${userId}] the question after "did you mean to ask me something?" — no wake word needed`);
    }

    let verdict = 'detected';   // no model: every utterance goes on, and the transcript decides
    if (wakeStream && !followUp) {
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
    processUtterance(pcm, userId, connection, channel, followUp || (wakeStream ? verdict === 'detected' : false), verdict === 'candidate' && !followUp)
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

    // Only "hey Luna", even after waiting for more: ask what they wanted.
    if (WAKE_FOLLOWUP_MS > 0 && isBareWake(transcript)) {
      askForQuestion(userId, connection);
      return;
    }

    console.log(`[${userId}] Query:`, query);
    await handleQuery(query, connection, channel, t0, userId);
  } catch (err) {
    console.error(`[${userId}] Error processing utterance:`, err);
  } finally {
    processingUsers.delete(userId);
  }
}

// "Hey smakus, I didn't catch that. Did you mean to ask me something?" — then
// that speaker's next words, if they start within WAKE_FOLLOWUP_MS of her
// finishing, are taken as the question without the wake word. (Until she has
// finished, the window stays open, so an early answer still counts.)
function askForQuestion(userId, connection) {
  const name = speakableName(activeVoiceChannel?.members?.get(userId)?.displayName);
  const fitting = REPROMPTS.filter(p => p.includes('{name}') === Boolean(name));
  const text = fillPhrase(fitting.length ? fitting : REPROMPTS, { name });
  console.log(`[${userId}] only "hey Luna" — asking: "${text}"`);
  const expect = ms => captureStates.get(userId)?.expectQuestion(ms);
  expect(60000);
  const generation = interruptOwnPlayback(userId);
  queuePlayback(async () => {
    const pt = await fetchTTS(text);
    if (pt) await playTTS(pt, connection);
    expect(WAKE_FOLLOWUP_MS);
  }, userId, generation);
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

// ─── Tools for the LLM (music, leaving) ───────────────────────────────────────
//
// Besides the fixed commands below, the LLM can play, skip and stop music and
// leave the channel itself (llm-tools.js): Luna serves the tools over MCP on
// LUNA_MCP_PORT, LM Studio knows them from its mcp.json as "luna", and every
// request offers them as mcp/luna. When a call succeeds, Luna acts on it (the
// onTool handlers in handleQuery and answerInText). Offering them, and leaving
// them out while LM Studio can't reach them, is answer-llm.js's job.
const LLM_TOOLS_ON    = config.LLM_TOOLS;
const LUNA_MCP_PORT   = config.LUNA_MCP_PORT;

function startLlmTools() {
  // say_in_voice tells the model the truth about whether anything was said.
  const tools = LLM_TOOLS.map(t => t.name !== 'say_in_voice' ? t : { ...t, run: () => activeConnection
    ? `Said in ${activeVoiceChannel?.name || 'the voice channel'}.`
    : 'You are not in a voice channel, so nothing was said. Tell them that.' });
  const server = createMcpServer({ tools });
  http.createServer((req, res) => server.handle(req, res).catch(() => { try { res.writeHead(500).end(); } catch (_) {} }))
    .on('error', err => console.error(`[tools] tools server failed on port ${LUNA_MCP_PORT}: ${err.message} — LLM tools off`))
    .listen(LUNA_MCP_PORT, '0.0.0.0', () => console.log(
      `[tools] ${[...LLM_TOOL_NAMES].join(', ')} offered to the LLM as ${TOOLS_PLUGIN_ID} ` +
      `(LM Studio's mcp.json needs "luna": {"url": "http://127.0.0.1:${LUNA_MCP_PORT}/mcp"})`));
}

// ─── Leaving on request ───────────────────────────────────────────────────────

// After being asked to leave, auto-join waits until the channel has emptied
// once (or someone types !luna), so she doesn't pop straight back in.
let autoJoinPaused = false;

function leaveOnRequest(userId) {
  if (!activeConnection) return;
  const who = speakableName(activeVoiceChannel?.members?.get(userId)?.displayName) || userId;
  if (AUTO_JOIN_CHANNELS.length) autoJoinPaused = true;
  leaveVoice(`asked to leave by ${who}`);
}

// Posts a smakbot command (commands.js) in the text channel, summoning smakbot
// first if it isn't in the voice channel. Used by the fixed commands and by
// the LLM's music tools, by voice and by text.
function sendSmakbotCommand(channel, command) {
  const musicBotPresent = !!activeVoiceChannel?.members?.some(m => m.user.username.toLowerCase().includes('smakbot'));
  return postSmakbotCommand(channel, command, { musicBotPresent, console });
}

// ─── Query handler ────────────────────────────────────────────────────────────

async function handleQuery(query, connection, channel, t0 = Date.now(), userId = 'unknown') {
  const what = route(query, { voice: true });
  if (what.type === 'music') {
    // Supersede this speaker's own pending audio BEFORE the chime. A
    // VoiceConnection has exactly one subscription, and playSound() creates its
    // own player and subscribes — so an unconditional chime detaches whatever
    // sentence is mid-playback, including another speaker's.
    const musicGeneration = interruptOwnPlayback(userId);
    if (!currentPlayer) {
      playSound(CHIME_PATH, connection).catch(() => {});
    }

    await sendSmakbotCommand(channel, what.command);

    const ack = what.command.ack;
    if (ack) {
      queuePlayback(async () => {
        const pt = await fetchTTS(ack);
        if (pt) await playTTS(pt, connection);
      }, userId, musicGeneration);
    }
    return;
  }

  // "Leave", "go away", "bye": a goodbye, then out — before the LLM, like the
  // music commands. (Wordier requests reach the LLM's leave_channel tool.)
  if (what.type === 'leave') {
    const generation = interruptOwnPlayback(userId);
    const goodbye = fillPhrase(LEAVE_PHRASES, {});
    queuePlayback(async () => {
      const pt = await fetchTTS(goodbye);
      if (pt) await playTTS(pt, connection);
      leaveOnRequest(userId);
    }, userId, generation);
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
  let useSearch = llm.offerSearch(query);

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
  let reasoning     = llm.reasoning;
  let firstSentence = true;
  let reasoningRetried = false;
  // Search results seen so far (tool_call.success), so a quick-answer retry
  // can answer from them instead of searching all over again.
  const searchCalls = [];
  let context = '';
  let leaveAfterAnswer = false;   // the LLM called leave_channel

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
      if (useSearch && llm.searchPaused()) useSearch = false;
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
        drop: (kind, text) => console.log(`[${userId}] [LLM] dropped ${{
          narration: 'narration before a search',
          planning:  'its plan, written as the answer',
        }[kind] || 'reasoning that leaked into the answer'} (not spoken): ${text.slice(0, 160)}`),
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
        }
        filter.event(e);
      };
      // What the model's tool calls mean (read in answer-llm.js). A search is
      // announced and handled as a search; music and leaving are acted on.
      const onTool = t => {
        if (t.type === 'search') {
          announceSearchNow();
          filter.event({ type: 'tool_call.start' });
        } else if (t.type === 'search-result') {
          searchCalls.push({ query: t.query, output: t.output });
        } else if (t.type === 'music') {
          if (t.command) sendSmakbotCommand(channel, t.command);
        } else if (t.type === 'leave') {
          console.log(`[${userId}] [voice] the LLM called leave_channel — leaving after the reply`);
          leaveAfterAnswer = true;
        }
      };

      try {
        const extraSystem = reasoningRetried ? QUICK_PROMPT : '';
        for await (const sentence of llm.stream(query, { userId, useSearch, reasoning, signal: cancel.signal, onEvent, onTool,
                                                         context, extraSystem, speaker: config.LM_USE_NAMES ? askerName : '' })) {
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
      if (fakeToolCall && !useSearch && llm.canSearch()) {
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
    // Queued behind the answer, so she leaves once her goodbye has played.
    if (leaveAfterAnswer && !superseded()) queuePlayback(async () => leaveOnRequest(userId), userId, myGeneration);
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
      player.on(AudioPlayerStatus.Idle, () => {
        // Idle while the audio has not ended: Discord's player stops a sentence
        // when no audio has arrived for 100 ms, so the rest of it is lost.
        // That happens when TTS renders slower than playback (it was streamed
        // Chatterbox while the LLM was writing). An interruption is not this:
        // interruptOwnPlayback() lets go of currentPlayer first.
        if (currentPlayer === player && resource.playStream && !resource.playStream.readableEnded) {
          console.warn(`[audio] sentence cut short after ${(resource.playbackDuration / 1000).toFixed(1)}s — ` +
            'the audio stopped arriving in time (TTS rendering slower than playback?)');
        }
        finish();
      });
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

// Per-person greetings (greetings.js): their own phrases, in their own
// ElevenLabs voice if they have one. Same cooldown and switches as the normal
// greeting; on any problem with the custom voice, the normal greeting plays.
// GREET_ON_JOIN=regular: everyone gets the regular greeting; the file stays.
const CUSTOM_GREETINGS = GREET_ON_JOIN === 'custom'
  ? loadCustomGreetings(path.resolve(__dirname, config.GREETINGS_FILE), { warn: message => console.warn(message) })
  : new Map();

// At startup: who has one, and whether their voices exist (no credits used).
function describeCustomGreetings() {
  if (!CUSTOM_GREETINGS.size) return;
  console.log(`[greet] custom greetings for ${[...CUSTOM_GREETINGS].map(([id, g]) => g.name || id).join(', ')}`);
  for (const [id, g] of CUSTOM_GREETINGS) {
    if (!g.voice) continue;
    checkElevenLabsVoice(g.voice).then(({ name, reason }) => {
      if (!name) console.warn(`[greet] ${g.name || id}: ElevenLabs voice ${g.voice} unavailable (${reason}) — they'll get the normal greeting`);
    });
  }
}

function greetMember(member, connection) {
  const now = Date.now();
  if (now - (lastGreetedAt.get(member.id) || 0) < GREET_COOLDOWN_MS) return;
  lastGreetedAt.set(member.id, now);

  const name = speakableName(member.displayName);
  const text = name
    ? fillPhrase(GREETINGS, { name })
    : 'Someone just joined. Hey there, welcome in!';
  const custom = CUSTOM_GREETINGS.get(member.id);
  if (custom) {
    const own = fillPhrase(custom.phrases, { name: name || 'friend', user: name || 'friend' });
    console.log(`[greet] ${member.user.tag} joined — custom greeting${custom.voice ? ` in voice ${custom.voice}` : ''}: "${own}"`);
    if (!custom.voice) return announce(member, connection, own);
    return announceInVoice(member, connection, own, custom.voice, text);
  }
  console.log(`[greet] ${member.user.tag} joined — "${text}"`);
  announce(member, connection, text);
}

// Their own line in their own voice; if that voice can't be had, the normal
// greeting in the normal voice.
function announceInVoice(member, connection, text, voiceId, fallbackText) {
  const generation = nextGeneration(member.id);
  queuePlayback(async () => {
    if (activeConnection !== connection) return;
    let pt = await fetchTTSInVoice(text, voiceId);
    if (!pt) {
      console.warn(`[greet] custom voice unavailable for ${member.user.tag} — normal greeting instead`);
      pt = await fetchTTS(fallbackText);
    }
    if (pt) await playTTS(pt, connection);
  }, member.id, generation);
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

// Overridable with INTRO_PHRASES. Phrases with {names} greet everyone in the
// channel by name; the others are for an empty channel or a crowd.
const INTROS = INTRO_PHRASES.length ? INTRO_PHRASES : [
  "Hey {names}! Luna here. Just say {wake} whenever you need me.",
  "Hi {names}! It's Luna. Say {wake} if you want anything.",
  "Hello {names}, Luna has arrived! Say {wake} to get my attention.",
  "Hi everyone, Luna here! Just say {wake} whenever you need me.",
  "Hey all, it's Luna. Say {wake} if you want anything.",
  "Luna has arrived! Say {wake} to get my attention.",
];
// More people than this and a list of names gets long: "everyone" instead.
const INTRO_MAX_NAMES = 6;

// "smakus", "smakus and joel", "smakus, joel, and kenbeans".
const NAME_LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

// The speakable names of the people in the channel (not bots, not ignored
// users), or [] when there are none or too many to list.
function introNames(channel) {
  const names = [...(channel?.members?.values() ?? [])]
    .filter(m => !m.user.bot && !IGNORED_USERS.has(m.id))
    .map(m => speakableName(m.displayName))
    .filter(Boolean);
  return names.length <= INTRO_MAX_NAMES ? names : [];
}

const INTRO_QUEUE_ID = 'luna:intro';

// Spoken once when Luna joins, so the channel knows she is listening. Queued
// under its own id, so nobody's query can be superseded by it or supersede it
// by accident; whoever speaks first after it is simply answered next.
function introduceSelf(connection) {
  if (!ANNOUNCE_SELF) return;
  const names = introNames(activeVoiceChannel);
  const fitting = INTROS.filter(p => p.includes('{names}') === names.length > 0);
  const text = fillPhrase(fitting.length ? fitting : INTROS, { wake: WAKE_LABEL, names: NAME_LIST.format(names) || 'everyone' });
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
  if (GREET_ON_JOIN === 'off' || !activeVoiceChannel || !activeConnection) return;
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

  // Asked to leave: auto-join resumes once the auto-join channels have emptied.
  if (autoJoinPaused && !autoJoinChannelsOccupied()) {
    autoJoinPaused = false;
    console.log('[voice] auto-join channels empty — auto-join resumes');
  }

  // Someone joined a voice channel while Luna is in none: maybe one to
  // auto-join (scheduleAutoJoin checks).
  if (!activeConnection && newState.channelId && newState.channelId !== oldState.channelId) scheduleAutoJoin();

  if (!activeVoiceChannel || oldState.channelId !== activeVoiceChannel.id) return;
  if (getRealMemberCount(activeVoiceChannel) === 0) {
    leaveVoice('Last real user left');
    scheduleAutoJoin();   // people may be waiting in another auto-join channel
  }
});

// ─── Text chat ────────────────────────────────────────────────────────────────
//
// Typed questions in TEXT_CHAT_CHANNELS (text-chat.js).
const textChat = createTextChat({
  config, llm, console, command: BOT_COMMAND,
  botId: () => client.user.id,
  isReady: () => ready,
  inChannels: channel => named(channel, config.TEXT_CHAT_CHANNELS),
  sendCommand: sendSmakbotCommand,
  sayInVoice: (text, userId, who) => sayInVoice(text, userId, who),
  voiceChannelName: () => (activeConnection ? activeVoiceChannel?.name || 'the voice channel' : null),
});

// Speaks a line in the voice channel on someone's behalf (say_in_voice, or
// "!luna say …"). Queued like their own answer — after whatever is playing,
// superseded if they then ask something by voice — not interrupting anyone.
// Returns false when she isn't in a voice channel.
function sayInVoice(text, userId, who) {
  const connection = activeConnection;
  const line = String(text || '').trim().slice(0, SAY_MAX_CHARS);
  if (!connection || !line) return false;
  console.log(`[text] ${who} had Luna say: ${JSON.stringify(line)}`);
  const generation = userGeneration.get(userId) ?? nextGeneration(userId);
  queuePlayback(async () => {
    if (activeConnection !== connection) return;
    const pt = await fetchTTS(line);
    if (pt) await playTTS(pt, connection);
  }, userId, generation);
  return true;
}

// ─── Auto-join ────────────────────────────────────────────────────────────────
//
// AUTO_JOIN_CHANNELS: voice channels (names or IDs) Luna joins by herself when
// someone is in one and she is in no channel — at startup, or when someone
// joins. With people in several, the busiest. She posts (status messages,
// smakbot commands) in AUTO_JOIN_TEXT_CHANNEL. She still leaves when the last
// person does, and a kick is respected: she comes back only when someone next
// joins. A short delay lets someone who pops in and straight out not summon her.
const AUTO_JOIN_CHANNELS     = config.AUTO_JOIN_CHANNELS;
const AUTO_JOIN_TEXT_CHANNEL = config.AUTO_JOIN_TEXT_CHANNEL;
const AUTO_JOIN_DELAY_MS     = 2000;
let autoJoinTimer = null;
let autoJoiningUntil = 0;   // a join in progress (not Ready yet): don't start another

const named = (channel, wanted) => wanted.some(w => w === channel.id || w.toLowerCase() === String(channel.name).toLowerCase());
const guildChannels = guild => [...(guild.channels?.cache?.values() ?? [])];
const textChannelFor = guild => AUTO_JOIN_TEXT_CHANNEL
  ? guildChannels(guild).find(c => !c.isVoiceBased?.() && c.isTextBased?.() && named(c, [AUTO_JOIN_TEXT_CHANNEL])) : null;

// At startup: say which settings match nothing, and what does exist.
function checkAutoJoin() {
  if (!AUTO_JOIN_CHANNELS.length) return;
  const guilds = [...(client.guilds?.cache?.values() ?? [])];
  const all = guilds.flatMap(guildChannels);
  const voices = all.filter(c => c.isVoiceBased?.()), texts = all.filter(c => !c.isVoiceBased?.() && c.isTextBased?.());
  const missing = AUTO_JOIN_CHANNELS.filter(w => !voices.some(c => named(c, [w])));
  if (missing.length) console.warn(`[voice] AUTO_JOIN_CHANNELS: no voice channel ${missing.map(m => `"${m}"`).join(', ')} — ` +
    `voice channels: ${voices.map(c => c.name).join(', ') || 'none'}`);
  if (!guilds.some(textChannelFor)) console.warn(`[voice] AUTO_JOIN_TEXT_CHANNEL ${AUTO_JOIN_TEXT_CHANNEL ? `"${AUTO_JOIN_TEXT_CHANNEL}" not found` : 'not set'} — ` +
    `she will post in the voice channel's own chat. Text channels: ${texts.map(c => c.name).join(', ') || 'none'}`);
  console.log(`[voice] auto-join: ${AUTO_JOIN_CHANNELS.join(', ')}`);
}

function autoJoinChannelsOccupied() {
  return [...(client.guilds?.cache?.values() ?? [])].some(guild => guildChannels(guild)
    .some(c => c.isVoiceBased?.() && named(c, AUTO_JOIN_CHANNELS) && getRealMemberCount(c) > 0));
}

function scheduleAutoJoin() {
  if (!AUTO_JOIN_CHANNELS.length) return;
  clearTimeout(autoJoinTimer);
  autoJoinTimer = setTimeout(autoJoin, AUTO_JOIN_DELAY_MS);
}

function autoJoin() {
  if (!ready || activeConnection || autoJoinPaused || Date.now() < autoJoiningUntil) return;
  const candidates = [...(client.guilds?.cache?.values() ?? [])].flatMap(guild => guildChannels(guild)
    .filter(c => c.isVoiceBased?.() && named(c, AUTO_JOIN_CHANNELS))
    .map(channel => ({ guild, channel, people: getRealMemberCount(channel) })))
    .filter(c => c.people > 0)
    .sort((a, b) => b.people - a.people);
  if (!candidates.length) return;
  const { guild, channel, people } = candidates[0];
  const g = { id: guild.id, adapterCreator: guild.voiceAdapterCreator };
  console.log(`[voice] auto-joining ${channel.name} (${people} ${people === 1 ? 'person' : 'people'} there)`);
  autoJoiningUntil = Date.now() + 15000;
  const connection = joinVoice(channel, g);
  attachVoice(connection, channel, textChannelFor(guild) || channel, g, () => { autoJoiningUntil = 0; introduceSelf(connection); });
}

void client.login(config.DISCORD_TOKEN || undefined);
