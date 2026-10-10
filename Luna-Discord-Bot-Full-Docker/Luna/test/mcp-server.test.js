// Luna's MCP server (mcp-server.js) and the tools it serves (llm-tools.js).
// Run: npm test   (see README → Development)
const { describe, it } = require('node:test');
const assert = require('assert');
const { Readable } = require('stream');
const { createMcpServer } = require('../mcp-server');
const { LLM_TOOLS, MUSIC_TOOL_NAMES, smakbotCommandFor } = require('../llm-tools');

// One HTTP exchange with the server, without a socket.
async function exchange(server, { method = 'POST', url = '/mcp', body } = {}) {
  const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
  Object.assign(req, { method, url });
  let status = 0, headers = {}, out = '';
  const res = { writeHead(s, h = {}) { status = s; headers = h; return res; }, end(b = '') { out = String(b); return res; } };
  await server.handle(req, res);
  return { status, headers, json: out ? JSON.parse(out) : null };
}

describe('MCP server', () => {
  const server = createMcpServer({ tools: LLM_TOOLS });
  it('initialize: tools capability, the client\'s protocol version', async () => {
    const r = await exchange(server, { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.result.capabilities, { tools: {} });
    assert.strictEqual(r.json.result.protocolVersion, '2025-03-26');
  });
  it('a notification is acknowledged with 202 and no body', async () => {
    const r = await exchange(server, { body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.strictEqual(r.status, 202); assert.strictEqual(r.json, null);
  });
  it('tools/list: the music tools and leave_channel, without their run()', async () => {
    const r = await exchange(server, { body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    assert.deepStrictEqual(r.json.result.tools.map(t => t.name), ['play_music', 'skip_song', 'stop_music', 'leave_channel']);
    assert.ok(r.json.result.tools.every(t => t.description && t.inputSchema && !t.run));
  });
  it('tools/call: the tool\'s answer for the model', async () => {
    const r = await exchange(server, { body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'play_music', arguments: { query: 'lo-fi beats' } } } });
    assert.strictEqual(r.json.result.isError, false);
    assert.match(r.json.result.content[0].text, /Queued "lo-fi beats"/);
  });
  it('a batch gets a batch of replies', async () => {
    const r = await exchange(server, { body: [{ jsonrpc: '2.0', id: 4, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 5, method: 'tools/list' }] });
    assert.deepStrictEqual(r.json.map(x => x.id), [4, 5]);
  });
  it('errors: unknown tool, unknown method, bad JSON, wrong path, GET', async () => {
    assert.strictEqual((await exchange(server, { body: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'launch_rockets' } } })).json.error.code, -32602);
    assert.strictEqual((await exchange(server, { body: { jsonrpc: '2.0', id: 7, method: 'resources/list' } })).json.error.code, -32601);
    assert.strictEqual((await exchange(server, { body: '{not json' })).status, 400);
    assert.strictEqual((await exchange(server, { url: '/other', body: {} })).status, 404);
    assert.strictEqual((await exchange(server, { method: 'GET' })).status, 405);
  });
  it('a tool that throws reports isError instead of failing the request', async () => {
    const s = createMcpServer({ tools: [{ name: 'boom', description: 'x', inputSchema: { type: 'object' }, run: () => { throw new Error('nope'); } }] });
    const r = await exchange(s, { body: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'boom' } } });
    assert.strictEqual(r.json.result.isError, true); assert.match(r.json.result.content[0].text, /nope/);
  });
});

describe('music tools → smakbot commands', () => {
  it('play_music → !play <query>, summoning smakbot; skip/stop → !skip / !stop', () => {
    assert.deepStrictEqual(smakbotCommandFor('play_music', { query: ' Bohemian Rhapsody ' }), { text: '!play Bohemian Rhapsody', summon: true });
    assert.deepStrictEqual(smakbotCommandFor('skip_song'), { text: '!skip', summon: false });
    assert.deepStrictEqual(smakbotCommandFor('stop_music', {}), { text: '!stop', summon: false });
  });
  it('nothing for an empty query or another tool', () => {
    assert.strictEqual(smakbotCommandFor('play_music', { query: '  ' }), null);
    assert.strictEqual(smakbotCommandFor('tavily_search', { query: 'x' }), null);
    assert.ok(!MUSIC_TOOL_NAMES.has('tavily_search'));
  });
});
