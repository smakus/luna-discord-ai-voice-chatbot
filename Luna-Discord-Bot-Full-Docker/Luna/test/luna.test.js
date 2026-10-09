// Luna's core behaviour: capture, wake word, LLM streaming, playback, voice recovery.
// Run: node --test test/   (see README → Development)
const assert = require('assert'), boot = require('./harness');
const ok = m => console.log('  ✓ ' + m);
const keepAlive = setInterval(() => {}, 1000);
const sse = (...sentences) => sentences.map(s => [5, { type: 'message.delta', content: s + ' ' }]);

(async () => {
  console.log('startup guard (item 4)');
  { const H = boot(); H.S.wakeLoadMs = 100; H.put('u1', 'A'); H.T.client.emit('ready');
    await H.luna('u1'); assert.match(H.S.replies.at(-1), /Still starting up/); assert.strictEqual(H.T.activeConnection, null);
    await H.wait(150); assert.strictEqual(H.T.ready, true);
    await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(5);
    assert.match(H.S.replies.at(-1), /Joined \*\*A\*\*/); ok('!luna before models load → "Still starting up"; after → joins'); }

  console.log('channel tracking (item 1)');
  { const H = boot(); await H.start(); H.put('u1', 'A'); H.put('u2', 'B');
    await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(5);
    await H.luna('u1'); assert.match(H.S.replies.at(-1), /Already listening in \*\*A\*\*/); ok('second !luna in same channel → "Already listening"');
    await H.luna('u2'); assert.match(H.S.replies.at(-1), /Moved to \*\*B\*\*/); assert.strictEqual(H.T.activeVoiceChannel.id, 'B'); ok('!luna from channel B → moves, reports B, tracks B');
    H.move('u1', 'A', null); await H.wait(5); assert.deepStrictEqual(H.S.destroyed, []); ok('old channel A emptying no longer disconnects her');
    H.move('u2', 'B', null); await H.wait(5); assert.deepStrictEqual(H.S.destroyed, ['B']); assert.strictEqual(H.T.activeConnection, null); ok('last user leaving B (where she is) → disconnects');
  }
  { const H = boot(); await H.start(); H.put('u1', 'A'); H.put('u3', 'C');
    await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(5);
    H.move('luna', 'A', 'C'); assert.strictEqual(H.T.activeVoiceChannel.id, 'C'); assert.deepStrictEqual(H.S.destroyed, []); ok('admin drags Luna to C (occupied) → tracks C');
    H.move('luna', 'C', 'D'); await H.wait(5); assert.deepStrictEqual(H.S.destroyed, ['A']); assert.strictEqual(H.T.activeConnection, null); ok('dragged into an empty channel → leaves'); }

  console.log('connection loss (item 2)');
  { const H = boot(); await H.start(); H.put('u1', 'A');
    await H.luna('u1'); const c1 = H.S.lastConnection; c1.setStatus(H.Status.Ready); await H.wait(5);
    c1.setStatus(H.Status.Disconnected); await H.wait(50); c1.setStatus(H.Status.Connecting); await H.wait(250);
    assert.strictEqual(H.T.activeConnection, c1); assert.deepStrictEqual(H.S.destroyed, []); ok('brief drop that reconnects → kept');
    c1.setStatus(H.Status.Disconnected); await H.wait(300);
    assert.deepStrictEqual(H.S.destroyed, ['A']); assert.strictEqual(H.T.activeConnection, null); assert.strictEqual(H.T.activeVoiceChannel, null); ok('kicked / lost for good → destroyed and state reset');
    await H.luna('u1'); assert.notStrictEqual(H.S.lastConnection, c1); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(5);
    assert.match(H.S.replies.at(-1), /Joined \*\*A\*\*/); ok('next !luna starts a fresh connection cleanly'); }

  console.log('status message off the critical path (item 5)');
  { const H = boot(); await H.start(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready);
    await H.wait(5); H.S.tts.length = 0; H.S.sendMs = 300; H.S.llmScript = sse('Hello there.');
    const t0 = Date.now(); const p = H.T.handleQuery('hi', H.S.lastConnection, H.text, t0, 'u1');
    await H.wait(30); assert.ok(H.S.llmRequests.length === 1 && H.S.llmRequests[0].at - t0 < 100, 'LLM called before send finished');
    await p; await H.wait(30); assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Hello there.']);
    ok(`LLM request sent ${H.S.llmRequests[0].at - t0}ms after the query, while the status message took 300ms to post`);
    await H.wait(350); assert.ok(H.S.sends.some(s => s.startsWith('deleted:'))); ok('status message still deleted once it exists'); }

  console.log('TTS lookahead + cancel on interrupt (item 6)');
  { const H = boot(); await H.start(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(5);
    H.S.tts.length = 0; H.S.playMs = 200; H.S.llmScript = sse('One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.');
    const p = H.T.handleQuery('long answer', H.S.lastConnection, H.text, Date.now(), 'u1');
    await H.wait(120);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['One.', 'Two.', 'Three.']); ok('6 sentences generated, only 3 synthesised while sentence 1 plays (lookahead 2)');
    await H.wait(220); assert.strictEqual(H.S.tts.length, 4); ok('window slides: sentence 4 requested when sentence 2 starts');
    H.T.interruptOwnPlayback('u1'); await H.wait(30);
    assert.ok(H.S.tts.every(t => t.signal.aborted)); const unplayed = H.S.tts.filter(t => !H.S.played.includes(t.text));
    assert.ok(unplayed.length >= 1 && unplayed.every(t => t.destroyed || t.signal.aborted)); assert.strictEqual(H.S.tts.length, 4);
    ok(`interrupt → pending requests aborted, ${unplayed.length} fetched-but-unplayed clip(s) discarded, Five/Six never synthesised`);
    await p; }
  { const H = boot({ TTS_LOOKAHEAD: '5' }); await H.start(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(5);
    H.S.tts.length = 0; H.S.playMs = 200; H.S.llmScript = sse('Alpha.', 'Bravo.', 'Charlie.', 'Delta.', 'Echo.', 'Foxtrot.', 'Golf.', 'Hotel.');
    H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(120); assert.strictEqual(H.S.tts.length, 6); ok('TTS_LOOKAHEAD=5 → 6 in flight'); }

  console.log('LLM timeouts');
  { const H = boot({ LM_IDLE_TIMEOUT_MS: '200' }); await H.start(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(5);
    H.S.tts.length = 0;
    H.S.llmScript = [...Array(8)].map(() => [100, { type: 'reasoning.delta', content: 'hmm' }]).concat(sse('Done thinking.'));
    await H.T.handleQuery('hard', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(20);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Done thinking.']); ok('800ms of reasoning with idle limit 200ms → not aborted (activity resets it)');
    H.S.tts.length = 0; H.S.llmScript = [...sse('First part.'), [1000, null]];
    await H.T.handleQuery('stall', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(20);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['First part.']); assert.ok(H.S.logs.some(l => /sent nothing for 0.2s/.test(l)));
    ok('stall after partial answer → aborted after idle limit, no "trouble" line tacked on');
    H.S.tts.length = 0; H.S.llmScript = [[1000, null]];
    await H.T.handleQuery('silent', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(20);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Sorry, that took too long to work out.']); ok('stall before any answer → "Sorry, that took too long to work out."'); }
  { const H = boot({ LM_TIMEOUT_MS: '300', LM_IDLE_TIMEOUT_MS: '5000' }); await H.start(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(5);
    H.S.tts.length = 0; H.S.llmScript = [...Array(20)].map(() => [50, { type: 'reasoning.delta', content: '.' }]);
    const t0 = Date.now(); await H.T.handleQuery('endless', H.S.lastConnection, H.text, t0, 'u1');
    assert.ok(Date.now() - t0 < 700); ok('overall LM_TIMEOUT_MS still caps a request that never stops trickling'); }

  console.log('model re-resolve (item 3)');
  { const H = boot(); await H.start(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(5);
    H.S.model = 'model-b'; H.S.tts.length = 0; H.S.llmRequests.length = 0; H.S.llmScript = sse('Switched fine.');
    await H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(20);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.model), ['model-a', 'model-b']); assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Switched fine.']);
    assert.strictEqual(H.T.model, 'model-b'); ok('model switched in LM Studio → 404, re-resolved, retried once, answered'); }


  console.log('search heads-up (event-driven)');
  const BUILTIN = ['Let me search for that.', '[curious] Hmm, let me take a look.', "One sec, I'll check the web.", '[thoughtful] Good question. Let me look that up.', 'Hang on, let me find out.'];
  const setup = async (env = {}) => { const H = boot(env); await H.start(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(150);
    H.S.tts.length = 0; H.S.played.length = 0; H.S.sends.length = 0; H.S.playMs = 30; return H; };
  // Like LM Studio when the model starts a web search.
  const TOOL = [[5, { type: 'tool_call.start' }], [5, { type: 'tool_call.arguments', tool: 'tavily_search', arguments: { query: 'weather' } }], [0, { type: 'tool_call.success', tool: 'tavily_search' }]];
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


  console.log('"still thinking" fillers');
  const FILL = ['Still thinking.', '[thoughtful] Hmm, give me a moment.', 'Almost there, bear with me.', "This one's taking a bit. Hang tight.", 'Just a little longer.'];
  const T = { THINKING_WAITS: '0.1-0.1', THINKING_MAX: '3' };
  const isFiller = t => FILL.includes(t) || /^Custom/.test(t) || /still working on that|Still on it,/.test(t);
  const fillersIn = H => H.S.tts.map(t => t.text).filter(isFiller);
  { const H = await setup(T); H.S.llmScript = [[900, null], ...sse('Finally.')];
    await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    const f = fillersIn(H);
    assert.strictEqual(f.length, 3); assert.strictEqual(new Set(f).size, 3); assert.deepStrictEqual(H.S.played.filter(x => x).slice(-1), ['Finally.']);
    ok(`900ms wait → 3 fillers, no repeats (${f.map(x => JSON.stringify(x)).join(', ')}), then the answer`); }
  { const H = await setup(T); H.S.llmScript = [[180, null], ...sse('Here you go.')];
    const t0 = Date.now(); await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, t0, 'u1'); await H.wait(400);
    assert.strictEqual(fillersIn(H).length, 1); ok('answer at ~185ms → exactly 1 filler (at 100ms); the one due at 200ms is never said'); }
  { const H = await setup(T); H.S.llmScript = sse('Quick.');
    await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(400);
    assert.strictEqual(fillersIn(H).length, 0); ok('fast answer → no filler'); }
  { const H = await setup({ ...T, ANNOUNCE_THINKING: 'false' }); H.S.llmScript = [[600, null], ...sse('Done.')];
    await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.strictEqual(fillersIn(H).length, 0); ok('ANNOUNCE_THINKING=false → no fillers'); }
  { const H = await setup({ ...T, THINKING_PHRASES: 'Custom A.|Custom B.' }); H.S.llmScript = [[700, null], ...sse('Done.')];
    await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    const f = fillersIn(H); assert.strictEqual(f.length, 3); assert.ok(f.every(x => /^Custom/.test(x)));
    assert.notStrictEqual(f[0], f[1]); ok('custom THINKING_PHRASES used; cycles without back-to-back repeats when fewer phrases than fillers'); }
  { const H = await setup(T); H.S.llmScript = [[900, null], ...sse('Old.')];
    const p = H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(130);
    H.T.interruptOwnPlayback('u1'); await p; await H.wait(100);
    assert.strictEqual(fillersIn(H).length, 1); assert.ok(!H.S.played.includes('Old.')); ok('barge-in → fillers stop, superseded answer never plays'); }
  { const H = await setup(T); H.S.llmScript = [...TOOL, [600, null], ...sse('Searched answer.')];
    await H.T.handleQuery("what's the weather today", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    const texts = H.S.tts.map(t => t.text);
    assert.ok(BUILTIN.includes(texts[0])); assert.ok(fillersIn(H).length >= 2); assert.strictEqual(texts.at(-1), 'Searched answer.');
    ok('search heads-up first, then fillers, then the answer'); }
  { // filler queued behind another speaker's long answer, and the answer arrives meanwhile → filler skipped
    const H = await setup(T); H.put('u2', 'A');
    H.S.playMs = 500; H.S.llmScript = sse('Other speaker sentence one.');
    H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u2'); await H.wait(40);
    H.S.llmScript = [[180, null], ...sse('Mine.')];
    await H.T.handleQuery('tell me a story', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(1200);
    assert.ok(!H.S.played.some(isFiller), 'filler not played'); assert.ok(H.S.played.includes('Mine.'));
    ok("filler waiting behind another speaker's answer is skipped once the answer has arrived"); }



  console.log('filler timing + personal fillers');
  { const gaps = [];
    for (let run = 0; run < 3; run++) {
      const H = await setup({ THINKING_WAITS: '0.06-0.16', THINKING_MAX: '3' });
      const stamps = []; const orig = H.S.tts.push.bind(H.S.tts);
      H.S.tts.push = r => { if (isFiller(r.text)) stamps.push(Date.now()); return orig(r); };
      H.S.llmScript = [[700, null], ...sse('Done.')];
      const t0 = Date.now(); await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, t0, 'u1'); await H.wait(50);
      let prev = t0; for (const st of stamps) { gaps.push(st - prev); prev = st; }
    }
    assert.ok(gaps.length >= 6); assert.ok(gaps.every(g => g >= 55 && g <= 200), 'gaps in range: ' + gaps);
    assert.ok(new Set(gaps.map(g => Math.round(g / 10))).size > 2, 'gaps vary');
    ok(`each wait random within 60–160ms (single window): ${gaps.join(', ')} ms`); }
  { const H = await setup({ ...T, THINKING_PHRASES: "Hey {name}, I'm still working on that. I didn't forget about you." }); H.S.names = { u1: '𝓢𝓪𝓶 ✨' };
    H.put('u1', 'A'); H.S.llmScript = [[150, null], ...sse('Done.')];
    await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    assert.deepStrictEqual(fillersIn(H), ["Hey Sam, I'm still working on that. I didn't forget about you."]);
    ok('{name} → asker\'s cleaned-up display name: ' + JSON.stringify(fillersIn(H)[0])); }
  { const H = await setup({ ...T, THINKING_PHRASES: 'Still on it, {name}.|Generic filler.' }); H.S.names = { u1: '🎮🎮' }; H.put('u1', 'A');
    H.S.llmScript = [[350, null], ...sse('Done.')];
    await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    const f = H.S.tts.map(t => t.text).filter(t => /filler|Still on it/.test(t));
    assert.ok(f.length >= 2 && f.every(x => x === 'Generic filler.')); ok('unpronounceable name → personal phrases skipped, generic ones used'); }
  { const H = await setup({ ...T, THINKING_PHRASES: 'Still on it, {name}.' }); H.S.names = { u1: '🎮' }; H.put('u1', 'A');
    H.S.llmScript = [[350, null], ...sse('Done.')];
    await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    assert.ok(!H.S.tts.some(t => /Still on it/.test(t.text))); ok('only personal phrases + unpronounceable name → no filler, no crash'); }
  { const H = await setup({ ...T, THINKING_MAX: '1' }); H.S.names = { u1: 'Sam' }; H.put('u1', 'A');
    let personal = 0, generic = 0;
    for (let k = 0; k < 40; k++) { H.S.tts.length = 0; H.S.llmScript = [[130, null], ...sse('Ok.')];
      await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u1');
      const f = fillersIn(H)[0]; if (/Sam/.test(f)) personal++; else if (f) generic++; }
    assert.ok(personal >= 3 && generic >= personal, `personal ${personal}, generic ${generic}`);
    ok(`default list over 40 waits: ${personal} personal, ${generic} generic (expected ~2 in 7 personal)`); }


  console.log('filler timing v2: 15–22 s, no cap, reshuffled passes');
  { const H = boot(); assert.deepStrictEqual(JSON.parse(JSON.stringify(H.T.THINKING)), { waits: [[15000, 22000], [22000, 30000], [30000, 40000]], cap: 0 }); ok('defaults: 15–22 s, then 22–30 s, then 30–40 s; no cap'); }
  { const H = await setup({ THINKING_WAITS: '0.04-0.06', THINKING_PHRASES: 'P1.|P2.|P3.' });
    H.S.llmScript = [[900, null], ...sse('Done.')];
    await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    const f = H.S.tts.map(t => t.text).filter(t => /^P\d\.$/.test(t));
    assert.ok(f.length >= 12, 'uncapped: ' + f.length);
    for (let k = 0; k + 3 <= f.length; k += 3) assert.strictEqual(new Set(f.slice(k, k + 3)).size, 3, 'each pass uses every phrase once');
    for (let k = 1; k < f.length; k++) assert.notStrictEqual(f[k], f[k - 1], 'no back-to-back repeat');
    ok(`900ms wait, 40–60ms gaps → ${f.length} fillers (no cap); every pass of 3 uses all phrases; no back-to-back repeats`);
    const tags = H.S.logs.map(l => l.match(/\[thinking \+([\d.]+)s\]/)).filter(Boolean).map(m => +m[1]);
    assert.ok(tags.length === f.length && tags.every(t => t >= 0 && t <= 0.1), "tags: " + tags); ok('each filler log line carries its wait, e.g. ' + H.S.logs.find(l => /\[thinking \+/.test(l)).replace(/^\[u1\] /, '')); }
  { const H = await setup({ THINKING_WAITS: '0.03-0.03', THINKING_MAX: '2' });
    H.S.llmScript = [[400, null], ...sse('Done.')];
    await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    assert.strictEqual(fillersIn(H).length, 2); ok('THINKING_MAX=2 still caps when set'); }
  { const H = await setup({ THINKING_WAITS: '0.04-0.04', THINKING_PHRASES: 'Only one.' });
    H.S.llmScript = [[300, null], ...sse('Done.')];
    await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    assert.ok(H.S.tts.filter(t => t.text === 'Only one.').length >= 5); ok('a single phrase simply repeats (nothing else to alternate with)'); }


  console.log('filler back-off');
  { const H = await setup({ THINKING_WAITS: '0.05-0.05,0.1-0.1,0.2-0.2' }); const stamps = [];
    const orig = H.S.tts.push.bind(H.S.tts); H.S.tts.push = r => { if (isFiller(r.text)) stamps.push(Date.now()); return orig(r); };
    H.S.llmScript = [[900, null], ...sse('Done.')];
    const t0 = Date.now(); await H.T.handleQuery('tell me a joke', H.S.lastConnection, H.text, t0, 'u1'); await H.wait(50);
    const gaps = []; let prev = t0; for (const st of stamps) { gaps.push(st - prev); prev = st; }
    assert.ok(gaps.length >= 5); const w = [50, 100, 200, 200, 200];
    gaps.slice(0, 5).forEach((g, k) => assert.ok(g >= w[k] - 5 && g <= w[k] + 40, `gap ${k}: ${g} vs ${w[k]}`));
    ok(`windows 50ms → 100ms → 200ms, last repeats: gaps ${gaps.join(', ')} ms`); }
  { const H = boot({ THINKING_WAITS: 'soon-ish' }); assert.deepStrictEqual(JSON.parse(JSON.stringify(H.T.THINKING.waits)), [[15000, 22000], [22000, 30000], [30000, 40000]]);
    assert.ok(H.S.logs.some(l => /THINKING_WAITS="soon-ish"/.test(l))); ok('malformed THINKING_WAITS → warning + default schedule'); }

  console.log('thinking limit → quick answer');
  // Like LM Studio: a reasoning burst is bracketed by reasoning.start / reasoning.end.
  const reasoningDeltas = (n, ms) => [[0, { type: 'reasoning.start' }], ...[...Array(n)].map(() => [ms, { type: 'reasoning.delta', content: 'hmm' }]), [0, { type: 'reasoning.end' }]];
  const searchPhase = (toolMs, readMs) => [[0, { type: 'tool_call.start' }], [toolMs, { type: 'tool_call.arguments', tool: 'tavily_search', arguments: { query: 'usc score' } }],
    [0, { type: 'tool_call.success', tool: 'tavily_search' }], [0, { type: 'prompt_processing.start' }], [readMs, { type: 'prompt_processing.end' }]];
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
  const tavily = (...results) => JSON.stringify([{ type: 'text', text: JSON.stringify({ query: 'q', answer: null, results }) }]);
  const found = (query, ...results) => [[0, { type: 'tool_call.start' }], [5, { type: 'tool_call.arguments', tool: 'tavily_search', arguments: { query } }],
    [5, { type: 'tool_call.success', tool: 'tavily_search', arguments: { query }, output: tavily(...results) }]];
  const msg = (...parts) => [[0, { type: 'message.start' }], ...parts.map(t => [5, { type: 'message.delta', content: t }]), [0, { type: 'message.end' }]];
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
  const searched = () => [[0, { type: 'tool_call.start' }], [5, { type: 'tool_call.arguments', tool: 'tavily_search', arguments: { query: 'pee time' } }],
    [5, { type: 'tool_call.success', tool: 'tavily_search', arguments: { query: 'pee time' }, output: '[]' }]];
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


  console.log('personality settings');
  { const H = await setup(); H.S.llmRequests.length = 0; H.S.llmScript = sse('Hi.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    const sys = H.S.llmRequests[0].system;
    assert.ok(sys.startsWith('You are Luna, a helpful voice assistant in a Discord voice channel. '), sys.slice(0, 80));
    assert.ok(sys.includes('Keep responses concise and conversational — no markdown'));
    ok('defaults: the prompt is exactly as before ("a helpful voice assistant", "concise and conversational")'); }
  { const H = await setup({ LM_PERSONALITY: 'fun, bubbly, friendly and helpful', LM_CONCISE: 'false' }); H.S.llmRequests.length = 0; H.S.llmScript = sse('Hi.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    const sys = H.S.llmRequests[0].system;
    assert.ok(sys.startsWith('You are Luna, a fun, bubbly, friendly and helpful voice assistant in a Discord voice channel. '), sys.slice(0, 100));
    assert.ok(sys.includes('Keep responses conversational — no markdown') && !sys.includes('concise'));
    assert.ok(sys.includes('web search tool'), 'the working instructions stay');
    ok('LM_PERSONALITY sets how Luna is described; LM_CONCISE=false drops "concise"; the working instructions stay'); }


  console.log('fake tool calls + date');
  const FAKE = "<tool_call>\n<function=web_search.query>(UCLA football game today score)\n</function>\n</tool_call>";
  { const H = await setup({ LUNA_TIMEZONE: 'America/Los_Angeles', WEB_SEARCH: 'keywords' }); H.S.llmRequests.length = 0;
    H.S.llmScripts = [[...reasoningDeltas(2, 20), ...sse(FAKE)], [...TOOL, ...sse('UCLA did not play today.')]];
    await H.T.handleQuery('did UCLA play football today', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    const said = H.S.tts.map(t => t.text);
    assert.ok(!said.some(t => /tool_call|function=/.test(t)), 'markup never spoken');
    assert.deepStrictEqual(H.S.llmRequests.map(r => `${r.tools ? 'search' : 'no-search'}:${r.reasoning || 'default'}`), ['no-search:default', 'search:default']);
    assert.ok(BUILTIN.includes(said[0])); assert.strictEqual(said.at(-1), 'UCLA did not play today.');
    ok('(keywords mode) "did UCLA play football today" → fake <tool_call> not spoken; re-asked WITH search (thinking still on); heads-up at the real search; answered'); }
  { const H = await setup(); H.S.llmRequests.length = 0;
    H.S.llmScripts = [[...TOOL, ...sse(FAKE)], sse('Here is the answer.')];
    await H.T.handleQuery("what's the weather today", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.llmRequests.map(r => `${r.tools ? 'search' : 'no-search'}:${r.reasoning || 'default'}`), ['search:default', 'search:off']);
    assert.ok(!H.S.tts.some(t => /tool_call/.test(t.text))); ok('fake tool call even with search on → not spoken, retried with reasoning off'); }
  { const H = await setup({ LUNA_TIMEZONE: 'America/Los_Angeles' }); H.S.llmRequests.length = 0; H.S.llmScript = sse('Ok.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    const expect = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
    assert.ok(H.S.llmRequests[0].system.includes(`Today is ${expect} (America/Los_Angeles time).`));
    ok(`system prompt carries the date: "Today is ${expect} (America/Los_Angeles time)."`); }
  { const H = boot({ LUNA_TIMEZONE: 'Mars/Olympus_Mons' }); await H.start(); assert.ok(H.S.logs.some(l => /LUNA_TIMEZONE="Mars\/Olympus_Mons" is not a valid time zone/.test(l)));
    ok('invalid LUNA_TIMEZONE → warning, UTC'); }


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

  console.log('empty answers');
  { const H = await setup(); H.S.llmRequests.length = 0; H.S.llmScripts = [sse('.'), sse('The actress is Jennifer Coolidge.')];
    await H.T.handleQuery('which actress said weird weird', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.reasoning), [undefined, 'off']);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['The actress is Jennifer Coolidge.']); ok('answer was just "." → not spoken, re-asked with reasoning off, real answer spoken'); }
  { const H = await setup(); H.S.llmScripts = [sse('.'), sse('…')];
    await H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Sorry, I lost my train of thought.']); ok('empty twice → "Sorry, I lost my train of thought."'); }
  { const H = await setup({ LLM_REASONING: 'off' }); H.S.llmRequests.length = 0; H.S.llmScripts = [sse('.')];
    await H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.reasoning), ['off']); assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Sorry, I lost my train of thought.']);
    ok('LLM_REASONING=off is sent; an empty answer then is not retried (already off)'); }
  { const H = await setup({ LLM_REASONING: 'low' }); H.S.llmRequests.length = 0; H.S.llmScript = sse('Hi.');
    await H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.reasoning), ['low']); ok('LLM_REASONING=low → sent as reasoning: "low"'); }

  console.log('barge-in while thinking (real capture path)');
  { const H = boot({ SILENCE_MS: '150', MIN_SPEECH_MS: '100', ANNOUNCE_THINKING: 'false', ANNOUNCE_SELF: 'false', LLM_THINK_LIMIT_MS: '0' });
    await H.start(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(20);
    const mic = H.S.audio.u1, wake = H.S.wake.u1; assert.ok(mic && wake, 'capture + wake stream created');
    const loud = Buffer.alloc(1920); for (let k = 0; k < 960; k++) loud.writeInt16LE(2000, k * 2);
    const speak = async ms => { for (let t = 0; t < ms; t += 20) { mic.write(loud); await H.wait(20); } };
    H.S.tts.length = 0; H.S.llmRequests.length = 0; H.S.aborted = 0;
    H.S.transcripts = ['tell me about camptown races', 'actually never mind, tell me a joke'];
    H.S.llmScripts = [[...reasoningDeltas(60, 50), ...sse('Old long answer.')], sse('Here is a joke.')];
    wake.onDetect(0.9, Date.now()); await speak(300); await H.wait(300);   // question 1 flushed, LLM "thinking"
    assert.strictEqual(H.S.llmRequests.length, 1); assert.strictEqual(H.S.llmRequests[0].input, 'tell me about camptown races');
    await H.wait(500);
    wake.onDetect(0.9, Date.now()); await H.wait(20);                     // "hey Luna" during the think
    assert.ok(H.S.logs.some(l => /barge-in — cancelling the previous question/.test(l))); assert.ok(H.S.aborted >= 1);
    await speak(300); await H.wait(600);
    assert.strictEqual(H.S.llmRequests.length, 2); assert.strictEqual(H.S.llmRequests[1].input, 'actually never mind, tell me a joke');
    const said = H.S.tts.map(t => t.text);
    assert.ok(said.includes('Here is a joke.') && !said.includes('Old long answer.'));
    assert.ok(H.S.logs.some(l => /previous question cancelled/.test(l)) && !H.S.logs.some(l => /handleQuery error/.test(l)));
    assert.ok(!H.S.logs.some(l => /DISCARDED despite detection/.test(l)));
    ok('"hey Luna" mid-think → old request aborted, new question transcribed and answered; old answer never spoken; no error, nothing discarded'); }


  console.log('two-stage wake detection');
  const wakeRig = async (env = {}) => {
    const H = boot({ SILENCE_MS: '150', MIN_SPEECH_MS: '100', ANNOUNCE_THINKING: 'false', ANNOUNCE_SELF: 'false', LLM_THINK_LIMIT_MS: '0', ...env });
    await H.start(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(20);
    const mic = H.S.audio.u1, wake = H.S.wake.u1;
    const loud = Buffer.alloc(1920); for (let k = 0; k < 960; k++) loud.writeInt16LE(2000, k * 2);
    H.utter = async (peak, transcript, detect = false) => {
      H.S.transcripts = [transcript]; (H.S.peaks ??= {}).u1 = peak; if (detect) wake.onDetect(0.9, Date.now());
      for (let t = 0; t < 300; t += 20) { mic.write(loud); await H.wait(20); } await H.wait(500); };
    H.S.tts.length = 0; H.S.llmRequests.length = 0; H.S.llmScript = sse('Sunny all day.'); return H; };
  { const H = await wakeRig();
    assert.ok(H.S.logs.some(l => /\[oww\] active — threshold=.*; candidates from 0\.1 confirmed by Whisper/.test(l)));
    await H.utter(0.41, "Hey Luna what's the weather like today");
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ["what's the weather like today"]);
    assert.ok(H.S.logs.some(l => /wake candidate \(peak score 0\.410/.test(l)) && H.S.logs.some(l => /wake candidate confirmed by Whisper/.test(l)));
    ok('run-on "hey Luna what\'s the weather" (peak 0.41, no full detection) → candidate, Whisper hears Luna → "what\'s the weather like today" answered'); }
  { const H = await wakeRig(); await H.utter(0.12, "So anyway, hey Luna, what's the weather like today?");
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ["what's the weather like today?"]);
    ok('mid-sentence "so anyway, hey Luna, what\'s…" → question after the wake phrase'); }
  { const H = await wakeRig(); await H.utter(0.15, 'I was looking at the lunar eclipse last night');
    assert.strictEqual(H.S.llmRequests.length, 0);
    const rej = H.S.logs.find(l => /wake candidate rejected/.test(l)); assert.ok(rej && /\(9 words\)/.test(rej) && !/eclipse/.test(rej), rej);
    ok('candidate whose transcript has no "Luna" ("lunar" doesn\'t count) → rejected; log gives a word count, not what was said'); }
  { const H = await wakeRig(); await H.utter(0.05, "Hey Luna what's the weather");
    assert.strictEqual(H.S.llmRequests.length, 0); assert.ok(!H.S.logs.some(l => /Processing \d+ms utterance/.test(l)));
    assert.ok(H.S.logs.some(l => /utterance discarded — no wake word \(\d+ms, peak score 0\.050/.test(l)));
    ok('peak below the candidate threshold (0.05) → discarded without transcribing, as before'); }
  { const H = await wakeRig({ OWW_CANDIDATE_THRESHOLD: '0' }); await H.utter(0.3, "Hey Luna what's the weather");
    assert.strictEqual(H.S.llmRequests.length, 0); assert.ok(!H.S.logs.some(l => /candidates from/.test(l)));
    ok('OWW_CANDIDATE_THRESHOLD=0 → two-stage off: peak 0.3 discarded'); }
  { const H = await wakeRig(); await H.utter(0.9, 'tell me a joke', true);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ['tell me a joke']); assert.ok(!H.S.logs.some(l => /wake candidate/.test(l)));
    H.S.peaks.u1 = 0.9; await H.utter(0.9, 'tell me another', true);  // a detection's peak is consumed with it...
    H.S.transcripts = ['and now a third']; for (let t = 0; t < 300; t += 20) { H.S.audio.u1.write(Buffer.alloc(1920, 7)); await H.wait(20); } await H.wait(500);
    assert.strictEqual(H.S.llmRequests.length, 2, '...so it cannot make a candidate of the next, wake-word-free utterance');
    ok('full detections unchanged (no Whisper check); their peak is consumed, so it never leaks into the next utterance as a candidate'); }


  console.log('listening after a bare "hey Luna"');
  { const H = await wakeRig({ WAKE_LISTEN_MS: '2000' }); const mic = H.S.audio.u1, wake = H.S.wake.u1;
    const loud = Buffer.alloc(1920); for (let k = 0; k < 960; k++) loud.writeInt16LE(2000, k * 2);
    const speak = async ms => { for (let t = 0; t < ms; t += 20) { mic.write(loud); await H.wait(20); } };
    H.S.transcripts = ["Hey Luna. What's the weather like?"]; H.S.played.length = 0;
    await speak(300); wake.onDetect(0.9, Date.now());                     // "hey Luna", the model fires as it ends
    await H.wait(700);                                                     // a pause well past SILENCE_MS (150)
    assert.strictEqual(H.S.llmRequests.length, 0, 'not answered as a greeting');
    assert.ok(H.S.logs.some(l => /heard "hey Luna" — listening for the question \(up to 2s\)/.test(l)));
    assert.strictEqual(H.S.played.filter(p => p === undefined).length, 0, 'no chime while she waits');
    await speak(400); await H.wait(600);                                   // the question
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ["What's the weather like?"]);
    assert.strictEqual(H.S.played.filter(p => p === undefined).length, 1, 'one chime, once the question is in');
    ok('"hey Luna" … pause … question → one utterance: silent wait, the usual chime after the question, no greeting'); }
  { const H = await wakeRig({ WAKE_LISTEN_MS: '600' }); const mic = H.S.audio.u1, wake = H.S.wake.u1;
    const loud = Buffer.alloc(1920); for (let k = 0; k < 960; k++) loud.writeInt16LE(2000, k * 2);
    H.S.transcripts = ['Hey Luna.'];
    for (let t = 0; t < 300; t += 20) { mic.write(loud); await H.wait(20); } wake.onDetect(0.9, Date.now());
    await H.wait(400); assert.strictEqual(H.S.llmRequests.length, 0);
    await H.wait(700);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ['Hey Luna.']);
    ok('nothing follows within WAKE_LISTEN_MS → the bare "hey Luna" is answered as a greeting'); }
  { const H = await wakeRig(); await H.utter(0.9, "hey Luna what's the weather", true);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ["what's the weather"]);
    assert.ok(!H.S.logs.some(l => /listening for the question/.test(l)));
    ok('run-on "hey Luna what\'s the weather" → no waiting, answered as before'); }
  { const H = await wakeRig({ WAKE_LISTEN_MS: '0' }); const mic = H.S.audio.u1, wake = H.S.wake.u1;
    const loud = Buffer.alloc(1920); for (let k = 0; k < 960; k++) loud.writeInt16LE(2000, k * 2);
    H.S.transcripts = ['Hey Luna.'];
    for (let t = 0; t < 300; t += 20) { mic.write(loud); await H.wait(20); } wake.onDetect(0.9, Date.now()); await H.wait(500);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ['Hey Luna.']); ok('WAKE_LISTEN_MS=0 → no waiting, as before'); }


  console.log('undecodable packets');
  { const H = await wakeRig(); const mic = H.S.audio.u1;
    const bad = Buffer.from([0xBA, 0xD0, 1, 2, 3, 4, 5, 6]);
    mic.write(bad); mic.write(bad); await H.wait(20);                  // e.g. still-encrypted packets right after joining
    await H.utter(0.9, 'tell me a joke', true);                          // real speech afterwards
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ['tell me a joke'], 'still heard after bad packets');
    assert.ok(H.S.logs.some(l => /\[u1\] 1 audio packet\(s\) could not be decoded — dropped/.test(l)));
    for (let k = 0; k < 5; k++) mic.write(bad); await H.wait(20);
    assert.strictEqual(H.S.logs.filter(l => /could not be decoded/.test(l)).length, 1, 'summarised at most every 10 s');
    await H.utter(0.9, 'and another one', true);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.input), ['tell me a joke', 'and another one']);
    ok('corrupted packets are dropped and logged (once per 10 s); the speaker is still heard afterwards — previously one bad packet deafened Luna to them'); }


  console.log('encrypted voice (DAVE): logging + self-heal');
  const daveSetup = async env => { const H = boot({ ANNOUNCE_SELF: 'false', ...env }); await H.start(); H.put('u1', 'A'); H.put('u2', 'A');
    await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(20); return H; };
  const loudChunk = (() => { const b = Buffer.alloc(1920); for (let k = 0; k < 960; k++) b.writeInt16LE(2000, k * 2); return b; })();
  { const H = await daveSetup({}); const c = H.S.lastConnection;
    c.emit('debug', '[NW] [DAVE] Session initialized for protocol version 1');
    c.emit('debug', '[WS] >> {"op":3,"d":123}');
    for (let k = 1; k <= 25; k++) c.emit('debug', `[NW] [DAVE] Failed to decrypt a packet (${k} consecutive fails)`);
    const lines = H.S.logs.filter(l => /\[voice\] (encryption|encrypted audio)/.test(l));
    assert.ok(lines.some(l => /encryption: Session initialized for protocol version 1/.test(l)));
    assert.strictEqual(lines.filter(l => /failed to decrypt/.test(l)).length, 1);
    assert.ok(!H.S.logs.some(l => /op":3/.test(l)));
    ok('DAVE messages logged; 25 decrypt failures → one summary line; other debug chatter ignored'); }
  { const H = await daveSetup({ VOICE_RECOVER_MS: '200' }); const first = H.S.lastConnection; const replies = H.S.replies.length;
    first.receiver.speaking.emit('start', 'u1');                  // Discord: u1 is speaking…
    await H.wait(260);                                              // …but no audio ever arrives
    assert.ok(H.S.logs.some(l => /Discord reports u1 speaking, but none of their audio has decrypted in 0s — reconnecting/.test(l)));
    assert.deepStrictEqual(H.S.destroyed, ['A']);
    await H.wait(1600); const second = H.S.lastConnection; assert.notStrictEqual(second, first);
    second.setStatus(H.Status.Ready); await H.wait(20);
    assert.ok(H.S.logs.some(l => /\[voice\] reconnected to A/.test(l))); assert.strictEqual(H.T.activeConnection, second);
    assert.strictEqual(H.S.replies.length, replies, 'no chat reply on reconnect');
    assert.ok(H.S.audio.u1 && H.S.wake.u1, 'capture restarted for u1');
    ok('speaker reported speaking with no decryptable audio → quiet reconnect to the same channel, captures restarted'); }
  { const H = await daveSetup({ VOICE_RECOVER_MS: '200' }); const c = H.S.lastConnection;
    c.receiver.speaking.emit('start', 'u1'); H.S.audio.u1.write(loudChunk); await H.wait(300);
    assert.deepStrictEqual(H.S.destroyed, []); assert.ok(!H.S.logs.some(l => /reconnecting/.test(l)));
    ok('speaker whose audio arrives → no reconnect'); }
  { const H = await daveSetup({ VOICE_RECOVER_MS: '200', IGNORED_USER_IDS: 'u2' }); const c = H.S.lastConnection;
    c.receiver.speaking.emit('start', 'u2'); c.receiver.speaking.emit('start', 'luna'); await H.wait(300);
    assert.deepStrictEqual(H.S.destroyed, []); ok('ignored users and Luna herself never trigger it'); }
  // Fake DAVE session on the connection, the way @discordjs/voice holds it.
  const fakeDave = (c, { members = ['luna', 'u1'], stats = {}, status = 3 } = {}) => {
    c.state = { ...(c.state || {}), networking: { state: { dave: { protocolVersion: 1, session: {
      status, epoch: 7n, getUserIds: () => members,
      getDecryptionStats: uid => stats[uid] ?? null } } } } };
    Object.defineProperty(c, 'voicePrivacyCode', { get: () => '12345 67890 11121', configurable: true }); };
  const voicecheck = async H => { H.T.client.emit('messageCreate', { content: '!luna voicecheck', member: null, channel: H.text, reply: async r => { H.S.replies.push(r); } }); await H.wait(10); return H.S.replies.at(-1); };
  { const H = await daveSetup({}); fakeDave(H.S.lastConnection, { members: ['luna', 'u1'], stats: { u1: { successes: 812, failures: 0 }, u2: { successes: 0, failures: 37 } } });
    const r = await voicecheck(H);
    assert.ok(/Voice encryption:\*\* active, epoch 7 — privacy code `12345 67890 11121`/.test(r), r);
    assert.ok(/✅ u1: in group, 812 decrypted\/0 failed/.test(r) && /⚠️ u2: NOT in group, 0 decrypted\/37 failed/.test(r), r);
    assert.ok(H.S.logs.some(l => /\[voice\] voicecheck: ✅ u1.*\| ⚠️ u2/.test(l)));
    ok('!luna voicecheck → per-person verdict (in group? decrypted/failed) + privacy code; logged too'); }
  { const H = await daveSetup({}); fakeDave(H.S.lastConnection, { members: ['luna', 'u1', 'u2'], stats: { u2: { successes: 0, failures: 5 } } });
    const r = await voicecheck(H);
    assert.ok(/✅ u1: in group, no packets yet/.test(r) && /⚠️ u2: in group, 0 decrypted\/5 failed/.test(r), r);
    ok('in group but every packet failing → flagged; no packets yet → fine'); }
  { const H = await daveSetup({}); const r = await voicecheck(H);
    assert.ok(/Encryption details are unavailable/.test(r)); assert.ok(!H.S.logs.some(l => /diagnostics unavailable/.test(l)));
    H.S.lastConnection.state = { ...H.S.lastConnection.state, networking: { state: { dave: { protocolVersion: 1, session: {} } } } };
    await voicecheck(H); await voicecheck(H);
    assert.strictEqual(H.S.logs.filter(l => /encryption diagnostics unavailable — the voice library's internals have changed/.test(l)).length, 1);
    ok('no session (unencrypted) → polite reply; session without the expected methods → warned once, never throws'); }
  { const H = boot({ ANNOUNCE_SELF: 'false' }); await H.start(); const r = await voicecheck(H);
    assert.ok(/not in a voice channel/.test(r)); ok('voicecheck when not in a channel → says so'); }
  { const H = await daveSetup({ VOICE_RECOVER_MS: '200' }); fakeDave(H.S.lastConnection, { members: ['luna', 'u2'], stats: { u1: { successes: 0, failures: 40 } } });
    H.S.lastConnection.receiver.speaking.emit('start', 'u1'); await H.wait(260);
    assert.ok(H.S.logs.some(l => /Discord reports u1 speaking, but none of their audio has decrypted in 0s \(encryption: NOT in group, 0 decrypted\/40 failed\) — reconnecting/.test(l)));
    ok('silent-speaker warning carries the definitive verdict'); }
  { const H = await daveSetup({ VOICE_RECOVER_MS: '200' }); const c = H.S.lastConnection;
    fakeDave(c, { members: ['luna', 'u1', 'u2'], stats: { u1: { successes: 661, failures: 9 } } });
    c.receiver.speaking.emit('start', 'u1'); const before = H.S.audio.u1; await H.wait(260);
    assert.deepStrictEqual(H.S.destroyed, [], 'no reconnect');
    assert.ok(H.S.logs.some(l => /Discord reports u1 speaking and their audio is decrypting \(encryption: in group, 661 decrypted\/9 failed\), but none of it reached Luna — restarting their capture/.test(l)));
    assert.ok(before.destroyed && H.S.logs.some(l => /\[u1\] capture stream closed/.test(l)), 'their capture was restarted');
    c.receiver.speaking.emit('start', 'u1'); await H.wait(20);
    assert.ok(H.S.audio.u1 !== before && !H.S.audio.u1.destroyed, 'fresh capture on next speech');
    ok('speaker whose audio decrypts but never arrives → only their capture is restarted, no reconnect for everyone'); }
  { const H = await daveSetup({ VOICE_RECOVER_MS: '0' }); H.S.lastConnection.receiver.speaking.emit('start', 'u1'); await H.wait(300);
    assert.deepStrictEqual(H.S.destroyed, []); ok('VOICE_RECOVER_MS=0 → disabled'); }
  { const H = await daveSetup({ VOICE_RECOVER_MS: '150' });
    H.S.lastConnection.receiver.speaking.emit('start', 'u1'); await H.wait(1800); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(20);
    H.S.lastConnection.receiver.speaking.emit('start', 'u2'); await H.wait(250);
    assert.strictEqual(H.S.destroyed.length, 1); assert.ok(H.S.logs.some(l => /already reconnected recently, not retrying yet/.test(l)));
    ok('a second failure within 5 minutes → logged, not another reconnect (no loops)'); }

  console.log('conversation memory recovery (sweep 2, item 1)');
  { const H = await setup(); H.S.llmRequests.length = 0;
    H.S.llmScript = sse('First answer.'); await H.T.handleQuery('hello', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    H.S.llmScript = sse('Second answer.'); await H.T.handleQuery('and then?', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.strictEqual(H.S.llmRequests[1].prev, 'resp_1'); ok('normal follow-up carries the previous response id');
    H.S.stored.clear();  // LM Studio reset: stored conversations gone
    H.S.tts.length = 0; H.S.llmRequests.length = 0; H.S.llmScript = sse('Fresh answer.');
    await H.T.handleQuery('still there?', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.prev), ['resp_2', undefined]);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Fresh answer.']); assert.ok(H.S.logs.some(l => /conversation memory not found/.test(l)));
    ok('stored conversation gone → 400 → retried once without it → answered (no "trouble" line)');
    H.S.tts.length = 0; H.S.llmRequests.length = 0; H.S.llmScript = sse('Next.');
    await H.T.handleQuery('and now?', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.prev), ['resp_3']); ok('next question continues the NEW conversation (single request)'); }
  { const H = await setup(); H.S.llmScript = sse('One.'); await H.T.handleQuery('hello', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    H.S.stored.clear(); H.S.model = 'model-b'; H.S.llmRequests.length = 0; H.S.tts.length = 0; H.S.llmScript = sse('Both fixed.');
    await H.T.handleQuery('hi again', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Both fixed.']); ok('model switched AND memory gone → both recovered in one question'); }
  { const H = await setup(); H.S.tts.length = 0; H.S.llmRequests.length = 0; H.S.force400 = true; H.S.llmScript = sse('x');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.strictEqual(H.S.llmRequests.length, 1); assert.deepStrictEqual(H.S.tts.map(t => t.text), ['I had trouble processing that.']);
    ok('unrelated 400 → one request, no retry loop, "I had trouble processing that."'); }

  console.log('LLM stats logging (sweep 2, item 2)');
  { const H = await setup(); H.S.llmScript = sse('Hi.'); await H.T.handleQuery('hello', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    H.S.llmScript = sse('Hi again.'); await H.T.handleQuery('hello again', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    const lines = H.S.logs.filter(l => /\[LLM\] stats:/.test(l));
    assert.strictEqual(lines.length, 2);
    assert.match(lines[0], /\[u1\] \[LLM\] stats: memory turn 1, prompt 1,234 tokens, reasoning 40, output 56, first token 12\.3s, 6\.9 tok\/s/);
    assert.match(lines[1], /memory turn 2/); ok('one stats line per answer: ' + lines[0].replace(/^\[u1\] /, '')); }

  console.log('ALL PASS'); clearInterval(keepAlive);
})().catch(e => { console.error('FAIL:', e.stack); process.exit(1); });
