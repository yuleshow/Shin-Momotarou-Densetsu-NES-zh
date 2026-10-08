import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { patchEnglishNameEntry } from './english-name-entry.mjs';
import { nameEntryContract } from './verify-name-entry.mjs';

const [runner, core, candidate, fixtures, output] = process.argv.slice(2);
assert.ok(output, 'Usage: verify-english-name-entry.mjs RUNNER CORE CANDIDATE NATIVE_NAME_FIXTURES NEW_OUTPUT');
const metadata = JSON.parse(fs.readFileSync(path.join(candidate, 'build.json')));
const baseline = fs.readFileSync(path.join(candidate, metadata.romFilename));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(digest(baseline), metadata.targetSha256);
const source = fs.readFileSync('assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc');
assert.equal(digest(source), metadata.sourceSha256);
const target = Buffer.from(baseline);
const keyboard = patchEnglishNameEntry(source, target);
target.writeUInt16LE(65535, 0xffdc);
target.writeUInt16LE(0, 0xffde);
const checksum = target.reduce((sum, byte) => (sum + byte) & 65535, 0);
target.writeUInt16LE(checksum ^ 65535, 0xffdc);
target.writeUInt16LE(checksum, 0xffde);
fs.mkdirSync(output);
const rom = path.join(output, 'english-input-probe.sfc');
fs.writeFileSync(rom, target, { flag: 'wx' });
const run = (name, state, frames, inputs) => {
  const stateFile = path.join(output, `${name}.state`);
  fs.writeFileSync(stateFile, state, { flag: 'wx' });
  const directory = path.join(output, name);
  const env = { ...process.env, MOMOTARO_CHEATS: '', MOMOTARO_TRACE: '', MOMOTARO_CAPTURE_EVERY: '60' };
  delete env.MOMOTARO_SRAM_FILE;
  const result = spawnSync(runner, [core, rom, directory, String(frames), inputs, stateFile], { encoding: 'utf8', env, timeout: 120000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return { directory, ram: fs.readFileSync(path.join(directory, `wram-${frames}.bin`)), state: fs.readFileSync(path.join(directory, 'state.bin')) };
};
const ranges = [[0x3d2a, 0x3d69], [0x5f4a, 0x5f50]];
const modes = [];
const alphanumericKeys = [];
for (const mode of nameEntryContract(source)) {
  const fixturePath = path.join(fixtures, `mode-${mode.mode}`, 'opened/state.bin');
  const original = fs.readFileSync(fixturePath);
  const state = Buffer.from(original);
  const ramStart = state.indexOf('RAM:131072:') + 11;
  assert.ok(ramStart > 11);
  assert.equal(state[ramStart + 0x195c], mode.mode);
  assert.equal(state[ramStart + 0x1985], 0);
  Buffer.from(keyboard.keyboardKeys).copy(state, ramStart + 0x1989);
  const openedRam = state.subarray(ramStart, ramStart + 131072);
  if (mode.mode === 1) {
    for (let key = 0; key < 36; key++) {
      const selected = Buffer.from(state);
      selected[ramStart + 0x1984] = key;
      const typedKey = run(`key-${key}`, selected, 120, '30:3:a');
      assert.equal(typedKey.ram[mode.address], keyboard.keyboardKeys[key]);
      assert.equal(typedKey.ram[0x1985], 1);
      for (const [start, end] of ranges) for (let address = start; address < end; address++) {
        if (address !== mode.address) assert.equal(typedKey.ram[address], openedRam[address]);
      }
      alphanumericKeys.push({ key, byte: typedKey.ram[mode.address] });
    }
    console.log('PASS all 36 native English alphanumeric keys');
  }
  const typed = run(`mode-${mode.mode}-capacity`, state, 720,
    Array.from({ length: 10 }, (_, index) => `${30 + index * 60}:3:a`).join(','));
  for (let frame = 60; frame <= 720; frame += 60) {
    const ram = fs.readFileSync(path.join(typed.directory, `wram-${frame}.bin`));
    const written = Math.min(frame / 60, mode.capacity);
    assert.ok(ram.subarray(mode.address, mode.address + written).every(byte => byte === 0x61), `English A not stored in mode ${mode.mode}, frame ${frame}`);
    assert.equal(ram[0x1985], Math.min(frame / 60, mode.capacity - 1));
    for (const [start, end] of ranges) for (let address = start; address < end; address++) {
      if (address >= mode.address && address < mode.address + mode.capacity) continue;
      assert.equal(ram[address], openedRam[address], `Adjacent name modified in mode ${mode.mode}`);
    }
  }
  const backed = run(`mode-${mode.mode}-back`, typed.state, 120, '30:3:b');
  assert.equal(backed.ram[0x1985], mode.capacity - 2);
  for (const [start, end] of ranges) assert.deepEqual(backed.ram.subarray(start, end), typed.ram.subarray(start, end));
  const confirmation = Buffer.from(backed.state);
  const confirmRam = confirmation.indexOf('RAM:131072:') + 11;
  assert.ok(confirmRam > 11);
  confirmation[confirmRam + 0x1984] = 79;
  confirmation[confirmRam + mode.address] = 0;
  const confirmed = run(`mode-${mode.mode}-confirm`, confirmation, 180, '30:3:a');
  const expected = Buffer.from(typed.ram);
  expected[mode.address] = 0x50;
  for (const [start, end] of ranges) assert.deepEqual(confirmed.ram.subarray(start, end), expected.subarray(start, end));
  assert.equal(digest(fs.readFileSync(fixturePath)), digest(original));
  modes.push({ mode: mode.mode, capacity: mode.capacity, capacitySamples: 12, adjacentNamesPreserved: true, backPassed: true, confirmationPassed: true });
  console.log(`PASS English mode ${mode.mode}: capacity, adjacent names, back and confirmation`);
}
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ targetSha256: digest(target), baselineSha256: digest(baseline), modes, alphanumericKeys,
  keyboard, synthetic: true, naturalNameScreenVerified: false, oldNamePixelsVerified: false,
  quizAnswersImplemented: false, inGameSaveLoadVerified: false, deviceWrites: false,
  limitations: ['Existing editor fixtures are seeded with the ROM keyboard values to isolate input and redraw; entry initialization and natural navigation are not covered.',
    'These checks verify name bytes and surrounding name fields, not complete RAM equality, visible glyphs or in-game SRAM persistence.'] }, null, 2) + '\n', { flag: 'wx' });