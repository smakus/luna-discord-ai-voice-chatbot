// ─── The LLM ──────────────────────────────────────────────────────────────────
//
// Everything about talking to LM Studio, for voice and text alike:
//   - which model is loaded (resolveModel);
//   - what each request offers: web search and Luna's own tools, each paused
//     for a while when LM Studio can't reach it;
//   - the system prompt (prompt.js) and conversation memory;
//   - streaming the answer, with the retries LM Studio's errors call for;
//   - what the model's tool calls mean (onTool): a search started, music to
//     play, leaving, something to say — read here once, so voice and text
//     only decide what to do about them.
//
// createLlm({ config, fetch, console, expressivePrompt, musicLine, nameOf }) → llm.
// fetch and console are passed in (not the globals) so the test harness can
// fake them; expressivePrompt() is the audio-tag instruction of the voice
// speaking now; musicLine() resolves to the prompt line about the song playing
// (now-playing.js), or ''.

const { systemPrompt, SEARCH_PROMPT } = require('./prompt');
const { takeSentences, createTagJoiner } = require('./sentences');
const { LLM_TOOL_NAMES, VOICE_TOOL_NAMES, MUSIC_TOOL_NAMES } = require('./llm-tools');
const { toolCommand } = require('./commands');

// ─── When to search ───────────────────────────────────────────────────────────

const SEARCH_KEYWORDS = [
  // factual lookups
  'price', 'cost', 'weather', 'forecast', 'temperature',
  'news', 'score', 'result', 'standing', 'ranking',
  'stock', 'crypto', 'bitcoin', 'market',
  // question patterns that imply real-world data
  'who is', 'who are', 'who won', 'who plays',
  'what happened', 'what time is',
  'when is', 'when does', 'when did',
  'where is', 'where are',
  'how much does', 'how much is',
  'is there a',
  // Unambiguous recency phrases. Each of these is a request for information
  // that changed after training; none of them occur in ordinary chit-chat.
  'the latest', 'latest on', 'any news', 'update on', 'headlines',
  'release date', 'came out', 'coming out',
  'exchange rate', 'earnings report', 'election',
  'open right now', 'still open', 'as of now',
];

// Bare time words are NOT search triggers on their own.
//
// "today", "tonight" and friends are among the most common words in casual
// speech — "how are you doing today?" is a greeting, not a query, and routing
// it through Tavily costs a web round trip plus a whole extra tool-calling turn
// on the LLM for no benefit. They only imply a lookup when paired with a
// subject whose answer actually moves.
const TEMPORAL = [
  'today', 'tonight', 'tomorrow', 'yesterday', 'last night',
  'this week', 'this month', 'this year', 'right now', 'currently',
];

const TOPICAL = [
  'weather', 'forecast', 'temperature', 'rain', 'snow', 'storm',
  'news', 'happening', 'going on', 'score', 'game', 'match',
  'price', 'cost', 'stock', 'market', 'open', 'closed', 'schedule',
  'release', 'launch', 'event', 'traffic', 'flight',
];

// A four-digit year at or after 2020 is a strong recency signal on its own and
// cannot be expressed as a substring match.
const SEARCH_YEAR_RE = /\b20[2-9]\d\b/;

function needsWebSearch(query) {
  const lower = query.toLowerCase();
  if (SEARCH_YEAR_RE.test(lower)) return true;
  if (SEARCH_KEYWORDS.some(k => lower.includes(k))) return true;
  return TEMPORAL.some(t => lower.includes(t)) && TOPICAL.some(t => lower.includes(t));
}

// Search results from tool_call.success events, condensed for a quick-answer
// retry: each result's title and snippet (never raw page content), deduplicated,
// capped at maxChars (~1,500 tokens, ~20 s to read on this hardware).
function condenseSearchResults(calls, maxChars = 6000) {
  const seen = new Set();
  const lines = [];
  for (const { query, output } of calls) {
    let results = null;
    try {
      // Tavily via MCP: '[{"type":"text","text":"{\"results\":[...]}"}]'
      const outer = typeof output === 'string' ? JSON.parse(output) : output;
      const text = Array.isArray(outer) ? outer.map(o => (o && o.text) || '').join('') : JSON.stringify(outer);
      const inner = JSON.parse(text);
      results = Array.isArray(inner.results) ? inner.results : [];
      if (inner.answer) lines.push(`- ${inner.answer}`);
    } catch (_) {}
    if (!results) {
      lines.push(`- (${query}) ${String(output ?? '').replace(/\s+/g, ' ').slice(0, 800)}`);
      continue;
    }
    for (const r of results) {
      const key = (r && (r.url || r.title)) || '';
      if (!r || seen.has(key)) continue;
      seen.add(key);
      const snippet = String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (snippet) lines.push(`- ${r.title || r.url}: ${snippet}`);
    }
  }
  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > maxChars) break;
    out += line + '\n';
  }
  return out.trim();
}

const TOOLS_PLUGIN_ID = 'mcp/luna';

function createLlm({ config, fetch, console, expressivePrompt = () => '', musicLine = async () => '', nameOf = id => id }) {
  const LM_STUDIO_URL = config.LM_STUDIO_URL;

  // The LLM gets two limits, because a single overall timeout cannot tell a
  // hung request from a slow one. A large model that reasons and searches before
  // answering can legitimately take minutes, and its answer then streams for a
  // while longer; an overall 2-minute cap cut such answers off mid-sentence.
  //
  //   LM_IDLE_TIMEOUT_MS — abort only after this long with NO data from LM
  //                        Studio. Reasoning, tool-call and token events all
  //                        reset it, so a working model never trips it.
  //   LM_TIMEOUT_MS      — overall backstop for a request that keeps trickling.
  const LM_IDLE_TIMEOUT_MS = config.LM_IDLE_TIMEOUT_MS;
  const LM_TIMEOUT_MS      = config.LM_TIMEOUT_MS;

  // Reasoning level sent to LM Studio ("off", "low", ... as the model allows;
  // empty = the model's own default, which for some models is the maximum).
  const LLM_REASONING = config.LLM_REASONING.toLowerCase();

  // The time zone of "today" in the system prompt (see prompt.js). An IANA name;
  // containers run in UTC, which turns evenings in the Americas into tomorrow.
  const LUNA_TIMEZONE = (() => {
    const tz = config.LUNA_TIMEZONE;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; }
    catch { console.warn(`LUNA_TIMEZONE="${tz}" is not a valid time zone — using UTC`); return 'UTC'; }
  })();

  // Optional personality line, injected on a fraction of requests. Keep the base
  // prompt free of "sometimes"/"occasionally" instructions — see stream().
  const LM_FLAVOR_PROMPT = config.LM_FLAVOR_PROMPT;
  const LM_FLAVOR_CHANCE = config.LM_FLAVOR_CHANCE;

  // ─── Model ──────────────────────────────────────────────────────────────────

  let model = null;

  // Run at startup, and again whenever LM Studio rejects a request, so
  // switching or reloading the model in LM Studio no longer breaks every query
  // until Luna is restarted. → false when no model is loaded.
  async function resolveModel() {
    try {
      const res = await fetch(
        LM_STUDIO_URL.replace('/api/v1/chat', '/api/v1/models'),
        { headers: { 'Authorization': `Bearer ${config.LM_STUDIO_MCP_BEARER_TOKEN}` } }
      );
      const data = await res.json();
      const loaded = data?.models?.find(m => m.type === 'llm' && m.loaded_instances?.length > 0);
      if (!loaded) throw new Error('No models loaded');
      const id = loaded.loaded_instances[0].id;
      if (id !== model) console.log(`Using LM Studio model: ${id}`);
      model = id;
      return true;
    } catch (err) {
      console.error('Failed to resolve LM Studio model:', err.message);
      return false;
    }
  }

  // ─── Conversation memory ────────────────────────────────────────────────────
  //
  // LM Studio's `previous_response_id` chains a conversation server-side. Two
  // consequences follow from how it was used before:
  //
  //   1. One global id meant every speaker shared one chain. The chain carries no
  //      speaker attribution, so the model saw A's and B's turns interleaved as a
  //      single user contradicting themselves — and B's follow-up ("what about
  //      tomorrow?") resolved against A's question.
  //   2. The chain never reset, so context grew for the lifetime of the process.
  //      Prefill cost is linear in context, so every turn was measurably slower
  //      than the last until the container was restarted.
  //
  // Now: one chain per speaker (or text channel), dropped after
  // LM_MEMORY_TTL_MS of silence or LM_MEMORY_MAX_TURNS turns, whichever comes
  // first. Both bound prefill.
  const LM_MEMORY_TTL_MS    = config.LM_MEMORY_TTL_MS;
  const LM_MEMORY_MAX_TURNS = config.LM_MEMORY_MAX_TURNS;
  const conversations = new Map(); // memory key -> { responseId, turns, lastAt }

  function getConversationId(key) {
    const c = conversations.get(key);
    if (!c) return null;
    if (Date.now() - c.lastAt > LM_MEMORY_TTL_MS) {
      conversations.delete(key);
      return null;
    }
    if (c.turns >= LM_MEMORY_MAX_TURNS) {
      console.log(`[${nameOf(key)}] conversation reset after ${c.turns} turns (context cap)`);
      conversations.delete(key);
      return null;
    }
    return c.responseId;
  }

  function rememberConversation(key, responseId) {
    if (!responseId) return;
    const prev = conversations.get(key);
    conversations.set(key, {
      responseId,
      turns:  (prev ? prev.turns : 0) + 1,
      lastAt: Date.now(),
    });
  }

  // ─── Web search ─────────────────────────────────────────────────────────────
  //
  // When the model is offered the web search tool:
  //   always   — on every question (default). The model decides for itself
  //              whether it needs the internet; the keyword rules above both
  //              missed real searches ("did UCLA play football today?" — the
  //              model then wrote a tool call as text) and searched for no
  //              reason ("is there a way to say this nicer?"). Offering the
  //              tool costs ~0.2 s per question.
  //   keywords — only when needsWebSearch() matches (the old behaviour).
  //   off      — never. Also forced when no search server is configured.
  //
  // Where the tool comes from:
  //   SEARCH_MCP_PLUGIN set (e.g. "mcp/tavily") — an MCP server configured in
  //     LM Studio's own mcp.json, which LM Studio keeps connected (~1 s faster
  //     per question than connecting per request).
  //   otherwise — Tavily's hosted MCP server with TAVILY_API_KEY, connected by
  //     LM Studio on every request (an "ephemeral" integration).
  // Either way the model is shown only SEARCH_TOOLS (default "tavily_search";
  // "all" for every tool the server has). Tavily also offers research, crawl,
  // map and extract — slower, credit-hungry, and the model chained them (search,
  // extract, search again) on a simple weather question; showing one tool also
  // cuts the tool definitions the model must read from ~2,300 to ~970 tokens.
  const SEARCH_MCP_PLUGIN = config.SEARCH_MCP_PLUGIN;
  const SEARCH_TOOLS = (() => {
    const raw = config.SEARCH_TOOLS;
    return raw.toLowerCase() === 'all' ? null : raw.split(',').map(t => t.trim()).filter(Boolean);
  })();

  // No search server configured → off, whatever WEB_SEARCH says.
  const WEB_SEARCH = !SEARCH_MCP_PLUGIN && !config.TAVILY_API_KEY ? 'off' : config.WEB_SEARCH;

  // Outage fallback. LM Studio connects to the search server before answering,
  // and if it can't (server down, or slow: it gives up after ~20 s) it rejects
  // the whole request, so with search offered on every question one outage
  // would fail every question. Instead the question is answered without
  // search, and search is paused for SEARCH_PAUSE_MS so the following
  // questions don't each pay the failed connection attempt.
  const SEARCH_PAUSE_MS = config.SEARCH_PAUSE_MS;
  let searchPausedUntil = 0;

  function pauseSearch(reason) {
    searchPausedUntil = Date.now() + SEARCH_PAUSE_MS;
    console.warn(`[search] ${reason} — answering without search; search paused for ${Math.round(SEARCH_PAUSE_MS / 60000)} min`);
  }

  const searchPaused = () => Date.now() < searchPausedUntil;

  function offerSearch(query) {
    if (searchPaused()) return false;
    return WEB_SEARCH === 'always' || (WEB_SEARCH === 'keywords' && needsWebSearch(query));
  }

  function searchIntegration() {
    const allowed = SEARCH_TOOLS ? { allowed_tools: SEARCH_TOOLS } : {};
    return SEARCH_MCP_PLUGIN
      ? { type: 'plugin', id: SEARCH_MCP_PLUGIN, ...allowed }
      : { type: 'ephemeral_mcp', server_label: 'tavily',
          server_url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${config.TAVILY_API_KEY}`, ...allowed };
  }

  function describeSearch() {
    if (WEB_SEARCH === 'off') {
      return 'off' + (SEARCH_MCP_PLUGIN || config.TAVILY_API_KEY ? '' : ' (no TAVILY_API_KEY or SEARCH_MCP_PLUGIN)');
    }
    return (WEB_SEARCH === 'always' ? 'offered on every question (the model decides)' : 'keywords') +
      ` via ${SEARCH_MCP_PLUGIN ? `LM Studio plugin ${SEARCH_MCP_PLUGIN}` : 'Tavily (connected per request)'}` +
      `, tools: ${SEARCH_TOOLS ? SEARCH_TOOLS.join(', ') : 'all'}`;
  }

  // ─── Luna's own tools ───────────────────────────────────────────────────────
  //
  // Music, leaving and saying (llm-tools.js), served by index.js over MCP and
  // known to LM Studio as mcp/luna. If LM Studio can't reach them, they are
  // left out for SEARCH_PAUSE_MS, like search.
  let toolsPausedUntil = 0;
  const offerTools = () => config.LLM_TOOLS && Date.now() >= toolsPausedUntil;
  const toolsIntegration = names => ({ type: 'plugin', id: TOOLS_PLUGIN_ID, allowed_tools: [...names] });

  // ─── Logging ────────────────────────────────────────────────────────────────

  // Where a searched answer's time goes: one line per tool call, and per long
  // read of a prompt or of tool results (~90 tokens/s on this hardware).
  function logPhase(userId, e, phase) {
    if (e.type === 'tool_call.arguments') {
      console.log(`[${nameOf(userId)}] [LLM] tool: ${e.tool} ${JSON.stringify(e.arguments || {}).slice(0, 160)}`);
    } else if (e.type === 'prompt_processing.start') {
      phase.readingAt = Date.now();
    } else if (e.type === 'prompt_processing.end' && phase.readingAt) {
      const ms = Date.now() - phase.readingAt;
      phase.readingAt = 0;
      if (ms >= 2000) console.log(`[${nameOf(userId)}] [LLM] read prompt/results in ${(ms / 1000).toFixed(1)}s`);
    }
  }

  // One line per answer from LM Studio's own accounting: what is needed to tell
  // whether a slow answer was spent reasoning, prefilling a long prompt
  // (conversation memory, stored web-search results) or just generating slowly.
  function logStats(userId, stats, memoryKey) {
    if (!stats) return;
    const n = v => (typeof v === 'number' ? v.toLocaleString('en-US') : '?');
    const f = v => (typeof v === 'number' ? v.toFixed(1) : '?');
    const turn = (conversations.get(memoryKey)?.turns || 0) + 1;
    console.log(
      `[${nameOf(userId)}] [LLM] stats: memory turn ${turn}, prompt ${n(stats.input_tokens)} tokens, ` +
      `reasoning ${n(stats.reasoning_output_tokens)}, output ${n(stats.total_output_tokens)}, ` +
      `first token ${f(stats.time_to_first_token_seconds)}s, ${f(stats.tokens_per_second)} tok/s`
    );
  }

  // ─── Tool calls ─────────────────────────────────────────────────────────────
  //
  // LM Studio reports a tool call as tool_call.start, then its name and
  // arguments, then tool_call.success (or failure). These are turned into
  // what they mean, for onTool:
  //   { type: 'search' }                          a web search started
  //   { type: 'search-result', query, output }    one came back
  //   { type: 'music', tool, args, command }      play/skip/stop (command: see commands.js, or null)
  //   { type: 'leave' }                           leave the voice channel
  //   { type: 'say', text }                       say this in the voice channel
  // Events that are none of these, and search results, go on to onEvent.
  function toolReader({ tag, onTool, onEvent }) {
    let pending = false;   // which tool is only known from the event after .start
    return e => {
      if (e.type === 'tool_call.start') { pending = true; return; }
      if ((e.type === 'tool_call.name' || e.type === 'tool_call.arguments') && pending) {
        pending = false;
        if (!LLM_TOOL_NAMES.has(e.tool_name || e.tool)) onTool({ type: 'search' });
        return;
      }
      if (e.type === 'tool_call.success') {
        if (e.tool === 'leave_channel') { onTool({ type: 'leave' }); return; }
        if (e.tool === 'say_in_voice') { onTool({ type: 'say', text: e.arguments?.text }); return; }
        if (MUSIC_TOOL_NAMES.has(e.tool)) {
          console.log(`[${nameOf(tag)}] [music] the LLM called ${e.tool} ${JSON.stringify(e.arguments || {})}`);
          onTool({ type: 'music', tool: e.tool, args: e.arguments || {}, command: toolCommand(e.tool, e.arguments) });
          return;
        }
        if (e.output) onTool({ type: 'search-result', query: e.arguments?.query || '', output: e.output });
      }
      onEvent(e);
    };
  }

  // ─── Streaming an answer ────────────────────────────────────────────────────
  //
  // stream(text, options) yields the answer as it is written: whole sentences
  // (voice), or raw pieces with line breaks and formatting kept (textMode).
  //
  //   userId      for the log; also the memory key unless memoryKey is given
  //   memoryKey   whose conversation this continues ("text:<channel>" for text)
  //   useSearch   offer web search (default: offerSearch(text))
  //   toolNames   which of Luna's tools to offer (VOICE_TOOL_NAMES by default)
  //   reasoning   overrides LLM_REASONING for this request
  //   signal      aborting it cancels the request (thinking limit, barge-in)
  //   onTool      a tool call, read (see toolReader)
  //   onEvent     every other LM Studio event (reasoning, search results, …)
  //   context     appended to the question (search results already found)
  //   extraSystem appended to the system prompt
  //   speaker     the asker's speakable name, for the prompt ('' for none)
  //   textMode    the text-channel prompt and raw pieces
  //   flavorOk    the occasional personality line may be added
  //   tag         the log tag for tool calls (default userId)
  //
  // Strategy:
  //   1. LM Studio's chat API with stream:true (SSE): yield as it arrives.
  //   2. If the response is plain JSON (LM Studio ignoring stream:true), parse
  //      it and split it into sentences ourselves.
  async function* stream(text, {
    userId, memoryKey = userId, useSearch = offerSearch(text), toolNames = VOICE_TOOL_NAMES,
    reasoning = LLM_REASONING, signal = null, onTool = () => {}, onEvent = () => {},
    context = '', extraSystem = '', speaker = '', textMode = false, flavorOk = true, tag = userId,
  } = {}) {
    const body = {
      model,
      input: context ? `${text}\n\n${context}` : text,
      stream: true,
    };
    const offeredTools = offerTools() ? toolNames : new Set();
    const integrations = [...(useSearch ? [searchIntegration()] : []), ...(offeredTools.size ? [toolsIntegration(offeredTools)] : [])];
    if (integrations.length) body.integrations = integrations;

    // Sent on EVERY request, not only the first of a chain.
    //
    // LM Studio stores the thread server-side, so in principle a system prompt
    // set on turn 1 persists through previous_response_id. In practice
    // instruction adherence decays as the prompt recedes behind a growing
    // conversation, and nothing here can observe whether the stored thread still
    // carries it. Re-sending costs a few tokens of prefill and removes the doubt.
    //
    // Personality lines are injected probabilistically, not written into the
    // base prompt. A model cannot follow "occasionally do X". Every turn is
    // evaluated independently, with no memory of how often it has already done
    // it, so "occasionally" reliably becomes "every single time". Deciding here —
    // and simply omitting the line most of the time — is the only way to get a
    // rate that is actually a rate.
    const flavor = flavorOk && LM_FLAVOR_PROMPT && Math.random() < LM_FLAVOR_CHANCE ? LM_FLAVOR_PROMPT : '';
    // Audio-tag instruction only while an expressive TTS (ElevenLabs v3/v4) is
    // the one speaking; empty for Kokoro, so it is never told to use tags.
    const expressive = textMode ? '' : expressivePrompt();
    // What smakbot is playing, so "what's this song about?" needs no tool call.
    const music = await musicLine().catch(() => '');
    body.system_prompt = systemPrompt({ config, timeZone: LUNA_TIMEZONE, expressive,
      search: useSearch && config.ANNOUNCE_SEARCH, tools: offeredTools, speaker, music, extra: extraSystem, flavor, text: textMode });

    const priorId = getConversationId(memoryKey);
    if (priorId) body.previous_response_id = priorId;

    const handleEvent = toolReader({ tag, onTool, onEvent });

    // Idle timeout: aborts only when LM Studio has sent nothing at all for
    // LM_IDLE_TIMEOUT_MS. Every chunk received — reasoning, tool calls, tokens —
    // pushes it back. LM_TIMEOUT_MS remains as an overall backstop.
    const idle = new AbortController();
    let idleTimer = null;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(new DOMException(
        `LM Studio sent nothing for ${LM_IDLE_TIMEOUT_MS / 1000}s`, 'TimeoutError')), LM_IDLE_TIMEOUT_MS);
    };
    const requestSignal = AbortSignal.any([idle.signal, AbortSignal.timeout(LM_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    if (reasoning) body.reasoning = reasoning;

    try {
      let res;
      let retriedModel = false;
      let retriedConversation = false;
      let retriedWithoutSearch = false;
      for (;;) {
        body.model = model;
        console.log(`[LLM] POST ${LM_STUDIO_URL} model=${model} stream=true useSearch=${useSearch} reasoning=${reasoning || 'default'}`);
        resetIdle();
        res = await fetch(LM_STUDIO_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.LM_STUDIO_MCP_BEARER_TOKEN}`,
          },
          body: JSON.stringify(body),
          signal: requestSignal,
        });
        if (res.ok) break;

        const errText = await res.text();

        // Luna's own tools are unreachable — not in LM Studio's mcp.json, or
        // its port isn't published. Answer without them and leave them out
        // for SEARCH_PAUSE_MS.
        if (body.integrations?.some(i => i.id === TOOLS_PLUGIN_ID) && /MCP|plugin|integration/i.test(errText) &&
            /\bluna\b/i.test(errText)) {
          toolsPausedUntil = Date.now() + SEARCH_PAUSE_MS;
          console.warn(`[tools] LM Studio can't use Luna's tools (${errText.replace(/\s+/g, ' ').slice(0, 160)}) — ` +
            `answering without them for ${Math.round(SEARCH_PAUSE_MS / 60000)} min. Is "luna" in LM Studio's mcp.json?`);
          body.integrations = body.integrations.filter(i => i.id !== TOOLS_PLUGIN_ID);
          if (!body.integrations.length) delete body.integrations;
          continue;
        }

        // The search server is unreachable (LM Studio rejects the whole request,
        // not just the search). Answer without it and pause search.
        if (!retriedWithoutSearch && useSearch && body.integrations && /MCP server|plugin|integration/i.test(errText)) {
          retriedWithoutSearch = true;
          pauseSearch(`search server unavailable (${errText.replace(/\s+/g, ' ').slice(0, 120)})`);
          body.integrations = body.integrations.filter(i => i.id === TOOLS_PLUGIN_ID);
          if (!body.integrations.length) delete body.integrations;
          body.system_prompt = body.system_prompt.replace(' ' + SEARCH_PROMPT, '');
          useSearch = false;
          continue;
        }

        // This conversation's memory no longer exists in LM Studio (it was
        // reset, its data cleared, or the stored response expired). Without
        // this the same dead id was resent on every question, and every answer
        // failed until LM_MEMORY_TTL_MS expired. Start a fresh conversation.
        if (!retriedConversation && body.previous_response_id && /previous_response_id/i.test(errText)) {
          retriedConversation = true;
          console.warn(`[${nameOf(userId)}] [LLM] conversation memory not found in LM Studio — starting a fresh one`);
          conversations.delete(memoryKey);
          delete body.previous_response_id;
          continue;
        }

        // Otherwise a 4xx is most often a model that was switched or unloaded in
        // LM Studio since startup. Look it up again and retry once.
        if (!retriedModel && res.status >= 400 && res.status < 500) {
          retriedModel = true;
          const previous = model;
          if (await resolveModel() && model !== previous) {
            console.warn(`[LLM] ${res.status} from LM Studio — model changed, retrying with ${model}`);
            continue;
          }
        }
        throw new Error(`LM Studio ${res.status}: ${errText}`);
      }

      const contentType = res.headers.get('content-type') || '';

      // ── Path A: SSE streaming ───────────────────────────────────────────────
      if (contentType.includes('text/event-stream')) {
        let buffer     = '';
        let sseBuffer  = '';
        let responseId = null;
        const reader   = res.body.getReader();
        const decoder  = new TextDecoder();

        // Terminal-event handling is load-bearing, not cosmetic.
        //
        // This loop previously ran `while (true)` and treated `data: [DONE]` as a
        // line to skip. If LM Studio finishes the response but does NOT close the
        // HTTP stream, `reader.read()` blocks forever: this generator never
        // returns, so the caller never returns, and that speaker is permanently
        // deaf with nothing logged. It presents exactly as "she answers once,
        // then stops responding".
        //
        // So: exit on the terminal markers rather than waiting for the socket.
        let finished = false;
        const phase = { readingAt: 0 };
        const joiner = createTagJoiner();   // keeps "… umbrella. [chuckles]" together

        try {
          while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;
            resetIdle();

            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop();

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              if (trimmed === 'data: [DONE]') { finished = true; break; }
              if (!trimmed.startsWith('data: ')) continue;

              let parsed;
              try { parsed = JSON.parse(trimmed.slice(6)); } catch { continue; }
              handleEvent(parsed);
              logPhase(userId, parsed, phase);
              // Reasoning or a tool call: no tag can follow the held sentence
              // now, so say it. (The end of the answer flushes it below, with
              // any tag still in the buffer.)
              if (/^(?:reasoning|tool_call)\./.test(parsed.type || '')) for (const sentence of joiner.release()) yield sentence;

              // response_id lives inside chat.end result
              if (parsed.type === 'chat.end') {
                logStats(userId, parsed.result?.stats, memoryKey);
                if (parsed.result?.output) {
                  const msg = parsed.result.output.filter(o => o.type === 'message').pop();
                  if (msg?.content) responseId = parsed.result?.response_id ?? null;
                }
                finished = true;
                break;
              }

              // A message ends at a tool call or at the end of the answer: either
              // way a sentence boundary, so text before a search is never glued
              // onto the text after it.
              if (parsed.type === 'message.end') {
                const rest = buffer;
                buffer = '';
                for (const sentence of joiner.flush(rest)) yield sentence;
                continue;
              }

              // LM Studio SSE format: {type:'message.delta', content:'token'}
              const delta = parsed.type === 'message.delta' ? (parsed.content ?? '') : '';

              if (!delta) continue;
              if (textMode) { yield delta; continue; }
              buffer += delta;

              const split = takeSentences(buffer);
              buffer = split.rest;
              for (const sentence of joiner.push(split.sentences, buffer)) yield sentence;
            }
          }
        } catch (err) {
          // Cut off (a stall, a timeout): a finished sentence the joiner was
          // holding for a possible tag is still said, then the error goes on.
          for (const sentence of joiner.flush('')) yield sentence;
          throw err;
        } finally {
          // Cancel rather than only releasing the lock: if we exited on a terminal
          // marker the socket is still open, and without this it leaks until the
          // AbortSignal fires two minutes later.
          try { await reader.cancel(); } catch (_) {}
          try { reader.releaseLock(); } catch (_) {}
        }

        for (const sentence of joiner.flush(buffer)) yield sentence;
        rememberConversation(memoryKey, responseId);

      // ── Path B: Plain JSON fallback (responses API without true streaming) ───
      } else {
        console.log('[LLM] Non-streaming JSON mode (unexpected — LM Studio ignored stream:true)');
        // No progress to observe while the whole body arrives; rely on the
        // overall LM_TIMEOUT_MS alone.
        clearTimeout(idleTimer);
        const data = await res.json();

        logStats(userId, data.stats, memoryKey);
        rememberConversation(memoryKey, data.response_id);

        // Extract full reply text from responses API format
        const messageItem = data.output?.filter(o => o.type === 'message').pop();
        const fullText    = messageItem?.content?.trim();

        if (!fullText) {
          console.error('[LLM] No content found in response:', JSON.stringify(data).slice(0, 300));
          throw new Error('No message content in LLM response');
        }

        // Split into sentences and yield each one so TTS starts immediately
        if (textMode) { yield fullText; return; }
        const split = takeSentences(fullText);
        const joiner = createTagJoiner();
        for (const sentence of [...joiner.push(split.sentences, ''), ...joiner.flush(split.rest)]) yield sentence;
      }
    } finally {
      clearTimeout(idleTimer);
    }
  }

  return {
    get model() { return model; },
    reasoning: LLM_REASONING,
    resolveModel,
    stream,
    offerSearch,
    searchPaused,
    // A search may be offered at all: configured and not paused.
    canSearch: () => WEB_SEARCH !== 'off' && !searchPaused(),
    describeSearch,
    // Forget every conversation (Luna left the voice channel).
    forgetConversations: () => conversations.clear(),
  };
}

module.exports = { createLlm, condenseSearchResults, TOOLS_PLUGIN_ID };
