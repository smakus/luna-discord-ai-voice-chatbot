// LLM benchmark (bench/): the scoring helpers, the question file, and the
// shared system prompt (prompt.js) the benchmark sends.
// Run: npm test   (see README → Development)
const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { wordsToDigits, isCorrect, searchOk, voiceIssues, median, mean, rate, isRight, summarize } = require('../bench/score');
const { systemPrompt, todayLine, SEARCH_PROMPT, QUICK_PROMPT } = require('../prompt');

describe('spoken numbers', () => {
  const cases = [
    ['two hundred and six bones', '206 bones'],
    ['about three hundred eighty-four thousand kilometers', 'about 384000 kilometers'],
    ['twelve dollars and sixty cents', '12 dollars and 60 cents'],
    ['four slices each, and four left over', '4 slices each, and 4 left over'],
    ['one hundred twenty-eight ounces', '128 ounces'],
    ['nothing to see', 'nothing to see'],
    ['twenty-one seconds.', '21 seconds.'],
    ['it is four!', 'it is 4!'],
    ['between twenty and thirty seconds', 'between 20 and 30 seconds'],
    ['four thousand, one hundred and eighty-nine dollars', '4189 dollars'],
    ['two thousand, which is a lot', '2000, which is a lot'],
  ];
  for (const [spoken, digits] of cases) it(`"${spoken}"`, () => assert.strictEqual(wordsToDigits(spoken), digits));
});

describe('answer key', () => {
  const questions = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'questions.json'), 'utf8')).questions;
  const q = id => questions.find(x => x.id === id).expect;
  it('accepts digits or words', () => {
    assert.strictEqual(isCorrect('There are 206 bones.', q('bones')), true);
    assert.strictEqual(isCorrect('An adult has two hundred and six bones!', q('bones')), true);
    assert.strictEqual(isCorrect('Around 300 bones.', q('bones')), false);
    assert.strictEqual(isCorrect('It fell in nineteen eighty-nine.', q('berlin-wall')), true);
    assert.strictEqual(isCorrect('About 384,400 kilometers away.', q('moon')), true);
    assert.strictEqual(isCorrect('On average about 384 000 km away.', q('moon')), true);
    assert.strictEqual(isCorrect('Roughly two hundred thirty-nine thousand miles.', q('moon')), true);
    assert.strictEqual(isCorrect('That comes to twelve dollars and sixty cents.', q('tip')), true);
    assert.strictEqual(isCorrect('A tip of $12.60.', q('tip')), true);
    assert.strictEqual(isCorrect('About twenty-one seconds, believe it or not.', q('pee')), true);
    assert.strictEqual(isCorrect("It's sunny and 72 degrees.", q('weather')), true);
    assert.strictEqual(isCorrect("It's sunny and warm.", q('weather')), false);
  });
  it('$weekday is today\'s weekday where Luna is', () => {
    const now = new Date('2026-10-06T03:00:00Z');   // Monday evening in Los Angeles, Tuesday in UTC
    assert.strictEqual(isCorrect("It's Monday!", ['$weekday'], { timeZone: 'America/Los_Angeles', now }), true);
    assert.strictEqual(isCorrect("It's Tuesday!", ['$weekday'], { timeZone: 'America/Los_Angeles', now }), false);
  });
  it('no key → null', () => assert.strictEqual(isCorrect('Cats, obviously.', undefined), null));
  it('search rules', () => {
    assert.strictEqual(searchOk(true, 'required'), true);
    assert.strictEqual(searchOk(false, 'required'), false);
    assert.strictEqual(searchOk(true, 'forbidden'), false);
    assert.strictEqual(searchOk(true, undefined), null);
  });
});

describe('question file', () => {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'questions.json'), 'utf8'));
  it('ids are unique, kinds and search rules known, every regex compiles', () => {
    const ids = file.questions.map(q => q.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    for (const q of file.questions) {
      assert.ok(['chat', 'fact', 'math', 'search', 'opinion', 'wake', 'date'].includes(q.kind), q.id);
      assert.ok([undefined, 'required', 'forbidden'].includes(q.search), q.id);
      assert.ok(q.q && typeof q.q === 'string', q.id);
      for (const re of q.expect ?? []) if (re !== '$weekday') assert.doesNotThrow(() => new RegExp(re, 'i'), `${q.id}: ${re}`);
    }
  });
});

describe('voice fitness', () => {
  it('a plain spoken answer passes', () => {
    assert.deepStrictEqual(voiceIssues("I'm doing great, thanks for asking! It's been a lovely day so far."), []);
  });
  const cases = [
    ['**Canberra** is the capital.', 'markdown'],
    ['Here you go:\n- one\n- two', 'list'],
    ['Steps:\n1. Do this', 'list'],
    ["I'm great 😊", 'emoji'],
    ['See https://example.com for more.', 'link'],
    ['The user is asking about the weather. It is sunny.', 'reasoning'],
    ['</think>It is sunny.', 'reasoning'],
    ['Let me search for that. It is sunny.', 'reasoning'],
    ['It is sunny. Anything else I can help with?', 'follow-up'],
    ['', 'empty'],
    ['word '.repeat(200), 'long'],
  ];
  for (const [answer, issue] of cases) {
    it(`${issue}: ${JSON.stringify(answer.slice(0, 40))}`, () => assert.ok(voiceIssues(answer).includes(issue), voiceIssues(answer).join()));
  }
  it('a joke that asks and answers is not a follow-up', () => {
    assert.deepStrictEqual(voiceIssues("Why don't skeletons fight? They don't have the guts."), []);
  });
});

describe('summary', () => {
  it('median, mean and rate skip missing values', () => {
    assert.strictEqual(median([3, null, 1, 2]), 2);
    assert.strictEqual(median([1, 2, 3, 4]), 2.5);
    assert.strictEqual(median([]), null);
    assert.strictEqual(mean([1, null, 3]), 2);
    assert.strictEqual(rate([true, false, null, true, false]), 0.5);
    assert.strictEqual(rate([null]), null);
  });
  it('right = answer key and search rule both kept', () => {
    assert.strictEqual(isRight({ correct: true, searchOk: null }), true);
    assert.strictEqual(isRight({ correct: true, searchOk: false }), false);
    assert.strictEqual(isRight({ correct: null, searchOk: null }), null);
    assert.strictEqual(isRight({ correct: null, searchOk: true, error: 'HTTP 500' }), false);
  });
  const run = (id, mode, first, correct, extra = {}) =>
    ({ id, mode, first_word_s: first, total_s: first + 2, tok_per_s: 40, correct, searchOk: null, voiceIssues: [], answer: `${id} ${mode} ${first}`, ...extra });
  it('thinking delay is the mean per-question difference in first word, on minus off', () => {
    const runs = [
      run('a', 'off', 1, true), run('a', 'off', 3, true), run('a', 'on', 12, true), run('a', 'on', 14, true),   // +11
      run('b', 'off', 8, false), run('b', 'on', 25, true),                                                     // +17
      run('c', 'off', 2, null, { voiceIssues: ['markdown'] }), run('c', 'on', 2, null),
    ];
    const s = summarize(runs, r => (r.id === 'c' ? (r.mode === 'off' ? 3 : 5) : undefined));
    assert.strictEqual(s.mode, 'off');
    assert.strictEqual(s.firstWord, 2.5);          // median of 1, 3, 8, 2
    assert.strictEqual(s.thinking.delay, (11 + 17 + 0) / 3);
    assert.strictEqual(s.accuracy, 2 / 3);
    assert.strictEqual(s.thinking.accuracy, 1 - 2 / 3);
    assert.strictEqual(s.voice, 3 / 4);
    assert.strictEqual(s.personality, 3);
    assert.strictEqual(s.rated, 1);
    assert.strictEqual(s.thinking.personality, 2);
  });
  it('a model that cannot turn reasoning off has no thinking column', () => {
    const s = summarize([run('a', 'on', 20, true)]);
    assert.strictEqual(s.mode, 'on');
    assert.strictEqual(s.thinking, null);
  });
});

describe('system prompt (prompt.js)', () => {
  const config = { LM_PERSONALITY: 'fun and helpful', LM_CONCISE: false };
  const now = new Date('2026-10-06T03:00:00Z');
  it('the date is where Luna is, not where the container is', () => {
    assert.strictEqual(todayLine('America/Los_Angeles', now), 'Today is Monday, October 5, 2026 (America/Los_Angeles time).');
  });
  it('parts in order: stable first, flavor last; empty parts leave no gaps', () => {
    const p = systemPrompt({ config, timeZone: 'UTC', now, expressive: 'EXPR.', search: true, extra: QUICK_PROMPT, flavor: 'FLAVOR.' });
    assert.ok(p.startsWith('You are Luna, a fun and helpful voice assistant'));
    const at = s => p.indexOf(s);
    assert.ok(at('Today is') < at('EXPR.') && at('EXPR.') < at(SEARCH_PROMPT) && at(SEARCH_PROMPT) < at(QUICK_PROMPT) && at(QUICK_PROMPT) < at('FLAVOR.'));
    assert.ok(p.endsWith(' FLAVOR.'));
    const plain = systemPrompt({ config, timeZone: 'UTC', now });
    assert.ok(plain.endsWith('(UTC time).') && !plain.includes('  '));
  });
});
