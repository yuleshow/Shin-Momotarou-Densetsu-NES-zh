import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function updateOneHitCheat(text, { previousCode, code, description }) {
  const fields = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/);
    assert.ok(match, `Unrecognized cheat field: ${line}`);
    assert.ok(!fields.has(match[1]), `Duplicate cheat field: ${match[1]}`);
    fields.set(match[1], JSON.parse(match[2]));
  }
  const matches = [...fields].filter(([key, value]) => /^cheat\d+_code$/.test(key) && value === previousCode);
  assert.equal(matches.length, 1, 'Expected exactly one known previous one-hit item');
  const prefix = matches[0][0].replace(/_code$/, '');
  assert.match(String(fields.get(`${prefix}_desc`)), /^One-hit defeat/);
  assert.equal(Number(fields.get(`${prefix}_handler`)), 0);
  assert.ok(['true', 'false'].includes(String(fields.get(`${prefix}_enable`))));
  assert.ok(Number(prefix.slice(5)) < Number(fields.get('cheats')));
  assert.ok(code.length <= 255);
  assert.match(code, /^[0-9A-F]{8}(?:\+[0-9A-F]{8})*$/);
  let result = text;
  for (const [field, value] of [['desc', description], ['code', code]]) {
    const pattern = new RegExp(`^(\\s*${prefix}_${field}\\s*=\\s*)[^\\r\\n]*(\\r?)$`, 'm');
    assert.ok(pattern.test(result));
    result = result.replace(pattern, (line, assignment, ending) => `${assignment}${JSON.stringify(value)}${ending}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = filename => JSON.parse(fs.readFileSync(path.join(root, filename)));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const hash = filename => digest(fs.readFileSync(filename));
  const stem = 'Shin Momotarou Densetsu (Traditional Chinese)';
  const local = fs.readFileSync(path.join(root, 'cheats', `${stem}.cht`), 'utf8');
  const native = read('cheats/one-hit-lizard-verification.json');
  assert.equal(native.cheatSha256, digest(Buffer.from(local)));
  assert.equal(native.runs.length, 27);
  assert.deepEqual(native.hook.excludedEnemyIds, [25]);
  assert.ok(native.checks.every(check => check.lizardGameplayWramIdenticalFrames === 80 && check.lizardDamageObserved));
  const update = { previousCode: read('cheats/one-hit-verification.json').code,
    code: JSON.parse(local.match(/^cheat10_code = (.+)$/m)[1]), description: JSON.parse(local.match(/^cheat10_desc = (.+)$/m)[1]) };
  assert.equal(update.code, native.code);
  const deviceRom = `/Volumes/share/roms/snes/${stem}.sfc`;
  const romHash = hash(deviceRom);
  assert.ok(Object.values(native.romHashes).includes(romHash), 'Device ROM was not covered by native verification');
  const inventory = (directory, filter = () => true) => fs.readdirSync(directory).filter(filter).sort().map(name => {
    const filename = path.join(directory, name);
    const stat = fs.lstatSync(filename);
    assert.ok(!stat.isSymbolicLink(), `Unexpected symlink: ${filename}`);
    return { name, type: stat.isFile() ? 'file' : 'directory', ...(stat.isFile() ? { sha256: hash(filename) } : {}) };
  });
  const saveRoot = '/Volumes/share/saves/snes';
  const screenshotRoot = '/Volumes/share/screenshots';
  const saves = inventory(saveRoot, name => name.startsWith(stem));
  const screenshots = inventory(screenshotRoot);
  const targets = ['Snes9x', '0QuickLoad'].map(folder => {
    const filename = `/Volumes/share/cheats/cht/${folder}/${stem}.cht`;
    assert.ok(fs.lstatSync(filename).isFile() && !fs.lstatSync(filename).isSymbolicLink());
    const before = fs.readFileSync(filename, 'utf8');
    const after = updateOneHitCheat(before, update);
    assert.notEqual(before, after);
    return { folder, filename, before, after, previousSha256: digest(Buffer.from(before)), targetSha256: digest(Buffer.from(after)) };
  });
  const protect = () => {
    assert.equal(hash(deviceRom), romHash, 'ROM changed during cheat deployment');
    assert.deepEqual(inventory(saveRoot, name => name.startsWith(stem)), saves, 'Save files changed');
    assert.deepEqual(inventory(screenshotRoot), screenshots, 'Screenshots changed');
  };
  console.log(JSON.stringify({ preflight: 'passed', romHash, saves: saves.length, screenshotEntries: screenshots.length,
    targets: targets.map(({ folder, previousSha256, targetSha256 }) => ({ folder, previousSha256, targetSha256 })) }, null, 2));
  if (!process.argv.includes('--install')) process.exit(0);
  const backup = path.join(root, 'cheats/deployment-backup-lizard-exception-20261006');
  const reportPath = path.join(root, 'cheats/one-hit-lizard-deployment-verification.json');
  assert.ok(!fs.existsSync(backup) && !fs.existsSync(reportPath), 'Existing deployment state: inspect before retrying');
  const write = (filename, data, flag = 'wx') => {
    const descriptor = fs.openSync(filename, flag);
    try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  };
  fs.mkdirSync(backup);
  for (const target of targets) {
    write(path.join(backup, `${target.folder}.cht`), target.before);
    assert.equal(hash(path.join(backup, `${target.folder}.cht`)), target.previousSha256);
  }
  write(path.join(backup, 'manifest.json'), JSON.stringify({ romHash, saves, screenshots,
    targets: targets.map(({ folder, filename, previousSha256, targetSha256 }) => ({ folder, filename, previousSha256, targetSha256 })) }, null, 2) + '\n');
  const report = { status: 'prepared', excludedEnemyIds: [25], code: update.code, deviceRomSha256: romHash,
    unchangedSaveEntries: saves.length, unchangedScreenshotEntries: screenshots.length, romWritten: false,
    savesWritten: false, screenshotsDeleted: 0, existingTogglesPreserved: true, physicalDeviceActivationVerified: false, targets: [] };
  write(reportPath, JSON.stringify(report, null, 2) + '\n');
  for (const target of targets) {
    protect();
    assert.equal(hash(target.filename), target.previousSha256, 'Cheat file changed since preflight');
    const staged = path.join(path.dirname(target.filename), `.lizard-exception-${randomUUID()}.tmp`);
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
}