// Web search: the spoken heads-up, the WEB_SEARCH modes, the search integration and its outage fallback.
// Run: npm test   (see docs/DEVELOPMENT.md)
const { assert, boot, ok, sse, BUILTIN, setup, TOOL, FILL, T, isFiller, fillersIn, reasoningDeltas, searchPhase, tavily, found, msg, searched, FAKE, wakeRig, bareRig, MUSIC_CALL, NP, textRig, TOP, MINE, IMG_CALL, PICS, SAY, inVoice, daveSetup, loudChunk, fakeDave, voicecheck } = require('./helpers');
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  console.log('search heads-up (event-driven)');
  // Like LM Studio when the model starts a web search.
  { const H = await setup(); H.S.llmScript = [[50, null], ...TOOL, [100, null], ...sse('It is sunny.')];
    await H.T.handleQuery("what's the weather today", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    assert.ok(BUILTIN.includes(H.S.tts[0].text), 'first TTS is a search phrase'); assert.strictEqual(H.S.tts[1].text, 'It is sunny.');
    assert.deepStrictEqual(H.S.played.filter(Boolean), [H.S.tts[0].text, 'It is sunny.']); assert.ok(H.S.played.includes(undefined), 'chime at the start');
    assert.ok(H.S.sends.includes('🤔 *Luna is thinking...*') && H.S.sends.includes('edit:🔍 *Luna is searching the web...*'));
    ok(`model starts a search → "${H.S.tts[0].text}" said then, status switches to "searching the web"; then the answer`); }
  { const H = await setup(); H.S.llmScript = sse('It is sunny.');
    await H.T.handleQuery("what's the weather today", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['It is sunny.']); assert.ok(!H.S.sends.some(x => /searching/.test(x)));
    ok('search tool offered but not used → no heads-up, status never says searching'); }
  { const H = await setup(); H.S.llmScript = sse('Hello.');
    await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Hello.']); assert.ok(H.S.played.includes(undefined), 'chime played');
    ok('non-search query → no phrase, chime as before'); }
  { const H = await setup({ ANNOUNCE_SEARCH: 'false' }); H.S.llmScript = [...TOOL, ...sse('Sunny.')];
    await H.T.handleQuery("what's the weather today", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Sunny.']); ok('ANNOUNCE_SEARCH=false → no spoken heads-up (status still updates)'); }
  { const H = await setup({ SEARCH_PHRASES: 'Custom one.|Custom two.' }); const seen = new Set();
    for (let k = 0; k < 12; k++) { H.S.tts.length = 0; H.S.llmScript = [...TOOL, ...sse('Ok.')];
      await H.T.handleQuery("what's the price of gold", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(80); seen.add(H.S.tts[0].text); }
    assert.deepStrictEqual([...seen].sort(), ['Custom one.', 'Custom two.']); ok('custom SEARCH_PHRASES used, picked at random'); }
  { const H = await setup(); H.S.llmScript = [...TOOL, ...TOOL, ...sse('Done.')];
    await H.T.handleQuery("what's the weather today", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.strictEqual(H.S.tts.filter(t => BUILTIN.includes(t.text)).length, 1); ok('two tool calls in one question → heads-up said once'); }
  { const H = await setup(); H.S.playMs = 300; H.S.llmScript = [...TOOL, [400, null], ...sse('Old answer.')];
    const p = H.T.handleQuery("what's the weather today", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(80);
    H.T.interruptOwnPlayback('u1'); await p; await H.wait(100);
    assert.ok(!H.S.played.includes('Old answer.')); ok('barge-in during the heads-up → the superseded answer never plays'); }


  console.log('WEB_SEARCH modes');
  { const H = await setup(); H.S.llmRequests.length = 0; H.S.llmScript = sse('Ok.');
    for (const q of ['tell me a joke', 'how are you', 'did UCLA play football today']) { await H.T.handleQuery(q, H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(40); }
    assert.ok(H.S.llmRequests.every(r => r.tools)); assert.ok(H.S.llmRequests.every(r => /never say that you will search/.test(r.system)));
    assert.ok(H.S.logs.some(l => /\[search\] web search: offered on every question/.test(l)));
    ok('default (always): search tool offered on every question, incl. the UCLA one; startup log says so'); }
  { const H = await setup({ WEB_SEARCH: 'off' }); H.S.llmRequests.length = 0; H.S.llmScripts = [sse(FAKE), sse('Best guess.')];
    await H.T.handleQuery("what's the weather today", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(80);
    assert.deepStrictEqual(H.S.llmRequests.map(r => `${r.tools ? 'search' : 'no-search'}:${r.reasoning || 'default'}`), ['no-search:default', 'no-search:off']);
    ok('off: never offered, even after a fake tool call (that falls back to the reasoning-off retry)'); }
  { const H = await setup({ TAVILY_API_KEY: '' }); H.S.llmRequests.length = 0; H.S.llmScript = sse('Ok.');
    await H.T.handleQuery("what's the weather today", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(40);
    assert.ok(!H.S.llmRequests[0].tools); assert.ok(H.S.logs.some(l => /web search: off \(no TAVILY_API_KEY or SEARCH_MCP_PLUGIN\)/.test(l)));
    ok('no TAVILY_API_KEY → search off, logged at startup'); }
  { const H = boot({ WEB_SEARCH: 'sometimes' }); await H.start(); assert.ok(H.S.logs.some(l => /\[config\] WEB_SEARCH="sometimes" is invalid \(expected one of always, keywords, off\) — using the default \("always"\)/.test(l)));
    ok('invalid WEB_SEARCH → warning, always'); }


  console.log('search integration: allowed tools, LM Studio plugin, outage fallback');
  { const H = await setup(); H.S.llmRequests.length = 0; H.S.llmScript = sse('Ok.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(40);
    const i = H.S.llmRequests[0].integrations[0];
    assert.strictEqual(i.type, 'ephemeral_mcp'); assert.deepStrictEqual(i.allowed_tools, ['tavily_search']); assert.match(i.server_url, /tavilyApiKey=test-key/);
    assert.ok(H.S.logs.some(l => /web search: offered on every question \(the model decides\) via Tavily \(connected per request\), tools: tavily_search/.test(l)));
    ok('default: Tavily per request, model shown only tavily_search; startup log says so'); }
  { const H = await setup({ SEARCH_MCP_PLUGIN: 'mcp/tavily', TAVILY_API_KEY: '' }); H.S.llmRequests.length = 0; H.S.llmScript = sse('Ok.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(40);
    assert.deepStrictEqual(H.S.llmRequests[0].integrations, [{ type: 'plugin', id: 'mcp/tavily', allowed_tools: ['tavily_search'] }]);
    assert.ok(H.S.logs.some(l => /via LM Studio plugin mcp\/tavily, tools: tavily_search/.test(l)));
    ok('SEARCH_MCP_PLUGIN=mcp/tavily → LM Studio plugin integration, works with no TAVILY_API_KEY'); }
  { const H = await setup({ SEARCH_TOOLS: 'all' }); H.S.llmRequests.length = 0; H.S.llmScript = sse('Ok.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(40);
    assert.strictEqual(H.S.llmRequests[0].integrations[0].allowed_tools, undefined);
    const H2 = await setup({ SEARCH_TOOLS: 'tavily_search, tavily_extract' }); H2.S.llmRequests.length = 0; H2.S.llmScript = sse('Ok.');
    await H2.T.handleQuery('hi', H2.S.lastConnection, H2.text, Date.now(), 'u1'); await H2.wait(40);
    assert.deepStrictEqual(H2.S.llmRequests[0].integrations[0].allowed_tools, ['tavily_search', 'tavily_extract']);
    ok('SEARCH_TOOLS=all → no restriction; a list → exactly those tools'); }
  { const H = await setup({ SEARCH_PAUSE_MS: '300' }); H.S.llmRequests.length = 0; H.S.mcpDown = true; H.S.llmScript = sse('Answer without search.');
    await H.T.handleQuery("what's the weather today", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(60);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.tools), [true, false]); assert.ok(!/never say that you will search/.test(H.S.llmRequests[1].system));
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Answer without search.']);
    assert.ok(H.S.logs.some(l => /\[search\] search server unavailable .* answering without search; search paused/.test(l)));
    ok('search server down → same question answered without search, search paused (no "trouble" line)');
    H.S.llmRequests.length = 0; H.S.tts.length = 0;
    await H.T.handleQuery('and tomorrow?', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(60);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.tools), [false]); ok('while paused → search not offered at all (no failed connection per question)');
    await H.wait(320); H.S.mcpDown = false; H.S.llmRequests.length = 0;
    await H.T.handleQuery('and next week?', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(60);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.tools), [true]); ok('after SEARCH_PAUSE_MS → search offered again'); }
  { const H = await setup({ SEARCH_PAUSE_MS: '5000' }); H.S.mcpDown = true; H.S.llmRequests.length = 0;
    H.S.llmScripts = [sse(FAKE), sse('Best guess.')];
    await H.T.handleQuery('did UCLA play football today', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(80);
    assert.ok(H.S.llmRequests.every((r, k) => k === 0 || !r.tools), 'no search retry while paused');
    assert.ok(!H.S.tts.some(t => /tool_call/.test(t.text))); ok('fake tool call while search is paused → no search retry'); }

  console.log('ALL PASS'); clearInterval(keepAlive);
})().catch(e => { console.error('FAIL:', e.stack); process.exit(1); });
