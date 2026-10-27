// ─── Sentence splitting ───────────────────────────────────────────────────────
//
// Luna speaks the LLM's answer sentence by sentence, as it streams, so TTS can
// start on the first sentence while the rest is still being written. Each
// sentence is rendered on its own, so a wrong break is audible: TTS gives the
// first half a falling, end-of-sentence tone and starts the rest afresh
// ("the architecture in St." | "Petersburg is stunning").
//
// A boundary is ".", "!" or "?" (plus closing quotes or brackets) followed by
// whitespace or the end of the text so far — except:
//   - decimals ("$403.80"): no digit right before and after;
//   - single-letter initials ("George W. Bush");
//   - abbreviations ("St.", "Dr.", "e.g.", "U.S."): not a boundary. A sentence
//     that really ends in one simply waits for the next sentence, or for the
//     end of the answer — a moment's delay, never a broken phrase.

const BOUNDARY = /(?<!\d)(?<!\b[A-Z])[.!?](?!\d)[\s"')\]]*(?:\s|$)/g;

// Lower-case, without the final dot. Words that are also ordinary sentence
// endings ("no", "am", "in") are deliberately left out.
const ABBREVIATIONS = new Set([
  // titles
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'rev', 'hon', 'gen', 'gov', 'sen', 'rep', 'pres',
  'capt', 'cpt', 'col', 'lt', 'sgt', 'cmdr', 'adm', 'maj',
  // places
  'mt', 'ft', 'ave', 'blvd', 'rd', 'hwy', 'apt', 'ste',
  // business and reference
  'inc', 'ltd', 'co', 'corp', 'dept', 'univ', 'assn', 'bros', 'vs', 'etc', 'approx', 'est', 'vol', 'fig', 'ca',
  // months
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

// Dotted abbreviations: "e.g.", "i.e.", "U.S.", "a.m.", "p.m.", "Ph.D."
const DOTTED = /(?:\b[A-Za-z]{1,2}\.){2,}$/;

function isAbbreviation(textBeforeDot) {
  if (DOTTED.test(textBeforeDot + '.')) return true;
  const word = textBeforeDot.match(/([A-Za-z]+)$/);
  return Boolean(word && ABBREVIATIONS.has(word[1].toLowerCase()));
}

// Index just past the first sentence boundary in text, or -1 if there is none
// yet (keep buffering).
function sentenceEnd(text) {
  BOUNDARY.lastIndex = 0;
  let match;
  while ((match = BOUNDARY.exec(text)) !== null) {
    if (text[match.index] === '.' && isAbbreviation(text.slice(0, match.index))) {
      BOUNDARY.lastIndex = match.index + 1;
      continue;
    }
    return match.index + match[0].length;
  }
  return -1;
}

// Splits off every complete sentence: { sentences, rest }.
function takeSentences(text) {
  const sentences = [];
  let end;
  while ((end = sentenceEnd(text)) !== -1) {
    const sentence = text.slice(0, end).trim();
    text = text.slice(end);
    if (sentence) sentences.push(sentence);
  }
  return { sentences, rest: text };
}

// ─── Audio tags after a sentence's end ───────────────────────────────────────
//
// The model sometimes ends an answer with an audio tag after the last full
// stop: "…bring an umbrella. [chuckles]". Split as usual, "[chuckles]" became
// a sentence of its own, which ElevenLabs refuses (no words: "empty text"),
// and the laugh was lost. A tag-only piece belongs to the sentence before it.
//
// createTagJoiner() holds each finished sentence until something other than
// tags follows it (the next token, usually milliseconds later) or the answer
// ends; a tag-only piece in between is appended to it. A tag that starts the
// next sentence ("[sighs] Oh well.") stays with that one, as before.
//   push(sentences, rest) → sentences to say now (rest: the text so far after them)
//   release()             → the held sentence, now: something other than text
//                           came next (reasoning, a tool call), so no tag will
//   flush(rest)           → the last ones, when the answer (or a message) ends
const TAG_ONLY     = /^\s*(?:\[[^\[\]\n]{1,40}\][\s.!?,]*)+$/;
const PENDING_TAGS = /^\s*(?:\[[^\[\]\n]{0,40}(?:\][\s.!?,]*)?)*$/;   // nothing yet, or only (partial) tags

function createTagJoiner() {
  let held = null;
  return {
    push(sentences, rest) {
      const out = [];
      for (const s of sentences) {
        if (held !== null && TAG_ONLY.test(s)) { held += ' ' + s.trim(); continue; }
        if (held !== null) out.push(held);
        held = s;
      }
      if (held !== null && !PENDING_TAGS.test(rest)) { out.push(held); held = null; }
      return out;
    },
    release() {
      const out = held !== null ? [held] : [];
      held = null;
      return out;
    },
    flush(rest = '') {
      const out = [];
      const last = rest.trim();
      if (held !== null && last && TAG_ONLY.test(last)) out.push(held + ' ' + last);
      else {
        if (held !== null) out.push(held);
        if (last) out.push(last);
      }
      held = null;
      return out;
    },
  };
}

module.exports = { sentenceEnd, takeSentences, createTagJoiner };
