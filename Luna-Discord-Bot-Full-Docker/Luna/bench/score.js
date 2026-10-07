// ─── Benchmark scoring ────────────────────────────────────────────────────────
//
// Pure functions: whether an answer is right, whether it can be spoken as is,
// and the summary numbers. Used by run.js and report.js; tested in
// test/bench-score.test.js.
//
// The answer scored is the model's raw output, before Luna's answer filter —
// the filter hides some problems (markdown, leaked reasoning), but a model
// that needs less hiding is the better model.

const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALE = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };

// "two hundred and six bones" → "206 bones", "four thousand, one hundred and
// eighty-nine dollars" → "4189 dollars". Answers are written for speech, so
// numbers often come spelled out. Numbers side by side stay apart ("between
// twenty and thirty", "twenty thirty"): "and" or a comma joins only after
// hundred, thousand, million or billion.
function wordsToDigits(text) {
  const tokens = text.split(/([a-z]+)/i);   // words at odd indexes, what lies between them at even
  const out = [];
  let total = 0, current = 0, inNumber = false, afterScale = false, gap = [];
  const end = () => {
    if (inNumber) out.push(String(total + current));
    out.push(...gap);
    total = 0; current = 0; inNumber = false; afterScale = false; gap = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], word = token.toLowerCase();
    if (i % 2 === 0) {
      if (inNumber && (/^[\s-]*$/.test(token) || afterScale && /^,\s*$/.test(token))) gap.push(token);
      else { end(); out.push(token); }
    } else if (inNumber && afterScale && word === 'and') {
      gap.push(token);
    } else if (word in SMALL) {
      const value = SMALL[word];
      if (inNumber && !afterScale && (value >= 10 ? current % 100 !== 0 : current % 10 !== 0)) end();
      current += value; inNumber = true; afterScale = false; gap = [];
    } else if (word in SCALE && inNumber) {
      if (SCALE[word] === 100) current *= 100;
      else { total += current * SCALE[word]; current = 0; }
      afterScale = true; gap = [];
    } else {
      end(); out.push(token);
    }
  }
  end();
  return out.join('');
}

function weekday(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now);
}

// true / false, or null when the question has no answer key.
function isCorrect(answer, expect, { timeZone = 'UTC', now = new Date() } = {}) {
  if (!expect?.length) return null;
  const spoken = answer.toLowerCase();
  const digits = wordsToDigits(spoken);
  return expect.some(pattern => {
    const re = new RegExp(pattern === '$weekday' ? `\\b${weekday(timeZone, now)}\\b` : pattern, 'i');
    return re.test(spoken) || re.test(digits);
  });
}

// Whether the search rule of a question was kept. null when there is none.
function searchOk(searched, rule) {
  if (rule === 'required') return searched;
  if (rule === 'forbidden') return !searched;
  return null;
}

// What would sound wrong read out by TTS. Empty list = fit for voice.
const LONG_WORDS = 150;
const VOICE_CHECKS = [
  ['empty', a => !/[a-z0-9]/i.test(a)],
  ['markdown', a => /\*\*|__|`|^\s{0,3}#{1,6}\s|\[[^\]]+\]\([^)]+\)/m.test(a)],
  ['list', a => /^\s*([-*•]|\d+[.)])\s+\S/m.test(a)],
  ['emoji', a => /\p{Extended_Pictographic}/u.test(a)],
  ['link', a => /https?:\/\/|www\./i.test(a)],
  ['reasoning', a => /<\/?think>|\bthe user (is asking|wants|asked|said)\b|\b(let me|I('ll| will| need to| should)) (search|look (that |it )?up|check|think)\b|\b(draft|response):/i.test(a)],
  ['follow-up', a => /\?["')\s]*$/.test(a.trim())],
  ['long', a => a.split(/\s+/).filter(Boolean).length > LONG_WORDS],
];
function voiceIssues(answer) {
  return VOICE_CHECKS.filter(([, bad]) => bad(answer)).map(([name]) => name);
}

function wordCount(answer) { return answer.split(/\s+/).filter(Boolean).length; }

function median(values) {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function mean(values) {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
// Share of true among true/false values, ignoring null. null when none count.
function rate(values) {
  const v = values.filter(x => x === true || x === false);
  return v.length ? v.filter(Boolean).length / v.length : null;
}

// The checks for one answer. Kept apart from the timings so report.js can
// re-score saved answers after a fix here or in questions.json.
function scoreRun(run, question, { timeZone = 'UTC', now = new Date() } = {}) {
  const answer = run.answer || '';
  return {
    correct: run.error ? false : isCorrect(answer, question?.expect, { timeZone, now }),
    searchOk: run.error ? false : searchOk((run.searches?.length ?? 0) > 0, question?.search),
    voiceIssues: run.error ? ['error'] : voiceIssues(answer),
    words: wordCount(answer),
  };
}

// A run counts as right when its answer matches the key and the search rule
// was kept; null when the question checks neither (opinions, small talk).
function isRight(run) {
  if (run.error) return false;
  if (run.correct == null && run.searchOk == null) return null;
  return run.correct !== false && run.searchOk !== false;
}

// One model's runs → the numbers in the report. `ratingOf(run)` gives the
// personality score of a run, or undefined. The main columns use reasoning
// off when the model was run that way (Luna's setting); `thinking` compares
// the two modes question by question.
function summarize(runs, ratingOf = () => undefined) {
  const modes = [...new Set(runs.map(r => r.mode))];
  const main = modes.includes('off') ? 'off' : modes[0];
  const of = mode => runs.filter(r => r.mode === mode);
  const stats = list => ({
    runs: list.length,
    firstWord: median(list.map(r => r.first_word_s)),
    total: median(list.map(r => r.total_s)),
    tokPerS: median(list.map(r => r.tok_per_s)),
    accuracy: rate(list.map(isRight)),
    voice: rate(list.map(r => r.voiceIssues.length === 0)),
    personality: mean(list.map(ratingOf)),
    rated: list.filter(r => typeof ratingOf(r) === 'number').length,
    errors: list.filter(r => r.error).length,
  });
  const summary = { mode: main, ...stats(of(main)), thinking: null };
  if (modes.includes('off') && modes.includes('on')) {
    const on = stats(of('on'));
    const ids = [...new Set(runs.map(r => r.id))];
    const delays = ids.map(id => {
      const off = median(of('off').filter(r => r.id === id).map(r => r.first_word_s));
      const withThinking = median(of('on').filter(r => r.id === id).map(r => r.first_word_s));
      return off == null || withThinking == null ? null : withThinking - off;
    });
    summary.thinking = {
      delay: mean(delays),
      accuracy: on.accuracy == null || summary.accuracy == null ? null : on.accuracy - summary.accuracy,
      personality: on.personality == null || summary.personality == null ? null : on.personality - summary.personality,
    };
  }
  return summary;
}

module.exports = { wordsToDigits, weekday, isCorrect, searchOk, voiceIssues, wordCount, median, mean, rate, scoreRun, isRight, summarize, LONG_WORDS };
