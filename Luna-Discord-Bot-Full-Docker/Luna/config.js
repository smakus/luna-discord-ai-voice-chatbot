// ─── Settings ─────────────────────────────────────────────────────────────────
//
// Every setting Luna reads from her environment (Luna/.env, or the compose
// file), in one list: name, type, default, limits. loadConfig(env) parses and
// checks them all; the rest of the code takes values from its result instead
// of reading process.env itself.
//
// A bad value is reported and replaced by the default, rather than silently
// turning into NaN (OWW_THRESHOLD=abc used to mean the wake word never fired).
// A name that looks like one of Luna's but isn't ("OWW_THRESHHOLD") is
// reported with the closest real name, since it would otherwise be ignored
// without a word.
//
// The README and example.env are checked against this list by the tests.
//
// Types:
//   string   text ('' = not set)            secret  text, never logged
//   int      whole number (min/max)          float   number (min/max)
//   bool     true/false (also 1/0, yes/no, on/off)
//   enum     one of `choices` (case-insensitive)
//   list     comma-separated                 phrases '|'-separated, trimmed

const SETTINGS = [
  // Discord and services
  { name: 'DISCORD_TOKEN', type: 'secret' },
  { name: 'LM_STUDIO_URL', type: 'string' },
  { name: 'LM_STUDIO_MCP_BEARER_TOKEN', type: 'secret' },
  { name: 'WHISPER_SERVER_URLS', type: 'list' },
  { name: 'IGNORED_USER_IDS', type: 'list' },
  { name: 'LUNA_TIMEZONE', type: 'string', fallbackEnv: 'TZ', default: 'UTC' },

  // Wake word
  { name: 'OWW_ENABLED', type: 'bool', default: true },
  { name: 'OWW_MODEL_PATH', type: 'string' },
  { name: 'OWW_MELSPEC_PATH', type: 'string' },
  { name: 'OWW_EMBEDDING_PATH', type: 'string' },
  { name: 'OWW_THRESHOLD', type: 'float', default: 0.5, min: 0, max: 1 },
  { name: 'OWW_CANDIDATE_THRESHOLD', type: 'float', default: 0.1, min: 0, max: 1 },
  { name: 'WAKE_LISTEN_MS', type: 'int', default: 4000, min: 0 },
  { name: 'OWW_TRIGGER_FRAMES', type: 'int', default: 1, min: 1 },
  { name: 'OWW_REFRACTORY_MS', type: 'int', default: 1500, min: 0 },
  { name: 'OWW_FEATURE_FRAMES', type: 'int', default: 0, min: 0 },
  { name: 'OWW_GRACE_MS', type: 'int', default: 2000, min: 0 },
  { name: 'OWW_DEBUG_SCORE', type: 'float', default: 0, min: 0, max: 1 },
  { name: 'OWW_GAIN', type: 'string', default: 'auto', check: v => v === 'auto' || v === 'off' || Number(v) > 0, expect: 'auto, off or a number above 0' },
  { name: 'OWW_AGC_TARGET_RMS', type: 'int', default: 4000, min: 1 },

  // Capture
  { name: 'SILENCE_MS', type: 'int', default: 1000, min: 1 },
  { name: 'ENERGY_THRESHOLD', type: 'int', default: 300, min: 0 },
  { name: 'MIN_SPEECH_MS', type: 'int', default: 300, min: 0 },
  { name: 'MAX_SPEECH_MS', type: 'int', default: 15000, min: 1 },
  { name: 'PREROLL_MS', type: 'int', default: 320, min: 0 },
  { name: 'MAX_SILENCE_FILL_MS', type: 'int', default: 2000, min: 0 },
  { name: 'VOICE_RECOVER_MS', type: 'int', default: 20000, min: 0 },

  // Announcements
  { name: 'ANNOUNCE_SELF', type: 'bool', default: true },
  { name: 'INTRO_PHRASES', type: 'phrases' },
  { name: 'GREET_ON_JOIN', type: 'bool', default: true },
  { name: 'GREET_PHRASES', type: 'phrases' },
  { name: 'GREET_COOLDOWN_MS', type: 'int', default: 600000, min: 0 },
  { name: 'GREET_DELAY_MS', type: 'int', default: 1500, min: 0 },
  { name: 'ANNOUNCE_LEAVE', type: 'bool', default: true },
  { name: 'FAREWELL_PHRASES', type: 'phrases' },
  { name: 'LEAVE_COOLDOWN_MS', type: 'int', default: 600000, min: 0 },
  { name: 'LEAVE_DELAY_MS', type: 'int', default: 3000, min: 0 },
  { name: 'ANNOUNCE_SEARCH', type: 'bool', default: true },
  { name: 'SEARCH_PHRASES', type: 'phrases' },
  { name: 'ANNOUNCE_THINKING', type: 'bool', default: true },
  { name: 'THINKING_PHRASES', type: 'phrases' },
  { name: 'THINKING_WAITS', type: 'string', default: '15-22,22-30,30-40', check: v => parseWaits(v) !== null, expect: 'windows in seconds like "15-22,22-30,30-40"' },
  { name: 'THINKING_MAX', type: 'int', default: 0, min: 0 },
  { name: 'QUICK_ANSWER_PHRASES', type: 'phrases' },

  // LLM
  { name: 'LM_PERSONALITY', type: 'string', default: 'helpful' },
  { name: 'LM_CONCISE', type: 'bool', default: true },
  { name: 'LLM_REASONING', type: 'string' },
  { name: 'LLM_THINK_LIMIT_MS', type: 'int', default: 60000, min: 0 },
  { name: 'LM_FLAVOR_PROMPT', type: 'string' },
  { name: 'LM_FLAVOR_CHANCE', type: 'float', default: 0.15, min: 0, max: 1 },
  { name: 'LM_MEMORY_TTL_MS', type: 'int', default: 600000, min: 0 },
  { name: 'LM_MEMORY_MAX_TURNS', type: 'int', default: 12, min: 0 },
  { name: 'LM_IDLE_TIMEOUT_MS', type: 'int', default: 90000, min: 1 },
  { name: 'LM_TIMEOUT_MS', type: 'int', default: 600000, min: 1 },
  { name: 'WHISPER_TIMEOUT_MS', type: 'int', default: 60000, min: 1 },

  // Web search
  { name: 'WEB_SEARCH', type: 'enum', default: 'always', choices: ['always', 'keywords', 'off'] },
  { name: 'SEARCH_MCP_PLUGIN', type: 'string' },
  { name: 'SEARCH_TOOLS', type: 'string', default: 'tavily_search' },
  { name: 'MUSIC_TOOLS', type: 'bool', default: true },
  { name: 'LUNA_MCP_PORT', type: 'int', default: 8895, min: 1, max: 65535 },
  { name: 'TAVILY_API_KEY', type: 'secret' },
  { name: 'SEARCH_PAUSE_MS', type: 'int', default: 300000, min: 0 },

  // Text-to-speech
  // Provider names are checked by tts.js, next to the providers themselves.
  { name: 'TTS_PROVIDER', type: 'string', default: 'kokoro' },
  { name: 'TTS_FALLBACK', type: 'string', default: 'kokoro' },
  { name: 'TTS_LOOKAHEAD', type: 'int', default: 2, min: 1 },
  { name: 'TTS_EXPRESSIVE', type: 'bool', default: true },
  { name: 'TTS_EXPRESSIVE_PROMPT', type: 'string' },
  { name: 'TTS_PROVIDER_RETRY_MS', type: 'int', default: 1800000, min: 0 },
  { name: 'TTS_CREDITS_RETRY_MS', type: 'int', default: 43200000, min: 0 },
  { name: 'KOKORO_URL', type: 'string' },
  { name: 'KOKORO_VOICE', type: 'string' },
  { name: 'KOKORO_TIMEOUT_MS', type: 'int', default: 30000, min: 1 },
  { name: 'QWEN3_TTS_URL', type: 'string' },
  { name: 'QWEN3_TTS_VOICE', type: 'string' },
  { name: 'QWEN3_TTS_STREAM', type: 'bool', default: false },
  { name: 'QWEN3_TTS_TIMEOUT_MS', type: 'int', default: 60000, min: 1 },
  { name: 'CHATTERBOX_URL', type: 'string' },
  { name: 'CHATTERBOX_VOICE', type: 'string' },
  { name: 'CHATTERBOX_STREAM', type: 'bool', default: false },
  { name: 'CHATTERBOX_TIMEOUT_MS', type: 'int', default: 60000, min: 1 },
  { name: 'ELEVENLABS_API_KEY', type: 'secret' },
  { name: 'ELEVENLABS_VOICE_ID', type: 'string' },
  { name: 'ELEVENLABS_MODEL', type: 'string', default: 'eleven_v4_turbo' },
  { name: 'ELEVENLABS_OUTPUT_FORMAT', type: 'string', default: 'mp3_44100_128' },
  { name: 'ELEVENLABS_BASE_URL', type: 'string', default: 'https://api.elevenlabs.io' },
  { name: 'ELEVENLABS_TIMEOUT_MS', type: 'int', default: 10000, min: 1 },
];

// Settings of the other programs (Kokoro, Whisper, the MLX voice servers) that
// may sit in the same .env or compose file. Not Luna's, but not typos either.
const OTHER_PROGRAMS = new Set([
  'KOKORO_THREADS', 'KOKORO_MAX_CONCURRENCY', 'KOKORO_DEVICE',
  'WHISPER_THREADS', 'WHISPER_MODEL',
  'QWEN3_TTS_MODEL', 'QWEN3_TTS_TEMPERATURE', 'QWEN3_TTS_PORT', 'QWEN3_TTS_VOICES_DIR',
  'CHATTERBOX_MODEL', 'CHATTERBOX_TEMPERATURE', 'CHATTERBOX_PORT', 'CHATTERBOX_VOICES_DIR',
]);

// "15-22,22-30" → [[15000, 22000], [22000, 30000]], or null if malformed.
function parseWaits(text) {
  const waits = String(text).split(',').map(w => w.trim().split('-').map(Number))
    .map(([lo, hi = lo]) => [lo * 1000, Math.max(lo, hi) * 1000]);
  const ok = waits.length && waits.every(([lo, hi]) => Number.isFinite(lo) && Number.isFinite(hi) && lo > 0);
  return ok ? waits : null;
}

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);

const blank = s => ({ string: '', secret: '', list: [], phrases: [] })[s.type];
const defaultOf = s => (s.default !== undefined ? s.default : blank(s) ?? null);

// Parses one raw value; returns { value } or { problem }.
function parse(s, raw) {
  const text = raw.trim();
  switch (s.type) {
    case 'string': case 'secret':
      if (s.check && !s.check(text)) return { problem: `expected ${s.expect}` };
      return { value: text };
    case 'list':
      return { value: text.split(',').map(t => t.trim()).filter(Boolean) };
    case 'phrases':
      return { value: text.split('|').map(t => t.trim()).filter(Boolean) };
    case 'bool': {
      const t = text.toLowerCase();
      if (TRUE.has(t)) return { value: true };
      if (FALSE.has(t)) return { value: false };
      return { problem: 'expected true or false' };
    }
    case 'enum': {
      const t = text.toLowerCase();
      return s.choices.includes(t) ? { value: t } : { problem: `expected one of ${s.choices.join(', ')}` };
    }
    case 'int': case 'float': {
      const n = Number(text);
      if (text === '' || !Number.isFinite(n) || (s.type === 'int' && !Number.isInteger(n))) {
        return { problem: `expected ${s.type === 'int' ? 'a whole number' : 'a number'}` };
      }
      if (s.min !== undefined && n < s.min) return { problem: `expected at least ${s.min}` };
      if (s.max !== undefined && n > s.max) return { problem: `expected at most ${s.max}` };
      return { value: n };
    }
    default:
      throw new Error(`config: unknown type ${s.type} for ${s.name}`);
  }
}

function distance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}
// Words that start Luna's setting names; an unknown name starting with one of
// these is probably a typo of one of hers.
const FAMILIES = new Set(SETTINGS.map(s => s.name.split('_')[0]));
const NAMES = SETTINGS.map(s => s.name);

// Each problem is reported once per environment, however often it is loaded:
// index.js, tts.js and wakeword.js each load the same process.env.
const reportedFor = new WeakMap();

// Parses every setting from env (an object like process.env). Returns a frozen
// { NAME: value } object. warn(message) receives each problem once.
function loadConfig(env, { warn = msg => console.warn(msg) } = {}) {
  let reported = reportedFor.get(env);
  if (!reported) reportedFor.set(env, (reported = new Set()));
  const report = msg => { if (!reported.has(msg)) { reported.add(msg); warn(msg); } };
  const config = {};
  for (const s of SETTINGS) {
    let raw = env[s.name];
    if ((raw === undefined || raw.trim() === '') && s.fallbackEnv) raw = env[s.fallbackEnv];
    if (raw === undefined || raw.trim() === '') {
      config[s.name] = defaultOf(s);
      continue;
    }
    const { value, problem } = parse(s, raw);
    if (problem) {
      const shown = s.type === 'secret' ? '(hidden)' : JSON.stringify(raw);
      report(`[config] ${s.name}=${shown} is invalid (${problem}) — using the default` +
        (defaultOf(s) !== '' && defaultOf(s) !== null ? ` (${JSON.stringify(defaultOf(s))})` : ''));
      config[s.name] = defaultOf(s);
    } else {
      config[s.name] = value;
    }
  }
  for (const name of Object.keys(env)) {
    if (NAMES.includes(name) || OTHER_PROGRAMS.has(name) || !FAMILIES.has(name.split('_')[0])) continue;
    const closest = NAMES.reduce((best, n) => (distance(name, n) < distance(name, best) ? n : best), NAMES[0]);
    report(`[config] ${name} is not one of Luna's settings and is ignored` +
      (distance(name, closest) <= 3 ? ` — did you mean ${closest}?` : ''));
  }
  return Object.freeze(config);
}

module.exports = { loadConfig, parseWaits, SETTINGS, OTHER_PROGRAMS };
