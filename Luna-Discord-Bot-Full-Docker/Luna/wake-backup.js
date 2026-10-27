// ─── Wake-word backup ─────────────────────────────────────────────────────────
//
// The wake-word model's misses: a "hey Luna" it scores 0.001 is discarded
// like any chatter (measured: rarely for smakus, a third or more of the time
// for others). Here every discarded utterance is also transcribed by Whisper,
// one at a time, and when Whisper hears "hey Luna" (WAKE_PHRASE_RE, or the
// utterance starts with "Luna": WAKE_RE — both in voice-input.js):
//   - WAKE_WHISPER_BACKUP=true: she answers it, as if the model had caught it
//     (voice-answer.js answerMissedWake) — a second chance, about 0.3 s
//     behind a normal detection;
//   - either way, something close to "hey Luna" that isn't it ("hey Lena":
//     nearWakePhrase in voice-input.js) is logged as a near miss — just
//     those two words — so regular mishearings can be added to the patterns;
//   - WAKE_SHADOW=true: the miss is logged — who, the model's score, how
//     long — and every WAKE_SHADOW_REPORT_MS a summary: how much audio, how
//     busy Whisper was, how long clips waited, drops, misses per person.
// Misses and near misses also go to the wake-word log (wake-log.js).
// Nothing else anyone said is logged or acted on.
//
// A clip waiting longer than MAX_WAIT_MS is dropped (and counted) rather than
// piling up: at most one backup request is ever with Whisper, so a real
// question waits behind at most one clip.
//
// createWakeBackup({ config, console, whisper, nameOf, onWake, wakeLog }) → { onDiscard(pcm, userId, info), report() }
// (report() is called every WAKE_SHADOW_REPORT_MS by index.js.)

const { WAKE_RE, WAKE_ANYWHERE_RE, WAKE_PHRASE_RE, nearWakePhrase } = require('./voice-input');

const MAX_WAIT_MS = 30000;
// A caught "hey Luna" older than this is not answered (only counted): an
// answer that late would land in the middle of something else.
const MAX_ANSWER_WAIT_MS = 8000;

function createWakeBackup({ config, console, whisper, nameOf = id => id, onWake = () => {}, wakeLog = { record() {} } }) {
  const enabled = () => config.WAKE_SHADOW || config.WAKE_WHISPER_BACKUP;
  const queue = [];        // { pcm, userId, peak, durationMs, at }
  let busy = false;

  const fresh = () => ({ since: Date.now(), clips: 0, audioMs: 0, whisperMs: 0, maxWhisperMs: 0, maxWaitMs: 0,
    dropped: 0, failed: 0, misses: new Map(), mentions: new Map() });
  let stats = fresh();
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  function onDiscard(pcm, userId, { peak = 0, durationMs = 0, connection = null, channel = null } = {}) {
    if (!enabled()) return;
    queue.push({ pcm, userId, peak, durationMs, connection, channel, at: Date.now() });
    run();
  }

  async function run() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const clip = queue.shift();
        const waited = Date.now() - clip.at;
        if (waited > MAX_WAIT_MS) { stats.dropped++; continue; }
        stats.maxWaitMs = Math.max(stats.maxWaitMs, waited);
        const t0 = Date.now();
        const text = await whisper.transcribe(clip.pcm).catch(() => null);
        const took = Date.now() - t0;
        stats.clips++;
        stats.audioMs += clip.durationMs;
        stats.whisperMs += took;
        stats.maxWhisperMs = Math.max(stats.maxWhisperMs, took);
        if (text == null) { stats.failed++; continue; }
        const who = nameOf(clip.userId);
        if (WAKE_PHRASE_RE.test(text) || WAKE_RE.test(text)) {
          bump(stats.misses, who);
          const late = Date.now() - clip.at > MAX_ANSWER_WAIT_MS;
          const answering = config.WAKE_WHISPER_BACKUP && clip.connection && !late;
          console.log(`[wake] Whisper heard "hey Luna" from ${who} that the model missed (scored ` +
            `${clip.peak.toFixed(3)}; ${(clip.durationMs / 1000).toFixed(1)}s utterance, Whisper ${took}ms, waited ${waited}ms)` +
            (answering ? ' — answering' : config.WAKE_WHISPER_BACKUP ? ' — too late to answer' : ''));
          wakeLog.record('missed', clip.userId, { peak: clip.peak, ms: Math.round(clip.durationMs),
            answered: answering ? 'yes' : config.WAKE_WHISPER_BACKUP && late ? 'late' : 'no' });
          if (answering) onWake(text, clip.userId, clip.connection, clip.channel, clip.at);
          continue;
        }
        const near = nearWakePhrase(text);
        if (near) {
          console.log(`[wake] near miss from ${who}: Whisper heard "${near}" — not counted as "hey Luna" (model scored ${clip.peak.toFixed(3)})`);
          wakeLog.record('near-miss', clip.userId, { heard: near, peak: clip.peak, ms: Math.round(clip.durationMs) });
        } else if (config.WAKE_SHADOW && WAKE_ANYWHERE_RE.test(text)) {
          // "Luna" somewhere, without "hey": talking about her, or to her without the wake phrase.
          bump(stats.mentions, who);
          console.log(`[shadow] "Luna" mentioned by ${who}, not as "hey Luna" — model score ${clip.peak.toFixed(3)}`);
        }
      }
    } finally {
      busy = false;
    }
  }

  // One line: could Whisper keep up, and how often did the model miss?
  function report() {
    if (!config.WAKE_SHADOW) return;
    const s = stats;
    stats = fresh();
    const wallMs = Date.now() - s.since;
    if (!s.clips && !s.dropped) return;
    const list = m => [...m].map(([who, n]) => `${who} ${n}`).join(', ') || 'none';
    console.log(
      `[shadow] last ${Math.round(wallMs / 60000)} min: ${s.clips} discarded clips transcribed ` +
      `(${(s.audioMs / 60000).toFixed(1)} min of speech), Whisper busy ${(100 * s.whisperMs / wallMs).toFixed(1)}% ` +
      `(avg ${s.clips ? Math.round(s.whisperMs / s.clips) : 0}ms, max ${s.maxWhisperMs}ms), ` +
      `longest wait ${(s.maxWaitMs / 1000).toFixed(1)}s, dropped ${s.dropped}, failed ${s.failed}, backlog ${queue.length}. ` +
      `Missed "hey Luna": ${list(s.misses)}. Other "Luna" mentions: ${list(s.mentions)}.`
    );
  }

  return { onDiscard, report };
}

module.exports = { createWakeBackup };
