// What Luna does the same way by voice and by text (actions.js).
// Run: npm test   (see docs/DEVELOPMENT.md)
const { describe, it } = require('node:test');
const assert = require('assert');
const { createActions } = require('../actions');

// A fake LLM whose stream makes the given tool calls, then ends.
function fakeLlm({ calls = [], tools = true } = {}) {
  const asked = [];
  return {
    asked,
    canUseTools: () => tools,
    async *stream(input, opts) {
      asked.push({ input, opts });
      for (const c of calls) opts.onTool?.(c);
      yield 'no';
    },
  };
}

function rig({ llm = fakeLlm(), nowPlaying = null, imageSearch = null } = {}) {
  const sent = [], logs = [];
  const console = { log: m => logs.push(m), warn: m => logs.push(m) };
  const actions = createActions({ llm, nowPlaying, imageSearch, console,
    sendCommand: async (channel, command, userId) => { sent.push({ channel, text: command.text, userId }); } });
  return { actions, sent, logs, llm };
}

const play = { type: 'music', command: { text: '!play Crazy Seal', ack: 'Okay, playing Crazy Seal.', queuedAck: 'Adding Crazy Seal to the queue.' } };

describe('music commands', () => {
  it('sends the command, credited to the asker, and says "playing" when nothing plays', async () => {
    const { actions, sent } = rig({ nowPlaying: { enabled: true, get: async () => ({ playing: false }) } });
    assert.strictEqual(await actions.musicCommand(play, { channel: 'c', userId: 'u1' }), 'Okay, playing Crazy Seal.');
    assert.deepStrictEqual(sent, [{ channel: 'c', text: '!play Crazy Seal', userId: 'u1' }]);
  });
  it('"Adding … to the queue" while music plays', async () => {
    const { actions } = rig({ nowPlaying: { enabled: true, get: async () => ({ playing: true }) } });
    assert.strictEqual(await actions.musicCommand(play, { channel: 'c', userId: 'u1' }), 'Adding Crazy Seal to the queue.');
  });
});

describe('smakbot answers', () => {
  const nowPlaying = { enabled: true, describe: np => `This is ${np.title}.`, get: async () => ({ playing: true, title: 'Crazy' }),
    topSongs: async n => [n], describeTop: (s, n) => `top ${n}`, topRequests: async (u, n) => [u, n], describeRequests: (r) => `requests ${r[0]}` };
  it('"what song is this?", "our top songs", "my top songs"', async () => {
    const { actions } = rig({ nowPlaying });
    assert.strictEqual(await actions.fixedAnswer({ type: 'now-playing' }, { userId: 'u1' }), 'This is Crazy.');
    assert.strictEqual(await actions.fixedAnswer({ type: 'top-songs', count: 3 }, { userId: 'u1' }), 'top 3');
    assert.strictEqual(await actions.fixedAnswer({ type: 'top-songs', count: 3, mine: true }, { userId: 'u1' }), 'requests u1');
  });
  it('null for anything else, or without smakbot (the LLM answers instead)', async () => {
    assert.strictEqual(await rig({ nowPlaying }).actions.fixedAnswer({ type: 'ask' }, {}), null);
    assert.strictEqual(await rig().actions.fixedAnswer({ type: 'now-playing' }, {}), null);
  });
});

describe('tool calls', () => {
  it('music to smakbot, pictures found, a line said, leaving, the rest passed on', async () => {
    const pictures = [], said = [], other = [];
    let left = false;
    const { actions, sent } = rig({ imageSearch: { find: async q => ({ name: `${q}.png` }) } });
    const tools = actions.toolHandler({ channel: 'c', userId: 'u1',
      onPicture: (p, q) => pictures.push([p, q]), onSay: t => said.push(t), onLeave: () => { left = true; }, onOther: t => other.push(t.type) });
    assert.strictEqual(tools.musicCalled(), false);
    tools.onTool({ type: 'music', command: { text: '!skip' } });
    tools.onTool({ type: 'image', query: 'capybara' });
    tools.onTool({ type: 'say', text: 'hello' });
    tools.onTool({ type: 'leave' });
    tools.onTool({ type: 'search' });
    assert.ok(tools.musicCalled());
    assert.deepStrictEqual(sent.map(s => s.text), ['!skip']);
    assert.strictEqual(pictures[0][1], 'capybara'); assert.deepStrictEqual(await pictures[0][0], { name: 'capybara.png' });
    assert.deepStrictEqual([said, left, other], [['hello'], true, ['search']]);
  });
  it('a music call the model couldn\'t turn into a command still counts as one', () => {
    const { actions, sent } = rig();
    const tools = actions.toolHandler({ channel: 'c', userId: 'u1' });
    tools.onTool({ type: 'music', command: null });
    assert.ok(tools.musicCalled()); assert.deepStrictEqual(sent, []);
  });
});

describe('music follow-up', () => {
  const claim = 'Let\'s get "Hit the Road Jack" queued up for you.';
  it('a claim with no music call → one follow-up; its calls reach smakbot', async () => {
    const llm = fakeLlm({ calls: [{ type: 'music', command: { text: '!play Hit the Road Jack' } }, { type: 'music', command: { text: '!play Georgia' } }] });
    const { actions, sent, logs } = rig({ llm });
    assert.strictEqual(await actions.musicFollowUp({ answer: claim, musicCalled: false, channel: 'c', userId: 'u1', log: '[x]', stream: { memoryKey: 'k' } }), 2);
    assert.match(llm.asked[0].input, /called no music tool/);
    assert.strictEqual(llm.asked[0].opts.memoryKey, 'k'); assert.strictEqual(llm.asked[0].opts.useSearch, false);
    assert.deepStrictEqual(sent.map(s => s.text), ['!play Hit the Road Jack', '!play Georgia']);
    assert.ok(logs.includes('[x] music follow-up: 2 music call(s) made'));
  });
  it('skipped: a real music call, no claim, an empty answer, or tools off', async () => {
    for (const [args, tools] of [[{ answer: claim, musicCalled: true }, true], [{ answer: 'It is sunny.' }, true],
                                 [{ answer: '' }, true], [{ answer: claim }, false]]) {
      const llm = fakeLlm({ tools });
      assert.strictEqual(await rig({ llm }).actions.musicFollowUp({ musicCalled: false, channel: 'c', userId: 'u1', log: '[x]', ...args }), 0);
      assert.strictEqual(llm.asked.length, 0);
    }
  });
});
