// "!luna voices" and "!luna voice [name] <text> [--file]" (text-commands.js).
// Run: npm test   (see docs/DEVELOPMENT.md)
const { describe, it } = require('node:test');
const assert = require('assert');
const { createTextCommands } = require('../text-commands');

function rig({ names = ['default', 'luna', 'stewart', 'tupac'], inVoice = true, wavFails = false } = {}) {
  const posted = [], said = [], rendered = [], reactions = [];
  const voices = {
    list: async () => names,
    say: (text, voice, userId, who) => { if (!inVoice) return false; said.push({ text, voice, userId, who }); return true; },
    wav: async (text, voice) => { rendered.push({ text, voice }); if (wavFails) throw new Error('Chatterbox error 500: boom'); return Buffer.from('RIFF'); },
  };
  const commands = createTextCommands({ command: '!luna', wakeLabel: 'hey Luna', isReady: () => true, session: {}, announcer: {},
    wakeLog: {}, sayInVoice: () => true, leave: () => {}, console: { log() {}, warn() {} }, voices, maxChars: 40 });
  const send = async content => {
    const handled = commands.onMessage({ content, author: { id: 'u1', bot: false }, member: { displayName: 'Sam' },
      reply: async r => { posted.push(r); }, react: async e => { reactions.push(e); }, channel: { sendTyping: async () => {} } });
    await new Promise(r => setTimeout(r, 10));
    return handled;
  };
  return { send, posted, said, rendered, reactions };
}
const text = r => (typeof r === 'string' ? r : r.content);

describe('!luna voices', () => {
  it('lists the Chatterbox voices, luna and default included, and how to use them', async () => {
    const R = rig();
    assert.strictEqual(await R.send('!luna voices'), true);
    const t = text(R.posted[0]);
    for (const v of ['`default` (built into the model', '`luna`', '`stewart`', '`tupac`']) assert.ok(t.includes(v), v);
    assert.match(t, /!luna voice <name> <text>.*!luna voice <text>.*--file/s);
  });
  it('Chatterbox not running → says so', async () => {
    const R = rig({ names: null });
    await R.send('!luna voices');
    assert.match(text(R.posted[0]), /Chatterbox isn't running/);
  });
});

describe('!luna voice', () => {
  it('a named voice (any capitalization) says the rest in the voice channel, and reacts 🔊', async () => {
    const R = rig();
    assert.strictEqual(await R.send('!luna voice Tupac Ay yo, what\'s poppin\'?'), true);
    assert.deepStrictEqual(R.said, [{ text: "Ay yo, what's poppin'?", voice: 'tupac', userId: 'u1', who: 'Sam' }]);
    assert.deepStrictEqual(R.reactions, ['🔊']);
  });
  it('her own clone: luna', async () => {
    const R = rig();
    await R.send('!luna voice luna [laugh] Okay, that one got me.');
    assert.deepStrictEqual(R.said.map(s => [s.voice, s.text]), [['luna', '[laugh] Okay, that one got me.']]);
  });
  it('no voice named → the default voice says the whole text; "default" works by name too', async () => {
    const R = rig();
    await R.send('!luna voice Hello there everyone');
    await R.send('!luna voice default Hello again');
    assert.deepStrictEqual(R.said.map(s => [s.voice, s.text]), [['default', 'Hello there everyone'], ['default', 'Hello again']]);
  });
  it('--file (anywhere) → a .wav to download, posted as a reply; nothing spoken', async () => {
    const R = rig();
    await R.send('!luna voice stewart --file Make it so. Engage!');
    await R.send('!luna voice Hello --file');
    assert.deepStrictEqual(R.rendered, [{ text: 'Make it so. Engage!', voice: 'stewart' }, { text: 'Hello', voice: 'default' }]);
    assert.strictEqual(R.posted[0].files[0].name, 'stewart-make-it-so-engage.wav');
    assert.strictEqual(R.posted[1].files[0].name, 'default-hello.wav');
    assert.strictEqual(text(R.posted[0]), '🎙️ `stewart`: Make it so. Engage!');
    assert.deepStrictEqual(R.said, []);
  });
  it('--file works without being in a voice channel; speaking does not, and says how to get a file', async () => {
    const R = rig({ inVoice: false });
    await R.send('!luna voice tupac hi');
    assert.match(text(R.posted[0]), /not in a voice channel.*--file/);
    await R.send('!luna voice tupac --file hi');
    assert.strictEqual(R.posted[1].files[0].name, 'tupac-hi.wav');
  });
  it('problems are said plainly: no text, Chatterbox down, a failed render; long text is capped', async () => {
    let R = rig();
    await R.send('!luna voice tupac');
    assert.match(text(R.posted[0]), /Say what\?.*`tupac`/);
    R = rig({ names: null });
    await R.send('!luna voice tupac hi');
    assert.match(text(R.posted[0]), /Chatterbox isn't running/);
    R = rig({ wavFails: true });
    await R.send('!luna voice tupac --file hi');
    assert.match(text(R.posted[0]), /Couldn't render that in `tupac`: Chatterbox error 500/);
    R = rig();
    await R.send('!luna voice ' + 'x'.repeat(100));
    assert.strictEqual(R.said[0].text.length, 40);
  });
  it('"!luna voices" and "!luna voice…" are told apart; bots are ignored', async () => {
    const R = rig();
    await R.send('!luna voices');
    assert.deepStrictEqual(R.said, []);
    assert.strictEqual(await R.send('!luna voicecheck'), true, 'still voicecheck, not a voice called "check"');
  });
});
