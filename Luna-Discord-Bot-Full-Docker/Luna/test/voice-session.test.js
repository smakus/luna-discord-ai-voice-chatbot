// Joining, moving and leaving voice channels; lost connections; undecodable packets and encrypted voice (DAVE).
// Run: npm test   (see docs/DEVELOPMENT.md)
const { assert, boot, ok, sse, BUILTIN, setup, TOOL, FILL, T, isFiller, fillersIn, reasoningDeltas, searchPhase, tavily, found, msg, searched, FAKE, wakeRig, bareRig, MUSIC_CALL, NP, textRig, TOP, MINE, IMG_CALL, PICS, SAY, inVoice, daveSetup, loudChunk, fakeDave, voicecheck } = require('./helpers');
const keepAlive = setInterval(() => {}, 1000);

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

  console.log('leaving on request');
  { const H = await setup({}); H.S.llmRequests.length = 0;
    await H.T.handleQuery('Okay, leave the channel.', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.destroyed.length > 0);
    assert.strictEqual(H.S.llmRequests.length, 0, 'no LLM');
    assert.ok(['Okay, bye everyone!', "Alright, I'm heading out. Bye!", 'Okay, see you later!'].includes(H.S.tts[0]?.text), H.S.tts[0]?.text);
    assert.ok(H.S.logs.some(l => /asked to leave by .* — disconnecting/.test(l)));
    ok('"leave the channel" → a goodbye, then she leaves (no LLM)'); }
  { const H = await setup({}); H.S.llmScript = sse('Sure.');
    for (const q of ['bye', 'go away', 'you can go now', 'Goodbye!']) assert.ok(H.T.LEAVE_RE.test(q), q);
    for (const q of ['leave the light on', 'bye bye birdie lyrics', 'how do I leave a server', 'go']) assert.ok(!H.T.LEAVE_RE.test(q), q);
    ok('the leave commands are whole utterances: "bye", "go away"…; "leave the light on" is a question'); }
  { const H = await setup({ LLM_TOOLS: 'true' });
    H.S.llmScript = [[5, { type: 'tool_call.start' }], [5, { type: 'tool_call.name', tool_name: 'leave_channel' }], [5, { type: 'tool_call.arguments', tool: 'leave_channel', arguments: {} }],
      [5, { type: 'tool_call.success', tool: 'leave_channel', arguments: {}, output: '[]' }], ...sse('Have a great night, everyone!')];
    await H.T.handleQuery("we're done for tonight, you can head out", H.S.lastConnection, H.text, Date.now(), 'u1');
    await H.until(() => H.S.destroyed.length > 0);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Have a great night, everyone!'], 'her goodbye is spoken, no search heads-up');
    assert.ok(H.S.played.includes('Have a great night, everyone!'), 'played before she left');
    assert.ok(H.S.logs.some(l => /the LLM called leave_channel/.test(l)));
    ok('wordier request → the LLM calls leave_channel → her goodbye plays, then she leaves'); }
  { const H = await setup({}); H.T.client.emit('messageCreate', { content: '!luna leave', author: { id: 'u1' }, member: null, guild: { id: 'g' }, channel: H.text, reply: async r => { H.S.replies.push(r); } });
    await H.wait(20); assert.strictEqual(H.S.destroyed.length, 1); assert.ok(H.S.replies.includes('Bye!')); ok('!luna leave → leaves'); }


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
    H.S.lastConnection.receiver.speaking.emit('start', 'u1'); await H.until(() => H.S.logs.some(l => /reconnecting/.test(l)));
    assert.ok(H.S.logs.some(l => /Discord reports u1 speaking, but none of their audio has decrypted in \d+s \(encryption: NOT in group, 0 decrypted\/40 failed\) — reconnecting/.test(l)));
    ok('silent-speaker warning carries the definitive verdict'); }
  { const H = await daveSetup({ VOICE_RECOVER_MS: '200' }); const c = H.S.lastConnection;
    fakeDave(c, { members: ['luna', 'u1', 'u2'], stats: { u1: { successes: 661, failures: 9 } } });
    c.receiver.speaking.emit('start', 'u1'); const before = H.S.audio.u1;
    await H.until(() => H.S.logs.some(l => /\[u1\] capture stream closed/.test(l)));
    assert.deepStrictEqual(H.S.destroyed, [], 'no reconnect');
    assert.ok(H.S.logs.some(l => /Discord reports u1 speaking and their audio is decrypting \(encryption: in group, 661 decrypted\/9 failed\), but none of it reached Luna — restarting their capture/.test(l)));
    assert.ok(before.destroyed && H.S.logs.some(l => /\[u1\] capture stream closed/.test(l)), 'their capture was restarted');
    c.receiver.speaking.emit('start', 'u1'); await H.wait(20);
    assert.ok(H.S.audio.u1 !== before && !H.S.audio.u1.destroyed, 'fresh capture on next speech');
    ok('speaker whose audio decrypts but never arrives → only their capture is restarted, no reconnect for everyone'); }
  { const H = await daveSetup({ VOICE_RECOVER_MS: '0' }); H.S.lastConnection.receiver.speaking.emit('start', 'u1'); await H.wait(300);
    assert.deepStrictEqual(H.S.destroyed, []); ok('VOICE_RECOVER_MS=0 → disabled'); }
  { const H = await daveSetup({ VOICE_RECOVER_MS: '150' });
    const first = H.S.lastConnection;
    first.receiver.speaking.emit('start', 'u1'); await H.until(() => H.S.lastConnection !== first, 6000);   // rejoined (after 1.5 s)
    H.S.lastConnection.setStatus(H.Status.Ready); await H.until(() => H.S.logs.some(l => /\[voice\] reconnected to/.test(l)));
    H.S.lastConnection.receiver.speaking.emit('start', 'u2'); await H.until(() => H.S.logs.some(l => /already reconnected recently, not retrying yet/.test(l)), 8000);
    assert.strictEqual(H.S.destroyed.length, 1); assert.ok(H.S.logs.some(l => /already reconnected recently, not retrying yet/.test(l)));
    ok('a second failure within 5 minutes → logged, not another reconnect (no loops)'); }

  console.log('ALL PASS'); clearInterval(keepAlive);
})().catch(e => { console.error('FAIL:', e.stack); process.exit(1); });
