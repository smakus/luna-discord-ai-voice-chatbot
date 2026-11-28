// Whether to ask the LLM again (answer-retry.js).
// Run: npm test   (see docs/DEVELOPMENT.md)
const { describe, it } = require('node:test');
const assert = require('assert');
const { nextPass } = require('../answer-retry');

// A pass that went fine, with reasoning on and nothing tried yet; each test
// changes what it's about.
const pass = over => ({ answered: true, fakeToolCall: false, thinkLimitHit: false, searched: false, saidAfterSearch: 0,
  useSearch: true, canSearch: true, reasoningOff: false, reasoningRetried: false, freshRetried: false, ...over });

describe('asking again', () => {
  it('an answer → done', () => {
    assert.deepStrictEqual(nextPass(pass({})), { step: 'done', brokeDown: false });
    assert.deepStrictEqual(nextPass(pass({ searched: true, saidAfterSearch: 3 })), { step: 'done', brokeDown: false });
  });
  it('a tool call written as text without the search tool → again with search', () => {
    assert.strictEqual(nextPass(pass({ answered: false, fakeToolCall: true, useSearch: false })).step, 'search');
  });
  it('…but not when search can\'t be offered, or after the fresh retry (it turned search off on purpose)', () => {
    assert.notStrictEqual(nextPass(pass({ answered: false, fakeToolCall: true, useSearch: false, canSearch: false })).step, 'search');
    assert.notStrictEqual(nextPass(pass({ answered: false, fakeToolCall: true, useSearch: false, freshRetried: true })).step, 'search');
  });
  it('no words with reasoning on, or stopped for thinking too long → quick (reasoning off)', () => {
    assert.deepStrictEqual(nextPass(pass({ answered: false })), { step: 'quick', brokeDown: true });
    assert.deepStrictEqual(nextPass(pass({ answered: false, thinkLimitHit: true })), { step: 'quick', brokeDown: false });
  });
  it('broke down after starting, or with reasoning already off → a fresh conversation', () => {
    assert.deepStrictEqual(nextPass(pass({ fakeToolCall: true })), { step: 'fresh', brokeDown: true });
    assert.deepStrictEqual(nextPass(pass({ searched: true, saidAfterSearch: 0 })), { step: 'fresh', brokeDown: true });
    assert.deepStrictEqual(nextPass(pass({ answered: false, reasoningOff: true })), { step: 'fresh', brokeDown: true });
  });
  it('each retry at most once: after the fresh or quick retry a breakdown is final', () => {
    assert.deepStrictEqual(nextPass(pass({ fakeToolCall: true, freshRetried: true })), { step: 'done', brokeDown: true });
    assert.deepStrictEqual(nextPass(pass({ answered: false, reasoningOff: true, reasoningRetried: true })), { step: 'done', brokeDown: true });
  });
});
