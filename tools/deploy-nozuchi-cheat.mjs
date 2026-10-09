import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stem = 'Shin Momotarou Densetsu (Traditional Chinese)';
const backup = path.join(root, 'cheats/deployment-backup-nozuchi-20261008');
const reportPath = path.join(root, 'cheats/nozuchi-deployment-verification.json');
const resume = process.argv.includes('--resume');
const prior = resume ? JSON.parse(fs.readFileSync(reportPath)) : null;
if (resume) assert.equal(prior.status, 'prepared');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = filename => digest(fs.readFileSync(filename));
const parse = text => {
  const fields = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/);
    assert.ok(match, `Unrecognized cheat field: ${line}`);
    assert.ok(!fields.has(match[1]), `Duplicate cheat field: ${match[1]}`);
    fields.set(match[1], JSON.parse(match[2]));
  }
  return fields;
};
const local = fs.readFileSync(path.join(root, 'cheats', `${stem}.cht`), 'utf8');
const source = parse(local);
assert.equal(Number(source.get('cheats')), 16);
assert.equal(source.get('cheat15_code'), '7E639731');
assert.equal(source.get('cheat15_enable'), false);
assert.equal(source.get('cheat15_handler'), 0);
const deviceRom = `/Volumes/share/roms/snes/${stem}.sfc`;
const romHash = hash(deviceRom);
assert.equal(romHash, hash(path.join(root, 'opening-preview-v65/opening-zh-Hant.sfc')));
const inventory = (directory, filter = () => true) => fs.readdirSync(directory).filter(filter).sort().map(name => {
  const filename = path.join(directory, name);
  const stat = fs.lstatSync(filename);
  assert.ok(!stat.isSymbolicLink(), `Unexpected symlink: ${filename}`);
  return { name, ...(stat.isFile() ? { sha256: hash(filename) } : { entries: inventory(filename) }) };
});
const saveRoot = '/Volumes/share/saves/snes';
const screenshotRoot = '/Volumes/share/screenshots';
const saves = inventory(saveRoot, name => name.startsWith(stem));
const screenshots = inventory(screenshotRoot, name => name.startsWith(stem));
if (resume) {
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json')));
  assert.equal(manifest.romHash, romHash);
  assert.deepEqual(saves, manifest.saves);
  assert.deepEqual(screenshots, manifest.screenshots.filter(entry => entry.name.startsWith(stem)));
}
const targets = ['Snes9x', '0QuickLoad'].map(folder => {
  const filename = `/Volumes/share/cheats/cht/${folder}/${stem}.cht`;
  assert.ok(fs.lstatSync(filename).isFile() && !fs.lstatSync(filename).isSymbolicLink());
  const current = fs.readFileSync(filename, 'utf8');
  const before = resume ? fs.readFileSync(path.join(backup, `${folder}.cht`), 'utf8') : current;
  if (resume) {
    const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json')));
    assert.equal(digest(before), manifest.targets.find(target => target.folder === folder).previousSha256);
  }
  const fields = parse(before);
  assert.equal(Number(fields.get('cheats')), 15, `${folder}: expected fifteen existing cheats`);
  assert.ok(![...fields.keys()].some(key => /^cheat15_/.test(key)));
  assert.ok(![...fields.values()].includes(source.get('cheat15_code')));
  const ending = before.includes('\r\n') ? '\r\n' : '\n';
  const appended = ['desc', 'code', 'enable', 'handler'].map(field =>
    `cheat15_${field} = ${JSON.stringify(source.get(`cheat15_${field}`))}`).join(ending);
  const after = before.replace(/^(\s*cheats\s*=\s*)[^\r\n]+/m, '$1"16"') + ending + appended + ending;
  const updated = parse(after);
  assert.equal(Number(updated.get('cheats')), 16);
  assert.equal(updated.size, fields.size + 4);
  for (const [key, value] of fields) if (key !== 'cheats') assert.deepEqual(updated.get(key), value);
  for (const field of ['desc', 'code', 'enable', 'handler']) {
    assert.deepEqual(updated.get(`cheat15_${field}`), source.get(`cheat15_${field}`));
  }
  assert.ok(current === before || (resume && current === after), 'Device cheat differs from backup and expected update');
  return { folder, filename, before, after, previousSha256: digest(before), targetSha256: digest(after) };
});
const protect = () => {
  assert.equal(hash(deviceRom), romHash, 'ROM changed during cheat deployment');
  assert.deepEqual(inventory(saveRoot, name => name.startsWith(stem)), saves, 'Save files changed');
  assert.deepEqual(inventory(screenshotRoot, name => name.startsWith(stem)), screenshots, 'Game screenshots changed');
};
console.log(JSON.stringify({ preflight: 'passed', deviceRomSha256: romHash, saves: saves.length,
  screenshotEntries: screenshots.length, targets: targets.map(({ folder, previousSha256, targetSha256 }) =>
    ({ folder, previousSha256, targetSha256 })) }, null, 2));
if (!process.argv.includes('--install')) process.exit(0);
if (!resume) assert.ok(!fs.existsSync(backup) && !fs.existsSync(reportPath), 'Inspect existing deployment before retrying');
const write = (filename, data, flag = 'wx') => {
  const descriptor = fs.openSync(filename, flag);
  try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
};
if (!resume) {
fs.mkdirSync(backup);
for (const target of targets) {
  write(path.join(backup, `${target.folder}.cht`), target.before);
  assert.equal(hash(path.join(backup, `${target.folder}.cht`)), target.previousSha256);
}
write(path.join(backup, 'manifest.json'), JSON.stringify({ romHash, saves, screenshots,
  targets: targets.map(({ folder, filename, previousSha256, targetSha256 }) =>
    ({ folder, filename, previousSha256, targetSha256 })) }, null, 2) + '\n');
  }
const report = { status: 'prepared', code: source.get('cheat15_code'), localCheatSha256: digest(local),
  deviceRomSha256: romHash, backupDirectory: backup, existingFieldsPreserved: true, newCheatDefaultOff: true,
  romWritten: false, savesWritten: false, screenshotsDeleted: 0, physicalDeviceActivationVerified: false, targets: [] };
if (resume) report.targets = prior.targets;
report.screenshotVerificationScope = 'game-prefixed-files';
write(reportPath, JSON.stringify(report, null, 2) + '\n', resume ? 'w' : 'wx');
for (const target of targets) {
  protect();
  if (hash(target.filename) === target.targetSha256) {
    assert.ok(report.targets.some(entry => entry.folder === target.folder && entry.fullReadbackVerified));
    continue;
  }
  assert.equal(hash(target.filename), target.previousSha256, 'Cheat file changed since preflight');
  const staged = path.join(path.dirname(target.filename), `.nozuchi-${randomUUID()}.tmp`);
  write(staged, target.after);
  assert.equal(hash(staged), target.targetSha256);
  fs.renameSync(staged, target.filename);
  assert.equal(fs.readFileSync(target.filename, 'utf8'), target.after);
  report.targets.push({ folder: target.folder, filename: target.filename, previousSha256: target.previousSha256,
    targetSha256: target.targetSha256, fullReadbackVerified: true });
  write(reportPath, JSON.stringify(report, null, 2) + '\n', 'w');
}
protect();
for (const target of targets) assert.equal(hash(target.filename), target.targetSha256);
report.status = 'deployed-cheats-readback-and-protected-files-verified';
report.completedAt = new Date().toISOString();
write(reportPath, JSON.stringify(report, null, 2) + '\n', 'w');
console.log(JSON.stringify(report, null, 2));