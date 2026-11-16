// ─── Custom join greetings ────────────────────────────────────────────────────
//
// Per-person greetings, optionally in their own voice (ElevenLabs, or a
// Chatterbox clone), read from a JSON file (GREETINGS_FILE, default
// local/greetings.json — server-specific, so kept out of git and mounted into
// the container):
//
//   {
//     "371034505349169152": {
//       "name": "User X",                         // for you; not used
//       "voice": "OUBnvvuqEKdDWtapoJFn",          // ElevenLabs voice ID, or "chatterbox:<name>" (optional)
//       "phrases": ["Oh my, look who is here, {user}. …",    // one picked at random
//                   { "text": "Make it so, {user}.", "voice": "chatterbox:stewart" }]
//     }
//   }
//
// A phrase can be { "text", "voice" } to be said in a voice of its own; plain
// phrases use the person's voice (or Luna's normal one).
//
// Keyed by Discord user ID, which survives renames. {user} and {name} are the
// person's speakable name. Any problem with an entry is reported and that
// entry is skipped; the person then gets the normal greeting.

const fs = require('fs');

// → Map(userId → { name, voice, phrases: [{ text, voice }] }), each phrase's
// voice already resolved ('' = Luna's normal voice). A missing file is no greetings.
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
    const voice = typeof entry?.voice === 'string' && entry.voice.trim() ? entry.voice.trim() : '';
    const phrases = (Array.isArray(entry?.phrases) ? entry.phrases : [entry?.phrases]).flatMap(p => {
      if (typeof p === 'string') return p.trim() ? [{ text: p.trim(), voice }] : [];
      if (p && typeof p === 'object' && typeof p.text === 'string' && p.text.trim()) {
        const own = typeof p.voice === 'string' && p.voice.trim() ? p.voice.trim() : voice;
        return [{ text: p.text.trim(), voice: own }];
      }
      if (p !== undefined && p !== null) warn(`[greet] ${label}: a phrase should be text or { "text", "voice" } — skipped`);
      return [];
    });
    if (!phrases.length) { warn(`[greet] ${label}: no phrases — skipped`); continue; }
    greetings.set(id, { name: entry.name || '', voice, phrases });
  }
  return greetings;
}

module.exports = { loadCustomGreetings };
