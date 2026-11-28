// "!luna help" (text-commands.js), and that what it says about where requests
// go is still true of the routing (commands.js).
// Run: npm test   (see docs/DEVELOPMENT.md)
const { describe, it } = require('node:test');
const assert = require('assert');
const { createTextCommands, helpMessages } = require('../text-commands');
const { route } = require('../commands');

function rig() {
  const posted = [];
  const message = (content) => ({
    content, author: { id: 'u1', bot: false },
    reply: async r => { posted.push(['reply', r]); },
    channel: { send: async m => { posted.push(['send', m]); } },
  });
  const commands = createTextCommands({ command: '!luna', wakeLabel: 'hey Luna', isReady: () => true, session: {},
    announcer: {}, wakeLog: {}, sayInVoice: () => true, leave: () => {}, console: { log() {}, warn() {} } });
  return { posted, message, commands };
}

describe('!luna help', () => {
  it('posts the commands as the reply, then the three routes in the same channel', async () => {
    const { posted, message, commands } = rig();
    assert.strictEqual(commands.onMessage(message('!luna help')), true);
    await new Promise(r => setTimeout(r, 10));
    assert.deepStrictEqual(posted.map(([how]) => how), ['reply', 'send']);
    assert.match(posted[0][1].content, /^\*\*⌨️ !luna commands\*\*/);
    assert.match(posted[1][1].content, /^\*\*🗣️ Talking or typing to Luna\*\*/);
    assert.deepStrictEqual(posted.map(([, m]) => m.allowedMentions), [{ parse: [] }, { parse: [] }], 'never pings');
  });
  it('is case-insensitive, and only the exact command ("Luna, help" stays a question)', () => {
    const { message, commands } = rig();
    assert.strictEqual(commands.onMessage(message('  !Luna HELP ')), true);
    assert.strictEqual(commands.onMessage(message('!luna help me')), false);
  });
  it('each message fits in one Discord message, and every !luna command is listed', () => {
    const [cmds, routes] = helpMessages('!luna');
    assert.ok(cmds.length < 2000 && routes.length < 2000, `${cmds.length} / ${routes.length} characters`);
    for (const c of ['`!luna`', '`!luna leave`', '`!luna say <text>`', '`!luna voicecheck`', '`!luna wakestats`', '`!luna help`']) {
      assert.ok(cmds.includes(c), c);
    }
  });
});

describe('what the help says about routing is true', () => {
  const r = q => route(q, { voice: true });
  it('1. straight to smakbot: play …, play the top 10, skip, pause, resume, stop, polite versions', () => {
    assert.strictEqual(r('play Crazy by Seal').command.text, '!play Crazy by Seal');
    assert.strictEqual(r('play the top 10').command.text, '!playtop 10');
    assert.strictEqual(r('play our most played').command.text, '!playtop 10');
    for (const [q, cmd] of [['skip', '!skip'], ['pause', '!pause'], ['resume', '!resume'], ['stop', '!stop'],
                            ['can you play Crazy by Seal', '!play Crazy by Seal'], ['please skip', '!skip']]) {
      assert.strictEqual(r(q).command?.text, cmd, q);
    }
    assert.strictEqual(r('play the top 4 tracks by Toto').command.text, '!play the top 4 tracks by Toto',
      'the 💡 tip: "play the top 4 tracks by Toto" is one search for those exact words');
  });
  it('2. answered instantly: what song is this, our / my top songs, you can go now, bye', () => {
    assert.strictEqual(r('what song is this?').type, 'now-playing');
    assert.strictEqual(r('what are our top songs?').type, 'top-songs');
    assert.deepStrictEqual(r('what are my top songs?'), { type: 'top-songs', count: 5, mine: true });
    assert.strictEqual(r('you can go now').type, 'leave');
    assert.strictEqual(r('bye').type, 'leave');
  });
  it('3. the AI: every "thinking" example in the help', () => {
    for (const q of ["what's the weather tomorrow?", 'tell me a joke', 'search for the top 4 tracks by Toto and queue them',
      'put on something chill', 'queue up three Ray Charles songs', 'who requests the most songs?',
      "what are kenbeans' top songs?", 'show me a picture of a capybara']) {
      assert.strictEqual(r(q).type, 'ask', q);
    }
    assert.strictEqual(route('say hello in Chinese in the voice channel', { voice: false }).type, 'say', 'typed only');
  });
});
