import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultRom = path.join(root, 'assets', 'Shin Momotarou Densetsu (Japan) (Rev 1).sfc');
const expectedSha256 = '3f79f2f44303e316994fad9d0b2ae6dc96146c5f2efc3f095a632c04c4fbbf7c';

function inspect(rom) {
  const sha256 = createHash('sha256').update(rom).digest('hex');
  assert.equal(sha256, expectedSha256, 'Unsupported ROM; this tool expects the supplied Rev 1 dump.');
  const header = 0xffc0;
  const checksum = rom.reduce((sum, byte) => (sum + byte) & 0xffff, 0);
  return {
    sha256,
    bytes: rom.length,
    title: rom.toString('ascii', header, header + 21),
    mapping: 'Fast HiROM',
    mapByte: rom[header + 21],
    copierHeaderBytes: 0,
    checksum,
    storedChecksum: rom.readUInt16LE(header + 30),
    checksumValid: checksum === rom.readUInt16LE(header + 30),
    complementValid: (rom.readUInt16LE(header + 28) ^ rom.readUInt16LE(header + 30)) === 0xffff,
  };
}

function decodeTile(rom, offset, bitsPerPixel) {
  const pixels = new Uint8Array(64);
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      let value = 0;
      for (let plane = 0; plane < bitsPerPixel; plane++) {
        const index = bitsPerPixel === 1
          ? offset + row
          : offset + Math.floor(plane / 2) * 16 + row * 2 + plane % 2;
        value |= ((rom[index] >> (7 - column)) & 1) << plane;
      }
      pixels[row * 8 + column] = Math.round(value * 255 / ((1 << bitsPerPixel) - 1));
    }
  }
  return pixels;
}

function preview(rom, offset, length, bitsPerPixel, destination) {
  assert.ok([1, 2, 4].includes(bitsPerPixel), 'Bits per pixel must be 1, 2, or 4.');
  assert.ok(Number.isSafeInteger(offset) && offset >= 0, 'Invalid offset.');
  assert.ok(Number.isSafeInteger(length) && length > 0 && offset + length <= rom.length, 'Invalid length.');
  const tileBytes = bitsPerPixel * 8;
  assert.equal(length % tileBytes, 0, 'Length must contain complete tiles.');
  const columns = 64;
  const width = columns * 8;
  const height = Math.ceil(length / tileBytes / columns) * 8;
  const pixels = Buffer.alloc(width * height);
  for (let tile = 0; tile < length / tileBytes; tile++) {
    const decoded = decodeTile(rom, offset + tile * tileBytes, bitsPerPixel);
    const left = (tile % columns) * 8;
    const top = Math.floor(tile / columns) * 8;
    for (let row = 0; row < 8; row++) {
      pixels.set(decoded.subarray(row * 8, row * 8 + 8), (top + row) * width + left);
    }
  }
  fs.writeFileSync(destination, Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), pixels]), { flag: 'wx' });
}

function selfTest() {
  for (const bitsPerPixel of [1, 2, 4]) {
    const blank = Buffer.alloc(bitsPerPixel * 8);
    assert.ok(decodeTile(blank, 0, bitsPerPixel).every(value => value === 0));
    assert.ok(decodeTile(Buffer.alloc(bitsPerPixel * 8, 255), 0, bitsPerPixel).every(value => value === 255));
  }
  const tile = Buffer.alloc(32);
  tile[0] = 0x80;
  tile[1] = 0x40;
  tile[16] = 0x20;
  tile[17] = 0x10;
  assert.deepEqual([...decodeTile(tile, 0, 4).subarray(0, 8)], [17, 34, 68, 136, 0, 0, 0, 0]);
  assert.throws(() => inspect(Buffer.alloc(32)), /Unsupported ROM/);
  console.log('Tile decoder and ROM identity tests passed.');
}

const [command = 'info', ...args] = process.argv.slice(2);
if (command === 'self-test') {
  selfTest();
} else if (command === 'info') {
  console.log(JSON.stringify(inspect(fs.readFileSync(args[0] ?? defaultRom)), null, 2));
} else if (command === 'tiles' && args.length === 4) {
  const rom = fs.readFileSync(defaultRom);
  inspect(rom);
  preview(rom, Number(args[0]), Number(args[1]), Number(args[2]), args[3]);
  console.log(`Wrote tile preview to ${args[3]}`);
} else if (command === 'raw-tiles' && args.length === 5) {
  preview(fs.readFileSync(args[0]), Number(args[1]), Number(args[2]), Number(args[3]), args[4]);
  console.log(`Wrote raw tile preview to ${args[4]}`);
} else {
  console.error('Usage: node tools/inspect-rom.mjs info [ROM]\n       node tools/inspect-rom.mjs self-test\n       node tools/inspect-rom.mjs tiles OFFSET LENGTH BPP OUTPUT.pgm\n       node tools/inspect-rom.mjs raw-tiles INPUT OFFSET LENGTH BPP OUTPUT.pgm');
  process.exitCode = 1;
}