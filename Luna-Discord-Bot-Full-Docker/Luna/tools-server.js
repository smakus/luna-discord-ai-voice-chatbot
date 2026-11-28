// ─── Luna's tools, served to LM Studio ────────────────────────────────────────
//
// Besides the fixed commands, the LLM can play, skip and stop music, look up
// the most played and requested songs, post a picture, leave the channel and
// say something in it (llm-tools.js). Luna serves the tools over MCP on
// LUNA_MCP_PORT; LM Studio knows them from its mcp.json as "luna", and every
// request offers them as mcp/luna. A tool's run() only answers the model: when
// a call succeeds, Luna acts on it in the asker's own answer (actions.js).
// Offering them, and leaving them out while LM Studio can't reach them, is
// answer-llm.js's job.
//
// startToolsServer({ config, console, http, session, nowPlaying, imageSearch })

const { createMcpServer } = require('./mcp-server');
const { LLM_TOOLS, LLM_TOOL_NAMES } = require('./llm-tools');
const { TOOLS_PLUGIN_ID } = require('./answer-llm');

const between = (value, lo, hi, fallback) => Math.min(hi, Math.max(lo, Math.round(Number(value)) || fallback));

function startToolsServer({ config, console, http, session, nowPlaying, imageSearch }) {
  const PORT = config.LUNA_MCP_PORT;
  // The tools whose answer to the model depends on what's going on; the rest
  // answer with their fixed run() (llm-tools.js).
  const runs = {
    // Tells the model the truth about whether anything was said.
    say_in_voice: () => session.connection
      ? `Said in ${session.channel?.name || 'the voice channel'}.`
      : 'You are not in a voice channel, so nothing was said. Tell them that.',
    // Asks smakbot: the server's most played, or one person's requests.
    list_top_songs: async ({ count, user }) => {
      const n = between(count, 1, 50, 10);
      if (typeof user === 'string' && user.trim()) {
        return nowPlaying.listRequestsForModel(await nowPlaying.topRequests(user.trim(), n), user.trim());
      }
      return nowPlaying.listForModel(await nowPlaying.topSongs(n));
    },
    // Asks smakbot who requests the most.
    list_top_requesters: async ({ count }) => nowPlaying.listRequestersForModel(
      await nowPlaying.topRequesters(between(count, 1, 50, 5))),
    // Finds the picture now, so the model is told whether there is one; the
    // answer's onTool handler posts it (the same search, cached).
    post_image: async ({ query }) => {
      const words = String(query || '').trim();
      if (!imageSearch.enabled) return 'Pictures are not set up (no TAVILY_API_KEY), so nothing was posted. Say so.';
      return (await imageSearch.find(words))
        ? `A picture for "${words}" is being posted in the text chat. Mention it briefly; you can't see it, so don't describe it.`
        : `No picture could be found for "${words}", so nothing was posted. Say so.`;
    },
  };
  const tools = LLM_TOOLS.map(t => runs[t.name] ? { ...t, run: runs[t.name] } : t);
  const server = createMcpServer({ tools });
  http.createServer((req, res) => server.handle(req, res).catch(() => { try { res.writeHead(500).end(); } catch (_) {} }))
    .on('error', err => console.error(`[tools] tools server failed on port ${PORT}: ${err.message} — LLM tools off`))
    .listen(PORT, '0.0.0.0', () => console.log(
      `[tools] ${[...LLM_TOOL_NAMES].join(', ')} offered to the LLM as ${TOOLS_PLUGIN_ID} ` +
      `(LM Studio's mcp.json needs "luna": {"url": "http://127.0.0.1:${PORT}/mcp"})`));
}

module.exports = { startToolsServer };
