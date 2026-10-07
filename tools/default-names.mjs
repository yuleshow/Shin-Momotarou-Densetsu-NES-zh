import assert from 'node:assert/strict';
import { chineseCode } from './chinese-font.mjs';

function patchDefaultName(source, target, characters, definition) {
  assert.equal(source.subarray(0x4ae6f, 0x4ae7d).toString('hex'), 'a7b1f0069caa123880011868fa7a');
  const label = Buffer.from([...[...definition.label].flatMap(character => {
    const index = characters.indexOf(character);
    assert.ok(index >= 0, `Missing default-name glyph: ${character}`);
    return chineseCode(index);
  }), 0]);
  const bytes = [0x08, 0x48, 0xc2, 0x10, 0x5a, 0xa5, 0xb3, 0xc9, 0x7e];
  const branches = [];
  const reject = () => { bytes.push(0xd0, 0); branches.push(bytes.length - 1); };
  reject();
  bytes.push(0xc2, 0x20, 0xa5, 0xb1, 0xc9, definition.nameAddress & 255, (definition.nameAddress >> 8) & 255);
  reject();
  bytes.push(0xe2, 0x20, 0xa0, 0, 0);
  for (const expected of Buffer.from(definition.originalHex, 'hex')) {
    bytes.push(0xb7, 0xb1, 0xc9, expected);
    reject();
    bytes.push(0xc8);
  }
  bytes.push(0xc2, 0x20, 0xa9, definition.labelOffset & 255, (definition.labelOffset >> 8) & 255,
    0x85, 0xb1, 0xe2, 0x20, 0xa9, 0xfc, 0x85, 0xb3);
  const cleanup = bytes.length;
  bytes.push(0xe2, 0x20, 0x7a, 0x68, 0x28, ...definition.tail);
  for (const branch of branches) {
    assert.ok(cleanup - branch - 1 < 128);
    bytes[branch] = cleanup - branch - 1;
  }
  const writes = [
    { offset: 0x4ae73, bytes: Buffer.from([0x22, definition.routineOffset & 255, (definition.routineOffset >> 8) & 255, 0xfc]) },
    { offset: definition.routineOffset, bytes: Buffer.from(bytes) },
    { offset: definition.labelOffset, bytes: label },
  ];
  for (const write of writes) {
    if (write.offset >= 0x200000) assert.ok(target.subarray(write.offset, write.offset + write.bytes.length).every(byte => byte === 0xff), 'Default-name allocation overlaps data');
    write.bytes.copy(target, write.offset);
  }
  return { label: definition.label, nameAddress: definition.nameAddress, originalHex: definition.originalHex,
    customNamesPreserved: true, saveDataWritten: false,
    writes: writes.map(write => ({ offset: write.offset, hex: write.bytes.toString('hex') })) };
}

export function patchDefaultMonta(source, target, characters) {
  return patchDefaultName(source, target, characters, { label: '蒙太', nameAddress: 0x7e3d3b,
    originalHex: '04b2bd9f00', routineOffset: 0x3c2280, labelOffset: 0x3c2500,
    tail: [0x9c, 0xaa, 0x12, 0x38, 0x6b] });
}

export function patchDefaultPochi(source, target, characters) {
  assert.equal(target.subarray(0x4ae73, 0x4ae77).toString('hex'), '228022fc', 'Default Pochi requires the Monta display hook');
  return patchDefaultName(source, target, characters, { label: '波奇', nameAddress: 0x7e3d35,
    originalHex: '04e7a000', routineOffset: 0x3c2300, labelOffset: 0x3c2508,
    tail: [0x5c, 0x80, 0x22, 0xfc] });
}

export function patchDefaultKiko(source, target, characters) {
  assert.equal(target.subarray(0x4ae73, 0x4ae77).toString('hex'), '220023fc', 'Default Kiko requires the Pochi display hook');
  return patchDefaultName(source, target, characters, { label: '琪可', nameAddress: 0x7e3d41,
    originalHex: '0496809900', routineOffset: 0x3c2380, labelOffset: 0x3c2510,
    tail: [0x5c, 0x00, 0x23, 0xfc] });
}