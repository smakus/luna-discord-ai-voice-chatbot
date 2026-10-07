// ─── Text-to-speech providers ─────────────────────────────────────────────────
//
// fetchTTS(text) starts synthesis and resolves to a readable audio stream (any
// container ffmpeg can probe — Kokoro, Qwen3-TTS and Chatterbox send WAV,
// ElevenLabs MP3),
// or null if every provider failed. It resolves as soon as the response headers
// arrive, so the prefetch pipeline in index.js keeps overlapping synthesis with
// playback.
//
// TTS_PROVIDER picks the preferred provider: "kokoro" (default), "qwen3",
// "chatterbox" or "elevenlabs". TTS_FALLBACK (default "kokoro") is tried next, then Kokoro as a
// last resort — e.g. ElevenLabs → Qwen3-TTS → Kokoro. TTS_FALLBACK=none
// disables fallback. A provider that fails is handled like this:
//
//   - out of credits: the provider is skipped for TTS_CREDITS_RETRY_MS
//     (12 h). Credits only come back with a top-up or the monthly reset, and
//     a short pause flip-flopped the voice: each retry could still fit a
//     short line into the last few credits, then failed on the next one.
//   - bad key/voice/plan: skipped for TTS_PROVIDER_RETRY_MS (30 min).
//   Either way it is tried again afterwards, so fixing the account brings it
//   back without a restart.
//   - rate limit, overload, server error, timeout: only this sentence falls
//     back; the next one tries the preferred provider again.
//
// Fallback can only happen before audio starts. A stream that dies mid-sentence
// truncates that sentence, as it always has.
//
// fetchTTS(text, { signal }) — aborting the signal cancels the request (no
// fallback, resolves null), and destroying a returned stream cancels its
// download. Used to drop sentences that will never be played.

const { PassThrough } = require('stream');
const { loadConfig } = require('./config');

// Settings come from config.js, like the rest of Luna's.
const config = loadConfig(process.env);

const KOKORO_URL        = config.KOKORO_URL;
// Unset → undefined, so the request leaves it out and the server uses its default.
const KOKORO_VOICE      = config.KOKORO_VOICE || undefined;
// Awaited inside the shared playback chain, so a hang blocks audio for every
// speaker — hence a timeout even on the local server.
const KOKORO_TIMEOUT_MS = config.KOKORO_TIMEOUT_MS;

// Qwen3-TTS (Qwen3TTS/qwen3_tts_server.py, macOS only) speaks Kokoro's API in a
// cloned voice. No default URL: it only exists when that server runs.
const QWEN3_TTS_URL   = config.QWEN3_TTS_URL;
const QWEN3_TTS_VOICE = config.QWEN3_TTS_VOICE || undefined;
// Buffered by default: while the LLM generates on the same GPU, Qwen3-TTS
// renders slower than real time, and a stream that runs dry mid-sentence
// warbles in Discord. A whole rendered sentence plays cleanly; the cost is a
// pause before it. (Also why its timeout is longer.)
const QWEN3_TTS_STREAM     = config.QWEN3_TTS_STREAM;
const QWEN3_TTS_TIMEOUT_MS = config.QWEN3_TTS_TIMEOUT_MS;

// Chatterbox Turbo (Chatterbox/chatterbox_server.py, macOS only): Kokoro's API
// again, with a built-in voice ("default") or clones, and it performs audio
// tags. Renders ~4x faster than real time, but buffered by default like Qwen3.
const CHATTERBOX_URL        = config.CHATTERBOX_URL;
const CHATTERBOX_VOICE      = config.CHATTERBOX_VOICE || undefined;
const CHATTERBOX_STREAM     = config.CHATTERBOX_STREAM;
const CHATTERBOX_TIMEOUT_MS = config.CHATTERBOX_TIMEOUT_MS;

const ELEVENLABS_API_KEY  = config.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = config.ELEVENLABS_VOICE_ID;
// v4 Turbo: real-time latency (~100 ms) and it follows audio tags.
const ELEVENLABS_MODEL    = config.ELEVENLABS_MODEL;
// MP3 works on every plan; PCM formats need Pro or above.
const ELEVENLABS_FORMAT   = config.ELEVENLABS_OUTPUT_FORMAT;
const ELEVENLABS_BASE_URL = config.ELEVENLABS_BASE_URL.replace(/\/+$/, '');
// Shorter than Kokoro's: a slow cloud response should fall back to Kokoro
// while there is still time for the sentence to play promptly.
const ELEVENLABS_TIMEOUT_MS = config.ELEVENLABS_TIMEOUT_MS;

const PROVIDER_RETRY_MS = config.TTS_PROVIDER_RETRY_MS;
const CREDITS_RETRY_MS  = config.TTS_CREDITS_RETRY_MS;

// ─── Expressiveness ───────────────────────────────────────────────────────────
//
// Some voices act on inline audio tags — "[laugh] That's great." Each provider
// says which tags it performs (`tags`) and what the LLM is told about them
// (`tagPrompt`); while such a provider is the one actually in use, the LLM
// gets that instruction (expressivePrompt()). Before a sentence goes to a
// provider, tags it can't perform are dropped (`speakable`), so they are never
// read out — e.g. an answer started on ElevenLabs that falls back mid-way, or
// a custom announcement phrase. Kokoro and Qwen3-TTS perform none.
const TTS_EXPRESSIVE = config.TTS_EXPRESSIVE;

const AUDIO_TAG = /\[[^\[\]\n]{1,40}\]/g;

function stripAudioTags(text) {
  return text.replace(AUDIO_TAG, ' ').replace(/\s+/g, ' ').trim();
}

// ElevenLabs v3/v4 take free-form tags ("any").
const ELEVENLABS_TAG_MODELS = new Set(['eleven_v4', 'eleven_v4_turbo', 'eleven_v3', 'eleven_v3_conversational']);
const ELEVENLABS_PROMPT =
  'Your voice can perform audio tags written in square brackets, such as ' +
  '[laughs], [chuckles], [sighs], [whispers], [excited] or [sarcastic]. Where ' +
  'one genuinely fits the moment, put it right before the words it applies to; ' +
  'use at most one per reply, and none at all for plain factual answers.';

// Chatterbox Turbo performs exactly the tags it was trained on (the server's
// /health lists them). The LLM is told all of them; ElevenLabs-style spellings
// it may still write are mapped to the nearest one, and the rest dropped.
const CHATTERBOX_EMOTIONS = ['happy', 'sarcastic', 'surprised', 'whispering', 'angry', 'fear', 'crying', 'dramatic'];
const CHATTERBOX_SOUNDS = ['laugh', 'chuckle', 'sigh', 'gasp', 'groan', 'sniff', 'cough', 'clear throat', 'shush'];
const CHATTERBOX_ALIASES = {
  laughs: 'laugh', laughing: 'laugh', giggles: 'laugh', giggle: 'laugh',
  chuckles: 'chuckle', chuckling: 'chuckle', sighs: 'sigh', sighing: 'sigh',
  gasps: 'gasp', groans: 'groan', sniffs: 'sniff', sniffles: 'sniff', coughs: 'cough',
  whispers: 'whispering', whisper: 'whispering', excited: 'happy', cheerful: 'happy',
  surprise: 'surprised', scared: 'fear', afraid: 'fear', cries: 'crying', sad: 'crying',
};
const tagList = names => names.map(n => `[${n}]`).join(', ');
const CHATTERBOX_PROMPT =
  'Your voice can perform these audio tags, written in square brackets exactly ' +
  `as shown. Emotions: ${tagList(CHATTERBOX_EMOTIONS)}; an emotion only colors the ` +
  'words after it, so put it at the start of a sentence, never at the end. ' +
  `Sounds: ${tagList(CHATTERBOX_SOUNDS)}; a sound is performed where it stands. ` +
  'Use tags wherever they genuinely fit the moment. ' +
  'Never use any for plain facts, numbers or information. No other bracketed tags.';

// The text with only the tags `tags` performs: a Set of tag names (after
// aliases), "any", or null for none.
function keepTags(text, tags, aliases = {}) {
  if (tags === 'any') return text.trim();
  if (!tags) return stripAudioTags(text);
  return text.replace(AUDIO_TAG, tag => {
    const name = tag.slice(1, -1).trim().toLowerCase();
    const known = aliases[name] || name;
    return tags.has(known) ? `[${known}]` : ' ';
  }).replace(/\s+/g, ' ').trim();
}

// Thrown by a provider to say whether the whole provider should be benched
// ('disable') or only this request should move on ('transient').
class TTSError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

// Turns a fetch Response body into a PassThrough that playTTS can consume.
function pipeBody(res, label) {
  const passThrough = new PassThrough();

  // Load-bearing. destroy(err) below emits 'error', and an 'error' event with
  // no listener is an uncaught exception that kills the process. A listener is
  // otherwise only attached once createAudioResource() runs in playTTS — which
  // may be seconds away while this sentence waits behind another speaker's
  // response, or may never happen at all if the sentence is superseded.
  passThrough.on('error', () => {});
  const reader = res.body.getReader();
  // Destroying the stream (a superseded sentence) stops the download instead
  // of reading the rest of the body into a stream nobody will play.
  passThrough.once('close', () => { reader.cancel().catch(() => {}); });
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
      if (!passThrough.destroyed) {
        console.error(`${label} stream aborted:`, err.message);
        passThrough.destroy(err);
      }
    }
  })();
  return passThrough;
}

// fetch() with a timeout, mapping network failures to transient errors and a
// caller cancellation to 'cancelled'.
async function request(label, url, init, timeoutMs, cancel) {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...init, signal: cancel ? AbortSignal.any([timeout, cancel]) : timeout });
  } catch (err) {
    if (cancel && cancel.aborted) throw new TTSError(`${label} request cancelled`, 'cancelled');
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new TTSError(`${label} timed out after ${timeoutMs}ms`, 'transient');
    }
    throw new TTSError(`${label} request failed: ${err.message}`, 'transient');
  }
}

// A local server with Kokoro's /v1/audio/speech API (WAV).
function localProvider(name, url, voice, stream, timeoutMs, { tags = null, aliases = {}, tagPrompt = '' } = {}) {
  return {
    name,
    tagPrompt,
    speakable: text => keepTags(text, tags, aliases),
    configured: () => Boolean(url),
    async synthesize(text, signal) {
      const res = await request(name, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text, voice, stream }),
      }, timeoutMs, signal);
      if (!res.ok) {
        const body = await res.text();
        // A voice that isn't installed fails every sentence until the config
        // is fixed; anything else (e.g. still loading) is worth retrying.
        const kind = res.status === 400 && /unknown voice/i.test(body) ? 'disable' : 'transient';
        throw new TTSError(`${name} error ${res.status}: ${body.slice(0, 200)}`, kind);
      }
      return pipeBody(res, name);
    },
  };
}

const kokoro = localProvider('Kokoro', KOKORO_URL, KOKORO_VOICE, true, KOKORO_TIMEOUT_MS);
const qwen3  = localProvider('Qwen3-TTS', QWEN3_TTS_URL, QWEN3_TTS_VOICE, QWEN3_TTS_STREAM, QWEN3_TTS_TIMEOUT_MS);
const chatterbox = localProvider('Chatterbox', CHATTERBOX_URL, CHATTERBOX_VOICE, CHATTERBOX_STREAM, CHATTERBOX_TIMEOUT_MS, {
  tags: new Set([...CHATTERBOX_EMOTIONS, ...CHATTERBOX_SOUNDS]), aliases: CHATTERBOX_ALIASES, tagPrompt: CHATTERBOX_PROMPT,
});

// Error codes per https://elevenlabs.io/docs/eleven-api/resources/errors.
// Credits used to be reported as 401 + detail.status "quota_exceeded" and are
// now 402 + detail.code "insufficient_credits"; both are handled.
const ELEVENLABS_CREDIT_CODES = new Set(['insufficient_credits', 'quota_exceeded']);
const ELEVENLABS_DISABLE_CODES = new Set([
  'payment_required', 'paid_plan_required',
  'invalid_api_key', 'missing_api_key', 'unauthorized',
  'detected_unusual_activity', 'insufficient_permissions',
  'feature_not_available', 'subscription_required',
  'voice_not_found', 'model_not_found', 'invalid_voice_id',
]);

function classifyElevenLabs(status, detail) {
  const code = (detail && (detail.code || detail.status)) || '';
  if (ELEVENLABS_CREDIT_CODES.has(code) || (detail && ELEVENLABS_CREDIT_CODES.has(detail.status))) return 'credits';
  if (ELEVENLABS_DISABLE_CODES.has(code)) return 'disable';
  if (status === 401 || status === 402 || status === 403 || status === 404) return 'disable';
  return 'transient'; // 400 text issues, 409, 429, 5xx
}

const ELEVENLABS_TAGS = ELEVENLABS_TAG_MODELS.has(ELEVENLABS_MODEL);
const elevenlabs = {
  name: 'ElevenLabs',
  tagPrompt: ELEVENLABS_TAGS ? ELEVENLABS_PROMPT : '',
  speakable: text => keepTags(text, ELEVENLABS_TAGS ? 'any' : null),
  configured: () => Boolean(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID),
  async synthesize(text, signal) {
    const url = `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}` +
      `/stream?output_format=${encodeURIComponent(ELEVENLABS_FORMAT)}`;
    const res = await request('ElevenLabs', url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY },
      body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
    }, ELEVENLABS_TIMEOUT_MS, signal);
    if (!res.ok) {
      const body = await res.text();
      let detail = null;
      try { detail = JSON.parse(body).detail; } catch (_) {}
      const message = (detail && (detail.message || detail.code || detail.status)) || body.slice(0, 200);
      throw new TTSError(`ElevenLabs error ${res.status}: ${message}`, classifyElevenLabs(res.status, detail));
    }
    return pipeBody(res, 'ElevenLabs');
  },
};

const PROVIDERS = { kokoro, qwen3, chatterbox, elevenlabs };

const preferred = PROVIDERS[config.TTS_PROVIDER.toLowerCase()];
const fallbackName = config.TTS_FALLBACK.toLowerCase();
const fallback = fallbackName === 'none' ? null : PROVIDERS[fallbackName];
if (fallbackName !== 'none' && !fallback) {
  console.warn(`[tts] unknown TTS_FALLBACK "${config.TTS_FALLBACK}" — using Kokoro`);
}

// Providers to try, in order. An unknown or unconfigured preferred provider is
// dropped with a warning rather than failing every sentence.
const chain = [];
if (!preferred) {
  console.warn(`[tts] unknown TTS_PROVIDER "${config.TTS_PROVIDER}" — using Kokoro`);
} else if (!preferred.configured()) {
  console.warn(`[tts] ${preferred.name} selected but not configured — using Kokoro`);
} else {
  chain.push(preferred);
}
for (const p of [fallback, kokoro]) {
  if (p && !chain.includes(p) && p.configured()) chain.push(p);
  if (fallback === null && chain.length) break; // TTS_FALLBACK=none
}

const benchedUntil = new Map(); // provider -> ms timestamp

const isBenched = p => Date.now() < (benchedUntil.get(p) || 0);

function describeTTS() {
  if (!chain.length) return 'none configured (set KOKORO_URL)';
  const desc = chain.map(p => p.name === 'ElevenLabs' ? `ElevenLabs (${ELEVENLABS_MODEL})` : p.name)
    .join(' → fallback ');
  return desc + (TTS_EXPRESSIVE && chain[0].tagPrompt ? ', expressive' : '');
}

// The provider the next sentence will most likely go to.
function activeProvider() {
  return chain.find((p, i) => !isBenched(p) || i === chain.length - 1) || null;
}

// Extra system-prompt text for the LLM: the audio-tag instruction of the
// provider in use, '' if it performs none (including while ElevenLabs is
// benched and Kokoro is speaking). TTS_EXPRESSIVE_PROMPT replaces the
// provider's own wording.
function expressivePrompt() {
  const p = activeProvider();
  if (!TTS_EXPRESSIVE || !p || !p.tagPrompt) return '';
  return config.TTS_EXPRESSIVE_PROMPT || p.tagPrompt;
}

async function fetchTTS(text, { signal } = {}) {
  for (let i = 0; i < chain.length; i++) {
    if (signal && signal.aborted) return null;
    const provider = chain[i];
    const isLast = i === chain.length - 1;

    // A benched provider is skipped — unless it is the only one left, where
    // trying is strictly better than certain silence.
    if (isBenched(provider) && !isLast) continue;

    const spoken = TTS_EXPRESSIVE ? provider.speakable(text) : stripAudioTags(text);
    // A sentence that was only a tag ("[laughs]") has nothing left to say.
    if (!spoken) return null;

    try {
      const stream = await provider.synthesize(spoken, signal);
      if (benchedUntil.has(provider)) {
        benchedUntil.delete(provider);
        console.log(`[tts] ${provider.name} is working again`);
      }
      return stream;
    } catch (err) {
      if (err instanceof TTSError && err.kind === 'cancelled') return null;
      const next = chain[i + 1];
      if (err instanceof TTSError && (err.kind === 'disable' || err.kind === 'credits') && !isLast) {
        const alreadyBenched = isBenched(provider);
        const pauseMs = err.kind === 'credits' ? CREDITS_RETRY_MS : PROVIDER_RETRY_MS;
        benchedUntil.set(provider, Date.now() + pauseMs);
        // Prefetched sentences hit the same error together; log it once.
        if (!alreadyBenched) {
          const span = pauseMs >= 3600000 ? `${+(pauseMs / 3600000).toFixed(1)} h` : `${Math.round(pauseMs / 60000)} min`;
          console.error(`[tts] ${err.message} — ${err.kind === 'credits' ? 'out of credits; ' : ''}` +
            `using ${next.name} for the next ${span}`);
        }
      } else {
        console.error(`[tts] ${err.message}${next ? ` — falling back to ${next.name}` : ''}`);
      }
    }
  }
  return null;
}

module.exports = { fetchTTS, describeTTS, expressivePrompt, stripAudioTags };
