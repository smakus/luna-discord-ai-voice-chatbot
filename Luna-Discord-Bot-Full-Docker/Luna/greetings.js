// ─── Custom join greetings ────────────────────────────────────────────────────
//
// Per-person greetings, optionally in their own ElevenLabs voice, read from a
// JSON file (GREETINGS_FILE, default local/greetings.json — server-specific,
// so kept out of git and mounted into the container):
//
//   {
//     "371034505349169152": {
//       "name": "User X",                         // for you; not used
//       "voice": "OUBnvvuqEKdDWtapoJFn",          // ElevenLabs voice ID (optional)
//       "phrases": ["Oh my, look who is here, {user}. …"]   // one picked at random
//     }
//   }
//
// Keyed by Discord user ID, which survives renames. {user} and {name} are the
// person's speakable name. Any problem with an entry is reported and that
// entry is skipped; the person then gets the normal greeting.

const fs = require('fs');

// → Map(userId → { name, voice, phrases }). A missing file is no greetings.
function loadCustomGreetings(file, { warn = () => {} } = {}) {
  const greetings = new Map();
  if (!fs.existsSync(file)) return greetings;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    warn(`[greet] ${file} is not valid JSON (${err.message}) — no custom greetings`);
    return greetings;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    warn(`[greet] ${file} should be an object of Discord user IDs — no custom greetings`);
    return greetings;
  }
  for (const [id, entry] of Object.entries(data)) {
    const label = entry?.name ? `${entry.name} (${id})` : id;
    if (!/^\d{5,25}$/.test(id)) { warn(`[greet] "${id}" is not a Discord user ID — skipped`); continue; }
    const phrases = (Array.isArray(entry?.phrases) ? entry.phrases : [entry?.phrases])
      .filter(p => typeof p === 'string' && p.trim()).map(p => p.trim());
    if (!phrases.length) { warn(`[greet] ${label}: no phrases — skipped`); continue; }
    const voice = typeof entry.voice === 'string' && entry.voice.trim() ? entry.voice.trim() : '';
    greetings.set(id, { name: entry.name || '', voice, phrases });
  }
  return greetings;
}

module.exports = { loadCustomGreetings };
