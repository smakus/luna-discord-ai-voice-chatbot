// Typing to Luna: text chat, pictures, saying things in the voice channel.
// Run: npm test   (see docs/DEVELOPMENT.md)
const { assert, boot, ok, sse, BUILTIN, setup, TOOL, FILL, T, isFiller, fillersIn, reasoningDeltas, searchPhase, tavily, found, msg, searched, FAKE, wakeRig, bareRig, MUSIC_CALL, NP, textRig, TOP, MINE, IMG_CALL, PICS, SAY, inVoice, daveSetup, loudChunk, fakeDave, voicecheck } = require('./helpers');
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  console.log('text chat');
  { const H = await textRig(); H.S.llmScripts = [sse('Hi Sam!', 'It is noon.'), sse('Sure, Joel.')];
    const ch = H.chan(); await H.say('Luna, what time is it?', { channel: ch }); await H.until(() => H.S.replies.length === 1);
    const req = H.S.llmRequests[0];
    assert.strictEqual(req.input, 'Sam: what time is it?');
    assert.ok(/answering in a text channel/.test(req.system) && /Discord formatting is fine/.test(req.system) && !/audio tags/.test(req.system));
    assert.strictEqual(H.S.replies[0].content, 'Hi Sam! It is noon.');
    assert.strictEqual(JSON.stringify(H.S.replies[0].allowedMentions), '{"parse":[],"repliedUser":false}');
    assert.ok(ch.typing >= 1, 'typing indicator');
    await H.say('<@luna> and for me?', { user: 'u2', name: 'Joel', channel: ch }); await H.until(() => H.S.replies.length === 2);
    assert.strictEqual(H.S.llmRequests[1].input, 'Joel: and for me?');
    assert.ok(H.S.llmRequests[1].prev && H.S.llmRequests[1].prev === 'resp_' + (H.S.nextRid - 1), 'continues the channel\'s conversation');
    assert.strictEqual(H.S.tts.length, 0, 'nothing spoken');
    ok('"Luna, …" or an @mention in textbuffet → written answer as a reply, "typing…", no pings; one shared conversation for the channel, each line with its writer\'s name'); }
  { const H = await textRig(); H.S.llmScript = sse('Hi.');
    await H.say('Luna, hi there', { channel: H.chan('general') }); await H.say('what time is it?'); await H.say('the lunar eclipse was cool'); await H.wait(150);
    assert.strictEqual(H.S.llmRequests.length, 0); assert.strictEqual(H.S.replies.length, 0);
    ok('other channels, and messages not addressed to her → ignored'); }
  { const H = await textRig(); H.S.llmScript = sse('x'.repeat(1500) + '.', 'y'.repeat(1500) + '.');
    await H.say('Luna, write a lot'); await H.until(() => H.S.sends.length > 0);
    assert.ok(H.S.replies[0].content.length <= 2000 && H.S.sends[0].content.length <= 2000); ok('a long answer → split into messages under 2,000 characters'); }
  console.log('pictures in the text chat (post_image)');
  { const H = await textRig({ LLM_TOOLS: 'true' }); PICS(H);
    H.S.llmScript = [...IMG_CALL('Baby Capybara'), ...sse('Here is a baby capybara!')];
    await H.say('Luna, show me a picture of a baby capybara'); await H.until(() => H.S.replies.length > 0);
    const r = H.S.replies[0];
    assert.strictEqual(r.content, 'Here is a baby capybara!');
    assert.deepStrictEqual(r.files.map(f => [f.name, f.attachment.length]), [['baby-capybara.png', 2048]]);
    assert.deepStrictEqual(H.S.imageSearches, ['Baby Capybara'], 'one search');
    assert.ok(H.S.llmRequests[0].integrations.some(i => i.id === 'mcp/luna' && i.allowed_tools.includes('post_image')));
    assert.ok(/post a picture in the text chat/.test(H.S.llmRequests[0].system));
    ok('text: post_image → the first real image under 8 MB (not a web page, not too big, not missing) attached to the reply, so Discord shows it inline'); }
  { const H = await setup({ LLM_TOOLS: 'true' }); PICS(H); H.S.names = { u1: 'Sam' }; H.put('u1', 'A');
    H.S.llmRequests.length = 0; H.S.llmScript = [...IMG_CALL('capybara'), ...sse('I put a capybara in the text chat.')];
    await H.T.handleQuery('show me a capybara', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.sends.some(m => m?.files));
    const post = H.S.sends.find(m => m?.files);
    assert.strictEqual(post.content, '📷 capybara (for Sam)'); assert.deepStrictEqual(post.files.map(f => f.name), ['capybara.png']);
    assert.ok(H.S.tts.some(t => /capybara in the text chat/.test(t.text)));
    ok('voice: post_image → the picture posted in the text channel ("📷 capybara (for Sam)") while she says so'); }
  { const H = await setup({ LLM_TOOLS: 'true' }); PICS(H);
    const { Readable } = require('stream');
    const call = async args => { const res = { status: 0, body: '', writeHead(s) { this.status = s; return this; }, end(b = '') { this.body = b; return this; } };
      const req = Readable.from([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post_image', arguments: args } })]);
      req.url = '/mcp'; req.method = 'POST'; await H.S.mcpHandler(req, res); return JSON.parse(res.body).result.content[0].text; };
    assert.match(await call({ query: 'capybara' }), /^A picture for "capybara" is being posted in the text chat/);
    H.S.images = ['https://img.test/page.html']; assert.match(await call({ query: 'zebra' }), /^No picture could be found for "zebra"/);
    H.S.imagesDown = true; assert.match(await call({ query: 'okapi' }), /^No picture could be found/);
    assert.ok(H.S.logs.some(l => /\[image\] "okapi": search failed \(Tavily answered 432\)/.test(l)));
    const H2 = await setup({ LLM_TOOLS: 'true', TAVILY_API_KEY: '' }); H2.S.images = ['https://img.test/capy.png'];
    const call2 = async args => { const res = { status: 0, body: '', writeHead(s) { this.status = s; return this; }, end(b = '') { this.body = b; return this; } };
      const req = Readable.from([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post_image', arguments: args } })]);
      req.url = '/mcp'; req.method = 'POST'; await H2.S.mcpHandler(req, res); return JSON.parse(res.body).result.content[0].text; };
    assert.match(await call2({ query: 'capybara' }), /no TAVILY_API_KEY/);
    ok('post_image tells the model the truth: posted / nothing found (no image, search failed) / not set up'); }
  { const H = await textRig({ LLM_TOOLS: 'true' }); H.S.images = [];
    H.S.llmScript = [...IMG_CALL('nothing'), ...sse('I could not find one.')];
    await H.say('Luna, show me nothing'); await H.until(() => H.S.replies.length > 0);
    assert.deepStrictEqual(H.S.replies[0].files, []); assert.strictEqual(H.S.replies[0].content, 'I could not find one.');
    ok('no picture found → the reply alone'); }
  { const H = await textRig(); H.S.nowPlaying = { playing: true, title: 'Seal - Crazy' }; await H.say('Luna, play some jazz'); await H.until(() => H.S.replies.length > 0);
    assert.strictEqual(H.S.replies[0].content ?? H.S.replies[0], 'Adding some jazz to the queue.'); ok('typed "Luna, play some jazz" while music plays → "Adding some jazz to the queue."'); }
  { const H = await textRig(); await H.say('Luna, play some jazz'); await H.until(() => H.S.replies.length > 0);
    assert.ok(H.S.sends.includes('!play some jazz') && H.S.llmRequests.length === 0); ok('"Luna, play …" in text → smakbot command, no LLM'); }
  { const H = await textRig(); H.S.nowPlaying = { playing: true, paused: true, title: 'Crazy', requested_by: 'smakus' };
    await H.say('Luna, what song is this?'); await H.until(() => H.S.replies.length > 0);
    assert.strictEqual(H.S.replies[0].content, "It's paused on Crazy, requested by smakus."); assert.strictEqual(H.S.llmRequests.length, 0);
    ok('"Luna, what song is this?" in text → answered from smakbot, no LLM'); }
  { const H = await textRig({ LLM_TOOLS: 'true' }); H.S.llmScript = [[5, { type: 'tool_call.start' }], [5, { type: 'tool_call.name', tool_name: 'play_music' }],
      [5, { type: 'tool_call.arguments', tool: 'play_music', arguments: { query: 'lo-fi' } }], [5, { type: 'tool_call.success', tool: 'play_music', arguments: { query: 'lo-fi' }, output: '[]' }], ...sse('Queued some lo-fi!')];
    await H.say('Luna, put on something chill'); await H.until(() => H.S.replies.length > 0);
    assert.ok(H.S.sends.includes('!play lo-fi'));
    const tools = H.S.llmRequests[0].integrations.find(i => i.id === 'mcp/luna').allowed_tools;
    assert.ok(tools.includes('play_music') && tools.includes('say_in_voice') && !tools.includes('leave_channel'));
    ok('the LLM\'s music tools work from text; say_in_voice is offered there, leave_channel isn\'t'); }
  { const H = await setup({ LLM_TOOLS: 'true' }); H.S.llmRequests.length = 0; H.S.llmScript = sse('Hi.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    const tools = H.S.llmRequests[0].integrations.find(i => i.id === 'mcp/luna').allowed_tools;
    assert.ok(tools.includes('leave_channel') && !tools.includes('say_in_voice')); ok('by voice: leave_channel offered, say_in_voice not'); }
  { const H = await textRig({ LLM_TOOLS: 'true' }); await inVoice(H); H.S.llmScript = sse('"你好!"');
    await H.say('<@luna> say "hello" in Chinese in the voice channel'); await H.until(() => H.S.replies.length > 0 && H.S.played.includes('你好!'));
    const req = H.S.llmRequests.at(-1);
    assert.ok(/Reply with only the exact words to say out loud/.test(req.system) && !(req.integrations || []).length, 'only asked for the line, no tools');
    assert.ok(!/Del Taco/.test(req.system), 'no flavor line in the line to speak');
    assert.strictEqual(H.S.replies[0].content, '🔊 Said in A: 你好!');
    assert.ok(H.S.logs.some(l => /\[text\] Sam had Luna say: "你好!"/.test(l)));
    ok('"say hello in Chinese in the voice channel" → the model writes only the line → 你好! spoken, and "🔊 Said in A: 你好!" posted (no tool needed)'); }
  { const H = await textRig(); await H.say('Luna, say hi in the voice channel'); await H.until(() => H.S.replies.length > 0);
    assert.strictEqual(H.S.replies[0].content, "I'm not in a voice channel right now."); assert.strictEqual(H.S.llmRequests.length, 0);
    ok('say request while not in a voice channel → says so, no LLM'); }
  { const H = await textRig({ LLM_TOOLS: 'true' }); await inVoice(H);
    H.S.llmScript = [...SAY('Welcome back, Joel!'), ...sse('Done, I welcomed Joel.')];
    await H.say('Luna, Joel just joined, give him a warm welcome out loud'); await H.until(() => H.S.replies.length > 0 && H.S.played.includes('Welcome back, Joel!'));
    assert.match(H.S.replies[0].content, /welcomed Joel/); ok('other phrasings → the say_in_voice tool still works'); }
  { const H = await textRig(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(50); H.S.tts.length = 0; H.S.replies.length = 0;
    const msg = { content: '!luna say Hey smakus, dinner is ready!', author: { id: 'u2', bot: false }, member: { displayName: 'Joel' }, channel: H.chan(),
      reply: async r => { H.S.replies.push(r); }, react: async e => { (H.S.reactions ??= []).push(e); } };
    H.T.client.emit('messageCreate', msg); await H.until(() => H.S.tts.length > 0);
    assert.strictEqual(H.S.tts[0].text, 'Hey smakus, dinner is ready!'); assert.strictEqual(H.S.llmRequests.length, 0);
    assert.ok(!H.S.tts[0].cache, 'one-off text is not cached');
    assert.strictEqual(JSON.stringify(H.S.reactions), '["🔊"]');
    msg.content = '!luna say ' + 'x'.repeat(600); H.T.client.emit('messageCreate', msg); await H.until(() => H.S.tts.length > 1);
    assert.strictEqual(H.S.tts[1].text.length, 400, 'capped');
    ok('"!luna say …" → those exact words spoken (no LLM), 🔊 reaction; capped at 400 characters'); }
  { const H = await textRig(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(50); H.S.tts.length = 0; H.S.replies.length = 0;
    const msg = { content: "!luna voice tupac Ay yo, what's poppin'?", author: { id: 'u2', bot: false }, member: { displayName: 'Joel' }, channel: H.chan(),
      reply: async r => { H.S.replies.push(r); }, react: async e => { (H.S.reactions ??= []).push(e); } };
    H.S.played.length = 0; H.T.client.emit('messageCreate', msg); await H.until(() => H.S.played.some(p => /tupac/.test(p)));
    assert.deepStrictEqual(H.S.voiceTts.map(v => [v.voice, v.text]), [['chatterbox:tupac', "Ay yo, what's poppin'?"]]);
    assert.deepStrictEqual(H.S.played, ["[voice chatterbox:tupac] Ay yo, what's poppin'?"]); assert.strictEqual(H.S.llmRequests.length, 0);
    msg.content = '!luna voice --file stewart Engage!'; H.T.client.emit('messageCreate', msg); await H.until(() => H.S.replies.length > 0);
    assert.deepStrictEqual(H.S.wavs, [{ text: 'Engage!', voice: 'stewart' }]); assert.strictEqual(H.S.replies[0].files[0].name, 'stewart-engage.wav');
    ok('"!luna voice tupac …" → spoken in Chatterbox\'s tupac voice (no LLM); "--file stewart …" → a .wav reply'); }
  { const H = await textRig(); const at = new Date().toISOString(), old = new Date(Date.now() - 3 * 86400000).toISOString();
    H.S.wakeLog = [
      { t: at, event: 'detected', who: 'smakus', id: 'u1', score: 0.7 }, { t: at, event: 'detected', who: 'smakus', id: 'u1', score: 0.8 },
      { t: at, event: 'detected', who: 'smakus', id: 'u1', score: 0.6 }, { t: at, event: 'confirmed', who: 'smakus', id: 'u1' },
      { t: at, event: 'missed', who: 'appa', id: 'u2', answered: 'yes' }, { t: at, event: 'missed', who: 'appa', id: 'u2', answered: 'late' },
      { t: at, event: 'detected', who: 'appa', id: 'u2', score: 0.41 }, { t: at, event: 'near-miss', who: 'appa', id: 'u2', heard: 'hey Lena' },
      { t: at, event: 'near-miss', who: 'appa', id: 'u2', heard: 'Hey Lena' }, { t: at, event: 'discarded', who: 'joel', id: 'u3', peak: 0.01 },
      { t: old, event: 'detected', who: 'smakus', id: 'u1', score: 0.9 },
    ];
    const msg = { content: '!luna wakestats', author: { id: 'u1', bot: false }, channel: H.chan(), reply: async r => { H.S.replies.push(r); } };
    H.T.client.emit('messageCreate', msg); await H.until(() => H.S.replies.length > 0);
    assert.strictEqual(H.S.replies[0], '**Wake word, last 1 day**\n' +
      '• **smakus** — answered 4 of 4 "hey Luna"s (model 3, near-threshold check 1). Typical model score 0.70.\n' +
      '• **appa** — answered 2 of 3 "hey Luna"s (model 1, backup 1); 1 caught too late to answer. Typical model score 0.41. Near misses: "hey lena" ×2.');
    msg.content = '!luna wakestats 7d'; H.T.client.emit('messageCreate', msg); await H.until(() => H.S.replies.length > 1);
    assert.match(H.S.replies[1], /^\*\*Wake word, last 7 days\*\*\n• \*\*smakus\*\* — answered 5 of 5/);
    assert.strictEqual(H.S.llmRequests.length, 0);
    ok('"!luna wakestats" → per person from the wake-word log: answered of "hey Luna"s, how, typical score, near misses; "7d" widens it'); }
  { const H = await textRig(); H.S.llmScript = [[50, null], ...TOOL, [50, null], ...sse('It is sunny.')];
    await H.T.handleQuery("what's the weather", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(200);
    const headsUp = H.S.tts.find(t => BUILTIN.includes(t.text)), answer = H.S.tts.find(t => t.text === 'It is sunny.');
    assert.ok(headsUp && answer, H.S.tts.map(t => t.text).join(' | '));
    assert.strictEqual(headsUp.cache, true); assert.ok(!answer.cache);
    ok('phrase cache: the search heads-up is asked for cached, the answer is not'); }
  { const H = await textRig(); const msg = { content: '!luna say hi', author: { id: 'u2', bot: false }, member: null, channel: H.chan(), reply: async r => { H.S.replies.push(r); }, react: async () => {} };
    H.T.client.emit('messageCreate', msg); await H.wait(50);
    assert.deepStrictEqual(H.S.replies, ["I'm not in a voice channel."]); ok('"!luna say" when not in a voice channel → says so'); }
  { const H = await textRig(); H.S.llmScript = [[50, null], ...TOOL, [50, null], ...sse('Sunny.')];
    await H.say('Luna, weather in Irvine?'); await H.until(() => H.S.replies.length > 0);
    assert.strictEqual(JSON.stringify(H.S.reactions), '["🔍"]'); assert.strictEqual(H.S.tts.length, 0); ok('a web search → 🔍 reaction on the question, no spoken heads-up'); }
  { const H = await textRig({ TEXT_CHAT_CHANNELS: '' }); await H.say('Luna, hi'); await H.wait(100);
    assert.strictEqual(H.S.llmRequests.length, 0); ok('TEXT_CHAT_CHANNELS unset → off'); }


  console.log('ALL PASS'); clearInterval(keepAlive);
})().catch(e => { console.error('FAIL:', e.stack); process.exit(1); });
