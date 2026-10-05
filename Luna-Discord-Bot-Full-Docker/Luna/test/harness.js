// Test harness for index.js.
//
// Runs index.js inside a vm context with every external dependency faked:
// Discord (client, voice connections, receivers), LM Studio and Whisper (fetch),
// TTS, and the wake-word engine. boot(env) returns { S, T, ... }:
//   S — recorded side effects (llmRequests, tts, logs, replies, destroyed, …)
//       and knobs the fakes read (llmScripts, transcripts, peaks, …)
//   T — index.js internals exposed for tests (handleQuery, client, …)
// Nothing here talks to a real service.
const path = require('path');
const LUNA_DIR = path.join(__dirname, '..');
// Loads the real index.js in a vm with Discord, voice, LM Studio and TTS faked.
const fs = require('fs'), vm = require('vm'), { EventEmitter } = require('events'), { PassThrough } = require('stream');

module.exports = function boot(env = {}) {
  const S = { replies: [], sends: [], tts: [], llmRequests: [], played: [], logs: [], destroyed: [] };
  const log = (...a) => S.logs.push(a.join(' '));

  // ── @discordjs/voice ──
  const Status = { Signalling: 'signalling', Connecting: 'connecting', Ready: 'ready', Disconnected: 'disconnected', Destroyed: 'destroyed' };
  class FakeConnection extends EventEmitter {
    constructor(channelId) { super(); this.channelId = channelId; this.state = { status: Status.Signalling }; const subs = new Map(); this.receiver = { speaking: new EventEmitter(), subscriptions: subs, subscribe: (uid) => { if (subs.has(uid)) return subs.get(uid); const s = new PassThrough(); s.once('close', () => subs.delete(uid)); subs.set(uid, s); (S.audio ??= {})[uid] = s; return s; } }; }
    setStatus(st) { this.state = { status: st }; this.emit(st); this.emit('stateChange'); }
    subscribe() {}
    destroy() { if (this.state.status === Status.Destroyed) throw new Error('already destroyed'); S.destroyed.push(this.channelId); this.setStatus(Status.Destroyed); }
  }
  let guildConn = null;
  const voice = {
    VoiceConnectionStatus: Status, AudioPlayerStatus: { Idle: 'idle' }, StreamType: { Arbitrary: 'arb' }, EndBehaviorType: { AfterSilence: 1 },
    joinVoiceChannel: ({ channelId }) => {
      if (guildConn && guildConn.state.status !== Status.Destroyed) { guildConn.channelId = channelId; return guildConn; }
      guildConn = new FakeConnection(channelId); S.lastConnection = guildConn; return guildConn;
    },
    entersState: (conn, st, ms) => new Promise((res, rej) => {
      if (conn.state.status === st) return res(conn);
      const t = setTimeout(() => rej(new Error('timeout')), Math.min(ms, 200));
      conn.once(st, () => { clearTimeout(t); res(conn); });
    }),
    createAudioPlayer: () => { const p = new EventEmitter(); p.play = r => { S.played.push(r.text); setTimeout(() => p.emit('idle'), S.playMs ?? 20); }; p.stop = () => {}; return p; },
    createAudioResource: (stream) => ({ text: stream.ttsText }),
  };

  // ── discord.js ──
  class Client extends EventEmitter { constructor() { super(); this.user = { id: 'luna' }; } login() {} }
  const discord = { Events: { ClientReady: 'ready', MessageCreate: 'messageCreate', VoiceStateUpdate: 'voiceStateUpdate', Error: 'error' }, Client };

  // ── tts.js ──
  const tts = {
    describeTTS: () => 'Fake', expressivePrompt: () => '',
    fetchTTS: (text, opts = {}) => {
      const rec = { text, signal: opts.signal, destroyed: false };
      S.tts.push(rec);
      return new Promise(res => setTimeout(() => {
        if (opts.signal?.aborted) return res(null);
        const st = new PassThrough(); st.ttsText = text; st.on('close', () => { rec.destroyed = true; }); res(st);
      }, S.ttsMs ?? 10));
    },
  };

  const mods = {
    '@discordjs/voice': voice, 'discord.js': discord, 'discord-api-types/v10': { GatewayIntentBits: {} },
    'prism-media': { opus: { Decoder: class extends PassThrough {} } }, '@discordjs/opus': { OpusEncoder: class { decode(b) { if (b[0] === 0xBA && b[1] === 0xD0) throw new Error('The compressed data passed is corrupted'); return b; } } }, dotenv: { config() {} },
    './wakeword': { WakeWordEngine: { load: async () => { await new Promise(r => setTimeout(r, S.wakeLoadMs ?? 0));
      return { createStream: (opts) => { (S.wake ??= {})[opts.label] = opts;
        return { write: () => Promise.resolve(null), takePeak: () => { const p = (S.peaks ??= {})[opts.label] || 0; S.peaks[opts.label] = 0; return p; }, takeHealthPeak: () => 0, close() {}, exportGainState: () => ({}), chunksProcessed: 0, queueDepth: 0, lastGain: 1, lastRms: 0 }; } }; } } },
    './tts': tts, path: require('path'),
  };

  // ── fetch: LM Studio ──
  S.model = 'model-a';
  const fakeFetch = async (url, init = {}) => {
    if (url.includes('whisper')) return { ok: true, json: async () => ({ text: (S.transcripts || []).shift() || '' }) };
    if (url.endsWith('/api/v1/models')) return { ok: true, json: async () => ({ models: [{ type: 'llm', loaded_instances: [{ id: S.model }] }] }) };
    const body = JSON.parse(init.body); S.llmRequests.push({ at: Date.now(), model: body.model, prev: body.previous_response_id, reasoning: body.reasoning, input: body.input, system: body.system_prompt, tools: !!(body.integrations && body.integrations.length), integrations: body.integrations });
    init.signal.addEventListener('abort', () => { S.aborted = (S.aborted || 0) + 1; }, { once: true });
    if (body.model !== S.model) return { ok: false, status: 404, text: async () => 'model not found' };
    if (S.mcpDown && body.integrations) return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "Unable to connect to remote MCP server 'tavily' at url 'https://mcp.tavily.com/mcp/'. Please ensure the provided url is correct and the server is reachable." } }) };
    if (S.force400) return { ok: false, status: 400, text: async () => 'max_output_tokens must be positive' };
    S.stored ??= new Set();
    if (body.previous_response_id && !S.stored.has(body.previous_response_id))
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: `Could not find stored response for previous_response_id '${body.previous_response_id}'.`, type: 'invalid_request', param: 'previous_response_id' } }) };
    const rid = 'resp_' + (S.nextRid = (S.nextRid || 0) + 1); S.stored.add(rid);
    const script = (S.llmScripts && S.llmScripts.length) ? S.llmScripts.shift() : S.llmScript; // array of [delayMs, eventOrNull]
    const enc = new TextEncoder();
    const stream = new ReadableStream({ async start(c) {
      try {
        for (const [ms, ev] of script) {
          await new Promise((r, j) => { const t = setTimeout(r, ms); init.signal.addEventListener('abort', () => { clearTimeout(t); j(init.signal.reason); }, { once: true }); });
          if (ev) c.enqueue(enc.encode('data: ' + JSON.stringify(ev) + '\n\n'));
        }
        c.enqueue(enc.encode('data: ' + JSON.stringify({ type: 'chat.end', result: { output: [{ type: 'message', content: 'x' }], response_id: rid,
          stats: { input_tokens: 1234, total_output_tokens: 56, reasoning_output_tokens: 40, tokens_per_second: 6.9, time_to_first_token_seconds: 12.34 } } }) + '\n\n')); c.close();
      } catch (e) { c.error(e); }
    }});
    return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: stream };
  };

  const src = fs.readFileSync(path.join(LUNA_DIR, 'index.js'), 'utf8');
  const ctx = {
    require: m => { if (m in mods) return mods[m]; throw new Error('unmocked ' + m); },
    process: { env: { LM_STUDIO_URL: 'http://lm/api/v1/chat', OWW_ENABLED: 'true', WHISPER_SERVER_URLS: 'http://whisper/inference', TAVILY_API_KEY: 'test-key', ...env }, exit: c => { throw new Error('exit ' + c); } },
    console: { log, warn: log, error: log }, fetch: fakeFetch, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    AbortController, AbortSignal, DOMException, TextDecoder, TextEncoder, Promise, Date, Math, Map, Set, WeakSet, Buffer, FormData, Blob, __dirname: LUNA_DIR,
  };
  vm.createContext(ctx);
  vm.runInContext(src + `
;globalThis.__t = { client, handleQuery, condenseSearchResults, speakableName, nextGeneration, interruptOwnPlayback, spokenResponses,
  get activeConnection() { return activeConnection; }, get activeVoiceChannel() { return activeVoiceChannel; }, get ready() { return ready; },
  get model() { return lmStudioModel; }, THINKING: { waits: THINKING_WAITS, cap: THINKING_MAX }, LLM: { reasoning: LLM_REASONING, thinkLimit: LLM_THINK_LIMIT_MS } };`, ctx);
  const T = ctx.__t;

  // helpers
  const members = new Map(); // channelId -> Map(userId -> member)
  const channel = (id) => ({ id, name: id, members: { get: uid => (members.get(id) || new Map()).get(uid), filter: f => { const arr = [...(members.get(id) || new Map()).values()].filter(f); return { size: arr.length }; }, forEach: f => (members.get(id) || new Map()).forEach(f), some: f => [...(members.get(id) || new Map()).values()].some(f), values: () => (members.get(id) || new Map()).values() } });
  // Like discord.js, member.voice is live: it reports where the user is now, not
  // where they were when the object was created.
  const currentChannel = uid => { for (const [cid, m] of members) if (m.has(uid)) return cid; return null; };
  const member = (uid, chan) => ({ id: uid, user: { bot: uid === 'luna', tag: uid, username: uid }, displayName: (S.names && S.names[uid]) || uid,
    voice: { get channelId() { return currentChannel(uid); }, get channel() { const c = currentChannel(uid); return c ? channel(c) : null; } } });
  const text = { send: async (m) => { S.sends.push(m); await new Promise(r => setTimeout(r, S.sendMs ?? 0)); return { delete: async () => { S.sends.push('deleted:' + m); }, edit: async t => { S.sends.push('edit:' + t); } }; } };
  const H = {
    S, T, Status, wait: ms => new Promise(r => setTimeout(r, ms)),
    put(uid, chan) { for (const m of members.values()) m.delete(uid); if (chan) { if (!members.has(chan)) members.set(chan, new Map()); members.set(chan, members.get(chan)).get(chan).set(uid, member(uid, chan)); } },
    channel,
    async luna(uid) { const m = members.get([...members.keys()].find(k => members.get(k).has(uid)))?.get(uid) || member(uid, null);
      T.client.emit('messageCreate', { content: '!luna', member: m, guild: { id: 'g', voiceAdapterCreator: {} }, channel: text, reply: async r => { S.replies.push(r); } }); await H.wait(5); },
    move(uid, from, to) { H.put(uid, to); const mk = c => ({ id: uid, channelId: c, channel: c ? channel(c) : null, member: member(uid, c) });
      T.client.emit('voiceStateUpdate', mk(from), mk(to)); },
    async start() { T.client.emit('ready'); await H.wait(20); },
    text,
  };
  return H;
};
