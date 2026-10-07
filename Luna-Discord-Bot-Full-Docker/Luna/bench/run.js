// ─── LLM benchmark: run ───────────────────────────────────────────────────────
//
// Asks the model loaded in LM Studio every question in questions.json, the way
// Luna asks: her system prompt (prompt.js, with the personality and time zone
// from Luna/.env), the same /api/v1/chat endpoint and search plugin. Each
// question gets a fresh conversation, a few takes, with reasoning off and on.
// Results go to bench/results/ for rate.js and report.js.
//
// Not included: the occasional flavor line and the ElevenLabs audio-tag
// instruction, which are random or depend on the voice in use.
//
//   node bench/run.js [--model ID] [--takes 3] [--reasoning off,on] [--only id,id] [--env FILE]
//
// See README → Development → LLM benchmark for running it in Docker.

const fs = require('fs'), path = require('path'), util = require('util');
const { loadConfig } = require('../config');
const { systemPrompt } = require('../prompt');
const { isCorrect, searchOk, voiceIssues, wordCount } = require('./score');

const LIMIT_MS = 240_000;   // per answer
const RESULTS = path.join(__dirname, 'results');

function parseArgs(argv) {
  const args = { takes: 3, reasoning: ['off', 'on'], only: null, model: null, env: path.join(__dirname, '..', '.env') };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--takes') { args.takes = Math.max(1, parseInt(value, 10) || 1); i++; }
    else if (flag === '--reasoning') { args.reasoning = value.split(',').map(s => s.trim()).filter(Boolean); i++; }
    else if (flag === '--only') { args.only = value.split(',').map(s => s.trim()); i++; }
    else if (flag === '--model') { args.model = value; i++; }
    else if (flag === '--env') { args.env = value; i++; }
    else { console.error(`Unknown option ${flag}\nUsage: node bench/run.js [--model ID] [--takes 3] [--reasoning off,on] [--only id,id] [--env FILE]`); process.exit(2); }
  }
  return args;
}

// What LM Studio is sent for each mode, best first. Models differ: Gemma
// takes only on/off, others want a level, and a model that cannot reason
// rejects the setting altogether (null = leave it out).
const REASONING_VALUES = { off: ['off', null], on: ['on', 'medium'] };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = fs.existsSync(args.env) ? util.parseEnv(fs.readFileSync(args.env, 'utf8')) : {};
  const config = loadConfig({ ...env, ...process.env }, { warn: m => console.warn(m) });
  const url = config.LM_STUDIO_URL || 'http://127.0.0.1:1234/api/v1/chat';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${config.LM_STUDIO_MCP_BEARER_TOKEN}` };
  let timeZone = config.LUNA_TIMEZONE;
  try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch { timeZone = 'UTC'; }

  const { questions } = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
  const chosen = args.only ? questions.filter(q => args.only.includes(q.id)) : questions;
  if (!chosen.length) { console.error('No questions match --only'); process.exit(2); }

  const model = args.model || await loadedModel(url, headers);
  const offerSearch = config.WEB_SEARCH !== 'off';
  const allowed = config.SEARCH_TOOLS.toLowerCase() === 'all' ? {} : { allowed_tools: config.SEARCH_TOOLS.split(',').map(t => t.trim()).filter(Boolean) };
  const integration = config.SEARCH_MCP_PLUGIN
    ? { type: 'plugin', id: config.SEARCH_MCP_PLUGIN, ...allowed }
    : config.TAVILY_API_KEY ? { type: 'ephemeral_mcp', server_label: 'tavily',
        server_url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${config.TAVILY_API_KEY}`, ...allowed } : null;

  const prompt = systemPrompt({ config, timeZone, search: offerSearch && !!integration && config.ANNOUNCE_SEARCH });
  const ask = (input, reasoning) => askOnce({ url, headers, model, input, prompt, reasoning,
    integrations: offerSearch && integration ? [integration] : null });

  // A first request per mode loads the weights, primes the search plugin, and
  // finds which reasoning value the model takes (if any).
  const modes = {};
  for (const mode of args.reasoning) {
    if (!REASONING_VALUES[mode]) { console.error(`--reasoning takes off and/or on, not ${mode}`); process.exit(2); }
    modes[mode] = { supported: false, value: null };
    for (const value of REASONING_VALUES[mode]) {
      const res = await ask('hi', value);
      if (res.error) { modes[mode].error = res.error; continue; }
      // Left out, the setting is the model's default — which isn't "off" if it reasons.
      if (value === null && (res.reasoning_tokens > 0 || res.reasoning_s > 0)) { modes[mode].error = 'the model always reasons'; continue; }
      modes[mode] = { supported: true, value }; break;
    }
    console.log(`reasoning ${mode}: ` + (modes[mode].supported ? `sent as ${modes[mode].value ? `"${modes[mode].value}"` : 'nothing (model default)'}` : `not supported (${modes[mode].error})`));
  }
  const usable = Object.keys(modes).filter(m => modes[m].supported);
  if (!usable.length) { console.error('The model answered no reasoning mode — is it loaded?'); process.exit(1); }

  fs.mkdirSync(RESULTS, { recursive: true });
  const started = new Date();
  const file = path.join(RESULTS, `${model.replace(/[^\w.-]+/g, '_')}-${started.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.json`);
  const result = {
    model, startedAt: started.toISOString(), timeZone, takes: args.takes,
    personality: config.LM_PERSONALITY, concise: config.LM_CONCISE, search: !!(offerSearch && integration),
    systemPrompt: prompt, modes, runs: [],
  };
  console.log(`${model}: ${chosen.length} questions × ${args.takes} takes × ${usable.length} modes → ${path.relative(process.cwd(), file)}`);

  // Takes and modes interleaved, so a slow patch on the machine spreads over
  // both modes instead of skewing one.
  for (let take = 1; take <= args.takes; take++) {
    for (const q of chosen) {
      for (const mode of usable) {
        const res = await ask(q.q, modes[mode].value);
        const answer = res.answer || '';
        const run = {
          id: q.id, kind: q.kind, mode, take, ...res,
          correct: res.error ? false : isCorrect(answer, q.expect, { timeZone, now: new Date() }),
          searchOk: res.error ? false : searchOk(res.searches.length > 0, q.search),
          voiceIssues: res.error ? ['error'] : voiceIssues(answer),
          words: wordCount(answer),
        };
        result.runs.push(run);
        fs.writeFileSync(file, JSON.stringify(result, null, 1));
        const marks = [run.correct === false && 'WRONG', run.searchOk === false && (q.search === 'required' ? 'NO SEARCH' : 'SEARCHED'),
          ...run.voiceIssues.map(i => i.toUpperCase())].filter(Boolean);
        console.log(`take ${take} ${q.id.padEnd(16)} ${mode.padEnd(3)} first word ${fmt(run.first_word_s)}  total ${fmt(run.total_s)}` +
          `  ${(run.tok_per_s ?? 0).toFixed(0).padStart(3)} tok/s  searches ${run.searches.length}  ${marks.join(' ')}` +
          (run.error ? `  (${run.error})` : ''));
      }
    }
  }
  console.log(`\nDone. Next: node bench/rate.js (personality), then node bench/report.js`);
}

function fmt(s) { return s == null ? '   — ' : `${s.toFixed(1).padStart(5)}s`; }

async function loadedModel(url, headers) {
  const res = await fetch(url.replace('/api/v1/chat', '/api/v1/models'), { headers });
  const data = await res.json();
  const loaded = data?.models?.find(m => m.type === 'llm' && m.loaded_instances?.length > 0);
  if (!loaded) { console.error('No model is loaded in LM Studio (or pass --model)'); process.exit(1); }
  return loaded.loaded_instances[0].id;
}

// One question, streamed, timed. Never throws: failures come back as `error`.
async function askOnce({ url, headers, model, input, prompt, reasoning, integrations }) {
  const body = { model, input, stream: true, system_prompt: prompt, ...(integrations && { integrations }), ...(reasoning && { reasoning }) };
  const t0 = performance.now();
  const secs = () => Math.round((performance.now() - t0) / 100) / 10;
  const out = { first_word_s: null, total_s: null, reasoning_s: 0, searches: [], tok_per_s: null,
    output_tokens: null, reasoning_tokens: null, timed_out: false, answer: '' };
  let reasoningAt = null;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(LIMIT_MS) });
    if (!res.ok) return { ...out, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let e; try { e = JSON.parse(line.slice(5)); } catch { continue; }
        if (e.type === 'reasoning.start') reasoningAt = performance.now();
        else if (e.type === 'reasoning.end' && reasoningAt) { out.reasoning_s += (performance.now() - reasoningAt) / 1000; reasoningAt = null; }
        else if (e.type === 'tool_call.arguments') out.searches.push(e.arguments?.query ?? '?');
        else if (e.type === 'message.delta') {
          out.answer += e.content ?? '';
          if (out.first_word_s == null && /[a-z0-9]/i.test(out.answer)) out.first_word_s = secs();
        } else if (e.type === 'chat.end') {
          const stats = e.result?.stats ?? {};
          out.tok_per_s = stats.tokens_per_second ?? null;
          out.output_tokens = stats.total_output_tokens ?? null;
          out.reasoning_tokens = stats.reasoning_output_tokens ?? null;
        } else if (e.type === 'error') return { ...out, total_s: secs(), error: JSON.stringify(e.error ?? e).slice(0, 200) };
      }
    }
  } catch (err) {
    if (err.name !== 'TimeoutError') return { ...out, total_s: secs(), error: err.message };
    out.timed_out = true;
  }
  out.total_s = secs();
  out.reasoning_s = Math.round(out.reasoning_s * 10) / 10;
  out.answer = out.answer.trim();
  return out.timed_out ? { ...out, error: `no answer within ${LIMIT_MS / 1000}s` } : out;
}

main().catch(err => { console.error(err); process.exit(1); });
