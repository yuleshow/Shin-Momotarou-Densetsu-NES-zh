import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyGlyphExtension } from './chinese-font.mjs';

const [runner, core, candidate, baseline, fixture, output] = process.argv.slice(2);
assert.ok(output, 'Usage: verify-field-menu-labels.mjs RUNNER CORE CANDIDATE BASELINE FIELD_STATE NEW_OUTPUT [--formation|--injury]');
const read = filename => JSON.parse(fs.readFileSync(filename));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = read(path.join(candidate, 'build.json'));
const previous = read(path.join(baseline, 'build.json'));
const rom = fs.readFileSync(path.join(candidate, metadata.romFilename));
const oldRom = fs.readFileSync(path.join(baseline, previous.romFilename));
assert.equal(hash(rom), metadata.targetSha256);
assert.equal(hash(oldRom), previous.targetSha256);
verifyGlyphExtension(metadata.glyphs, previous.glyphs);
const snapshot = fs.readFileSync(fixture);
const ramOffset = snapshot.indexOf('RAM:131072:') + 11;
assert.ok(ramOffset > 11);
if (process.argv.includes('--injury')) assert.equal(snapshot[ramOffset + 0x113c], 0, 'Use a native local-map fixture for the individual ability page');
else assert.notEqual(snapshot[ramOffset + 0x113c], 0, 'Use a native world-map fixture, not a forced local-map layout');
fs.mkdirSync(output);

function run(directory, build, name, inputs, state) {
  const destination = path.join(output, name);
  const result = spawnSync(runner, [core, path.join(directory, build.romFilename), destination, '360', inputs, state], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, MOMOTARO_CHEATS: '', MOMOTARO_TRACE: '', MOMOTARO_CAPTURE_EVERY: '360' },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const frame = fs.readFileSync(path.join(destination, 'frame-360.ppm'));
  const header = /^P6\n256 224\n255\n/.exec(frame.subarray(0, 64).toString());
  assert.ok(header);
  const image = `${name}.png`;
  assert.equal(spawnSync('magick', [path.join(destination, 'frame-360.ppm'), path.join(output, image)]).status, 0);
  return { state: path.join(destination, 'state.bin'), pixels: frame.subarray(header[0].length),
    ram: fs.readFileSync(path.join(destination, 'wram-360.bin')), image };
}

function locate(pixels, word) {
  const points = [];
  for (const [index, character] of [...word].entries()) {
    const glyph = metadata.glyphs.find(entry => entry.character === character);
    assert.ok(glyph);
    for (let row = 0; row < 15; row++) for (let column = 0; column < 12; column++) {
      const plane = number => column < 8 ? (rom[glyph.offset + number * 23 + row] >> (7 - column)) & 1
        : (rom[glyph.offset + number * 23 + 15 + (row >> 1)] >> ((row % 2 === 0 ? 4 : 0) + 11 - column)) & 1;
      if (plane(0)) points.push({ offset: (row + 1) * 256 + index * 12 + column, foreground: Boolean(plane(1)) });
    }
  }
  for (let y = 0; y <= 208; y++) for (let x = 0; x <= 256 - [...word].length * 12; x++) {
    if (points.every(point => {
      const offset = ((y * 256 + x) + point.offset) * 3;
      const brightness = Math.max(...pixels.subarray(offset, offset + 3));
      return point.foreground ? brightness >= 140 : brightness <= 80;
    })) return { x, y, width: [...word].length * 12, height: 16 };
  }
  return null;
}

function outsideEqual(before, after, rectangles) {
  for (let y = 0; y < 224; y++) for (let x = 0; x < 256; x++) {
    if (rectangles.some(rectangle => x >= rectangle.x && x < rectangle.x + rectangle.width && y >= rectangle.y && y < rectangle.y + rectangle.height)) continue;
    const offset = (y * 256 + x) * 3;
    assert.deepEqual(after.subarray(offset, offset + 3), before.subarray(offset, offset + 3), `Unexpected pixel difference at ${x},${y}`);
  }
}

function verifyFormation() {
  const versions = [[baseline, previous, 'source'], [candidate, metadata, 'target']];
  const opened = versions.map(([directory, build, version]) => {
    const field = run(directory, build, `field-${version}`, '30:3:a', fixture);
    const special = run(directory, build, `special-${version}`,
      '30:3:right,90:3:right,150:3:right,210:3:down,270:3:a', field.state);
    return run(directory, build, `formation-${version}`, '30:3:down,90:3:a', special.state);
  });
  const heading = locate(opened[1].pixels, '隊列');
  assert.ok(heading, 'Missing formation heading');
  assert.equal(locate(opened[0].pixels, '隊列'), null, 'Baseline unexpectedly has translated formation heading');
  outsideEqual(opened[0].pixels, opened[1].pixels, [heading]);
  assert.deepEqual(opened[1].ram.subarray(0x1500, 0x2000), opened[0].ram.subarray(0x1500, 0x2000));
  const party = [...opened[1].ram.subarray(0x1569, 0x156d)];
  assert.equal(new Set(party).size, 4, 'Fixture must have four distinct party members');
  assert.ok(party.every(member => member < 23), 'Fixture contains an empty party slot');
  for (const result of opened) assert.equal(result.ram[0x12e4], 1, 'Expected native cursor at the second member');
  const cases = [];
  for (const [name, inputs, order] of [
    ['cancel', '90:3:b', [0, 1, 2, 3]],
    ['cancel-after-pick', '30:3:a,150:3:b', [0, 1, 2, 3]],
    ['swap-second-third', '30:3:a,90:3:right,150:3:a', [0, 2, 1, 3]],
    ['swap-second-fourth', '30:3:a,90:3:right,150:3:right,210:3:a', [0, 3, 2, 1]],
  ]) {
    const results = versions.map(([directory, build, version], index) => run(directory, build, `${name}-${version}`, inputs, opened[index].state));
    const expected = order.map(index => party[index]);
    for (const result of results) assert.deepEqual([...result.ram.subarray(0x1569, 0x156d)], expected, `${name}: wrong party order`);
    assert.deepEqual(results[1].ram.subarray(0x1500, 0x2000), results[0].ram.subarray(0x1500, 0x2000));
    outsideEqual(results[0].pixels, results[1].pixels, [heading]);
    cases.push({ name, party: expected, gameDataMatchesBaseline: true, outsideHeadingPixelsIdentical: true, image: results[1].image });
  }
  assert.equal(hash(fs.readFileSync(fixture)), hash(snapshot));
  const report = { targetSha256: metadata.targetSha256, baselineSha256: previous.targetSha256, fixtureSha256: hash(snapshot),
    originalFixtureUnchanged: true, syntheticStateChanges: false, nativeControllerNavigation: true,
    heading, sourceNegativeControlPassed: true, outsideHeadingPixelsIdentical: true,
    initialParty: party, initialCursorIndex: 1, partyAddress: '7E1569', cases, image: opened[1].image,
    limitations: ['Four-member world-map fixture only; not every party size, physical device or full release regression.'] };
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}

function verifyAbilityInjury() {
  const versions = [[baseline, previous, 'source'], [candidate, metadata, 'target']];
  const cases = [];
  for (const status of [0, 0x80]) {
    const state = Buffer.from(snapshot);
    state[ramOffset + 0x180a] = status;
    const stateFile = path.join(output, `injury-${status}.bin`);
    fs.writeFileSync(stateFile, state, { flag: 'wx' });
    const opened = versions.map(([directory, build, version]) => {
      const field = run(directory, build, `field-${status}-${version}`, '30:3:a', stateFile);
      return run(directory, build, `ability-${status}-${version}`, '30:3:down,90:3:down,150:3:a', field.state);
    });
    for (const result of opened) assert.equal(result.ram[0x180a], status);
    const checkedRanges = [[0x315, 0x336], [0x1500, 0x15e0], [0x160b, 0x2000]];
    for (const [start, end] of checkedRanges) assert.deepEqual(opened[1].ram.subarray(start, end), opened[0].ram.subarray(start, end));
    const unclassifiedRamDifferences = Array.from({ length: 0x2b }, (_, index) => 0x15e0 + index)
      .filter(address => opened[0].ram[address] !== opened[1].ram[address])
      .map(address => ({ address: `7E${address.toString(16).toUpperCase()}`, before: opened[0].ram[address], after: opened[1].ram[address] }));
    for (const word of ['心值', '體力', '技力', '攻擊力', '防禦力']) assert.ok(locate(opened[1].pixels, word), `Not an ability page: ${word}`);
    const heading = locate(opened[1].pixels, '重傷');
    assert.equal(locate(opened[0].pixels, '重傷'), null);
    if (status) {
      assert.ok(heading, 'Injury condition did not show translated label');
      outsideEqual(opened[0].pixels, opened[1].pixels, [{ ...heading, width: 36 }, { x: 0, y: 0, width: 128, height: 224 }]);
    } else {
      assert.equal(heading, null, 'Healthy actor shows injury label');
      assert.deepEqual(opened[1].pixels, opened[0].pixels);
    }
    cases.push({ status, heading, checkedRanges, checkedAbilityDataIdentical: true, abilityPanelOutsideInjuryIdentical: true,
      unclassifiedRamDifferences, image: opened[1].image });
  }
  assert.equal(hash(fs.readFileSync(fixture)), hash(snapshot));
  const report = { targetSha256: metadata.targetSha256, baselineSha256: previous.targetSha256, fixtureSha256: hash(snapshot),
    cases, nativeControllerNavigation: true, syntheticConditionAddress: '7E180A', originalFixtureUnchanged: true,
    limitations: ['Healthy/severely injured protagonist only; not every actor, status combination or full release regression.',
      'Background animation timing differs in the injury case. RAM 7E15E0-7E160A differences are recorded but unclassified; full scene or gameplay RAM equality is not claimed.'] };
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv.includes('--injury')) {
  verifyAbilityInjury();
  process.exit(0);
}

if (process.argv.includes('--formation')) {
  verifyFormation();
  process.exit(0);
}

const report = { targetSha256: metadata.targetSha256, baselineSha256: previous.targetSha256, fixtureSha256: hash(snapshot),
  conditions: 'Native world-map state with only cash values set in copies; original layout, ROM code and normal controller input.', money: [], special: [],
  limitations: ['Not physical-device validation or a complete release regression.'] };
const cashImages = [];
for (const cash of [0, 65535]) {
  const state = Buffer.from(snapshot);
  state.writeUInt16LE(cash, ramOffset + 0x1621);
  const stateFile = path.join(output, `field-${cash}.bin`);
  fs.writeFileSync(stateFile, state, { flag: 'wx' });
  const versions = [[baseline, previous, 'source'], [candidate, metadata, 'target']];
  const opened = versions.map(([directory, build, version]) => run(directory, build, `money-${cash}-${version}`, '30:3:a', stateFile));
  const heading = locate(opened[1].pixels, '持有金');
  assert.ok(heading, 'Missing translated money heading');
  assert.equal(locate(opened[0].pixels, '持有金'), null);
  outsideEqual(opened[0].pixels, opened[1].pixels, [heading]);
  for (const result of opened) assert.equal(result.ram.readUInt16LE(0x1621), cash);
  cashImages.push(Buffer.concat(Array.from({ length: 16 }, (_, row) => {
    const offset = ((192 + row) * 256 + 192) * 3;
    return opened[1].pixels.subarray(offset, offset + 56 * 3);
  })));
  assert.deepEqual(opened[1].ram.subarray(0x1500, 0x2000), opened[0].ram.subarray(0x1500, 0x2000));
  report.money.push({ cash, heading, outsideHeadingPixelsIdentical: true, gameplayDataIdentical: true, image: opened[1].image });
  if (cash !== 65535) continue;
  const special = versions.map(([directory, build, version], index) => run(directory, build, `special-${version}`,
    '30:3:right,90:3:right,150:3:right,210:3:down,270:3:a', opened[index].state));
  const labels = ['語速', '隊列'].map(word => {
    const bounds = locate(special[1].pixels, word);
    assert.ok(bounds, `Missing compact special-menu label: ${word}`);
    assert.equal(locate(special[0].pixels, word), null);
    return { word, ...bounds };
  });
  const changedLabelBounds = labels.map(label => ({ ...label, width: label.word === '語速' ? 36 : 24 }));
  outsideEqual(special[0].pixels, special[1].pixels, changedLabelBounds);
  assert.deepEqual(special[1].ram.subarray(0x1500, 0x2000), special[0].ram.subarray(0x1500, 0x2000));
  report.special.push({ labels, changedLabelBounds, outsideLabelPixelsIdentical: true, gameplayDataIdentical: true, image: special[1].image });
  const actions = [];
  for (const [name, inputs] of [['speech', '90:3:a'], ['order', '30:3:down,90:3:a'], ['cancel', '90:3:b']]) {
    const results = versions.map(([directory, build, version], index) => run(directory, build, `${name}-${version}`, inputs, special[index].state));
    assert.deepEqual(results[1].ram.subarray(0x1500, 0x2000), results[0].ram.subarray(0x1500, 0x2000));
    const actionBounds = [...changedLabelBounds, heading];
    if (name === 'order' && metadata.inlineMenus.some(menu => menu.name === 'party-formation')
      && !previous.inlineMenus.some(menu => menu.name === 'party-formation')) {
      const formationHeading = locate(results[1].pixels, '隊列');
      assert.deepEqual(formationHeading, { x: 108, y: 176, width: 24, height: 16 });
      assert.equal(locate(results[0].pixels, '隊列'), null);
      actionBounds.push(formationHeading);
    }
    outsideEqual(results[0].pixels, results[1].pixels, actionBounds);
    assert.ok(!results[1].pixels.equals(special[1].pixels), `${name}: menu action had no visible effect`);
    if (name === 'speech') {
      for (const word of ['訊息速度', '極速', '快速', '普通', '慢速']) assert.ok(locate(results[1].pixels, word), word);
      const selected = versions.map(([directory, build, version], index) => run(directory, build, `speech-applied-${version}`, '30:3:left,90:3:a', results[index].state));
      assert.equal(selected[1].ram[0x12b6], selected[0].ram[0x12b6]);
      assert.notEqual(selected[1].ram[0x12b6], results[1].ram[0x12b6], 'Speech speed did not change');
      assert.deepEqual(selected[1].ram.subarray(0x1500, 0x2000), selected[0].ram.subarray(0x1500, 0x2000));
      actions.push({ name, speedApplied: selected[1].ram[0x12b6], speedMatchesBaseline: true, image: results[1].image });
    } else actions.push({ name, gameDataMatchesBaseline: true, changedLabelBounds: actionBounds, image: results[1].image });
  }
  report.special[0].actions = actions;
}
assert.equal(hash(fs.readFileSync(fixture)), report.fixtureSha256);
assert.ok(!cashImages[0].equals(cashImages[1]), 'Cash display did not change between zero and 65535');
report.cashAddress = '7E1621';
report.cashDisplayChangesWithValue = true;
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));