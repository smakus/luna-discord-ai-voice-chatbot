// ─── Text-to-speech providers ─────────────────────────────────────────────────
//
// fetchTTS(text) starts synthesis and resolves to a readable audio stream (any
// container ffmpeg can probe — Kokoro sends WAV, ElevenLabs MP3), or null if
// every provider failed. It resolves as soon as the response headers arrive, so
// the prefetch pipeline in index.js keeps overlapping synthesis with playback.
//
// TTS_PROVIDER picks the preferred provider: "kokoro" (default), "vibevoice"
// or "elevenlabs". TTS_FALLBACK (default "kokoro") is tried next, then Kokoro
// as a last resort — e.g. ElevenLabs → VibeVoice → Kokoro. TTS_FALLBACK=none
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

const KOKORO_URL        = process.env.KOKORO_URL;
const KOKORO_VOICE      = process.env.KOKORO_VOICE;
// Awaited inside the shared playback chain, so a hang blocks audio for every
// speaker — hence a timeout even on the local server.
const KOKORO_TIMEOUT_MS = parseInt(process.env.KOKORO_TIMEOUT_MS || '30000', 10);

// VibeVoice-Realtime (VibeVoice/vibevoice_server.py, macOS only) speaks the
// same API as Kokoro. No default URL: it only exists when that server runs.
const VIBEVOICE_URL        = process.env.VIBEVOICE_URL;
const VIBEVOICE_VOICE      = process.env.VIBEVOICE_VOICE;
const VIBEVOICE_TIMEOUT_MS = parseInt(process.env.VIBEVOICE_TIMEOUT_MS || '30000', 10);

const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';
// v4 Turbo: real-time latency (~100 ms) and it follows audio tags.
const ELEVENLABS_MODEL    = process.env.ELEVENLABS_MODEL || 'eleven_v4_turbo';
// MP3 works on every plan; PCM formats need Pro or above.
const ELEVENLABS_FORMAT   = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';
const ELEVENLABS_BASE_URL = (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
// Shorter than Kokoro's: a slow cloud response should fall back to Kokoro
// while there is still time for the sentence to play promptly.
const ELEVENLABS_TIMEOUT_MS = parseInt(process.env.ELEVENLABS_TIMEOUT_MS || '10000', 10);

const PROVIDER_RETRY_MS = parseInt(process.env.TTS_PROVIDER_RETRY_MS || '1800000', 10);
const CREDITS_RETRY_MS  = parseInt(process.env.TTS_CREDITS_RETRY_MS  || '43200000', 10);

// ─── Expressiveness ───────────────────────────────────────────────────────────
//
// ElevenLabs' v3/v4 models act on inline audio tags — "[laughs] That's great."
// While such a model is the provider actually in use, the LLM is told it may
// use them (expressivePrompt()). Kokoro has no such feature and would read the
// tag out loud, so it gets no instruction, and any tag that still reaches it —
// e.g. an answer started on ElevenLabs that falls back mid-way, or a custom
// announcement phrase — is stripped first.
const TTS_EXPRESSIVE = (process.env.TTS_EXPRESSIVE || 'true').toLowerCase() !== 'false';
const TAG_MODELS = new Set(['eleven_v4', 'eleven_v4_turbo', 'eleven_v3', 'eleven_v3_conversational']);
const EXPRESSIVE_PROMPT = process.env.TTS_EXPRESSIVE_PROMPT ||
  'Your voice can perform audio tags written in square brackets, such as ' +
  '[laughs], [chuckles], [sighs], [whispers], [excited] or [sarcastic]. Where ' +
  'one genuinely fits the moment, put it right before the words it applies to; ' +
  'use at most one per reply, and none at all for plain factual answers.';

const AUDIO_TAG = /\[[^\[\]\n]{1,40}\]/g;

function stripAudioTags(text) {
  return text.replace(AUDIO_TAG, ' ').replace(/\s+/g, ' ').trim();
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

// A local server with Kokoro's /v1/audio/speech API (streaming WAV).
function localProvider(name, url, voice, timeoutMs) {
  return {
    name,
    supportsTags: false,
    configured: () => Boolean(url),
    async synthesize(text, signal) {
      const res = await request(name, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text, voice, stream: true }),
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

const kokoro    = localProvider('Kokoro', KOKORO_URL, KOKORO_VOICE, KOKORO_TIMEOUT_MS);
const vibevoice = localProvider('VibeVoice', VIBEVOICE_URL, VIBEVOICE_VOICE, VIBEVOICE_TIMEOUT_MS);

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

const elevenlabs = {
  name: 'ElevenLabs',
  supportsTags: TAG_MODELS.has(ELEVENLABS_MODEL),
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

const PROVIDERS = { kokoro, vibevoice, elevenlabs };

const preferred = PROVIDERS[(process.env.TTS_PROVIDER || 'kokoro').toLowerCase()];
const fallbackName = (process.env.TTS_FALLBACK || 'kokoro').toLowerCase();
const fallback = fallbackName === 'none' ? null : PROVIDERS[fallbackName];
if (fallbackName !== 'none' && !fallback) {
  console.warn(`[tts] unknown TTS_FALLBACK "${process.env.TTS_FALLBACK}" — using Kokoro`);
}

// Providers to try, in order. An unknown or unconfigured preferred provider is
// dropped with a warning rather than failing every sentence.
const chain = [];
if (!preferred) {
  console.warn(`[tts] unknown TTS_PROVIDER "${process.env.TTS_PROVIDER}" — using Kokoro`);
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
  return desc + (TTS_EXPRESSIVE && chain[0].supportsTags ? ', expressive' : '');
}

// The provider the next sentence will most likely go to.
function activeProvider() {
  return chain.find((p, i) => !isBenched(p) || i === chain.length - 1) || null;
}

// Extra system-prompt text for the LLM: the audio-tag instruction while an
// expressive provider is in use, '' otherwise (including while ElevenLabs is
// benched and Kokoro is speaking).
function expressivePrompt() {
  const p = activeProvider();
  return TTS_EXPRESSIVE && p && p.supportsTags ? EXPRESSIVE_PROMPT : '';
}

async function fetchTTS(text, { signal } = {}) {
  for (let i = 0; i < chain.length; i++) {
    if (signal && signal.aborted) return null;
    const provider = chain[i];
    const isLast = i === chain.length - 1;

    // A benched provider is skipped — unless it is the only one left, where
    // trying is strictly better than certain silence.
    if (isBenched(provider) && !isLast) continue;

    const spoken = provider.supportsTags && TTS_EXPRESSIVE ? text.trim() : stripAudioTags(text);
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
