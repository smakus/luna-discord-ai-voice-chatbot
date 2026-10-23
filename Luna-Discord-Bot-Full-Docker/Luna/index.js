require('dotenv').config();

const voiceLib = require('@discordjs/voice');
const { GatewayIntentBits } = require('discord-api-types/v10');
const { Events, Client } = require('discord.js');
const { OpusEncoder } = require('@discordjs/opus');
const http = require('http');
const { WakeWordEngine } = require('./wakeword');
const { createMcpServer } = require('./mcp-server');
const { createTextChat, SAY_MAX_CHARS } = require('./text-chat');
const { sendSmakbotCommand: postSmakbotCommand } = require('./commands');
const { LLM_TOOLS, LLM_TOOL_NAMES } = require('./llm-tools');
const { fetchTTS, fetchTTSInVoice, checkElevenLabsVoice, describeTTS, expressivePrompt } = require('./tts');
const { speakableName } = require('./phrases');
const { createAnnouncer } = require('./announce');
const { loadConfig } = require('./config');
const { createPlayback } = require('./voice-playback');
const { createVoiceSession } = require('./voice-session');
const { createListener } = require('./voice-listen');
const { createVoiceAnswerer } = require('./voice-answer');
const { createWhisper } = require('./whisper');
const { createLlm, TOOLS_PLUGIN_ID } = require('./answer-llm');
const { createNowPlaying } = require('./now-playing');

// ─── Config ───────────────────────────────────────────────────────────────────

// Every setting, parsed and checked in one place (config.js).
const config = loadConfig(process.env, { warn: message => console.warn(message) });

// What smakbot is playing (now-playing.js): answers "what song is this?", and
// names the song in the LLM's prompt while one plays.
const nowPlaying = createNowPlaying({ config, fetch, console });

// Talking to LM Studio: model, prompt, memory, search and tool offers (answer-llm.js).
const llm = createLlm({ config, fetch, console, expressivePrompt,
  musicLine: async () => nowPlaying.promptLine(await nowPlaying.get(session.channel?.guild?.id || '')) });

// Everything said in the voice channel goes through one queue (voice-playback.js).
const playback = createPlayback({ voice: voiceLib, fetchTTS, console, lookahead: config.TTS_LOOKAHEAD });

// ─── Wake phrase ──────────────────────────────────────────────────────────────
//
// The spoken wake phrase is "hey luna". A single-word "luna" is a poor wake word
// for openWakeWord — two syllables of common phonemes with no distinctive onset —
// and trains badly. Every official openWakeWord model is 3–4 syllables.
//
// WAKE_RE matches the phrase at the START of a transcript, tolerating Whisper's
// punctuation ("Hey, Luna, ...") and its usual mishearings. It is used for two
// things only:
//   1. the fallback path when the ONNX model is unavailable
//   2. stripping the phrase off the front of a transcript before it reaches
//      the LLM or the music-command parser
// Detection itself is the ONNX model's job.
// (WAKE_RE and the other voice-input stages live in voice-input.js.)

// Text command to summon the bot. Deliberately NOT derived from the spoken
// phrase — "!hey luna" would be an awkward thing to type.
const BOT_COMMAND = '!luna';

// Human-readable phrase for user-facing messages.
const WAKE_LABEL = 'hey Luna';

const IGNORED_USERS = new Set(
  config.IGNORED_USER_IDS
);

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.Guilds,
  ],
});

// Luna's place in a voice channel (voice-session.js) and hearing the people in
// it (voice-listen.js). Leaving forgets the session's listening, playback and
// conversations.
const session = createVoiceSession({
  config, voice: voiceLib, console,
  isIgnored: id => IGNORED_USERS.has(id),
  onConnected: (connection, channel, textChannel) => listener.start(connection, channel, textChannel),
  onReset: () => { listener.reset(); playback.reset(); llm.forgetConversations(); },
});
const listener = createListener({
  config, console, voice: voiceLib, OpusEncoder, WakeWordEngine, timers: { setInterval, clearInterval },
  session, playback,
  botId: () => client.user.id,
  isIgnored: id => IGNORED_USERS.has(id),
  onUtterance: (...args) => answerer.onUtterance(...args),
  onStuck: userId => answerer.release(userId),
});
setInterval(() => listener.healthReport(), 30000).unref?.();

// From an utterance to Luna's spoken answer (voice-answer.js, whisper.js).
const answerer = createVoiceAnswerer({
  config, console, llm, playback, session, fetchTTS,
  whisper: createWhisper({ config, fetch, console }),
  sendCommand: (channel, command, requesterId) => sendSmakbotCommand(channel, command, requesterId),
  leave: userId => leaveOnRequest(userId),
  expectQuestion: (userId, ms) => listener.expectQuestion(userId, ms),
  nowPlaying,
});

// Her intro, join greetings and farewells (announce.js).
const announcer = createAnnouncer({
  config, console, session, playback, fetchTTS, fetchTTSInVoice, checkElevenLabsVoice,
  isIgnored: id => IGNORED_USERS.has(id), wakeLabel: WAKE_LABEL,
});

// !luna is refused until startup finishes. A capture created before the wake
// word models load runs without detection until its stream next restarts.
let ready = false;

client.on(Events.ClientReady, async () => {
  if (!await llm.resolveModel()) process.exit(1);
  await listener.initWakeWord();
  console.log(`[tts] ${describeTTS()}`);
  announcer.describeCustomGreetings();
  console.log(`[search] web search: ${llm.describeSearch()}`);
  if (LLM_TOOLS_ON) startLlmTools();
  ready = true;
  checkAutoJoin();
  scheduleAutoJoin();
  console.log(`Ready! Wake phrase: "${WAKE_LABEL}"  •  text command: ${BOT_COMMAND}`);
});

// ─── Text commands ────────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async message => {
  if (textChat.onMessage(message)) return;
  if (message.content.toLowerCase().trim() === `${BOT_COMMAND} voicecheck`) return voiceCheck(message);
  // "!luna say <text>": exactly those words, out loud, no LLM.
  const sayMatch = message.content.trim().match(new RegExp(`^${BOT_COMMAND}\\s+say\\s+([\\s\\S]+)$`, 'i'));
  if (sayMatch && !message.author?.bot) {
    const who = message.member?.displayName || message.author?.username || 'someone';
    if (!sayInVoice(sayMatch[1], message.author?.id || 'text', who)) {
      message.reply("I'm not in a voice channel.").catch(() => {});
    } else {
      message.react('🔊').catch(() => {});
    }
    return;
  }
  if (message.content.toLowerCase().trim() === `${BOT_COMMAND} leave`) {
    if (!session.connection) return message.reply("I'm not in a voice channel.").catch(() => {});
    message.reply('Bye!').catch(() => {});
    return leaveOnRequest(message.author?.id);
  }
  if (message.content.toLowerCase().trim() !== BOT_COMMAND) return;
  // .catch: a rejected reply (e.g. no send permission) in an async listener is
  // an unhandled rejection, which terminates Node.
  if (!ready) return message.reply('Still starting up — try again in a few seconds.').catch(() => {});

  const channel = message.member?.voice?.channel;
  if (!channel) return message.reply('You need to join a voice channel first!').catch(() => {});

  autoJoinPaused = false;   // asked to join: auto-join may follow people again
  const guild = { id: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator };
  // Returns the guild's existing connection if there is one, moving it to
  // `channel` when that differs.
  const connection = session.join(channel, guild);

  if (connection === session.connection) {
    if (session.channel?.id === channel.id) {
      message.reply(`Already listening in **${channel.name}**.`).catch(() => {});
      return;
    }
    // !luna from another channel: session.join() just moved Luna there.
    // Listening carries over (it is per connection, not per channel); only
    // the channel she announces and counts members in changes.
    console.log(`[voice] moved to ${channel.name} by !luna`);
    session.moveTo(channel);
    message.reply(`Moved to **${channel.name}**!`).catch(() => {});
    announcer.introduce(connection);
    return;
  }

  session.attach(connection, channel, message.channel, guild, () => {
    message.reply(
      `Joined **${channel.name}**! Say "${WAKE_LABEL}" to wake me up. ` +
      `Also, you can say "${WAKE_LABEL}, play song ___" to play music, ` +
      `or "${WAKE_LABEL}, skip" and "${WAKE_LABEL}, stop" to control it.`
    ).catch(() => {});
    announcer.introduce(connection);
  });
});

// `!luna voicecheck`: per-person answer to "can Luna decrypt them?", plus the
// voice privacy code to compare with the one Discord shows in the call's
// encryption details — if they differ, Luna's whole session is out of sync.
function voiceCheck(message) {
  if (!session.connection || !session.channel) return message.reply("I'm not in a voice channel.").catch(() => {});
  const crypto = session.cryptoState();
  if (!crypto) return message.reply('Encryption details are unavailable (unencrypted call, or the voice library changed).').catch(() => {});
  const lines = [`**Voice encryption:** ${crypto.status}, epoch ${crypto.epoch ?? '-'}` +
    (crypto.privacyCode ? ` — privacy code \`${crypto.privacyCode}\` (should match the code Discord shows for this call)` : '')];
  for (const member of session.channel.members.values()) {
    if (member.user.bot) continue;
    const v = session.cryptoVerdict(crypto, member.id);
    lines.push(`${v.problem ? '⚠️' : '✅'} ${member.displayName}: ${v.text}`);
  }
  console.log(`[voice] voicecheck: ${lines.slice(1).join(' | ')}`);
  return message.reply(lines.join('\n')).catch(() => {});
}

// ─── Tools for the LLM (music, leaving) ───────────────────────────────────────
//
// Besides the fixed commands below, the LLM can play, skip and stop music and
// leave the channel itself (llm-tools.js): Luna serves the tools over MCP on
// LUNA_MCP_PORT, LM Studio knows them from its mcp.json as "luna", and every
// request offers them as mcp/luna. When a call succeeds, Luna acts on it (the
// onTool handlers in voice-answer.js and text-chat.js). Offering them, and leaving
// them out while LM Studio can't reach them, is answer-llm.js's job.
const LLM_TOOLS_ON    = config.LLM_TOOLS;
const LUNA_MCP_PORT   = config.LUNA_MCP_PORT;

function startLlmTools() {
  // say_in_voice tells the model the truth about whether anything was said.
  const tools = LLM_TOOLS.map(t => t.name !== 'say_in_voice' ? t : { ...t, run: () => session.connection
    ? `Said in ${session.channel?.name || 'the voice channel'}.`
    : 'You are not in a voice channel, so nothing was said. Tell them that.' });
  const server = createMcpServer({ tools });
  http.createServer((req, res) => server.handle(req, res).catch(() => { try { res.writeHead(500).end(); } catch (_) {} }))
    .on('error', err => console.error(`[tools] tools server failed on port ${LUNA_MCP_PORT}: ${err.message} — LLM tools off`))
    .listen(LUNA_MCP_PORT, '0.0.0.0', () => console.log(
      `[tools] ${[...LLM_TOOL_NAMES].join(', ')} offered to the LLM as ${TOOLS_PLUGIN_ID} ` +
      `(LM Studio's mcp.json needs "luna": {"url": "http://127.0.0.1:${LUNA_MCP_PORT}/mcp"})`));
}

// ─── Leaving on request ───────────────────────────────────────────────────────

// After being asked to leave, auto-join waits until the channel has emptied
// once (or someone types !luna), so she doesn't pop straight back in.
let autoJoinPaused = false;

function leaveOnRequest(userId) {
  if (!session.connection) return;
  const who = speakableName(session.channel?.members?.get(userId)?.displayName) || userId;
  if (AUTO_JOIN_CHANNELS.length) autoJoinPaused = true;
  session.leave(`asked to leave by ${who}`);
}

// Posts a smakbot command (commands.js) in the text channel, summoning smakbot
// first if it isn't in the voice channel, credited to whoever asked
// (requesterId). Used by the fixed commands and by the LLM's music tools, by
// voice and by text.
function sendSmakbotCommand(channel, command, requesterId = null) {
  const musicBotPresent = !!session.channel?.members?.some(m => m.user.username.toLowerCase().includes('smakbot'));
  return postSmakbotCommand(channel, command, { musicBotPresent, console, requesterId });
}

client.on(Events.Error, console.warn);

// Tracks Luna being moved, announces joins and leaves, and disconnects when the
// last real user (non-bot, non-ignored) leaves.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  // Luna herself was dragged to another channel by someone. (A kick or a lost
  // connection is handled by voice-session.js; !luna updates this itself.)
  if (newState.id === client.user.id) {
    if (session.connection && newState.channelId && newState.channelId !== session.channel?.id) {
      session.moveTo(newState.channel);
      console.log(`[voice] moved to ${newState.channel.name}`);
      if (session.realMemberCount(session.channel) === 0) session.leave('Moved into an empty channel');
    }
    return;
  }

  announcer.onJoin(oldState, newState);
  announcer.onLeave(oldState, newState);

  // Asked to leave: auto-join resumes once the auto-join channels have emptied.
  if (autoJoinPaused && !autoJoinChannelsOccupied()) {
    autoJoinPaused = false;
    console.log('[voice] auto-join channels empty — auto-join resumes');
  }

  // Someone joined a voice channel while Luna is in none: maybe one to
  // auto-join (scheduleAutoJoin checks).
  if (!session.connection && newState.channelId && newState.channelId !== oldState.channelId) scheduleAutoJoin();

  if (!session.channel || oldState.channelId !== session.channel.id) return;
  if (session.realMemberCount(session.channel) === 0) {
    session.leave('Last real user left');
    scheduleAutoJoin();   // people may be waiting in another auto-join channel
  }
});

// ─── Text chat ────────────────────────────────────────────────────────────────
//
// Typed questions in TEXT_CHAT_CHANNELS (text-chat.js).
const textChat = createTextChat({
  config, llm, console, command: BOT_COMMAND,
  botId: () => client.user.id,
  isReady: () => ready,
  inChannels: channel => named(channel, config.TEXT_CHAT_CHANNELS),
  sendCommand: sendSmakbotCommand,
  sayInVoice: (text, userId, who) => sayInVoice(text, userId, who),
  voiceChannelName: () => (session.connection ? session.channel?.name || 'the voice channel' : null),
  nowPlaying,
});

// Speaks a line in the voice channel on someone's behalf (say_in_voice, or
// "!luna say …"). Queued like their own answer — after whatever is playing,
// superseded if they then ask something by voice — not interrupting anyone.
// Returns false when she isn't in a voice channel.
function sayInVoice(text, userId, who) {
  const connection = session.connection;
  const line = String(text || '').trim().slice(0, SAY_MAX_CHARS);
  if (!connection || !line) return false;
  console.log(`[text] ${who} had Luna say: ${JSON.stringify(line)}`);
  // Their current generation: after whatever of theirs is already queued.
  playback.say(line, { connection, userId, generation: playback.generationOf(userId) ?? playback.nextGeneration(userId),
                       wanted: () => session.connection === connection });
  return true;
}

// ─── Auto-join ────────────────────────────────────────────────────────────────
//
// AUTO_JOIN_CHANNELS: voice channels (names or IDs) Luna joins by herself when
// someone is in one and she is in no channel — at startup, or when someone
// joins. With people in several, the busiest. She posts (status messages,
// smakbot commands) in AUTO_JOIN_TEXT_CHANNEL. She still leaves when the last
// person does, and a kick is respected: she comes back only when someone next
// joins. A short delay lets someone who pops in and straight out not summon her.
const AUTO_JOIN_CHANNELS     = config.AUTO_JOIN_CHANNELS;
const AUTO_JOIN_TEXT_CHANNEL = config.AUTO_JOIN_TEXT_CHANNEL;
const AUTO_JOIN_DELAY_MS     = 2000;
let autoJoinTimer = null;
let autoJoiningUntil = 0;   // a join in progress (not Ready yet): don't start another

const named = (channel, wanted) => wanted.some(w => w === channel.id || w.toLowerCase() === String(channel.name).toLowerCase());
const guildChannels = guild => [...(guild.channels?.cache?.values() ?? [])];
const textChannelFor = guild => AUTO_JOIN_TEXT_CHANNEL
  ? guildChannels(guild).find(c => !c.isVoiceBased?.() && c.isTextBased?.() && named(c, [AUTO_JOIN_TEXT_CHANNEL])) : null;

// At startup: say which settings match nothing, and what does exist.
function checkAutoJoin() {
  if (!AUTO_JOIN_CHANNELS.length) return;
  const guilds = [...(client.guilds?.cache?.values() ?? [])];
  const all = guilds.flatMap(guildChannels);
  const voices = all.filter(c => c.isVoiceBased?.()), texts = all.filter(c => !c.isVoiceBased?.() && c.isTextBased?.());
  const missing = AUTO_JOIN_CHANNELS.filter(w => !voices.some(c => named(c, [w])));
  if (missing.length) console.warn(`[voice] AUTO_JOIN_CHANNELS: no voice channel ${missing.map(m => `"${m}"`).join(', ')} — ` +
    `voice channels: ${voices.map(c => c.name).join(', ') || 'none'}`);
  if (!guilds.some(textChannelFor)) console.warn(`[voice] AUTO_JOIN_TEXT_CHANNEL ${AUTO_JOIN_TEXT_CHANNEL ? `"${AUTO_JOIN_TEXT_CHANNEL}" not found` : 'not set'} — ` +
    `she will post in the voice channel's own chat. Text channels: ${texts.map(c => c.name).join(', ') || 'none'}`);
  console.log(`[voice] auto-join: ${AUTO_JOIN_CHANNELS.join(', ')}`);
}

function autoJoinChannelsOccupied() {
  return [...(client.guilds?.cache?.values() ?? [])].some(guild => guildChannels(guild)
    .some(c => c.isVoiceBased?.() && named(c, AUTO_JOIN_CHANNELS) && session.realMemberCount(c) > 0));
}

function scheduleAutoJoin() {
  if (!AUTO_JOIN_CHANNELS.length) return;
  clearTimeout(autoJoinTimer);
  autoJoinTimer = setTimeout(autoJoin, AUTO_JOIN_DELAY_MS);
}

function autoJoin() {
  if (!ready || session.connection || autoJoinPaused || Date.now() < autoJoiningUntil) return;
  const candidates = [...(client.guilds?.cache?.values() ?? [])].flatMap(guild => guildChannels(guild)
    .filter(c => c.isVoiceBased?.() && named(c, AUTO_JOIN_CHANNELS))
    .map(channel => ({ guild, channel, people: session.realMemberCount(channel) })))
    .filter(c => c.people > 0)
    .sort((a, b) => b.people - a.people);
  if (!candidates.length) return;
  const { guild, channel, people } = candidates[0];
  const g = { id: guild.id, adapterCreator: guild.voiceAdapterCreator };
  console.log(`[voice] auto-joining ${channel.name} (${people} ${people === 1 ? 'person' : 'people'} there)`);
  autoJoiningUntil = Date.now() + 15000;
  const connection = session.join(channel, g);
  session.attach(connection, channel, textChannelFor(guild) || channel, g, () => { autoJoiningUntil = 0; announcer.introduce(connection); });
}

void client.login(config.DISCORD_TOKEN || undefined);
