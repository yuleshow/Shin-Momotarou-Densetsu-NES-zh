import assert from 'node:assert/strict';

export const crystalListAllocation = { start: 0x3f9000, end: 0x3fa000, hook: 0x4a0ee };

export function crystalListText(count) {
  assert.ok(Number.isInteger(count) && count >= 0 && count <= 6);
  if (count === 0) return '「已經全部收集齊了！」';
  const rows = [];
  for (let index = 0; index < count; index += 2) {
    rows.push(Array(Math.min(2, count - index)).fill('[09]').join('、'));
  }
  return `「${rows.join('\n')}」`;
}

export function patchCrystalList(source, target, glyphs, segments) {
  const { start, end, hook } = crystalListAllocation;
  assert.equal(source.subarray(hook, hook + 4).toString('hex'), '9cc612da');
  assert.deepEqual(target.subarray(hook, hook + 4), source.subarray(hook, hook + 4));
  assert.ok(target.subarray(start, end).every(byte => byte === 0xff));
  const codes = new Map(glyphs.map(glyph => [glyph.character, Buffer.from(glyph.code, 'hex')]));
  const encode = text => Buffer.concat([...text].map(character => {
    assert.ok(codes.has(character), `Missing crystal-list glyph: ${character}`);
    return codes.get(character);
  }));
  const firstName = segments.findIndex(segment => segment.hex === '09');
  assert.ok(firstName > 0);
  assert.equal(segments[firstName - 1].text, '「');
  const prefix = Buffer.concat(segments.slice(0, firstName - 1).map(segment => segment.hex
    ? Buffer.from(segment.hex, 'hex') : encode(segment.text)));
  const variants = [];
  let cursor = start + 0x200;
  for (let count = 0; count <= 6; count++) {
    const text = crystalListText(count);
    const parts = text.split(/(\[09\]|\n)/).filter(Boolean).map(part => part === '[09]'
      ? Buffer.from([9]) : part === '\n' ? Buffer.from([1]) : encode(part));
    const bytes = Buffer.concat([prefix, ...parts, Buffer.from([0])]);
    assert.ok(cursor + bytes.length <= end);
    bytes.copy(target, cursor);
    target.writeUInt16LE(cursor & 0xffff, start + 0x100 + count * 2);
    variants.push({ count, offset: cursor, text, hex: bytes.toString('hex') });
    cursor += bytes.length;
  }
  const bytes = [], labels = new Map(), branches = [];
  const emit = hex => bytes.push(...Buffer.from(hex, 'hex'));
  const label = name => labels.set(name, bytes.length);
  const branch = (opcode, name) => { bytes.push(opcode, 0); branches.push({ offset: bytes.length - 1, name }); };
  emit('0848');
  emit('adb412c913'); branch(0xd0, 'native');
  emit('adb512c9bf'); branch(0xd0, 'native');
  emit('da5a');
  emit('a200a000');
  label('count'); emit('bd9f12'); branch(0xf0, 'empty');
  emit('c8'); label('empty'); emit('e8e006'); branch(0xd0, 'count');
  emit('980aaabf0091ff85b1bf0191ff85b2a9ff85b3');
  emit('a9138d71128da712');
  emit('9cc6129caa129ca8129ca9129c89129c96129c74129c72129cb700');
  emit('7afa68286b');
  label('native'); emit('68289cc612da5cf2a084');
  for (const pending of branches) {
    const distance = labels.get(pending.name) - pending.offset - 1;
    assert.ok(distance >= -128 && distance <= 127);
    bytes[pending.offset] = distance & 255;
  }
  assert.ok(bytes.length < 0x80);
  Buffer.from(bytes).copy(target, start);
  Buffer.from('5c0090ff', 'hex').copy(target, hook);
  return { hook, start, end, variants, routineHex: Buffer.from(bytes).toString('hex'),
    fieldTable: 0x13, recordIndex: 191, nameTypesAddress: 0x129f, capacity: 6 };
}