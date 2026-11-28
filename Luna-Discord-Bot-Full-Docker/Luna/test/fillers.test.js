// "Still thinking" fillers: when, how many, which, personal ones.
// Run: npm test   (see docs/DEVELOPMENT.md)
const { assert, boot, ok, sse, BUILTIN, setup, TOOL, FILL, T, isFiller, fillersIn, reasoningDeltas, searchPhase, tavily, found, msg, searched, FAKE, wakeRig, bareRig, MUSIC_CALL, NP, textRig, TOP, MINE, IMG_CALL, PICS, SAY, inVoice, daveSetup, loudChunk, fakeDave, voicecheck } = require('./helpers');
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  console.log('"still thinking" fillers');
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

  console.log('ALL PASS'); clearInterval(keepAlive);
})().catch(e => { console.error('FAIL:', e.stack); process.exit(1); });
