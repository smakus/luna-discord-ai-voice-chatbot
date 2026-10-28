// ─── Text chat ────────────────────────────────────────────────────────────────
//
// Typing to Luna in TEXT_CHAT_CHANNELS: a message that @mentions her or starts
// with "Luna" gets a written answer there, through the same routing (see
// commands.js) and LLM (answer-llm.js) as voice, with the text-channel prompt.
// Everyone in a channel shares one conversation (memory "text:<channel>",
// LM_MEMORY_TTL_MS), each message prefixed with its writer's name; answers in
// a channel go one at a time so they don't tangle that memory. The voice
// channel isn't needed.

const { route, isSayRequest } = require('./commands');
const { TEXT_TOOL_NAMES } = require('./llm-tools');

// "Luna, …", "hey Luna …", "Luna: …" at the start ("lunar" does not count).
const NAME_RE = /^\s*(?:(?:hey|hi|hello|ok(?:ay)?|yo)[\s,]+)?luna\b[\s,:;.!?-]*/i;

// The question in `content`, or null when the message isn't for her: it must
// @mention her (anywhere) or start with her name. Text commands (!luna …) are
// not questions.
function textQuestion(content, botId, command = '!luna') {
  const text = String(content || '').trim();
  if (!text || text.toLowerCase().startsWith(command)) return null;
  const mention = new RegExp(`<@!?${botId}>`, 'g');
  if (mention.test(text)) {
    const question = text.replace(mention, ' ').replace(/\s+/g, ' ').replace(NAME_RE, '').trim();
    return question || null;
  }
  if (!NAME_RE.test(text)) return null;
  return text.replace(NAME_RE, '').trim() || null;
}

// Discord's limit is 2,000 characters a message. Cut at a paragraph, then a
// line, then a sentence, then a space — whichever comes last within the limit.
function splitMessage(text, max = 2000) {
  const parts = [];
  let rest = String(text).trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.search(/[.!?]\s[^.!?]*$/) + 1, window.lastIndexOf(' ')]
      .find(i => i > max * 0.5) || max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// No pings from the model's text: no @everyone, roles or users.
const NO_PINGS = { parse: [], repliedUser: false };

const SAY_PROMPT = 'Reply with only the exact words to say out loud in the voice channel, in the ' +
  'language asked for, and nothing else: no quotation marks, no explanation, no pronunciation guide.';
const SAY_MAX_CHARS = 400;

// createTextChat(deps) → { onMessage(message) → true when it was for her }.
//   llm            answer-llm.js
//   botId()        her Discord user id
//   isReady()      startup has finished
//   inChannels(c)  c is one of TEXT_CHAT_CHANNELS
//   sendCommand(channel, command, requesterId)   post a smakbot command, credited to them
//   sayInVoice(text, userId, who) → bool   speak in the voice channel (false: not in one)
//   voiceChannelName() → name, or null when not in a voice channel
//   nowPlaying     now-playing.js: "what song is this?"
function createTextChat({ config, llm, console, botId, isReady, inChannels, sendCommand, sayInVoice, voiceChannelName, nowPlaying, command = '!luna' }) {
  const queues = new Map();   // channel id -> the answer in progress

  function onMessage(message) {
    if (!config.TEXT_CHAT_CHANNELS.length || message.author?.bot || !message.channel) return false;
    if (!inChannels(message.channel)) return false;
    const question = textQuestion(message.content, botId(), command);
    if (!question) return false;
    if (!isReady()) { message.reply('Still starting up — try again in a few seconds.').catch(() => {}); return true; }
    const key = message.channel.id;
    const answer = (queues.get(key) || Promise.resolve())
      .then(() => answerInText(message, question))
      .catch(err => console.error(`[text] ${err.message}`));
    queues.set(key, answer);
    return true;
  }

  const reply = (message, content) => message.reply({ content, allowedMentions: NO_PINGS });

  async function answerInText(message, question) {
    const channel = message.channel;
    const name = message.member?.displayName || message.author?.username || 'Someone';
    const userId = message.author?.id || 'text';
    console.log(`[text] ${name}: ${question}`);

    const what = route(question, { voice: false });
    // "Luna, play …", "skip", "stop": straight to smakbot, as by voice.
    if (what.type === 'music') {
      await sendCommand(channel, what.command, userId);
      if (what.command.ack) await reply(message, what.command.ack).catch(() => {});
      return;
    }
    // "Say … in the voice channel": the model only writes the line; Luna speaks
    // it and confirms herself, so the confirmation is always true.
    if (what.type === 'say') return sayFromText(message, question, name, userId);
    // "What song is this?": from smakbot (else the LLM answers, as by voice).
    if (what.type === 'now-playing' && nowPlaying?.enabled) {
      await reply(message, nowPlaying.describe(await nowPlaying.get(message.guild?.id || ''))).catch(() => {});
      return;
    }
    // "What are our top songs?": the same, from smakbot's most played list.
    if (what.type === 'top-songs' && nowPlaying?.enabled) {
      await reply(message, nowPlaying.describeTop(await nowPlaying.topSongs(what.count), what.count)).catch(() => {});
      return;
    }

    // "Luna is typing…" lasts ~10 s; renewed until the answer is posted.
    const typing = () => channel.sendTyping?.().catch(() => {});
    typing();
    const typingTimer = setInterval(typing, 8000);
    let text = '', failed = false, searched = false;
    try {
      const onTool = t => {
        if (t.type === 'say') {
          sayInVoice(t.text, userId, name);
        } else if (t.type === 'music') {
          if (t.command) sendCommand(channel, t.command, userId);
        } else if (t.type === 'search' && !searched) {
          searched = true;
          message.react('🔍').catch(() => {});
        }
      };
      for await (const piece of llm.stream(`${name}: ${question}`, { userId, tag: 'text',
        useSearch: llm.offerSearch(question), textMode: true, memoryKey: `text:${channel.id}`, toolNames: TEXT_TOOL_NAMES, onTool })) {
        text += piece;
      }
    } catch (err) {
      failed = true;
      console.error(`[text] answer failed: ${err.message}`);
    } finally {
      clearInterval(typingTimer);
    }

    const answer = text.replace(/<\/?think>/gi, '').trim() ||
      (failed ? 'Sorry, I had trouble with that.' : 'Sorry, I lost my train of thought.');
    const [first, ...rest] = splitMessage(answer);
    await reply(message, first).catch(err => console.error(`[text] reply failed: ${err.message}`));
    for (const part of rest) await channel.send({ content: part, allowedMentions: NO_PINGS }).catch(() => {});
  }

  async function sayFromText(message, question, name, userId) {
    const channel = message.channel;
    if (!voiceChannelName()) {
      await reply(message, "I'm not in a voice channel right now.").catch(() => {});
      return;
    }
    channel.sendTyping?.().catch(() => {});
    let line = '';
    try {
      for await (const piece of llm.stream(`${name}: ${question}`, { userId, useSearch: false,
        textMode: true, memoryKey: `text:${channel.id}`, toolNames: new Set(), extraSystem: SAY_PROMPT, flavorOk: false })) {
        line += piece;
      }
    } catch (err) {
      console.error(`[text] say failed: ${err.message}`);
    }
    line = line.replace(/<\/?think>/gi, '').trim().replace(/^["“'‘]+|["”'’]+$/g, '').trim();
    if (!line || !sayInVoice(line, userId, name)) {
      await reply(message, 'Sorry, I couldn\'t work out what to say.').catch(() => {});
      return;
    }
    await reply(message, `🔊 Said in ${voiceChannelName() || 'the voice channel'}: ${line.slice(0, SAY_MAX_CHARS)}`).catch(() => {});
  }

  return { onMessage };
}

module.exports = { createTextChat, textQuestion, splitMessage, isSayRequest, SAY_MAX_CHARS };
