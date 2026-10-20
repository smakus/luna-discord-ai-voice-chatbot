// ─── Phrases ──────────────────────────────────────────────────────────────────
//
// Small helpers for the lines Luna says: picking one of a list of phrases and
// filling in its {placeholders}, and turning a Discord display name into
// something a voice can say.

// A shuffled copy (Fisher–Yates; sorting on a random comparator is biased).
function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// A random phrase from `phrases` with every {key} in `vars` replaced.
function fillPhrase(phrases, vars) {
  let text = phrases[Math.floor(Math.random() * phrases.length)];
  for (const [key, value] of Object.entries(vars)) text = text.replaceAll(`{${key}}`, value);
  return text;
}

// Turns a display name into something a voice can say.
//
// NFKC folds "fancy font" names (𝓢𝓪𝓶, Ｓａｍ) back to plain letters. Emoji and
// symbols are dropped rather than read aloud, separators become spaces, and a
// trailing number tag ("sam_1234") is removed when there is a name before it.
// Returns '' if nothing pronounceable is left.
function speakableName(raw) {
  let name = (raw || '').normalize('NFKC')
    .replace(/[_.]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const withoutTag = name.replace(/[\s-]*\d+$/, '');
  if (/\p{L}/u.test(withoutTag)) name = withoutTag;
  return name.slice(0, 32).trim();
}

module.exports = { shuffle, fillPhrase, speakableName };
