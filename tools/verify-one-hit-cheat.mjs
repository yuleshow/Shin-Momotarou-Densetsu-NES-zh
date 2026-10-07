import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const [runner, core, statePath, output] = process.argv.slice(2);
assert.ok(runner && core && statePath && output,
  'Usage: node tools/verify-one-hit-cheat.mjs RUNNER CORE LOCAL_BATTLE_STATE NEW_OUTPUT');
const hash = data => createHash('sha256').update(data).digest('hex');
const cheatPath = 'cheats/Shin Momotarou Densetsu (Traditional Chinese).cht';
const cheatText = fs.readFileSync(cheatPath, 'utf8');
const fields = Object.fromEntries(cheatText.split('\n').filter(line => line.trim()).map(line => {
  const match = line.match(/^(\w+) = (.+)$/);
  assert.ok(match, `Invalid cheat field: ${line}`);
  return [match[1], JSON.parse(match[2])];
}));
assert.ok(Number.isInteger(fields.cheats) && fields.cheats >= 11);
assert.equal(fields.cheat10_enable, false);
assert.equal(fields.cheat10_handler, 0);
const previous = cheatText.slice(0, cheatText.indexOf('\n\ncheat10_desc')).replace(/^cheats = \d+/, 'cheats = 10');
assert.equal(hash(previous), JSON.parse(fs.readFileSync('cheats/kintarou-urashima-verification.json')).cheatSha256);
const routine = Buffer.from('0510f012bde519f00dbdd519c919f006a9ff850f85104cded0', 'hex');
const expectedWrites = [[0x82d09c, 0x40], [0x82d09d, 0xfe],
  ...[...routine].map((value, index) => [0x82fe40 + index, value])];
const writes = fields.cheat10_code.split('+').map(code => {
  assert.match(code, /^[0-9A-F]{8}$/);
  return [parseInt(code.slice(0, 6), 16), parseInt(code.slice(6), 16)];
});
assert.deepEqual(writes, expectedWrites);
assert.ok(fields.cheat10_code.length <= 255);
const state = fs.readFileSync(statePath);
const stateHash = hash(state);
const marker = Buffer.from('RAM:131072:');
const markerOffset = state.indexOf(marker);
assert.ok(markerOffset >= 0);
const ramStart = markerOffset + marker.length;
assert.equal(state.indexOf(marker, ramStart), -1);
assert.deepEqual([...state.subarray(ramStart + 0x19e5, ramStart + 0x19ea)], [0, 0, 1, 1, 2]);
const initialHp = [961, 35, 18, 18, 24];
const hp = ram => Array.from({ length: 5 }, (_, index) => ram[0x1a35 + index] + 256 * ram[0x1a45 + index]);
assert.deepEqual(hp(state.subarray(ramStart)), initialHp);
assert.ok(!fs.existsSync(output), 'Output must not exist');
fs.mkdirSync(output, { recursive: true });
const inputs = frames => ['30:3:left', ...Array.from({ length: Math.ceil((frames - 90) / 180) },
  (_, index) => `${90 + index * 180}:3:a`)].join(',');
const runs = [];
function run(rom, name, enabled, frames, sourceState = statePath, buttons = inputs(frames), every = 30) {
  const directory = path.join(output, name);
  const result = spawnSync(runner, [core, rom, directory, String(frames), buttons, sourceState], {
    encoding: 'utf8', timeout: 180000,
    env: { ...process.env, MOMOTARO_CHEATS: enabled ? fields.cheat10_code : '', MOMOTARO_CAPTURE_EVERY: String(every) },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const read = frame => fs.readFileSync(path.join(directory, `wram-${frame}.bin`));
  runs.push({ name, enabled, frames, finalHp: hp(read(frames)), directory });
  console.log(`PASS run ${name}`);
  return { directory, read };
}
const versions = [
  ['original', 'assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc'],
  ['v46', 'opening-preview-v46/opening-zh-Hant.sfc'],
  ['v56', 'opening-preview-v56/opening-zh-Hant.sfc'],
  ['v60', 'opening-preview-v60/opening-zh-Hant.sfc'],
];
const romHashes = Object.fromEntries(versions.map(([version, filename]) => [version, hash(fs.readFileSync(filename))]));
const checks = [];
for (const [version, romPath] of versions) {
  const rom = fs.readFileSync(romPath);
  assert.equal(rom.subarray(0x2d092, 0x2d0a0).toString('hex'), 'c22068850fe220b01a20ded0b015');
  assert.ok(rom.subarray(0x2fe40, 0x2fe59).every(value => value === 255));
  assert.equal(rom.subarray(0x2d0de, 0x2d104).toString('hex'),
    '8b5a4bab bde519f00fa000b9fdd0f008ddd519f007c880f3187aab603880fae9e0e1e2e3e500'.replaceAll(' ', ''));
  const baseline = run(romPath, `${version}-baseline`, false, 2400);
  const enabled = run(romPath, `${version}-enabled`, true, 2400);
  const firstHit = Array.from({ length: 80 }, (_, index) => (index + 1) * 30)
    .find(frame => hp(baseline.read(frame)).slice(2).some((value, index) => value < initialHp[index + 2]));
  assert.ok(firstHit, 'Baseline never damaged an enemy');
  for (let frame = 30; frame <= firstHit; frame += 30) {
    assert.deepEqual(hp(enabled.read(frame)).slice(0, 2), hp(baseline.read(frame)).slice(0, 2));
    if (frame < firstHit) assert.deepEqual(hp(enabled.read(frame)), hp(baseline.read(frame)));
  }
  const firstTarget = hp(baseline.read(firstHit)).findIndex((value, index) => index >= 2 && value < initialHp[index]);
  assert.ok(hp(baseline.read(firstHit))[firstTarget] > 0, 'Baseline must demonstrate a nonlethal hit');
  const expectedHp = hp(baseline.read(firstHit));
  expectedHp[firstTarget] = 0;
  assert.deepEqual(hp(enabled.read(firstHit)), expectedHp);
  const idleBaseline = run(romPath, `${version}-idle-baseline`, false, 120, statePath, '', 120);
  const idleEnabled = run(romPath, `${version}-idle-enabled`, true, 120, statePath, '', 120);
  assert.ok(idleBaseline.read(120).equals(idleEnabled.read(120)), 'Idle WRAM changed');
  const lizardState = Buffer.from(state);
  for (const index of [2, 3, 4]) lizardState[ramStart + 0x19d5 + index] = 25;
  const lizardPath = path.join(output, `${version}-synthetic-lizard-state.bin`);
  fs.writeFileSync(lizardPath, lizardState, { flag: 'wx' });
  const lizardBaseline = run(romPath, `${version}-lizard-baseline`, false, 2400, lizardPath);
  const lizardEnabled = run(romPath, `${version}-lizard-enabled`, true, 2400, lizardPath);
  let lizardDamaged = false;
  const lizardExecutionDifferences = [];
  for (let frame = 30; frame <= 2400; frame += 30) {
    const before = lizardBaseline.read(frame);
    const after = lizardEnabled.read(frame);
    const differences = [];
    for (let address = 0; address < before.length; address++) if (before[address] !== after[address]) {
      assert.ok(address === 0x0f || (address >= 0x100 && address < 0x200),
        `Lizard non-stack/gameplay WRAM differs: ${version}:${frame}:${address.toString(16)}`);
      differences.push({ address: `7E${address.toString(16).padStart(4, '0')}`, before: before[address], after: after[address] });
    }
    if (differences.length) lizardExecutionDifferences.push({ frame, differences });
    assert.deepEqual(hp(after), hp(before), `Lizard HP differs: ${version}:${frame}`);
    for (const index of [2, 3, 4]) {
      assert.equal(lizardEnabled.read(frame)[0x19d5 + index], 25);
      if (hp(lizardBaseline.read(frame))[index] < initialHp[index]) lizardDamaged = true;
    }
  }
  assert.ok(lizardDamaged, 'Lizard exception test never reached damage');
  checks.push({ version, firstHitFrame: firstHit, firstTarget, firstHitBaselineHp: hp(baseline.read(firstHit))[firstTarget], firstHitEnabledHp: 0,
    allyDamageIdenticalThroughFirstHit: true, enemiesUnchangedUntilHit: true, idleWramIdentical: true,
    lizardEnemyId: 25, lizardDamageObserved: lizardDamaged, lizardGameplayWramIdenticalFrames: 80,
    lizardExcludedExecutionBytes: ['7E000F damage-work scratch', '7E0100-7E01FF CPU stack'], lizardExecutionDifferences });
}
const highHpState = Buffer.from(state);
for (const index of [2, 3]) {
  highHpState[ramStart + 0x1a35 + index] = 10000 & 255;
  highHpState[ramStart + 0x1a45 + index] = 10000 >> 8;
}
const highHpPath = path.join(output, 'synthetic-high-hp-state.bin');
fs.writeFileSync(highHpPath, highHpState, { flag: 'wx' });
const highBaseline = run(versions.at(-1)[1], 'v60-high-hp-baseline', false, 2400, highHpPath);
const highEnabled = run(versions.at(-1)[1], 'v60-high-hp-enabled', true, 2400, highHpPath);
const highFirstHit = Array.from({ length: 80 }, (_, index) => (index + 1) * 30)
  .find(frame => hp(highBaseline.read(frame)).slice(2, 4).some(value => value < 10000));
assert.ok(highFirstHit, 'High-HP baseline never damaged a target');
const highTarget = hp(highBaseline.read(highFirstHit)).findIndex((value, index) => [2, 3].includes(index) && value < 10000);
assert.ok(hp(highBaseline.read(highFirstHit))[highTarget] > 0);
const highExpected = hp(highBaseline.read(highFirstHit));
highExpected[highTarget] = 0;
assert.deepEqual(hp(highEnabled.read(highFirstHit)), highExpected);
const continued = run(versions.at(-1)[1], 'v60-finish', true, 18000,
  path.join(highEnabled.directory, 'state.bin'),
  Array.from({ length: 100 }, (_, index) => `${30 + index * 180}:3:a`).join(','), 120);
assert.ok([2, 3, 4].every(index => hp(continued.read(18000))[index] === 0), 'Not all enemies defeated');
assert.ok([2, 3, 4].every(index => continued.read(18000)[0x19c5 + index] === 0), 'Defeated enemies still active');
assert.equal(hash(fs.readFileSync(statePath)), stateHash);
for (const [version, filename] of versions) assert.equal(hash(fs.readFileSync(filename)), romHashes[version]);
const result = {
  status: 'locally-verified-not-deployed', cheatSha256: hash(Buffer.from(cheatText)), code: fields.cheat10_code,
  defaultEnabled: false, previousTenEntriesPreserved: true, romHashes,
  hook: { address: '82D09B', original: '20DED0', replacement: '2040FE', routineAddress: '82FE40', routineHex: routine.toString('hex'),
    targetSide: '7E19E5 + X: zero is ally; nonzero is enemy group',
    targetEnemyId: '7E19D5 + X: ordinary lizard is 25; golden lizard is 26',
    excludedEnemyIds: [25],
    behavior: 'Preserve ordinary lizard and ally damage; raise other nonzero enemy damage to 65535; tail-call original immunity check before normal HP subtraction',
    directSaveOrRamCheatWrites: false },
  checks, highHp: { original: 10000, firstHitFrame: highFirstHit,
    baselineAfterHit: hp(highBaseline.read(highFirstHit))[highTarget], enabledAfterHit: 0 },
  allThreeEnemiesDefeatedAndInactive: true, runs, statePath, stateSha256: stateHash,
  sourceStateAndRomFilesUnchanged: true, deviceFilesAccessed: false,
  limitations: ['Synthetic local battle fixture, not the current Fukuryuu Cave encounter',
    'Lizard cases change enemy IDs in copies of the fixture; natural tail severing and item acquisition are not replayed',
    'Only ordinary lizard ID 25 is excluded; golden lizard ID 26 remains eligible for one-hit damage',
    'Not location-restricted; disable for scripted fights', 'Misses, zero damage and original special immunity checks are not bypassed',
    'Not every skill, boss, reflected attack, or natural story route tested', 'Physical device activation not tested'],
};
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(`PASS verification: ${path.join(output, 'verification.json')}`);