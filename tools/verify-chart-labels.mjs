import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyGlyphExtension } from './chinese-font.mjs';

const [runner, core, candidate, baseline, fixture, output] = process.argv.slice(2);
assert.ok(output, 'Usage: verify-chart-labels.mjs RUNNER CORE CANDIDATE BASELINE CHART_MESSAGE_STATE NEW_OUTPUT');
const read = filename => JSON.parse(fs.readFileSync(filename));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = read(path.join(candidate, 'build.json'));
const previous = read(path.join(baseline, 'build.json'));
const target = fs.readFileSync(path.join(candidate, metadata.romFilename));
const original = fs.readFileSync(path.join(baseline, previous.romFilename));
const state = fs.readFileSync(fixture);
const stateHash = hash(state);
assert.equal(hash(target), metadata.targetSha256);
assert.equal(hash(original), previous.targetSha256);
verifyGlyphExtension(metadata.glyphs, previous.glyphs);
assert.equal(metadata.commandChart.cells.length, 44);
assert.equal(metadata.defaultMonta.originalHex, '04b2bd9f00');
fs.mkdirSync(output);
function checksum(rom) {
  rom.writeUInt16LE(65535, 0xffdc);
  rom.writeUInt16LE(0, 0xffde);
  const sum = rom.reduce((total, byte) => (total + byte) & 65535, 0);
  rom.writeUInt16LE(sum ^ 65535, 0xffdc);
  rom.writeUInt16LE(sum, 0xffde);
}
function run(name, bytes, snapshot = state, inputs = '30:3:a') {
  const filename = path.join(output, `${name}.sfc`);
  const stateFile = path.join(output, `${name}.bin`);
  fs.writeFileSync(filename, bytes, { flag: 'wx' });
  fs.writeFileSync(stateFile, snapshot, { flag: 'wx' });
  const directory = path.join(output, name);
  const result = spawnSync(runner, [core, filename, directory, '360', inputs, stateFile], {
    env: { ...process.env, MOMOTARO_CHEATS: '', MOMOTARO_CAPTURE_EVERY: '360' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  return { directory, frame: fs.readFileSync(path.join(directory, 'frame-360.ppm')),
    ram: fs.readFileSync(path.join(directory, 'wram-360.bin')) };
}
function image(bytes) {
  const header = /^P6\n256 224\n255\n/.exec(bytes.subarray(0, 64).toString());
  assert.ok(header);
  return bytes.subarray(header[0].length);
}
function glyphMatches(frame, character, x, y) {
  const pixels = image(frame);
  const glyph = metadata.glyphs.find(entry => entry.character === character);
  assert.ok(glyph);
  for (let row = 0; row < 15; row++) for (let column = 0; column < 12; column++) {
    const plane = number => column < 8 ? (target[glyph.offset + number * 23 + row] >> (7 - column)) & 1
      : (target[glyph.offset + number * 23 + 15 + (row >> 1)] >> ((row % 2 === 0 ? 4 : 0) + 11 - column)) & 1;
    if (!plane(0)) continue;
    const offset = ((y + row) * 256 + x + 2 + column) * 3;
    const brightness = Math.max(...pixels.subarray(offset, offset + 3));
    if (plane(1) ? brightness < 140 : brightness > 80) return false;
  }
  return true;
}
function outsideEqual(first, second, rectangles) {
  const before = image(first), after = image(second);
  for (let y = 0; y < 224; y++) for (let x = 0; x < 256; x++) {
    if (rectangles.some(rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height)) continue;
    const offset = (y * 256 + x) * 3;
    assert.deepEqual(after.subarray(offset, offset + 3), before.subarray(offset, offset + 3), `Unrelated chart pixel changed: ${x},${y}`);
  }
}
if (process.argv.includes('--pochi')) {
  assert.equal(metadata.defaultPochi.originalHex, '04e7a000');
  const ramStart = state.indexOf('RAM:131072:') + 11;
  assert.ok(ramStart > 11);
  assert.equal(state.subarray(ramStart + 0x3d35, ramStart + 0x3d39).toString('hex'), '04e7a000');
  if (metadata.defaultKiko) {
    assert.equal(metadata.defaultKiko.originalHex, '0496809900');
    assert.equal(state.subarray(ramStart + 0x3d41, ramStart + 0x3d46).toString('hex'), '0496809900');
  }
  const names = [];
  for (const sample of [
    { name: 'default-pochi', index: 23, address: 0x3d35, hex: '04e7a000', translated: true, label: '波奇' },
    { name: 'custom-suffix', index: 23, address: 0x3d35, hex: '04e7a0a000', translated: false },
    { name: 'custom-name', index: 23, address: 0x3d35, hex: '0495969700', translated: false },
    { name: 'other-character', index: 24, address: 0x3d3b, hex: '04e7a000', translated: false },
    { name: 'default-monta', index: 24, address: 0x3d3b, hex: '04b2bd9f00', translated: false },
    ...(metadata.defaultKiko ? [
      { name: 'default-kiko', index: 25, address: 0x3d41, hex: '0496809900', translated: true, label: '琪可' },
      { name: 'kiko-custom-suffix', index: 25, address: 0x3d41, hex: '049680999900', translated: false },
      { name: 'kiko-custom-name', index: 25, address: 0x3d41, hex: '0495969700', translated: false },
      { name: 'kiko-other-character', index: 23, address: 0x3d35, hex: '0496809900', translated: false },
    ] : []),
  ]) {
    const snapshot = Buffer.from(state);
    snapshot.fill(0, ramStart + sample.address, ramStart + sample.address + 6);
    Buffer.from(sample.hex, 'hex').copy(snapshot, ramStart + sample.address);
    const runs = [original, target].map((bytes, index) => {
      const probe = Buffer.from(bytes);
      Buffer.from('a9048db412', 'hex').copy(probe, 0x5c7cf);
      probe[0x5c80b] = sample.index;
      probe[0x5c80e] = 0;
      checksum(probe);
      return run(`${sample.name}-${index ? 'translated' : 'source'}`, probe, snapshot);
    });
    for (const result of runs) assert.deepEqual(result.ram.subarray(0x3d20, 0x3d70), snapshot.subarray(ramStart + 0x3d20, ramStart + 0x3d70));
    if (sample.translated) {
      assert.ok(glyphMatches(runs[1].frame, sample.label[0], 112, 24));
      assert.ok(glyphMatches(runs[1].frame, sample.label[1], 126, 24));
      assert.ok(!glyphMatches(runs[0].frame, sample.label[0], 112, 24));
      outsideEqual(runs[0].frame, runs[1].frame, [{ x: 112, y: 23, width: 48, height: 17 }]);
    } else assert.deepEqual(runs[1].frame, runs[0].frame);
    assert.equal(spawnSync('magick', [path.join(runs[1].directory, 'frame-360.ppm'), path.join(output, `${sample.name}.png`)]).status, 0);
    names.push({ ...sample, passed: true, nameRamUnchanged: true, outsideNamePixelsIdentical: true });
  }
  assert.equal(hash(fs.readFileSync(fixture)), stateHash);
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ targetSha256: metadata.targetSha256,
    baselineSha256: previous.targetSha256, fixtureSha256: stateHash, defaultNameCases: names, fixtureUnchanged: true,
    limitations: ['Scoped native dynamic-name probes, not all menus, natural battles, naming input or physical-device boot.'] }, null, 2) + '\n', { flag: 'wx' });
  console.log(`PASS ${names.length} animal/default/custom-name cases; stored names unchanged`);
  process.exit(0);
}

const sourceChart = run('source-chart', original);
const translatedChart = run('translated-chart', target);
const cells = metadata.commandChart.cells.map(cell => {
  if (cell.character !== ' ') assert.ok(glyphMatches(translatedChart.frame, cell.character, cell.x * 8, cell.y * 8), `Missing chart glyph: ${cell.character}`);
  return { ...cell, rendered: true };
});
outsideEqual(sourceChart.frame, translatedChart.frame, cells.map(cell => ({ x: cell.x * 8, y: cell.y * 8, width: 16, height: 16 })));
const familyRuns = [original, target].map((bytes, index) => {
  const probe = Buffer.from(bytes);
  assert.equal(probe.subarray(0x5c3b4, 0x5c3bf).toString('hex'), 'bd9907c902d003ee9e0322');
  Buffer.from('a902ea', 'hex').copy(probe, 0x5c3b4);
  assert.equal(probe.subarray(0x5c476, 0x5c47c).toString('hex'), 'bd9907d00d20');
  Buffer.from('a902ea', 'hex').copy(probe, 0x5c476);
  checksum(probe);
  return run(index ? 'translated-family' : 'source-family', probe);
});
const familyCells = metadata.commandChart.familyCells ?? [];
if (familyCells.length) {
  assert.equal(familyCells.length, 50);
  for (const cell of familyCells) {
    if (cell.character !== ' ') assert.ok(glyphMatches(familyRuns[1].frame, cell.character, (cell.x - 32) * 8, cell.y * 8), `Missing family-chart glyph: ${cell.character} at ${cell.x},${cell.y}`);
  }
  assert.ok(!familyRuns[1].frame.equals(familyRuns[0].frame), 'Family chart negative control did not differ');
  outsideEqual(familyRuns[0].frame, familyRuns[1].frame,
    familyCells.map(cell => ({ x: (cell.x - 32) * 8, y: cell.y * 8 - 1, width: 16, height: 17 })));
} else assert.deepEqual(familyRuns[1].frame, familyRuns[0].frame);
const names = [];
const ramStart = state.indexOf('RAM:131072:') + 11;
assert.ok(ramStart > 11);
for (const sample of [
  { name: 'default', index: 24, address: 0x3d3b, hex: '04b2bd9f00', translated: true },
  { name: 'custom-suffix', index: 24, address: 0x3d3b, hex: '04b2bd9f9f00', translated: false },
  { name: 'custom-name', index: 24, address: 0x3d3b, hex: '0495969700', translated: false },
  { name: 'other-character', index: 23, address: 0x3d35, hex: '04b2bd9f00', translated: false },
]) {
  const snapshot = Buffer.from(state);
  snapshot.fill(0, ramStart + sample.address, ramStart + sample.address + 6);
  Buffer.from(sample.hex, 'hex').copy(snapshot, ramStart + sample.address);
  const runs = [original, target].map((bytes, index) => {
    const probe = Buffer.from(bytes);
    Buffer.from('a9048db412', 'hex').copy(probe, 0x5c7cf);
    probe[0x5c80b] = sample.index;
    probe[0x5c80e] = 0;
    checksum(probe);
    return run(`${sample.name}-${index ? 'translated' : 'source'}`, probe, snapshot);
  });
  for (const result of runs) assert.deepEqual(result.ram.subarray(0x3d20, 0x3d70), snapshot.subarray(ramStart + 0x3d20, ramStart + 0x3d70));
  if (sample.translated) {
    assert.ok(glyphMatches(runs[1].frame, '蒙', 112, 24));
    assert.ok(glyphMatches(runs[1].frame, '太', 126, 24));
    assert.ok(!glyphMatches(runs[0].frame, '蒙', 112, 24));
    outsideEqual(runs[0].frame, runs[1].frame, [{ x: 112, y: 23, width: 48, height: 17 }]);
  } else assert.deepEqual(runs[1].frame, runs[0].frame);
  names.push({ ...sample, passed: true, nameRamUnchanged: true });
}
assert.equal(hash(fs.readFileSync(fixture)), stateHash);
const converted = spawnSync('magick', [path.join(translatedChart.directory, 'frame-360.ppm'), path.join(output, 'command-chart.png')]);
assert.equal(converted.status, 0);
const nameImage = spawnSync('magick', [path.join(output, 'default-translated/frame-360.ppm'), path.join(output, 'default-name.png')]);
assert.equal(nameImage.status, 0);
if (familyCells.length) {
  const familyImage = spawnSync('magick', [path.join(familyRuns[1].directory, 'frame-360.ppm'), path.join(output, 'family-chart.png')]);
  assert.equal(familyImage.status, 0);
}
const report = { targetSha256: metadata.targetSha256, baselineSha256: previous.targetSha256,
  fixtureSha256: stateHash, commandChartCells: cells, outsideChartCellsUnchanged: true,
  otherChartPixelsIdentical: familyCells.length === 0,
  familyChartCells: familyCells, outsideFamilyCellsUnchanged: true,
  familyModeInitialized: true, defaultNameCases: names, fixtureUnchanged: true,
  limitations: ['Chart opened from a copied item-use state; family mode and name cases use scoped probes', 'Not a natural dice-summoning battle or physical-device boot verification'] };
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ chartCells: cells.length, nameCases: names.length, report: path.join(output, 'verification.json') }));