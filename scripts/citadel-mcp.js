#!/usr/bin/env node
/**
 * Citadel MCP bridge — exposes the task mesh to any MCP-capable agent.
 *
 * Dependency-free: it speaks JSON-RPC 2.0 over newline-delimited JSON on
 * stdio, which is the MCP stdio transport. Point your client at it with:
 *
 *   CITADEL_URL=https://panel.example.com \
 *   CITADEL_TOKEN=<session id> \
 *   node scripts/citadel-mcp.js
 *
 * Tools: citadel_nodes, citadel_node_load, citadel_enqueue_task,
 *        citadel_tasks, citadel_task.
 * The logic lives in the HTTP API; this is only a thin facade.
 */
const APP_VERSION = require('../package.json').version;

const BASE = (process.env.CITADEL_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const TOKEN = process.env.CITADEL_TOKEN || '';
const DEFAULT_PROTOCOL = '2024-11-05';

const TOOLS = [
  {
    name: 'citadel_nodes',
    description: 'List worker nodes in the mesh with their load, capacity and last-seen time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'citadel_node_load',
    description: 'Get the current load/capacity of one node, to decide where to place work.',
    inputSchema: {
      type: 'object',
      properties: { node: { type: 'string', description: 'Node id (hostname) reported by the sentinel.' } },
      required: ['node'],
      additionalProperties: false,
    },
  },
  {
    name: 'citadel_enqueue_task',
    description: 'Enqueue a command to be run by a node sentinel. Leave "node" empty to let any free node pull it (load-balanced).',
    inputSchema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Executable to run (no shell). Use cmd="bash" with args=["-lc","..."] for shell.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed to cmd.' },
        projectPath: { type: 'string', description: 'Working directory on the executing node.' },
        priority: { type: 'integer', description: 'Higher runs first (default 0).' },
        node: { type: 'string', description: 'Pin the task to one node; omit for any node.' },
      },
      required: ['cmd'],
      additionalProperties: false,
    },
  },
  {
    name: 'citadel_tasks',
    description: 'List tasks, optionally filtered by status (queued|running|done|failed) or node.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        node: { type: 'string' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'citadel_task',
    description: 'Get one task by id, including status, exit code and result reference (progress check).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Citadel-MCP',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'citadel_nodes':
      return api('/api/nodes');
    case 'citadel_node_load': {
      const { nodes } = await api('/api/nodes');
      const found = (nodes || []).filter((n) => n.id === args.node);
      if (found.length === 0) throw new Error(`Node "${args.node}" not found.`);
      return { nodes: found };
    }
    case 'citadel_enqueue_task':
      return api('/api/tasks', { method: 'POST', body: args });
    case 'citadel_tasks': {
      const qs = new URLSearchParams();
      for (const key of ['status', 'node', 'limit']) {
        if (args[key] !== undefined) qs.set(key, String(args[key]));
      }
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return api(`/api/tasks${suffix}`);
    }
    case 'citadel_task':
      return api(`/api/tasks/${encodeURIComponent(args.id)}`);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMessage(msg) {
  const method = msg.method;
  const params = msg.params || {};

  if (method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion || DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'citadel-mcp', version: APP_VERSION },
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'resources/list') return { resources: [] };
  if (method === 'prompts/list') return { prompts: [] };
  if (method === 'tools/call') {
    try {
      const result = await callTool(params.name, params.arguments || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }

  const err = new Error(`Method not found: ${method}`);
  err.code = -32601;
  throw err;
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const isNotification = msg.id === undefined || msg.id === null;
  try {
    const result = await handleMessage(msg);
    if (!isNotification) send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (err) {
    if (!isNotification) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } });
    }
  }
}

function main() {
  if (!TOKEN) process.stderr.write('[citadel-mcp] warning: CITADEL_TOKEN is empty; requests will be rejected.\n');
  process.stderr.write(`[citadel-mcp] v${APP_VERSION} -> ${BASE}\n`);
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) handleLine(line);
    }
  });
}

if (require.main === module) main();

module.exports = { TOOLS, handleMessage, callTool };
