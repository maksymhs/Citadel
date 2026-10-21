const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVmStat } = require('../server/services/memoryStats');

const SAMPLE = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                              928785.
Pages active:                           1315138.
Pages wired down:                        634374.
Pages purgeable:                         104660.
Anonymous pages:                        1152496.
Pages occupied by compressor:             1000.
`;

test('parseVmStat uses app memory + wired + compressed like Activity Monitor', () => {
  const { usedBytes } = parseVmStat(SAMPLE);
  assert.equal(usedBytes, (1152496 - 104660 + 634374 + 1000) * 4096);
});

test('parseVmStat returns null on unexpected output', () => {
  assert.equal(parseVmStat('nope'), null);
});
