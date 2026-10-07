import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planIndex = process.argv.indexOf('--plan');
const plan = planIndex < 0 ? null : JSON.parse(fs.readFileSync(path.resolve(root, process.argv[planIndex + 1])));
const installOnly = process.argv.includes('--install-only');
const reviewedOnly = Boolean(plan?.screenshotReview);
assert.ok(!reviewedOnly || !process.argv.includes('--install-and-remove-related'), 'Reviewed plan requires reviewed-only removal');
assert.ok(!installOnly || (!process.argv.includes('--install-and-remove-related') && !process.argv.includes('--install-and-remove-reviewed')),
  'Install-only cannot be combined with screenshot removal');
const version = plan?.version ?? 'v44';
assert.match(version, /^v\d+$/);
const releaseDirectory = path.join(root, `opening-preview-${version}`);
const stem = 'Shin Momotarou Densetsu (Traditional Chinese)';
const deviceRom = `/Volumes/share/roms/snes/${stem}.sfc`;
const screenshotDirectory = '/Volumes/share/screenshots';
const savesDirectory = '/Volumes/share/saves/snes';
const read = filename => JSON.parse(fs.readFileSync(filename));
const hash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const write = (filename, value, flag = 'wx') => {
  const descriptor = fs.openSync(filename, flag);
  try {
    fs.writeFileSync(descriptor, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};
const release = read(path.join(releaseDirectory, 'release-verification.json'));
assert.equal(release.status, 'locally-verified-not-deployed');
const gates = ['nativeDialoguePassed',
  'sumoRegressionPassed', 'glyphRegressionPassed', 'menuRegressionPassed', 'welcomePassed',
  'ipsRoundtripPassed', 'checksumPassed'];
if (!plan) gates.push('screenshotCoveragePassed', 'nativeInlineMenusPassed');
const battlePreview = release.scope === 'battle-status-graphics-preview';
if (battlePreview) {
  assert.equal(plan?.scope, release.scope, 'Battle preview requires an explicit scoped plan');
  assert.ok(!process.argv.includes('--install-and-remove-related') && !process.argv.includes('--install-and-remove-reviewed'), 'Battle preview cannot remove screenshots');
  assert.match(plan.translationBaseDirectory, /^opening-preview-v\d+$/);
  const inheritedDirectory = path.join(root, plan.translationBaseDirectory);
  const inherited = read(path.join(inheritedDirectory, 'release-verification.json'));
  assert.equal(inherited.targetSha256, release.baselineSha256);
  for (const field of gates) assert.equal(inherited[field], true, `Unmet inherited release gate: ${field}`);
  for (const [filename, expected] of Object.entries(inherited.artifactSha256)) assert.equal(hash(path.join(inheritedDirectory, filename)), expected);
  assert.equal(release.visuallyReviewed, true);
  assert.equal(release.largeTextAndBattleCodeByteIdenticalToV47, true);
  const required = ['opening-zh-Hant.sfc', 'opening-zh-Hant.ips', 'build.json', 'resolved-translation-manifest.json',
    'battle-status-verification.json', 'build-scope-verification.json', 'menu-verification.json', 'sumo-verification.json', 'welcome-verification.json'];
  assert.ok(Array.isArray(release.files));
  assert.equal(new Set(release.files.map(file => file.filename)).size, release.files.length);
  for (const filename of required) assert.ok(release.files.some(file => file.filename === filename), `Missing preview artifact: ${filename}`);
  for (const file of release.files) {
    assert.equal(path.basename(file.filename), file.filename);
    assert.equal(hash(path.join(releaseDirectory, file.filename)), file.sha256);
  }
  for (const name of ['battle-status', 'build-scope', 'menu', 'sumo', 'welcome']) {
    const report = read(path.join(releaseDirectory, `${name}-verification.json`));
    assert.equal(report.targetSha256, release.targetSha256);
  }
  const battle = read(path.join(releaseDirectory, 'battle-status-verification.json'));
  assert.deepEqual(battle.results.map(entry => entry.name), ['normal', 'poison', 'curse', 'paralysis', 'combined', 'injury', 'excellent', 'invincible']);
  for (const entry of battle.results) {
    assert.equal(entry.exactNativeBattleFont, true);
    assert.equal(entry.oldGlyphNegativeControlsPassed, true);
    assert.equal(entry.otherGameplayBytesUnchanged, true);
  }
  const scope = read(path.join(releaseDirectory, 'build-scope-verification.json'));
  assert.equal(scope.status, 'passed');
  for (const gate of ['tests', 'codecs', 'welcome', 'sumo', 'menu']) assert.ok(scope.completed.includes(gate));
  const target = fs.readFileSync(path.join(releaseDirectory, 'opening-zh-Hant.sfc'));
  const baseline = fs.readFileSync(path.join(inheritedDirectory, 'opening-zh-Hant.sfc'));
  assert.equal(hash(path.join(inheritedDirectory, 'opening-zh-Hant.sfc')), release.baselineSha256);
  assert.equal(target.length, 0x400000);
  assert.equal(target.readUInt16LE(0xffdc) ^ target.readUInt16LE(0xffde), 65535);
  assert.equal(target.reduce((sum, byte) => (sum + byte) & 65535, 0), target.readUInt16LE(0xffde));
  const unchanged = Buffer.from(target);
  for (const [start, end] of [[0xffdc, 0xffe0], [0x3000c, 0x3000f], [0x3004c, 0x3004f], [0x3c0000, 0x3c06c0], [0x3c0800, 0x3c1928], [0x3e0000, 0x3f0000]]) baseline.copy(unchanged, start, start, end);
  assert.ok(unchanged.equals(baseline), 'Non-graphics game data changed');
} else {
  assert.equal(release.version, version);
  for (const field of gates) assert.equal(release[field], true, `Unmet release gate: ${field}`);
}
for (const [filename, expected] of Object.entries(release.artifactSha256 ?? {})) {
  assert.equal(hash(path.join(releaseDirectory, filename)), expected, `Release artifact changed: ${filename}`);
}
const expected = release.targetSha256;
const previousVersion = plan ? path.basename(plan.baseDirectory).replace('opening-preview-', '') : 'v42-sumo-fix';
assert.match(previousVersion, /^v\d+(?:-sumo-fix)?$/);
const previous = plan ? read(path.join(root, plan.baseDirectory, 'build.json')).targetSha256
  : '598c791126d88360435c4c37e5d3c06b8902a1f95d8ded12add8b5d8596c604a';
const candidate = path.join(releaseDirectory, 'opening-zh-Hant.sfc');
assert.equal(hash(candidate), expected);
assert.equal(hash(deviceRom), previous, 'Device ROM changed; inspect before replacing');
assert.ok(fs.lstatSync(deviceRom).isFile() && !fs.lstatSync(deviceRom).isSymbolicLink());
const inventory = directory => fs.readdirSync(directory).filter(name =>
  name.startsWith(stem) && fs.lstatSync(path.join(directory, name)).isFile())
  .sort().map(name => ({ name, sha256: hash(path.join(directory, name)) }));
const saves = inventory(savesDirectory);
const screenshots = inventory(screenshotDirectory);
const directoryNames = fs.readdirSync(screenshotDirectory).sort();
const cheats = ['Snes9x', '0QuickLoad'].map(folder => {
  const filename = `/Volumes/share/cheats/cht/${folder}/${stem}.cht`;
  return { filename, sha256: hash(filename), backupName: `${folder}.cht` };
});
const review = reviewedOnly && !installOnly ? read(path.join(root, plan.screenshotReview)) : null;
if (review) {
  assert.equal(review.version, version);
  assert.equal(review.targetSha256, expected, 'Screenshot review targets a different ROM');
  assert.equal(review.nativeDialoguePending, false, 'Screenshot dialogue verification is incomplete');
  assert.equal(release.screenshotCoveragePassed, true, 'Screenshot coverage gate is incomplete');
  assert.equal(hash(path.join(root, plan.screenshotReview)), release.artifactSha256['screenshot-review.json'], 'Screenshot review differs from packaged evidence');
  assert.ok(review.screenshots.length > 0 && review.screenshots.every(entry => entry.reviewed && entry.resolved));
}
const audit = installOnly || battlePreview ? { backupDirectory: null, screenshots: [] } : plan ? {
  backupDirectory: path.join(releaseDirectory, 'deployment-backup/screenshots'),
  screenshots: review?.screenshots ?? screenshots.filter(entry => entry.name.startsWith(`${stem}-`) && entry.name.endsWith('.png')),
} : read(path.join(root, 'translations/screenshot-review-20261003.json'));
if (!plan && !installOnly) assert.equal(audit.screenshots.length, 108);
assert.equal(new Set(audit.screenshots.map(entry => entry.name)).size, audit.screenshots.length);
for (const screenshot of audit.screenshots) {
  if (!plan || reviewedOnly) assert.ok(screenshot.reviewed);
  assert.equal(path.basename(screenshot.name), screenshot.name);
  assert.ok(screenshot.name.startsWith(`${stem}-`) && screenshot.name.endsWith('.png'));
  const original = path.join(screenshotDirectory, screenshot.name);
  assert.ok(fs.lstatSync(original).isFile() && !fs.lstatSync(original).isSymbolicLink());
  assert.equal(hash(original), screenshot.sha256);
  if (!plan) assert.equal(hash(path.join(audit.backupDirectory, screenshot.name)), screenshot.sha256);
}
const protect = () => {
  assert.deepEqual(inventory(savesDirectory), saves, 'Save files changed; do not restore or overwrite them');
  for (const cheat of cheats) assert.equal(hash(cheat.filename), cheat.sha256, 'Cheats changed');
};
const backupDirectory = path.join(releaseDirectory, 'deployment-backup');
const reportPath = path.join(releaseDirectory, 'deployment-verification.json');
assert.ok(!fs.existsSync(backupDirectory) && !fs.existsSync(reportPath), 'Existing deployment state: inspect before retrying');
console.log(JSON.stringify({ preflight: 'passed', protectedSaves: saves.length, protectedCheats: cheats.length,
  screenshotsToRemove: audit.screenshots.length, relatedScreenshotsRetained: screenshots.length - audit.screenshots.length,
  unrelatedScreenshotEntriesRetained: directoryNames.length - screenshots.length }));
if (!installOnly && !process.argv.includes(plan && !reviewedOnly ? '--install-and-remove-related' : '--install-and-remove-reviewed')) process.exit(0);
protect();
fs.mkdirSync(backupDirectory);
fs.mkdirSync(path.join(backupDirectory, 'saves'));
write(path.join(backupDirectory, `previous-${previousVersion}.sfc`), fs.readFileSync(deviceRom));
assert.equal(hash(path.join(backupDirectory, `previous-${previousVersion}.sfc`)), previous);
if (plan && !installOnly) {
  fs.mkdirSync(audit.backupDirectory);
  for (const screenshot of audit.screenshots) {
    const destination = path.join(audit.backupDirectory, screenshot.name);
    write(destination, fs.readFileSync(path.join(screenshotDirectory, screenshot.name)));
    assert.equal(hash(destination), screenshot.sha256);
  }
}
for (const save of saves) {
  const destination = path.join(backupDirectory, 'saves', save.name);
  write(destination, fs.readFileSync(path.join(savesDirectory, save.name)));
  assert.equal(hash(destination), save.sha256);
}
for (const cheat of cheats) {
  write(path.join(backupDirectory, cheat.backupName), fs.readFileSync(cheat.filename));
  assert.equal(hash(path.join(backupDirectory, cheat.backupName)), cheat.sha256);
}
write(path.join(backupDirectory, 'backup-manifest.json'), {
  previousRomSha256: previous, saves, cheats, screenshots, directoryNames,
  screenshotBackupDirectory: audit.backupDirectory, removalAllowlist: audit.screenshots.map(({ name, sha256 }) => ({ name, sha256 })),
});
const staged = path.join(path.dirname(deviceRom), `.momotaro-${version}-${randomUUID()}.tmp`);
write(staged, fs.readFileSync(candidate));
assert.equal(hash(staged), expected);
protect();
assert.deepEqual(inventory(screenshotDirectory), screenshots);
assert.equal(hash(deviceRom), previous);
const report = { version, status: 'prepared', targetSha256: expected, previousSha256: previous,
  devicePath: deviceRom, stagedPath: staged, backupDirectory, deletedScreenshots: [],
  savesWritten: false, cheatsWritten: false, physicalDeviceBootVerified: false };
write(reportPath, report);
fs.renameSync(staged, deviceRom);
assert.ok(fs.readFileSync(deviceRom).equals(fs.readFileSync(candidate)), 'Full ROM readback mismatch');
Object.assign(report, { status: 'installed-readback-verified', fullReadbackVerified: true, bytes: fs.statSync(deviceRom).size });
write(reportPath, report, 'w');
protect();
for (const screenshot of audit.screenshots) {
  const original = path.join(screenshotDirectory, screenshot.name);
  assert.equal(hash(deviceRom), expected, 'Installed ROM changed before screenshot cleanup');
  assert.equal(hash(original), screenshot.sha256, 'Screenshot changed; do not delete');
  assert.equal(hash(path.join(audit.backupDirectory, screenshot.name)), screenshot.sha256, 'Backup changed; do not delete');
  fs.unlinkSync(original);
  assert.ok(!fs.existsSync(original));
  report.deletedScreenshots.push({ name: screenshot.name, sha256: screenshot.sha256 });
  write(reportPath, report, 'w');
}
protect();
const removed = new Set(report.deletedScreenshots.map(entry => entry.name));
assert.deepEqual(inventory(screenshotDirectory), screenshots.filter(entry => !removed.has(entry.name)));
assert.deepEqual(fs.readdirSync(screenshotDirectory).sort(), directoryNames.filter(name => !removed.has(name)));
assert.equal(hash(deviceRom), expected);
Object.assign(report, { status: installOnly ? 'deployed-rom-readback-and-protected-files-verified' : plan && !reviewedOnly ? 'deployed-and-related-screenshots-removed' : 'deployed-and-reviewed-screenshots-removed', completedAt: new Date().toISOString(),
  unchangedSaveFiles: saves.length, unchangedCheatFiles: cheats.length, screenshotsDeleted: removed.size,
  unrelatedScreenshotEntriesPreserved: true, screenshotBackupsVerified: !installOnly, screenshotsPreserved: installOnly });
write(reportPath, report, 'w');
release.status = report.status;
release.device = { deployed: true, targetSha256: expected, fullReadbackVerified: true,
  screenshotsDeleted: removed.size, savesWritten: false, cheatsWritten: false,
  deploymentReport: 'deployment-verification.json', physicalDeviceBootVerified: false };
write(path.join(releaseDirectory, 'release-verification.json'), release, 'w');
console.log(JSON.stringify({ status: report.status, targetSha256: expected, screenshotsDeleted: removed.size,
  unchangedSaveFiles: saves.length, unchangedCheatFiles: cheats.length, fullReadbackVerified: true }, null, 2));
