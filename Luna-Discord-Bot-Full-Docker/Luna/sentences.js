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

module.exports = { sentenceEnd, takeSentences, ABBREVIATIONS };
