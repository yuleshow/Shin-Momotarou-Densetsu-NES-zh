import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { catalog } from './text-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'opening-preview-v44');
const read = filename => JSON.parse(fs.readFileSync(filename));
const hash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const metadata = read(path.join(release, 'build.json'));
const expected = metadata.targetSha256;
assert.equal(hash(path.join(release, metadata.romFilename)), expected);
const reports = {
  source: path.join(release, 'source-verification.json'),
  dialogue: path.join(release, 'screenshot-dialogue-native-93ae5613/verification.json'),
  inline: path.join(root, 'verification/screenshot-inline-v44-corrected/verification.json'),
  font: path.join(root, 'verification/native-font-v44-corrected/report.json'),
  sumo: '/tmp/momotaro-v44-final-sumo/verification.json',
  menu: '/tmp/momotaro-v44-final-menu/verification.json',
  welcome: '/tmp/momotaro-v44-final-welcome/verification.json',
};
const checks = Object.fromEntries(Object.entries(reports).map(([key, filename]) => {
  const report = read(filename);
  assert.equal(report.targetSha256, expected, `Stale ${key} verification`);
  return [key, report];
}));
assert.equal(checks.source.screenshots, 108);
for (const field of ['previousTranslationsPreserved', 'unselectedRecordsPreserved', 'ipsRoundtripPassed', 'checksumPassed']) {
  assert.equal(checks.source[field], true);
}
assert.equal(checks.dialogue.scenes.length, 100);
assert.equal(checks.dialogue.exactCandidateRecordsVerified, 100);
assert.equal(checks.dialogue.screenshotCoverage.dynamicLabelLimitations.length, 0);
const screenshotIds = new Set([
  ...checks.dialogue.scenes.flatMap(scene => scene.screenshotIds),
  ...checks.dialogue.screenshotCoverage.skipped.map(entry => entry.screenshotId),
  ...checks.dialogue.screenshotCoverage.external.map(entry => entry.screenshotId),
]);
assert.deepEqual([...screenshotIds].sort((first, second) => first - second), Array.from({ length: 108 }, (_, index) => index));
for (const scene of checks.dialogue.scenes) {
  assert.equal(scene.originalRelocationFramesIdentical, true);
  for (const word of scene.words) assert.ok(scene.renderedWords[word], `Missing rendered phrase ${scene.name}:${word}`);
}
for (const [name, expectedCases] of [['karura-three-stories', 4], ['shuten-four-opponents', 8]]) {
  const menu = checks.inline.menus.find(item => item.name === name);
  assert.equal(menu.cases.length, expectedCases);
  assert.ok(menu.cases.some(item => item.cancel?.includes('B ignored; subsequent A')));
  for (const result of menu.cases.filter(item => item.source)) assert.deepEqual(result.target, result.source);
}
assert.equal(checks.font.dispatchMaximum, 0x11ff);
assert.equal(checks.font.cases.length, 15);
assert.ok(checks.font.cases.every(item => item.match));
assert.deepEqual(checks.font.negativeControls.map(item => item.rendered), [true, false, false]);
assert.deepEqual(checks.sumo.sumo.choices.map(item => item.expectedAction), [0xb2, 0xb3, 0xb4, null]);
assert.ok(checks.sumo.sumo.choices.every(item => item.callbackMatchesOriginal));
assert.ok(checks.sumo.sumo.choices.slice(0, 3).every(item => item.translatedAndOriginalBattleProgressed));
assert.equal(checks.sumo.sumo.choices[3].cancelReopenPassed, true);
assert.equal(checks.sumo.sumo.brokenReproduction.palmCallbackMissing, true);
assert.equal(checks.menu.untranslatedControlVerified, true);
assert.equal(checks.menu.followingScriptByteIdentical,
  metadata.opening.originalParagraphBytes < metadata.opening.originalDecodedBytes ? true : null);
assert.equal(metadata.opening.suffixPreserved, true);
assert.equal(checks.menu.fieldMenuVerification.savedCave.actorDataMatchesOriginal, true);
assert.deepEqual(checks.menu.fieldMenuVerification.savedShop.selectionResults.map(item => item.result), [1, 0, 0]);
assert.ok(checks.menu.fieldMenuVerification.savedShop.selectionResults.every(item => item.gameDataMatchesOriginal));
for (const key of ['enemyIndexes', 'enemyReadingIndexes']) {
  assert.deepEqual(checks.menu.fieldMenuVerification.screenshotNameChecks[key], Array.from({ length: 247 }, (_, index) => index + 1));
}
assert.equal(checks.welcome.version, 'v44');
for (const field of ['exactCoverPixels', 'existingStateBypassesWelcome', 'nonWelcomeRomBytesIdentical']) {
  assert.equal(checks.welcome[field], true);
}
const testCommands = [
  ['--test', ...fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`)],
  ['tools/inspect-rom.mjs', 'self-test'],
  ['tools/font-codec.mjs', 'verify'],
  ['tools/text-codec.mjs', 'self-test'],
  ['tools/text-codec.mjs', 'verify-fixtures', 'tests/lz-runtime.json'],
  ['tools/text-catalog.mjs', 'self-test'],
  ['tools/build-menu-patch.mjs', 'self-test'],
];
for (const args of testCommands) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, MOMOTARO_MANIFEST: path.join(root, 'translations/screenshots-v44.release.json') } });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  console.log(result.stdout.trim());
}
const manifest = read(path.join(root, 'translations/screenshots-v44.release.json'));
const original = fs.readFileSync(path.join(root, 'assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc'));
const coverage = catalog(original, manifest, read(path.join(root, 'translations/opening.zh-Hant.json'))).summary;
assert.equal(coverage.translatedRecords, 3188 + 186);
const copy = (source, destination) => {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  assert.equal(hash(source), hash(destination));
};
for (const [name, filename] of Object.entries(reports)) {
  if (name === 'source') continue;
  copy(filename, path.join(release, `${name}-verification.json`));
}
copy(path.join(root, 'translations/screenshots-v44.release.json'), path.join(release, 'resolved-translation-manifest.json'));
copy(path.join(root, 'translations/screenshot-review-20261003.json'), path.join(release, 'screenshot-review.json'));
copy(path.join(root, 'opening-preview-v42-sumo-fix/FONT-LICENSE.txt'), path.join(release, 'FONT-LICENSE.txt'));
const artifactSha256 = {};
for (const entry of fs.readdirSync(release, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const filename = path.join(entry.parentPath, entry.name);
  artifactSha256[path.relative(release, filename)] = hash(filename);
}
const result = {
  version: 'v44', status: 'locally-verified-not-deployed', targetSha256: expected,
  sourceSha256: metadata.sourceSha256, baseVersion: 'v42-sumo-fix',
  reviewedScreenshots: 108, addedIndexedEntries: 186, addedInlineLabels: 7,
  glyphs: metadata.glyphs.length, coverage,
  screenshotCoveragePassed: true, nativeDialoguePassed: true, nativeInlineMenusPassed: true,
  sumoRegressionPassed: true, glyphRegressionPassed: true, menuRegressionPassed: true,
  welcomePassed: true, ipsRoundtripPassed: true, checksumPassed: true,
  nativeDialogueScenes: checks.dialogue.scenes.length,
  exactPhraseChecks: checks.dialogue.scenes.reduce((sum, scene) => sum + scene.words.length, 0),
  previousTranslationsPreserved: true, tests: testCommands.map(args => args.join(' ')),
  limitations: ['Synthetic native dialogue and menu fixtures, not a full natural playthrough',
    'All runtime actor-name, suffix and quantity bounds not exhaustively tested',
    'Player-saved names and emulator overlay text are not rewritten',
    'Physical device boot not verified'],
  deviceWrites: false, artifactSha256,
};
fs.writeFileSync(path.join(release, 'release-verification.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: result.status, targetSha256: expected, coverage, nativeScenes: result.nativeDialogueScenes,
  exactPhraseChecks: result.exactPhraseChecks, hashedArtifacts: Object.keys(artifactSha256).length }, null, 2));
