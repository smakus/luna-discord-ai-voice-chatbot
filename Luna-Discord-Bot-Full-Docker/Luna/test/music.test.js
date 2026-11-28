// Music with smakbot: the LLM's music tools, polite commands, "adding … to the queue", the music follow-up, now playing, top songs and requests.
// Run: npm test   (see docs/DEVELOPMENT.md)
const { assert, boot, ok, sse, BUILTIN, setup, TOOL, FILL, T, isFiller, fillersIn, reasoningDeltas, searchPhase, tavily, found, msg, searched, FAKE, wakeRig, bareRig, MUSIC_CALL, NP, textRig, TOP, MINE, IMG_CALL, PICS, SAY, inVoice, daveSetup, loudChunk, fakeDave, voicecheck } = require('./helpers');
const keepAlive = setInterval(() => {}, 1000);

(async () => {
  console.log('music tools (LLM → smakbot)');
  { const H = await setup({ LLM_TOOLS: 'true' });
    assert.ok(H.S.logs.some(l => /\[tools\] play_music, play_top_songs, skip_song, pause_music, resume_music, stop_music, list_top_songs, list_top_requesters, post_image, leave_channel, say_in_voice offered to the LLM as mcp\/luna/.test(l)) && H.S.mcpPort === 8895);
    H.S.llmRequests.length = 0; H.S.llmScript = [...sse('Sure thing!'), ...MUSIC_CALL('play_music', { query: 'chill lo-fi' }), ...sse('Coming right up.')];
    await H.T.handleQuery('put on something chill', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(200);
    assert.deepStrictEqual(H.S.llmRequests[0].integrations.map(i => i.id || i.server_label), ['tavily', 'mcp/luna'], 'search and the music tools');
    assert.ok(H.S.llmRequests[0].integrations.some(i => i.id === 'mcp/luna' && i.allowed_tools.includes('play_music')));
    assert.ok(H.S.sends.includes('!summon') && H.S.sends.includes('!play chill lo-fi'), H.S.sends.join(' | '));
    assert.ok(H.S.sends.indexOf('!summon') < H.S.sends.indexOf('!play chill lo-fi'));
    const said = H.S.tts.map(t => t.text);
    assert.deepStrictEqual(said, ['Sure thing!', 'Coming right up.'], 'no search heads-up; what she said before the call is kept');
    assert.ok(!H.S.sends.some(m => /searching the web/.test(m)));
    assert.ok(H.S.logs.some(l => /\[u1\] \[music\] the LLM called play_music \{"query":"chill lo-fi"\}/.test(l)));
    ok('"put on something chill" → the LLM calls play_music → !summon, !play chill lo-fi; no search heads-up; her words around it spoken'); }
  { const H = await setup({ LLM_TOOLS: 'true' }); H.S.llmScript = [...MUSIC_CALL('skip_song', {}), ...sse('Skipping it.')];
    await H.T.handleQuery('next one please', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    assert.ok(H.S.sends.includes('!skip') && !H.S.sends.includes('!summon')); ok('skip_song → !skip, no summon'); }
  { const H = await setup({ LLM_TOOLS: 'true' }); H.S.llmScript = [[50, null], ...TOOL, [50, null], ...sse('It is sunny.')];
    await H.T.handleQuery("what's the weather", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    assert.ok(BUILTIN.includes(H.S.tts[0].text) && H.S.sends.includes('edit:🔍 *Luna is searching the web...*') && !H.S.sends.some(m => m.startsWith('!')));
    ok('a web search next to the music tools is still announced as a search; no smakbot command'); }
  { const H = await setup({ LLM_TOOLS: 'true' }); H.S.lunaDown = true; H.S.llmRequests.length = 0; H.S.llmScript = sse('Hello.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Hello.']);
    assert.ok(H.S.logs.some(l => /\[tools\] LM Studio can't use Luna's tools .* Is "luna" in LM Studio's mcp.json\?/.test(l)));
    assert.ok(H.S.llmRequests.at(-1).integrations?.every(i => i.id !== 'mcp/luna') ?? true, 'retried without them');
    H.S.llmRequests.length = 0; await H.T.handleQuery('hi again', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(150);
    assert.ok(H.S.llmRequests.every(r => !(r.integrations || []).some(i => i.id === 'mcp/luna')), 'left out while paused');
    ok('LM Studio can\'t reach the music tools → answered without them, warned once, left out for a while'); }
  { const H = await setup({ LLM_TOOLS: 'false' }); H.S.llmRequests.length = 0; H.S.llmScript = sse('Hi.');
    await H.T.handleQuery('hi', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.ok(!(H.S.llmRequests[0].integrations || []).some(i => i.id === 'mcp/luna') && !H.S.logs.some(l => /\[tools\]|\[music\]/.test(l)));
    ok('LLM_TOOLS=false → not offered, no server'); }


  console.log('polite commands');
  { const H = await setup({});
    const cmd = q => { const c = H.T.extractSmakbotCommand(q); return c && c.build(c.arg); };
    assert.strictEqual(cmd("can you play Seal, we're never gonna survive."), "!play Seal, we're never gonna survive");
    assert.strictEqual(cmd('Could you please play some jazz for me?'), '!play some jazz');
    assert.strictEqual(cmd('Okay, would you play Bohemian Rhapsody please.'), '!play Bohemian Rhapsody');
    assert.strictEqual(cmd('play Right Now'), '!play Right Now');
    assert.strictEqual(cmd('can you skip this song?'), '!skip');
    assert.strictEqual(cmd('please stop the music, thanks'), '!stop');
    assert.strictEqual(cmd('play the top 10'), '!playtop 10');
    assert.strictEqual(cmd('can you play the top twenty songs?'), '!playtop 20');
    assert.strictEqual(cmd('play our most played'), '!playtop 10');
    assert.strictEqual(cmd('play the 15 most played tracks'), '!playtop 15');
    assert.strictEqual(cmd('play my favorites'), '!playtop 10');
    assert.strictEqual(cmd('play the top 100'), '!playtop 50');
    assert.strictEqual(cmd('can you play our top three hits?'), '!playtop 3');
    assert.strictEqual(cmd('play our top jams'), '!playtop 10');
    assert.strictEqual(cmd('play my 5 most played jams'), '!playtop 5');
    assert.strictEqual(cmd('play greatest hits'), '!play greatest hits');
    for (const q of ['pause.', 'pause the music', 'can you pause the song for a sec?']) assert.strictEqual(cmd(q), '!pause', q);
    for (const q of ['resume', 'unpause', 'un-pause the music', 'keep playing']) assert.strictEqual(cmd(q), '!resume', q);
    for (const q of ['pause for effect when you tell the joke', 'resume where we left off in the story']) assert.strictEqual(cmd(q), null, q);
    for (const q of ['play top of the world', 'play favorites', 'play the top 10 songs of 1985']) assert.strictEqual(cmd(q), '!play ' + q.slice(5), q);
    for (const q of ['do you play guitar?', "let's play a game", 'can you play?', 'can you stop talking']) assert.strictEqual(cmd(q), null, q);
    for (const q of ['can you leave?', 'could you please head out', 'you can go now, thanks']) assert.ok(H.T.LEAVE_RE.test(H.T.stripPoliteness(q)), q);
    assert.ok(!H.T.LEAVE_RE.test(H.T.stripPoliteness('can you leave a note?')));
    ok('"can you play …", "could you skip this song", "please stop the music, thanks", "can you leave", "play the top 10" are fixed commands; "play top of the world" is still a song'); }
  { const H = await setup({}); H.S.llmRequests.length = 0;
    await H.T.handleQuery('play the top 5', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.ok(H.S.sends.includes('!summon') && H.S.sends.includes('!playtop 5') && H.S.llmRequests.length === 0, H.S.sends.join(' | '));
    assert.strictEqual(H.S.tts[0].text, 'Okay, playing the top 5.');
    ok('"play the top 5" → !summon, !playtop 5, "Okay, playing the top 5." (no LLM)'); }
  console.log('"adding … to the queue" when music is already playing');
  { const H = await setup({}); H.S.nowPlaying = { playing: true, paused: false, title: 'Seal - Crazy' };
    await H.T.handleQuery('play Kiss From a Rose', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.strictEqual(H.S.tts[0].text, 'Adding Kiss From a Rose to the queue.'); assert.ok(H.S.sends.some(m => m.startsWith('!play Kiss From a Rose')));
    H.S.tts.length = 0; await H.wait(2100);
    await H.T.handleQuery('play the top 5', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.strictEqual(H.S.tts[0].text, 'Adding the top 5 to the queue.');
    ok('smakbot already playing → "Adding Kiss From a Rose to the queue." / "Adding the top 5 to the queue."'); }
  { const H = await setup({}); H.S.nowPlaying = { playing: true, paused: true, title: 'Seal - Crazy' };
    await H.T.handleQuery('play Kiss From a Rose', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.strictEqual(H.S.tts[0].text, 'Adding Kiss From a Rose to the queue.'); ok('paused on a song counts as playing → "adding … to the queue"'); }
  { const H = await setup({}); H.S.nowPlaying = { playing: false };
    await H.T.handleQuery('play Kiss From a Rose', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.strictEqual(H.S.tts[0].text, 'Okay, playing Kiss From a Rose.'); ok('nothing playing → "Okay, playing …", as before'); }
  { const H = await setup({}); H.S.musicDown = true;
    await H.T.handleQuery('play Kiss From a Rose', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.strictEqual(H.S.tts[0].text, 'Okay, playing Kiss From a Rose.'); ok('smakbot\'s status unreachable → "playing", as before'); }
  { const H = await setup({}); H.S.nowPlaying = { playing: true, title: 'Seal - Crazy' };
    await H.T.handleQuery('skip', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.strictEqual(H.S.tts[0].text, 'Skipping.'); assert.ok(!H.S.nowPlayingAsked, 'not asked for other commands');
    ok('"skip" etc. → unchanged, smakbot not asked'); }
  { const H = await setup({}); const id = '189231634736873473'; H.put(id, 'A'); await H.wait(10);
    await H.T.handleQuery('play some jazz', H.S.lastConnection, H.text, Date.now(), id); await H.until(() => H.S.sends.some(m => /^!play /.test(m?.content ?? m)));
    const credited = H.S.sends.find(m => m?.content === `!play some jazz --for=<@${id}>`);
    assert.ok(credited, JSON.stringify(H.S.sends)); assert.deepStrictEqual(credited.allowedMentions, { parse: [] }, 'shown as @name, nobody pinged');
    H.S.sends.length = 0; await H.T.handleQuery('skip', H.S.lastConnection, H.text, Date.now(), id); await H.wait(50);
    assert.ok(H.S.sends.includes('!skip'), 'only songs that are queued are credited');
    const { sendSmakbotCommand } = H.T; const sent = []; const chan = { send: async m => sent.push(m) }; const quiet = { log() {}, error() {} };
    await sendSmakbotCommand(chan, { text: '!playtop 10', summon: true }, { musicBotPresent: true, console: quiet, requesterId: id });
    await sendSmakbotCommand(chan, { text: '!play x', summon: true }, { musicBotPresent: true, console: quiet, requesterId: 'text' });
    assert.deepStrictEqual(sent.map(m => m.content ?? m), [`!playtop 10 --for=<@${id}>`, '!play x']);
    ok('a song asked for by voice → "!play … --for=<@their id>" (shown as @name, no ping), so smakbot credits them; !skip and non-Discord ids untouched'); }
  { const H = await setup({ LLM_TOOLS: 'true' }); H.S.llmScript = [[5, { type: 'tool_call.start' }], [5, { type: 'tool_call.name', tool_name: 'play_top_songs' }],
      [5, { type: 'tool_call.arguments', tool: 'play_top_songs', arguments: { count: 8 } }], [5, { type: 'tool_call.success', tool: 'play_top_songs', arguments: { count: 8 }, output: '[]' }], ...sse('Here come the favourites!')];
    await H.T.handleQuery('put on the usual stuff', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.sends.includes('!playtop 8'));
    ok('the LLM calls play_top_songs {count: 8} → !playtop 8'); }
  { const H = await setup({}); H.S.llmRequests.length = 0;
    await H.T.handleQuery('can you play some jazz?', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.ok(H.S.sends.includes('!play some jazz') && H.S.llmRequests.length === 0, H.S.sends.join(' | '));
    ok('"can you play some jazz?" → smakbot, no LLM'); }
  { const H = await setup({ LLM_TOOLS: 'true' }); H.S.llmRequests.length = 0; H.S.llmScript = sse('Sure.');
    await H.T.handleQuery('put on something chill', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.match(H.S.llmRequests[0].system, /You have tools to play, skip or stop music, leave the voice channel and post a picture in the text chat\./);
    ok('the system prompt names the tools offered'); }

  console.log('said music was queued without calling a tool → one follow-up');
  { const { claimsMusic } = require(require('path').join(__dirname, '..', 'llm-tools.js'));
    for (const t of ["Let's get \"Hit the Road Jack\" and \"What'd I Say\" queued up for you, smakus.", "I'll keep them spinning.",
      "Alright, I'll play some Ray Charles for you.", "Coming right up!", "I've cued up three classics.", "Let me queue up a few of his hits."])
      assert.ok(claimsMusic(t), t);
    for (const t of ['Toto\'s top three songs are "Africa", "Rosanna" and "Hold the Line".', 'It is sunny and 72 degrees.',
      'Let me know if you want me to play one.', 'Ray Charles played piano from the age of three.'])
      assert.ok(!claimsMusic(t), t);
    ok('claimsMusic: "queued up", "keep them spinning", "I\'ll play…", "coming right up" are claims; a song list, "let me know if…", "played piano" are not'); }
  { const H = await setup({ LLM_TOOLS: 'true' }); H.S.names = { u1: 'Sam' }; H.put('u1', 'A'); H.S.llmRequests.length = 0;
    H.S.llmScripts = [sse('Let\'s get "Hit the Road Jack" and "What\'d I Say" queued up for you.'),
      [...MUSIC_CALL('play_music', { query: 'Hit the Road Jack Ray Charles' }), ...MUSIC_CALL('play_music', { query: "What'd I Say Ray Charles" }), ...sse('Done.')]];
    await H.T.handleQuery('cue up two Ray Charles songs', H.S.lastConnection, H.text, Date.now(), 'u1');
    await H.until(() => H.S.sends.includes("!play What'd I Say Ray Charles"));
    assert.strictEqual(H.S.llmRequests.length, 2);
    assert.match(H.S.llmRequests[1].input, /your reply above said music was queued or playing, but you called no music tool/);
    assert.ok(H.S.llmRequests[1].prev, 'same conversation');
    assert.ok(H.S.sends.includes('!play Hit the Road Jack Ray Charles'));
    await H.wait(100); assert.ok(!H.S.tts.some(t => t.text === 'Done.'), 'the follow-up is not spoken');
    assert.ok(H.S.logs.some(l => /said music was queued but called no music tool/.test(l)) && H.S.logs.some(l => /music follow-up: 2 music call\(s\) made/.test(l)));
    ok('voice: "…queued up for you" with no tool call → one follow-up in the same conversation; its play_music calls reach smakbot, its words are not spoken'); }
  { const H = await setup({ LLM_TOOLS: 'true' }); H.S.names = { u1: 'Sam' }; H.put('u1', 'A'); H.S.llmRequests.length = 0;
    H.S.llmScripts = [sse("I'm going to play devil's advocate here."), sse('no')];
    await H.T.handleQuery('is pineapple on pizza good?', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(300);
    assert.strictEqual(H.S.llmRequests.length, 2); assert.ok(!H.S.sends.some(m => typeof m === 'string' && m.startsWith('!play')));
    assert.ok(!H.S.tts.some(t => t.text === 'no')); assert.ok(H.S.logs.some(l => /music follow-up: no calls \(no music meant\)/.test(l)));
    ok('a false alarm ("play devil\'s advocate") → the follow-up says no: nothing queued, nothing said'); }
  { const H = await setup({ LLM_TOOLS: 'true' }); H.S.names = { u1: 'Sam' }; H.put('u1', 'A'); H.S.llmRequests.length = 0;
    H.S.llmScript = [...sse('Sure thing!'), ...MUSIC_CALL('play_music', { query: 'chill lo-fi' }), ...sse('Queued up some lo-fi.')];
    await H.T.handleQuery('put on something chill', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(300);
    assert.strictEqual(H.S.llmRequests.length, 1, 'a real call → no follow-up');
    const H2 = await setup({ LLM_TOOLS: 'false' }); H2.S.names = { u1: 'Sam' }; H2.put('u1', 'A'); H2.S.llmRequests.length = 0; H2.S.llmScript = sse("I've queued it up.");
    await H2.T.handleQuery('what should we listen to?', H2.S.lastConnection, H2.text, Date.now(), 'u1'); await H2.wait(300);
    assert.strictEqual(H2.S.llmRequests.length, 1, 'tools off → no follow-up');
    ok('no follow-up when a music tool was called, or when the tools are off'); }

  console.log('now playing (smakbot)');
  { const H = await setup({}); H.S.nowPlaying = NP; H.S.llmRequests.length = 0;
    await H.T.handleQuery("what song is this?", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.strictEqual(H.S.tts[0].text, 'This is Crazy by Seal, requested by smakus. Up next: Kiss From a Rose.');
    assert.strictEqual(H.S.llmRequests.length, 0);
    ok('"what song is this?" → "This is Crazy by Seal, requested by smakus. Up next: Kiss From a Rose." (no LLM)'); }
  { const H = await setup({}); H.S.nowPlaying = { playing: false };
    await H.T.handleQuery("what's playing", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.strictEqual(H.S.tts[0].text, "Nothing's playing right now."); ok('nothing playing → says so'); }
  { const H = await setup({}); H.S.musicDown = true;
    await H.T.handleQuery("what song is this", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.match(H.S.tts[0].text, /can't reach the music bot/); assert.ok(H.S.logs.some(l => /\[music\] can't reach smakbot/.test(l)));
    ok("smakbot unreachable → says it can't tell, warns in the log"); }
  { const H = await setup({ MUSIC_STATUS_URL: '' }); H.S.llmScript = sse('No idea!'); H.S.llmRequests.length = 0;
    await H.T.handleQuery("what song is this", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.strictEqual(H.S.llmRequests.length, 1); assert.ok(!H.S.nowPlayingAsked); ok('MUSIC_STATUS_URL unset → an ordinary question for the LLM'); }
  { const H = await setup({}); H.S.nowPlaying = NP; H.S.llmScript = sse('It is about love.'); H.S.llmRequests.length = 0;
    await H.T.handleQuery("what is this song about?", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.match(H.S.llmRequests[0].system, /Music playing in the voice channel now: "Seal - Crazy", artist: Seal, track: Crazy, requested by smakus \(1:13 of 3:32\)\. When someone asks about "this song"/);
    H.S.nowPlaying = { playing: false }; H.S.llmRequests.length = 0; await H.wait(2100);
    await H.T.handleQuery("tell me a joke", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.ok(!/Music playing/.test(H.S.llmRequests[0].system));
    ok('"what is this song about?" → the LLM, told what is playing; nothing playing → no music line'); }

  console.log('top songs, read out (smakbot)');
  { const H = await setup({}); const r = q => JSON.stringify(H.T.route(q, { voice: true }));
    for (const [q, want] of [['What are our top songs?', '{"type":"top-songs","count":5}'], ['what are the top 3 hits?', '{"type":"top-songs","count":3}'],
      ['list our top ten', '{"type":"top-songs","count":10}'], ['tell me the 2 most played songs', '{"type":"top-songs","count":2}'],
      ["what's our top song?", '{"type":"top-songs","count":1}'], ['which are our most played jams lately', '{"type":"top-songs","count":5}']])
      assert.strictEqual(r(q), want, q);
    for (const q of ["what's the top song by Queen?", "what's at the top of the charts?"]) assert.strictEqual(r(q), '{"type":"ask"}', q);
    assert.match(r('play our top five songs'), /"!playtop 5"/);
    ok('"what are our top songs?" (and "top 3 hits", "list our top ten", "our top song") → read out; "play our top five" still plays; "top song by Queen" → the LLM'); }
  { const H = await setup({}); H.S.topSongs = TOP; H.S.llmRequests.length = 0;
    await H.T.handleQuery('what are our top 3 songs?', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.strictEqual(H.S.tts[0].text, "Your top 3: One Chain to Rule Them All, 13 plays. Shock My Dog I Can't Stop, 9. Dire Straits - Money For Nothing, 4.");
    assert.ok(H.S.topSongsAsked[0].endsWith('/top-songs?count=3'), H.S.topSongsAsked[0]);
    assert.strictEqual(H.S.llmRequests.length, 0); assert.ok(!H.S.sends.some(m => m.startsWith('!')), 'nothing played'); assert.ok(!H.S.tts[0].cache);
    ok('"what are our top 3 songs?" → "Your top 3: One Chain to Rule Them All, 13 plays. …" from smakbot (no LLM, nothing played, not cached)'); }
  { const H = await setup({}); H.S.topSongs = TOP;
    await H.T.handleQuery("what's our top song?", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.strictEqual(H.S.tts[0].text, 'Your most played song is One Chain to Rule Them All, 13 plays.'); ok('"what\'s our top song?" → just the one'); }
  { const H = await setup({}); H.S.topSongs = [];
    await H.T.handleQuery('what are our top songs', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.strictEqual(H.S.tts[0].text, 'Nothing has been played enough to count yet.'); ok('no play counts yet → says so'); }
  { const H = await setup({}); H.S.musicDown = true;
    await H.T.handleQuery('what are our top songs', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.match(H.S.tts[0].text, /can't reach the music bot/); ok("smakbot unreachable → says it can't check"); }
  { const H = await textRig(); H.S.topSongs = TOP;
    await H.say('Luna, what are our top 2 hits?'); await H.until(() => H.S.replies.length > 0);
    assert.strictEqual(H.S.replies[0].content, "Your top 2: One Chain to Rule Them All, 13 plays. Shock My Dog I Can't Stop, 9."); assert.strictEqual(H.S.llmRequests.length, 0);
    ok('"Luna, what are our top 2 hits?" in text → answered from smakbot, no LLM'); }
  { const H = await setup({ LLM_TOOLS: 'true' }); H.S.topSongs = TOP;
    const { Readable } = require('stream');
    const call = async body => { const res = { status: 0, body: '', writeHead(s) { this.status = s; return this; }, end(b = '') { this.body = b; return this; } };
      const req = Readable.from([JSON.stringify(body)]); req.url = '/mcp'; req.method = 'POST'; await H.S.mcpHandler(req, res); return JSON.parse(res.body); };
    const list = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(list.result.tools.some(t => t.name === 'list_top_songs'));
    const got = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_top_songs', arguments: { count: 3 } } });
    assert.strictEqual(got.result.content[0].text, 'Most played songs in this server, most first:\n1. One Chain to Rule Them All (13 plays)\n' +
      "2. Shock My Dog I Can't Stop (9 plays)\n3. Dire Straits - Money For Nothing (4 plays)");
    assert.ok(!H.S.sends.some(m => m.startsWith('!')), 'nothing played');
    H.S.llmRequests.length = 0; H.S.llmScript = sse('Yes, Tom Sawyer is fourth.');
    await H.T.handleQuery('is Tom Sawyer in our top ten?', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.ok(H.S.llmRequests[0].integrations.some(i => i.id === 'mcp/luna' && i.allowed_tools.includes('list_top_songs')));
    ok('LLM tool list_top_songs: offered, answers the model with the list from smakbot, plays nothing ("is Tom Sawyer in our top ten?")'); }
  console.log("one person's top songs (smakbot request history)");
  { const H = await setup({}); const r = q => JSON.stringify(H.T.route(q, { voice: true }));
    assert.strictEqual(r('what are my top songs?'), '{"type":"top-songs","count":5,"mine":true}');
    assert.strictEqual(r("what's my top song"), '{"type":"top-songs","count":1,"mine":true}');
    assert.strictEqual(r('list my top 3 tracks'), '{"type":"top-songs","count":3,"mine":true}');
    assert.strictEqual(r("what are kenbeans' top songs?"), '{"type":"ask"}');
    ok('"what are my top songs?" → the asker\'s own requests; "kenbeans\' top songs" → the LLM (and its tool)'); }
  { const H = await setup({}); H.S.userTop = { u1: MINE };
    await H.T.handleQuery('what are my top 2 songs?', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.strictEqual(H.S.tts[0].text, 'Your top 2 requests: Neil Young - Heart of Gold, 4 requests. Sledgehammer, 2.');
    assert.match(H.S.topSongsAsked[0], /\/top-songs\?user=u1&count=2$/); assert.strictEqual(H.S.llmRequests.length, 0);
    ok('"what are my top 2 songs?" → smakbot asked by the speaker\'s ID → "Your top 2 requests: …" (no LLM)'); }
  { const H = await setup({}); H.S.userTop = {};
    await H.T.handleQuery("what's my top song", H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.tts.length > 0);
    assert.strictEqual(H.S.tts[0].text, "I don't have any song requests from you yet."); ok('no requests from the asker yet → says so'); }
  { const H = await textRig(); H.S.userTop = new Proxy({}, { get: () => MINE });  // whoever the author is
    await H.say('Luna, what are my top songs?'); await H.until(() => H.S.replies.length > 0);
    assert.strictEqual(H.S.replies[0].content, 'Your top 3 requests: Neil Young - Heart of Gold, 4 requests. Sledgehammer, 2. Biko, 1.');
    assert.strictEqual(H.S.llmRequests.length, 0); ok('"Luna, what are my top songs?" in text → the author\'s requests, no LLM'); }
  { const H = await setup({ LLM_TOOLS: 'true', NAME_PRONUNCIATIONS: 'smakus=smackus' }); H.S.userTop = { smakus: MINE }; H.S.userMatches = [];
    const { Readable } = require('stream');
    const call = async args => { const res = { status: 0, body: '', writeHead(s) { this.status = s; return this; }, end(b = '') { this.body = b; return this; } };
      const req = Readable.from([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_top_songs', arguments: args } })]);
      req.url = '/mcp'; req.method = 'POST'; await H.S.mcpHandler(req, res); return JSON.parse(res.body).result.content[0].text; };
    assert.strictEqual(await call({ count: 2, user: 'Smackus' }), 'Songs smakus requested most, most first:\n1. Neil Young - Heart of Gold (4 requests)\n2. Sledgehammer (2 requests)');
    assert.match(H.S.topSongsAsked.at(-1), /user=smakus&count=2$/);
    assert.strictEqual(await call({ user: 'zork' }), 'Nobody called "zork" is known to the music bot. Say so.');
    H.S.userMatches = ['kenbeans', 'kendra']; assert.strictEqual(await call({ user: 'ken' }), '"ken" could be any of: kenbeans, kendra. Ask which one they mean.');
    H.S.userTop.appa = { user: 'appa', songs: [] }; assert.match(await call({ user: 'appa' }), /^appa hasn't requested any songs/);
    H.S.topSongs = TOP; assert.match(await call({ count: 1 }), /^Most played songs in this server/);
    H.S.musicDown = true; assert.match(await call({ user: 'smakus' }), /could not be reached/);
    assert.ok(!H.S.sends.some(m => m.startsWith('!')), 'nothing played');
    ok('list_top_songs with a user → that person\'s requests (speakable "Smackus" → smakus), unknown / ambiguous / none yet / unreachable said plainly'); }
  { const H = await setup({ LLM_TOOLS: 'true' });
    H.S.requesters = [{ user: 'smakus', requests: 248, songs: 192, top_song: 'One Chain to Rule Them All | Gandalf x Frodo (Lord of the Rings Rap Parody) - WeGoTunes Studio' },
      { user: 'kenbeans', requests: 116, songs: 102, top_song: 'gilette dr disrespect lyrics' }, { user: 'User X', requests: 1, songs: 1, top_song: null }];
    const { Readable } = require('stream');
    const call = async args => { const res = { status: 0, body: '', writeHead(s) { this.status = s; return this; }, end(b = '') { this.body = b; return this; } };
      const req = Readable.from([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_top_requesters', arguments: args } })]);
      req.url = '/mcp'; req.method = 'POST'; await H.S.mcpHandler(req, res); return JSON.parse(res.body).result.content[0].text; };
    assert.strictEqual(await call({ count: 4 }), 'People who requested the most songs, most first:\n' +
      '1. smakus: 248 requests (192 different songs), most requested: One Chain to Rule Them All\n' +
      '2. kenbeans: 116 requests (102 different songs), most requested: gilette dr disrespect lyrics\n3. User X: 1 request (1 different song)');
    assert.match(H.S.topSongsAsked.at(-1), /\/top-requesters\?count=4$/);
    await call({}); assert.match(H.S.topSongsAsked.at(-1), /count=5$/);
    H.S.requesters = []; assert.match(await call({}), /^Nobody has requested any songs/);
    H.S.musicDown = true; assert.match(await call({}), /could not be reached/);
    H.S.llmRequests.length = 0; H.S.musicDown = false; H.S.llmScript = sse('smakus leads.');
    await H.T.handleQuery('who requests the most songs?', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.wait(100);
    assert.ok(H.S.llmRequests[0].integrations.some(i => i.id === 'mcp/luna' && i.allowed_tools.includes('list_top_requesters')));
    assert.ok(!H.S.sends.some(m => m.startsWith('!')), 'nothing played');
    ok('LLM tool list_top_requesters: offered, ranks people by songs requested with counts and top song (default 5); none yet / unreachable said plainly'); }
  { const H = await textRig({ LLM_TOOLS: 'true' });
    H.S.llmScripts = [sse('Queued up "Africa" by Toto for you!'), [...MUSIC_CALL('play_music', { query: 'Africa Toto' }), ...sse('Done.')]];
    await H.say('Luna, queue up Africa by Toto'); await H.until(() => H.S.sends.includes('!play Africa Toto') && H.S.replies.length > 0);
    await H.wait(50); assert.strictEqual(H.S.replies.length, 1, 'the follow-up posts nothing'); assert.strictEqual(H.S.replies[0].content, 'Queued up "Africa" by Toto for you!');
    ok('text: the same follow-up; its calls reach smakbot, only the first answer is posted'); }
  console.log('ALL PASS'); clearInterval(keepAlive);
})().catch(e => { console.error('FAIL:', e.stack); process.exit(1); });
