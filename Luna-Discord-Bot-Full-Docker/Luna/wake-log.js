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
// createWakeLog({ config, fs, path, console, nameOf }) → { record(event, userId, fields) }
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

  return { record };
}

module.exports = { createWakeLog };
