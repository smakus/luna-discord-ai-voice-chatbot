// Voice-channel announcements: Luna's intro, join greetings, leave farewells,
// and turning display names into something speakable.
// Run: node --test test/   (see README → Development)
const assert = require('assert'), boot = require('./harness');
const ok = m => console.log('  ✓ ' + m);
const keepAlive = setInterval(() => {}, 1000);

// Short delays and cooldowns so the tests run in milliseconds.
const FAST = { GREET_DELAY_MS: '20', GREET_COOLDOWN_MS: '400', LEAVE_DELAY_MS: '40', LEAVE_COOLDOWN_MS: '400' };

// Luna in channel A with u1, ready to announce.
async function inChannel(env = {}) {
  const H = boot({ ...FAST, ...env });
  await H.start(); H.put('u1', 'A'); await H.luna('u1');
  H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(30);
  H.S.tts.length = 0;
  H.S.names = { u2: 'Sam' };
  H.said = () => H.S.tts.map(t => t.text);
  return H;
}

(async () => {
  console.log('speakableName');
  { const H = boot(FAST);
    const cases = { 'Sam': 'Sam', '𝓢𝓪𝓶 ✨': 'Sam', 'sam_1234': 'sam', 'Ｍｉｋｅ🔥': 'Mike', 'dark.knight': 'dark knight',
      "D'Angelo": "D'Angelo", '🎮🎮': '', '1234': '1234', ['x'.repeat(50)]: 'x'.repeat(32), 'Player2': 'Player', '': '' };
    for (const [raw, spoken] of Object.entries(cases)) assert.strictEqual(H.T.speakableName(raw), spoken, JSON.stringify(raw));
    assert.strictEqual(H.T.speakableName(null), '');
    ok(`${Object.keys(cases).length + 1} names: fancy fonts folded, emoji dropped, "_1234" tags removed, capped at 32 chars`); }

  console.log('intro');
  { const H = boot(FAST); await H.start(); H.S.names = { u1: 'smakus', u2: 'joel_42', u3: 'kenbeans', smakbot: 'smakbot' };
    H.S.bots = ['smakbot']; H.put('u1', 'A'); H.put('u2', 'A'); H.put('u3', 'A'); H.put('smakbot', 'A'); await H.luna('u1');
    H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(30);
    const intro = H.S.tts.map(t => t.text)[0];
    assert.ok(/Luna/.test(intro) && /hey Luna/.test(intro) && intro.includes('smakus, joel, and kenbeans'), intro);
    ok(`Luna introduces herself on joining, greeting everyone by name: "${intro}"`); }
  { const H = boot(FAST); await H.start(); H.S.names = { u1: 'smakus' }; H.put('u1', 'A'); await H.luna('u1');
    H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(30);
    assert.match(H.S.tts[0].text, /(Hey|Hi|Hello) smakus[!,]/); ok('one person → just their name'); }
  { const H = boot(FAST); await H.start(); const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    H.S.names = Object.fromEntries(ids.map(id => [id, 'Name' + id.toUpperCase().replace(/\d/, d => 'XYZWVUT'[d])])); ids.forEach(id => H.put(id, 'A')); await H.luna('a1');
    H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(30);
    assert.ok(!/Name/.test(H.S.tts[0].text) && /everyone|all|arrived/.test(H.S.tts[0].text), H.S.tts[0].text); ok('more than 6 people → no list of names, "everyone"'); }
  { const H = boot({ ...FAST, ANNOUNCE_SELF: 'false' }); await H.start(); H.put('u1', 'A'); await H.luna('u1');
    H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(30);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), []); ok('ANNOUNCE_SELF=false → no intro'); }
  { const H = boot({ ...FAST, INTRO_PHRASES: 'Luna online. Say {wake}.' }); await H.start(); H.put('u1', 'A'); await H.luna('u1');
    H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(30);
    assert.deepStrictEqual(H.S.tts.map(t => t.text), ['Luna online. Say hey Luna.']); ok('INTRO_PHRASES with {wake}'); }

  console.log('join greetings');
  { const H = await inChannel();
    H.move('u2', null, 'A'); await H.wait(80);
    assert.strictEqual(H.said().length, 1); assert.ok(/Sam/.test(H.said()[0]), H.said()[0]);
    ok(`someone joins → greeted by name: "${H.said()[0]}"`); }
  { const H = await inChannel();
    H.move('u2', null, 'A'); await H.wait(80); H.move('u2', 'A', null); await H.wait(5); H.move('u2', null, 'A'); await H.wait(120);
    assert.strictEqual(H.said().filter(t => /Sam/.test(t)).length, 1);
    ok('drops and rejoins within the leave delay → no farewell, and no second greeting (cooldown)'); }
  { const H = await inChannel({ IGNORED_USER_IDS: 'u3' });
    H.move('luna', null, 'A'); H.move('u3', null, 'A'); H.move('u1', 'A', 'A'); await H.wait(100);
    assert.deepStrictEqual(H.said(), []); ok('bots, ignored users and mute/deafen toggles (same channel) are not announced'); }
  { const H = await inChannel({ GREET_PHRASES: 'GREETING {name}' });
    H.move('u2', null, 'A'); await H.wait(5); H.move('u2', 'A', 'B'); await H.wait(100);
    assert.ok(!H.said().some(t => /GREETING/.test(t)), H.said().join(' | '));
    ok('passes through (joins, leaves before the greet delay) → not greeted'); }
  { const H = await inChannel({ GREET_PHRASES: 'Welcome aboard, {name}!' }); H.S.names = { u2: '🎮🎮' };
    H.move('u2', null, 'A'); await H.wait(80);
    assert.deepStrictEqual(H.said(), ['Someone just joined. Hey there, welcome in!']);
    ok('a name with nothing pronounceable → generic greeting'); }
  { const H = await inChannel({ GREET_PHRASES: 'Welcome aboard, {name}!' });
    H.move('u2', null, 'A'); await H.wait(80);
    assert.deepStrictEqual(H.said(), ['Welcome aboard, Sam!']); ok('GREET_PHRASES with {name}'); }
  { const H = await inChannel({ GREET_ON_JOIN: 'false' });
    H.move('u2', null, 'A'); await H.wait(80);
    assert.deepStrictEqual(H.said(), []); ok('GREET_ON_JOIN=false → no greetings'); }

  console.log('leave farewells');
  { const H = await inChannel({ FAREWELL_PHRASES: '{name} left. Bye, {name}!' });
    H.move('u2', null, 'A'); await H.wait(80); H.S.tts.length = 0;
    H.move('u2', 'A', null); await H.wait(100);
    assert.deepStrictEqual(H.said(), ['Sam left. Bye, Sam!']); ok('someone leaves → farewell (FAREWELL_PHRASES with {name})'); }
  { const H = await inChannel({ FAREWELL_PHRASES: '{name} left.' });
    H.move('u2', null, 'A'); await H.wait(80); H.S.tts.length = 0;
    H.move('u2', 'A', 'B'); await H.wait(100);
    assert.deepStrictEqual(H.said(), ['Sam left.']); ok('moves to another channel → farewell'); }
  { const H = await inChannel({ ANNOUNCE_LEAVE: 'false' });
    H.move('u2', null, 'A'); await H.wait(80); H.S.tts.length = 0;
    H.move('u2', 'A', null); await H.wait(100);
    assert.deepStrictEqual(H.said(), []); ok('ANNOUNCE_LEAVE=false → no farewells'); }

  console.log('last real user leaves');
  { const H = await inChannel(); H.move('luna', null, 'A');
    H.move('u1', 'A', null); await H.wait(100);
    assert.ok(H.S.destroyed.includes('A'), 'Luna left the channel'); assert.strictEqual(H.T.activeConnection, null);
    ok('the last real user leaves (bots don\'t count) → Luna leaves too'); }

  console.log('ALL PASS'); clearInterval(keepAlive);
})().catch(e => { console.error('FAIL:', e.stack); process.exit(1); });
