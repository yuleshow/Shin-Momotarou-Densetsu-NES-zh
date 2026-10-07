import assert from 'node:assert/strict';
import { chineseCode } from './chinese-font.mjs';

export const commandChartLabels = [
  { text: '伐折羅王', x: 14, y: 3, horizontal: true, indexes: [93, 94, 57, 41] },
  { text: '迦樓羅', x: 4, y: 7, indexes: [36, 37, 38] },
  { text: '達伊達王子', x: 12, y: 7, indexes: [39, 40, 39, 41, 42] },
  { text: '閻魔王 ', x: 22, y: 7, indexes: [43, 44, 45, 41] },
  { text: '左魂鬼', x: 2, y: 17, indexes: [46, 48, 49] },
  { text: '右魂鬼', x: 6, y: 17, indexes: [47, 48, 49] },
  { text: '三千世界', x: 9, y: 19, indexes: [50, 51, 52, 53] },
  { text: '酒吞童子', x: 12, y: 19, indexes: [54, 55, 56, 42] },
  { text: '羅生門', x: 15, y: 19, indexes: [57, 58, 59] },
  { text: '阿修羅 ', x: 19, y: 17, indexes: [60, 61, 62, 63] },
  { text: '風神', x: 22, y: 17, indexes: [64, 66] },
  { text: '雷神', x: 25, y: 17, indexes: [65, 66] },
  { text: '醜女 ', x: 28, y: 17, indexes: [61, 67, 68] },
];

export const familyChartLabels = [
  { text: '伐 折 羅 王', x: 47, y: 4, indexes: [93, 99, 94, 99, 57, 99, 41] },
  { text: '鬼子母神', x: 34, y: 5, indexes: [69, 70, 71, 72] },
  { text: '達伊達王子', x: 37, y: 14, indexes: [39, 40, 39, 41, 42] },
  { text: '夜叉姬', x: 44, y: 20, indexes: [73, 74, 75] },
  { text: '人類女子', x: 41, y: 10, indexes: [76, 77, 78, 79] },
  { text: '阿闍世王子 ', x: 50, y: 14, indexes: [95, 96, 97, 98, 41, 42] },
  { text: '月族第一公主 ', x: 55, y: 6, indexes: [80, 78, 81, 83, 84, 78, 85] },
  { text: '月族第二公主 ', x: 59, y: 6, indexes: [80, 78, 82, 83, 84, 78, 85] },
  { text: '月族 ', x: 55, y: 2, horizontal: true, indexes: [90, 91, 92] },
  { text: '輝夜姬 ', x: 55, y: 22, horizontal: true, indexes: [86, 87, 88, 89] },
];

export function patchCommandChart(source, target, characters, { familyChart = false } = {}) {
  const expect = (offset, hex) => assert.equal(source.subarray(offset, offset + hex.length / 2).toString('hex'), hex, `Chart source changed at ${offset.toString(16)}`);
  expect(0x49d66, 'bf0000c785aebf0100c785af');
  expect(0x5c7cf, 'a9028db412c210');
  expect(0x5c88d, '000000');
  const writes = [];
  const write = (offset, bytes, free = false) => {
    if (free) assert.ok(target.subarray(offset, offset + bytes.length).every(byte => byte === 0xff), 'Chart allocation overlaps data');
    bytes.copy(target, offset);
    writes.push({ offset, hex: bytes.toString('hex') });
  };
  const records = [Buffer.from([0, 0])];
  const cells = [];
  for (const label of commandChartLabels) {
    assert.equal([...label.text].length, label.indexes.length);
    for (const [index, character] of [...label.text].entries()) {
      const offset = 0x5c809 + cells.length * 3;
      const x = label.x + (label.horizontal ? index * 2 : 0);
      const y = label.y + (label.horizontal ? 0 : index * 2);
      assert.deepEqual([...source.subarray(offset, offset + 3)], [x, y, label.indexes[index]]);
      const glyph = characters.indexOf(character);
      assert.ok(character === ' ' || glyph >= 0, `Missing chart glyph: ${character}`);
      const code = character === ' ' ? [0x50] : chineseCode(glyph);
      records.push(Buffer.from([...code, 0]));
      cells.push({ character, x, y, code: Buffer.from(code).toString('hex') });
      write(offset + 2, Buffer.from([cells.length]));
    }
  }
  assert.equal(cells.length, 44);
  const familyCells = [];
  if (familyChart) {
    expect(0x5c926, '000000');
    for (const label of familyChartLabels) {
      assert.equal([...label.text].length, label.indexes.length);
      for (const [index, character] of [...label.text].entries()) {
        const offset = 0x5c890 + familyCells.length * 3;
        const x = label.x + (label.horizontal ? index * 2 : 0);
        const y = label.y + (label.horizontal ? 0 : index * 2);
        assert.deepEqual([...source.subarray(offset, offset + 3)], [x, y, label.indexes[index]]);
        const glyph = characters.indexOf(character);
        assert.ok(character === ' ' || glyph >= 0, `Missing family-chart glyph: ${character}`);
        const code = character === ' ' ? [0x50] : chineseCode(glyph);
        records.push(Buffer.from([...code, 0]));
        familyCells.push({ character, x, y, code: Buffer.from(code).toString('hex') });
        write(offset + 2, Buffer.from([cells.length + familyCells.length]));
      }
    }
    assert.equal(familyCells.length, 50);
  }
  for (const [offset, original, helper, immediate] of [
    [0x49d66, 'bf0000c7', 0x3c2200, familyChart ? '0026' : '0024'],
    [0x49d6c, 'bf0100c7', 0x3c2220, familyChart ? '26fc' : '24fc'],
  ]) {
    write(helper, Buffer.from(`08e0fa02f00628${original}6b28a9${immediate}6b`, 'hex'), true);
    const call = Buffer.from([0x22, 0, 0, 0]);
    call.writeUIntLE(helper + 0xc00000, 1, 3);
    write(offset, call);
  }
  write(0x3c2240, Buffer.from(familyChart ? 'a9ff8db4126b' : '08e002f00728a9ff8db4126b28a9028db4126b', 'hex'), true);
  write(0x5c7cf, Buffer.from('224022fcea', 'hex'));
  write(familyChart ? 0x3c2600 : 0x3c2400, Buffer.concat(records), true);
  return { messageGroup: 255, sourceTable: 0x5c809, cells, writes,
    ...(familyChart ? { familyCells, familySourceTable: 0x5c890 } : {}),
    otherChartUsesOriginalGroup: !familyChart, sharedNameFragmentsUnchanged: true };
}