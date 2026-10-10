// Auto-join (AUTO_JOIN_CHANNELS / AUTO_JOIN_TEXT_CHANNEL in index.js).
// Run: npm test   (see README → Development)
const assert = require('assert');
const boot = require('./harness');
const ok = m => console.log('  ✓ ' + m);
const FAST = { ANNOUNCE_THINKING: 'false', WAKE_FOLLOWUP_MS: '0' };
const DELAY = 2300;   // AUTO_JOIN_DELAY_MS (2 s) + margin

(async () => {
  console.log('auto-join');
  { const H = boot({ ...FAST, AUTO_JOIN_CHANNELS: 'Lounge', AUTO_JOIN_TEXT_CHANNEL: 'music' }); H.S.textChannels = ['general', 'music'];
    H.put('u1', 'Lounge'); H.put('u2', 'Lounge'); await H.start();
    assert.ok(H.S.logs.some(l => /\[voice\] auto-join: Lounge/.test(l)) && !H.S.logs.some(l => /AUTO_JOIN_\w+: no|not found/.test(l)));
    await H.until(() => H.S.lastConnection, DELAY + 1000);
    assert.strictEqual(H.S.lastConnection.channelId, 'Lounge');
    assert.ok(H.S.logs.some(l => /auto-joining Lounge \(2 people there\)/.test(l)));
    H.S.lastConnection.setStatus(H.Status.Ready); await H.until(() => H.S.tts.length > 0);
    assert.match(H.S.tts[0].text, /Luna/, 'intro');
    ok('someone in a listed channel at startup → she joins it and introduces herself'); }
  { const H = boot({ ...FAST, AUTO_JOIN_CHANNELS: 'Lounge' }); H.put('u1', 'Gaming'); await H.start(); await H.wait(DELAY);
    assert.strictEqual(H.S.lastConnection, undefined); ok('someone only in an unlisted channel → she stays out'); }
  { const H = boot({ ...FAST, AUTO_JOIN_CHANNELS: 'Lounge' }); H.S.voiceChannels = ['Lounge']; await H.start(); await H.wait(DELAY);
    assert.strictEqual(H.S.lastConnection, undefined, 'nobody there yet');
    H.move('u1', null, 'Lounge'); await H.until(() => H.S.lastConnection, DELAY + 1000);
    assert.strictEqual(H.S.lastConnection.channelId, 'Lounge'); ok('someone joins a listed channel → she follows'); }
  { const H = boot({ ...FAST, AUTO_JOIN_CHANNELS: 'Lounge' }); H.S.voiceChannels = ['Lounge']; await H.start(); await H.wait(DELAY);
    H.move('u1', null, 'Lounge'); await H.wait(500); H.move('u1', 'Lounge', null); await H.wait(DELAY);
    assert.strictEqual(H.S.lastConnection, undefined); ok('someone pops in and straight out → not summoned'); }
  { const H = boot({ ...FAST, AUTO_JOIN_CHANNELS: 'Lounge,Gaming' }); H.put('u1', 'Lounge'); H.put('u2', 'Gaming'); H.put('u3', 'Gaming'); await H.start();
    await H.until(() => H.S.lastConnection, DELAY + 1000); assert.strictEqual(H.S.lastConnection.channelId, 'Gaming'); ok('several listed channels → the busiest'); }
  { const H = boot({ ...FAST, AUTO_JOIN_CHANNELS: 'Lounge' }); H.put('u1', 'Lounge'); await H.start();
    await H.until(() => H.S.lastConnection, DELAY + 1000); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(50);
    H.move('u1', 'Lounge', null); await H.wait(50);
    assert.ok(H.S.logs.some(l => /Last real user left — disconnecting/.test(l)));
    const conn = H.S.lastConnection; H.move('u1', null, 'Lounge'); await H.until(() => H.S.lastConnection !== conn, DELAY + 1000);
    assert.notStrictEqual(H.S.lastConnection, conn); ok('leaves when the last person goes, comes back when someone returns'); }
  { const H = boot({ ...FAST, AUTO_JOIN_CHANNELS: 'Lounge' }); H.put('u1', 'Lounge'); H.put('u2', 'Lounge'); await H.start();
    await H.until(() => H.S.lastConnection, DELAY + 1000); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(50);
    await H.T.handleQuery('bye', H.S.lastConnection, H.text, Date.now(), 'u1'); await H.until(() => H.S.destroyed.length > 0);
    const first = H.S.lastConnection;
    H.move('u3', null, 'Lounge'); await H.wait(DELAY);
    assert.strictEqual(H.S.lastConnection, first, 'asked to leave: not back just because someone joins');
    H.move('u1', 'Lounge', null); H.move('u2', 'Lounge', null); H.move('u3', 'Lounge', null);
    assert.ok(H.S.logs.some(l => /auto-join channels empty — auto-join resumes/.test(l)));
    H.move('u1', null, 'Lounge'); await H.until(() => H.S.lastConnection !== first, DELAY + 1000);
    assert.notStrictEqual(H.S.lastConnection, first);
    ok('asked to leave → stays out while people remain; once the channel has emptied, auto-join resumes'); }
  { const H = boot({ ...FAST, AUTO_JOIN_CHANNELS: 'Loungee', AUTO_JOIN_TEXT_CHANNEL: 'musik' }); H.S.textChannels = ['general', 'music']; H.put('u1', 'Lounge'); await H.start();
    assert.ok(H.S.logs.some(l => /AUTO_JOIN_CHANNELS: no voice channel "Loungee" — voice channels: Lounge/.test(l)));
    assert.ok(H.S.logs.some(l => /AUTO_JOIN_TEXT_CHANNEL "musik" not found .* Text channels: general, music/.test(l)));
    ok('names that match nothing → warned at startup, with the channels that exist'); }
  { const H = boot({ ...FAST }); H.put('u1', 'Lounge'); await H.start(); await H.wait(DELAY);
    assert.strictEqual(H.S.lastConnection, undefined); assert.ok(!H.S.logs.some(l => /auto-join/.test(l))); ok('AUTO_JOIN_CHANNELS unset → off'); }
  console.log('ALL PASS');
})().catch(e => { console.error('FAIL:', e.stack); process.exit(1); });
