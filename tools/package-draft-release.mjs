import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { catalog } from './text-catalog.mjs';
import { verifyFontDispatchReport } from './chinese-font.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [planPath, candidate, prefix] = process.argv.slice(2);
assert.ok(planPath && candidate && prefix, 'Usage: node tools/package-draft-release.mjs PLAN CANDIDATE VERIFICATION_PREFIX --previews|--visually-reviewed');
const read = filename => JSON.parse(fs.readFileSync(filename));
const hash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const plan = read(path.resolve(root, planPath));
assert.match(plan.version, /^v\d+$/);
const manifest = read(path.join(root, plan.manifest));
const metadata = read(path.join(candidate, 'build.json'));
const expected = metadata.targetSha256;
assert.equal(hash(path.join(candidate, metadata.romFilename)), expected);
const reports = {
  source: path.join(candidate, 'source-verification.json'),
  dialogue: `${prefix}-dialogue/verification.json`,
  menu: `${prefix}-menu/verification.json`,
  welcome: `${prefix}-welcome/verification.json`,
  font: `${prefix}-font-final/report.json`,
  sumo: `${prefix}-sumo/verification.json`,
};
if (manifest.commandChart || manifest.defaultMonta) {
  reports['screenshot-labels'] = `${prefix}-screenshot-labels/verification.json`;
  reports['battle-status'] = `${prefix}-battle/verification.json`;
}
if (manifest.defaultPochi || manifest.defaultKiko) reports['animal-names'] = `${prefix}-animal-names/verification.json`;
if (plan.nativeMenuFollowups) {
  for (const name of ['field', 'formation', 'injury', 'dictionary-reference']) reports[name] = `${prefix}-${name}/verification.json`;
  reports['release-gates'] = `${prefix}-progress.json`;
}
if (plan.screenshotReview) {
  reports['screenshot-review'] = path.resolve(root, plan.screenshotReview);
  reports['screenshot-dialogue'] = `${prefix}-screenshot-dialogue/verification.json`;
}
const checks = Object.fromEntries(Object.entries(reports).map(([key, filename]) => {
  const report = read(filename);
  assert.equal(report.targetSha256, expected, `Stale ${key} report`);
  return [key, report];
}));
for (const field of ['previousTranslationsPreserved', 'unselectedRecordsPreserved', 'ipsRoundtripPassed', 'checksumPassed']) {
  assert.equal(checks.source[field], true);
}
assert.equal(checks.source.draftRecords, plan.addedIndexedEntries);
const checkedDraftRecords = plan.drafts.reduce((total, filename) => total + Object.keys(read(path.join(root, filename)).records).length, 0);
assert.equal(checks.source.checkedDraftRecords, checkedDraftRecords);
assert.equal(checks.dialogue.scenes.length, checkedDraftRecords);
assert.equal(checks.dialogue.exactCandidateRecordsVerified, checkedDraftRecords);
assert.deepEqual(checks.dialogue.draftFiles, plan.drafts);
for (const filename of plan.drafts) {
  const draft = read(path.join(root, filename));
  assert.deepEqual(checks.dialogue.scenes.filter(scene => Number(scene.pointerOffset) === Number(draft.pointerOffset)).map(scene => scene.firstIndex),
    Object.keys(draft.records).map(Number));
}
for (const scene of checks.dialogue.scenes) {
  assert.equal(scene.originalRelocationFramesIdentical, true);
  for (const word of scene.words) assert.ok(scene.renderedWords[word]);
}
assert.equal(checks.menu.untranslatedControlVerified, true);
assert.deepEqual(checks.menu.fieldMenuVerification.savedShop.selectionResults.map(item => item.result), [1, 0, 0]);
assert.ok(checks.menu.fieldMenuVerification.savedShop.selectionResults.every(item => item.gameDataMatchesOriginal));
assert.equal(checks.menu.fieldMenuVerification.savedCave.actorDataMatchesOriginal, true);
for (const key of ['enemyIndexes', 'enemyReadingIndexes']) {
  assert.deepEqual(checks.menu.fieldMenuVerification.screenshotNameChecks[key], Array.from({ length: 247 }, (_, index) => index + 1));
}
assert.equal(checks.welcome.version, plan.version);
for (const key of ['exactCoverPixels', 'existingStateBypassesWelcome', 'nonWelcomeRomBytesIdentical']) assert.equal(checks.welcome[key], true);
verifyFontDispatchReport(checks.font);
assert.ok(checks.sumo.sumo.choices.every(item => item.callbackMatchesOriginal));
assert.ok(checks.sumo.sumo.choices.slice(0, 3).every(item => item.translatedAndOriginalBattleProgressed));
assert.equal(checks.sumo.sumo.choices[3].cancelReopenPassed, true);
assert.equal(checks.sumo.sumo.brokenReproduction.palmCallbackMissing, true);
if (manifest.commandChart || manifest.defaultMonta) {
  const labels = checks['screenshot-labels'];
  assert.equal(labels.fixtureUnchanged, true);
  if (manifest.commandChart) {
    assert.ok(metadata.commandChart);
    assert.equal(labels.commandChartCells.length, 44);
    assert.equal(new Set(labels.commandChartCells.map(cell => `${cell.x}:${cell.y}`)).size, 44);
    for (const cell of labels.commandChartCells) {
      assert.equal(cell.rendered, true);
      assert.equal(cell.code, cell.character === ' ' ? '50' : metadata.glyphs.find(glyph => glyph.character === cell.character)?.code);
    }
    assert.equal(labels.outsideChartCellsUnchanged, true);
    if (metadata.commandChart.familyCells?.length) {
      assert.equal(labels.familyChartCells.length, 50);
      assert.deepEqual(labels.familyChartCells, metadata.commandChart.familyCells);
      assert.equal(labels.familyModeInitialized, true);
      assert.equal(labels.outsideFamilyCellsUnchanged, true);
      assert.equal(labels.otherChartPixelsIdentical, false);
    } else assert.equal(labels.otherChartPixelsIdentical, true);
  }
  if (manifest.defaultMonta) {
    assert.ok(metadata.defaultMonta);
    assert.deepEqual(labels.defaultNameCases.map(entry => entry.name), ['default', 'custom-suffix', 'custom-name', 'other-character']);
    for (const entry of labels.defaultNameCases) {
      assert.equal(entry.passed, true);
      assert.equal(entry.nameRamUnchanged, true);
      assert.equal(entry.translated, entry.name === 'default');
    }
  }
  const battle = checks['battle-status'];
  assert.equal(battle.sourceFixturesAndRomsUnchanged, true);
  assert.deepEqual(battle.results.map(entry => entry.name), ['normal', 'poison', 'curse', 'paralysis', 'combined', 'injury', 'excellent', 'invincible']);
  for (const entry of battle.results) for (const field of ['exactNativeBattleFont', 'oldGlyphNegativeControlsPassed', 'otherGameplayBytesUnchanged']) assert.equal(entry[field], true);
}
if (manifest.defaultPochi || manifest.defaultKiko) {
  const animals = checks['animal-names'];
  assert.equal(animals.fixtureUnchanged, true);
  const expectedNames = ['default-pochi', 'custom-suffix', 'custom-name', 'other-character', 'default-monta'];
  if (manifest.defaultKiko) expectedNames.push('default-kiko', 'kiko-custom-suffix', 'kiko-custom-name', 'kiko-other-character');
  assert.deepEqual(animals.defaultNameCases.map(entry => entry.name), expectedNames);
  for (const entry of animals.defaultNameCases) {
    assert.equal(entry.passed, true);
    assert.equal(entry.nameRamUnchanged, true);
    assert.equal(entry.outsideNamePixelsIdentical, true);
    assert.equal(entry.translated, ['default-pochi', 'default-kiko'].includes(entry.name));
  }
}
if (plan.nativeMenuFollowups) {
  const gates = checks['release-gates'];
  assert.equal(gates.status, 'passed');
  assert.deepEqual(gates.jobs.map(job => job.name).sort(), ['baseline', 'control', 'font-final', 'menu', 'sumo',
    'welcome', 'battle', 'screenshot-labels', 'animal-names', 'field', 'formation', 'injury', 'dictionary-reference',
    'tests', 'rom-codec', 'font-codec', 'text-codec', 'lz-fixtures', 'catalog', 'builder',
    'dialogue-0', 'dialogue-1', 'dialogue-2'].sort());
  assert.ok(gates.jobs.every(job => job.status === 'passed'));
  const field = checks.field;
  assert.equal(field.cashAddress, '7E1621');
  assert.equal(field.cashDisplayChangesWithValue, true);
  assert.deepEqual(field.money.map(entry => entry.cash), [0, 65535]);
  for (const entry of field.money) {
    assert.equal(entry.outsideHeadingPixelsIdentical, true);
    assert.equal(entry.gameplayDataIdentical, true);
  }
  assert.equal(field.special.length, 1);
  for (const entry of field.special) {
    assert.equal(entry.outsideLabelPixelsIdentical, true);
    assert.equal(entry.gameplayDataIdentical, true);
    assert.deepEqual(entry.actions.map(action => action.name), ['speech', 'order', 'cancel']);
    assert.equal(entry.actions[0].speedMatchesBaseline, true);
    for (const action of entry.actions.slice(1)) assert.equal(action.gameDataMatchesBaseline, true);
  }
  assert.equal(checks.formation.originalFixtureUnchanged, true);
  assert.equal(checks.formation.sourceNegativeControlPassed, true);
  assert.deepEqual(checks.formation.cases.map(entry => entry.name), ['cancel', 'cancel-after-pick', 'swap-second-third', 'swap-second-fourth']);
  for (const entry of checks.formation.cases) {
    assert.equal(entry.gameDataMatchesBaseline, true);
    assert.equal(entry.outsideHeadingPixelsIdentical, true);
  }
  assert.equal(checks.injury.originalFixtureUnchanged, true);
  assert.deepEqual(checks.injury.cases.map(entry => entry.status), [0, 128]);
  for (const entry of checks.injury.cases) {
    assert.equal(entry.checkedAbilityDataIdentical, true);
    assert.equal(entry.abilityPanelOutsideInjuryIdentical, true);
  }
  const reference = checks['dictionary-reference'];
  assert.deepEqual(reference.dictionaryReferenceProbes, [{ index: 39, referenceHex: '02c7' }]);
  assert.equal(reference.scenes.length, 1);
  assert.equal(reference.scenes[0].originalRelocationFramesIdentical, true);
  assert.ok(reference.scenes[0].renderedWords['村']);
}
if (plan.screenshotReview) {
  const review = checks['screenshot-review'];
  const dialogue = checks['screenshot-dialogue'];
  assert.equal(review.version, plan.version);
  assert.equal(review.nativeDialoguePending, false);
  assert.ok(review.screenshots.length > 0 && review.screenshots.every(entry => entry.reviewed && entry.resolved));
  const required = [...new Set(review.screenshots.flatMap(entry => (entry.records ?? []).map(index => `${Number(entry.pointerOffset)}:${index}`)))].sort();
  assert.deepEqual(dialogue.scenes.map(scene => `${Number(scene.pointerOffset)}:${scene.firstIndex}`).sort(), required);
  assert.equal(dialogue.exactCandidateRecordsVerified, required.length);
  for (const scene of dialogue.scenes) {
    assert.equal(scene.originalRelocationFramesIdentical, true);
    assert.ok(scene.changedFrames > 0 && scene.words.length > 0);
    assert.deepEqual(scene.captures.map(capture => capture.filename).sort(), [...new Set(scene.words.map(word => scene.renderedWords[word].frame))].sort());
    for (const capture of scene.captures) {
      assert.equal(path.basename(capture.filename), capture.filename);
      assert.equal(hash(path.join(`${prefix}-screenshot-dialogue`, `${scene.name}-${scene.firstIndex}-translated`, capture.filename)), capture.sha256);
    }
  }
}
const previews = `${prefix}-previews`;
if (process.argv.includes('--previews')) {
  fs.mkdirSync(previews);
  const groups = plan.drafts.map(filename => {
    const draft = read(path.join(root, filename));
    return checks.dialogue.scenes.filter(scene => Number(scene.pointerOffset) === Number(draft.pointerOffset))
      .reduce((longest, scene) => scene.words.length > longest.words.length ? scene : longest);
  }).map(scene => ({ ...scene, captureDirectory: `${prefix}-dialogue` }));
  if (plan.screenshotReview) groups.push(...checks['screenshot-dialogue'].scenes.map(scene => ({ ...scene, captureDirectory: `${prefix}-screenshot-dialogue` })));
  const images = [];
  for (const position of ['first', 'last']) {
    for (let start = 0; start < groups.length; start += 9) {
    const args = ['montage', '-font', '/tmp/momotaro-NotoSansCJKtc-Regular.otf'];
    for (const scene of groups.slice(start, start + 9)) {
      const frames = [...new Set(Object.values(scene.renderedWords).map(match => match.frame))]
        .sort((first, second) => Number(first.match(/\d+/)[0]) - Number(second.match(/\d+/)[0]));
      const frame = position === 'first' ? frames[0] : frames.at(-1);
      args.push('-label', `${scene.name}:${scene.firstIndex}`, path.join(scene.captureDirectory, `${scene.name}-${scene.firstIndex}-translated`, frame));
    }
    const filename = groups.length <= 9 ? `dialogue-${position}-pages.png` : `dialogue-${position}-pages-${start / 9 + 1}.png`;
    args.push('-tile', '3x', '-geometry', '+8+8', path.join(previews, filename));
    const result = spawnSync('magick', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    images.push({ filename, sha256: hash(path.join(previews, filename)) });
    }
  }
  if (manifest.commandChart || manifest.defaultMonta) for (const filename of ['command-chart.png', 'default-name.png', ...(metadata.commandChart?.familyCells?.length ? ['family-chart.png'] : [])]) {
    fs.copyFileSync(path.join(`${prefix}-screenshot-labels`, filename), path.join(previews, filename), fs.constants.COPYFILE_EXCL);
    images.push({ filename, sha256: hash(path.join(previews, filename)) });
  }
  if (manifest.defaultPochi) for (const filename of ['default-pochi.png', ...(manifest.defaultKiko ? ['default-kiko.png'] : [])]) {
    fs.copyFileSync(path.join(`${prefix}-animal-names`, filename), path.join(previews, filename), fs.constants.COPYFILE_EXCL);
    images.push({ filename, sha256: hash(path.join(previews, filename)) });
  }
  if (plan.nativeMenuFollowups) for (const [name, filename] of [
    ['field', 'money-65535-target.png'], ['field', 'special-target.png'],
    ['formation', 'formation-target.png'], ['injury', 'ability-128-target.png'],
  ]) {
    fs.copyFileSync(path.join(`${prefix}-${name}`, filename), path.join(previews, filename), fs.constants.COPYFILE_EXCL);
    images.push({ filename, sha256: hash(path.join(previews, filename)) });
  }
  fs.writeFileSync(path.join(previews, 'previews.json'), JSON.stringify({ targetSha256: expected, images }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ previews, images }, null, 2));
  process.exit(0);
}
assert.ok(process.argv.includes('--visually-reviewed'), 'Review generated previews before packaging');
const previewReport = read(path.join(previews, 'previews.json'));
assert.equal(previewReport.targetSha256, expected);
for (const image of previewReport.images) assert.equal(hash(path.join(previews, image.filename)), image.sha256);
const testCommands = [
  ['--test', 'tests/text-draft.test.mjs', 'tests/font-dispatch.test.mjs', 'tests/chart-labels.test.mjs', 'tests/deploy-release.test.mjs', 'tools/screenshot-dialogue-cases.test.mjs'],
  ['tools/inspect-rom.mjs', 'self-test'], ['tools/font-codec.mjs', 'verify'],
  ['tools/text-codec.mjs', 'self-test'], ['tools/text-codec.mjs', 'verify-fixtures', 'tests/lz-runtime.json'],
  ['tools/text-catalog.mjs', 'self-test'], ['tools/build-menu-patch.mjs', 'self-test'],
];
for (const args of testCommands) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, MOMOTARO_MANIFEST: plan.manifest } });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  console.log(result.stdout.trim());
}
const original = fs.readFileSync(path.join(root, 'assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc'));
const opening = read(path.join(root, 'translations/opening.zh-Hant.json'));
const coverage = catalog(original, manifest, opening).summary;
const previous = catalog(original, read(path.join(root, plan.baseDirectory, 'resolved-translation-manifest.json')), opening).summary;
assert.equal(coverage.translatedRecords - previous.translatedRecords, plan.addedIndexedEntries);
const destination = path.join(root, `opening-preview-${plan.version}`);
fs.mkdirSync(destination);
const artifacts = {};
const copy = (source, name) => {
  const target = path.join(destination, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  assert.equal(hash(target), hash(source));
  artifacts[name] = hash(target);
};
for (const filename of [metadata.romFilename, 'opening-zh-Hant.ips', 'build.json', 'welcome-preview.png']) copy(path.join(candidate, filename), filename);
copy(path.join(root, plan.manifest), 'resolved-translation-manifest.json');
copy(path.resolve(root, planPath), 'release-plan.json');
copy(path.join(root, plan.baseDirectory, 'FONT-LICENSE.txt'), 'FONT-LICENSE.txt');
for (const [name, filename] of Object.entries(reports)) copy(filename, name === 'screenshot-review' ? 'screenshot-review.json' : `${name}-verification.json`);
let fullTestSummary;
if (plan.nativeMenuFollowups) {
  copy(`${prefix}-tests.log`, 'tests.log');
  const log = fs.readFileSync(`${prefix}-tests.log`, 'utf8');
  fullTestSummary = { tests: Number(log.match(/\btests (\d+)/)?.[1]), passed: Number(log.match(/\bpass (\d+)/)?.[1]),
    failed: Number(log.match(/\bfail (\d+)/)?.[1]), skipped: Number(log.match(/\bskipped (\d+)/)?.[1]) };
  assert.ok(fullTestSummary.tests > 0);
  assert.equal(fullTestSummary.passed, fullTestSummary.tests);
  assert.equal(fullTestSummary.failed, 0);
  assert.equal(fullTestSummary.skipped, 0);
  for (const scene of checks.dialogue.scenes) for (const filename of new Set(Object.values(scene.renderedWords).map(match => match.frame))) {
    assert.equal(path.basename(filename), filename);
    const relative = path.join(`${scene.name}-${scene.firstIndex}-translated`, filename);
    copy(path.join(`${prefix}-dialogue`, relative), path.join('dialogue-evidence', relative));
  }
}
if (plan.screenshotReview) for (const scene of checks['screenshot-dialogue'].scenes) for (const capture of scene.captures) {
  const relative = path.join(`${scene.name}-${scene.firstIndex}-translated`, capture.filename);
  copy(path.join(`${prefix}-screenshot-dialogue`, relative), path.join('screenshot-evidence', relative));
}
for (const image of previewReport.images) copy(path.join(previews, image.filename), image.filename);
const report = {
  version: plan.version, status: 'locally-verified-not-deployed', targetSha256: expected,
  sourceSha256: metadata.sourceSha256, baseVersion: path.basename(plan.baseDirectory).replace('opening-preview-', ''),
  addedIndexedEntries: plan.addedIndexedEntries, glyphs: metadata.glyphs.length, coverage,
  nativeDialoguePassed: true, menuRegressionPassed: true, welcomePassed: true,
  ...(plan.screenshotReview ? { screenshotCoveragePassed: true, reviewedScreenshots: checks['screenshot-review'].screenshots.length,
    screenshotDialogueScenes: checks['screenshot-dialogue'].scenes.length } : {}),
  ...(manifest.commandChart || manifest.defaultMonta ? { screenshotLabelsPassed: true, battleStatusRegressionPassed: true } : {}),
  ...(manifest.defaultPochi ? { animalNamesPassed: true } : {}),
  ...(plan.nativeMenuFollowups ? { nativeMenuFollowupsPassed: true,
    nativeMenuFollowupLimitations: [...checks.field.limitations, ...checks.formation.limitations, ...checks.injury.limitations] } : {}),
  glyphRegressionPassed: true, sumoRegressionPassed: true, ipsRoundtripPassed: true, checksumPassed: true,
  previousTranslationsPreserved: true, previousGlyphsPreserved: checks.source.previousGlyphsPreserved,
  nativeDialogueScenes: checks.dialogue.scenes.length,
  exactPhraseChecks: checks.dialogue.scenes.reduce((sum, scene) => sum + scene.words.length, 0),
  previewsVisuallyReviewed: true, tests: testCommands.map(args => args.join(' ')),
  ...(fullTestSummary ? { fullTestSummary, releaseJobsPassed: checks['release-gates'].jobs.length } : {}),
  limitations: ['Synthetic native scenes, not a full natural story playthrough',
    'Runtime custom-name bounds and all event branches not exhaustively tested',
    `Only the ${plan.drafts.length} specified draft files are integrated; other drafts remain separate`,
    'Physical device boot not verified'],
  deviceWrites: false, artifactSha256: artifacts,
};
fs.writeFileSync(path.join(destination, 'release-verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ destination, targetSha256: expected, coverage, scenes: report.nativeDialogueScenes }, null, 2));