import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const [runner, core, romPath, statePath, output] = process.argv.slice(2);
assert.ok(runner && core && romPath && statePath && output,
  'Usage: node tools/verify-mankin-cheat.mjs RUNNER CORE ROM NATURAL_STATE239 NEW_OUTPUT');
const hash = data => createHash('sha256').update(data).digest('hex');
const rom = fs.readFileSync(romPath);
const raw = fs.readFileSync(statePath);
let state = raw;
if (raw.subarray(0, 8).toString('hex') === '23525a4950760123') {
  const chunks = [];
  for (let offset = 20; offset < raw.length;) {
    const length = raw.readUInt32LE(offset);
    offset += 4;
    assert.ok(length > 0 && offset + length <= raw.length);
    chunks.push(inflateSync(raw.subarray(offset, offset + length)));
    offset += length;
  }
  const container = Buffer.concat(chunks);
  assert.equal(container.length, Number(raw.readBigUInt64LE(12)));
  assert.equal(container.subarray(0, 7).toString(), 'RASTATE');
  state = container.subarray(16, 16 + container.readUInt32LE(12));
}
assert.equal(state.subarray(0, 9).toString(), '#!s9xsnp:');
const marker = Buffer.from('RAM:131072:');
const markerOffset = state.indexOf(marker);
assert.ok(markerOffset >= 0);
const ramStart = markerOffset + marker.length;
assert.equal(state.indexOf(marker, ramStart), -1);
const initial = state.subarray(ramStart, ramStart + 131072);
assert.equal(initial.length, 131072);
assert.equal(initial[0x19d6], 244);
assert.equal(initial[0x637e], 1, 'Requires the original natural slot-239 fixture');
const cheatText = fs.readFileSync(new URL('../cheats/Shin Momotarou Densetsu (Traditional Chinese).cht', import.meta.url), 'utf8');
const code = JSON.parse(cheatText.match(/^cheat16_code = (.+)$/m)[1]);
assert.equal(rom.subarray(0x2d037, 0x2d03a).toString('hex'), '2064d0');
assert.equal(rom.subarray(0x292c2, 0x292c9).toString('hex'), 'c9f4d003eeb819');
assert.ok(rom.subarray(0x2fe60, 0x2fe75).every(byte => byte === 255));
assert.ok(code.length <= 255);
assert.ok(!fs.existsSync(output), 'Output must not exist');
fs.mkdirSync(output, { recursive: true });
const fixture = path.join(output, 'natural-input.state');
fs.writeFileSync(fixture, state, { flag: 'wx' });
const frames = 6000;
const buttons = ['2140:3:down', ...Array.from({ length: 34 }, (_, index) => `${30 + index * 180}:3:a`)].join(',');
const health = ram => ({ current: ram[0x16a1] + 256 * ram[0x16b6], maximum: ram[0x1677] + 256 * ram[0x168c] });
const runs = [];
for (const enabled of [false, true]) {
  const directory = path.join(output, enabled ? 'enabled' : 'baseline');
  const env = { ...process.env, MOMOTARO_CHEATS: enabled ? code : '', MOMOTARO_TRACE: '', MOMOTARO_CAPTURE_EVERY: '120' };
  delete env.MOMOTARO_SRAM_FILE;
  const result = spawnSync(runner, [core, romPath, directory, String(frames), buttons, fixture], {
    env, encoding: 'utf8', timeout: 180000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const ram = fs.readFileSync(path.join(directory, `wram-${frames}.bin`));
  if (enabled) assert.equal(health(ram).current, health(ram).maximum);
  else {
    const firstRecovery = fs.readFileSync(path.join(directory, 'wram-3480.bin'));
    assert.equal(firstRecovery[0x1a35] + 256 * firstRecovery[0x1a45], 41);
  }
  const awardFrame = path.join(directory, 'frame-4800.ppm');
  const awardFrameSha256 = hash(fs.readFileSync(awardFrame));
  const reviewedAward = '14b283b511bc8a0e057472ccd512327c754d2101cae7e41d1b325706946c33c4';
  if (enabled) assert.equal(awardFrameSha256, reviewedAward, 'Must reproduce the visually reviewed Mankin learned message');
  else assert.notEqual(awardFrameSha256, reviewedAward);
  runs.push({ enabled, frames, directory, health: health(ram), awardFrame, awardFrameSha256 });
  console.log(`PASS natural training ${enabled ? 'enabled: learned Mankin' : 'control: not completed'}`);
}
assert.equal(hash(fs.readFileSync(romPath)), hash(rom));
assert.equal(hash(fs.readFileSync(statePath)), hash(raw));
assert.equal(hash(fs.readFileSync(fixture)), hash(state));
const report = {
  status: 'natural-recovery-training-and-spell-award-verified', code,
  romPath, romSha256: hash(rom), statePath, stateSha256: hash(raw),
  coreSha256: hash(fs.readFileSync(core)), runnerSha256: hash(fs.readFileSync(runner)),
  inputs: buttons, runs, sourceStateUnmodified: true, syntheticRamWrites: false,
  originalRomAndStateUnchanged: true, deviceFilesWritten: false,
  naturalTrainingCompletionVerified: true, spellLearningVerified: true,
  limitations: ['Requires using a recovery action such as Kintan, not an attack',
    'Award-frame regression is specific to the natural slot-239 fixture, current ROM and core',
    'Physical device activation is not verified; restart the core to discard the obsolete damage patch'],
};
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(`PASS ${path.join(output, 'verification.json')}`);