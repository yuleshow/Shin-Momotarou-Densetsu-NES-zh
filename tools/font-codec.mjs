import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function fontGroup(rom, group) {
  assert.ok(Number.isInteger(group) && group >= 1 && group <= 22);
  const offset = 0x1a0000 + rom.readUInt16LE(0x1a3800 + (group - 1) * 2);
  const firstRow = rom[offset] >> 4;
  const lastRow = rom[offset] & 15;
  const height = lastRow - firstRow + 1;
  const stride = (height * 3 + 1) & 0x3e;
  const next = group < 22 ? 0x1a0000 + rom.readUInt16LE(0x1a3800 + group * 2) : null;
  return { group, offset, firstRow, lastRow, height, stride, count: next === null ? null : (next - offset - 1) / stride };
}

export function decodeGlyph(rom, group, index) {
  const info = fontGroup(rom, group);
  assert.ok(Number.isInteger(index) && index >= 0 && (info.count === null || index < info.count));
  const pixels = new Uint8Array(12 * 16);
  let cursor = info.offset + 1 + index * info.stride;
  assert.ok(cursor + info.stride <= rom.length);
  for (let plane = 0; plane < 2; plane++) {
    for (let row = info.firstRow; row <= info.lastRow; row++) {
      const byte = rom[cursor++];
      for (let column = 0; column < 8; column++) pixels[row * 12 + column] |= ((byte >> (7 - column)) & 1) << plane;
    }
    for (let relativeRow = 0; relativeRow < info.height; relativeRow++) {
      const nibble = (rom[cursor + Math.floor(relativeRow / 2)] >> (relativeRow % 2 === 0 ? 4 : 0)) & 15;
      for (let column = 0; column < 4; column++) pixels[(relativeRow + info.firstRow) * 12 + column + 8] |= ((nibble >> (3 - column)) & 1) << plane;
    }
    cursor += Math.ceil(info.height / 2);
  }
  return pixels;
}

export function encodeGlyph(pixels, firstRow, lastRow, original) {
  assert.equal(pixels.length, 192);
  assert.ok(firstRow >= 0 && lastRow < 16 && firstRow <= lastRow);
  const height = lastRow - firstRow + 1;
  const stride = (height * 3 + 1) & 0x3e;
  const bytes = original ? Buffer.from(original) : Buffer.alloc(stride);
  assert.equal(bytes.length, stride);
  let cursor = 0;
  for (let plane = 0; plane < 2; plane++) {
    for (let row = firstRow; row <= lastRow; row++) {
      let byte = 0;
      for (let column = 0; column < 8; column++) byte |= ((pixels[row * 12 + column] >> plane) & 1) << (7 - column);
      bytes[cursor++] = byte;
    }
    for (let relativeRow = 0; relativeRow < height; relativeRow++) {
      let nibble = 0;
      for (let column = 0; column < 4; column++) nibble |= ((pixels[(relativeRow + firstRow) * 12 + column + 8] >> plane) & 1) << (3 - column);
      const shift = relativeRow % 2 === 0 ? 4 : 0;
      const address = cursor + Math.floor(relativeRow / 2);
      bytes[address] = (bytes[address] & ~(15 << shift)) | (nibble << shift);
    }
    cursor += Math.ceil(height / 2);
  }
  return bytes;
}

function verify(rom) {
  let count = 0;
  for (let group = 1; group < 22; group++) {
    const info = fontGroup(rom, group);
    assert.ok(Number.isInteger(info.count), `Group ${group} has a fractional glyph count`);
    for (let index = 0; index < info.count; index++) {
      const offset = info.offset + 1 + index * info.stride;
      const original = rom.subarray(offset, offset + info.stride);
      assert.deepEqual(encodeGlyph(decodeGlyph(rom, group, index), info.firstRow, info.lastRow, original), original);
      count++;
    }
  }
  const pixels = new Uint8Array(192);
  pixels[12 + 8] = 1;
  pixels[24 + 11] = 2;
  const bytes = encodeGlyph(pixels, 1, 15);
  assert.equal(bytes[15], 0x80);
  assert.equal(bytes[38], 0x01);
  console.log(`Verified ${count} original glyphs with byte-exact decode/encode round trips.`);
}

function atlas(rom, group, destination) {
  const info = fontGroup(rom, group);
  assert.ok(info.count !== null, 'Last font group length is not yet established');
  const width = 16 * 16;
  const height = Math.ceil(info.count / 16) * 20;
  const pixels = Buffer.alloc(width * height, 255);
  for (let index = 0; index < info.count; index++) {
    const glyph = decodeGlyph(rom, group, index);
    for (let row = 0; row < 16; row++) {
      for (let column = 0; column < 12; column++) {
        const value = glyph[row * 12 + column];
        pixels[(Math.floor(index / 16) * 20 + row) * width + (index % 16) * 16 + column] = (value & 2) ? 0 : 255;
      }
    }
  }
  fs.writeFileSync(destination, Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), pixels]), { flag: 'wx' });
  console.log(info);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const rom = fs.readFileSync(new URL('../assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc', import.meta.url));
  if (command === 'verify') verify(rom);
  else if (command === 'atlas' && args.length === 2) atlas(rom, Number(args[0]), args[1]);
  else throw new Error('Usage: node tools/font-codec.mjs verify | atlas GROUP OUTPUT.pgm');
}