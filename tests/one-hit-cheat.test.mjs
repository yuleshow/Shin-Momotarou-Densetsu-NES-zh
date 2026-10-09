import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { catalog } from '../tools/text-catalog.mjs';
import { updateOneHitCheat } from '../tools/deploy-one-hit-cheat.mjs';

const read = filename => JSON.parse(fs.readFileSync(new URL(`../${filename}`, import.meta.url)));
const source = fs.readFileSync(new URL('../assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc', import.meta.url));
const text = fs.readFileSync(new URL('../cheats/Shin Momotarou Densetsu (Traditional Chinese).cht', import.meta.url), 'utf8');
const code = JSON.parse(text.match(/^cheat10_code = (.+)$/m)[1]);
const writes = code.split('+').map(part => {
  assert.match(part, /^[0-9A-F]{8}$/);
  return { address: parseInt(part.slice(0, 6), 16), value: parseInt(part.slice(6), 16) };
});
const routine = Buffer.from(writes.slice(2).map(write => write.value));

test('Nozuchi reporting cheat meets the native fifty-defeat threshold', () => {
  const threshold = Buffer.from('9c5719a93238ef97637e90038d5719a901', 'hex');
  assert.deepEqual(source.subarray(0x4c5e3, 0x4c5e3 + threshold.length), threshold);
  const nozuchiCode = JSON.parse(text.match(/^cheat15_code = (.+)$/m)[1]);
  assert.equal(nozuchiCode, '7E639732');
  assert.equal(parseInt(nozuchiCode.slice(6), 16), source[0x4c5e7]);
  assert.match(text, /^cheat15_enable = false$/m);
  assert.match(text, /^cheat15_handler = 0$/m);
  assert.doesNotMatch(text, /apply once then disable before battle|through one Nozuchi defeat/);
});

test('one-hit exception targets the ordinary tail lizard and fits one cheat item', () => {
  const manifest = read('opening-preview-v60/resolved-translation-manifest.json');
  const names = catalog(source, manifest, read('translations/opening.zh-Hant.json')).blocks.find(block => block.pointerOffset === '0x7000f');
  assert.equal(names.records[25].translation, '蜥蜴');
  assert.equal(names.records[26].translation, '金蜥蜴');
  assert.ok(code.length <= 255);
  assert.match(text, /^cheat10_enable = false$/m);
  assert.match(text, /^cheat10_handler = 0$/m);
  assert.deepEqual(writes.slice(0, 2), [{ address: 0x82d09c, value: 0x40 }, { address: 0x82d09d, value: 0xfe }]);
  assert.deepEqual(writes.slice(2).map(write => write.address), Array.from({ length: 25 }, (_, index) => 0x82fe40 + index));
  assert.equal(routine.toString('hex'), '0510f012bde519f00dbdd519c919f006a9ff850f85104cded0');
});

test('one-hit hook receives damage in A and tail-calls the untouched immunity routine', () => {
  for (const filename of ['assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc',
    'opening-preview-v56/opening-zh-Hant.sfc', 'opening-preview-v60/opening-zh-Hant.sfc']) {
    const rom = fs.readFileSync(new URL(`../${filename}`, import.meta.url));
    assert.equal(rom.subarray(0x2d092, 0x2d0a0).toString('hex'), 'c22068850fe220b01a20ded0b015');
    assert.ok(rom.subarray(0x2fe40, 0x2fe59).every(byte => byte === 255));
    assert.deepEqual(rom.subarray(0x2d0de, 0x2d104), source.subarray(0x2d0de, 0x2d104));
  }
});

function execute(damage, side, enemy, instructions = routine) {
  const ram = new Uint8Array(65536);
  const target = 3;
  ram[0x0f] = damage & 255;
  ram[0x10] = damage >> 8;
  ram[0x19e5 + target] = side;
  ram[0x19d5 + target] = enemy;
  let accumulator = damage & 255;
  let zero = accumulator === 0;
  let cursor = 0;
  for (let steps = 0; steps < 20; steps++) {
    const opcode = instructions[cursor++];
    if (opcode === 0x05) { accumulator |= ram[instructions[cursor++]]; zero = accumulator === 0; }
    else if (opcode === 0x09) { accumulator |= instructions[cursor++]; zero = accumulator === 0; }
    else if (opcode === 0xf0 || opcode === 0xd0) {
      const displacement = instructions.readInt8(cursor++);
      if (opcode === 0xf0 ? zero : !zero) cursor += displacement;
    }
    else if (opcode === 0xbd) { accumulator = ram[instructions.readUInt16LE(cursor) + target]; cursor += 2; zero = accumulator === 0; }
    else if (opcode === 0xc9) zero = accumulator === instructions[cursor++];
    else if (opcode === 0xa9) { accumulator = instructions[cursor++]; zero = accumulator === 0; }
    else if (opcode === 0x85) ram[instructions[cursor++]] = accumulator;
    else if (opcode === 0x4c) {
      assert.equal(instructions.readUInt16LE(cursor), 0xd0de);
      return ram[0x0f] + (ram[0x10] << 8);
    } else assert.fail(`Unexpected opcode: ${opcode}`);
  }
  assert.fail('Routine did not return to native immunity check');
}

test('one-hit routine preserves all lizard and ally damage and only boosts nonzero enemy damage', () => {
  for (const damage of [0, 1, 13, 255, 256, 10000, 65535]) {
    for (let enemy = 1; enemy <= 247; enemy++) {
      assert.equal(execute(damage, 0, enemy), damage);
      for (const side of [1, 2, 15]) assert.equal(execute(damage, side, enemy), enemy === 25 || damage === 0 ? damage : 65535);
    }
  }
});

test('one-hit deployment preserves quoted toggles, other fields and CRLF bytes', () => {
  const before = '# keep\r\ncheats = "3"\r\ncheat2_desc = "One-hit defeat old"\r\ncheat2_code = "OLD"\r\ncheat2_enable = "true"\r\ncheat2_handler = "0"\r\ncheat0_code = "UNCHANGED"\r\ncheat2_rumble_type = "4"\r\n';
  const update = { previousCode: 'OLD', code, description: 'One-hit defeat except normal lizard (tail)' };
  assert.equal(updateOneHitCheat(before, update), before.replace('One-hit defeat old', update.description).replace('"OLD"', JSON.stringify(code)));
  assert.throws(() => updateOneHitCheat(before.replace('"OLD"', '"UNKNOWN"'), update), /exactly one/);
  assert.throws(() => updateOneHitCheat(`${before}cheat1_code = "OLD"\r\n`, update), /exactly one/);
  assert.throws(() => updateOneHitCheat(`${before}cheat2_enable = false\r\n`, update), /Duplicate/);
  assert.throws(() => updateOneHitCheat(before.replace('cheat2_handler = "0"', 'cheat2_handler = "1"'), update));
});

test('Mankin recovery item only boosts hero healing during the native recovery contest', () => {
  const manifest = read('opening-preview-v60/resolved-translation-manifest.json');
  const names = catalog(source, manifest, read('translations/opening.zh-Hant.json')).blocks.find(block => block.pointerOffset === '0x7000f');
  for (const enemy of [244, 245]) assert.equal(names.records[enemy].translation, '萬金仙人');
  const mankinCode = JSON.parse(text.match(/^cheat16_code = (.+)$/m)[1]);
  assert.ok(mankinCode.length <= 255);
  assert.match(text, /^cheats = 17$/m);
  assert.match(text, /^cheat16_enable = false$/m);
  assert.match(text, /^cheat16_handler = 0$/m);
  const parts = mankinCode.split('+');
  assert.deepEqual(parts.slice(0, 2), ['82D03860', '82D039FE']);
  const instructions = Buffer.from(parts.slice(2).map((part, index) => {
    assert.match(part, /^[0-9A-F]{8}$/);
    assert.equal(parseInt(part.slice(0, 6), 16), 0x82fe60 + index);
    return parseInt(part.slice(6), 16);
  }));
  assert.equal(instructions.toString('hex'), 'adb819f00dae531fd008a9ff8dc81f8dc91f4c64d0');
  assert.ok(source.subarray(0x2fe60, 0x2fe60 + instructions.length).every(byte => byte === 255));
  assert.equal(source.subarray(0x292c2, 0x292c9).toString('hex'), 'c9f4d003eeb819');
  assert.equal(source.subarray(0x2d037, 0x2d063).toString('hex'),
    '2064d0c220adc81f48e22020d6cfc220adc81f851e688dc81fc51e900aa51e8dc81fe22020edd1e22020c4cf');
  assert.ok(parts.every(part => !writes.some(write => write.address === parseInt(part.slice(0, 6), 16))));
  for (const amount of [0, 1, 255, 256, 10000, 65535]) {
    for (const training of [0, 1, 2, 255]) {
      for (let target = 0; target < 16; target++) {
        const ram = Buffer.alloc(65536, 0x5a);
        ram[0x19b8] = training;
        ram[0x1f53] = target;
        ram.writeUInt16LE(amount, 0x1fc8);
        const expected = Buffer.from(ram);
        if (training && target === 0) expected.writeUInt16LE(65535, 0x1fc8);
        let accumulator = 0;
        let zero = false;
        let cursor = 0;
        let returned = false;
        for (let steps = 0; steps < 12; steps++) {
          const opcode = instructions[cursor++];
          if (opcode === 0xad || opcode === 0xae) {
            const value = ram[instructions.readUInt16LE(cursor)];
            cursor += 2;
            if (opcode === 0xad) accumulator = value;
            zero = value === 0;
          } else if (opcode === 0xf0 || opcode === 0xd0) {
            const displacement = instructions.readInt8(cursor++);
            if (opcode === 0xf0 ? zero : !zero) cursor += displacement;
          } else if (opcode === 0xa9) {
            accumulator = instructions[cursor++];
            zero = accumulator === 0;
          } else if (opcode === 0x8d) {
            ram[instructions.readUInt16LE(cursor)] = accumulator;
            cursor += 2;
          } else if (opcode === 0x4c) {
            assert.equal(instructions.readUInt16LE(cursor), 0xd064);
            returned = true;
            break;
          } else assert.fail(`Unexpected recovery opcode: ${opcode}`);
        }
        assert.ok(returned, 'Must tail-call native HP addition and return to its maximum clamp');
        assert.deepEqual(ram, expected, 'Only the guarded recovery amount may change');
      }
    }
  }
});