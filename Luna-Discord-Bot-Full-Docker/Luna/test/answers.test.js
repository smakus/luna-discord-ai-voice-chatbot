// Spoken answers from the LLM: the status message, TTS lookahead and interrupts, timeouts, the model, personality, empty and broken-down answers, sampling, audio tags, memory and stats.
// Run: npm test   (see docs/DEVELOPMENT.md)
const { assert, boot, ok, sse, BUILTIN, setup, TOOL, FILL, T, isFiller, fillersIn, reasoningDeltas, searchPhase, tavily, found, msg, searched, FAKE, wakeRig, bareRig, MUSIC_CALL, NP, textRig, TOP, MINE, IMG_CALL, PICS, SAY, inVoice, daveSetup, loudChunk, fakeDave, voicecheck } = require('./helpers');
const keepAlive = setInterval(() => {}, 1000);

(async () => {
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


  console.log('empty answers');
  { const H = await setup(); H.S.llmRequests.length = 0; H.S.llmScripts = [sse('.'), sse('The actress is Jennifer Coolidge.')];
    await H.T.handleQuery('which actress said weird weird', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.reasoning), [undefined, 'off']);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['The actress is Jennifer Coolidge.']); ok('answer was just "." → not spoken, re-asked with reasoning off, real answer spoken'); }
  { const H = await setup(); H.S.llmScripts = [sse('.'), sse('…')];
    await H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Sorry, I lost my train of thought.']); ok('empty twice → "Sorry, I lost my train of thought."'); }
  { const H = await setup({ LLM_REASONING: 'off' }); H.S.llmRequests.length = 0; H.S.llmScripts = [sse('.'), sse('.')];
    await H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.reasoning), ['off', 'off']); assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Sorry, I lost my train of thought.']);
    ok('LLM_REASONING=off is sent; an empty answer is asked once more in a fresh conversation (not with reasoning off: already off), then "Sorry…"'); }
  console.log('sampling settings sent with every request');
  { const H = await setup({ LM_TEMPERATURE: '0.7', LM_TOP_P: '0.8', LM_TOP_K: '20', LM_MIN_P: '0', LM_REPEAT_PENALTY: '1.05' }); H.S.llmRequests.length = 0; H.S.llmScript = sse('Hi.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(80);
    assert.deepStrictEqual(H.S.llmRequests[0].sampling, { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, repeat_penalty: 1.05 });
    assert.ok(H.S.logs.some(l => /\[LLM\] sampling sent with every request: temperature 0\.7, top_p 0\.8, top_k 20, min_p 0, repeat_penalty 1\.05/.test(l)));
    ok('LM_TEMPERATURE, LM_TOP_P, LM_TOP_K, LM_MIN_P, LM_REPEAT_PENALTY → sent with the request (min_p 0 included), listed at startup'); }
  { const H = await setup({ LM_TEMPERATURE: '0.6' }); H.S.llmRequests.length = 0; H.S.llmScripts = [sse('.'), sse('Hello.')];
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(120);
    assert.ok(H.S.llmRequests.length === 2 && H.S.llmRequests.every(r => JSON.stringify(r.sampling) === '{"temperature":0.6}'), JSON.stringify(H.S.llmRequests.map(r => r.sampling)));
    ok('only the ones set are sent, on retries too'); }
  { const H = await setup({}); H.S.llmRequests.length = 0; H.S.llmScript = sse('Hi.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(80);
    assert.deepStrictEqual(H.S.llmRequests[0].sampling, {}); assert.ok(!H.S.logs.some(l => /sampling sent/.test(l)));
    ok('none set → none sent (LM Studio\'s own settings), as before'); }

  console.log('a broken-down answer → once more in a fresh conversation');
  { // The live case: twelve messages deep, the model searched, then wrote '[play_music] "…"' instead of answering.
    const H = await setup({ LLM_REASONING: 'off' }); H.S.llmScript = sse('Hello there.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(80);
    H.S.llmRequests.length = 0; H.S.tts.length = 0;
    H.S.llmScripts = [[...msg('Let me look up their hits.'), ...found('Yaz hits', { url: 'u', title: 'Yazoo', content: "Only You and Don't Go were their biggest hits." }),
                       ...msg('[play_music] "smooth jazz for late night coding"')],
                      msg("Yaz's biggest hits were Only You and Don't Go.")];
    await H.T.handleQuery("what was Yaz's hits?", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    const [first, retry] = H.S.llmRequests;
    assert.ok(first.prev, 'the first pass continued the conversation'); assert.ok(!retry.prev, 'the retry starts a fresh one');
    assert.ok(retry.input.startsWith("what was Yaz's hits?\n\nWeb search results already found") && /Yazoo: Only You/.test(retry.input), retry.input.slice(0, 120));
    assert.strictEqual(retry.tools, false, 'no second search');
    const said = H.S.tts.map(t => t.text);
    assert.ok(said.includes("Yaz's biggest hits were Only You and Don't Go.") && !said.some(t => /play_music|lost my train/.test(t)), said.join(' | '));
    assert.ok(H.S.logs.some(l => /answer broke down \(a tool call written as text\) — asking again in a fresh conversation, with the 1 search result set\(s\) already found/.test(l)));
    H.S.llmRequests.length = 0; H.S.llmScript = sse('Yes.');
    await H.T.handleQuery('and were they British?', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(80);
    assert.ok(H.S.llmRequests[0].prev, 'the next question continues the fresh conversation');
    ok('searched, then a tool call written as text → once more in a fresh conversation with the results found → answered; the next question continues from there'); }
  { const H = await setup({ LLM_REASONING: 'off' });
    H.S.llmScripts = [[...msg('Let me check.'), ...found('q', { url: 'u', title: 'T', content: 'C' })], msg('[skip_song]')];
    await H.T.handleQuery('who won?', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    assert.strictEqual(H.S.llmRequests.length, 2);
    assert.deepStrictEqual(H.S.tts.map(t => t.text).filter(t => !BUILTIN.includes(t)), ['Let me check.', 'Sorry, I lost my train of thought.']);
    ok('nothing said after the search, and the fresh try breaks down too → "Sorry, I lost my train of thought." (not silence), no third try'); }
  { const H = await setup({ LLM_REASONING: 'off' }); H.S.llmRequests.length = 0;
    H.S.llmScript = [...msg('Let me check.'), ...found('q', { url: 'u', title: 'T', content: 'C' }), ...msg('It was the Lakers.')];
    await H.T.handleQuery('who won?', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    assert.strictEqual(H.S.llmRequests.length, 1); assert.ok(!H.S.logs.some(l => /broke down/.test(l)));
    ok('a normal searched answer → no retry'); }
  { const H = await setup({ LLM_REASONING: 'low' }); H.S.llmRequests.length = 0; H.S.llmScript = sse('Hi.');
    await H.T.handleQuery('q', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(50);
    assert.deepStrictEqual(H.S.llmRequests.map(r => r.reasoning), ['low']); ok('LLM_REASONING=low → sent as reasoning: "low"'); }

  console.log('the asker\'s name');
  { const H = await setup({}); H.S.names = { u1: 'smak_99' }; H.put('u1', 'A'); H.S.llmRequests.length = 0; H.S.llmScript = sse('Hi smak.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.ok(H.S.llmRequests[0].system.includes('The person talking to you now is smak. Use their name now and then'), H.S.llmRequests[0].system.slice(-200));
    ok('the asker\'s speakable display name is in the prompt ("smak_99" → smak)'); }
  { const H = await setup({}); H.S.names = { u1: '🔥🔥' }; H.put('u1', 'A'); H.S.llmRequests.length = 0; H.S.llmScript = sse('Hi.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.ok(!H.S.llmRequests[0].system.includes('person talking to you')); ok('a name with nothing speakable → no name line'); }
  { const H = await setup({ LM_USE_NAMES: 'false' }); H.S.names = { u1: 'Sam' }; H.put('u1', 'A'); H.S.llmRequests.length = 0; H.S.llmScript = sse('Hi.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.ok(!H.S.llmRequests[0].system.includes('person talking to you')); ok('LM_USE_NAMES=false → no name line'); }


  console.log('audio tags after the last sentence');
  { const H = await setup({}); H.S.llmScript = sse('Expect rain today, so bring an umbrella.', '[chuckles]');
    await H.T.handleQuery('what is the weather', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0); await H.wait(100);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Expect rain today, so bring an umbrella. [chuckles]']);
    ok('"… umbrella." then "[chuckles]" → one sentence for the voice (ElevenLabs refuses a tag on its own)'); }

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
