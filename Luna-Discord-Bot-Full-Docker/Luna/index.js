require('dotenv').config();

const {
  joinVoiceChannel, createAudioResource, StreamType,
  AudioPlayerStatus, VoiceConnectionStatus, createAudioPlayer,
  EndBehaviorType,
} = require('@discordjs/voice');
const { GatewayIntentBits } = require('discord-api-types/v10');
const { Events, Client } = require('discord.js');
const prism = require('prism-media');
const { PassThrough } = require('stream');
const path = require('path');
const { WakeWordEngine } = require('./wakeword');

// ─── Config ───────────────────────────────────────────────────────────────────

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
// The trailing \b is load-bearing: without it "lunar eclipse" matches and gets
// mangled into "eclipse".
const WAKE_RE = /^\s*(?:hey|hay|hi)?[\s,.]*(?:luna|loona|runa|roona)\b[\s,.]*/i;

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

const OWW_ENABLED   = (process.env.OWW_ENABLED ?? 'true').toLowerCase() !== 'false';
const OWW_MODEL     = process.env.OWW_MODEL_PATH     || path.join(__dirname, 'hey_luna.onnx');
const OWW_MELSPEC   = process.env.OWW_MELSPEC_PATH   || path.join(__dirname, 'melspectrogram.onnx');
const OWW_EMBEDDING = process.env.OWW_EMBEDDING_PATH || path.join(__dirname, 'embedding_model.onnx');
const OWW_THRESHOLD = parseFloat(process.env.OWW_THRESHOLD || '0.5');
const OWW_TRIGGER_FRAMES = parseInt(process.env.OWW_TRIGGER_FRAMES || '1', 10);
const OWW_REFRACTORY_MS  = parseInt(process.env.OWW_REFRACTORY_MS  || '1500', 10);
const OWW_FEATURE_FRAMES = parseInt(process.env.OWW_FEATURE_FRAMES || '0', 10);
// How far before an utterance's first speech a detection may land and still
// count for that utterance. Covers the gap between the wake word finishing and
// the energy gate opening.
const OWW_GRACE_MS = parseInt(process.env.OWW_GRACE_MS || '2000', 10);
// Log every score above this value — useful for tuning OWW_THRESHOLD.
const OWW_DEBUG_SCORE = parseFloat(process.env.OWW_DEBUG_SCORE || '0');
// 'auto' normalises quiet speech up toward a target level before detection,
// 'off' disables it, or give a fixed multiplier like '3'. Detection input only —
// the audio sent to Whisper is untouched. Never attenuates, so it cannot make a
// already-working setup worse.
const OWW_GAIN = process.env.OWW_GAIN || 'auto';

let wakeEngine = null; // set during ClientReady; null means fall back to transcript matching

const IGNORED_USERS = new Set(
  (process.env.IGNORED_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean)
);

const WHISPER_SERVER_URLS = (process.env.WHISPER_SERVER_URLS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
let whisperRR = 0;
function nextWhisperUrl() {
  const url = WHISPER_SERVER_URLS[whisperRR % WHISPER_SERVER_URLS.length];
  whisperRR++;
  return url;
}
const LM_STUDIO_URL = process.env.LM_STUDIO_URL;
const LM_SYSTEM_PROMPT =
  'You are Luna, a helpful voice assistant in a Discord voice channel. ' +
  'The user addresses you by saying "hey Luna" at the start of their message. ' +
  'This prefix is usually stripped before the message reaches you, but may ' +
  'sometimes remain — either way, ignore it and respond only to the rest. ' +
  'Keep responses concise and ' +
  'conversational — no markdown, no bullet points, no emojis, just natural spoken ' +
  'sentences. Do not ask follow-up questions unless necessary for data. You have ' +
  'access to the internet via a web search tool and should use it whenever asked ' +
  'about current events, prices, weather, news, scores, or anything time-sensitive.';

const KOKORO_URL   = process.env.KOKORO_URL;
const KOKORO_VOICE = process.env.KOKORO_VOICE;

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
const LM_MEMORY_TTL_MS    = parseInt(process.env.LM_MEMORY_TTL_MS    || '600000', 10);
const LM_MEMORY_MAX_TURNS = parseInt(process.env.LM_MEMORY_MAX_TURNS || '12',     10);

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
const SILENCE_MS       = parseInt(process.env.SILENCE_MS       || '1000', 10);
const ENERGY_THRESHOLD = parseInt(process.env.ENERGY_THRESHOLD || '300',  10);
const MIN_SPEECH_MS    = parseInt(process.env.MIN_SPEECH_MS    || '300',  10);

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
const PREROLL_MS     = parseInt(process.env.PREROLL_MS || '320', 10);
const PREROLL_CHUNKS = Math.max(0, Math.round(PREROLL_MS / 20));

// Hard cap on a single buffered utterance. `flushing` stays true for the whole
// LLM + TTS response, during which flushUtterance() early-returns while the
// decoder keeps appending — without this cap, speechChunks grows for the entire
// duration of Luna's reply (~2.9 MB per 30 s per speaker).
// Request timeouts. Without these a hung Whisper or LM Studio call never
// settles, `flushing` stays true forever, and that speaker goes permanently
// deaf with nothing logged. Generous, because a saturated CPU makes Whisper
// genuinely slow — these are for hangs, not slowness.
const WHISPER_TIMEOUT_MS = parseInt(process.env.WHISPER_TIMEOUT_MS || '60000', 10);
const LM_TIMEOUT_MS      = parseInt(process.env.LM_TIMEOUT_MS      || '120000', 10);
// Kokoro's is the most important of the three: its result is awaited INSIDE the
// shared playback chain, so a hang here blocks audio for every speaker.
const KOKORO_TIMEOUT_MS  = parseInt(process.env.KOKORO_TIMEOUT_MS  || '30000',  10);

// Backstop if something still wedges despite the timeouts above.
const STUCK_FLUSH_MS = 180000;

const MAX_UTTERANCE_MS    = 30000;
const DECODER_CHUNK_MS    = 20; // 960 samples @ 48 kHz
const MAX_UTTERANCE_CHUNKS = MAX_UTTERANCE_MS / DECODER_CHUNK_MS;

// Longest a single stretch of speech may run without a silence gap before it is
// flushed anyway.
//
// An utterance normally ends after SILENCE_MS of audio below ENERGY_THRESHOLD.
// If the threshold sits below the room's noise floor — or Luna's own voice
// returns through a speaker into the mic — hasEnergy() is true on every frame,
// the silence timer is reset on every frame, and the utterance never ends. That
// speaker then buffers audio forever and is never heard again.
const MAX_SPEECH_MS = parseInt(process.env.MAX_SPEECH_MS || '15000', 10);

// Discord stops transmitting Opus during silence, so two consecutive packets
// can be seconds apart in wall-clock time while being adjacent in the sample
// stream. The detector then sees the gap spliced out — "hey ... Luna" spoken
// with a natural pause arrives as a compressed "heyLuna" that matches nothing
// the model was trained on. Re-inserting real silence keeps the feature
// timeline aligned with how the phrase was actually spoken.
//
// Capped because the classifier window is only 1.28 s; beyond that the window
// is fully flushed anyway and further silence is wasted inference.
const MAX_SILENCE_FILL_MS = parseInt(process.env.MAX_SILENCE_FILL_MS || '2000', 10);

// Sentence boundary regex — triggers TTS as soon as a sentence is complete
// rather than waiting for the full LLM response.
// The lookbehinds suppress false sentence breaks:
//   (?<!\d)      — decimals, e.g. "$403.80"
//   (?<!\b[A-Z]) — single-letter initials, e.g. "George W. Bush", which would
//                  otherwise make TTS pause mid-name
// Multi-letter abbreviations ("Mr.", "etc.") still split; add them here if they
// become audible in practice.
const SENTENCE_END = /(?<!\d)(?<!\b[A-Z])[.!?](?!\d)[\s"')\]]*(?:\s|$)/;

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

async function resolveModel() {
  try {
    const res = await fetch(
      LM_STUDIO_URL.replace('/api/v1/chat', '/api/v1/models'),
      { headers: { 'Authorization': `Bearer ${process.env.LM_STUDIO_MCP_BEARER_TOKEN}` } }
    );
    const data = await res.json();
    const loaded = data?.models?.find(m => m.type === 'llm' && m.loaded_instances?.length > 0);
    if (!loaded) throw new Error('No models loaded');
    lmStudioModel = loaded.loaded_instances[0].id;
    console.log(`Using LM Studio model: ${lmStudioModel}`);
  } catch (err) {
    console.error('Failed to resolve LM Studio model:', err.message);
    process.exit(1);
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
    console.log(`[oww] active — threshold=${OWW_THRESHOLD}, Whisper gated on detection`);
  } catch (err) {
    console.warn(`[oww] unavailable (${err.message})`);
    console.warn('[oww] falling back to transcript wake word matching');
    wakeEngine = null;
  }
}

client.on(Events.ClientReady, async () => {
  await resolveModel();
  await initWakeWord();
  console.log(`Ready! Wake phrase: "${WAKE_LABEL}"  •  text command: ${BOT_COMMAND}`);
});

// ─── Voice join ───────────────────────────────────────────────────────────────

let activeConnection   = null;
let activeVoiceChannel = null;
const listeningUsers   = new Set();

client.on(Events.MessageCreate, async message => {
  if (message.content.toLowerCase().trim() === BOT_COMMAND) {
    const channel = message.member?.voice?.channel;
    if (!channel) return message.reply('You need to join a voice channel first!');

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      message.reply(
        `Joined **${channel.name}**! Say "${WAKE_LABEL}" to wake me up. ` +
        `Also, you can say "${WAKE_LABEL}, play song ___" to play music.`
      );
      activeConnection   = connection;
      activeVoiceChannel = channel;
      startListening(connection, message.channel);

      // Subscribe to users already in the channel at join time
      channel.members.forEach(member => {
        if (member.user.bot)               return;
        if (IGNORED_USERS.has(member.id))  return;
        if (listeningUsers.has(member.id)) return;
        listeningUsers.add(member.id);
        continuousCapture(connection, member.id, message.channel);
      });
    });
  }
});

// ─── Core listening loop ──────────────────────────────────────────────────────

function getRealMemberCount(voiceChannel) {
  if (!voiceChannel) return 0;
  return voiceChannel.members.filter(m => !m.user.bot && !IGNORED_USERS.has(m.id)).size;
}

function startListening(connection, channel) {
  connection.receiver.speaking.on('start', userId => {
    if (listeningUsers.has(userId))   return;
    if (userId === client.user.id)    return; // ignore bot's own audio
    if (IGNORED_USERS.has(userId))    return; // ignore configured bots/users
    listeningUsers.add(userId);
    continuousCapture(connection, userId, channel);
  });
}

function hasEnergy(chunk) {
  let sum = 0;
  for (let i = 0; i < chunk.length - 1; i += 2) {
    sum += Math.abs(chunk.readInt16LE(i));
  }
  return (sum / (chunk.length / 2)) > ENERGY_THRESHOLD;
}

// Live view of every active capture, for the health heartbeat below.
const captureStates = new Map();

// Every 30 s, report enough per-speaker state to tell apart the three ways this
// can silently stop working: audio stopped arriving, the detector wedged, or
// `flushing` got stuck holding the gate shut.
setInterval(() => {
  if (captureStates.size === 0) return;

  const now = Date.now();
  const parts = [];
  for (const [uid, s] of captureStates) {
    const ws = s.wakeStream;
    parts.push(
      `${uid.slice(-5)}[` +
      `audio ${((now - s.lastData) / 1000).toFixed(0)}s ago, ` +
      `frames ${ws ? ws.chunksProcessed : 'n/a'}, ` +
      `peak30s ${ws ? ws.takeHealthPeak().toFixed(3) : 'n/a'}, ` +
      `qdepth ${ws ? ws.queueDepth : 'n/a'}, ` +
      `flushing ${s.flushing}, ` +
      `buffered ${s.buffered}]`
    );
  }
  console.log('[health] ' + parts.join(' '));
}, 30000).unref?.();

function continuousCapture(connection, userId, channel) {
  console.log(`[${userId}] capture started`);
  const audioStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 60000 },
  });

  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 });
  audioStream.setMaxListeners(20);
  audioStream.pipe(decoder);
  decoder.on('error', () => {}); // ignore corrupted Opus packets
  
  let speechChunks = [];
  // Ring of sub-threshold frames immediately preceding speech; prepended to the
  // utterance when the energy gate opens so word onsets are not clipped.
  let preroll      = [];
  let prerollMs    = 0;   // how much of the current utterance is pre-roll
  let silenceTimer = null;
  let speaking       = false;
  let flushing       = false;
  let flushStartedAt = 0;
  let lastDataTime   = Date.now();

  // ── openWakeWord state for this user ───────────────────────────────────────
  // Each speaker needs an independent feature pipeline — sharing one buffer
  // across users would interleave their audio and corrupt every detection.
  let lastWakeAt      = 0;
  let speechStartedAt = 0;

  const wakeStream = wakeEngine
    ? wakeEngine.createStream({
        threshold:     OWW_THRESHOLD,
        triggerFrames: OWW_TRIGGER_FRAMES,
        refractoryMs:  OWW_REFRACTORY_MS,
        gain:          OWW_GAIN,
        label:         userId,
        onDetect: (score, at) => {
          lastWakeAt = at;
          console.log(`[${userId}] [oww] wake word detected (score=${score.toFixed(3)})`);
        },
      })
    : null;

  captureStates.set(userId, {
    wakeStream,
    get flushing() { return flushing; },
    get buffered() { return speechChunks.length; },
    get lastData() { return lastDataTime; },
  });

  let blockedWarnAt = 0;

  function flushUtterance() {
    silenceTimer = null;

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

    if (speechChunks.length === 0) return;
    flushing = true;
    flushStartedAt = Date.now();
    const pcm = Buffer.concat(speechChunks);
    speechChunks = [];
    speaking     = false;

    // Consume the detection up front. Every exit path below must leave
    // lastWakeAt disarmed, otherwise a detection that was dropped by an early
    // return stays armed and silently validates a later, wake-word-free
    // utterance.
    const wakeAt = lastWakeAt;
    lastWakeAt = 0;

    const durationMs = (pcm.length / 2 / 48000) * 1000;

    // Measure the MIN_SPEECH_MS gate against actual speech, not against speech
    // plus pre-roll. Otherwise adding PREROLL_MS of lead-in would quietly
    // lower the effective minimum by the same amount and let short noise
    // bursts through as utterances.
    const speechMs = durationMs - prerollMs;
    prerollMs = 0;

    if (speechMs < MIN_SPEECH_MS) {
      // Too short to transcribe, but the detector sees all audio while
      // speechChunks only sees chunks above ENERGY_THRESHOLD. A quiet speaker
      // can trip the model without clearing the energy gate — re-arm rather
      // than burning the detection and rejecting the query that follows.
      lastWakeAt = wakeAt;
      flushing = false;
      return;
    }

    // ── The gate ─────────────────────────────────────────────────────────────
    // Two-sided window. The detection must have landed inside this utterance —
    // allowing OWW_GRACE_MS of lead-in, since the model fires the moment the
    // wake word completes, which can precede the energy gate opening — and it
    // must not be stale relative to the audio we are about to send.
    let wakeDetected = false;
    if (wakeStream) {
      const now = Date.now();
      // Discord stops sending Opus packets during silence, so buffered
      // duration can lag wall-clock. Measure staleness against whichever is
      // longer, or a hesitant speaker's valid wake word gets rejected.
      const span = Math.max(durationMs, now - speechStartedAt);
      wakeDetected =
        wakeAt > 0 &&
        wakeAt >= speechStartedAt - OWW_GRACE_MS &&
        now - wakeAt <= span + OWW_GRACE_MS;
      if (!wakeDetected) {
        // Report the model's best score across the discarded utterance.
        // If you spoke the wake word and this reads 0.2x, the threshold is
        // too high. If it reads 0.00x, the model did not react to your voice
        // at all and no threshold will help.
        console.log(
          `[${userId}] utterance discarded — no wake word ` +
          `(${Math.round(durationMs)}ms, peak score ${wakeStream.takePeak().toFixed(3)}, ` +
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
            `utterance ${Math.round(durationMs)}ms, span ${Math.round(span)}ms. ` +
            'Raise OWW_GRACE_MS if this looks wrong.'
          );
        }
        flushing = false;
        return;
      }
    }

    // Consume the peak on success too, so a good score cannot leak forward and
    // be reported against a later discarded utterance.
    if (wakeStream) wakeStream.takePeak();

    console.log(`[${userId}] Processing ${Math.round(durationMs)}ms utterance...`);
    processUtterance(pcm, userId, connection, channel, wakeDetected)
      .finally(() => { flushing = false; });
  }

  let lastChunkAt = 0;

  decoder.on('data', chunk => {
    const chunkAt = Date.now();
    lastDataTime = chunkAt;

    // Feed the detector every frame we receive, including low-energy ones.
    if (wakeStream) {
      // Re-insert any silence Discord dropped, so the detector's timeline
      // matches wall-clock. Without this a pause inside the wake phrase is
      // spliced out and the phrase becomes unrecognisable.
      if (lastChunkAt) {
        const gapMs = chunkAt - lastChunkAt - DECODER_CHUNK_MS;
        if (gapMs > DECODER_CHUNK_MS) {
          const fillMs  = Math.min(gapMs, MAX_SILENCE_FILL_MS);
          const samples = Math.floor((fillMs / 1000) * 48000);
          if (samples > 0) {
            // Buffer.alloc zero-fills — silent 16-bit PCM.
            wakeStream.write(Buffer.alloc(samples * 2)).catch(() => {});
          }
        }
      }
      lastChunkAt = chunkAt;
    }

    if (wakeStream) {
      wakeStream.write(chunk).then(score => {
        if (OWW_DEBUG_SCORE > 0 && score !== null && score >= OWW_DEBUG_SCORE) {
          console.log(
            `[${userId}] [oww] score=${score.toFixed(3)} ` +
            `gain=${wakeStream.lastGain.toFixed(1)}x rms=${Math.round(wakeStream.lastRms)}`
          );
        }
      }).catch(() => {});
    }

    if (hasEnergy(chunk)) {
     if (!speaking) {
        speechStartedAt = Date.now();
        // Prepend the quiet lead-in. speechStartedAt deliberately still marks
        // the energy onset, not the start of the pre-roll: the wake-word window
        // check is calibrated against it, and moving it would shift the gate.
        if (preroll.length) {
          prerollMs = preroll.length * DECODER_CHUNK_MS;
          for (const c of preroll) speechChunks.push(c);
          preroll = [];
        }
      }
      speaking = true;
      speechChunks.push(chunk);
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(flushUtterance, SILENCE_MS);
   } else if (speaking) {
      speechChunks.push(chunk);
    } else if (PREROLL_CHUNKS > 0) {
      preroll.push(chunk);
      if (preroll.length > PREROLL_CHUNKS) preroll.shift();
    }

    // Drop the oldest audio rather than growing without bound.
    while (speechChunks.length > MAX_UTTERANCE_CHUNKS) speechChunks.shift();
  });

  // Discord stops sending Opus packets when truly silent — track real time elapsed
  // and flush if we've been speaking and no data arrives for SILENCE_MS
  const dataWatchdog = setInterval(() => {
    if (speaking && Date.now() - lastDataTime > SILENCE_MS) {
      flushUtterance();
    }

    // Backstop for an utterance that never sees a silence gap.
    if (speaking && Date.now() - speechStartedAt > MAX_SPEECH_MS) {
      console.warn(
        `[${userId}] ${Math.round(MAX_SPEECH_MS / 1000)}s of continuous speech with no ` +
        'silence gap — forcing flush. ENERGY_THRESHOLD is likely below your background ' +
        'noise floor, or Luna is hearing herself through your speakers.'
      );
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      flushUtterance();

      // If the flush was refused — already flushing, or nothing buffered —
      // reset anyway so this does not re-fire every 100 ms.
      if (speaking) {
        speaking = false;
        speechChunks = [];
        preroll = [];
        prerollMs = 0;
      }
    }

    // `flushing` gates every subsequent utterance from this user, and it is
    // cleared in processUtterance's .finally(). If a Whisper or LM Studio call
    // never settles, it stays true forever and this user goes permanently
    // deaf with no error logged. Self-heal, and say so loudly.
    if (flushing && Date.now() - flushStartedAt > STUCK_FLUSH_MS) {
      console.error(
        `[${userId}] flush stuck for ${Math.round((Date.now() - flushStartedAt) / 1000)}s ` +
        '— releasing. A Whisper or LM Studio request almost certainly never returned.'
      );
      flushing = false;
      flushStartedAt = 0;
    }
  }, 100);

  audioStream.once('close', () => {
    console.log(`[${userId}] capture stream closed — will resume on next speech`);
    clearInterval(dataWatchdog);
    if (silenceTimer) clearTimeout(silenceTimer);
    if (wakeStream) wakeStream.close();
    captureStates.delete(userId);
    listeningUsers.delete(userId);
    // Stream closed — speaking.start will re-trigger continuousCapture next time user speaks
  });

  audioStream.once('error', err => {
    console.error(`[${userId}] capture stream error:`, err);
    clearInterval(dataWatchdog);
    if (silenceTimer) clearTimeout(silenceTimer);
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
  return g;
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

async function processUtterance(pcm, userId, connection, channel, wakeDetected = false) {
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

    // When the ONNX model already confirmed the wake word on the raw audio, do
    // not re-check the transcript — Whisper frequently mangles or drops a
    // leading wake word, and rejecting on that would discard valid queries.
    if (!wakeDetected && !WAKE_RE.test(transcript)) return;

    // Strip the wake phrase so the LLM gets a clean query. Falls back to the
    // raw transcript when the phrase was the whole utterance (a bare "hey
    // Luna"), so that still reaches the LLM as a greeting rather than "".
    const query = stripWakeWord(transcript) || transcript;

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

function needsWebSearch(query) {
  const lower = query.toLowerCase();
  if (SEARCH_YEAR_RE.test(lower)) return true;
  if (SEARCH_KEYWORDS.some(k => lower.includes(k))) return true;
  return TEMPORAL.some(t => lower.includes(t)) && TOPICAL.some(t => lower.includes(t));
}

// Removes a leading wake word if Whisper transcribed one. With openWakeWord
// gating the transcript often has no wake word at all (the model already
// consumed it on the audio), so this must degrade gracefully to a no-op.
function stripWakeWord(query) {
  return query.replace(WAKE_RE, '').trim();
}

function extractSmakbotCommand(query) {
  const after = stripWakeWord(query);
  const match = after.match(/^play(?:\s+(?:the\s+)?(?:song|music))?[,.]?\s+(.+)/i);
  return match ? match[1].trim().replace(/[,.]+$/, '') : null;
}

// ─── Query handler ────────────────────────────────────────────────────────────

async function handleQuery(query, connection, channel, t0 = Date.now(), userId = 'unknown') {
  // Check for smakbot music command first
  const songRequest = extractSmakbotCommand(query);
  if (songRequest) {
    console.log(`Smakbot command: !play ${songRequest}`);
    await channel.send(`!play ${songRequest}`).catch(err =>
      console.error('Failed to send play music command:', err.message)
    );
    // interruptOwnPlayback, not nextGeneration: the latter invalidates pending
    // sentences but leaves the one currently playing, so an old answer talks
    // over "Okay, playing X."
    const musicGeneration = interruptOwnPlayback(userId);
    queuePlayback(async () => {
      const pt = await fetchTTS(`Okay, playing ${songRequest}.`);
      if (pt) await playTTS(pt, connection);
    }, userId, musicGeneration);
    return;
  }

  // Supersede only this speaker's own pending response. Anyone else's queued
  // sentences survive and play in turn.
  const myGeneration = interruptOwnPlayback(userId);

  // Fire chime (don't await — let it play while we fetch the LLM response)
  // Fire chime (don't await — let it play while we fetch the LLM response).
  //
  // Skipped while audio is already playing. playSound() creates its own
  // AudioPlayer and calls connection.subscribe(), and a VoiceConnection has
  // exactly one subscription — so an unconditional chime silently detached
  // whichever sentence was mid-playback. With several people in a channel that
  // presented as Luna's answers being randomly truncated.
  if (!currentPlayer) {
    playSound('./chime.mp3', connection).catch(() => {});
  }
  const statusMsg = await channel.send('🤔 *Luna is thinking...*').catch(() => null);

  // ── Per-response playback ───────────────────────────────────────────────
  //
  // ONE entry goes on the global chain for the whole response, not one per
  // sentence. With per-sentence entries two speakers' answers braid together
  // — A1, B1, A2, B2 — which is worse than the bug this design replaced.
  //
  // Prefetch is preserved: fetchTTS still fires the instant the LLM yields a
  // sentence, so Kokoro renders sentence N+1 while N plays. Only playback
  // order is serialised.
  const pending  = [];      // Promise<PassThrough>[], in speech order
  let streamDone = false;
  let wake       = null;    // resolver signalling "more sentences available"

  const signal = () => { if (wake) { wake(); wake = null; } };

  // Enqueued LAZILY, on the first sentence — never at query time.
  //
  // The entry parks at the head of the shared chain while it waits for more
  // sentences. Enqueuing it up front would therefore hold that head for the
  // entire LLM generation (up to LM_TIMEOUT_MS = 2 minutes) while producing no
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

      while (true) {
        if (i < pending.length) {
          if (userGeneration.get(userId) !== myGeneration) return;

          const passThrough = await pending[i++];

          // Re-check AFTER the await: a barge-in can land while Kokoro is still
          // rendering, and without this the superseded sentence plays anyway.
          if (userGeneration.get(userId) !== myGeneration) return;

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
    }, userId, myGeneration);
  };

  try {
    let firstSentence = true;
   for await (const sentence of getLMStudioResponseStreaming(query, userId)) {
      if (!sentence.trim()) continue;
      // Abort only if THIS speaker asked something newer mid-stream.
      if (userGeneration.get(userId) !== myGeneration) break;
      console.log('Luna sentence:', sentence);

      if (firstSentence) {
        firstSentence = false;
        console.log(`[timing] First LLM sentence: ${Date.now() - t0}ms`);
        try { if (statusMsg) await statusMsg.delete(); } catch (_) {}
      }

      ensureQueued();
      pending.push(fetchTTS(sentence));  // fire immediately, await later
      signal();
    }

    // Clean up status message if LLM returned nothing
    if (firstSentence) {
      try { if (statusMsg) await statusMsg.delete(); } catch (_) {}
    }
  } catch (err) {
    console.error('handleQuery error:', err.message);
    try { if (statusMsg) await statusMsg.delete(); } catch (_) {}
    ensureQueued();
    pending.push(fetchTTS('I had trouble processing that.'));
    signal();
  } finally {
    // MUST run on every path. The queue entry above parks on `wake`, and if
    // it is never released it blocks the global playback chain for every
    // speaker, forever.
    streamDone = true;
    signal();
  }
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

async function* getLMStudioResponseStreaming(text, userId) {
  const useSearch = needsWebSearch(text);

  const body = {
    model: lmStudioModel,
    input: text,
    stream: true,
    ...(useSearch && {
      integrations: [{
        type: 'ephemeral_mcp',
        server_label: 'tavily',
        server_url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${process.env.TAVILY_API_KEY}`,
      }],
    }),
  };

  const priorId = getConversationId(userId);
  if (priorId) {
    body.previous_response_id = priorId;
  } else {
    body.system_prompt = LM_SYSTEM_PROMPT;
  }

  console.log(`[LLM] POST ${LM_STUDIO_URL} model=${lmStudioModel} stream=true useSearch=${useSearch}`);

  const res = await fetch(LM_STUDIO_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.LM_STUDIO_MCP_BEARER_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LM_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text();
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

    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;

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

          // response_id lives inside chat.end result
          if (parsed.type === 'chat.end') {
            if (parsed.result?.output) {
              const msg = parsed.result.output.filter(o => o.type === 'message').pop();
              if (msg?.content) responseId = parsed.result?.response_id ?? null;
            }
            finished = true;
            break;
          }

          // LM Studio SSE format: {type:'message.delta', content:'token'}
          const delta = parsed.type === 'message.delta' ? (parsed.content ?? '') : '';

          if (!delta) continue;
          buffer += delta;

          let match;
          while ((match = SENTENCE_END.exec(buffer)) !== null) {
            const endIdx   = match.index + match[0].length;
            const sentence = buffer.slice(0, endIdx).trim();
            buffer = buffer.slice(endIdx);
            if (sentence) yield sentence;
          }
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
    const data = await res.json();

    rememberConversation(userId, data.response_id);

    // Extract full reply text from responses API format
    const messageItem = data.output?.filter(o => o.type === 'message').pop();
    const fullText    = messageItem?.content?.trim();

    if (!fullText) {
      console.error('[LLM] No content found in response:', JSON.stringify(data).slice(0, 300));
      throw new Error('No message content in LLM response');
    }

    // Split into sentences and yield each one so TTS starts immediately
    let remaining = fullText;
    let match;
    while ((match = SENTENCE_END.exec(remaining)) !== null) {
      const endIdx   = match.index + match[0].length;
      const sentence = remaining.slice(0, endIdx).trim();
      remaining = remaining.slice(endIdx);
      if (sentence) yield sentence;
    }
    if (remaining.trim()) yield remaining.trim();
  }
}

// ─── TTS: fetch and play (split for prefetch pipeline) ──────────────────────
//
// fetchTTS()  — starts the Kokoro request and returns a PassThrough stream.
//               Called as soon as a sentence is ready, even while a previous
//               sentence is still playing, so audio is ready with zero wait.
//
// playTTS()   — subscribes the stream to the Discord player and awaits completion.
//               Called by the playback queue in order.

async function fetchTTS(text) {
  try {
    const res = await fetch(KOKORO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, voice: KOKORO_VOICE, stream: true }),
      signal: AbortSignal.timeout(KOKORO_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`Kokoro error ${res.status}:`, await res.text());
      return null;
    }

    // Pipe HTTP response body into a PassThrough so playTTS can consume it
    const passThrough = new PassThrough();

    // Load-bearing. destroy(err) below emits 'error', and an 'error' event with
    // no listener is an uncaught exception that kills the process. A listener is
    // otherwise only attached once createAudioResource() runs in playTTS — which
    // may be seconds away while this sentence waits behind another speaker's
    // response, or may never happen at all if the sentence is superseded.
    passThrough.on('error', () => {});
    const reader = res.body.getReader();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { passThrough.end(); break; }
          passThrough.write(value);
        }
      } catch (err) {
        // Without this the sentence truncates mid-word with nothing logged,
        // since the 'error' listener above is intentionally a no-op.
        console.error('Kokoro stream aborted:', err.message);
        passThrough.destroy(err);
      }
    })();

    return passThrough;
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error(`Kokoro timed out after ${KOKORO_TIMEOUT_MS}ms`);
    } else {
      console.error('fetchTTS error:', err.message);
    }
    return null;
  }
}

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

// Disconnect when the last real user (non-bot, non-ignored) leaves
client.on(Events.VoiceStateUpdate, (oldState, _newState) => {
  if (!activeVoiceChannel || oldState.channelId !== activeVoiceChannel.id) return;
  if (getRealMemberCount(activeVoiceChannel) === 0) {
    console.log('[voice] Last real user left — disconnecting.');
    activeConnection.destroy();
    activeConnection   = null;
    activeVoiceChannel = null;
    listeningUsers.clear();
    captureStates.clear();
    userGeneration.clear();
    playbackQueue      = Promise.resolve();
    currentPlayer      = null;
    currentPlayerUser  = null;
    conversations.clear();
  }
});

void client.login(process.env.DISCORD_TOKEN);
