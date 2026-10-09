import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { nativeSaveContract } from './name-storage.mjs';
import { decodeGlyph } from './font-codec.mjs';
import { renderRecord } from './text-catalog.mjs';

const [runner, core, candidate, baseline, fixturePath, output] = process.argv.slice(2);
assert.ok(output, 'Usage: verify-name-entry-pixels.mjs RUNNER CORE CANDIDATE BASELINE FIELD_STATE NEW_OUTPUT');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = filename => JSON.parse(fs.readFileSync(filename));
const metadata = read(path.join(candidate, 'build.json'));
const previous = read(path.join(baseline, 'build.json'));
const target = fs.readFileSync(path.join(candidate, metadata.romFilename));
const before = fs.readFileSync(path.join(baseline, previous.romFilename));
const source = fs.readFileSync(new URL('../assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc', import.meta.url));
assert.equal(hash(target), metadata.targetSha256);
assert.equal(hash(before), previous.targetSha256);
assert.equal(hash(source), metadata.sourceSha256);
assert.ok(metadata.englishNameEntry);
const fixture = fs.readFileSync(fixturePath), fixtureHash = hash(fixture);
const contract = nativeSaveContract(source);
const modes = contract.modes.filter(mode => mode.persistent);
const modeLimit = Number(process.env.MOMOTARO_NAME_PIXEL_MODE_LIMIT ?? modes.length);
const keyLimit = Number(process.env.MOMOTARO_NAME_PIXEL_KEY_LIMIT ?? 36);
assert.ok(Number.isInteger(modeLimit) && modeLimit >= 1 && modeLimit <= 11);
assert.ok(Number.isInteger(keyLimit) && keyLimit >= 1 && keyLimit <= 36);
fs.mkdirSync(output);

function ramOffset(state) {
  const tag = Buffer.from('RAM:131072:');
  const offset = state.indexOf(tag);
  assert.ok(offset > 0 && state.indexOf(tag, offset + 1) === -1);
  return offset + tag.length;
}
function probe(bytes, name) {
  const rom = Buffer.alloc(0x400000, 255);
  bytes.copy(rom);
  if (bytes.length === 0x200000) rom[0xffd7] = 12;
  assert.equal(rom.subarray(0x1eee6, 0x1eeea).toString('hex'), '228ab385');
  assert.ok(rom.subarray(0x3ce400, 0x3ce600).every(byte => byte === 255));
  Buffer.from('5c00e4fc', 'hex').copy(rom, 0x1eee6);
  Buffer.from('228ab38522d4be83c220a900e58506e220a9bc85082280e4fc5c13ef81', 'hex').copy(rom, 0x3ce400);
  Buffer.from('8ba98448abf45ea05c218084', 'hex').copy(rom, 0x3ce480);
  Buffer.from('a074f4cba025c5cbb0', 'hex').copy(rom, 0x3ce500);
  rom.writeUInt16LE(65535, 0xffdc);
  rom.writeUInt16LE(0, 0xffde);
  const checksum = rom.reduce((sum, byte) => (sum + byte) & 65535, 0);
  rom.writeUInt16LE(checksum ^ 65535, 0xffdc);
  rom.writeUInt16LE(checksum, 0xffde);
  const filename = path.join(output, `${name}.sfc`);
  fs.writeFileSync(filename, rom, { flag: 'wx' });
  return filename;
}
const probes = { baseline: probe(before, 'baseline'), candidate: probe(target, 'candidate'), original: probe(source, 'original') };
function run(version, name, state, frames, inputs = '30:3:a') {
  const directory = path.join(output, name), statePath = `${directory}.state`;
  fs.writeFileSync(statePath, state, { flag: 'wx' });
  const env = { ...process.env, MOMOTARO_CHEATS: '', MOMOTARO_TRACE: '', MOMOTARO_CAPTURE_EVERY: String(frames) };
  delete env.MOMOTARO_SRAM_FILE;
  const result = spawnSync(runner, [core, probes[version], directory, String(frames), inputs, statePath], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `${name}: ${result.stderr || result.error?.message}`);
  const frame = fs.readFileSync(path.join(directory, `frame-${frames}.ppm`));
  const header = Buffer.from('P6\n256 224\n255\n');
  assert.deepEqual(frame.subarray(0, header.length), header);
  assert.equal(frame.length, header.length + 256 * 224 * 3);
  return { pixels: frame.subarray(header.length), state: fs.readFileSync(path.join(directory, 'state.bin')),
    ram: fs.readFileSync(path.join(directory, `wram-${frames}.bin`)), directory };
}
function field(pixels) {
  return Buffer.concat(Array.from({ length: 16 }, (_, row) => pixels.subarray(((row + 16) * 256 + 136) * 3, ((row + 16) * 256 + 200) * 3)));
}
function matches(pixels, glyph, left, top) {
  let ink = 0;
  for (let row = 0; row < 16; row++) for (let column = 0; column < 12; column++) {
    const value = glyph[row * 12 + column];
    if (!(value & 1)) continue;
    ink++;
    const offset = ((top + row) * 256 + left + column) * 3;
    const brightness = Math.max(...pixels.subarray(offset, offset + 3));
    if (value & 2 ? brightness < 140 : brightness > 110) return false;
  }
  assert.ok(ink > 0, 'Empty glyph cannot establish a visual match');
  return true;
}
function legacyInk(pixels, mode, bytes) {
  const rendered = renderRecord(source, Buffer.concat([Buffer.from([mode.katakana ? 4 : 3]), bytes]), []);
  const header = /^P5\n304 36\n255\n/.exec(rendered.toString('latin1', 0, 32));
  assert.ok(header);
  let ink = 0;
  for (let index = 0; index < 4; index++) for (let row = 0; row < 16; row++) for (let column = 0; column < 12; column++) {
    if (rendered[header[0].length + (row + 8) * 304 + 8 + index * 12 + column] !== 0) continue;
    const offset = ((16 + row) * 256 + 136 + index * 16 + column) * 3;
    assert.ok(Math.max(...pixels.subarray(offset, offset + 3)) >= 140, `Missing legacy glyph in mode ${mode.mode}, character ${index}`);
    ink++;
  }
  assert.ok(ink > 40);
  return ink;
}
const results = [], keyResults = [], cellResults = [], controls = [];
const legacyNames = [Buffer.from('909ad0e7', 'hex'), Buffer.from('94f0f8a0', 'hex')];
for (const mode of modes.slice(0, modeLimit)) {
  const samples = [];
  for (const [variant, name] of legacyNames.entries()) {
    const state = Buffer.from(fixture), offset = ramOffset(state);
    state[offset + 0x195c] = mode.mode;
    if (mode.katakana) state[offset + mode.legacyAddress] = 4;
    Buffer.concat([name, Buffer.from([0])]).copy(state, offset + mode.address);
    for (let slot = 0; slot < 32; slot++) {
      const actor = state[offset + 0x185e + slot];
      if (actor < 128) state[offset + 0x759 + actor] &= ~0x40;
    }
    const opened = Object.fromEntries(['baseline', 'candidate'].map(version => [version, run(version, `${mode.mode}-${variant}-${version}`, state, 600)]));
    assert.deepEqual(field(opened.candidate.pixels), field(opened.baseline.pixels), `Legacy pixels changed: mode ${mode.mode}`);
    const ink = legacyInk(opened.candidate.pixels, mode, name);
    assert.deepEqual(opened.candidate.ram.subarray(0x1989, 0x1989 + 85), Buffer.from(metadata.englishNameEntry.keyboardKeys), 'Native keyboard initialization differs');
    samples.push({ nameHex: name.toString('hex'), visibleInkPixels: ink, fieldSha256: hash(field(opened.candidate.pixels)) });
    if (variant !== 0) continue;
    for (const [cell, key] of [0, 25, 26, 35].entries()) {
      const selected = Buffer.from(opened.candidate.state), address = ramOffset(selected);
      selected[address + 0x1984] = key;
      selected[address + 0x1985] = cell;
      const typed = run('candidate', `${mode.mode}-cell-${cell}`, selected, 120);
      const byte = metadata.englishNameEntry.keyboardKeys[key];
      assert.equal(typed.ram[mode.address + cell], byte);
      assert.ok(matches(typed.pixels, decodeGlyph(source, 1, byte - 0x50), 136 + cell * 16, 16), `English glyph missing: mode ${mode.mode}, cell ${cell}`);
      cellResults.push({ mode: mode.mode, cell, key, byte, glyphPixelsMatched: true });
    }
    if (mode.mode === 1) {
      for (let key = 0; key < keyLimit; key++) {
        const selected = Buffer.from(opened.candidate.state), address = ramOffset(selected);
        selected[address + 0x1984] = key;
        const typed = run('candidate', `key-${key}`, selected, 120);
        const byte = metadata.englishNameEntry.keyboardKeys[key];
        assert.equal(typed.ram[mode.address], byte);
        assert.ok(matches(typed.pixels, decodeGlyph(source, 1, byte - 0x50), 136, 16), `English key ${key} has wrong glyph`);
        keyResults.push({ key, byte, glyphPixelsMatched: true });
      }
      const original = run('original', 'original-opened', state, 600);
      for (const [version, entry] of Object.entries({ ...opened, original })) {
        const typed = run(version, `${version}-persistence`, entry.state, 120);
        const glyph = decodeGlyph(source, version === 'candidate' ? 1 : 5, version === 'candidate' ? 0x11 : 0);
        const visibleBefore = matches(entry.pixels, glyph, 40, 56);
        const visibleAfter = matches(typed.pixels, glyph, 40, 56);
        assert.equal(visibleBefore, true, `${version}: keyboard not visible initially`);
        assert.equal(visibleAfter, false, `${version}: known fixture limitation changed; reassess coverage`);
        controls.push({ version, keyboardVisibleBefore: visibleBefore, keyboardVisibleAfter: visibleAfter });
      }
    }
  }
  assert.notEqual(samples[0].fieldSha256, samples[1].fieldSha256, 'Different legacy names must change pixels');
  results.push({ mode: mode.mode, katakana: mode.katakana, samples, baselinePixelsIdentical: true, differentNameNegativeControlPassed: true });
  console.log(`PASS mode ${mode.mode}: two legacy names and four English glyph positions`);
}
assert.equal(hash(fs.readFileSync(fixturePath)), fixtureHash);
const report = { targetSha256: metadata.targetSha256, baselineSha256: previous.targetSha256, sourceSha256: hash(source),
  runnerSha256: hash(fs.readFileSync(runner)), coreSha256: hash(fs.readFileSync(core)), fixtureSha256: fixtureHash,
  originalFixtureUnchanged: true, synthetic: true, nativeKeyboardInitializationWithoutKeyMapSeeding: true,
  legacyModes: results, englishKeys: keyResults, englishCells: cellResults, keyboardPersistenceControls: controls,
  naturalNameScreenVerified: false, keyboardPersistenceVerified: false, deviceWrites: false,
  limitations: ['A copied field fixture enters original scene clearing and common naming events through a test-only ROM hook; this is not natural NPC navigation.',
    'Legacy names, mode, selected key and cursor position are seeded; the keyboard map is initialized by native code.',
    'Residual scene sprites and disappearing keyboard after input occur with the Japanese original, v65 and candidate; this fixture does not prove a usable natural naming screen.',
    'Only input-field glyphs and initialized keyboard bytes are verified; this is not a natural-layout or release gate.'] };
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });