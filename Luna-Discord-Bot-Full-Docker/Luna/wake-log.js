// ─── Wake-word log ────────────────────────────────────────────────────────────
//
// One JSON line per wake-word event, appended to WAKE_LOG_FILE (default
// logs/wake.jsonl; empty turns it off). Docker's own log is wiped on every
// rebuild; this file is mounted from the host and kept, so how well the wake
// word works for each person can be looked at over days. Events:
//   detected     the model heard "hey Luna" (score)
//   candidate    a score near the threshold, sent to Whisper to check (peak)
//   confirmed    …and Whisper heard "Luna" in it
//   rejected     …and it didn't (reason)
//   discarded    speech without the wake word (peak, ms): ordinary chatter,
//                and the count the misses are out of
//   missed       a "hey Luna" the model missed and the backup's Whisper heard
//                (peak, ms, answered: yes / late / no — backup off)
//   near-miss    the backup's Whisper heard something close to "hey Luna"
//                ("hey Lena"): just those two words (heard)
// Every line has t (time), event, who (display name) and id (Discord ID).
// What people said is never written, only the near-miss's two words.
//
// Writes are queued and asynchronous, a few short lines a minute, so they
// never hold up listening. Past WAKE_LOG_MAX_MB the file is renamed to .1
// (replacing the one before) and a new one started. If it can't be written,
// that is logged once and the log turns itself off.
//
// "!luna wakestats" reads it back (summary(sinceMs)): per person, how many of
// their "hey Luna"s she heard and how — see summarizeWakeEvents.
//
// createWakeLog({ config, fs, path, console, nameOf }) → { record(event, userId, fields), summary(sinceMs) }
// fs is require('fs').promises, passed in so the tests can fake it.

function createWakeLog({ config, fs, path, console, nameOf = id => id }) {
  const file = config.WAKE_LOG_FILE;
  const maxBytes = config.WAKE_LOG_MAX_MB * 1024 * 1024;
  let off = !file;
  let size = null;              // bytes in the file, read before the first write
  let queue = Promise.resolve();

  const round = v => typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(3) : v;

  function record(event, userId, fields = {}) {
    if (off) return;
    const entry = { t: new Date().toISOString(), event, who: nameOf(userId), id: userId };
    for (const [k, v] of Object.entries(fields)) entry[k] = round(v);
    const line = JSON.stringify(entry) + '\n';
    queue = queue.then(() => write(line)).catch(err => {
      if (off) return;
      off = true;
      console.warn(`[wake-log] can't write ${file} (${err.message}) — the wake-word log is off until restart`);
    });
  }

  async function write(line) {
    if (off) return;
    if (size === null) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      size = await fs.stat(file).then(s => s.size, () => 0);
    }
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) {
      await fs.rename(file, `${file}.1`);
      size = 0;
    }
    await fs.appendFile(file, line);
    size += bytes;
  }

  // The events since `sinceMs` (from the file and the one before it), summarized.
  async function summary(sinceMs) {
    if (!file) return 'The wake-word log is off (WAKE_LOG_FILE is empty).';
    await queue;                          // what's been recorded so far, written
    const events = [];
    for (const f of [`${file}.1`, file]) {
      const text = await fs.readFile(f, 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (Date.parse(e.t) >= sinceMs) events.push(e);
        } catch (_) { /* a line cut off mid-write */ }
      }
    }
    return summarizeWakeEvents(events);
  }

  return { record, summary };
}

// Per person: their "hey Luna"s — caught by the model (detected), by the
// near-threshold check Whisper confirmed (confirmed), or missed by both and
// caught by the backup (missed) — and how many she answered; the typical
// detection score; near misses. Busiest first, at most 15 people.
function summarizeWakeEvents(events) {
  const people = new Map();
  for (const e of events) {
    const p = people.get(e.id) ?? { who: e.who, detected: 0, confirmed: 0, caught: 0, late: 0, scores: [], near: new Map() };
    p.who = e.who || p.who;
    if (e.event === 'detected') { p.detected++; if (typeof e.score === 'number') p.scores.push(e.score); }
    else if (e.event === 'confirmed') p.confirmed++;
    else if (e.event === 'missed') { if (e.answered === 'yes') p.caught++; else p.late++; }
    else if (e.event === 'near-miss' && e.heard) {
      const heard = e.heard.toLowerCase();
      p.near.set(heard, (p.near.get(heard) || 0) + 1);
    }
    people.set(e.id, p);
  }
  const lines = [];
  const rows = [...people.values()]
    .map(p => ({ ...p, total: p.detected + p.confirmed + p.caught + p.late }))
    .filter(p => p.total || p.near.size)
    .sort((a, b) => b.total - a.total);
  for (const p of rows.slice(0, 15)) {
    const heard = p.detected + p.confirmed + p.caught;
    const how = [p.detected && `model ${p.detected}`, p.confirmed && `near-threshold check ${p.confirmed}`,
      p.caught && `backup ${p.caught}`].filter(Boolean).join(', ');
    let line = `• **${p.who}** — answered ${heard} of ${p.total} "hey Luna"${p.total === 1 ? '' : 's'}`;
    if (how) line += ` (${how})`;
    if (p.late) line += `; ${p.late} caught too late to answer`;
    if (p.scores.length) {
      const sorted = [...p.scores].sort((a, b) => a - b);
      line += `. Typical model score ${sorted[Math.floor(sorted.length / 2)].toFixed(2)}`;
    }
    if (p.near.size) {
      line += `. Near misses: ${[...p.near].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([w, n]) => `"${w}"${n > 1 ? ` ×${n}` : ''}`).join(', ')}`;
    }
    lines.push(line + '.');
  }
  return lines.length ? lines.join('\n') : 'No wake-word events in that time.';
}

module.exports = { createWakeLog, summarizeWakeEvents };
