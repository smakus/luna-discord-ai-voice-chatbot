// ─── System prompt ────────────────────────────────────────────────────────────
//
// What Luna tells the model about herself on every request. Built here so the
// benchmark (bench/run.js) sends exactly the prompt Luna sends.
//
// Order matters: stable parts first and the occasional flavor line last, so
// the cached prefix LM Studio can reuse stays as long as possible.

// Luna's character comes from settings (LM_PERSONALITY, LM_CONCISE). The rest
// — the wake phrase, speakable text, the search tool — is what she needs to
// work, so it is fixed here.
function basePrompt({ LM_PERSONALITY, LM_CONCISE }) {
  return `You are Luna, a ${LM_PERSONALITY} voice assistant in a Discord voice channel. ` +
    'The user addresses you by saying "hey Luna" at the start of their message. ' +
    'This prefix is usually stripped before the message reaches you, but may ' +
    'sometimes remain — either way, ignore it and respond only to the rest. ' +
    `Keep responses ${LM_CONCISE ? 'concise and ' : ''}` +
    'conversational — no markdown, no bullet points, no emojis, just natural spoken ' +
    'sentences. Do not ask follow-up questions unless necessary for data. You have ' +
    'access to the internet via a web search tool and should use it whenever asked ' +
    'about current events, prices, weather, news, scores, or anything time-sensitive.';
}

// The same character in the text channel: people type to her, several in one
// shared conversation, and Discord shows formatting, so it is allowed.
function textBasePrompt({ LM_PERSONALITY, LM_CONCISE }) {
  return `You are Luna, a ${LM_PERSONALITY} assistant in a Discord server, answering in a text channel. ` +
    'People write to you by mentioning you or starting their message with "Luna". Several people ' +
    'may talk to you in the same conversation; each of their messages starts with their name ' +
    '("Sam: ..."), so you know who said what. Do not start your reply with your own name. ' +
    `Keep replies ${LM_CONCISE ? 'concise and ' : ''}conversational, short enough to read in a chat. ` +
    'Discord formatting is fine (bold, italics, a short list, links), but no headings or tables. ' +
    'Do not ask follow-up questions unless necessary for data. You have access to the internet via ' +
    'a web search tool and should use it whenever asked about current events, prices, weather, news, ' +
    'scores, or anything time-sensitive.';
}

// Today's date. The model otherwise guesses: it has searched for "today" as
// June 2026 in October, and called October "a December day". Date only, not
// the time, on purpose: LM Studio reuses its cached copy of an identical
// prompt prefix, and a clock in the prompt would change it on every request.
function todayLine(timeZone, now = new Date()) {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  }).format(now);
  return `Today is ${date} (${timeZone} time).`;
}

// Added whenever the search tool is offered and Luna's own heads-up is on.
// Luna announces the search the moment it starts; the model's own "I need to
// look that up for you" duplicated it, and — counting as the answer starting —
// silenced the "still thinking" fillers for the whole search that followed.
const SEARCH_PROMPT =
  "When you search the web, the user is told automatically, so never say that " +
  "you will search or look anything up; once you have the information, just answer.";

// Added whenever Luna's own tools are offered (llm-tools.js). Without it the
// model knew the tools only from their descriptions, and Qwen answered "can
// you play …" with "Playing it now!" without ever calling play_music.
function toolsLine(names) {
  const can = [];
  if (names.has('play_music')) can.push('play, skip or stop music');
  if (names.has('leave_channel')) can.push('leave the voice channel');
  if (names.has('say_in_voice')) can.push('say something out loud in the voice channel');
  if (!can.length) return '';
  return `You have tools to ${can.join(', ').replace(/, ([^,]*)$/, ' and $1')}. Saying you did something ` +
    'does not do it: whenever someone asks for one of these, call the tool, then reply. Never say that ' +
    'you are playing, skipping, stopping, leaving or saying something unless you called its tool.';
}

// Added to a quick-answer (reasoning off) retry. Without reasoning, the
// model's planning ends up in the answer — "Keep it natural, conversational,
// no markdown." was read out loud.
const QUICK_PROMPT =
  "Reply with only the words you will say out loud: no planning, no notes to " +
  "yourself, and no drafts in quotation marks.";

// Who is asking, so she can use their name. "Now and then": told only the
// name, the model starts every reply with it.
function speakerLine(name) {
  return `The person talking to you now is ${name}. Use their name now and then where it feels natural, not in every reply.`;
}

// The whole prompt for one request.
//   expressive  the audio-tag / wording instruction for the voice in use ('' for none)
//   search      the search tool is offered and Luna announces searches herself
//   tools       names of Luna's own tools offered (a Set), for toolsLine
//   speaker     the asker's speakable name ('' to leave it out); after the
//               parts every request shares, so they stay a cached prefix
//   music       what smakbot is playing (now-playing.js), '' when nothing;
//               changes with every song, so it comes late
//   extra       e.g. QUICK_PROMPT for a quick-answer retry
//   flavor      the occasional personality line, already chosen or ''
//   text        the text-channel version of her (textBasePrompt) instead of voice
function systemPrompt({ config, timeZone, now = new Date(), expressive = '', search = false, tools = new Set(), speaker = '', music = '', extra = '', flavor = '', text = false }) {
  return (text ? textBasePrompt(config) : basePrompt(config)) + ' ' + todayLine(timeZone, now) +
    (expressive ? ' ' + expressive : '') +
    (search ? ' ' + SEARCH_PROMPT : '') +
    (tools.size && toolsLine(tools) ? ' ' + toolsLine(tools) : '') +
    (speaker ? ' ' + speakerLine(speaker) : '') +
    (music ? ' ' + music : '') +
    (extra ? ' ' + extra : '') +
    (flavor ? ' ' + flavor : '');
}

module.exports = { todayLine, speakerLine, toolsLine, systemPrompt, SEARCH_PROMPT, QUICK_PROMPT };
