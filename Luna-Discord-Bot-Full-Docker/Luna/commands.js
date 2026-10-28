// ─── Commands ─────────────────────────────────────────────────────────────────
//
// What a question is, before any LLM sees it — the same for voice and text:
//
//   route(question, { voice }) →
//     { type: 'music', command }   play/skip/stop, straight to smakbot
//     { type: 'leave' }            "leave", "bye" (by voice only)
//     { type: 'say' }              "say … in the voice channel" (typed only)
//     { type: 'now-playing' }      "what song is this?" (answered from smakbot)
//     { type: 'top-songs', count } "what are our top songs?" (read from smakbot, not played)
//     { type: 'ask' }              everything else: the LLM answers
//
// A smakbot command, whether from a fixed command here or from the LLM's
// music tools (llm-tools.js), is { text, summon, ack }: the message to post,
// whether smakbot is summoned first, and what Luna says about it (or null).

const { stripWakeWord } = require('./voice-input');
const { smakbotCommandFor } = require('./llm-tools');

// ─── Smakbot commands ─────────────────────────────────────────────────────────
//
// Spoken form → text command posted in the channel. Tried top-down, so
// argument-taking patterns must precede bare verbs.
//
// Every pattern is anchored at both ends against the wake-stripped transcript.
// The start anchor stops "I'll stop by later" being a command; the end anchor
// stops "skip the intro of that song you played" from silently becoming !skip
// instead of reaching the LLM.
//
// The trailing [\s,.!?]* is load-bearing: Whisper punctuates single-word
// utterances, so a spoken "skip" arrives as "Skip." and matches nothing
// without it.
// "the top 10", "ten": how many of the most played songs.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const NUMBER = `\\d+|${NUMBER_WORDS.join('|')}`;
const TOP_DEFAULT = 10;
const TOP_MAX     = 50;
// A count as said (digits or a word), within 1..TOP_MAX; TOP_DEFAULT if none.
function topCount(said) {
  if (!said) return TOP_DEFAULT;
  const n = /^\d+$/.test(said) ? Number(said) : NUMBER_WORDS.indexOf(said.toLowerCase());
  return Math.min(TOP_MAX, Math.max(1, n || TOP_DEFAULT));
}

const SMAKBOT_COMMANDS = [
  {
    // smakbot's most played songs, from its cache (!playtop): "play the top
    // 10", "play the top songs", "play our top three hits", "play our top jams", "play our most played", "play the 20 most
    // played songs", "play my favorites". Before 'play', which would search
    // for the words instead. Anchored at the end, so "play top of the world"
    // is still a song.
    name:    'playtop',
    pattern: new RegExp(
      `^play\\s+(?:(?:the|our|my)\\s+)?(?:(?:top|most[\\s-]played)(?:\\s+(${NUMBER}))?|(${NUMBER})\\s+most[\\s-]played|(?<=(?:our|my)\\s+)favou?rites?)` +
      `(?:\\s+(?:songs?|tracks?|hits?|jams?))?[\\s,.!?]*$`, 'i'),
    build:   n => `!playtop ${topCount(n)}`,
    ack:     n => `Okay, playing the top ${topCount(n)}.`,
    summon:  true,
  },
  {
    name:        'play',
    pattern:     /^play(?:\s+(?:the\s+)?(?:song|music|track))?[,.]?\s+(.+)$/i,
    requiresArg: true,
    build:       arg => `!play ${arg}`,
    ack:         arg => `Okay, playing ${arg}.`,
    // Only play summons. !skip and !stop with no music bot in the channel are
    // no-ops, and dragging smakbot in to receive them would be surprising.
    summon:      true,
  },
  {
    name:    'skip',
    pattern: /^skip(?:\s+(?:this|that|the|it))?(?:\s+(?:song|track|one))?[\s,.!?]*$/i,
    build:   () => '!skip',
    ack:     () => 'Skipping.',
  },
  {
    name:    'stop',
    pattern: /^stop(?:\s+(?:the|this|that))?(?:\s+(?:song|music|track|playing))?[\s,.!?]*$/i,
    build:   () => '!stop',
    // Set to () => null if you'd rather "stop" produce silence — some people
    // say "hey Luna, stop" meaning "stop talking", and answering them with
    // speech reads as ignoring them.
    ack:     () => 'Okay, stopping.',
  },
];

// Polite wrapping around a command: "can you play …", "Luna, could you please
// skip this song", "stop the music for me please". Stripped before the
// patterns are tried, so these are fixed commands too, instead of reaching the
// LLM (where Qwen has answered "can you play …" with "Playing it now!" and no
// tool call). Only wrapping that can't change the meaning: "do you play
// guitar" and "let's play a game" are left alone.
const POLITE_PREFIX_RE = /^(?:(?:luna|ok(?:ay)?|alright|hey|so|um+|uh+)[\s,]+|(?:can|could|would|will) you(?:\s+please)?[\s,]+|please[\s,]+|go ahead and\s+|i(?:'d| would) like you to\s+|i want you to\s+)+/i;
// Song titles end in "now" or "thank you" too ("Right Now"), so those need a
// comma before them to count as politeness.
const POLITE_SUFFIX_RE = /(?:[\s,]+(?:please|for (?:me|us))|,\s*(?:now|thanks|thank you))+([\s,.!?]*)$/i;

function stripPoliteness(text) {
  return String(text).trim().replace(POLITE_PREFIX_RE, '').replace(POLITE_SUFFIX_RE, '$1').trim();
}

// The question as a command is matched: no wake phrase (normally already
// stripped upstream; a no-op safety net for the path where openWakeWord gated
// on audio and Whisper still transcribed the phrase), no polite wrapping.
const bare = question => stripPoliteness(stripWakeWord(question));

// Returns { build, ack, summon, arg } or null.
function extractSmakbotCommand(question) {
  const after = bare(question);

  for (const cmd of SMAKBOT_COMMANDS) {
    const match = after.match(cmd.pattern);
    if (!match) continue;

    const said = match[1] ?? match[2];
    const arg = said
      ? said
          .trim()
          .replace(/[,.!?]+$/, '')
          .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')  // strip surrounding quote characters, incl. curly quotes
          .trim()
      : null;

    // A bare "play" with nothing after it is a conversational fragment, not a
    // command — fall through and let the LLM have it.
    if (cmd.requiresArg && !arg) continue;

    return { ...cmd, arg };
  }
  return null;
}

// ─── Leaving ──────────────────────────────────────────────────────────────────

// Anchored at both ends, like the smakbot patterns: "leave" and "bye" are
// commands, "leave the light on" and "bye bye birdie lyrics" are questions.
const LEAVE_RE = /^(?:please\s+|ok(?:ay)?[\s,]+|alright[\s,]+)?(?:leave|go away|get out|disconnect|log off|head out|you can (?:go|leave)|bye(?: bye)?|goodbye)(?:\s+(?:the\s+)?(?:voice\s+)?(?:channel|call|now|please|for now))*[\s,.!?]*$/i;
const LEAVE_PHRASES = ['Okay, bye everyone!', "Alright, I'm heading out. Bye!", 'Okay, see you later!'];

// ─── Saying something in the voice channel (typed) ────────────────────────────
//
// "say hello in Chinese in the voice channel", "tell everyone in vc dinner is
// ready", "announce in voice that …". Handled without relying on the model to
// call a tool (some models answer "I said it!" without calling it).
const SAY_RE = /\b(?:say|tell|announce|speak|shout|whisper|read)\b[\s\S]*?\b(?:in|on|over|to|into)\s+(?:the\s+)?(?:voice(?:\s+(?:channel|chat|call))?|vc|audio(?:\s+channel)?|call)\b/i;
const isSayRequest = question => SAY_RE.test(String(question || ''));

// ─── What's playing ───────────────────────────────────────────────────────────
//
// "What song is this?", "what's playing?", "what are we listening to?",
// "what's the name of this song?" — the whole question, so "what song is
// this about?" or "who sings this?" still reach the LLM (which is told what
// is playing, see now-playing.js).
const NOW_PLAYING_RE = /^(?:what|which)(?:'s|\s+is)?\s+(?:(?:the\s+)?(?:song|track|music|tune)(?:\s+is)?(?:\s+(?:this|that|playing|on))?|this\s+(?:song|track|tune)(?:\s+called)?|playing|that\s+(?:song|track|tune)|the\s+name\s+of\s+(?:this|that|the)\s+(?:song|track|tune)|are\s+we\s+listening\s+to|(?:song|track)\s+are\s+we\s+listening\s+to)(?:\s+(?:right\s+)?now)?[\s,.!?]*$/i;
const isNowPlayingQuestion = question => NOW_PLAYING_RE.test(bare(question));

// ─── The most played songs, read out ──────────────────────────────────────────
//
// "What are our top songs?", "what are the top 5 hits?", "which are our most
// played tracks?", "list our top ten", "tell me the 3 most played songs",
// "what's our top song?" (just the one):
// smakbot's most played list, said or typed but not played ("play the top 5"
// is the music command above). The whole question, like NOW_PLAYING_RE, so
// "what's the top song by Queen?" still reaches the LLM. How many: as said;
// else one for "song" said singular ("what's our top song?"), or TOP_LISTED.
const TOP_LISTED = 5;
const TOP_SONGS_RE = new RegExp(
  `^(?:(?:what|which)(?:'s|\\s+is|\\s+are|\\s+were)?|list|name|tell\\s+me|read(?:\\s+(?:me|out))?|give\\s+me)\\s+` +
  `(?:the\\s+|our\\s+|my\\s+)?(?:(?:top|most[\\s-]played)(?:\\s+(${NUMBER}))?|(${NUMBER})\\s+most[\\s-]played)` +
  `(?:\\s+(?:(songs|tracks|hits|jams)|song|track|hit|jam))?(?:\\s+(?:so\\s+far|lately|right\\s+now|on\\s+here))?[\\s,.!?]*$`, 'i');
function topSongsQuestion(question) {
  const m = TOP_SONGS_RE.exec(bare(question));
  if (!m) return null;
  const said = m[1] || m[2];
  const plural = m[3] || !/\b(?:song|track|hit|jam)\b/i.test(m[0]);
  return { count: said ? topCount(said) : plural ? TOP_LISTED : 1 };
}

// ─── Routing ──────────────────────────────────────────────────────────────────

function route(question, { voice }) {
  const cmd = extractSmakbotCommand(question);
  // fixedAck: the ack doesn't name what was asked for ("Skipping."), so it's
  // worth keeping rendered; "Okay, playing <song>." isn't.
  if (cmd) return { type: 'music', command: { text: cmd.build(cmd.arg), summon: !!cmd.summon, ack: cmd.ack(cmd.arg), fixedAck: cmd.ack.length === 0 } };
  if (voice && LEAVE_RE.test(bare(question))) return { type: 'leave' };
  if (!voice && isSayRequest(question)) return { type: 'say' };
  if (isNowPlayingQuestion(question)) return { type: 'now-playing' };
  const top = topSongsQuestion(question);
  if (top) return { type: 'top-songs', count: top.count };
  return { type: 'ask' };
}

// The smakbot command for one of the LLM's music tool calls, in the same
// shape (ack: null — the model says its own words about it).
function toolCommand(tool, args) {
  const c = smakbotCommandFor(tool, args);
  return c ? { ...c, ack: null } : null;
}

// ─── Sending to smakbot ───────────────────────────────────────────────────────
//
// Posts a command in the text channel, summoning smakbot first when the
// command asks for it and smakbot isn't in the voice channel. A song queued
// for someone (requesterId: their Discord user id) ends in "--for=<@id>", so
// smakbot credits it to them rather than to Luna ("added by", now playing).
// It is a mention, which Discord shows as "@name", sent without pinging them.
async function sendSmakbotCommand(channel, command, { musicBotPresent = false, console, requesterId = null }) {
  const forSomeone = /^!play/.test(command.text) && /^\d{5,25}$/.test(String(requesterId || ''));
  command = forSomeone ? { ...command, text: `${command.text} --for=<@${requesterId}>` } : command;
  console.log(`Smakbot command: ${command.text}`);
  if (!musicBotPresent && command.summon) {
    console.log('smakbot not in channel — summoning first');
    await channel.send('!summon').catch(err =>
      console.error('Failed to send summon command:', err.message)
    );
  }
  const message = forSomeone ? { content: command.text, allowedMentions: { parse: [] } } : command.text;
  await channel.send(message).catch(err =>
    console.error(`Failed to send ${command.text}:`, err.message)
  );
}

module.exports = {
  route, toolCommand, sendSmakbotCommand, extractSmakbotCommand, stripPoliteness, isSayRequest,
  LEAVE_RE, LEAVE_PHRASES,
};
