import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { welcomeOffset } from './welcome-screen.mjs';

const [runner, core, previewDirectory, baselineDirectory, outputDirectory] = process.argv.slice(2);
assert.ok(outputDirectory, 'Usage: node tools/verify-welcome.mjs RUNNER CORE PREVIEW_DIRECTORY BASELINE_DIRECTORY NEW_OUTPUT_DIRECTORY');
const metadata = JSON.parse(fs.readFileSync(path.join(previewDirectory, 'build.json')));
const baselineMetadata = JSON.parse(fs.readFileSync(path.join(baselineDirectory, 'build.json')));
assert.ok(metadata.welcome, 'Build has no welcome screen');
const filename = path.join(previewDirectory, metadata.romFilename);
const baselineFilename = path.join(baselineDirectory, baselineMetadata.romFilename);
const rom = fs.readFileSync(filename);
const baseline = fs.readFileSync(baselineFilename);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(rom), metadata.targetSha256);
assert.equal(sha256(baseline), baselineMetadata.targetSha256);
assert.equal(rom.length, baseline.length);
assert.equal(rom.readUInt16LE(0xffdc) ^ rom.readUInt16LE(0xffde), 65535);
assert.equal(rom.reduce((sum, byte) => (sum + byte) & 65535, 0), rom.readUInt16LE(0xffde));
assert.equal(rom.subarray(0xf002, 0xf006).toString('hex'), '5c0000fe');
const unchanged = Buffer.from(rom);
for (const [start, end] of [[0xf002, 0xf006], [0xffdc, 0xffe0], [welcomeOffset, welcomeOffset + 0x10000]]) {
  baseline.copy(unchanged, start, start, end);
}
assert.ok(unchanged.equals(baseline), 'Non-welcome game data changed');
const preview = spawnSync('magick', [path.join(previewDirectory, metadata.welcome.previewFilename), '-depth', '8', 'rgb:-']);
assert.equal(preview.status, 0, preview.stderr?.toString());
assert.equal(preview.stdout.length, 256 * 224 * 3);
fs.mkdirSync(outputDirectory);

function run(romFilename, name, frames, inputs = '', state) {
  const directory = path.join(outputDirectory, name);
  const args = [core, romFilename, directory, String(frames), inputs];
  if (state) args.push(state);
  const result = spawnSync(runner, args, { stdio: 'inherit', timeout: 120000,
    env: { ...process.env, MOMOTARO_CAPTURE_EVERY: '120' } });
  assert.equal(result.status, 0, `Emulator failed: ${name}`);
  return directory;
}

function pixels(directory, frame) {
  const image = fs.readFileSync(path.join(directory, `frame-${frame}.ppm`));
  const header = /^P6\n(\d+) (\d+)\n255\n/.exec(image.toString('ascii', 0, 64));
  assert.ok(header);
  assert.equal(Number(header[1]), 256);
  assert.equal(Number(header[2]), 224);
  return image.subarray(header[0].length);
}

const waitingScenarios = [
  { name: 'idle', frames: 900, inputs: '' },
  { name: 'held-at-reset-and-other-buttons', frames: 300, inputs: '1:180:start,210:3:a,240:3:b' },
  { name: 'wait-for-start-release', frames: 300, inputs: '60:300:start' },
];
for (const scenario of waitingScenarios) {
  const directory = run(filename, scenario.name, scenario.frames, scenario.inputs);
  assert.ok(pixels(directory, 120).equals(preview.stdout), `Cover differs: ${scenario.name}`);
  assert.ok(pixels(directory, scenario.frames).equals(preview.stdout), `Cover did not remain stable: ${scenario.name}`);
  console.log(`PASS ${scenario.name}: exact cover and version pixels`);
}
const title = run(filename, 'title', 1500, '240:30:start');
const originalTitle = run(baselineFilename, 'baseline-title', 1500);
assert.ok(pixels(title, 1500).equals(pixels(originalTitle, 1500)), 'Original title differs after welcome');
const menu = run(filename, 'menu', 180, '30:3:start', path.join(title, 'state.bin'));
const originalMenu = run(baselineFilename, 'baseline-menu', 180, '30:3:start', path.join(originalTitle, 'state.bin'));
assert.ok(pixels(menu, 180).equals(pixels(originalMenu, 180)), 'Menu differs after welcome');
assert.ok(!pixels(menu, 180).equals(pixels(title, 1500)), 'Start did not open the menu');
const stateBypass = run(filename, 'existing-state-bypass', 180, '30:3:start', path.join(originalTitle, 'state.bin'));
assert.ok(pixels(stateBypass, 180).equals(pixels(originalMenu, 180)), 'Loading a pre-welcome state is affected');
const gameData = directory => fs.readFileSync(path.join(directory, 'wram-180.bin')).subarray(0x1600, 0x1940);
assert.ok(gameData(menu).equals(gameData(originalMenu)), 'Initialized game data changed');
const report = {
  targetSha256: metadata.targetSha256, baselineSha256: baselineMetadata.targetSha256,
  version: metadata.welcome.version, sourceImageSha256: metadata.welcome.sourceImageSha256,
  exactCoverPixels: true, idleScreenStable: true, heldAtResetRequiresNewPress: true,
  waitsForStartRelease: true, otherButtonsIgnored: true, originalTitlePixelsIdentical: true,
  menuPixelsIdentical: true, initializedGameDataIdentical: true, existingStateBypassesWelcome: true,
  nonWelcomeRomBytesIdentical: true, physicalDeviceBootVerified: false,
};
fs.writeFileSync(path.join(outputDirectory, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log('PASS original title, menu, game data and pre-welcome state compatibility');