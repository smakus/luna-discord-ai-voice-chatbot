// Reasoning: the thinking limit and the quick answer, leaked reasoning, narration before searches.
// Run: npm test   (see docs/DEVELOPMENT.md)
const { assert, boot, ok, sse, BUILTIN, setup, TOOL, FILL, T, isFiller, fillersIn, reasoningDeltas, searchPhase, tavily, found, msg, searched, FAKE, wakeRig, bareRig, MUSIC_CALL, NP, textRig, TOP, MINE, IMG_CALL, PICS, SAY, inVoice, daveSetup, loudChunk, fakeDave, voicecheck } = require('./helpers');
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  console.log('thinking limit → quick answer');
  // Like LM Studio: a reasoning burst is bracketed by reasoning.start / reasoning.end.
  { const H = await setup({ LLM_THINK_LIMIT_MS: '300', ANNOUNCE_THINKING: 'false' }); H.S.llmRequests.length = 0; H.S.aborted = 0;
    H.S.llmScripts = [reasoningDeltas(40, 50), sse('Quick answer here.')];
    const t0 = Date.now(); await H.T.handleQuery('why is the sky blue', H.S.lastConnection, H.text, t0, 'u1'); await H.wait(150);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.reasoning), [undefined, 'off']); assert.strictEqual(H.S.aborted >= 1, true);
    const said = H.S.tts.map(t => t.text);
    assert.ok(/overthinking|short version/.test(said[0]), said[0]); assert.strictEqual(said.at(-1), 'Quick answer here.');
    assert.ok(!said.some(t => /train of thought|trouble/.test(t))); assert.ok(H.S.logs.some(l => /no answer after 0.3s of reasoning/.test(l)));
    ok(`model still reasoning at 300ms → cancelled, "${said[0]}", re-asked with reasoning=off, answered (${Date.now() - t0}ms total)`); }
  { const H = await setup({ LLM_THINK_LIMIT_MS: '300' }); H.S.llmRequests.length = 0; H.S.llmScripts = [[...reasoningDeltas(2, 50), ...sse('Started in time.'), ...reasoningDeltas(10, 50), ...sse('Second part.')]];
    await H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.strictEqual(H.S.llmRequests.length, 1); assert.deepStrictEqual(H.S.tts.map(t => t.text).filter(t => /part|time/.test(t)), ['Started in time.', 'Second part.']);
    ok('answer started before the limit → limit no longer applies, nothing cancelled'); }
  { const H = await setup({ LLM_THINK_LIMIT_MS: '0' }); H.S.llmRequests.length = 0; H.S.llmScripts = [[...reasoningDeltas(10, 50), ...sse('Slow but fine.')]];
    await H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.strictEqual(H.S.llmRequests.length, 1); ok('LLM_THINK_LIMIT_MS=0 → never cancelled'); }

  { const H = await setup({ LLM_THINK_LIMIT_MS: '200', ANNOUNCE_THINKING: 'false' }); H.S.llmRequests.length = 0;
    H.S.llmScripts = [reasoningDeltas(30, 50), sse('Quick one.'), sse('.'), sse('Fallback two.'), sse('Normal three.')];
    await H.T.handleQuery('hard question', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    await H.T.handleQuery('empty question', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    await H.T.handleQuery('easy question', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.llmRequests.map(r => `${r.input}:${r.reasoning || 'default'}`),
      ['hard question:default', 'hard question:off', 'empty question:default', 'empty question:off', 'easy question:default']);
    ok('every new question starts with thinking on (model default); "off" is used only for that question\'s retry'); }


  console.log('quick answer: no narration, reuses search results');
  { // The live bug: searched, reasoned past the limit, then the reasoning-off retry narrated around new searches.
    const H = await setup({ LLM_THINK_LIMIT_MS: '300', ANNOUNCE_THINKING: 'false' }); H.S.llmRequests.length = 0;
    H.S.llmScripts = [[...reasoningDeltas(2, 20), ...found('top steam game', { url: 'u1', title: 'SteamDB charts', content: 'Counter-Strike 2 leads with 535K players online.' }),
                       ...found('steam top 100', { url: 'u1', title: 'SteamDB charts', content: 'dup' }, { url: 'u2', title: 'Steam stats', content: 'Dota 2 is second.' }),
                       ...reasoningDeltas(30, 20)],
                      msg('Counter-Strike 2 is number one right now, with about 535 thousand players.')];
    await H.T.handleQuery('what is the number one game right now', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    const retry = H.S.llmRequests[1];
    assert.strictEqual(retry.reasoning, 'off'); assert.strictEqual(retry.tools, false, 'search not offered again');
    assert.ok(retry.input.startsWith('what is the number one game right now\n\nWeb search results already found'), retry.input.slice(0, 120));
    assert.ok(/SteamDB charts: Counter-Strike 2 leads/.test(retry.input) && /Steam stats: Dota 2 is second/.test(retry.input) && !/: dup/.test(retry.input), 'condensed + deduplicated');
    assert.ok(/only the words you will say out loud/.test(retry.system)); assert.ok(!/only the words you will say out loud/.test(H.S.llmRequests[0].system));
    assert.ok(H.S.logs.some(l => /quick answer reuses 2 search result set\(s\)/.test(l)));
    assert.strictEqual(H.S.tts.map(t => t.text).at(-1), 'Counter-Strike 2 is number one right now, with about 535 thousand players.');
    ok('think limit after 2 searches → retry answers from the condensed, deduplicated results: no search offered, "only words to say aloud" instruction'); }
  { // No results yet → the retry may search; its narration around searches is dropped.
    const H = await setup({ LLM_THINK_LIMIT_MS: '200', ANNOUNCE_THINKING: 'false' }); H.S.llmRequests.length = 0;
    H.S.llmScripts = [reasoningDeltas(30, 20),
      [...msg("I'll try to find the current top game. ", 'Let me try searching'), ...found('top game', { url: 'a', title: 'A', content: 'x' }),
       ...msg('The search returned irrelevant results. ', 'Let me try a more targeted search.'), ...found('steamdb', { url: 'b', title: 'B', content: 'y' }),
       ...msg('Counter-Strike 2 is number one. ', 'Dota 2 is second.')]];
    await H.T.handleQuery('what is the number one game right now', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    const said = H.S.tts.map(t => t.text);
    assert.strictEqual(H.S.llmRequests[1].tools, true);
    assert.deepStrictEqual(said.slice(-2), ['Counter-Strike 2 is number one.', 'Dota 2 is second.']);
    assert.ok(!said.some(t => /try to find|try searching|irrelevant|targeted/i.test(t)), said.join(' | ')); // Luna's own search heads-up is expected
    assert.strictEqual(H.S.logs.filter(l => /dropped narration before a search/.test(l)).length, 2);
    ok('no results yet → retry may search; narration before each search (incl. unpunctuated "Let me try searching") dropped, final answer spoken: ' + said.slice(-2).join(' ')); }
  { // Normal (thinking on) answers still stream sentence by sentence, nothing held.
    const H = await setup({ ANNOUNCE_THINKING: 'false' }); H.S.llmRequests.length = 0;
    H.S.llmScripts = [[...msg('First sentence. ', 'Second sentence.'), [400, null]]];
    const p = H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(120);
    assert.ok(H.S.logs.some(l => /Luna sentence: First sentence\./.test(l)), 'spoken before the stream ends'); await p;
    assert.ok(!/only the words you will say out loud/.test(H.S.llmRequests[0].system)); assert.strictEqual(H.S.llmRequests[0].input, 'hi');
    ok('normal answers unchanged: streamed immediately, no extra instruction or context'); }
  { const H = await setup({}); const c = H.T.condenseSearchResults;
    assert.strictEqual(c([{ query: 'q', output: 'plain text result' }]), '- (q) plain text result');
    const many = [...Array(50)].map((_, i) => ({ url: 'u' + i, title: 'T' + i, content: 'x'.repeat(400) }));
    const out = c([{ query: 'q', output: tavily(...many) }]); assert.ok(out.length <= 6000 && out.split('\n').length >= 10, out.length);
    assert.strictEqual(c([{ query: 'q', output: tavily({ url: 'a', title: 'A', content: 'one\n\n  two', raw_content: 'RAW PAGE' }) }]), '- A: one two');
    ok('condenseSearchResults: non-JSON output kept as text, capped at 6000 chars, whitespace collapsed, raw page content never included'); }


  console.log('reasoning leaked into the answer');
  { // The live glitch: search, then the "reasoning" arrives as answer text ending in </think>, then the answer again.
    const H = await setup({ ANNOUNCE_THINKING: 'false', ANNOUNCE_SEARCH: 'false' }); H.S.llmRequests.length = 0;
    H.S.llmScripts = [[...reasoningDeltas(2, 10), ...searched(),
      ...msg('About 20 to 21 seconds. ', 'Researchers at Georgia Tech found 21 seconds. ', '</think>', '\n\nIt sounds silly, but researchers found about 21 seconds. ', "You're in the same league as a jaguar.")]];
    await H.T.handleQuery('how long does it take to pee', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(120);
    const said = H.S.tts.map(t => t.text);
    assert.deepStrictEqual(said, ['It sounds silly, but researchers found about 21 seconds.', "You're in the same league as a jaguar."], said.join(' | '));
    assert.ok(H.S.logs.some(l => /dropped reasoning that leaked into the answer \(not spoken\): About 20 to 21 seconds\. Researchers at Georgia Tech/.test(l)));
    ok('search → answer-like text → "</think>" → answer: only the real answer spoken, the draft dropped and logged, the tag never read aloud'); }
  { // Tag in the middle of a sentence chunk.
    const H = await setup({ ANNOUNCE_THINKING: 'false', ANNOUNCE_SEARCH: 'false' });
    H.S.llmScripts = [[...searched(), ...msg('Draft answer here.</think>Final answer here.')]];
    await H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Final answer here.']);
    ok('"draft.</think>final" in one chunk → only "final" spoken'); }
  { // Normal order: search → reasoning → answer streams immediately.
    const H = await setup({ ANNOUNCE_THINKING: 'false', ANNOUNCE_SEARCH: 'false' });
    H.S.llmScripts = [[...reasoningDeltas(2, 10), ...searched(), ...reasoningDeltas(3, 10), ...msg('First sentence. ', 'Second sentence.'), [400, null]]];
    const p = H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    assert.ok(H.S.logs.some(l => /Luna sentence: First sentence\./.test(l)), 'spoken before the stream ends — not held'); await p; await H.wait(50);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['First sentence.', 'Second sentence.']);
    ok('normal search → reasoning → answer: streamed immediately, nothing held'); }
  { // Suspicious order but no </think>: held, then spoken in full at the end — nothing lost.
    const H = await setup({ ANNOUNCE_THINKING: 'false', ANNOUNCE_SEARCH: 'false' });
    H.S.llmScripts = [[...searched(), ...msg('Straight answer one. ', 'Straight answer two.'), [300, null]]];
    const p = H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(120);
    assert.ok(!H.S.logs.some(l => /Luna sentence: Straight answer one/.test(l)), 'held while it might be leaked reasoning'); await p; await H.wait(50);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Straight answer one.', 'Straight answer two.']);
    ok('answer straight after a search with no reasoning and no </think> → held, then spoken in full at the end'); }
  { // No search: stray tags stripped, nothing held.
    const H = await setup({ ANNOUNCE_THINKING: 'false' });
    H.S.llmScripts = [msg('Hello there. ', '</think> ', 'How are you?')];
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Hello there.', 'How are you?']);
    ok('a stray tag is never read aloud'); }
  { // Reasoning off (quick pass / LLM_REASONING=off): no leak handling, no hold beyond the existing one.
    const H = await setup({ ANNOUNCE_THINKING: 'false', ANNOUNCE_SEARCH: 'false', LLM_REASONING: 'off' });
    H.S.llmScripts = [[...searched(), ...msg('Answer one. ', 'Answer two.'), [300, null]]];
    const p = H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(120);
    assert.ok(H.S.logs.some(l => /Luna sentence: Answer one\./.test(l)), 'reasoning off → not held'); await p;
    ok('reasoning off → post-search answers are not held'); }


  console.log('thinking limit counts reasoning only');
  { const H = await setup({ LLM_THINK_LIMIT_MS: '300', ANNOUNCE_THINKING: 'false' }); H.S.llmRequests.length = 0; H.S.aborted = 0;
    H.S.llmScripts = [[...reasoningDeltas(4, 50), ...searchPhase(300, 2200), ...reasoningDeltas(1, 50), ...sse('USC won 25 to 21.')]];
    const t0 = Date.now(); await H.T.handleQuery("what was the score of the USC game tonight", H.S.lastConnection, H.text, t0, 'u1'); await H.wait(100);
    assert.strictEqual(H.S.llmRequests.length, 1); assert.strictEqual(H.S.aborted, 0);
    assert.ok(H.S.tts.map(t => t.text).includes('USC won 25 to 21.'));
    ok(`200ms reasoning + 2.5s searching/reading + 50ms reasoning, limit 300ms → not cancelled; answered after ${Date.now() - t0}ms`); }
  { const H = await setup({ LLM_THINK_LIMIT_MS: '300', ANNOUNCE_THINKING: 'false' }); H.S.llmRequests.length = 0;
    H.S.llmScripts = [[...reasoningDeltas(4, 50), ...searchPhase(100, 200), ...reasoningDeltas(6, 50), ...sse('Too late.')], sse('Quick.')];
    await H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.reasoning || 'default'), ['default', 'off']);
    assert.ok(H.S.logs.some(l => /no answer after 0.3s of reasoning/.test(l)));
    ok('reasoning bursts before and after a search add up (200 + 300ms > 300ms) → cancelled, quick answer'); }
  { const H = await setup({ ANNOUNCE_THINKING: 'false' }); H.S.llmScripts = [[...searchPhase(50, 2500), ...sse('Done.')]];
    await H.T.handleQuery("what's the weather today", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    assert.ok(H.S.logs.some(l => /\[LLM\] tool: tavily_search \{"query":"usc score"\}/.test(l)));
    assert.ok(H.S.logs.some(l => /\[LLM\] read prompt\/results in 2\.5s/.test(l)));
    ok('tool calls and long reads are logged: ' + H.S.logs.filter(l => /\[LLM\] (tool|read)/.test(l)).map(l => l.replace(/^\[u1\] /, '')).join(' | ')); }
  { const H = await setup({ WEB_SEARCH: 'keywords' }); H.S.llmRequests.length = 0; H.S.llmScript = sse('Ok.');
    await H.T.handleQuery("what's the weather today", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    assert.ok(/never say that you will search/.test(H.S.llmRequests[0].system)); assert.ok(!/never say that you will search/.test(H.S.llmRequests[1].system));
    const H2 = await setup({ ANNOUNCE_SEARCH: 'false' }); H2.S.llmRequests.length = 0; H2.S.llmScript = sse('Ok.');
    await H2.T.handleQuery("what's the weather today", H2.S.lastConnection, H2.text, Date.now(), 'u1'); await H2.wait(50);
    assert.ok(!/never say that you will search/.test(H2.S.llmRequests[0].system));
    ok('"don\'t announce the search" instruction: only when the search tool is offered, and only with Luna\'s own heads-up on'); }


  console.log('ALL PASS'); clearInterval(keepAlive);
})().catch(e => { console.error('FAIL:', e.stack); process.exit(1); });
