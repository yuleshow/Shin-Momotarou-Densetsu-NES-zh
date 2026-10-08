import assert from 'node:assert/strict';
import { nameEntryContract } from './verify-name-entry.mjs';

export function encodeEnglishName(text, mode) {
  assert.ok(mode && Number.isInteger(mode.mode) && mode.mode >= 1 && mode.mode <= 12);
  assert.equal(mode.capacity, mode.mode === 12 ? 5 : 4);
  assert.equal(typeof text, 'string');
  assert.match(text, /^[A-Za-z0-9 ]+$/, 'English input supports only letters, digits and spaces');
  assert.ok(text.trim().length > 0, 'English input cannot be blank');
  assert.ok(text.length <= mode.capacity, 'English input exceeds native character capacity');
  const bytes = Buffer.alloc(mode.capacity + 1);
  for (const [index, character] of [...text.toUpperCase()].entries()) {
    bytes[index] = character === ' ' ? 0x50
      : character >= '0' && character <= '9' ? 0x51 + character.charCodeAt(0) - 48
        : 0x61 + character.charCodeAt(0) - 65;
  }
  return bytes;
}

export function nativeSaveContract(rom) {
  assert.equal(rom.subarray(0x5819f, 0x581a7).toString('hex'), '8b5ada4babad4a11');
  assert.equal(rom.subarray(0x582b5, 0x582bd).toString('hex'), '00000062006c0076');
  const fields = [];
  let cursor = 0x582db;
  let payloadBytes = 0;
  while (cursor < 0x58675) {
    const length = rom.readUInt16LE(cursor);
    if (!length) break;
    const address = rom.readUInt16LE(cursor + 2);
    const maximum = rom[cursor + 4];
    fields.push({ address, length, maximum, saveOffset: payloadBytes });
    payloadBytes += length;
    cursor += 5;
  }
  assert.equal(cursor, 0x58673);
  assert.equal(fields.length, 184);
  assert.equal(payloadBytes, 2352);
  const modes = nameEntryContract(rom).map(mode => {
    const address = mode.address - Number(mode.katakana);
    const length = mode.capacity + Number(mode.katakana) + 1;
    const field = fields.find(entry => address >= entry.address && address + length <= entry.address + entry.length);
    return { ...mode, legacyAddress: address, legacyBytes: length,
      persistent: mode.mode !== 12,
      saveOffset: field ? field.saveOffset + address - field.address : null };
  });
  assert.ok(modes.slice(0, 11).every(mode => mode.saveOffset !== null));
  assert.equal(modes[11].saveOffset, null);
  assert.equal(rom.subarray(0x5da42, 0x5da58).toString('hex'), 'a2002286e284adb212f00bdf4a5f7ed00ce8e00590ec');
  return { sramBytes: 8192, slotOffsets: [0x200, 0xc00, 0x1600], slotBytes: 2560,
    payloadBytes, extensionBytes: 208, fields, modes };
}

export function readLegacySaveSlot(sram, contract, slot) {
  assert.equal(sram.length, contract.sramBytes);
  assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 3);
  const offset = contract.slotOffsets[slot - 1];
  const payload = sram.subarray(offset, offset + contract.payloadBytes);
  const checksum = payload.reduce((sum, byte) => (sum + byte) & 65535, 0);
  const occupied = sram[0x20 + slot] === slot;
  return { slot, occupied, checksum, expectedChecksum: sram.readUInt16LE(0x22 + slot * 2),
    checksumValid: checksum === sram.readUInt16LE(0x22 + slot * 2),
    names: contract.modes.map(mode => ({ mode: mode.mode, capacity: mode.capacity,
      bytes: mode.saveOffset === null ? null : Buffer.from(payload.subarray(mode.saveOffset, mode.saveOffset + mode.legacyBytes)) })) };
}