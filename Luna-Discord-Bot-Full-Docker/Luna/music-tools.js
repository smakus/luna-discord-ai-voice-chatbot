// ─── Music tools for the LLM ──────────────────────────────────────────────────
//
// The fixed patterns in index.js ("play …", "skip", "stop") handle the plain
// commands instantly, before the LLM. These tools cover everything else
// ("put on something chill", "turn that off"): the LLM calls one, and Luna
// posts the smakbot command.
//
// Served to LM Studio by mcp-server.js. A tool's run() only answers the LLM
// (that server cannot tell whose question a call belongs to); index.js posts
// the command when it sees the call in the speaker's own answer stream, via
// smakbotCommandFor().
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

const MUSIC_TOOL_NAMES = new Set(MUSIC_TOOLS.map(t => t.name));

// The smakbot command for a tool call: { text, summon }, or null.
function smakbotCommandFor(tool, args = {}) {
  if (tool === 'play_music') {
    const query = String(args.query || '').trim();
    return query ? { text: `!play ${query}`, summon: true } : null;
  }
  if (tool === 'skip_song') return { text: '!skip', summon: false };
  if (tool === 'stop_music') return { text: '!stop', summon: false };
  return null;
}

module.exports = { MUSIC_TOOLS, MUSIC_TOOL_NAMES, smakbotCommandFor };
