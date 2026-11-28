require('dotenv').config();

const voiceLib = require('@discordjs/voice');
const { GatewayIntentBits } = require('discord-api-types/v10');
const { Events, Client } = require('discord.js');
const { OpusEncoder } = require('@discordjs/opus');
const http = require('http');
const { WakeWordEngine } = require('./wakeword');
const { createTextChat, SAY_MAX_CHARS } = require('./text-chat');
const { sendSmakbotCommand: postSmakbotCommand } = require('./commands');
const { createTTS } = require('./tts');
const { speakableName } = require('./phrases');
const { createAnnouncer } = require('./announce');
const { loadConfig } = require('./config');
const { createPlayback } = require('./voice-playback');
const { createVoiceSession } = require('./voice-session');
const { createListener } = require('./voice-listen');
const { createVoiceAnswerer } = require('./voice-answer');
const { createWhisper } = require('./whisper');
const { createWakeBackup } = require('./wake-backup');
const { createWakeLog } = require('./wake-log');
const { createLlm } = require('./answer-llm');
const { createNowPlaying } = require('./now-playing');
const { createImageSearch } = require('./image-search');
const { createTextCommands } = require('./text-commands');
const { createAutoJoin, named } = require('./auto-join');
const { startToolsServer } = require('./tools-server');

// ─── Config ───────────────────────────────────────────────────────────────────

// Every setting, parsed and checked in one place (config.js).
const config = loadConfig(process.env, { warn: message => console.warn(message) });

// A person's display name in the channel, for the logs (their ID if unknown).
const nameOf = userId => session.channel?.members?.get(userId)?.displayName || userId;

// Wake-word events, one JSON line each, kept across rebuilds (wake-log.js).
const wakeLog = createWakeLog({ config, fs: require('fs').promises, path: require('path'), console, nameOf });

// Text to speech: ElevenLabs, local voices and the fallback between them (tts.js).
const { fetchTTS, fetchTTSInVoice, checkVoice, describeTTS, expressivePrompt, chatterboxVoices, chatterboxWav } =
  createTTS({ config, fetch, console, fs: require('fs') });

// What smakbot is playing (now-playing.js): answers "what song is this?", and
// names the song in the LLM's prompt while one plays.
const nowPlaying = createNowPlaying({ config, fetch, console });
const imageSearch = createImageSearch({ config, fetch, console });

// Talking to LM Studio: model, prompt, memory, search and tool offers (answer-llm.js).
const llm = createLlm({ config, fetch, console, expressivePrompt, nameOf,
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
// punctuation ("Hey, Luna, ...") and its usual mishearings. It is used for:
//   1. the fallback path when the ONNX model is unavailable
//   2. stripping the phrase off the front of a transcript before it reaches
//      the LLM or the music-command parser
//   3. the backup (WAKE_WHISPER_BACKUP): spotting a "hey Luna" the model missed
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
  onDiscard: (...args) => wakeBackup.onDiscard(...args),
  nameOf, wakeLog,
});
setInterval(() => listener.healthReport(), 30000).unref?.();

// Speech to text (whisper.js).
const whisper = createWhisper({ config, fetch, console });

// A second chance for the wake word (WAKE_WHISPER_BACKUP) and, optionally, a
// measurement of its misses (WAKE_SHADOW): Whisper also checks what the wake-word model
// rejected (wake-backup.js). Both off by default.
const wakeBackup = createWakeBackup({
  config, console, whisper, nameOf, wakeLog,
  onWake: (...args) => answerer.answerMissedWake(...args),
});
if (config.WAKE_SHADOW) setInterval(() => wakeBackup.report(), config.WAKE_SHADOW_REPORT_MS).unref?.();

// From an utterance to Luna's spoken answer (voice-answer.js, whisper.js).
const answerer = createVoiceAnswerer({
  config, console, llm, playback, session, fetchTTS,
  whisper,
  sendCommand: (channel, command, requesterId) => sendSmakbotCommand(channel, command, requesterId),
  leave: userId => leaveOnRequest(userId),
  expectQuestion: (userId, ms, why) => listener.expectQuestion(userId, ms, why),
  nowPlaying, imageSearch, nameOf, wakeLog,
});

// Her intro, join greetings and farewells (announce.js).
const announcer = createAnnouncer({
  config, console, session, playback, fetchTTS, fetchTTSInVoice, checkVoice,
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
  if (config.LLM_TOOLS) startToolsServer({ config, console, http, session, nowPlaying, imageSearch });
  ready = true;
  autoJoin.check();
  autoJoin.schedule();
  console.log(`Ready! Wake phrase: "${WAKE_LABEL}"  •  text command: ${BOT_COMMAND}`);
});

// ─── Text commands ────────────────────────────────────────────────────────────
//
// Typed questions ("Luna, …", text-chat.js) first, then the !luna commands
// (text-commands.js).
client.on(Events.MessageCreate, async message => {
  if (textChat.onMessage(message)) return;
  textCommands.onMessage(message);
});

// ─── Leaving on request ───────────────────────────────────────────────────────

// After being asked to leave, auto-join waits until the channel has emptied
// once (or someone types !luna), so she doesn't pop straight back in.
function leaveOnRequest(userId) {
  if (!session.connection) return;
  const who = speakableName(session.channel?.members?.get(userId)?.displayName) || userId;
  autoJoin.pause();
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

  autoJoin.onVoiceState(oldState, newState);

  if (!session.channel || oldState.channelId !== session.channel.id) return;
  if (session.realMemberCount(session.channel) === 0) {
    session.leave('Last real user left');
    autoJoin.schedule();   // people may be waiting in another auto-join channel
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
  nowPlaying, imageSearch,
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
                       wanted: () => session.connection === connection, cache: false });
  return true;
}

// "!luna voice": the same, in one of Chatterbox's voices ("default", or a
// clone). Not cached: these are test lines.
function sayInVoiceAs(text, voice, userId, who) {
  const connection = session.connection;
  const line = String(text || '').trim().slice(0, SAY_MAX_CHARS);
  if (!connection || !line) return false;
  console.log(`[voice] ${who} had Luna say in ${voice}: ${JSON.stringify(line)}`);
  playback.say(line, { connection, userId, generation: playback.generationOf(userId) ?? playback.nextGeneration(userId),
                       wanted: () => session.connection === connection, cache: false,
                       render: l => fetchTTSInVoice(l, `chatterbox:${voice}`) });
  return true;
}

// ─── Auto-join and the !luna commands ─────────────────────────────────────────

// Joining voice channels by herself (auto-join.js).
const autoJoin = createAutoJoin({ config, client, session, announcer, isReady: () => ready, console });

// !luna, !luna leave, say, voicecheck, wakestats (text-commands.js).
const textCommands = createTextCommands({
  command: BOT_COMMAND, wakeLabel: WAKE_LABEL, isReady: () => ready, session, announcer, wakeLog,
  sayInVoice: (text, userId, who) => sayInVoice(text, userId, who),
  leave: userId => leaveOnRequest(userId),
  onJoin: () => autoJoin.resume(),
  voices: { list: chatterboxVoices, say: sayInVoiceAs, wav: chatterboxWav }, maxChars: SAY_MAX_CHARS,
  console,
});

void client.login(config.DISCORD_TOKEN || undefined);
