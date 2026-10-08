import assert from 'node:assert/strict';
import { chineseCode } from './chinese-font.mjs';

export function patchChineseNameQuiz(source, target, characters, draft) {
  assert.equal(target.length, 0x400000);
  assert.equal(source.subarray(0xae21, 0xae32).toString('hex'), 'bd9905856548abbd19058563bd59058564');
  assert.equal(source.subarray(0x4bbaa, 0x4bbbb).toString('hex'), '5309440a640b5a0c4e0e490d3e0f2d1000');
  assert.ok(target.subarray(0x3ca000, 0x3cc000).every(byte => byte === 255), 'Quiz allocation overlaps existing data');
  const hooks = [
    { offset: 0x5d164, expected: 'c220a976d1', replacement: '5c00a0fcea' },
    { offset: 0x5da21, expected: 'da', replacement: '6b' },
    { offset: 0x4bb5b, expected: '64072039bb', replacement: '5c80a1fcea' },
  ];
  for (const hook of hooks) {
    const expected = Buffer.from(hook.expected, 'hex');
    assert.deepEqual(source.subarray(hook.offset, hook.offset + expected.length), expected);
    assert.deepEqual(target.subarray(hook.offset, hook.offset + expected.length), expected);
  }
  const questions = encodeChineseQuiz(source, draft, characters, 0xbca080);
  const writes = [
    ...hooks.map(hook => ({ offset: hook.offset, bytes: Buffer.from(hook.replacement, 'hex') })),
    { offset: 0x3ca000, bytes: Buffer.from('ad5c19c90cf009c220a976d15c69d1859c6703ad65030aaabfa6da858d6a03bfa7da858d6b03c220ad650329ff000a0aaabf00a2fc85b9e220a9fc85bb22b8af84c220a900a1850fe220a9bc8511a930850d2224ac806b', 'hex') },
    { offset: 0x3ca080, bytes: Buffer.from('ad650329031acde412d007a9018d670380039c67035c0db084', 'hex') },
    { offset: 0x3ca100, bytes: Buffer.from('ade312f0016ba98448aba96d22238784c220a9f38d850fe220a983851122c3ad80a98448aba97b222387842235ad806b', 'hex') },
    { offset: 0x3ca180, bytes: Buffer.from('640722d0a1fc8506c921f0045c74bb8422d0a1fcc943f00e22e0a1fc8506a9ff85075c90bb8422d0a1fc850722d0a1fc85065c90bb84', 'hex') },
    { offset: 0x3ca1d0, bytes: Buffer.from('8ba98448abf45ea05c39bb84', 'hex') },
    { offset: 0x3ca1e0, bytes: Buffer.from('8b48a98448ab68f45ea05c91bb84', 'hex') },
  ];
  let cursor = 0x3ca300;
  const report = [];
  for (const question of questions) {
    const menuOffset = cursor;
    writes.push({ offset: cursor, bytes: question.menuBytes });
    cursor += question.menuBytes.length;
    const clueOffset = cursor;
    writes.push({ offset: cursor, bytes: question.clueBytes });
    cursor += question.clueBytes.length;
    const pointers = Buffer.alloc(4);
    pointers.writeUInt16LE(menuOffset & 65535, 0);
    pointers.writeUInt16LE(clueOffset & 65535, 2);
    writes.push({ offset: 0x3ca200 + question.questionIndex * 4, bytes: pointers });
    report.push({ questionIndex: question.questionIndex, clue: question.clue, choices: question.choices,
      correctPosition: question.correctPosition, menuOffset, clueOffset });
  }
  assert.ok(cursor <= 0x3cc000, 'Quiz data exceeds allocation');
  const sorted = [...writes].sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < sorted.length; index++) {
    assert.ok(sorted[index - 1].offset + sorted[index - 1].bytes.length <= sorted[index].offset, 'Quiz writes overlap');
  }
  for (const write of writes) write.bytes.copy(target, write.offset);
  assert.deepEqual(target.subarray(0x58000, 0x58675), source.subarray(0x58000, 0x58675));
  assert.deepEqual(target.subarray(0x5d9f7, 0x5da21), source.subarray(0x5d9f7, 0x5da21));
  return { type: draft.type, questions: report, callbackAddress: '0xbca080',
    writes: writes.map(write => ({ offset: write.offset, hex: write.bytes.toString('hex') })),
    originalQuestionSelectionPreserved: true, sramFormatChanged: false,
    naturalQuizFlowVerified: false, released: false };
}

export function encodeChineseQuiz(source, draft, characters, callbackAddress) {
  assert.ok(Number.isInteger(callbackAddress) && callbackAddress >= 0x808000 && callbackAddress <= 0xbfffff
    && (callbackAddress & 0xffff) >= 0x8000, 'Native task callback requires a low-WRAM-mapped HiROM mirror');
  const callback = Buffer.alloc(3);
  callback.writeUIntLE(callbackAddress, 0, 3);
  const encode = text => Buffer.from([...text].flatMap(character => {
    const index = characters.indexOf(character);
    assert.ok(index >= 0, `Missing quiz glyph: ${character}`);
    return chineseCode(index);
  }));
  const encodeMenu = text => Buffer.concat([...text].map(character => {
    const code = encode(character);
    return code[0] < 0x20 ? code : Buffer.concat([Buffer.from([0x21, 0x43]), code]);
  }));
  return draft.questions.map((entry, questionIndex) => {
    const question = chineseQuizChoices(source, draft, questionIndex, questionIndex % 4);
    return {
      ...question,
      clueBytes: Buffer.concat([encode(question.clue), Buffer.from([0])]),
      menuBytes: Buffer.concat([
        Buffer.from('32010738', 'hex'), callback, encodeMenu(question.clue), Buffer.from([1]),
        ...question.choices.map(choice => Buffer.concat([Buffer.from('213e', 'hex'), encodeMenu(choice), Buffer.from([1])])),
        Buffer.from([0]),
      ]),
    };
  });
}

export function chineseQuizChoices(source, draft, questionIndex, correctPosition) {
  assert.equal(draft.type, 'chinese-multiple-choice');
  assert.equal(draft.questions.length, 44);
  for (const [index, question] of draft.questions.entries()) {
    assert.equal(question.group, source[0x5daa6 + index * 2]);
    assert.equal(question.index, source[0x5daa7 + index * 2]);
    assert.ok(typeof question.answer === 'string' && [...question.answer].length >= 1 && [...question.answer].length <= 5);
    assert.ok(typeof question.clue === 'string' && [...question.clue].length <= 14);
  }
  assert.ok(Number.isInteger(questionIndex) && questionIndex >= 0 && questionIndex < 44);
  assert.ok(Number.isInteger(correctPosition) && correctPosition >= 0 && correctPosition < 4);
  const question = draft.questions[questionIndex];
  const candidates = [...draft.questions.slice(questionIndex + 1), ...draft.questions.slice(0, questionIndex)];
  const distractors = [];
  for (const candidate of candidates) {
    if (candidate.answer === question.answer || distractors.includes(candidate.answer)) continue;
    if (candidate.answer.includes(question.answer) || question.answer.includes(candidate.answer)) continue;
    distractors.push(candidate.answer);
    if (distractors.length === 3) break;
  }
  assert.equal(distractors.length, 3);
  const choices = [...distractors];
  choices.splice(correctPosition, 0, question.answer);
  assert.equal(new Set(choices).size, 4);
  return { questionIndex, clue: question.clue, choices, correctPosition };
}

export function chineseQuizResult(question, selection) {
  assert.ok(Number.isInteger(question.correctPosition) && question.correctPosition >= 0 && question.correctPosition < 4);
  return Number.isInteger(selection) && selection >= 1 && selection <= 4 && selection === question.correctPosition + 1 ? 1 : 0;
}