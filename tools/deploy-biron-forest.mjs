import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [candidateArgument, nativeArgument, saveArgument] = process.argv.slice(2);
assert.ok(candidateArgument && nativeArgument && saveArgument,
  'Usage: node tools/deploy-biron-forest.mjs CANDIDATE NATIVE_REPORT_DIRECTORY SAVE_LOAD_DIRECTORY [--install]');
const candidate = path.resolve(candidateArgument);
const metadata = JSON.parse(fs.readFileSync(path.join(candidate, 'build.json')));
const binary = JSON.parse(fs.readFileSync(path.join(candidate, 'biron-verification.json')));
const native = JSON.parse(fs.readFileSync(path.join(nativeArgument, 'verification.json')));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = filename => digest(fs.readFileSync(filename));
const previousSha256 = 'b74ddb417f2cb5936c75c9046e21b731c3b8658788617a66deb2bf07d33f5a1e';
const stem = 'Shin Momotarou Densetsu';
const target = `/Volumes/share/roms/snes/${stem} (Traditional Chinese).sfc`;
const backup = path.join(root, 'verification/remaining-completion/deployment-backup-biron-forest-v1');
assert.ok(!fs.existsSync(backup), 'Deployment backup already exists; inspect the report instead of rerunning');
assert.equal(metadata.bironForest.baselineSha256, previousSha256);
assert.equal(binary.baselineSha256, previousSha256);
assert.equal(binary.targetSha256, metadata.targetSha256);
assert.equal(native.targetSha256, metadata.targetSha256);
assert.equal(binary.onlyLocationBlockAndChecksumChanged, true);
const scene = native.scenes.find(entry => entry.name === 'screenshot-locations' && entry.firstIndex === 28);
assert.equal(scene.originalRelocationFramesIdentical, true);
assert.ok(scene.renderedWords['比隆森林']);
const capture = path.join(nativeArgument, 'screenshot-locations-28-translated', scene.renderedWords['比隆森林'].frame);
assert.ok(fs.statSync(capture).size > 100000);
const saveState = fs.readFileSync(path.join(saveArgument, 'state.bin'));
const savedRam = saveState.indexOf(Buffer.from('RAM:131072:'));
assert.ok(savedRam >= 0);
assert.equal(saveState.subarray(savedRam + 11 + 0x3d50, savedRam + 11 + 0x3d55).toString('hex'), '7f577f7f00');
assert.ok(fs.statSync(path.join(saveArgument, 'frame-600.ppm')).size > 100000);
assert.ok(fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink());
const previous = fs.readFileSync(target);
const next = fs.readFileSync(path.join(candidate, metadata.romFilename));
assert.equal(digest(previous), previousSha256);
assert.equal(digest(next), metadata.targetSha256);
assert.equal(previous.length, next.length);
for (let offset = 0; offset < next.length; offset++) {
  if (next[offset] === previous[offset]) continue;
  assert.ok((offset >= 0xffdc && offset < 0xffe0) || (offset >= 0x3d9800 && offset < 0x3d9800 + 1059));
}
const saveRoot = '/Volumes/share/saves/snes';
const inventory = directory => fs.readdirSync(directory).sort()
  .filter(name => directory !== saveRoot || name.startsWith(stem))
  .map(name => {
    const filename = path.join(directory, name);
    const stat = fs.lstatSync(filename);
    assert.ok(!stat.isSymbolicLink());
    return { name, ...(stat.isFile() ? { sha256: hash(filename) } : { entries: inventory(filename) }) };
  });
const saves = inventory(saveRoot);
const cheats = ['Snes9x', '0QuickLoad'].map(folder => {
  const filename = `/Volumes/share/cheats/cht/${folder}/${stem} (Traditional Chinese).cht`;
  return { filename, sha256: hash(filename) };
});
console.log(JSON.stringify({ preflight: 'passed', previousSha256, targetSha256: metadata.targetSha256,
  saveEntries: saves.length, cheatFiles: cheats.length }, null, 2));
if (!process.argv.includes('--install')) process.exit(0);
const write = (filename, bytes, flag = 'wx') => {
  const descriptor = fs.openSync(filename, flag);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
};
fs.mkdirSync(backup);
const backupFile = path.join(backup, 'previous-restaurant-cancel.sfc');
write(backupFile, previous);
assert.equal(hash(backupFile), previousSha256);
write(path.join(backup, 'protected-files.json'), JSON.stringify({ saves, cheats }, null, 2) + '\n');
write(path.join(candidate, 'native-verification.json'), JSON.stringify(native, null, 2) + '\n');
write(path.join(candidate, 'biron-label.ppm'), fs.readFileSync(capture));
write(path.join(candidate, 'save245-load.ppm'), fs.readFileSync(path.join(saveArgument, 'frame-600.ppm')));
const report = {
  status: 'backed-up', target, previousSha256, targetSha256: metadata.targetSha256,
  backupFile, saveEntries: saves.length, savesWritten: false, cheatsWritten: false,
  onlyLocationBlockAndChecksumChanged: true, nativeNamePixelsVerified: true,
  save245Loaded: true, savedCityTokenPreserved: true,
  actualStoryRouteVerified: false, physicalDeviceActivationVerified: false,
};
const reportPath = path.join(candidate, 'deployment-verification.json');
write(reportPath, JSON.stringify(report, null, 2) + '\n');
const staged = path.join(path.dirname(target), `.biron-forest-${randomUUID()}.tmp`);
write(staged, next);
assert.equal(hash(staged), metadata.targetSha256);
assert.equal(hash(target), previousSha256);
fs.renameSync(staged, target);
assert.equal(hash(target), metadata.targetSha256);
report.status = 'rom-replaced-readback-verified';
write(reportPath, JSON.stringify(report, null, 2) + '\n', 'w');
assert.deepEqual(inventory(saveRoot), saves, 'Save files changed during deployment');
for (const cheat of cheats) assert.equal(hash(cheat.filename), cheat.sha256, 'Cheat file changed during deployment');
report.status = 'biron-forest-deployed-readback-and-protected-files-verified';
report.completedAt = new Date().toISOString();
write(reportPath, JSON.stringify(report, null, 2) + '\n', 'w');
console.log(JSON.stringify(report, null, 2));