// ─── Luna's own MCP server ────────────────────────────────────────────────────
//
// Tools the LLM can call to make Luna do something, not just say it — e.g.
// play music through smakbot. LM Studio connects to it like it connects to
// the web-search server: it is registered in LM Studio's mcp.json ("luna",
// http://127.0.0.1:<port>/mcp) and Luna offers it by name (mcp/luna). The
// model decides when to call a tool, LM Studio sends the call here, and the
// tool's text result goes back to the model.
//
// (LM Studio refuses per-request "ephemeral" MCP servers at private
// addresses, so the server has one fixed URL and cannot tell whose question
// a call belongs to. Each tool's run() therefore only answers the model; Luna
// carries the action out when she sees the call in that speaker's own answer
// stream — see index.js.)
//
// Just enough of MCP's Streamable HTTP transport for that: JSON-RPC over
// POST, answered with plain JSON (no server-sent events, no server-initiated
// messages). Methods: initialize, ping, tools/list, tools/call; notifications
// are acknowledged.
//
// createMcpServer({ tools }) → { handle(req, res) } for an http server.
// tools: [{ name, description, inputSchema, run(args) → text }].

const PROTOCOL_VERSION = '2025-06-18';

function createMcpServer({ tools, name = 'luna', version = '1.0.0' }) {
  const byName = new Map(tools.map(t => [t.name, t]));

  async function call(message) {
    const { id, method, params = {} } = message;
    const reply = result => ({ jsonrpc: '2.0', id, result });
    const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name, version },
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const tool = byName.get(params.name);
        if (!tool) return fail(-32602, `unknown tool ${params.name}`);
        try {
          const text = await tool.run(params.arguments || {});
          return reply({ content: [{ type: 'text', text: String(text) }], isError: false });
        } catch (err) {
          return reply({ content: [{ type: 'text', text: `Failed: ${err.message}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  }

  async function handle(req, res) {
    if (req.url.split('?')[0] !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1e6) { res.writeHead(413).end(); return; }
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    // Notifications and responses (no method, or no id) get no reply.
    const replies = (await Promise.all(messages.map(m => (m.method && m.id !== undefined ? call(m) : null))))
      .filter(Boolean);
    if (!replies.length) { res.writeHead(202).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
  }

  return { handle };
}

module.exports = { createMcpServer };
