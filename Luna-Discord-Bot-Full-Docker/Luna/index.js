require('dotenv').config();

const voiceLib = require('@discordjs/voice');
const { GatewayIntentBits } = require('discord-api-types/v10');
const { Events, Client } = require('discord.js');
const { OpusEncoder } = require('@discordjs/opus');
const path = require('path');
const http = require('http');
const { WakeWordEngine } = require('./wakeword');
const { createMcpServer } = require('./mcp-server');
const { createTextChat, SAY_MAX_CHARS } = require('./text-chat');
const { route, sendSmakbotCommand: postSmakbotCommand, LEAVE_PHRASES } = require('./commands');
const { LLM_TOOLS, LLM_TOOL_NAMES } = require('./llm-tools');
const { fetchTTS, fetchTTSInVoice, checkElevenLabsVoice, describeTTS, expressivePrompt } = require('./tts');
const { loadCustomGreetings } = require('./greetings');
const { createAnswerFilter } = require('./answer-filter');
const { loadConfig, parseWaits } = require('./config');
const { QUICK_PROMPT } = require('./prompt');
const { createPlayback } = require('./voice-playback');
const { createVoiceSession } = require('./voice-session');
const { createListener } = require('./voice-listen');
const { createLlm, condenseSearchResults, TOOLS_PLUGIN_ID } = require('./answer-llm');
const { isBareWake, confirmWake } = require('./voice-input');

// ─── Config ───────────────────────────────────────────────────────────────────

// Every setting, parsed and checked in one place (config.js).
const config = loadConfig(process.env, { warn: message => console.warn(message) });

// Talking to LM Studio: model, prompt, memory, search and tool offers (answer-llm.js).
const llm = createLlm({ config, fetch, console, expressivePrompt });

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

// ─── Wake follow-up ───────────────────────────────────────────────────────────
//
// A bare "hey Luna" (nothing followed, even after WAKE_LISTEN_MS): she asks
// what they wanted (WAKE_REPROMPT_PHRASES) instead of answering a greeting,
// then that speaker has WAKE_FOLLOWUP_MS after she finishes to start the
// question, without the wake word. 0 answers the greeting, as before.
const WAKE_FOLLOWUP_MS = config.WAKE_FOLLOWUP_MS;
const REPROMPTS = config.WAKE_REPROMPT_PHRASES.length ? config.WAKE_REPROMPT_PHRASES : [
  "Hey {name}, I didn't catch that. Did you mean to ask me something?",
  "Sorry {name}, I missed that. What did you want to ask?",
  "Hey, I didn't catch that. Did you mean to ask me something?",
];
const IGNORED_USERS = new Set(
  config.IGNORED_USER_IDS
);

// ─── Join greetings ───────────────────────────────────────────────────────────
//
// When someone joins the voice channel Luna is in, she announces them by name
// and says hello. The cooldown is per user, so a flaky connection that drops
// and rejoins every few seconds is greeted once, not on every reconnect.
const GREET_ON_JOIN     = config.GREET_ON_JOIN;
const GREET_COOLDOWN_MS = config.GREET_COOLDOWN_MS;
// A joining client takes a moment to connect its audio, and someone who joins
// and immediately leaves (or passes through on the way to another channel)
// should not be greeted at all. The greeting is spoken only if they are still
// in the channel after this delay.
const GREET_DELAY_MS    = config.GREET_DELAY_MS;

// Leave announcements: the same idea in reverse. The delay is longer than the
// join one because a dropped connection typically takes a few seconds to come
// back, and someone who is back by then did not really leave.
const ANNOUNCE_LEAVE    = config.ANNOUNCE_LEAVE;
const LEAVE_COOLDOWN_MS = config.LEAVE_COOLDOWN_MS;
const LEAVE_DELAY_MS    = config.LEAVE_DELAY_MS;

// Custom wording for both announcements: phrases separated by "|", with
// {name} where the person's name goes, e.g.
//   FAREWELL_PHRASES={name} just left. Bye, {name}!|And {name} is gone.
// One is picked at random each time. Unset or empty keeps the built-in lines.
const GREET_PHRASES    = config.GREET_PHRASES;
const FAREWELL_PHRASES = config.FAREWELL_PHRASES;

// Luna introduces herself when she joins a voice channel. INTRO_PHRASES works
// like the two above, with {wake} for the wake phrase and {names} for the
// people in the channel ("smakus, joel, and kenbeans") instead of {name}.
const ANNOUNCE_SELF = config.ANNOUNCE_SELF;
const INTRO_PHRASES = config.INTRO_PHRASES;

// Spoken heads-up when a question is going to a web search — the slowest kind
// of answer, where silence most reads as Luna not having heard. Audio tags are
// performed by ElevenLabs v3/v4 and stripped for Kokoro.
const ANNOUNCE_SEARCH = config.ANNOUNCE_SEARCH;
const SEARCH_PHRASES  = (() => {
  const custom = config.SEARCH_PHRASES;
  return custom.length ? custom : [
    'Let me search for that.',
    '[curious] Hmm, let me take a look.',
    "One sec, I'll check the web.",
    '[thoughtful] Good question. Let me look that up.',
    'Hang on, let me find out.',
  ];
})();

// "Still thinking" fillers: while no answer has started, Luna says one after a
// random wait, then more, backing off: THINKING_WAITS lists the wait window
// (in seconds) for the 1st, 2nd, ... filler, and the last window repeats.
// The default "15-22,22-30,30-40" means 15-22 s, then 22-30 s, then every
// 30-40 s. Random within each window, because a varied gap sounds less
// mechanical than a fixed beat; backing off, because the longer a wait gets,
// the less a frequent reminder adds. THINKING_MAX > 0 caps the count. They stop the moment the answer's
// first sentence is ready. Big models that reason (and search) before
// answering can be silent for a minute or more, which otherwise sounds exactly
// like being ignored.
//
// A phrase containing {name} is spoken with the asker's name, so mixing a few
// of those into the list makes some fillers personal. They are skipped when
// the name has nothing pronounceable in it.
const ANNOUNCE_THINKING    = config.ANNOUNCE_THINKING;
const THINKING_WAITS       = parseWaits(config.THINKING_WAITS);
const THINKING_MAX         = config.THINKING_MAX; // 0 = no limit

const THINKING_PHRASES     = (() => {
  const custom = config.THINKING_PHRASES;
  return custom.length ? custom : [
    'Still thinking.',
    '[thoughtful] Hmm, give me a moment.',
    'Almost there, bear with me.',
    "This one's taking a bit. Hang tight.",
    'Just a little longer.',
    "Hey {name}, I'm still working on that. I didn't forget about you.",
    'Still on it, {name}. Thanks for your patience.',
  ];
})();

const WHISPER_SERVER_URLS = config.WHISPER_SERVER_URLS;
let whisperRR = 0;
function nextWhisperUrl() {
  const url = WHISPER_SERVER_URLS[whisperRR % WHISPER_SERVER_URLS.length];
  whisperRR++;
  return url;
}
// Resolved against this file, not the working directory, so `node Luna/index.js`
// from elsewhere still finds it.
const CHIME_PATH = path.join(__dirname, 'chime.mp3');

// Request timeouts. Without these a hung Whisper or LM Studio call never
// settles, `flushing` stays true forever, and that speaker goes permanently
// deaf with nothing logged. Generous, because a saturated CPU makes Whisper
// genuinely slow — these are for hangs, not slowness.
const WHISPER_TIMEOUT_MS = config.WHISPER_TIMEOUT_MS;

// Thinking limit. The LLM's own timeouts (answer-llm.js) can't catch a model
// that keeps reasoning: reasoning streams, so the request is never idle. One question spent over
// seven minutes (3,210 reasoning tokens) before its first word. If, before the
// answer starts, the model has spent LLM_THINK_LIMIT_MS actually *reasoning*,
// the request is cancelled and asked again with reasoning off, which answers
// in seconds. 0 disables.
//
// Only reasoning counts — LM Studio marks it with reasoning.start/.end events.
// Searching and reading the results do not: a searched question can spend a
// minute on those alone (results are read at ~90 tokens/s on this hardware),
// and counting them cancelled healthy searches and redid them from scratch.
const LLM_THINK_LIMIT_MS = config.LLM_THINK_LIMIT_MS;
const QUICK_ANSWER_PHRASES = (() => {
  const custom = config.QUICK_ANSWER_PHRASES;
  return custom.length ? custom : [
    "Sorry, I was overthinking that one. Here's the quick answer.",
    'Okay, let me give you the short version.',
  ];
})();

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
  onUtterance: (...args) => processUtterance(...args),
  onStuck: userId => processingUsers.delete(userId),
});
setInterval(() => listener.healthReport(), 30000).unref?.();

const processingUsers = new Set(); // who is being transcribed/answered right now

// !luna is refused until startup finishes. A capture created before the wake
// word models load runs without detection until its stream next restarts.
let ready = false;

client.on(Events.ClientReady, async () => {
  if (!await llm.resolveModel()) process.exit(1);
  await listener.initWakeWord();
  console.log(`[tts] ${describeTTS()}`);
  describeCustomGreetings();
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
    introduceSelf(connection);
    return;
  }

  session.attach(connection, channel, message.channel, guild, () => {
    message.reply(
      `Joined **${channel.name}**! Say "${WAKE_LABEL}" to wake me up. ` +
      `Also, you can say "${WAKE_LABEL}, play song ___" to play music, ` +
      `or "${WAKE_LABEL}, skip" and "${WAKE_LABEL}, stop" to control it.`
    ).catch(() => {});
    introduceSelf(connection);
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

// ─── WAV helper ───────────────────────────────────────────────────────────────

function buildWavBuffer(pcmData, sampleRate, channels, bitDepth) {
  const byteRate   = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const header     = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1,  20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

// ─── Whisper ──────────────────────────────────────────────────────────────────

async function transcribeWithWhisper(wavBuffer) {
  try {
    const form = new FormData();
    form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'json');

    const res = await fetch(nextWhisperUrl(), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`Whisper server error ${res.status}:`, await res.text());
      return null;
    }
    const data = await res.json();
    return (data.text || '').trim() || null;
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error(`Whisper timed out after ${WHISPER_TIMEOUT_MS}ms — server may be overloaded`);
    } else {
      console.error('Whisper server error:', err.message);
    }
    return null;
  }
}

// ─── Utterance processing ─────────────────────────────────────────────────────

async function processUtterance(pcm, userId, connection, channel, wakeDetected = false, wakeCandidate = false) {
  if (processingUsers.has(userId)) {
    console.warn(`[${userId}] utterance dropped — previous one still being processed`);
    return;
  }
  processingUsers.add(userId);

  const t0 = Date.now(); // timing: clock starts when the utterance is flushed

  try {
    const wavBuffer = buildWavBuffer(pcm, 48000, 1, 16);
    const transcript = await transcribeWithWhisper(wavBuffer);
    console.log(`[${userId}] [timing] Whisper done: ${Date.now() - t0}ms`);

    if (!transcript) return;

    // The question: the wake phrase removed, or nothing if a candidate turns
    // out to have no "Luna" in it (see confirmWake in voice-input.js).
    const confirmed = confirmWake(transcript, { detected: wakeDetected, candidate: wakeCandidate });
    if (!confirmed.accepted) {
      if (wakeCandidate) {
        console.log(`[${userId}] [oww] wake candidate rejected — ${confirmed.reason} ` +
          `(${transcript.split(/\s+/).length} words)`);
      }
      return;
    }
    if (wakeCandidate) console.log(`[${userId}] [oww] wake candidate confirmed by Whisper`);
    const query = confirmed.query;

    // Only "hey Luna", even after waiting for more: ask what they wanted.
    if (WAKE_FOLLOWUP_MS > 0 && isBareWake(transcript)) {
      askForQuestion(userId, connection);
      return;
    }

    console.log(`[${userId}] Query:`, query);
    await handleQuery(query, connection, channel, t0, userId);
  } catch (err) {
    console.error(`[${userId}] Error processing utterance:`, err);
  } finally {
    processingUsers.delete(userId);
  }
}

// "Hey smakus, I didn't catch that. Did you mean to ask me something?" — then
// that speaker's next words, if they start within WAKE_FOLLOWUP_MS of her
// finishing, are taken as the question without the wake word. (Until she has
// finished, the window stays open, so an early answer still counts.)
function askForQuestion(userId, connection) {
  const name = speakableName(session.channel?.members?.get(userId)?.displayName);
  const fitting = REPROMPTS.filter(p => p.includes('{name}') === Boolean(name));
  const text = fillPhrase(fitting.length ? fitting : REPROMPTS, { name });
  console.log(`[${userId}] only "hey Luna" — asking: "${text}"`);
  const expect = ms => listener.expectQuestion(userId, ms);
  expect(60000);
  const generation = playback.interrupt(userId);
  playback.queue(async () => {
    const pt = await fetchTTS(text);
    if (pt) await playback.play(pt, connection);
    expect(WAKE_FOLLOWUP_MS);
  }, userId, generation);
}

// ─── Tools for the LLM (music, leaving) ───────────────────────────────────────
//
// Besides the fixed commands below, the LLM can play, skip and stop music and
// leave the channel itself (llm-tools.js): Luna serves the tools over MCP on
// LUNA_MCP_PORT, LM Studio knows them from its mcp.json as "luna", and every
// request offers them as mcp/luna. When a call succeeds, Luna acts on it (the
// onTool handlers in handleQuery and answerInText). Offering them, and leaving
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
// first if it isn't in the voice channel. Used by the fixed commands and by
// the LLM's music tools, by voice and by text.
function sendSmakbotCommand(channel, command) {
  const musicBotPresent = !!session.channel?.members?.some(m => m.user.username.toLowerCase().includes('smakbot'));
  return postSmakbotCommand(channel, command, { musicBotPresent, console });
}

// ─── Query handler ────────────────────────────────────────────────────────────

async function handleQuery(query, connection, channel, t0 = Date.now(), userId = 'unknown') {
  const what = route(query, { voice: true });
  if (what.type === 'music') {
    // Supersede this speaker's own pending audio BEFORE the chime. A
    // VoiceConnection has exactly one subscription, and playback.playSound() creates its
    // own player and subscribes — so an unconditional chime detaches whatever
    // sentence is mid-playback, including another speaker's.
    const musicGeneration = playback.interrupt(userId);
    if (!playback.busy) {
      playback.playSound(CHIME_PATH, connection).catch(() => {});
    }

    await sendSmakbotCommand(channel, what.command);

    const ack = what.command.ack;
    if (ack) {
      playback.queue(async () => {
        const pt = await fetchTTS(ack);
        if (pt) await playback.play(pt, connection);
      }, userId, musicGeneration);
    }
    return;
  }

  // "Leave", "go away", "bye": a goodbye, then out — before the LLM, like the
  // music commands. (Wordier requests reach the LLM's leave_channel tool.)
  if (what.type === 'leave') {
    const generation = playback.interrupt(userId);
    const goodbye = fillPhrase(LEAVE_PHRASES, {});
    playback.queue(async () => {
      const pt = await fetchTTS(goodbye);
      if (pt) await playback.play(pt, connection);
      leaveOnRequest(userId);
    }, userId, generation);
    return;
  }

  // Supersede only this speaker's own pending response. Anyone else's queued
  // sentences survive and play in turn.
  const myGeneration = playback.interrupt(userId);

  // Fire chime (don't await — let it play while we fetch the LLM response).
  //
  // Skipped while audio is already playing. playback.playSound() creates its own
  // AudioPlayer and calls connection.subscribe(), and a VoiceConnection has
  // exactly one subscription — so an unconditional chime silently detached
  // whichever sentence was mid-playback. With several people in a channel that
  // presented as Luna's answers being randomly truncated.
  // Whether the model is offered the web search tool. It decides itself
  // whether to use it; `let`, because a question it tried to search without
  // the tool is asked again with it (see the pass loop).
  let useSearch = llm.offerSearch(query);

  if (!playback.busy) {
    playback.playSound(CHIME_PATH, connection).catch(() => {});
  }

  // Not awaited: posting (and later deleting) this message are Discord round
  // trips of 100-300 ms each, and both used to sit directly in front of the
  // LLM request and the first sentence's TTS.
  const statusMsg = channel.send('🤔 *Luna is thinking...*').catch(() => null);
  let statusCleared = false;
  const clearStatus = () => {
    if (statusCleared) return;
    statusCleared = true;
    statusMsg.then(m => m && m.delete()).catch(() => {});
  };

  // A one-off line tied to this question — the search heads-up and the
  // "still thinking" fillers. Each is its own queue entry, ahead of the
  // answer's: making it the answer's first sentence would enqueue the answer
  // immediately, and that entry would then hold the shared queue for the whole
  // wait, blocking other speakers. Same generation as the answer, so a barge-in
  // skips it too, as does `wanted()` turning false while it waits.
  const sayAside = (tag, phrase, wanted = () => true) => {
    console.log(`[${userId}] [${tag}] "${phrase}"`);
    playback.queue(async () => {
      if (!wanted()) return;
      const pt = await fetchTTS(phrase);
      if (!pt) return;
      if (!wanted() || !playback.isCurrent(userId, myGeneration)) { pt.destroy(); return; }
      await playback.play(pt, connection);
    }, userId, myGeneration);
  };

  // Search heads-up, said when the model actually starts a web search (its
  // first tool call), once per question. Predicting it from keywords before
  // the request announced searches that never happened and missed ones that
  // did; this way it is heard if and only if Luna really is searching.
  let searchAnnounced = false;
  const announceSearchNow = () => {
    if (searchAnnounced) return;
    searchAnnounced = true;
    if (!statusCleared) {
      statusMsg.then(m => m && !statusCleared && m.edit('🔍 *Luna is searching the web...*')).catch(() => {});
    }
    // Skipped if the answer has already started: queued behind it, it would
    // only play once the answer had finished.
    if (ANNOUNCE_SEARCH) sayAside('search', fillPhrase(SEARCH_PHRASES, {}), () => firstSentence);
  };

  // "Still thinking" fillers while no answer has started. Each pass through
  // the phrases is freshly shuffled, so nothing repeats until every phrase
  // has been used, and never twice in a row across passes.
  let answerStarted = false;
  let fillerTimer   = null;
  let fillersSaid   = 0;
  const askerName = speakableName(session.channel?.members?.get(userId)?.displayName);
  const usable = THINKING_PHRASES.filter(p => askerName || !p.includes('{name}'));
  let deck = [];
  let lastFiller = null;
  const nextFiller = () => {
    if (!deck.length) {
      deck = shuffle(usable);
      if (deck.length > 1 && deck[0] === lastFiller) deck.push(deck.shift());
    }
    return (lastFiller = deck.shift());
  };
  const stopFillers = () => {
    answerStarted = true;
    clearTimeout(fillerTimer);
  };
  const scheduleFiller = () => {
    if (!ANNOUNCE_THINKING || !usable.length) return;
    if (THINKING_MAX > 0 && fillersSaid >= THINKING_MAX) return;
    const [lo, hi] = THINKING_WAITS[Math.min(fillersSaid, THINKING_WAITS.length - 1)];
    const wait = lo + Math.random() * (hi - lo);
    fillerTimer = setTimeout(() => {
      if (answerStarted || !playback.isCurrent(userId, myGeneration)) return;
      fillersSaid++;
      // The wait is in the log tag ("[thinking +17.3s]"), so the spacing can
      // be checked from the logs.
      sayAside(`thinking +${(wait / 1000).toFixed(1)}s`,
        nextFiller().replaceAll('{name}', askerName), () => !answerStarted);
      scheduleFiller();
    }, wait);
  };
  scheduleFiller();

  // ── Per-response playback ───────────────────────────────────────────────
  //
  // ONE entry goes on the global chain for the whole response, not one per
  // sentence. With per-sentence entries two speakers' answers braid together
  // — A1, B1, A2, B2 — which is worse than the bug this design replaced.
  //
  // TTS for each sentence is requested as soon as it is within TTS_LOOKAHEAD
  // of playback (see voice-playback.js), so synthesis still overlaps playback.
  // Only playback order is serialised.
  const response = playback.startResponse(userId);
  let streamDone = false;
  let wake       = null;    // resolver signalling "more sentences available"

  const signal = () => { if (wake) { wake(); wake = null; } };

  // Enqueued LAZILY, on the first sentence — never at query time.
  //
  // The entry parks at the head of the shared chain while it waits for more
  // sentences. Enqueuing it up front would therefore hold that head for the
  // entire LLM generation (up to LM_TIMEOUT_MS) while producing no
  // audio at all, blocking every other speaker. Ordering is unaffected: the
  // chain still serialises whole responses, just from first audio rather than
  // from first keystroke.
  let queued = false;
  const ensureQueued = () => {
    if (queued) return;
    queued = true;

    playback.queue(async () => {
      let i = 0;
      let firstAudio = true;

      try {
        while (true) {
          if (i < response.size) {
            if (!playback.isCurrent(userId, myGeneration)) return;

            const passThrough = await response.take(i++);

            // Re-check AFTER the await: a barge-in can land while TTS is still
            // rendering, and without this the superseded sentence plays anyway.
            if (!playback.isCurrent(userId, myGeneration)) {
              passThrough?.destroy();
              return;
            }

            if (passThrough) {
              if (firstAudio) {
                firstAudio = false;
                console.log(`[${userId}] [timing] First audio start: ${Date.now() - t0}ms`);
              }
              await playback.play(passThrough, connection);
            }
          } else if (streamDone) {
            return;
          } else {
            await new Promise(r => { wake = r; });
          }
        }
      } finally {
        playback.finishResponse(userId, response);
      }
    }, userId, myGeneration);
  };

  // One LLM request per pass, and at most one retry for each reason:
  //   - the model wrote a tool call as text because it was not offered the
  //     search tool -> ask again with search on (same reasoning);
  //   - it thought past LLM_THINK_LIMIT_MS without starting an answer, or
  //     finished with no words at all (it has answered "." after 50 s of
  //     reasoning) -> ask again with reasoning off, which answers in seconds.
  const superseded = () => !playback.isCurrent(userId, myGeneration);
  let reasoning     = llm.reasoning;
  let firstSentence = true;
  let reasoningRetried = false;
  // Search results seen so far (tool_call.success), so a quick-answer retry
  // can answer from them instead of searching all over again.
  const searchCalls = [];
  let context = '';
  let leaveAfterAnswer = false;   // the LLM called leave_channel

  const speak = sentence => {
    console.log('Luna sentence:', sentence);
    if (firstSentence) {
      firstSentence = false;
      console.log(`[timing] First LLM sentence: ${Date.now() - t0}ms`);
      clearStatus();
      stopFillers();
    }
    ensureQueued();
    response.add(sentence);
    signal();
  };

  try {
    for (;;) {
      let fakeToolCall = false;
      // Search may have been paused by an earlier pass of this question.
      if (useSearch && llm.searchPaused()) useSearch = false;
      const cancel = new AbortController();
      playback.trackRequest(userId, cancel);
      // Reasoning clock: runs only between reasoning.start and reasoning.end,
      // so time spent searching and reading results is not counted.
      let thinkLimitHit = false;
      let thinkTimer    = null;
      let reasonedMs    = 0;
      let reasoningAt   = 0;
      const limitActive = () => LLM_THINK_LIMIT_MS > 0 && reasoning !== 'off' && firstSentence;
      // What of the answer gets said is the answer filter's job (see
      // answer-filter.js). Reasoning-off passes that may search hold
      // everything until the end: without reasoning the model narrates its
      // way through searches. (Only those: holding every answer until it is
      // complete would delay all of them.)
      const filter = createAnswerFilter({
        reasoning: reasoning !== 'off',
        holdUntilEnd: reasoningRetried && useSearch,
        speak,
        drop: (kind, text) => console.log(`[${userId}] [LLM] dropped ${{
          narration: 'narration before a search',
          planning:  'its plan, written as the answer',
        }[kind] || 'reasoning that leaked into the answer'} (not spoken): ${text.slice(0, 160)}`),
        cleaned: raw => console.log(`[${userId}] [LLM] cleaned up for speech; as written: ${JSON.stringify(raw.slice(0, 200))}`),
      });
      const onEvent = e => {
        if (e.type === 'reasoning.start' && !reasoningAt) {
          reasoningAt = Date.now();
          if (limitActive()) {
            thinkTimer = setTimeout(() => {
              thinkLimitHit = true;
              cancel.abort(new DOMException(`no answer after ${LLM_THINK_LIMIT_MS / 1000}s of reasoning`, 'AbortError'));
            }, Math.max(0, LLM_THINK_LIMIT_MS - reasonedMs));
          }
        } else if (e.type === 'reasoning.end' && reasoningAt) {
          reasonedMs += Date.now() - reasoningAt;
          reasoningAt = 0;
          clearTimeout(thinkTimer);
        }
        filter.event(e);
      };
      // What the model's tool calls mean (read in answer-llm.js). A search is
      // announced and handled as a search; music and leaving are acted on.
      const onTool = t => {
        if (t.type === 'search') {
          announceSearchNow();
          filter.event({ type: 'tool_call.start' });
        } else if (t.type === 'search-result') {
          searchCalls.push({ query: t.query, output: t.output });
        } else if (t.type === 'music') {
          if (t.command) sendSmakbotCommand(channel, t.command);
        } else if (t.type === 'leave') {
          console.log(`[${userId}] [voice] the LLM called leave_channel — leaving after the reply`);
          leaveAfterAnswer = true;
        }
      };

      try {
        const extraSystem = reasoningRetried ? QUICK_PROMPT : '';
        for await (const sentence of llm.stream(query, { userId, useSearch, reasoning, signal: cancel.signal, onEvent, onTool,
                                                         context, extraSystem, speaker: config.LM_USE_NAMES ? askerName : '' })) {
          // Abort only if THIS speaker asked something newer mid-stream.
          if (superseded()) break;
          const verdict = filter.text(sentence);
          // A tool call written out as text — the model wanted to search but
          // had no search tool. Never spoken; stop this pass and ask again
          // with search on.
          if (verdict === 'tool-call-as-text') {
            fakeToolCall = true;
            console.warn(`[${userId}] [LLM] model wrote a tool call as text (not spoken): ${sentence.replace(/\s+/g, ' ').slice(0, 120)}`);
            break;
          }
          // The answer has started: the thinking limit no longer applies.
          if (verdict === 'ok') clearTimeout(thinkTimer);
        }
        // Whatever is still held was answer. (Not after a tool call written
        // as text: what came before it is narration.)
        if (!superseded() && !fakeToolCall) filter.end();
      } catch (err) {
        // The thinking limit is a planned cancel; anything else (including a
        // supersede) is handled below.
        if (!thinkLimitHit || superseded()) throw err;
      } finally {
        clearTimeout(thinkTimer);
        playback.untrackRequest(userId, cancel);
      }

      if (superseded()) break;
      if (fakeToolCall && !useSearch && llm.canSearch()) {
        console.warn(`[${userId}] [LLM] model tried to search without the search tool — asking again with web search`);
        useSearch = true;
        continue;
      }
      if (!firstSentence || reasoning === 'off' || reasoningRetried) break;
      if (thinkLimitHit) {
        console.warn(`[${userId}] [LLM] no answer after ${LLM_THINK_LIMIT_MS / 1000}s of reasoning — asking again with reasoning off`);
        sayAside('quick', fillPhrase(QUICK_ANSWER_PHRASES, {}), () => firstSentence);
      } else {
        console.warn(`[${userId}] [LLM] answer had ${fakeToolCall ? 'only a tool call written as text' : 'no words'} — asking again with reasoning off`);
      }
      reasoning = 'off';
      reasoningRetried = true;
      if (searchCalls.length) {
        // Answer from what was already found: searching again redid minutes
        // of work, and a reasoning-off model narrates its way through searches.
        context = 'Web search results already found for this question (answer from these; do not search again):\n' +
          condenseSearchResults(searchCalls);
        useSearch = false;
        console.log(`[${userId}] [LLM] quick answer reuses ${searchCalls.length} search result set(s); search not offered again`);
      }
    }

    if (firstSentence && !superseded()) {
      stopFillers();
      ensureQueued();
      response.add('Sorry, I lost my train of thought.');
      signal();
    }
  } catch (err) {
    stopFillers();
    if (superseded()) {
      // Barge-in or a newer question: the cancel is the point, not an error.
      console.log(`[${userId}] previous question cancelled`);
    } else {
      console.error('handleQuery error:', err.message);
      // Only when nothing has been said yet. After part of an answer has
      // played, a tacked-on "I had trouble processing that." makes a merely
      // truncated answer sound like a failure.
      if (response.size === 0) {
        ensureQueued();
        response.add(err.name === 'TimeoutError'
          ? 'Sorry, that took too long to work out.'
          : 'I had trouble processing that.');
        signal();
      }
    }
  } finally {
    clearStatus();
    stopFillers();
    // MUST run on every path. The queue entry above parks on `wake`, and if
    // it is never released it blocks the global playback chain for every
    // speaker, forever.
    streamDone = true;
    signal();
    // Never queued (no sentence, or superseded first): nothing will consume it.
    if (!queued) playback.finishResponse(userId, response);
    // Queued behind the answer, so she leaves once her goodbye has played.
    if (leaveAfterAnswer && !superseded()) playback.queue(async () => leaveOnRequest(userId), userId, myGeneration);
  }
}


client.on(Events.Error, console.warn);

// ─── Join greetings ───────────────────────────────────────────────────────────

const lastGreetedAt = new Map(); // userId -> ms timestamp of their last greeting

// {name} is filled in by fillPhrase(). Overridable with GREET_PHRASES.
const GREETINGS = GREET_PHRASES.length ? GREET_PHRASES : [
  '{name} just joined. Hey {name}!',
  "Look who's here, it's {name}. Hi there!",
  '{name} has joined the channel. Hello, {name}!',
  'Heads up, {name} is here. Welcome in, {name}!',
];

// A shuffled copy (Fisher–Yates; sorting on a random comparator is biased).
function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// A random phrase from `phrases` with every {key} in `vars` replaced.
function fillPhrase(phrases, vars) {
  let text = phrases[Math.floor(Math.random() * phrases.length)];
  for (const [key, value] of Object.entries(vars)) text = text.replaceAll(`{${key}}`, value);
  return text;
}

// Turns a display name into something Kokoro can say.
//
// NFKC folds "fancy font" names (𝓢𝓪𝓶, Ｓａｍ) back to plain letters. Emoji and
// symbols are dropped rather than read aloud, separators become spaces, and a
// trailing number tag ("sam_1234") is removed when there is a name before it.
// Returns '' if nothing pronounceable is left.
function speakableName(raw) {
  let name = (raw || '').normalize('NFKC')
    .replace(/[_.]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const withoutTag = name.replace(/[\s-]*\d+$/, '');
  if (/\p{L}/u.test(withoutTag)) name = withoutTag;
  return name.slice(0, 32).trim();
}

// Per-person greetings (greetings.js): their own phrases, in their own
// ElevenLabs voice if they have one. Same cooldown and switches as the normal
// greeting; on any problem with the custom voice, the normal greeting plays.
// GREET_ON_JOIN=regular: everyone gets the regular greeting; the file stays.
const CUSTOM_GREETINGS = GREET_ON_JOIN === 'custom'
  ? loadCustomGreetings(path.resolve(__dirname, config.GREETINGS_FILE), { warn: message => console.warn(message) })
  : new Map();

// At startup: who has one, and whether their voices exist (no credits used).
function describeCustomGreetings() {
  if (!CUSTOM_GREETINGS.size) return;
  console.log(`[greet] custom greetings for ${[...CUSTOM_GREETINGS].map(([id, g]) => g.name || id).join(', ')}`);
  for (const [id, g] of CUSTOM_GREETINGS) {
    if (!g.voice) continue;
    checkElevenLabsVoice(g.voice).then(({ name, reason }) => {
      if (!name) console.warn(`[greet] ${g.name || id}: ElevenLabs voice ${g.voice} unavailable (${reason}) — they'll get the normal greeting`);
    });
  }
}

function greetMember(member, connection) {
  const now = Date.now();
  if (now - (lastGreetedAt.get(member.id) || 0) < GREET_COOLDOWN_MS) return;
  lastGreetedAt.set(member.id, now);

  const name = speakableName(member.displayName);
  const text = name
    ? fillPhrase(GREETINGS, { name })
    : 'Someone just joined. Hey there, welcome in!';
  const custom = CUSTOM_GREETINGS.get(member.id);
  if (custom) {
    const own = fillPhrase(custom.phrases, { name: name || 'friend', user: name || 'friend' });
    console.log(`[greet] ${member.user.tag} joined — custom greeting${custom.voice ? ` in voice ${custom.voice}` : ''}: "${own}"`);
    if (!custom.voice) return announce(member, connection, own);
    return announceInVoice(member, connection, own, custom.voice, text);
  }
  console.log(`[greet] ${member.user.tag} joined — "${text}"`);
  announce(member, connection, text);
}

// Their own line in their own voice; if that voice can't be had, the normal
// greeting in the normal voice.
function announceInVoice(member, connection, text, voiceId, fallbackText) {
  const generation = playback.nextGeneration(member.id);
  playback.queue(async () => {
    if (session.connection !== connection) return;
    let pt = await fetchTTSInVoice(text, voiceId);
    if (!pt) {
      console.warn(`[greet] custom voice unavailable for ${member.user.tag} — normal greeting instead`);
      pt = await fetchTTS(fallbackText);
    }
    if (pt) await playback.play(pt, connection);
  }, member.id, generation);
}

// Queued under the member's own id: if they say the wake word before the
// greeting plays, their query supersedes it (barge-in), and an announcement
// never cuts off an answer someone else is already hearing.
function announce(member, connection, text) {
  const generation = playback.nextGeneration(member.id);
  playback.queue(async () => {
    if (session.connection !== connection) return; // Luna left in the meantime
    const pt = await fetchTTS(text);
    if (pt) await playback.play(pt, connection);
  }, member.id, generation);
}

// ─── Self-introduction ────────────────────────────────────────────────────────

// Overridable with INTRO_PHRASES. Phrases with {names} greet everyone in the
// channel by name; the others are for an empty channel or a crowd.
const INTROS = INTRO_PHRASES.length ? INTRO_PHRASES : [
  "Hey {names}! Luna here. Just say {wake} whenever you need me.",
  "Hi {names}! It's Luna. Say {wake} if you want anything.",
  "Hello {names}, Luna has arrived! Say {wake} to get my attention.",
  "Hi everyone, Luna here! Just say {wake} whenever you need me.",
  "Hey all, it's Luna. Say {wake} if you want anything.",
  "Luna has arrived! Say {wake} to get my attention.",
];
// More people than this and a list of names gets long: "everyone" instead.
const INTRO_MAX_NAMES = 6;

// "smakus", "smakus and joel", "smakus, joel, and kenbeans".
const NAME_LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

// The speakable names of the people in the channel (not bots, not ignored
// users), or [] when there are none or too many to list.
function introNames(channel) {
  const names = [...(channel?.members?.values() ?? [])]
    .filter(m => !m.user.bot && !IGNORED_USERS.has(m.id))
    .map(m => speakableName(m.displayName))
    .filter(Boolean);
  return names.length <= INTRO_MAX_NAMES ? names : [];
}

const INTRO_QUEUE_ID = 'luna:intro';

// Spoken once when Luna joins, so the channel knows she is listening. Queued
// under its own id, so nobody's query can be superseded by it or supersede it
// by accident; whoever speaks first after it is simply answered next.
function introduceSelf(connection) {
  if (!ANNOUNCE_SELF) return;
  const names = introNames(session.channel);
  const fitting = INTROS.filter(p => p.includes('{names}') === names.length > 0);
  const text = fillPhrase(fitting.length ? fitting : INTROS, { wake: WAKE_LABEL, names: NAME_LIST.format(names) || 'everyone' });
  console.log(`[intro] "${text}"`);
  const generation = playback.nextGeneration(INTRO_QUEUE_ID);
  playback.queue(async () => {
    if (session.connection !== connection) return;
    const pt = await fetchTTS(text);
    if (pt) await playback.play(pt, connection);
  }, INTRO_QUEUE_ID, generation);
}

// ─── Leave announcements ──────────────────────────────────────────────────────

const lastFarewellAt = new Map(); // userId -> ms timestamp of their last announcement

// Overridable with FAREWELL_PHRASES.
const FAREWELLS = FAREWELL_PHRASES.length ? FAREWELL_PHRASES : [
  '{name} just left. See you later, {name}!',
  '{name} has left the channel.',
  '{name} headed out. Bye, {name}!',
  'And {name} is gone. Catch you next time!',
];

function announceLeave(member, connection) {
  const now = Date.now();
  if (now - (lastFarewellAt.get(member.id) || 0) < LEAVE_COOLDOWN_MS) return;
  lastFarewellAt.set(member.id, now);

  const name = speakableName(member.displayName);
  const text = name
    ? fillPhrase(FAREWELLS, { name })
    : 'Someone just left the channel.';
  console.log(`[farewell] ${member.user.tag} left — "${text}"`);

  // Also supersedes anything still queued for the leaver — an unplayed
  // greeting, or the rest of an answer nobody is there to hear.
  announce(member, connection, text);
}

// Someone left Luna's channel — disconnected from voice, or moved to another
// channel. If they were the last real user, the disconnect handler below
// tears the connection down, and the session.connection check skips this.
function onVoiceLeave(oldState, newState) {
  if (!ANNOUNCE_LEAVE || !session.channel || !session.connection) return;
  if (oldState.channelId !== session.channel.id) return;
  if (oldState.channelId === newState.channelId) return;

  const member = oldState.member;
  if (!member || member.user.bot || IGNORED_USERS.has(member.id)) return;

  const connection = session.connection;
  setTimeout(() => {
    if (session.connection !== connection) return;
    if (member.voice.channelId === session.channel?.id) return; // came back
    announceLeave(member, connection);
  }, LEAVE_DELAY_MS);
}

// Someone arrived in Luna's channel — from outside voice, or moved in from
// another channel. Mute/deafen/stream toggles also emit VoiceStateUpdate but
// keep the same channelId, so they never match.
function onVoiceJoin(oldState, newState) {
  if (GREET_ON_JOIN === 'off' || !session.channel || !session.connection) return;
  if (newState.channelId !== session.channel.id) return;
  if (oldState.channelId === newState.channelId) return;

  const member = newState.member;
  if (!member || member.user.bot || IGNORED_USERS.has(member.id)) return;

  const connection = session.connection;
  setTimeout(() => {
    if (session.connection !== connection) return;
    if (member.voice.channelId !== session.channel?.id) return; // left again
    greetMember(member, connection);
  }, GREET_DELAY_MS);
}

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

  onVoiceJoin(oldState, newState);
  onVoiceLeave(oldState, newState);

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
  const generation = playback.generationOf(userId) ?? playback.nextGeneration(userId);
  playback.queue(async () => {
    if (session.connection !== connection) return;
    const pt = await fetchTTS(line);
    if (pt) await playback.play(pt, connection);
  }, userId, generation);
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
  session.attach(connection, channel, textChannelFor(guild) || channel, g, () => { autoJoiningUntil = 0; introduceSelf(connection); });
}

void client.login(config.DISCORD_TOKEN || undefined);
