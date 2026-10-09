import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { encodeEnglishName, nativeSaveContract, readLegacySaveSlot } from '../tools/name-storage.mjs';
import { patchEnglishNameEntry } from '../tools/english-name-entry.mjs';
import { renderRecord, splitRecords } from '../tools/text-catalog.mjs';
import { decodeGlyph } from '../tools/font-codec.mjs';
import { chineseQuizChoices, chineseQuizResult, encodeChineseQuiz, patchChineseNameQuiz } from '../tools/name-quiz.mjs';
import { chineseNameDefaults, defaultNameToken, patchChineseNameDefaults } from '../tools/default-name-entry.mjs';
import { patchDefaultMonta, patchDefaultPochi, patchDefaultKiko } from '../tools/default-names.mjs';
import { chineseCode } from '../tools/chinese-font.mjs';

const rom = fs.readFileSync(new URL('../assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc', import.meta.url));

test('legacy kana diacritic outlines replace underlying ink in source previews', () => {
  let coveredInk = 0;
  for (const katakana of [false, true]) for (let index = 0; index < 24; index++) {
    const base = decodeGlyph(rom, katakana ? 5 : 2, rom[0x4a949 + index]);
    const marks = decodeGlyph(rom, katakana ? 6 : 3, index);
    const rendered = renderRecord(rom, Buffer.from([katakana ? 4 : 3, 0xd0 + index]), []);
    const header = Buffer.from('P5\n304 36\n255\n');
    assert.deepEqual(rendered.subarray(0, header.length), header);
    for (let pixel = 0; pixel < 192; pixel++) {
      const offset = header.length + (8 + Math.floor(pixel / 12)) * 304 + 8 + pixel % 12;
      if ((base[pixel] & 2) && marks[pixel] === 1) {
        coveredInk++;
        assert.equal(rendered[offset], 255, 'Mark outline must clear base ink');
      }
      if (marks[pixel] === 3) assert.equal(rendered[offset], 0, 'Mark ink must remain visible');
    }
  }
  assert.ok(coveredInk > 0, 'The test must exercise overlapping outline and ink');
});

test('Chinese quiz covers all original question slots with four unique choices and strict scoring', () => {
  const draft = JSON.parse(fs.readFileSync(new URL('../translations/name-quiz.zh-Hant.json', import.meta.url)));
  for (let questionIndex = 0; questionIndex < 44; questionIndex++) {
    for (let correctPosition = 0; correctPosition < 4; correctPosition++) {
      const question = chineseQuizChoices(rom, draft, questionIndex, correctPosition);
      assert.equal(question.choices[correctPosition], draft.questions[questionIndex].answer);
      assert.equal(new Set(question.choices).size, 4);
      for (let selection = 0; selection <= 5; selection++) {
        assert.equal(chineseQuizResult(question, selection), Number(selection === correctPosition + 1));
      }
      for (const selection of [NaN, undefined, '1', -1, 1.5]) assert.equal(chineseQuizResult(question, selection), 0);
    }
  }
  assert.throws(() => chineseQuizChoices(rom, draft, 44, 0));
  const changed = Buffer.from(rom);
  changed[0x5daa6] ^= 1;
  assert.throws(() => chineseQuizChoices(changed, draft, 0, 0));
});

test('Chinese quiz encodes native menus with scheduler-compatible callback banks', () => {
  const draft = JSON.parse(fs.readFileSync(new URL('../translations/name-quiz.zh-Hant.json', import.meta.url)));
  const characters = [...new Set(draft.questions.flatMap(question => [...question.clue, ...question.answer]))];
  const questions = encodeChineseQuiz(rom, draft, characters, 0xbca080);
  assert.equal(questions.length, 44);
  for (const [index, question] of questions.entries()) {
    assert.equal(question.menuBytes.subarray(0, 7).toString('hex'), '3201073880a0bc');
    assert.equal(question.menuBytes.at(-1), 0);
    assert.equal(question.clueBytes.length, [...question.clue].length * 2 + 1);
    assert.equal(question.clueBytes.at(-1), 0);
    assert.equal(question.correctPosition, index % 4);
  }
  for (const address of [0xfca080, 0x7ea080, 0xbc0080, NaN]) {
    assert.throws(() => encodeChineseQuiz(rom, draft, characters, address), /low-WRAM/);
  }
  assert.throws(() => encodeChineseQuiz(rom, draft, [], 0xbca080), /Missing quiz glyph/);
  const extendedCharacters = [...Array(1088).fill(null), ...characters];
  const extended = encodeChineseQuiz(rom, draft, extendedCharacters, 0xbca080);
  assert.equal(extended[0].menuBytes.subarray(7, 11).toString('hex'), '21432400');
});

test('Chinese quiz hooks only transient input and preserves question selection and save contracts', () => {
  const draft = JSON.parse(fs.readFileSync(new URL('../translations/name-quiz.zh-Hant.json', import.meta.url)));
  const characters = [...new Set(draft.questions.flatMap(question => [...question.clue, ...question.answer]))];
  const target = Buffer.alloc(0x400000, 255);
  rom.copy(target);
  const report = patchChineseNameQuiz(rom, target, characters, draft);
  assert.equal(report.questions.length, 44);
  assert.equal(report.callbackAddress, '0xbca080');
  assert.equal(target.subarray(0x3ca000, 0x3ca010).toString('hex'), 'ad5c19c90cf009c220a976d15c69d185');
  assert.deepEqual(nativeSaveContract(target), nativeSaveContract(rom));
  assert.deepEqual(target.subarray(0x5d9f7, 0x5da21), rom.subarray(0x5d9f7, 0x5da21));
  assert.deepEqual(target.subarray(0x5da6a, 0x5daa6), rom.subarray(0x5da6a, 0x5daa6));
  assert.deepEqual(target.subarray(0x4bbc6, 0x4bbe2), rom.subarray(0x4bbc6, 0x4bbe2));
  const completion = target.subarray(0x3ca100, 0x3ca180);
  assert.equal(completion.indexOf(rom.subarray(0x5d1d6, 0x5d1dc)), 10);
  assert.ok(completion.includes(Buffer.from('a97b22238784', 'hex')));
  assert.ok(!completion.includes(Buffer.from('22872384', 'hex')));
  for (const question of report.questions) {
    assert.equal(target.readUIntLE(question.menuOffset + 4, 3), 0xbca080);
    assert.equal(target.readUInt16LE(0x3ca200 + question.questionIndex * 4), question.menuOffset & 65535);
  }
  assert.throws(() => patchChineseNameQuiz(rom, target, characters, draft));
});

test('English input uses native single-byte glyphs and four/five-character capacity', () => {
  const { modes } = nativeSaveContract(rom);
  for (const mode of modes.slice(0, 11)) {
    assert.equal(encodeEnglishName('Ab09', mode).toString('hex'), '6162515a00');
    assert.equal(encodeEnglishName('Z 1', mode).toString('hex'), '7a50520000');
    assert.throws(() => encodeEnglishName('ABCDE', mode), /capacity/);
  }
  assert.equal(encodeEnglishName('abcde', modes[11]).toString('hex'), '616263646500');
  assert.throws(() => encodeEnglishName('ABCDEF', modes[11]), /capacity/);
  for (const text of ['', '    ', '中文', 'かな', 'Ａ', 'ß', 'A\n', 'A\0', 'A!']) {
    assert.throws(() => encodeEnglishName(text, modes[0]));
  }
  assert.throws(() => encodeEnglishName('ABCDE', { mode: 1, capacity: 5 }));
});

test('English keyboard changes emitted bytes and rows while preserving legacy names and storage', () => {
  const target = Buffer.alloc(0x400000, 255);
  rom.copy(target);
  const sourceStart = rom.readUIntLE(0x70033, 3) - 0xc00000;
  const sourceEnd = rom.readUIntLE(0x70036, 3) - 0xc00000;
  const before = splitRecords(rom.subarray(sourceStart + 1, sourceEnd));
  const result = patchEnglishNameEntry(rom, target);
  const after = splitRecords(target.subarray(result.textOffset + 1, result.textOffset + result.textBytes));
  assert.equal(after.length, 231);
  assert.equal(result.keyboardKeys.length, 85);
  assert.equal(result.keyboardKeys[0], 0x61);
  assert.equal(result.keyboardKeys[25], 0x7a);
  assert.deepEqual(result.keyboardKeys.slice(77, 80), [0x83, 0x84, 0x82]);
  assert.equal(after[199].originalHex, '616263646550666768696a');
  for (const record of before) if (!result.replacedRowIndexes.includes(record.index)) {
    assert.equal(after[record.index].originalHex, record.originalHex);
  }
  assert.deepEqual(nativeSaveContract(target), nativeSaveContract(rom));
  assert.throws(() => patchEnglishNameEntry(rom, target));
});

test('Chinese preset patch adds eleven names and a preset command without extending saved fields', () => {
  const target = Buffer.alloc(0x400000, 255);
  rom.copy(target);
  const characters = [...new Set(chineseNameDefaults.join('') + '預設')];
  patchDefaultMonta(rom, target, characters);
  patchDefaultPochi(rom, target, characters);
  patchDefaultKiko(rom, target, characters);
  const english = patchEnglishNameEntry(rom, target);
  const before = splitRecords(target.subarray(english.textOffset + 1, english.textOffset + english.textBytes));
  const report = patchChineseNameDefaults(rom, target, characters, english);
  assert.equal(report.definitions.length, 11);
  assert.deepEqual(report.definitions.map(entry => entry.label), chineseNameDefaults);
  assert.equal(report.definitions.find(entry => entry.mode === 7).label, '梅璽大閣');
  assert.equal([...'梅璽大閣'].length, 4);
  const castleLabel = Buffer.from([...'梅璽大閣'].flatMap(character => chineseCode(characters.indexOf(character))));
  const castleLabelOffset = 0x3cc600 + 6 * 16;
  assert.deepEqual(target.subarray(castleLabelOffset, castleLabelOffset + castleLabel.length), castleLabel);
  const castleCellsOffset = 0x3cc800 + 6 * 8;
  assert.deepEqual(target.subarray(castleCellsOffset, castleCellsOffset + 8), castleLabel);
  for (const [index, label] of ['粉紅蛆', '惡臭列表', '五毛黨', '梅璽閣主'].entries()) {
    const mode = index + 8;
    assert.equal(report.definitions.find(entry => entry.mode === mode).label, label);
    assert.ok([...label].length <= 4);
    const encoded = Buffer.from([...label].flatMap(character => chineseCode(characters.indexOf(character))));
    const offset = 0x3cc600 + (mode - 1) * 16;
    assert.deepEqual(target.subarray(offset, offset + encoded.length), encoded);
  }
  assert.deepEqual(report.presetKeyIndexes, [36, 37]);
  assert.equal(new Set(report.definitions.map(entry => entry.tokenHex)).size, 11);
  for (const definition of report.definitions) {
    assert.equal(definition.tokenHex, defaultNameToken(definition.mode).toString('hex'));
    assert.equal(defaultNameToken(definition.mode).length, 5);
    assert.ok(!english.keyboardKeys.includes(defaultNameToken(definition.mode)[0]));
    const originalOffset = 0x4adfc + definition.address - 0x3d2b;
    const tableOffset = 0x3cc900 + (definition.mode - 1) * 8;
    assert.deepEqual(target.subarray(tableOffset, tableOffset + 5), rom.subarray(originalOffset, originalOffset + 5));
  }
  const redraw = target.subarray(0x3ccc00, 0x3cce00);
  assert.ok(redraw.includes(Buffer.from('8507e8bf00c8fc8506', 'hex')));
  assert.ok(!redraw.includes(Buffer.from('38e917', 'hex')));
  assert.ok(redraw.includes(Buffer.from('2220e3fc', 'hex')));
  assert.throws(() => defaultNameToken(0));
  assert.throws(() => defaultNameToken(12));
  const after = splitRecords(target.subarray(english.textOffset + 1, english.textOffset + english.textBytes));
  const presetLabel = Buffer.from([...'預設'].flatMap(character => chineseCode(characters.indexOf(character))));
  for (const record of before) {
    if ([202, 211].includes(record.index)) assert.ok(Buffer.from(after[record.index].originalHex, 'hex').includes(presetLabel));
    else assert.equal(after[record.index].originalHex, record.originalHex);
  }
  assert.deepEqual(nativeSaveContract(target), nativeSaveContract(rom));
  assert.deepEqual(target.subarray(0x58000, 0x58675), rom.subarray(0x58000, 0x58675));
  assert.deepEqual(target.subarray(0x5d9f7, 0x5daa6), rom.subarray(0x5d9f7, 0x5daa6));
  assert.equal(target.subarray(0x5d1ad, 0x5d1b3).toString('hex'), '2200d0fceaea');
  assert.equal(target.subarray(0x5d278, 0x5d27c).toString('hex'), '5c00cefc');
  assert.throws(() => patchChineseNameDefaults(rom, target, characters, english), /overlaps/);
});

test('native save contract preserves three slots and locates saved name fields', () => {
  const contract = nativeSaveContract(rom);
  assert.equal(contract.payloadBytes + contract.extensionBytes, contract.slotBytes);
  assert.equal(contract.modes.length, 12);
  assert.deepEqual(contract.modes.slice(0, 3).map(mode => mode.saveOffset), [203, 209, 215]);
  assert.deepEqual(contract.modes.slice(3, 11).map(mode => mode.saveOffset), [193, 198, 225, 230, 235, 240, 245, 250]);
  assert.equal(contract.modes[11].saveOffset, null);
  assert.equal(contract.modes[11].persistent, false);
  assert.ok(contract.modes.slice(0, 11).every(mode => mode.persistent));
  const changed = Buffer.from(rom);
  changed[0x582db] ^= 1;
  assert.throws(() => nativeSaveContract(changed));
});

test('default naming must keep the native four-cell fields and exclude quiz input', () => {
  const { modes } = nativeSaveContract(rom);
  assert.deepEqual(modes.slice(0, 11).map(mode => mode.legacyBytes), [6, 6, 6, 5, 5, 5, 5, 5, 5, 5, 5]);
  for (const mode of modes.slice(0, 11)) {
    assert.equal(mode.capacity, 4);
    assert.equal(mode.persistent, true);
    assert.equal(mode.address + mode.capacity, mode.legacyAddress + mode.legacyBytes - 1);
  }
  assert.equal(modes[11].persistent, false);
  assert.equal(modes[11].address, 0x5f4a);
});

test('legacy slot reader validates original checksum and does not mutate SRAM', () => {
  const contract = nativeSaveContract(rom);
  const sram = Buffer.alloc(contract.sramBytes);
  for (let slot = 1; slot <= 3; slot++) {
    sram[0x20 + slot] = slot;
    const start = contract.slotOffsets[slot - 1];
    sram.fill(slot, start, start + contract.payloadBytes);
    sram.writeUInt16LE(slot * contract.payloadBytes, 0x22 + slot * 2);
  }
  const before = Buffer.from(sram);
  for (let slot = 1; slot <= 3; slot++) {
    const result = readLegacySaveSlot(sram, contract, slot);
    assert.equal(result.occupied, true);
    assert.equal(result.checksumValid, true);
    assert.equal(result.names[0].bytes.length, 6);
  }
  assert.deepEqual(sram, before);
  sram[contract.slotOffsets[0]] ^= 1;
  assert.equal(readLegacySaveSlot(sram, contract, 1).checksumValid, false);
  assert.throws(() => readLegacySaveSlot(sram, contract, 0));
  assert.throws(() => readLegacySaveSlot(Buffer.alloc(8191), contract, 1));
});