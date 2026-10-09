import assert from 'node:assert/strict';
import { chineseCode } from './chinese-font.mjs';
import { nativeSaveContract } from './name-storage.mjs';
import { patchDefaultName } from './default-names.mjs';
import { splitRecords } from './text-catalog.mjs';

export const chineseNameDefaults = ['波奇', '蒙太', '琪可', '貧乏神', '小雪', '桃餅', '梅璽大閣', '粉紅蛆', '惡臭列表', '五毛黨', '梅璽閣主'];

export function defaultNameToken(mode) {
  assert.ok(Number.isInteger(mode) && mode >= 1 && mode <= 11);
  return Buffer.from([0x7f, 0x50 + mode, 0x7f, 0x7f, 0]);
}

function routine() {
  const bytes = [], labels = new Map(), branches = [];
  return {
    emit(...values) { bytes.push(...values); },
    hex(value) { bytes.push(...Buffer.from(value, 'hex')); },
    label(name) { assert.ok(!labels.has(name)); labels.set(name, bytes.length); },
    branch(opcode, label) { bytes.push(opcode, 0); branches.push({ offset: bytes.length - 1, label }); },
    finish() {
      for (const { offset, label } of branches) {
        assert.ok(labels.has(label), label);
        const distance = labels.get(label) - offset - 1;
        assert.ok(distance >= -128 && distance < 128, `Branch too far: ${label}`);
        bytes[offset] = distance & 255;
      }
      return Buffer.from(bytes);
    },
  };
}

export function patchChineseNameDefaults(source, target, characters, english) {
  assert.ok(english, 'Chinese defaults require the English naming patch');
  const contract = nativeSaveContract(source);
  assert.ok(target.subarray(0x3cc000, 0x3ce000).every(byte => byte === 255), 'Default naming allocation overlaps data');
  for (const [offset, hex] of [[0x5d1ad, '2060d4207cd5'], [0x5d278, 'ad8419c94f'], [0x58064, 'ab6b'], [0x4a5af, 'a507f00538e9178507']]) {
    assert.equal(source.subarray(offset, offset + hex.length / 2).toString('hex'), hex);
    assert.deepEqual(target.subarray(offset, offset + hex.length / 2), source.subarray(offset, offset + hex.length / 2));
  }
  assert.equal(target.subarray(0x5d59e, 0x5d5a2).toString('hex'), '5c00e1fc');
  assert.equal(target[0x4ae73], 0x22, 'Existing default-name display hook is required');
  const encode = label => Buffer.from([...label].flatMap(character => {
    const index = characters.indexOf(character);
    assert.ok(index >= 0, `Missing preset glyph: ${character}`);
    return chineseCode(index);
  }));
  const writes = [];
  const write = (offset, bytes, limit) => {
    assert.ok(!limit || offset + bytes.length <= limit, `Routine exceeds allocation: ${offset.toString(16)}`);
    bytes.copy(target, offset);
    writes.push({ offset, hex: bytes.toString('hex') });
  };
  const definitions = contract.modes.slice(0, 11).map((mode, index) => {
    const token = defaultNameToken(mode.mode);
    const expected = Buffer.concat([mode.katakana ? Buffer.from([4]) : Buffer.alloc(0), token]);
    const previousHook = Buffer.from(target.subarray(0x4ae74, 0x4ae77));
    const definition = { ...mode, label: chineseNameDefaults[index], tokenHex: token.toString('hex'),
      nameAddress: 0x7e0000 + mode.legacyAddress, originalHex: expected.toString('hex'),
      routineOffset: 0x3cc000 + index * 128, labelOffset: 0x3cc600 + index * 16,
      tail: [0x5c, ...previousHook] };
    const report = patchDefaultName(source, target, characters, definition);
    assert.ok(Buffer.from(report.writes[1].hex, 'hex').length <= 128);
    writes.push(...report.writes);
    const slots = Buffer.concat(Array.from({ length: 4 }, (_, cell) => [...definition.label][cell] ? encode([...definition.label][cell]) : Buffer.from([0x50, 0])));
    write(0x3cc800 + index * 8, slots, 0x3cc900);
    return { mode: mode.mode, address: mode.address, label: definition.label, tokenHex: definition.tokenHex };
  });
  const pointer = 'daad5c193a0aaabfecd5858506bfedd5858507a97e8508fa';
  const match = routine();
  match.hex('5adaad5c19c901'); match.branch(0x90, 'no');
  match.emit(0xc9, 12); match.branch(0xb0, 'no');
  match.hex(pointer); match.hex('a000b706c97f'); match.branch(0xd0, 'no');
  match.hex('c8ad5c19186950d706'); match.branch(0xd0, 'no');
  match.hex('c8b706c97f'); match.branch(0xd0, 'no');
  match.hex('c8b706c97f'); match.branch(0xd0, 'no');
  match.hex('c8b706'); match.branch(0xd0, 'no');
  match.hex('fa7a386b'); match.label('no'); match.hex('fa7a186b');
  write(0x3cca00, match.finish(), 0x3ccb00);

  const set = routine();
  set.hex('5ada'); set.hex(pointer);
  set.hex('ad5c19c904'); set.branch(0xb0, 'token');
  set.hex('c606a000a9049706e606');
  set.label('token'); set.hex('a000a97f9706c8ad5c191869509706c8a97f9706c89706c8a90097069c8519fa7a6b');
  write(0x3ccb00, set.finish(), 0x3ccc00);

  const draw = routine();
  draw.hex('5ada482200cafc'); draw.branch(0x90, 'legacy');
  draw.hex('adcd1248adb41248a9058dcd12af5703c08db412a3030a1869118d0b03a9028d0d032200e3fcad5c193a0a0a0a8506a3030a186506aabf00c8fcc950');
  draw.branch(0xf0, 'space');
  draw.hex('8507e8bf00c8fc8506'); draw.branch(0x80, 'render');
  draw.label('space'); draw.hex('85066407');
  draw.label('render'); draw.hex('2220e3fc688db412688dcd1268fa7a5cbcd585');
  draw.label('legacy'); draw.hex('68fa7a5c00e1fc');
  write(0x3ccc00, draw.finish(), 0x3cce00);

  const press = routine();
  press.hex('ad5c19c901'); press.branch(0x90, 'normal');
  press.emit(0xc9, 12); press.branch(0xb0, 'normal');
  press.hex('ad8419c924'); press.branch(0xf0, 'preset');
  press.emit(0xc9, 37); press.branch(0xf0, 'preset');
  press.emit(0xc9, 77); press.branch(0xb0, 'normal');
  press.hex('2200cafc'); press.branch(0x90, 'normal');
  press.hex('a000a950'); press.label('clear'); press.hex('9706c8c004'); press.branch(0x90, 'clear');
  press.hex('a90097069c85192210d2fc');
  press.label('normal'); press.hex('ad8419c94f5c7dd285');
  press.label('preset'); press.hex('2200cbfc2210d2fca9006b');
  write(0x3cce00, press.finish(), 0x3cd000);

  const initial = routine();
  initial.hex('2200d2fc5ada48ad5c19c901'); initial.branch(0x90, 'done');
  initial.emit(0xc9, 12); initial.branch(0xb0, 'done');
  initial.hex(pointer); initial.hex('a000'); initial.label('blank');
  initial.hex('b706'); initial.branch(0xf0, 'next'); initial.emit(0xc9, 0x50); initial.branch(0xd0, 'original');
  initial.label('next'); initial.hex('c8c004'); initial.branch(0x90, 'blank');
  initial.branch(0x80, 'set');
  initial.label('original'); initial.hex('2200d1fc'); initial.branch(0x90, 'done');
  initial.label('set'); initial.hex('2200cbfc');
  initial.label('done'); initial.hex('68fa7a2210d2fc6b');
  write(0x3cd000, initial.finish(), 0x3cd100);

  const legacy = routine();
  legacy.hex('daad5c19c90c'); legacy.branch(0xb0, 'no');
  legacy.hex('3a0a0a0aaaa000'); legacy.label('compare');
  legacy.hex('bf00c9fcd706'); legacy.branch(0xd0, 'no');
  legacy.emit(0xc9, 0); legacy.branch(0xf0, 'yes');
  legacy.hex('e8c8'); legacy.branch(0x80, 'compare');
  legacy.label('yes'); legacy.hex('fa386b'); legacy.label('no'); legacy.hex('fa186b');
  write(0x3cd100, legacy.finish(), 0x3cd200);
  assert.equal(source.subarray(0x4adea, 0x4adfc).toString('hex'), 'daa200bffcad849f2b3d7ee8e03e90f3fa6b');
  for (const [index, mode] of contract.modes.slice(0, 11).entries()) {
    const bytes = Buffer.alloc(8);
    const offset = 0x4adfc + mode.address - 0x3d2b;
    source.subarray(offset, offset + mode.capacity + 1).copy(bytes);
    write(0x3cc900 + index * 8, bytes, 0x3cca00);
  }
  write(0x3cd200, Buffer.from('8ba98548abf463805c60d485', 'hex'), 0x3cd210);
  write(0x3cd210, Buffer.from('8ba98548abf463805c7cd585', 'hex'), 0x3cd220);
  write(0x5d1ad, Buffer.from('2200d0fceaea', 'hex'));
  write(0x5d278, Buffer.from('5c00cefc', 'hex'));
  write(0x5d59e, Buffer.from('5c00ccfc', 'hex'));

  const records = splitRecords(target.subarray(english.textOffset + 1, english.textOffset + english.textBytes));
  const text = Buffer.concat([Buffer.from([0]), ...records.flatMap(record => {
    const bytes = Buffer.from(record.originalHex, 'hex');
    return [[202, 211].includes(record.index) ? Buffer.concat([bytes.subarray(0, 7), encode('預設'), Buffer.from([0x50])]) : bytes, Buffer.from([0])];
  })]);
  write(english.textOffset, text, 0x3d0000);
  english.textBytes = text.length;
  assert.deepEqual(nativeSaveContract(target), contract);
  return { definitions, presetKeyIndexes: [36, 37], storage: 'native-four-cell-reserved-token',
    existingCustomNamesPreserved: true, quizModeExcluded: true, naturalNameScreenVerified: false,
    runtimeVerified: false, writes };
}