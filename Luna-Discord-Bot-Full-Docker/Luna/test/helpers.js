// Shared by Luna's integration tests: the harness, the fake LLM streams and
// the rigs each feature's tests start from. (These were inline in one
// long luna.test.js; see docs/DEVELOPMENT.md.)
const assert = require('assert'), boot = require('./harness');
const ok = m => console.log('  ✓ ' + m);
const sse = (...sentences) => sentences.map(s => [5, { type: 'message.delta', content: s + ' ' }]);

const BUILTIN = ['Let me search for that.', '[curious] Hmm, let me take a look.', "One sec, I'll check the web.", '[thoughtful] Good question. Let me look that up.', 'Hang on, let me find out.'];

const setup = async (env = {}) => { const H = boot(env); await H.start(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(150);
  H.S.tts.length = 0; H.S.played.length = 0; H.S.sends.length = 0; H.S.playMs = 30; return H; };

const TOOL = [[5, { type: 'tool_call.start' }], [5, { type: 'tool_call.arguments', tool: 'tavily_search', arguments: { query: 'weather' } }], [0, { type: 'tool_call.success', tool: 'tavily_search' }]];

const FILL = ['Still thinking.', '[thoughtful] Hmm, give me a moment.', 'Almost there, bear with me.', "This one's taking a bit. Hang tight.", 'Just a little longer.'];

const T = { THINKING_WAITS: '0.1-0.1', THINKING_MAX: '3' };

const isFiller = t => FILL.includes(t) || /^Custom/.test(t) || /still working on that|Still on it,/.test(t);

const fillersIn = H => H.S.tts.map(t => t.text).filter(isFiller);

const reasoningDeltas = (n, ms) => [[0, { type: 'reasoning.start' }], ...[...Array(n)].map(() => [ms, { type: 'reasoning.delta', content: 'hmm' }]), [0, { type: 'reasoning.end' }]];

const searchPhase = (toolMs, readMs) => [[0, { type: 'tool_call.start' }], [toolMs, { type: 'tool_call.arguments', tool: 'tavily_search', arguments: { query: 'usc score' } }],
  [0, { type: 'tool_call.success', tool: 'tavily_search' }], [0, { type: 'prompt_processing.start' }], [readMs, { type: 'prompt_processing.end' }]];

const tavily = (...results) => JSON.stringify([{ type: 'text', text: JSON.stringify({ query: 'q', answer: null, results }) }]);

const found = (query, ...results) => [[0, { type: 'tool_call.start' }], [5, { type: 'tool_call.arguments', tool: 'tavily_search', arguments: { query } }],
  [5, { type: 'tool_call.success', tool: 'tavily_search', arguments: { query }, output: tavily(...results) }]];

const msg = (...parts) => [[0, { type: 'message.start' }], ...parts.map(t => [5, { type: 'message.delta', content: t }]), [0, { type: 'message.end' }]];

const searched = () => [[0, { type: 'tool_call.start' }], [5, { type: 'tool_call.arguments', tool: 'tavily_search', arguments: { query: 'pee time' } }],
  [5, { type: 'tool_call.success', tool: 'tavily_search', arguments: { query: 'pee time' }, output: '[]' }]];

const FAKE = "<tool_call>\n<function=web_search.query>(UCLA football game today score)\n</function>\n</tool_call>";

const wakeRig = async (env = {}) => {
  const H = boot({ SILENCE_MS: '300', MIN_SPEECH_MS: '100', ANNOUNCE_THINKING: 'false', ANNOUNCE_SELF: 'false', LLM_THINK_LIMIT_MS: '0', ...env });
  await H.start(); H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(20);
  const mic = H.S.audio.u1, wake = H.S.wake.u1;
  const loud = Buffer.alloc(1920); for (let k = 0; k < 960; k++) loud.writeInt16LE(2000, k * 2);
  H.utter = async (peak, transcript, detect = false) => {
    H.S.transcripts = [transcript]; (H.S.peaks ??= {}).u1 = peak; if (detect) wake.onDetect(0.9, Date.now());
    const seen = H.S.logs.length;
    // Half a second: clearly more than QUERY_MIN_MS (300) of speech after a detection.
    for (let t = 0; t < 500; t += 20) { mic.write(loud); await H.wait(20); }
    // The utterance ends after SILENCE_MS; wait for its outcome, then for the LLM request.
    await H.until(() => H.S.logs.slice(seen).some(l => /Query:|utterance discarded|wake candidate rejected/.test(l)));
    await H.wait(150); };
  H.S.tts.length = 0; H.S.llmRequests.length = 0; H.S.llmScript = sse('Sunny all day.'); return H; };

const bareRig = async (env = {}) => {
  const H = await wakeRig({ WAKE_LISTEN_MS: '600', ...env }); H.S.names = { u1: 'smakus' }; H.put('u1', 'A');
  const mic = H.S.audio.u1, wake = H.S.wake.u1;
  const loud = Buffer.alloc(1920); for (let k = 0; k < 960; k++) loud.writeInt16LE(2000, k * 2);
  H.speak = async ms => { for (let t = 0; t < ms; t += 20) { mic.write(loud); await H.wait(20); } };
  H.bareWake = async () => { H.S.transcripts = ['Hey Luna.']; await H.speak(300); wake.onDetect(0.9, Date.now());
    await H.until(() => H.S.tts.some(t => /didn't catch that|missed that/.test(t.text))); await H.wait(100); };
  return H; };

const MUSIC_CALL = (tool, args) => [[5, { type: 'tool_call.start' }], [5, { type: 'tool_call.name', tool_name: tool, provider_info: { type: 'plugin', plugin_id: 'mcp/luna' } }],
  [5, { type: 'tool_call.arguments', tool, arguments: args }], [5, { type: 'tool_call.success', tool, arguments: args, output: '[{"type":"text","text":"ok"}]' }]];

const NP = { playing: true, paused: false, title: 'Seal - Crazy (Official Music Video)', artist: 'Seal', track: 'Crazy', url: 'https://youtu.be/x',
  requested_by: 'smakus', elapsed: 73, duration: 212, up_next: ['Kiss From a Rose (Official Video)'] };

const textRig = async (env = {}) => {
  const H = boot({ TEXT_CHAT_CHANNELS: 'textbuffet', ...env }); await H.start();
  H.chan = (name = 'textbuffet') => ({ id: 'c-' + name, name, typing: 0, sendTyping() { this.typing++; return Promise.resolve(); },
    send: async m => { H.S.sends.push(m); return {}; } });
  H.say = async (content, { user = 'u1', name = 'Sam', channel = H.chan() } = {}) => {
    const msg = { content, author: { id: user, username: user, bot: false }, member: { displayName: name }, channel,
      reply: async r => { H.S.replies.push(r); }, react: async e => { (H.S.reactions ??= []).push(e); } };
    H.T.client.emit('messageCreate', msg); return msg; };
  H.S.llmRequests.length = 0; return H; };

const TOP = [{ title: 'One Chain to Rule Them All | Gandalf x Frodo (Lord of the Rings Rap Parody) - WeGoTunes Studio', plays: 13 }, { title: "Shock My Dog I Can't Stop", plays: 9 },
  { title: 'Dire Straits - Money For Nothing (Official Music Video)', plays: 4 }, { title: 'Rush - Tom Sawyer', plays: 2 },
  { title: 'Sweet Pea', plays: 1 }, { title: 'Sixth', plays: 1 }];

const MINE = { user: 'smakus', songs: [{ title: 'Neil Young - Heart of Gold (Official Audio)', requests: 4 }, { title: 'Sledgehammer', requests: 2 }, { title: 'Biko', requests: 1 }] };

const IMG_CALL = query => [[5, { type: 'tool_call.start' }], [5, { type: 'tool_call.name', tool_name: 'post_image', provider_info: { type: 'plugin', plugin_id: 'mcp/luna' } }],
  [5, { type: 'tool_call.arguments', tool: 'post_image', arguments: { query } }], [5, { type: 'tool_call.success', tool: 'post_image', arguments: { query }, output: '[{"type":"text","text":"ok"}]' }]];

const PICS = H => { H.S.images = ['https://img.test/page.html', 'https://img.test/huge.jpg', 'https://img.test/missing.png', 'https://img.test/capy.png'];
  H.S.imageFiles = { 'https://img.test/page.html': { type: 'text/html', bytes: 10 }, 'https://img.test/huge.jpg': { type: 'image/jpeg', bytes: 9 * 1024 * 1024 },
                     'https://img.test/capy.png': { type: 'image/png; charset=binary', bytes: 2048 } }; };

const SAY = text => [[5, { type: 'tool_call.start' }], [5, { type: 'tool_call.name', tool_name: 'say_in_voice' }],
  [5, { type: 'tool_call.arguments', tool: 'say_in_voice', arguments: { text } }], [5, { type: 'tool_call.success', tool: 'say_in_voice', arguments: { text }, output: '[]' }]];

const inVoice = async H => { H.put('u1', 'A'); await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(50); H.S.tts.length = 0; H.S.replies.length = 0; };

const daveSetup = async env => { const H = boot({ ANNOUNCE_SELF: 'false', ...env }); await H.start(); H.put('u1', 'A'); H.put('u2', 'A');
  await H.luna('u1'); H.S.lastConnection.setStatus(H.Status.Ready); await H.wait(20); return H; };

const loudChunk = (() => { const b = Buffer.alloc(1920); for (let k = 0; k < 960; k++) b.writeInt16LE(2000, k * 2); return b; })();

const fakeDave = (c, { members = ['luna', 'u1'], stats = {}, status = 3 } = {}) => {
  c.state = { ...(c.state || {}), networking: { state: { dave: { protocolVersion: 1, session: {
    status, epoch: 7n, getUserIds: () => members,
    getDecryptionStats: uid => stats[uid] ?? null } } } } };
  Object.defineProperty(c, 'voicePrivacyCode', { get: () => '12345 67890 11121', configurable: true }); };

const voicecheck = async H => { H.T.client.emit('messageCreate', { content: '!luna voicecheck', member: null, channel: H.text, reply: async r => { H.S.replies.push(r); } }); await H.wait(10); return H.S.replies.at(-1); };

module.exports = { assert, boot, ok, sse, BUILTIN, setup, TOOL, FILL, T, isFiller, fillersIn, reasoningDeltas, searchPhase, tavily, found, msg, searched, FAKE, wakeRig, bareRig, MUSIC_CALL, NP, textRig, TOP, MINE, IMG_CALL, PICS, SAY, inVoice, daveSetup, loudChunk, fakeDave, voicecheck };
