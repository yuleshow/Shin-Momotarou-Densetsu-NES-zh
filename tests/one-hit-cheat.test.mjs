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

function execute(damage, side, enemy) {
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
    const opcode = routine[cursor++];
    if (opcode === 0x05) { accumulator |= ram[routine[cursor++]]; zero = accumulator === 0; }
    else if (opcode === 0xf0) { const displacement = routine.readInt8(cursor++); if (zero) cursor += displacement; }
    else if (opcode === 0xbd) { accumulator = ram[routine.readUInt16LE(cursor) + target]; cursor += 2; zero = accumulator === 0; }
    else if (opcode === 0xc9) zero = accumulator === routine[cursor++];
    else if (opcode === 0xa9) { accumulator = routine[cursor++]; zero = accumulator === 0; }
    else if (opcode === 0x85) ram[routine[cursor++]] = accumulator;
    else if (opcode === 0x4c) {
      assert.equal(routine.readUInt16LE(cursor), 0xd0de);
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