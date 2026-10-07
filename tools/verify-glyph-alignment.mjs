import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const [runner, core, candidate, baseline, output] = process.argv.slice(2);
assert.ok(output, 'Usage: node tools/verify-glyph-alignment.mjs RUNNER CORE CANDIDATE BASELINE NEW_OUTPUT');
const read = filename => JSON.parse(fs.readFileSync(filename));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = read(path.join(candidate, 'build.json'));
const previous = read(path.join(baseline, 'build.json'));
const target = fs.readFileSync(path.join(candidate, metadata.romFilename));
const original = fs.readFileSync(path.join(baseline, previous.romFilename));
assert.equal(hash(target), metadata.targetSha256);
assert.equal(hash(original), previous.targetSha256);
assert.equal(metadata.glyphAlignment, 'baseline');
assert.deepEqual(metadata.glyphs, previous.glyphs);
const restored = Buffer.from(target);
for (const glyph of metadata.glyphs) original.copy(restored, glyph.offset, glyph.offset, glyph.offset + 46);
for (const [start, end] of [[0xffdc, 0xffe0], [0x3e0000, 0x3f0000]]) original.copy(restored, start, start, end);
assert.deepEqual(restored, original, 'Non-font game data changed');
const characters = metadata.glyphs.map(glyph => glyph.character).filter(character => /[\p{Punctuation}\p{Symbol}]/u.test(character));
assert.equal(characters.filter(character => /\p{Punctuation}/u.test(character)).length, 20);
characters.push('一');
fs.mkdirSync(output);
function run(rom, name, frames, inputs, state) {
  const directory = path.join(output, name);
  const result = spawnSync(runner, [core, rom, directory, String(frames), inputs, ...(state ? [state] : [])], {
    encoding: 'utf8', env: { ...process.env, MOMOTARO_CHEATS: '', MOMOTARO_CAPTURE_EVERY: '60' },
  });
  assert.equal(result.status, 0, result.stderr);
  return directory;
}
function probe(bytes, text, name) {
  const rom = Buffer.from(bytes);
  const codes = [...text].flatMap(character => [...Buffer.from(metadata.glyphs.find(glyph => glyph.character === character).code, 'hex')]);
  Buffer.from([0, ...codes, ...Array(64).fill(0)]).copy(rom, 0x3f0000);
  rom.writeUIntLE(0xff0000, 0x702c4, 3);
  rom.writeUInt16LE(65535, 0xffdc);
  rom.writeUInt16LE(0, 0xffde);
  const checksum = rom.reduce((total, byte) => (total + byte) & 65535, 0);
  rom.writeUInt16LE(checksum ^ 65535, 0xffdc);
  rom.writeUInt16LE(checksum, 0xffde);
  const filename = path.join(output, `${name}.sfc`);
  fs.writeFileSync(filename, rom, { flag: 'wx' });
  return filename;
}
function points(text) {
  return [...text].flatMap((character, index) => {
    const glyph = metadata.glyphs.find(entry => entry.character === character);
    const bytes = target.subarray(glyph.offset, glyph.offset + 46);
    const result = [];
    for (let row = 0; row < 15; row++) for (let column = 0; column < 12; column++) {
      const bit = plane => column < 8 ? (bytes[plane * 23 + row] >> (7 - column)) & 1
        : (bytes[plane * 23 + 15 + (row >> 1)] >> ((row % 2 ? 0 : 4) + 11 - column)) & 1;
      if (bit(0)) result.push({ row: row + 1, column: index * 12 + column, foreground: bit(1) });
    }
    return result;
  });
}
function match(filename, text) {
  const image = fs.readFileSync(filename);
  const header = /^P6\n256 224\n255\n/.exec(image.subarray(0, 64).toString());
  assert.ok(header);
  const pixels = image.subarray(header[0].length);
  const brightness = Uint8Array.from({ length: 256 * 224 }, (_, index) => Math.max(...pixels.subarray(index * 3, index * 3 + 3)));
  const mask = points(text);
  for (let row = 0; row <= 208; row++) for (let column = 0; column <= 256 - [...text].length * 12; column++) {
    if (mask.every(point => point.foreground ? brightness[(row + point.row) * 256 + column + point.column] >= 140
      : brightness[(row + point.row) * 256 + column + point.column] <= 80)) return { x: column, y: row };
  }
  return null;
}
function rendered(directory, text) {
  const frames = fs.readdirSync(directory).filter(filename => /^frame-\d+\.ppm$/.test(filename))
    .sort((first, second) => Number(first.match(/\d+/)[0]) - Number(second.match(/\d+/)[0]));
  for (const frame of frames) {
    const found = match(path.join(directory, frame), text);
    if (found) return { ...found, frame };
  }
  return null;
}
const title = run(path.join(candidate, metadata.romFilename), 'title', 1380, '30:3:start,1201:2:start');
const cases = [];
for (let start = 0; start < characters.length; start += 8) {
  const text = `桃${characters.slice(start, start + 8).join('')}桃`;
  const name = `punctuation-${start / 8}`;
  const translated = run(probe(target, text, name), name, 1800, '1:2:a', path.join(title, 'state.bin'));
  const before = run(probe(original, text, `${name}-old`), `${name}-old`, 1800, '1:2:a', path.join(title, 'state.bin'));
  const found = rendered(translated, text);
  assert.ok(found, `Native punctuation did not render: ${text}`);
  const frame = path.join(translated, found.frame);
  const changed = [...text].some(character => {
    const glyph = metadata.glyphs.find(entry => entry.character === character);
    return !target.subarray(glyph.offset, glyph.offset + 46).equals(original.subarray(glyph.offset, glyph.offset + 46));
  });
  assert.equal(Boolean(rendered(before, text)), !changed, `Old-position control: ${text}`);
  const png = path.join(output, `${name}.png`);
  const conversion = spawnSync('magick', [frame, png], { encoding: 'utf8' });
  assert.equal(conversion.status, 0, conversion.stderr);
  cases.push({ text, rendered: found, oldPositionRejected: changed, image: path.basename(png), sha256: hash(fs.readFileSync(png)) });
}
const report = { targetSha256: metadata.targetSha256, baselineSha256: previous.targetSha256,
  punctuationCount: 20, checkedCharacters: characters, cases, nonFontGameDataUnchanged: true,
  limitations: ['Synthetic native dialogue, not a natural battle or physical-device boot'] };
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));