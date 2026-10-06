// Sentence splitting (sentences.js): where Luna's streamed answer is cut into
// sentences for TTS. A wrong cut is audible — the first half gets an
// end-of-sentence tone.
// Run: node --test test/   (see README → Development)
const { describe, it } = require('node:test');
const assert = require('assert');
const { takeSentences, sentenceEnd } = require('../sentences');

const split = text => { const { sentences, rest } = takeSentences(text); return rest.trim() ? [...sentences, rest.trim()] : sentences; };

describe('sentence splitting', () => {
  const cases = [
    ['the live bug: "St." is not a sentence end',
      "Russia has its own charm, the architecture in St. Petersburg is stunning, but the visa process is a headache. Japan is easier.",
      ["Russia has its own charm, the architecture in St. Petersburg is stunning, but the visa process is a headache.", 'Japan is easier.']],
    ['titles', 'Dr. Smith and Mrs. Jones met Mr. Lee. They talked.', ['Dr. Smith and Mrs. Jones met Mr. Lee.', 'They talked.']],
    ['dotted abbreviations', 'The U.S. economy grew, e.g. in jobs, i.e. hiring. It slowed later.', ['The U.S. economy grew, e.g. in jobs, i.e. hiring.', 'It slowed later.']],
    ['times', 'We open at 9 a.m. tomorrow. Come early!', ['We open at 9 a.m. tomorrow.', 'Come early!']],
    ['vs., etc., approx.', 'It was Lakers vs. Celtics, approx. 20,000 fans, food, etc. and more. Great game.', ['It was Lakers vs. Celtics, approx. 20,000 fans, food, etc. and more.', 'Great game.']],
    ['decimals are not ends (unchanged)', 'It costs $403.80 today. Cheap.', ['It costs $403.80 today.', 'Cheap.']],
    ['single-letter initials (unchanged)', 'George W. Bush spoke. Then he left.', ['George W. Bush spoke.', 'Then he left.']],
    ['! and ? end sentences, with closing quotes', 'She said "Wow!" Really? Yes.', ['She said "Wow!"', 'Really?', 'Yes.']],
    ['ordinary words that end sentences still split ("no", "in")', 'The answer is no. Come in. Sit down.', ['The answer is no.', 'Come in.', 'Sit down.']],
  ];
  for (const [name, text, expected] of cases) it(name, () => assert.deepStrictEqual(split(text), expected));

  it('streaming: text ending in an abbreviation waits for more instead of splitting', () => {
    assert.strictEqual(sentenceEnd('the architecture in St.'), -1);
    assert.deepStrictEqual(takeSentences('the architecture in St.'), { sentences: [], rest: 'the architecture in St.' });
    assert.ok(sentenceEnd('That is all.') > 0, 'a normal sentence end splits at once');
  });

  it('a sentence that really ends in an abbreviation is kept with the next one, never lost', () => {
    assert.deepStrictEqual(split('I live in the U.S. It is big.'), ['I live in the U.S. It is big.']);
  });
});
