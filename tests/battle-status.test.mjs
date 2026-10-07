import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const filename = new URL('../tools/verify-battle-status.mjs', import.meta.url);
const source = fs.readFileSync(filename, 'utf8');
const start = source.indexOf('const cases = ');
const end = source.indexOf('const results = [];', start);
assert.ok(start >= 0 && end > start);
const casesFor = remainingStatusBits => JSON.parse(JSON.stringify(runInNewContext(
  `${source.slice(start, end)}; cases`, { remainingStatusBits })));

test('remaining single-bit probes are opt-in and complement the original status masks', () => {
  const standard = casesFor(false);
  assert.deepEqual(standard.map(entry => entry.name), [
    'normal', 'poison', 'curse', 'paralysis', 'combined', 'injury', 'excellent', 'invincible',
  ]);
  assert.deepEqual(standard.map(entry => entry.status), [0, 1, 0x10, 0x20, 0x31, 0x80, 0, 0]);
  const remaining = casesFor(true);
  assert.deepEqual(remaining.map(entry => entry.status), [2, 4, 8, 0x40]);
  assert.ok(remaining.every(entry => entry.labels.length === 0 && !entry.excellent && !entry.invincible));
  assert.equal([...standard, ...remaining].reduce((mask, entry) => mask | entry.status, 0), 0xff);
});

test('battle verifier rejects unknown or duplicated options before accessing input files', () => {
  for (const options of [['--unknown'], ['--remaining-status-bits', '--remaining-status-bits']]) {
    const result = spawnSync(process.execPath, [filename.pathname,
      'missing-runner', 'missing-core', 'missing-candidate', 'missing-baseline', 'missing-fixture', 'missing-output', ...options],
    { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown battle verification option/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
});

test('remaining-bit persistence guard rejects cleared or substituted status values', () => {
  const guardStart = source.indexOf('    if (remainingStatusBits) {', source.indexOf('const observedStatusSamples'));
  const guardEnd = source.indexOf('\n    if (oldRam[0x1d06]', guardStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart);
  const check = (baselineStatus, candidateStatus) => {
    const oldRam = Buffer.alloc(0x2000);
    const newRam = Buffer.alloc(0x2000);
    oldRam[0x180a] = baselineStatus;
    newRam[0x180a] = candidateStatus;
    runInNewContext(source.slice(guardStart, guardEnd), {
      assert, remainingStatusBits: true, oldRam, newRam, frame: 120, entry: { name: 'status-bit-02', status: 2 },
    });
  };
  assert.doesNotThrow(() => check(2, 2));
  assert.throws(() => check(0, 2), /baseline status bit did not persist/);
  assert.throws(() => check(2, 0), /candidate status bit did not persist/);
  assert.throws(() => check(4, 4), /baseline status bit did not persist/);
});