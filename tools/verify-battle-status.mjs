import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { decodeLz } from './text-codec.mjs';
import { verifyGlyphExtension } from './chinese-font.mjs';

const [runner, core, candidate, baseline, fixture, output, ...options] = process.argv.slice(2);
assert.ok(output, 'Usage: node tools/verify-battle-status.mjs RUNNER CORE CANDIDATE BASELINE CAVE_STATE NEW_OUTPUT [--remaining-status-bits]');
assert.ok(options.length === 0 || (options.length === 1 && options[0] === '--remaining-status-bits'), 'Unknown battle verification option');
const remainingStatusBits = options.includes('--remaining-status-bits');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = filename => JSON.parse(fs.readFileSync(filename));
const metadata = readJson(path.join(candidate, 'build.json'));
const previous = readJson(path.join(baseline, 'build.json'));
const rom = fs.readFileSync(path.join(candidate, metadata.romFilename));
const oldRom = fs.readFileSync(path.join(baseline, previous.romFilename));
assert.equal(digest(rom), metadata.targetSha256);
assert.equal(digest(oldRom), previous.targetSha256);
const font = metadata.battleStatusFont;
assert.ok(font?.hp && font.labels.length === 5);
const source = fs.readFileSync('assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc');
assert.equal(digest(source), metadata.sourceSha256);
const expected = decodeLz(source.subarray(font.sourceStart), font.decodedBytes).bytes;
for (const label of [font.hp, ...font.labels]) {
  const offset = label.tile * 32;
  assert.equal(expected.subarray(offset, offset + label.tiles * 32).toString('hex'), label.originalHex);
  const bytes = Buffer.from(label.hex, 'hex');
  assert.equal(bytes.length, label.tiles * 32);
  bytes.copy(expected, offset);
}
assert.deepEqual(decodeLz(rom.subarray(font.target), font.decodedBytes).bytes, expected);
assert.equal(rom.readUIntLE(0x3004c, 3), 0xc00000 + font.target);
const sourceState = fs.readFileSync(fixture);
const stateHash = digest(sourceState);
const ramOffset = sourceState.indexOf('RAM:131072:') + 11;
const vramOffset = sourceState.indexOf('VRA:065536:') + 11;
assert.ok(ramOffset > 11 && vramOffset > 11);
assert.ok(!fs.existsSync(output), 'Output must not already exist');
fs.mkdirSync(output);
let comparisonFilename = path.join(baseline, previous.romFilename);
let comparisonSha256 = previous.targetSha256;
const matchedDialogueBaseline = metadata.glyphAlignment === 'baseline';
if (matchedDialogueBaseline) {
  verifyGlyphExtension(metadata.glyphs, previous.glyphs);
  const comparison = Buffer.from(oldRom);
  for (const glyph of metadata.glyphs) rom.copy(comparison, glyph.offset, glyph.offset, glyph.offset + 46);
  comparison.writeUInt16LE(65535, 0xffdc);
  comparison.writeUInt16LE(0, 0xffde);
  const checksum = comparison.reduce((total, byte) => (total + byte) & 65535, 0);
  comparison.writeUInt16LE(checksum ^ 65535, 0xffdc);
  comparison.writeUInt16LE(checksum, 0xffde);
  const restored = Buffer.from(comparison);
  for (const glyph of metadata.glyphs) oldRom.copy(restored, glyph.offset, glyph.offset, glyph.offset + 46);
  oldRom.copy(restored, 0xffdc, 0xffdc, 0xffe0);
  assert.deepEqual(restored, oldRom, 'Non-dialogue data changed in battle control');
  comparisonFilename = path.join(output, 'baseline-matched-dialogue.sfc');
  fs.writeFileSync(comparisonFilename, comparison, { flag: 'wx' });
  comparisonSha256 = digest(comparison);
}

function image(filename) {
  const bytes = fs.readFileSync(filename);
  const header = /^P6\n(\d+) (\d+)\n255\n/.exec(bytes.subarray(0, 64).toString('ascii'));
  assert.ok(header);
  return { width: Number(header[1]), height: Number(header[2]), pixels: bytes.subarray(header[0].length) };
}

function maskFor(label) {
  const vertical = label.layout === 'vertical';
  const width = vertical ? 8 : label.tiles * 8;
  const height = vertical ? 16 : 8;
  const bytes = Buffer.from(label.hex, 'hex');
  const foreground = label.foreground ?? 3;
  const mask = [];
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const tile = vertical ? Math.floor(row / 8) : Math.floor(column / 8);
    let value = 0;
    for (let plane = 0; plane < 4; plane++) value |= ((bytes[tile * 32 + (plane >> 1) * 16 + (row % 8) * 2 + (plane & 1)] >> (7 - column % 8)) & 1) << plane;
    mask.push(value === foreground ? 1 : foreground === 2 && value !== 14 ? -1 : 0);
  }
  assert.ok(mask.filter(value => value === 1).length >= 12);
  return { width, height, mask };
}

function locate(frame, pattern, minimumRow = 176) {
  const { width, height, mask } = pattern;
  const first = mask.indexOf(1);
  for (let top = minimumRow; top <= frame.height - height; top++) for (let left = 48; left <= 200 - width; left++) {
    const firstOffset = ((top + Math.floor(first / width)) * frame.width + left + first % width) * 3;
    const colour = frame.pixels.readUIntBE(firstOffset, 3);
    if (mask.every((value, index) => value < 0 || (frame.pixels.readUIntBE(((top + Math.floor(index / width)) * frame.width + left + index % width) * 3, 3) === colour) === Boolean(value))) return { x: left, y: top, colour };
  }
  return null;
}

function run(directory, build, name, frames, inputs, state) {
  const destination = path.join(output, name);
  const filename = directory === baseline ? comparisonFilename : path.join(directory, build.romFilename);
  const result = spawnSync(runner, [core, filename, destination, String(frames), inputs, state],
    { encoding: 'utf8', timeout: 120000, env: { ...process.env, MOMOTARO_CHEATS: '', MOMOTARO_CAPTURE_EVERY: '120' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return destination;
}

const inputs = Array.from({ length: 16 }, (_, index) => `${60 + index * 210}:180:${['right', 'down', 'left', 'up'][index % 4]}`).join(',');
const cases = remainingStatusBits ? [
  { name: 'status-bit-02', status: 0x02, labels: [] },
  { name: 'status-bit-04', status: 0x04, labels: [] },
  { name: 'status-bit-08', status: 0x08, labels: [] },
  { name: 'status-bit-40', status: 0x40, labels: [] },
] : [
  { name: 'normal', status: 0, labels: [] },
  { name: 'poison', status: 1, labels: ['中毒'] },
  { name: 'curse', status: 0x10, labels: ['詛咒'] },
  { name: 'paralysis', status: 0x20, labels: ['麻痺'] },
  { name: 'combined', status: 0x31, labels: ['麻痺', '中毒', '詛咒'] },
  { name: 'injury', status: 0x80, labels: [] },
  { name: 'excellent', status: 0, excellent: 1, labels: ['絕好調'] },
  { name: 'invincible', status: 0, invincible: 255, labels: ['無敵'] },
];
const results = [];
const previews = [];
for (const entry of cases) {
  const runs = [];
  for (const [version, directory, build, bytes] of [['baseline', baseline, previous, oldRom], ['candidate', candidate, metadata, rom]]) {
    const state = Buffer.from(sourceState);
    state[ramOffset + 0x180a] = entry.status;
    state[ramOffset + 0x1834] = entry.excellent ?? 0;
    if (entry.invincible) state[ramOffset + 0x1d60] = entry.invincible;
    const compact = build.compactHpFont;
    decodeLz(bytes.subarray(compact.target), compact.decodedBytes).bytes.copy(state, vramOffset + 0x8900);
    const stateFile = path.join(output, `${entry.name}-${version}.bin`);
    fs.writeFileSync(stateFile, state, { flag: 'wx' });
    runs.push(run(directory, build, `${entry.name}-${version}`, 3600, inputs, stateFile));
  }
  const orderingKeyDifferences = [];
  const observedStatusSamples = [];
  for (let frame = 120; frame <= 3600; frame += 120) {
    const oldRam = fs.readFileSync(path.join(runs[0], `wram-${frame}.bin`));
    const newRam = fs.readFileSync(path.join(runs[1], `wram-${frame}.bin`));
    observedStatusSamples.push({ frame, baseline: oldRam[0x180a], candidate: newRam[0x180a] });
    if (remainingStatusBits) {
      assert.equal(oldRam[0x180a], entry.status, `${entry.name}: baseline status bit did not persist at ${frame}`);
      assert.equal(newRam[0x180a], entry.status, `${entry.name}: candidate status bit did not persist at ${frame}`);
    }
    if (oldRam[0x1d06] !== newRam[0x1d06]) {
      assert.ok(entry.status & 0x20, 'Unexpected ordering difference without paralysis');
      orderingKeyDifferences.push({ frame, address: '7E1D06', baseline: oldRam[0x1d06], candidate: newRam[0x1d06] });
      newRam[0x1d06] = oldRam[0x1d06];
    }
    assert.deepEqual(newRam.subarray(0x1500, 0x2000), oldRam.subarray(0x1500, 0x2000), `${entry.name}: battle state changed at ${frame}`);
  }
  const vram = fs.readFileSync(path.join(runs[1], 'vram-3600.bin'));
  assert.deepEqual(vram.subarray(font.vramOffset, font.vramOffset + expected.length), expected, `${entry.name}: native battle font differs`);
  const frame = image(path.join(runs[1], 'frame-3600.ppm'));
  const oldFrame = image(path.join(runs[0], 'frame-3600.ppm'));
  const comparedPixels = Buffer.from(frame.pixels.subarray(0, 176 * frame.width * 3));
  if (entry.invincible) for (let row = 64; row < 72; row++) {
    const offset = (row * frame.width + 120) * 3;
    oldFrame.pixels.copy(comparedPixels, offset, offset, offset + 8 * 3);
  }
  assert.deepEqual(comparedPixels, oldFrame.pixels.subarray(0, comparedPixels.length), `${entry.name}: battle image outside HUD changed`);
  const found = {};
  for (const label of [font.hp, ...font.labels.filter(label => entry.labels.includes(label.label))]) {
    const pattern = maskFor(label);
    found[label.label] = locate(frame, pattern);
    assert.ok(found[label.label], `${entry.name}: ${label.label} pixels not found`);
    assert.equal(locate(oldFrame, pattern), null, `${entry.name}: old ROM also matched ${label.label}`);
  }
  previews.push(path.join(runs[1], 'frame-3600.ppm'));
  results.push({ ...entry, comparedGameplaySamples: 30, observedStatusSamples, orderingKeyDifferences, otherGameplayBytesUnchanged: true,
    ...(entry.invincible ? { ignoredBlinkingDialogueCursor: { x: 120, y: 64, width: 8, height: 8 } } : {}),
    exactNativeBattleFont: true, pixels: found, oldGlyphNegativeControlsPassed: true });
  console.log(`PASS ${entry.name}`);
}
const montage = spawnSync('magick', ['montage', '-font', '/System/Library/Fonts/Helvetica.ttc',
  ...previews.flatMap((filename, index) => ['-label', cases[index].name, filename]),
  '-tile', '3x', '-geometry', '+8+8', path.join(output, 'battle-statuses.png')], { encoding: 'utf8' });
assert.equal(montage.status, 0, montage.stderr);
assert.equal(digest(fs.readFileSync(fixture)), stateHash);
assert.equal(digest(fs.readFileSync(path.join(candidate, metadata.romFilename))), metadata.targetSha256);
assert.equal(digest(fs.readFileSync(path.join(baseline, previous.romFilename))), previous.targetSha256);
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ status: 'locally-verified-not-deployed', targetSha256: metadata.targetSha256,
  baselineSha256: previous.targetSha256, fixture, fixtureSha256: stateHash, syntheticConditions: true,
  scope: remainingStatusBits ? 'remaining-single-status-bits' : 'standard-battle-status-graphics',
  matchedDialogueBaseline, comparisonSha256,
  legacyCompactVramRestored: true, sourceFixturesAndRomsUnchanged: true, unrelatedBattleFontBytesUnchanged: true,
  results, notVerified: ['Full natural playthrough', 'Every transient battle condition', 'Semantic identity or natural acquisition of unexplained status bits', 'Identical battle ordering timing', 'Physical device'] }, null, 2), { flag: 'wx' });
console.log('PASS native battle status graphics; ordering differences recorded separately');