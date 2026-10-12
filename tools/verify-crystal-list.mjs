import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { crystalListText } from './crystal-list.mjs';

const [runner, core, candidate, baseline, stateFile, output] = process.argv.slice(2);
assert.ok(output, 'Usage: verify-crystal-list.mjs RUNNER CORE CANDIDATE BASELINE NATURAL_STATE NEW_OUTPUT');
const read = filename => JSON.parse(fs.readFileSync(filename));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = read(path.join(candidate, 'build.json'));
const previous = read(path.join(baseline, 'build.json'));
const target = fs.readFileSync(path.join(candidate, metadata.romFilename));
const before = fs.readFileSync(path.join(baseline, previous.romFilename));
assert.equal(hash(target), metadata.targetSha256);
assert.equal(hash(before), previous.targetSha256);
const rawState = fs.readFileSync(stateFile);
let state = rawState;
if (state.subarray(0, 8).toString('hex') === '23525a4950760123') {
  const chunks = [];
  for (let offset = 20; offset < rawState.length;) {
    const length = rawState.readUInt32LE(offset);
    offset += 4;
    chunks.push(inflateSync(rawState.subarray(offset, offset + length)));
    offset += length;
  }
  const container = Buffer.concat(chunks);
  assert.equal(container.length, Number(rawState.readBigUInt64LE(12)));
  assert.equal(container.subarray(0, 7).toString(), 'RASTATE');
  state = container.subarray(16, 16 + container.readUInt32LE(12));
}
assert.equal(state.subarray(0, 9).toString(), '#!s9xsnp:');
fs.mkdirSync(output);
const fixture = path.join(output, 'natural-input.state');
fs.writeFileSync(fixture, state, { flag: 'wx' });
function run(filename, name, buttons, input, frames = 1800) {
  const directory = path.join(output, name);
  const env = { ...process.env, MOMOTARO_CAPTURE_EVERY: '60' };
  delete env.MOMOTARO_SRAM_FILE;
  delete env.MOMOTARO_CHEATS;
  delete env.MOMOTARO_TRACE;
  const result = spawnSync(runner, [core, filename, directory, String(frames), buttons, input], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return directory;
}
const field = run(path.join(candidate, metadata.romFilename), 'natural-field', '30:3:b,120:3:b,210:3:b', fixture, 360);
const fieldState = path.join(field, 'state.bin');
function probe(rom, count, name, record = 191, table = 0x13) {
  const result = Buffer.from(rom);
  assert.equal(result.subarray(0x1eee6, 0x1eeea).toString('hex'), '228ab385');
  assert.ok(result.subarray(0x23e000, 0x23e100).every(byte => byte === 255));
  Buffer.from('5c00e0e3', 'hex').copy(result, 0x1eee6);
  const setup = [Buffer.from('228ab38522d4be832261a084', 'hex')];
  for (let index = 0; index < 8; index++) {
    const active = index < count;
    const bytes = Buffer.from([0xa9, active ? 165 - count + index : 0, 0x8d, 0x97 + index, 0x12,
      0xa9, active ? 4 : 0, 0x8d, 0x9f + index, 0x12]);
    setup.push(bytes);
  }
  setup.push(Buffer.from([0xa9, table, 0x8d, 0xb4, 0x12, 0xa9, record]));
  setup.push(Buffer.from('22c4a0845c13ef81', 'hex'));
  Buffer.concat(setup).copy(result, 0x23e000);
  result.writeUInt16LE(0xffff, 0xffdc);
  result.writeUInt16LE(0, 0xffde);
  const checksum = result.reduce((sum, byte) => (sum + byte) & 65535, 0);
  result.writeUInt16LE(checksum ^ 65535, 0xffdc);
  result.writeUInt16LE(checksum, 0xffde);
  const filename = path.join(output, `${name}.sfc`);
  fs.writeFileSync(filename, result, { flag: 'wx' });
  return filename;
}
function wordPositions(frame, text) {
  const header = /^P6\n256 224\n255\n/.exec(frame.subarray(0, 64).toString());
  assert.ok(header);
  const pixels = frame.subarray(header[0].length);
  const points = [];
  [...text].forEach((character, index) => {
    const glyph = metadata.glyphs.find(entry => entry.character === character);
    assert.ok(glyph, character);
    for (let row = 0; row < 15; row++) for (let column = 0; column < 12; column++) {
      const bit = plane => column < 8 ? (target[glyph.offset + plane * 23 + row] >> (7 - column)) & 1
        : (target[glyph.offset + plane * 23 + 15 + (row >> 1)] >> ((row % 2 ? 0 : 4) + 11 - column)) & 1;
      if (bit(0)) points.push({ row: row + 1, column: index * 12 + column, foreground: bit(1) });
    }
  });
  const positions = [];
  for (let row = 0; row <= 208; row++) for (let column = 0; column <= 256 - [...text].length * 12; column++) {
    if (points.every(point => {
      const offset = ((row + point.row) * 256 + column + point.column) * 3;
      const brightness = Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      return point.foreground ? brightness >= 140 : brightness <= 80;
    })) positions.push({ x: column, y: row });
  }
  return positions;
}
const names = ['上弦水晶', '下弦水晶', '臥待水晶', '居待水晶', '十六夜水晶', '滿月水晶'];
const cases = [];
const counts = process.env.MOMOTARO_CRYSTAL_COUNT ? [Number(process.env.MOMOTARO_CRYSTAL_COUNT)] : [0, 1, 2, 3, 4, 5, 6];
for (const count of counts) {
  const filename = probe(target, count, `count-${count}`);
  const directory = run(filename, `count-${count}`, '30:3:a,900:3:a', fieldState);
  let next = 0;
  const selectedNames = names.slice(6 - count);
  const rows = crystalListText(count).replaceAll('[09]', () => selectedNames[next++]).split('\n');
  let match;
  for (let frame = 960; frame <= 1800; frame += 60) {
    const image = fs.readFileSync(path.join(directory, `frame-${frame}.ppm`));
    const positions = rows.map(row => wordPositions(image, row));
    if (positions.every(row => row.length > 0)) { match = { frame, rows, positions }; break; }
  }
  assert.ok(match, `Expected list was not rendered for count ${count}`);
  cases.push({ count, ...match });
  console.log(`PASS ${count} remaining crystals: ${JSON.stringify(match)}`);
}
const report = { targetSha256: metadata.targetSha256, baselineSha256: previous.targetSha256,
  stateSha256: hash(rawState), syntheticQueueTests: true, actualFishingRouteVerified: false, cases };
assert.equal(hash(fs.readFileSync(stateFile)), hash(rawState));
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });