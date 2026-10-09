import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { patchChineseNameDefaults, defaultNameToken } from './default-name-entry.mjs';
import { nativeSaveContract, encodeEnglishName } from './name-storage.mjs';

const [runner, core, candidate, fixturePath, output, naturalFixturePath] = process.argv.slice(2);
assert.ok(output, 'Usage: verify-default-name-entry.mjs RUNNER CORE BASE_CANDIDATE FIELD_STATE NEW_OUTPUT [NATURAL_OWN_NAME_STATE]');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = JSON.parse(fs.readFileSync(path.join(candidate, 'build.json')));
const original = fs.readFileSync(path.join(candidate, metadata.romFilename));
assert.equal(hash(original), metadata.targetSha256);
const source = fs.readFileSync(new URL('../assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc', import.meta.url));
assert.equal(hash(source), metadata.sourceSha256);
const target = Buffer.from(original);
const english = structuredClone(metadata.englishNameEntry);
assert.ok(Array.isArray(metadata.glyphs));
const characters = metadata.glyphs.map(glyph => glyph.character);
const defaults = english.chineseDefaults ?? patchChineseNameDefaults(source, target, characters, english);
const fixture = fs.readFileSync(fixturePath);
const fixtureHash = hash(fixture);
const { modes } = nativeSaveContract(source);
fs.mkdirSync(output);
const checksum = bytes => {
  bytes.writeUInt16LE(65535, 0xffdc);
  bytes.writeUInt16LE(0, 0xffde);
  const value = bytes.reduce((sum, byte) => (sum + byte) & 65535, 0);
  bytes.writeUInt16LE(value ^ 65535, 0xffdc);
  bytes.writeUInt16LE(value, 0xffde);
};
checksum(target);
fs.writeFileSync(path.join(output, 'candidate.sfc'), target, { flag: 'wx' });
fs.writeFileSync(path.join(output, 'build.json'), JSON.stringify({ ...metadata,
  status: 'experimental-chinese-name-defaults-not-release-verified', romFilename: 'candidate.sfc',
  targetSha256: hash(target), englishNameEntry: { ...english, chineseDefaults: defaults },
  derivedFromSha256: metadata.targetSha256 }, null, 2));
const probe = Buffer.from(target);
assert.equal(probe.subarray(0x1eee6, 0x1eeea).toString('hex'), '228ab385');
assert.ok(probe.subarray(0x3ce400, 0x3ce600).every(byte => byte === 255));
Buffer.from('5c00e4fc', 'hex').copy(probe, 0x1eee6);
Buffer.from('228ab38522d4be83c220a900e58506e220a9bc85082280e4fc5c13ef81', 'hex').copy(probe, 0x3ce400);
Buffer.from('8ba98448abf45ea05c218084', 'hex').copy(probe, 0x3ce480);
Buffer.from('a074f4cba025c5cbb0', 'hex').copy(probe, 0x3ce500);
checksum(probe);
const probePath = path.join(output, 'probe.sfc');
fs.writeFileSync(probePath, probe, { flag: 'wx' });
function ramOffset(state) {
  const tag = Buffer.from('RAM:131072:');
  const offset = state.indexOf(tag);
  assert.ok(offset > 0 && state.indexOf(tag, offset + 1) === -1);
  return offset + tag.length;
}
function run(name, state, frames = 600, inputs = '30:3:a', romPath = probePath) {
  const directory = path.join(output, name);
  const statePath = `${directory}.state`;
  fs.writeFileSync(statePath, state, { flag: 'wx' });
  const env = { ...process.env, MOMOTARO_CHEATS: '', MOMOTARO_TRACE: '', MOMOTARO_CAPTURE_EVERY: String(frames) };
  delete env.MOMOTARO_SRAM_FILE;
  const result = spawnSync(runner, [core, romPath, directory, String(frames), inputs, statePath], { encoding: 'utf8', env, timeout: 120000 });
  assert.equal(result.status, 0, `${name}: ${result.error?.message || result.stderr}`);
  assert.ok(!/deadlocked/i.test(result.stdout + result.stderr), `${name}: CPU deadlock`);
  const ppm = fs.readFileSync(path.join(directory, `frame-${frames}.ppm`));
  const header = Buffer.from('P6\n256 224\n255\n');
  assert.deepEqual(ppm.subarray(0, header.length), header);
  return { ram: fs.readFileSync(path.join(directory, `wram-${frames}.bin`)),
    state: fs.readFileSync(path.join(directory, 'state.bin')), pixels: ppm.subarray(header.length) };
}
function select(state, key, cursor = 0) {
  const selected = Buffer.from(state), offset = ramOffset(selected);
  selected[offset + 0x1984] = key;
  selected[offset + 0x1985] = cursor;
  return selected;
}
function checkLabel(pixels, label) {
  for (const [cell, character] of [...label].entries()) {
    const glyph = metadata.glyphs.find(glyph => glyph.character === character);
    assert.ok(glyph, character);
    let ink = 0;
    for (let row = 0; row < 15; row++) for (let column = 0; column < 12; column++) {
      const bit = plane => column < 8 ? (target[glyph.offset + plane * 23 + row] >> (7 - column)) & 1
        : (target[glyph.offset + plane * 23 + 15 + (row >> 1)] >> ((row % 2 ? 0 : 4) + 11 - column)) & 1;
      if (!bit(0)) continue;
      const offset = ((17 + row) * 256 + 136 + cell * 16 + column) * 3;
      const brightness = Math.max(...pixels.subarray(offset, offset + 3));
      assert.ok(bit(1) ? brightness >= 140 : brightness <= 110, `Preset glyph mismatch: ${label}/${character} at ${column},${row}`);
      if (bit(1)) ink++;
    }
    assert.ok(ink > 10, character);
  }
}
const cases = [];
for (const definition of defaults.definitions) {
  const mode = modes[definition.mode - 1];
  const state = Buffer.from(fixture), offset = ramOffset(state);
  state[offset + 0x195c] = mode.mode;
  state.fill(0, offset + mode.address, offset + mode.address + 5);
  for (let slot = 0; slot < 32; slot++) {
    const actor = state[offset + 0x185e + slot];
    if (actor < 128) state[offset + 0x759 + actor] &= ~0x40;
  }
  const checkStored = result => {
    assert.deepEqual(result.ram.subarray(mode.address, mode.address + 5), defaultNameToken(mode.mode));
    for (const other of modes.slice(0, 11).filter(other => other.mode !== mode.mode)) {
      assert.deepEqual(result.ram.subarray(other.legacyAddress, other.legacyAddress + other.legacyBytes), state.subarray(offset + other.legacyAddress, offset + other.legacyAddress + other.legacyBytes));
    }
  };
  const opened = run(`${mode.mode}-blank`, state);
  checkStored(opened); checkLabel(opened.pixels, definition.label);
  const legacyState = Buffer.from(state);
  const legacyOffset = 0x4adfc + mode.address - 0x3d2b;
  source.subarray(legacyOffset, legacyOffset + mode.capacity + 1).copy(legacyState, offset + mode.address);
  const legacy = run(`${mode.mode}-original-default`, legacyState);
  checkStored(legacy); checkLabel(legacy.pixels, definition.label);
  const confirmed = run(`${mode.mode}-confirm`, select(opened.state, 79), 180);
  checkStored(confirmed);
  const typed = run(`${mode.mode}-english`, select(opened.state, 25, 2), 120);
  assert.deepEqual(typed.ram.subarray(mode.address, mode.address + 5), Buffer.from('7a50505000', 'hex'));
  encodeEnglishName('AB12', mode).copy(state, offset + mode.address);
  const custom = run(`${mode.mode}-custom`, state);
  assert.deepEqual(custom.ram.subarray(mode.address, mode.address + 5), encodeEnglishName('AB12', mode));
  const preset = run(`${mode.mode}-preset`, select(custom.state, 36), 120);
  checkStored(preset); checkLabel(preset.pixels, definition.label);
  cases.push({ mode: mode.mode, label: definition.label, blankPrefilled: true, chinesePixelsMatched: true,
    originalDefaultReplaced: true, confirmationPreserved: true, customNamePreserved: true,
    typingReplacesWholePreset: true, presetButtonWorked: true });
  console.log(`PASS mode ${mode.mode}: ${definition.label}; prefill, pixels, confirm, custom, reset`);
}
let naturalOwnName;
if (naturalFixturePath) {
  const state = fs.readFileSync(naturalFixturePath), offset = ramOffset(state), stateHash = hash(state);
  assert.equal(state[offset + 0x195c], 11);
  assert.equal(state[offset + 0x1984], 4);
  const romPath = path.join(candidate, metadata.romFilename);
  assert.ok(english.chineseDefaults, 'Natural check requires a built default-name candidate');
  const preset = run('natural-own-preset', state, 240,
    '20:3:down,50:3:down,80:3:down,110:3:right,140:3:right,180:3:a', romPath);
  assert.deepEqual(preset.ram.subarray(0x3d64, 0x3d69), defaultNameToken(11));
  checkLabel(preset.pixels, defaults.definitions.find(entry => entry.mode === 11).label);
  const typed = run('natural-own-english', preset.state, 150, '20:3:up,50:3:left,80:3:a', romPath);
  assert.equal(typed.ram.subarray(0x3d64, 0x3d69).toString('hex'), '7a50505000');
  const restored = run('natural-own-restored', typed.state, 150, '20:3:down,50:3:right,80:3:a', romPath);
  assert.deepEqual(restored.ram.subarray(0x3d64, 0x3d69), defaultNameToken(11));
  checkLabel(restored.pixels, defaults.definitions.find(entry => entry.mode === 11).label);
  assert.equal(hash(fs.readFileSync(naturalFixturePath)), stateHash);
  naturalOwnName = { fixtureSha256: stateHash, unhookedRom: true, normalJoypadOnly: true,
    fixtureUnchanged: true, presetPixelsMatched: true, englishReplacementVerified: true, presetRestored: true };
  console.log('PASS natural own-name screen: preset pixels, English replacement, preset restore');
}
assert.equal(hash(fs.readFileSync(fixturePath)), fixtureHash);
assert.equal(hash(fs.readFileSync(path.join(candidate, metadata.romFilename))), metadata.targetSha256);
const report = { targetSha256: hash(target), baseSha256: metadata.targetSha256, fixtureSha256: fixtureHash,
  fixtureUnchanged: true, sourceCandidateUnchanged: true, synthetic: true, cases,
  naturalOwnName, naturalNpcFlowVerified: false, presetSaveLoadVerified: false, deviceWrites: false,
  limitations: ['Uses a copy of a field fixture and a test-only common-event hook; not natural NPC interaction.',
    'Selected keys and cursor are seeded; keyboard persistence and whole-dialogue display still require natural-context verification.',
    'Confirmation verifies live name bytes, not a native SRAM save and cold load of the new tokens.'] };
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));