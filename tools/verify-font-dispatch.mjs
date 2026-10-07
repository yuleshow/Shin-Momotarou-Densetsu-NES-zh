import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chineseCode, chineseDispatchMaximum, chineseFontGroup, chineseGlyphOffset, fontBankTable, fontPointerTable,
  fontDispatchCases, fontDispatchControls, verifyFontDispatchReport } from './chinese-font.mjs';

const [runner, core, previewDirectory, outputDirectory] = process.argv.slice(2);
assert.ok(runner && core && previewDirectory && outputDirectory,
  'Usage: node tools/verify-font-dispatch.mjs RUNNER CORE PREVIEW_DIRECTORY NEW_OUTPUT_DIRECTORY\nSet MOMOTARO_KEEP_FONT_CAPTURES=1 to retain all successful probe ROMs, frames and memory dumps.');
const keepCaptures = process.env.MOMOTARO_KEEP_FONT_CAPTURES === '1';
const metadata = JSON.parse(fs.readFileSync(path.join(previewDirectory, 'build.json')));
const target = fs.readFileSync(path.join(previewDirectory, metadata.romFilename));
assert.equal(createHash('sha256').update(target).digest('hex'), metadata.targetSha256);
assert.equal(target.readUInt16LE(0x4a613), chineseDispatchMaximum, 'Native font dispatch upper bound is stale');
assert.equal(target.readUInt16LE(0x4a615), 0xa62a, 'Native font handler changed');
assert.deepEqual(target.subarray(0x4a634, 0x4a637), Buffer.from('29c01f', 'hex'));
const glyphs = [...'秩測'].map(character => {
  const glyph = metadata.glyphs.find(entry => entry.character === character);
  assert.ok(Number.isInteger(glyph?.offset), `Missing probe glyph: ${character}`);
  return target.subarray(glyph.offset, glyph.offset + 46);
});
assert.notDeepEqual(glyphs[0], glyphs[1]);
const sumo = metadata.inlineMenus?.find(menu => menu.name === 'sumo-techniques');
assert.ok(sumo && Number(sumo.sourceEnd) === 0x2e927, 'Sumo callback extent changed');
assert.ok(target.subarray(Number(sumo.target), Number(sumo.target) + 0x100)
  .includes(Buffer.from('2c0027e98227e98227e982', 'hex')), 'Sumo callbacks missing');
fs.mkdirSync(outputDirectory);

function run(rom, name, frames, inputs, state) {
  const directory = path.join(outputDirectory, name);
  const result = spawnSync(runner, [core, rom, directory, String(frames), inputs, ...(state ? [state] : [])],
    { encoding: 'utf8', timeout: 120000, env: { ...process.env, MOMOTARO_CAPTURE_EVERY: '60' } });
  assert.equal(result.status, 0, `Native font playback failed: ${name}\n${result.stderr}\n${result.stdout}`);
  return directory;
}

function probe(name, indexes, staleMaximum) {
  const rom = Buffer.from(target);
  indexes.forEach((index, position) => {
    const { number, offset } = chineseFontGroup(index);
    rom.writeUInt16LE(offset & 65535, fontPointerTable + (number - 1) * 2);
    rom[fontBankTable + (number - 1) * 2] = (offset + 0xc00000) >>> 16;
    rom[offset] = 0x1f;
    glyphs[position].copy(rom, chineseGlyphOffset(index));
  });
  // Replace only the indexed opening message: boot, parsing, dispatch and drawing remain native.
  Buffer.from([0, ...indexes.flatMap(chineseCode), ...Array(64).fill(0)]).copy(rom, 0x3f0000);
  rom.writeUIntLE(0xff0000, 0x702c4, 3);
  if (staleMaximum !== undefined) rom.writeUInt16LE(staleMaximum, 0x4a613);
  rom.writeUInt16LE(65535, 0xffdc);
  rom.writeUInt16LE(0, 0xffde);
  const sum = rom.reduce((total, byte) => (total + byte) & 65535, 0);
  rom.writeUInt16LE(sum ^ 65535, 0xffdc);
  rom.writeUInt16LE(sum, 0xffde);
  const filename = path.join(outputDirectory, `${name}.sfc`);
  fs.writeFileSync(filename, rom, { flag: 'wx' });
  return filename;
}

const points = glyphs.flatMap((glyph, position) => {
  const result = [];
  for (let row = 0; row < 15; row++) for (let column = 0; column < 12; column++) {
    const bit = plane => column < 8 ? (glyph[plane * 23 + row] >> (7 - column)) & 1
      : (glyph[plane * 23 + 15 + (row >> 1)] >> ((row % 2 ? 0 : 4) + 11 - column)) & 1;
    if (bit(0)) result.push({ row: row + 1, column: position * 12 + column, foreground: bit(1) });
  }
  assert.ok(result.some(point => point.foreground), 'Empty probe glyph');
  return result;
});
function renderedPair(directory) {
  const frames = fs.readdirSync(directory).filter(name => /^frame-\d+\.ppm$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  for (const frame of frames) {
    const image = fs.readFileSync(path.join(directory, frame));
    const header = /^P6\n(\d+) (\d+)\n255\n/.exec(image.subarray(0, 64).toString('ascii'));
    assert.ok(header);
    const width = Number(header[1]), height = Number(header[2]);
    const pixels = image.subarray(header[0].length);
    assert.equal(pixels.length, width * height * 3);
    const brightness = Uint8Array.from({ length: width * height }, (_, index) =>
      Math.max(pixels[index * 3], pixels[index * 3 + 1], pixels[index * 3 + 2]));
    for (let y = 0; y <= height - 16; y++) for (let x = 0; x <= width - 24; x++) {
      if (points.every(point => point.foreground
        ? brightness[(y + point.row) * width + x + point.column] >= 140
        : brightness[(y + point.row) * width + x + point.column] <= 80)) return { frame, x, y };
    }
  }
  return null;
}

function retainEvidence(directory, frame, keepState = false) {
  if (keepCaptures) return;
  for (const filename of fs.readdirSync(directory)) {
    if (filename === frame || (keepState && filename === 'state.bin')) continue;
    if (/^(?:frame-\d+\.ppm|(?:wram|vram)-\d+\.bin|state\.bin)$/.test(filename)) {
      fs.unlinkSync(path.join(directory, filename));
    }
  }
  if (!keepState) fs.unlinkSync(`${directory}.sfc`);
}

const title = run(path.join(previewDirectory, metadata.romFilename), 'title', 1380,
  metadata.welcome ? '30:3:start,1201:2:start' : '1201:2:start');
const state = path.join(title, 'state.bin');
retainEvidence(title, 'frame-1380.ppm', true);
const report = { targetSha256: metadata.targetSha256, synthetic: true, actualStoryRouteVerified: false,
  path: 'native indexed dialogue', word: '秩測', dispatchMaximum: chineseDispatchMaximum,
  captureRetention: keepCaptures ? 'all' : 'matched frame per positive probe; final frame per negative probe; title state',
  cases: [], negativeControls: [] };
for (const indexes of fontDispatchCases) {
  const name = `glyphs-${indexes.join('-')}`;
  const directory = run(probe(name, indexes), name, 1200, '1:2:a', state);
  const match = renderedPair(directory);
  assert.ok(match, `Native glyph pair 秩測 failed at ${indexes.map(index => Buffer.from(chineseCode(index)).toString('hex'))}`);
  report.cases.push({ indexes, codes: indexes.map(index => Buffer.from(chineseCode(index)).toString('hex')), match });
  retainEvidence(directory, match.frame);
}
for (const { indexes, rendered: expected, maximum } of fontDispatchControls) {
  const name = `stale-${maximum.toString(16)}-${indexes.join('-')}`;
  const directory = run(probe(name, indexes, maximum), name, 1200, '1:2:a', state);
  const match = renderedPair(directory);
  assert.equal(Boolean(match), expected, `Old-bound negative control failed at ${indexes}`);
  report.negativeControls.push({ indexes, maximum, rendered: Boolean(match), match });
  retainEvidence(directory, match?.frame ?? 'frame-1200.ppm');
}
verifyFontDispatchReport(report);
fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(`Native font dispatch verified: ${report.cases.length} boundary/glyph pairs; ${report.negativeControls.length} stale-bound controls.`);
