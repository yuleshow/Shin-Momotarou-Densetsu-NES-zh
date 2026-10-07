import assert from 'node:assert/strict';

const retainedGlyphs = new Map([['砲', '1a20'], ['１', '52'], ['０', '51']]);

export function addInlineMenuData(menus, changes, source) {
  for (const change of changes) {
    const menu = menus.find(menu => menu.name === change.name);
    assert.ok(menu, `Unknown inline menu: ${change.name}`);
    for (const entry of change.entries ?? []) {
      assert.match(entry.originalHex, /^(?:[0-9a-f]{2})+$/);
      const start = Number(entry.offset);
      const end = start + entry.originalHex.length / 2;
      assert.ok(start >= Number(menu.start) && end <= Number(menu.end), 'Inline entry outside menu');
      assert.equal(source.subarray(start, end).toString('hex'), entry.originalHex, 'Inline source mismatch');
      assert.ok(!menu.entries.some(old => start < Number(old.offset) + old.originalHex.length / 2 && end > Number(old.offset)),
        'Inline addition overlaps existing translation');
      menu.entries.push(structuredClone(entry));
    }
    menu.entries.sort((first, second) => Number(first.offset) - Number(second.offset));
    for (const reference of change.alternatePointers ?? []) {
      const skip = reference.skip ?? 0;
      assert.ok(Number.isInteger(skip) && skip >= 0 && Number(menu.start) + skip <= Number(menu.entries[0].offset));
      assert.equal(source.readUInt16LE(Number(reference.pointerOperand)), (Number(menu.start) + skip) & 65535);
      assert.equal(source[Number(reference.bankOperand)], Number.parseInt(menu.originalBank ?? '81', 16));
      assert.ok(!menus.some(other => [other, ...(other.alternatePointers ?? [])].some(old =>
        Number(old.pointerOperand) === Number(reference.pointerOperand) || Number(old.bankOperand) === Number(reference.bankOperand))),
      'Inline pointer already registered');
      (menu.alternatePointers ??= []).push(structuredClone(reference));
    }
  }
}

export function encodeInlineLabel(entry, glyphCode) {
  for (const [character, hex] of Object.entries(entry.nativeGlyphs ?? {})) {
    assert.equal(retainedGlyphs.get(character), hex, `Unapproved native inline glyph: ${character}`);
    assert.ok(entry.translation.includes(character), `Unused native inline glyph: ${character}`);
    assert.ok(Buffer.from(entry.originalHex, 'hex').includes(Buffer.from(hex, 'hex')), `Native glyph absent from source: ${character}`);
  }
  return Buffer.concat([...entry.translation].map(character => {
    const retained = entry.nativeGlyphs?.[character];
    if (retained) return Buffer.from(retained, 'hex');
    const code = glyphCode(character);
    assert.ok(code, `Missing inline glyph: ${character}`);
    assert.ok(code.length === 2 && code[0] >= 0x1b && code[0] < 0x20,
      `Inline labels exceed the legacy glyph range: ${character}`);
    return Buffer.from(code);
  }));
}