// ─── Tools for the LLM ────────────────────────────────────────────────────────
//
// Things the LLM can make Luna do: play, skip and stop music through smakbot,
// look up the most played songs, leave the voice channel, and (from text chat) say something in it. The
// fixed commands in commands.js ("play …", "skip", "stop", "leave") handle the
// plain requests instantly, before the LLM; these tools cover everything else ("put on something chill", "we're
// done for tonight, you can head out").
//
// Served to LM Studio by mcp-server.js. A tool's run() only answers the LLM
// (that server cannot tell whose question a call belongs to). Luna acts when
// she sees the call in the asker's own answer stream (read in answer-llm.js,
// acted on in voice-answer.js and text-chat.js): the smakbot command via
// smakbotCommandFor(), or leaving once her goodbye has played.
//
// smakbot: !play queues after the current song when music is playing, so
// there is no separate queue tool.

const MUSIC_TOOLS = [
  {
    name: 'play_music',
    description: 'Play music in the voice channel through the music bot: a song, artist, album, ' +
      'soundtrack or style. If music is already playing, it is queued after the current song. ' +
      'Use it whenever someone asks for music to be played or queued.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for and play, e.g. "Bohemian Rhapsody Queen" or "lo-fi study beats"' },
      },
      required: ['query'],
    },
    run: ({ query }) => `Queued "${query}" with the music bot. It plays after any song already playing.`,
  },
  {
    name: 'play_top_songs',
    description: "Play the most played songs: the music bot's own favourites, the ones played most " +
      'in this server. Use it when someone asks you to play the top songs, the most played, the usual, or ' +
      'their favourites rather than a particular song. To only say which songs those are, use list_top_songs.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: 'How many songs (default 10, at most 50)', minimum: 1, maximum: 50 },
      },
    },
    run: ({ count }) => `Queued the ${count || 10} most played songs with the music bot.`,
  },
  {
    name: 'skip_song',
    description: 'Skip the song the music bot is playing now and go to the next one in its queue.',
    inputSchema: { type: 'object', properties: {} },
    run: () => 'Skipped to the next song.',
  },
  {
    name: 'stop_music',
    description: 'Stop the music bot: stops the music and clears its queue. Only for the music — ' +
      'not for when someone wants you to stop talking.',
    inputSchema: { type: 'object', properties: {} },
    run: () => 'Stopped the music.',
  },
];

// Read-only: which songs are played most, without playing anything ("is
// Tom Sawyer in our top ten?", "what do we listen to most?"). index.js
// replaces run() with one that asks smakbot (now-playing.js).
const TOP_TOOL = {
  name: 'list_top_songs',
  description: "Look up the most played songs in this server and their play counts, without playing " +
    'anything. Use it when someone asks which songs are played most, what their favourites are, or ' +
    'whether a song is among them.',
  inputSchema: {
    type: 'object',
    properties: {
      count: { type: 'integer', description: 'How many (default 10, at most 50)', minimum: 1, maximum: 50 },
    },
  },
  run: () => 'The most played songs are not available right now.',
};

const LEAVE_TOOL = {
  name: 'leave_channel',
  description: 'Actually leave the voice channel. Saying goodbye does not make you leave: you must ' +
    'call this whenever someone tells you to leave, go, head out, log off or go away, or says they are ' +
    'done with you for now ("that will be all", "catch you later"). Then say a short goodbye. Not for ' +
    'questions about leaving something else.',
  inputSchema: { type: 'object', properties: {} },
  run: () => 'You will leave the voice channel right after your reply has been spoken.',
};

// From text chat: say something out loud in the voice channel ("say hello in
// Chinese in the voice channel"). index.js replaces run() with one that knows
// whether Luna is in a voice channel, and speaks the line.
const SAY_TOOL = {
  name: 'say_in_voice',
  description: 'Say something out loud in the voice channel you are in, in your voice. Use it when ' +
    'someone typing asks you to say something in the voice channel. Pass exactly the words to speak, ' +
    'in the language asked for (e.g. "你好!" for hello in Chinese), at most a few sentences. Then ' +
    'confirm in your text reply what you said.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Exactly what to say out loud' } },
    required: ['text'],
  },
  run: () => 'Said in the voice channel.',
};

const LLM_TOOLS = [...MUSIC_TOOLS, TOP_TOOL, LEAVE_TOOL, SAY_TOOL];
const LLM_TOOL_NAMES = new Set(LLM_TOOLS.map(t => t.name));
// Which are offered where: leaving makes sense only by voice, saying
// something in voice only from text.
const VOICE_TOOL_NAMES = new Set([...MUSIC_TOOLS.map(t => t.name), TOP_TOOL.name, LEAVE_TOOL.name]);
const TEXT_TOOL_NAMES = new Set([...MUSIC_TOOLS.map(t => t.name), TOP_TOOL.name, SAY_TOOL.name]);
const MUSIC_TOOL_NAMES = new Set(MUSIC_TOOLS.map(t => t.name));

// The smakbot command for a tool call: { text, summon }, or null.
function smakbotCommandFor(tool, args = {}) {
  if (tool === 'play_music') {
    const query = String(args.query || '').trim();
    return query ? { text: `!play ${query}`, summon: true } : null;
  }
  if (tool === 'play_top_songs') {
    const n = Math.min(50, Math.max(1, Math.round(Number(args.count)) || 10));
    return { text: `!playtop ${n}`, summon: true };
  }
  if (tool === 'skip_song') return { text: '!skip', summon: false };
  if (tool === 'stop_music') return { text: '!stop', summon: false };
  return null;
}

module.exports = { LLM_TOOLS, LLM_TOOL_NAMES, VOICE_TOOL_NAMES, TEXT_TOOL_NAMES, MUSIC_TOOL_NAMES, smakbotCommandFor };
