// The answer filter (answer-filter.js): which parts of the LLM's answer Luna
// says, holds or drops.
//   - rules: each state and rule on its own;
//   - fixtures: LM Studio event streams replayed through the real pipeline
//     (index.js sentence splitting → filter → TTS). Recorded ones are real
//     streams with search results and reasoning text removed; "reconstructed"
//     ones rebuild a failure seen in Luna's logs (the model doesn't produce
//     those on demand).
// Run: node --test test/   (see README → Development)
const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs'), path = require('path');
const { createAnswerFilter, stripMarkdown, stripEmoji } = require('../answer-filter');
const boot = require('./harness');

// A filter whose speech and drops are recorded.
function rig(options = {}) {
  const spoken = [], dropped = [];
  const filter = createAnswerFilter({ speak: s => spoken.push(s), drop: (kind, text) => dropped.push([kind, text]), ...options });
  return { filter, spoken, dropped };
}
const TOOL = [{ type: 'tool_call.start' }, { type: 'tool_call.success', output: '[]' }];

describe('answer filter rules', () => {
  it('speaks sentences as they arrive in the normal case', () => {
    const { filter, spoken } = rig();
    filter.event({ type: 'reasoning.start' }); filter.event({ type: 'reasoning.end' });
    assert.strictEqual(filter.text('First.'), 'ok'); assert.deepStrictEqual(spoken, ['First.']);
    filter.text('Second.'); assert.deepStrictEqual(spoken, ['First.', 'Second.']);
    assert.strictEqual(filter.state, 'speaking');
  });

  it('search → reasoning → answer (the normal order) is never held', () => {
    const { filter, spoken } = rig();
    TOOL.forEach(filter.event); filter.event({ type: 'reasoning.start' });
    filter.text('Answer.'); assert.deepStrictEqual(spoken, ['Answer.']);
  });

  it('text straight after a search, with no reasoning, waits; reasoning.start releases it', () => {
    const { filter, spoken } = rig();
    TOOL.forEach(filter.event);
    filter.text('Maybe answer.'); assert.deepStrictEqual(spoken, []); assert.strictEqual(filter.state, 'unsure');
    filter.event({ type: 'reasoning.start' }); assert.deepStrictEqual(spoken, ['Maybe answer.']);
  });

  it('…"</think>" drops it and the text before the tag; what follows is spoken', () => {
    const { filter, spoken, dropped } = rig();
    TOOL.forEach(filter.event);
    filter.text('Draft one.'); filter.text('Draft two.</think>Real answer.');
    assert.deepStrictEqual(spoken, ['Real answer.']);
    assert.deepStrictEqual(dropped, [['leaked reasoning', 'Draft one. Draft two.']]);
    filter.text('More.'); assert.deepStrictEqual(spoken, ['Real answer.', 'More.']);
  });

  it('…and if neither comes, it was the answer: spoken at the end', () => {
    const { filter, spoken } = rig();
    TOOL.forEach(filter.event); filter.text('Straight answer.'); filter.end();
    assert.deepStrictEqual(spoken, ['Straight answer.']);
  });

  it('a search starting drops pending text as narration, in any state', () => {
    for (const holdUntilEnd of [false, true]) {
      const { filter, spoken, dropped } = rig({ reasoning: !holdUntilEnd, holdUntilEnd });
      if (!holdUntilEnd) TOOL.forEach(filter.event);
      filter.text("I'll search for that."); filter.event({ type: 'tool_call.start' });
      filter.event({ type: 'tool_call.success' }); filter.text('The answer.'); filter.end();
      assert.deepStrictEqual(spoken, ['The answer.'], `holdUntilEnd=${holdUntilEnd}`);
      assert.deepStrictEqual(dropped, [['narration', "I'll search for that."]]);
    }
  });

  it('holding: everything waits for the end, in order', () => {
    const { filter, spoken } = rig({ reasoning: false, holdUntilEnd: true });
    filter.text('One.'); filter.text('Two.'); assert.deepStrictEqual(spoken, []);
    filter.end(); assert.deepStrictEqual(spoken, ['One.', 'Two.']);
  });

  it('holding: "</think>" drops everything before it too', () => {
    const { filter, spoken, dropped } = rig({ reasoning: false, holdUntilEnd: true });
    filter.text('Planning.'); filter.text('</think>'); filter.text('Answer.'); filter.end();
    assert.deepStrictEqual(spoken, ['Answer.']); assert.deepStrictEqual(dropped, [['leaked reasoning', 'Planning.']]);
  });

  it('reasoning off: a search does not make the filter unsure', () => {
    const { filter, spoken } = rig({ reasoning: false });
    TOOL.forEach(filter.event); filter.text('Answer.'); assert.deepStrictEqual(spoken, ['Answer.']);
  });

  it('"<think>" in the answer: text before it is spoken, after it waits', () => {
    const { filter, spoken } = rig();
    filter.text('Sure. <think>let me plan'); assert.deepStrictEqual(spoken, ['Sure.']); assert.strictEqual(filter.state, 'unsure');
    filter.text('more planning</think>Done.'); assert.deepStrictEqual(spoken, ['Sure.', 'Done.']);
  });

  it('tags are never spoken; text without letters or digits is ignored', () => {
    const { filter, spoken } = rig({ reasoning: false });
    assert.strictEqual(filter.text('.'), 'ignored');
    filter.text('<think>Hello there.'); filter.text('</think>'); filter.text('Bye. </think>');
    assert.deepStrictEqual(spoken, ['Hello there.']);   // "Bye." precedes a closing tag: reasoning, dropped
  });

  it('a tool call written as text is reported, never spoken', () => {
    const { filter, spoken } = rig();
    assert.strictEqual(filter.text('<tool_call>\n<function=web_search>(x)</function>\n</tool_call>'), 'tool-call-as-text');
    assert.deepStrictEqual(spoken, []);
  });
});

describe('emoji are not spoken', () => {
  const said = text => stripEmoji(text).replace(/\s+/g, ' ').trim();
  const cases = [
    ['get yourself some🍦 scooped', 'get yourself some scooped'],
    ['That is so funny 😂😂', 'That is so funny'],
    ['I love it ❤️ so much', 'I love it so much'],
    ['Nice 👍🏽 work', 'Nice work'],
    ['The coder 👩‍💻 is here', 'The coder is here'],
    ['Go team 🇺🇸!', 'Go team !'],
    ['Option 1️⃣ first', 'Option 1 first'],
    ['Sunny ☀ today', 'Sunny today'],
  ];
  for (const [input, output] of cases) it(`${JSON.stringify(input)} → ${JSON.stringify(output)}`, () => assert.strictEqual(said(input), output));

  it('leaves alone what is not an emoji: accents, tone marks, symbols, numbers, dashes, tags', () => {
    for (const text of ['Café au lait with José.', 'Marshmallow is mián huā táng.', "It's 72° and €5 — or £4.", 'About 1,000 people, 50% of them.', '[laugh] Ha!', 'Tom & Jerry #1 © 2026', 'Acme® and Luna™'])
      assert.strictEqual(stripEmoji(text), text);
  });

  it('the filter speaks the cleaned sentence and reports what the model wrote', () => {
    const raw = [];
    const { filter, spoken } = rig({ cleaned: r => raw.push(r) });
    filter.text('Plain sentence.'); filter.text('Some 🍦 here.'); filter.text('🎉');
    assert.deepStrictEqual(spoken, ['Plain sentence.', 'Some here.']);
    assert.deepStrictEqual(raw, ['Some 🍦 here.']);
  });
});

describe('markdown is not spoken', () => {
  const cases = [
    ['So the 2020 Census had it at **85,239**, but it has been ticking down.', 'So the 2020 Census had it at 85,239, but it has been ticking down.'],
    ['It is *really* good and __very__ fast.', 'It is really good and very fast.'],
    ['_italic_ and _another one_', 'italic and another one'],
    ['Check [the city site](https://example.gov) for details.', 'Check the city site for details.'],
    ['Run `npm test` first.', 'Run npm test first.'],
    ['- **Census (2024):** about 83,000', 'Census (2024): about 83,000'],
    ['## Weather today', 'Weather today'], ['1. First item', 'First item'], ['> Quoted line', 'Quoted line'],
    ['**Hello.', 'Hello.'],                                          // a sentence split inside a bold phrase
  ];
  for (const [input, output] of cases) it(`${JSON.stringify(input)} → ${JSON.stringify(output)}`, () => assert.strictEqual(stripMarkdown(input), output));

  it('leaves alone what is not markdown: audio tags, snake_case, arithmetic', () => {
    for (const text of ['[laughs] That is great.', 'Use the snake_case name.', '5 * 3 = 15']) assert.strictEqual(stripMarkdown(text), text);
  });

  it('applies to everything the filter speaks, held or not; markers alone are not spoken', () => {
    const { filter, spoken } = rig();
    filter.text('**Bold** answer.'); filter.text('**');
    TOOL.forEach(filter.event); filter.text('- *Held* item.'); filter.end();
    assert.deepStrictEqual(spoken, ['Bold answer.', 'Held item.']);
  });
});

// ── Fixture replay through the real pipeline ─────────────────────────────────

const FIXTURES = path.join(__dirname, 'fixtures');
const words = text => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
const answerText = fx => fx.expectSpoken ?? fx.events.filter(e => e.type === 'message.delta').map(e => e.content).join('');

async function replay(fx) {
  const reasoningOff = fx.reasoning === 'off';
  // Reasoning-off fixtures are replayed as Luna's quick-answer retry, where
  // reasoning-off answers happen: a first pass reasons past the thinking
  // limit, then the fixture is the retry.
  const H = boot({ ANNOUNCE_THINKING: 'false', ANNOUNCE_SEARCH: 'false', ANNOUNCE_SELF: 'false',
    QUICK_ANSWER_PHRASES: 'QUICK.', ...(reasoningOff ? { LLM_THINK_LIMIT_MS: '100' } : {}) });
  await H.start(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(50);
  H.S.tts.length = 0;
  const script = fx.events.map(e => [2, e]);
  const firstPass = [[0, { type: 'reasoning.start' }], ...Array(40).fill([10, { type: 'reasoning.delta', content: '…' }])];
  H.S.llmScripts = reasoningOff ? [firstPass, script] : [script];
  await H.T.handleQuery(fx.question, H.S.lastConnection, H.text, Date.now(), 'u1');
  await H.wait(150);
  return { said: H.S.tts.map(t => t.text).filter(t => t !== 'QUICK.'), logs: H.S.logs };
}

describe('recorded and reconstructed LM Studio streams', () => {
  for (const file of fs.readdirSync(FIXTURES).filter(f => f.endsWith('.json')).sort()) {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    const label = `${file.replace('.json', '')} (${fx.reconstructed ? 'reconstructed' : 'recorded'}, reasoning ${fx.reasoning}${fx.search ? ', searched' : ''})`;
    it(`${label}: Luna says exactly the answer`, async () => {
      const { said } = await replay(fx);
      assert.deepStrictEqual(words(said.join(' ')), words(answerText(fx)), `said: ${JSON.stringify(said)}`);
      assert.ok(!said.some(s => /<\/?think>|tool_call/i.test(s)), 'no tags spoken');
      assert.ok(!said.some(s => /\*|`|^#|__/.test(s)), `no markdown spoken: ${JSON.stringify(said)}`);
    });
  }
});
