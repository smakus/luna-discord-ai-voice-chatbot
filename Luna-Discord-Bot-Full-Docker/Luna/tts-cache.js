// ─── Rendered-phrase cache ────────────────────────────────────────────────────
//
// The lines Luna says again and again — the search heads-up, "still thinking"
// fillers, greetings, farewells, her intro, "did you mean to ask me
// something?" — rendered once and kept on disk (TTS_CACHE_DIR, default
// cache/tts; empty turns it off). A repeat then costs no ElevenLabs credits
// and starts at once. Answers are never cached: they're different every time.
//
// The key is the voice (provider, voice ID, model, format) plus the exact text
// sent to it, so a changed voice, model or pronunciation simply misses and is
// rendered afresh. A file is kept only once all of its audio has arrived; a
// line cut off or superseded part-way leaves nothing behind. Past
// TTS_CACHE_MAX_MB the files played least recently are deleted. If the folder
// can't be used, that is logged once and caching turns itself off.
//
// createTtsCache({ dir, maxBytes, fs, console })
//   → { get(voice, text) → Promise<stream|null>, store(voice, text, stream) → stream }
// fs is require('fs'), passed in so the tests can use a temporary folder.

const { PassThrough } = require('stream');
const crypto = require('crypto');
const path = require('path');

function createTtsCache({ dir, maxBytes, fs, console }) {
  let off = !dir || !fs;
  const files = new Map();   // file name -> size, least recently played first
  let total = 0;
  let loading = null;
  let tmpCount = 0;

  function disable(err) {
    if (off) return;
    off = true;
    console.warn(`[tts] phrase cache off — can't use ${dir} (${err.message})`);
  }

  // What's already on disk, oldest first; leftovers of interrupted writes removed.
  function load() {
    return loading ??= (async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      const found = [];
      for (const name of await fs.promises.readdir(dir)) {
        const file = path.join(dir, name);
        if (name.endsWith('.tmp')) { await fs.promises.unlink(file).catch(() => {}); continue; }
        const st = await fs.promises.stat(file).catch(() => null);
        if (st?.isFile()) found.push([name, st.size, st.mtimeMs]);
      }
      found.sort((a, b) => a[2] - b[2]);
      for (const [name, size] of found) { files.set(name, size); total += size; }
    })().catch(disable);
  }

  const nameOf = (voice, text) => crypto.createHash('sha1').update(`${voice}\n${text}`).digest('hex') + '.audio';

  function evict() {
    for (const [name, size] of files) {
      if (total <= maxBytes || files.size <= 1) break;
      files.delete(name);
      total -= size;
      fs.promises.unlink(path.join(dir, name)).catch(() => {});
    }
  }

  // The cached audio for this line in this voice, or null.
  async function get(voice, text) {
    if (off) return null;
    await load();
    const name = nameOf(voice, text);
    if (off || !files.has(name)) return null;
    const size = files.get(name);
    files.delete(name);
    files.set(name, size);                    // now the most recently played
    const file = path.join(dir, name);
    const now = new Date();
    fs.promises.utimes(file, now, now).catch(() => {});
    const stream = fs.createReadStream(file);
    stream.on('error', err => {               // deleted behind our back: forget it
      if (files.delete(name)) total -= size;
      console.warn(`[tts] cached line unreadable (${err.message}) — it will be rendered again next time`);
    });
    return stream;
  }

  // Passes `src` through unchanged, writing a copy that is kept once the
  // whole of it has arrived.
  function store(voice, text, src) {
    if (off || !src) return src;
    const name = nameOf(voice, text);
    const file = path.join(dir, name);
    const tmp = `${file}.${++tmpCount}.tmp`;
    const out = new PassThrough();
    out.on('error', () => {});
    let size = 0;
    let failed = false;
    const sink = fs.createWriteStream(tmp);
    sink.on('error', err => { failed = true; disable(err); });
    const discard = () => { if (!sink.destroyed) sink.destroy(); fs.promises.unlink(tmp).catch(() => {}); };

    src.on('data', chunk => { size += chunk.length; if (!failed) sink.write(chunk); });
    src.on('end', () => sink.end(async () => {
      if (failed || size === 0) return discard();
      try {
        await fs.promises.rename(tmp, file);
        if (files.has(name)) total -= files.get(name);
        files.delete(name);
        files.set(name, size);
        total += size;
        evict();
      } catch (err) {
        discard();
        disable(err);
      }
    }));
    src.on('close', () => { if (!src.readableEnded) discard(); });
    src.pipe(out);
    // The listener stopped (a superseded line): stop downloading it too.
    out.on('close', () => { if (!src.readableEnded) src.destroy(); });
    return out;
  }

  return { get, store };
}

module.exports = { createTtsCache };
