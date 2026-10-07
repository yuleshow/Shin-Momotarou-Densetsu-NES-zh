import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const [runner, core, candidate, baseline, fixture, output, ...options] = process.argv.slice(2);
assert.ok(output, 'Usage: verify-quiz-menus.mjs RUNNER CORE CANDIDATE BASELINE FIELD_STATE NEW_OUTPUT [--all-questions]');
assert.ok(options.length === 0 || (options.length === 1 && options[0] === '--all-questions'), 'Invalid quiz verification option');
const read = filename => JSON.parse(fs.readFileSync(filename));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = fs.readFileSync(new URL('../assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc', import.meta.url));
const definition = read(new URL('../translations/quiz-menus.json', import.meta.url));
const metadata = read(path.join(candidate, 'build.json'));
const previous = read(path.join(baseline, 'build.json'));
const target = fs.readFileSync(path.join(candidate, metadata.romFilename));
const before = fs.readFileSync(path.join(baseline, previous.romFilename));
const fixtureHash = hash(fs.readFileSync(fixture));
assert.equal(hash(source), definition.sourceSha256);
assert.equal(hash(target), metadata.targetSha256);
assert.equal(hash(before), previous.targetSha256);
assert.deepEqual(metadata.glyphs, previous.glyphs);
for (const bytes of [before, target]) {
  assert.deepEqual(bytes.subarray(0x5e312, 0x5e500), source.subarray(0x5e312, 0x5e500));
  assert.equal(bytes.subarray(0x5dd21, 0x5dd2b).toString('hex'), 'ade4128d57195c0db084');
}
fs.mkdirSync(output);

function probe(bytes, bank, question, name) {
  const rom = Buffer.from(bytes);
  assert.equal(rom.subarray(0x1eee6, 0x1eeea).toString('hex'), '228ab385');
  assert.ok(rom.subarray(0x23e000, 0x23e080).every(byte => byte === 255));
  Buffer.from('5c00e0e3', 'hex').copy(rom, 0x1eee6);
  Buffer.from('228ab38522d4be832212e3855c13ef81', 'hex').copy(rom, 0x23e000);
  for (const [start, end] of [[0x5dc5d, 0x5dc64], [0x5e3a4, 0x5e3b0], [0x5e3e1, 0x5e3f0]]) {
    const offset = rom.indexOf(Buffer.from('ad0603', 'hex'), start);
    assert.ok(offset >= start && offset + 3 <= end);
    Buffer.from([0xa9, bank ? 0x70 : 0, 0xea]).copy(rom, offset);
  }
  assert.equal(rom.subarray(0x5e3c1, 0x5e3c7).toString('hex'), 'a92b22a4bb80');
  Buffer.from([0xa9, question, 0xea, 0xea, 0xea, 0xea]).copy(rom, 0x5e3c1);
  rom.writeUInt16LE(65535, 0xffdc);
  rom.writeUInt16LE(0, 0xffde);
  const checksum = rom.reduce((sum, byte) => (sum + byte) & 65535, 0);
  rom.writeUInt16LE(checksum ^ 65535, 0xffdc);
  rom.writeUInt16LE(checksum, 0xffde);
  const filename = path.join(output, `${name}.sfc`);
  fs.writeFileSync(filename, rom, { flag: 'wx' });
  return filename;
}

function run(filename, name, inputs, state, frames) {
  const directory = path.join(output, name);
  const result = spawnSync(runner, [core, filename, directory, String(frames), inputs, state], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, MOMOTARO_CHEATS: '', MOMOTARO_TRACE: '', MOMOTARO_CAPTURE_EVERY: String(frames) },
  });
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  return { directory, state: path.join(directory, 'state.bin'),
    ram: fs.readFileSync(path.join(directory, `wram-${frames}.bin`)),
    frame: fs.readFileSync(path.join(directory, `frame-${frames}.ppm`)) };
}

function pixels(frame) {
  const header = /^P6\n256 224\n255\n/.exec(frame.subarray(0, 64).toString());
  assert.ok(header);
  assert.equal(frame.length, header[0].length + 256 * 224 * 3);
  return frame.subarray(header[0].length);
}

function labelMatches(frame, text, x, y) {
  const image = pixels(frame);
  return [...text].every((character, index) => {
    const glyph = metadata.glyphs.find(item => item.character === character);
    assert.ok(glyph, character);
    for (let row = 0; row < 15; row++) for (let column = 0; column < 12; column++) {
      let pixel = 0;
      for (let plane = 0; plane < 2; plane++) {
        const byte = column < 8 ? glyph.offset + plane * 23 + row : glyph.offset + plane * 23 + 15 + (row >> 1);
        const shift = column < 8 ? 7 - column : (row % 2 === 0 ? 4 : 0) + 11 - column;
        pixel |= ((target[byte] >> shift) & 1) << plane;
      }
      if (!(pixel & 1)) continue;
      const offset = ((y + row + 1) * 256 + x + index * 12 + column) * 3;
      const brightness = Math.max(...image.subarray(offset, offset + 3));
      if (pixel & 2 ? brightness < 140 : brightness > 110) return false;
    }
    return true;
  });
}

function comparePanels(original, translated, bank) {
  const originalPixels = pixels(original), translatedPixels = pixels(translated);
  const labels = [{ text: '選擇', x: 48, y: 128, width: bank ? 24 : 36 }, { text: '分數', x: 48, y: 96, width: 24 }];
  for (const label of labels) {
    assert.ok(labelMatches(translated, label.text, label.x, label.y), `Missing translated heading: ${label.text}`);
    assert.ok(!labelMatches(original, label.text, label.x, label.y), `Heading negative control: ${label.text}`);
  }
  const panels = [{ x: 8, y: 16, width: 240, height: 72 }, { x: 40, y: 88, width: 64, height: 32 },
    { x: 8, y: 120, width: 160, height: 80 }];
  let outsidePanelChangedPixels = 0;
  for (let row = 0; row < 224; row++) for (let column = 0; column < 256; column++) {
    if (labels.some(label => column >= label.x && column < label.x + label.width && row >= label.y && row < label.y + 16)) continue;
    const offset = (row * 256 + column) * 3;
    if (originalPixels.subarray(offset, offset + 3).equals(translatedPixels.subarray(offset, offset + 3))) continue;
    assert.ok(!panels.some(panel => column >= panel.x && column < panel.x + panel.width && row >= panel.y && row < panel.y + panel.height),
      `Quiz panel changed outside headings at ${column},${row}`);
    outsidePanelChangedPixels++;
  }
  return { labels, panels, outsidePanelChangedPixels };
}

function compareGameData(original, translated) {
  assert.equal(source.subarray(0x1b45b, 0x1b477).toString('hex'),
    'ad8218c22029ff0085000a0a6500690000852ae220a90069c0852c60');
  if (original[0x1882] !== translated[0x1882]) {
    assert.ok([0x19, 0x76].includes(original[0x1882]) && [0x19, 0x76].includes(translated[0x1882]), 'Unexpected native event selector');
  }
  for (const [start, end] of [[0x160b, 0x187f], [0x1880, 0x1882], [0x1883, 0x1940], [0x151d, 0x1520]]) {
    assert.deepEqual(translated.subarray(start, end), original.subarray(start, end));
  }
  return [...Array.from({ length: 11 }, (_, index) => 0x1600 + index), 0x187f]
    .filter(address => original[address] !== translated[address])
    .map(address => ({ address, before: original[address], after: translated[address] }));
}

const report = { targetSha256: metadata.targetSha256, baselineSha256: previous.targetSha256, fixtureSha256: fixtureHash,
  runnerSha256: hash(fs.readFileSync(runner)), coreSha256: hash(fs.readFileSync(core)),
  deviceModified: false, syntheticControllerEntry: true, answerKeysAndCallbackUnchanged: true, questions: [], progressions: [],
  limitations: ['Quiz entered through a test-only field hook, not natural NPC traversal.',
    'Question randomization and bank context forced only in probe ROMs; production selection, scoring and progression code remains original.',
    'Five-round score accumulation is checked, but native cleanup returns to a black screen without the NPC caller; closing feedback and rewards are not verified.',
    '7E1882 is the guarded 81B45B five-byte event-table selector. Only the observed 19/76 scene-event mismatch is allowed, both during questions and after cleanup; values are recorded separately.',
    'Only documented gameplay RAM ranges are compared. Unclassified scene-object RAM and outside-panel pixel differences are recorded, not claimed identical.'] };
const questions = options.includes('--all-questions') ? Array.from({ length: 44 }, (_, index) => index) : [12];
for (const bank of [0, 1]) for (const question of questions) {
  const answer = source[(bank ? 0x5e453 : 0x5e427) + question];
  assert.ok(answer >= 1 && answer <= 3);
  const variants = [before, target].map((bytes, index) => {
    const name = `${bank}-${question}-${index ? 'target' : 'baseline'}`;
    const filename = probe(bytes, bank, question, name);
    return { name, filename, opened: run(filename, `${name}-open`, '30:3:a', fixture, 1800) };
  });
  for (const variant of variants) {
    assert.equal(variant.opened.ram[0x368], 0);
    assert.equal(variant.opened.ram[0x36a], 1);
    assert.equal(variant.opened.ram[0x1fcf], question * 4);
    assert.equal(variant.opened.ram[0x12b4], 16 + bank);
    assert.deepEqual([...variant.opened.ram.subarray(0x356, 0x359)], [1, 2, 3].map(choice => question * 4 + choice));
  }
  const panels = comparePanels(variants[0].opened.frame, variants[1].opened.frame, bank);
  const cases = [];
  for (const selection of [1, 2, 3, 0]) {
    const inputs = selection ? [...Array.from({ length: selection - 1 }, (_, index) => `${30 + index * 60}:3:down`), '240:3:a'].join(',') : '30:3:b';
    const results = variants.map(variant => run(variant.filename, `${variant.name}-choice-${selection}`, inputs, variant.opened.state, 600));
    for (const result of results) {
      assert.equal(result.ram[0x1957], selection);
      assert.equal(result.ram[0x368], selection === answer ? 20 : 0);
      assert.equal(result.ram[0x36a], selection ? 2 : 1);
      if (!selection) assert.ok(labelMatches(result.frame, '選擇', 48, 128) || result === results[0]);
    }
    cases.push({ selection, correct: selection === answer, score: results[1].ram[0x368], round: results[1].ram[0x36a],
      unclassifiedRamDifferences: compareGameData(results[0].ram, results[1].ram),
      nativeEventSelectors: results.map(result => result.ram[0x1882]) });
  }
  const image = `${bank}-${question}.png`;
  assert.equal(spawnSync('magick', [path.join(variants[1].opened.directory, 'frame-1800.ppm'), path.join(output, image)]).status, 0);
  report.questions.push({ bank: 16 + bank, question, answer, ...panels, cases, image });
  console.log(`PASS quiz bank ${16 + bank}, question ${question}: layout, three selections, scoring, B ignored`);
  if (question === 12) for (const correctCount of [0, 4, 5]) {
    let states = variants.map(variant => variant.opened.state);
    const rounds = [];
    const numericImages = [];
    for (let round = 1; round <= 5; round++) {
      const selection = round <= correctCount ? answer : answer % 3 + 1;
      const inputs = [...Array.from({ length: selection - 1 }, (_, index) => `${30 + index * 60}:3:down`), '240:3:a'].join(',');
      const results = variants.map((variant, index) => run(variant.filename,
        `${variant.name}-game-${correctCount}-round-${round}`, inputs, states[index], 1800));
      const score = Math.min(round, correctCount) * 20;
      for (const result of results) {
        assert.equal(result.ram[0x1957], selection);
        assert.equal(result.ram[0x368], score);
        assert.equal(result.ram[0x36a], Math.min(round + 1, 5));
      }
      const panels = round < 5 ? comparePanels(results[0].frame, results[1].frame, bank) : null;
      if (round < 5 && correctCount === 5) {
        const image = `${bank}-score-${score}.png`;
        assert.equal(spawnSync('magick', [path.join(results[1].directory, 'frame-1800.ppm'), path.join(output, image)]).status, 0);
        const screen = pixels(results[1].frame);
        numericImages.push(hash(Buffer.concat(Array.from({ length: 16 }, (_, row) => {
          const offset = ((96 + row) * 256 + 80) * 3;
          return screen.subarray(offset, offset + 16 * 3);
        }))));
      }
      rounds.push({ round, selection, score, panels,
        unclassifiedRamDifferences: compareGameData(results[0].ram, results[1].ram),
        nativeEventSelectors: results.map(result => result.ram[0x1882]) });
      states = results.map(result => result.state);
    }
    if (correctCount === 5) assert.equal(new Set(numericImages).size, 4, 'Score digits failed to change at 20/40/60/80');
    report.progressions.push({ bank: 16 + bank, finalScore: correctCount * 20, rounds });
    console.log(`PASS quiz bank ${16 + bank}: five-round final score ${correctCount * 20}`);
  }
}
assert.equal(hash(fs.readFileSync(fixture)), fixtureHash);
report.originalFixtureUnchanged = true;
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });