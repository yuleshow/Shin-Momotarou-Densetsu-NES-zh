import assert from 'node:assert/strict';
import { splitRecords } from './text-catalog.mjs';
import { encodeEnglishName, nativeSaveContract } from './name-storage.mjs';
import { isGlyphPrefix } from './chinese-font.mjs';

export function patchEnglishNameEntry(source, target) {
  nativeSaveContract(source);
  assert.equal(source.subarray(0x5d59e, 0x5d5a2).toString('hex'), '5adaa80a');
  assert.equal(source.subarray(0x5d5bd, 0x5d5d3).toString('hex'), 'da850fa200bd8919f007c50ff005e880f4a24c8afa60');
  assert.equal(source.subarray(0x4a05f, 0x4a061).toString('hex'), 'ab6b');
  for (const [start, end] of [[0x402, 0x461], [0x5d59e, 0x5d5d3], [0x4a05f, 0x4a061]]) {
    assert.deepEqual(target.subarray(start, end), source.subarray(start, end));
  }
  assert.ok(target.subarray(0x3ce000, 0x3d0000).every(byte => byte === 255), 'English keyboard allocation overlaps data');
  const originalKeys = [...source.subarray(0x402, 0x461)].filter(byte => byte > 1);
  assert.equal(originalKeys.length, 85);
  assert.deepEqual(originalKeys.slice(77, 80), [0x83, 0x84, 0x82]);
  const keys = Buffer.alloc(85, 0x50);
  for (const [index, character] of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].entries()) {
    keys[index] = encodeEnglishName(character, { mode: 1, capacity: 4 })[0];
  }
  Buffer.from(originalKeys.slice(77, 80)).copy(keys, 77);
  const input = Buffer.from(source.subarray(0x402, 0x461));
  let keyIndex = 0;
  for (let index = 0; index < input.length; index++) if (input[index] > 1) input[index] = keys[keyIndex++];
  assert.equal(keyIndex, keys.length);
  const start = target.readUIntLE(0x70033, 3) - 0xc00000;
  assert.equal(target[start], 0);
  let end = start + 1;
  let count = 0;
  while (count < 231 && end < target.length) {
    const byte = target[end++];
    if (isGlyphPrefix(byte) || byte === 2) end++;
    else if (byte === 0) count++;
  }
  assert.equal(count, 231);
  const records = splitRecords(target.subarray(start + 1, end));
  const replacements = new Map();
  for (let row = 0; row < 9; row++) {
    const rowKeys = keys.subarray(row * 10, Math.min(row * 10 + 10, keys.length));
    const bytes = row === 7 ? Buffer.concat([Buffer.alloc(8, 0x50), Buffer.from('888718fd', 'hex')])
      : rowKeys.length === 10 ? Buffer.concat([rowKeys.subarray(0, 5), Buffer.from([0x50]), rowKeys.subarray(5)])
        : Buffer.from(rowKeys);
    replacements.set(199 + row, bytes);
    replacements.set(208 + row, bytes);
  }
  const text = Buffer.concat([Buffer.from([0]), ...records.flatMap(record => [replacements.get(record.index)
    ?? Buffer.from(record.originalHex, 'hex'), Buffer.from([0])])]);
  assert.ok(text.length <= 0x1000);
  const redraw = Buffer.from('5ada48ad5c193a0aaabfecd5858506bfedd5858507a97e8508a301a8b706c980b000c950900048adcd1248a9058dcd12980a1869118d0b03a9028d0d032200e3fca302850664072220e3fc688dcd126868fa7a5cbcd58568fa7a5adaa80a5ca2d585', 'hex');
  const legacy = redraw.indexOf(Buffer.from('68fa7a5adaa80a', 'hex'));
  for (const opcode of ['c980b000', 'c9509000']) {
    const branch = redraw.indexOf(Buffer.from(opcode, 'hex')) + 3;
    assert.ok(branch >= 3 && legacy - branch - 1 < 128);
    redraw[branch] = legacy - branch - 1;
  }
  const writes = [
    { offset: 0x402, bytes: input },
    { offset: 0x3ce000, bytes: Buffer.from(originalKeys) },
    { offset: 0x3ce100, bytes: redraw },
    { offset: 0x3ce200, bytes: Buffer.from('da850fa200bf00e0fcc50ff007e8e05590f3a24c8afa5cd2d585', 'hex') },
    { offset: 0x3ce300, bytes: Buffer.from('8ba98448abf45ea05cd7a784', 'hex') },
    { offset: 0x3ce320, bytes: Buffer.from('8ba98448abf45ea05cafa584', 'hex') },
    { offset: 0x5d59e, bytes: Buffer.from('5c00e1fc', 'hex') },
    { offset: 0x5d5bd, bytes: Buffer.from('5c00e2fc', 'hex') },
    { offset: 0x3cf000, bytes: text },
    { offset: 0x70033, bytes: Buffer.from('00f0fc', 'hex') },
  ];
  for (const write of writes) write.bytes.copy(target, write.offset);
  assert.deepEqual(target.subarray(0x58000, 0x58675), source.subarray(0x58000, 0x58675));
  return { inputLanguage: 'English', keyboardKeys: [...keys], unchangedLegacyLabelIndexes: [24, 183],
    replacedRowIndexes: [...replacements.keys()].sort((first, second) => first - second),
    textOffset: 0x3cf000, textBytes: text.length, sramFormatChanged: false,
    quizAnswersImplemented: false, naturalNameScreenVerified: false,
    writes: writes.map(write => ({ offset: write.offset, hex: write.bytes.toString('hex') })) };
}