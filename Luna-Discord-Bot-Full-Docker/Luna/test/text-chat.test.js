// Text chat helpers (text-chat.js).
// Run: npm test   (see README → Development)
const { describe, it } = require('node:test');
const assert = require('assert');
const { textQuestion, splitMessage, isSayRequest } = require('../text-chat');

describe('textQuestion', () => {
  const cases = [
    ['Luna, what time is it?', 'what time is it?'],
    ['hey luna what is the weather', 'what is the weather'],
    ['LUNA: tell me a joke', 'tell me a joke'],
    ['<@999> play some jazz', 'play some jazz'],
    ['so <@!999> what do you think?', 'so what do you think?'],
    ['<@999> Luna, hi', 'hi'],
  ];
  for (const [msg, q] of cases) it(JSON.stringify(msg), () => assert.strictEqual(textQuestion(msg, '999'), q));
  it('not for her: no name or mention, "lunar", another mention, commands, nothing after the name', () => {
    for (const msg of ['what is the weather', 'the lunar eclipse was cool', 'hey <@123> look', '!luna', '!luna leave', 'Luna', 'hey luna!', '', null])
      assert.strictEqual(textQuestion(msg, '999'), null, String(msg));
  });
});

describe('splitMessage', () => {
  it('short text stays one message', () => assert.deepStrictEqual(splitMessage('Hello there.'), ['Hello there.']));
  it('long text is cut under the limit at paragraph, line or sentence boundaries', () => {
    const para = 'Sentence one is here. '.repeat(40).trim();            // ~880 chars
    const parts = splitMessage([para, para, para].join('\n\n'), 2000);
    assert.ok(parts.length >= 2 && parts.every(p => p.length <= 2000 && p.endsWith('.')), parts.map(p => p.length).join());
    assert.strictEqual(parts.join(' ').replace(/\s+/g, ' '), [para, para, para].join(' '));
  });
  it('a single huge word is still cut at the limit', () => {
    const parts = splitMessage('x'.repeat(4500), 2000);
    assert.deepStrictEqual(parts.map(p => p.length), [2000, 2000, 500]);
  });
});

describe('isSayRequest', () => {
  it('asks to say something in voice', () => {
    for (const q of ['say hello in Chinese in the voice channel', 'say "hello" in chinese in the audio channel', 'tell everyone in vc that dinner is ready',
      'announce in voice that the game starts', 'whisper goodnight in the voice chat', 'Say hi to Joel in voice'])
      assert.strictEqual(isSayRequest(q), true, q);
  });
  it('ordinary questions are not', () => {
    for (const q of ['how do you say thank you in Japanese?', 'tell me a joke', 'what is a voice actor', 'say something nice', 'read me the news'])
      assert.strictEqual(isSayRequest(q), false, q);
  });
});
