import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const [runner, core, candidate, fixture, output] = process.argv.slice(2);
assert.ok(output, 'Usage: verify-chinese-name-quiz.mjs RUNNER CORE CANDIDATE FIELD_STATE NEW_OUTPUT');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = JSON.parse(fs.readFileSync(path.join(candidate, 'build.json')));
const baseline = fs.readFileSync(path.join(candidate, metadata.romFilename));
assert.equal(digest(baseline), metadata.targetSha256);
assert.equal(metadata.chineseNameQuiz.questions.length, 44);
const originalState = fs.readFileSync(fixture);
const ramStart = originalState.indexOf('RAM:131072:') + 11;
assert.ok(ramStart > 11);
const target = Buffer.from(baseline);
assert.equal(target.subarray(0x1eee6, 0x1eeea).toString('hex'), '228ab385');
assert.ok(target.subarray(0x3ce400, 0x3ce500).every(byte => byte === 255));
Buffer.from('5c00e4fc', 'hex').copy(target, 0x1eee6);
Buffer.from('228ab38522d4be83c220a9f4f18506e220a9cb85082280e4fc5c13ef81', 'hex').copy(target, 0x3ce400);
Buffer.from('8ba98448abf45ea05c218084', 'hex').copy(target, 0x3ce480);
target.writeUInt16LE(65535, 0xffdc);
target.writeUInt16LE(0, 0xffde);
const checksum = target.reduce((sum, byte) => (sum + byte) & 65535, 0);
target.writeUInt16LE(checksum ^ 65535, 0xffdc);
target.writeUInt16LE(checksum, 0xffde);
fs.mkdirSync(output);
const rom = path.join(output, 'quiz-probe.sfc');
fs.writeFileSync(rom, target, { flag: 'wx' });
const run = (name, state, inputs) => {
  const directory = path.join(output, name);
  const env = { ...process.env, MOMOTARO_CHEATS: '', MOMOTARO_TRACE: '', MOMOTARO_CAPTURE_EVERY: '600' };
  delete env.MOMOTARO_SRAM_FILE;
  const result = spawnSync(runner, [core, rom, directory, '600', inputs, state], { encoding: 'utf8', env, timeout: 120000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.ok(fs.existsSync(path.join(directory, 'frame-600.ppm')), `Video stopped: ${name}`);
  return { directory, ram: fs.readFileSync(path.join(directory, 'wram-600.bin')),
    sram: fs.readFileSync(path.join(directory, 'sram.bin')), state: path.join(directory, 'state.bin') };
};
const limit = Number(process.env.MOMOTARO_QUIZ_LIMIT ?? 44);
assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 44);
const verifyText = (filename, text, x, y) => {
  const frame = fs.readFileSync(filename);
  const header = /^P6\n256 224\n255\n/.exec(frame.subarray(0, 64).toString());
  assert.ok(header);
  const pixels = frame.subarray(header[0].length);
  assert.equal(pixels.length, 256 * 224 * 3);
  assert.ok(x + [...text].length * 12 <= 256 && y + 16 <= 224);
  for (const [index, character] of [...text].entries()) {
    const glyph = metadata.glyphs.find(glyph => glyph.character === character);
    assert.ok(glyph, character);
    for (let row = 0; row < 15; row++) for (let column = 0; column < 12; column++) {
      const bit = plane => column < 8 ? (baseline[glyph.offset + plane * 23 + row] >> (7 - column)) & 1
        : (baseline[glyph.offset + plane * 23 + 15 + (row >> 1)] >> ((row % 2 ? 0 : 4) + 11 - column)) & 1;
      if (!bit(0)) continue;
      const offset = ((y + row + 1) * 256 + x + index * 12 + column) * 3;
      const brightness = Math.max(...pixels.subarray(offset, offset + 3));
      assert.ok(bit(1) ? brightness >= 140 : brightness <= 110, `Quiz glyph mismatch: ${text}, ${character} at ${column},${row}`);
    }
  }
  return { text, x, y };
};
const questions = [];
for (const question of metadata.chineseNameQuiz.questions.slice(0, limit)) {
  const state = Buffer.from(originalState);
  state[ramStart + 0x365] = question.questionIndex;
  state[ramStart + 0x367] = 1;
  state[ramStart + 0x364] = 0;
  state[ramStart + 0x195d] = 1;
  const stateFile = path.join(output, `question-${question.questionIndex}.state`);
  fs.writeFileSync(stateFile, state, { flag: 'wx' });
  const opened = run(`question-${question.questionIndex}-opened`, stateFile, '30:3:a');
  assert.equal(opened.ram[0x367], 0, 'Opening must clear a stale correct result, including before cancellation');
  assert.equal(opened.ram[0x195c], 12, 'Original event did not select quiz mode');
  assert.equal(opened.ram[0x12e3], 1, 'Original event must wait for the choice menu');
  const frame = path.join(opened.directory, 'frame-600.ppm');
  const renderedText = [verifyText(frame, question.clue, 16, 64),
    ...question.choices.map((choice, index) => verifyText(frame, choice, 24, 80 + index * 16))];
  const choices = [];
  for (let selection = 0; selection <= 4; selection++) {
    const presses = selection === 0 ? ['30:3:b'] : [
      ...Array.from({ length: selection - 1 }, (_, index) => `${30 + index * 60}:3:down`),
      `${30 + (selection - 1) * 60}:3:a`,
    ];
    const selected = run(`question-${question.questionIndex}-choice-${selection}`, opened.state, presses.join(','));
    const expected = Number(selection === question.correctPosition + 1);
    assert.equal(selected.ram[0x367], expected, `Wrong quiz result: question ${question.questionIndex}, selection ${selection}`);
    assert.equal(selected.ram[0x364], expected * 10, 'Original quiz event did not update points');
    assert.equal(selected.ram[0x12e3], 0, 'Choice menu left the original event blocked');
    assert.deepEqual(selected.ram.subarray(0x3d2a, 0x3d69), opened.ram.subarray(0x3d2a, 0x3d69), 'Persistent names changed');
    assert.deepEqual(selected.sram, opened.sram, 'Quiz modified SRAM');
    choices.push({ selection, score: selected.ram[0x367], points: selected.ram[0x364], originalEventResumed: true, videoContinued: true });
  }
  questions.push({ ...question, renderedText, choicesVerified: choices });
  console.log(`PASS quiz ${question.questionIndex}: pixels, choices, cancel, original points, names and SRAM`);
}
assert.equal(digest(fs.readFileSync(fixture)), digest(originalState));
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ baselineSha256: metadata.targetSha256,
  targetSha256: digest(target), questions, synthetic: true, nativeMode12Entry: true,
  originalFixtureSha256: digest(originalState), nativeSingleQuestionEventVerified: true,
  nativeQuizFlowVerified: false, deviceWrites: false,
  limitations: ['A local field-menu hook invokes the original CB:F1F4 answer event; question indexes and the initial point value are seeded in copies of one field state.',
    'These cases verify single-question point changes and completion events, not natural access, all round progression, final rewards or the natural background layout.'] }, null, 2) + '\n', { flag: 'wx' });