const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { TOOLS, handleMessage } = require('../scripts/citadel-mcp');

describe('Citadel MCP bridge (protocol shape)', () => {
  test('initialize echoes the client protocol and advertises tools', async () => {
    const res = await handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x' } },
    });
    assert.equal(res.protocolVersion, '2024-11-05');
    assert.ok(res.capabilities.tools);
    assert.equal(res.serverInfo.name, 'citadel-mcp');
  });

  test('tools/list exposes the task-mesh tools with valid JSON schemas', async () => {
    const res = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = res.tools.map((t) => t.name);
    assert.deepEqual(names, [
      'citadel_nodes',
      'citadel_node_load',
      'citadel_enqueue_task',
      'citadel_tasks',
      'citadel_task',
      'citadel_cancel_task',
    ]);
    for (const tool of res.tools) {
      assert.equal(tool.inputSchema.type, 'object');
    }
    assert.equal(TOOLS.length, 6);
  });

  test('tools/call surfaces handler errors as isError content', async () => {
    const res = await handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'does_not_exist', arguments: {} },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /unknown tool/i);
  });

  test('unknown methods produce a JSON-RPC method-not-found error', async () => {
    await assert.rejects(
      () => handleMessage({ jsonrpc: '2.0', id: 4, method: 'nope' }),
      (err) => err.code === -32601
    );
  });
});
