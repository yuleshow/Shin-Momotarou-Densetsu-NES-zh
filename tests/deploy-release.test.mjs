import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = fs.readFileSync(new URL('../tools/deploy-screenshot-release.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('fileURLToPath(import.meta.url)', 'scriptFilename');
const stem = 'Shin Momotarou Densetsu (Traditional Chinese)';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-install-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (filename, value) => {
    const destination = path.join(root, filename);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
  };
  const previous = Buffer.from('previous test ROM');
  const candidate = Buffer.from('candidate test ROM');
  write(`device/roms/snes/${stem}.sfc`, previous);
  write(`device/saves/snes/${stem}.state7`, 'protected save');
  write(`device/screenshots/${stem}-test.png`, 'protected screenshot');
  write('device/screenshots/other-game.png', 'unrelated screenshot');
  for (const folder of ['Snes9x', '0QuickLoad']) write(`device/cheats/cht/${folder}/${stem}.cht`, 'protected cheat');
  write('opening-preview-v98/build.json', { targetSha256: hash(previous) });
  write('opening-preview-v99/opening-zh-Hant.sfc', candidate);
  write('opening-preview-v99/release-verification.json', {
    version: 'v99', status: 'locally-verified-not-deployed', targetSha256: hash(candidate),
    nativeDialoguePassed: true, sumoRegressionPassed: true, glyphRegressionPassed: true,
    menuRegressionPassed: true, welcomePassed: true, ipsRoundtripPassed: true, checksumPassed: true,
    artifactSha256: { 'opening-zh-Hant.sfc': hash(candidate) },
  });
  write('plan.json', { version: 'v99', baseDirectory: 'opening-preview-v98' });
  const map = filename => typeof filename === 'string' && filename.startsWith('/Volumes/share/')
    ? path.join(root, 'device', filename.slice('/Volumes/share/'.length)) : filename;
  const sandboxFs = new Proxy(fs, { get(target, key) {
    if (typeof target[key] !== 'function') return target[key];
    return (...args) => {
      args[0] = map(args[0]);
      if (key === 'renameSync') args[1] = map(args[1]);
      return target[key](...args);
    };
  } });
  const execute = flags => vm.runInNewContext(source, {
    assert, fs: sandboxFs, path, createHash, randomUUID, fileURLToPath, Buffer,
    scriptFilename: path.join(root, 'tools/deploy-screenshot-release.mjs'),
    process: { argv: ['node', 'installer', '--plan', path.join(root, 'plan.json'), ...flags],
      exit: code => { throw new Error(`exit:${code}`); } },
    console: { log() {} },
  });
  return { root, execute, candidate, previous };
}

test('install-only replaces ROM with verified backup and preserves screenshots, saves and cheats', context => {
  const { root, execute, candidate, previous } = fixture(context);
  execute(['--install-only']);
  assert.ok(fs.readFileSync(path.join(root, `device/roms/snes/${stem}.sfc`)).equals(candidate));
  assert.ok(fs.readFileSync(path.join(root, 'opening-preview-v99/deployment-backup/previous-v98.sfc')).equals(previous));
  assert.equal(fs.readFileSync(path.join(root, `device/screenshots/${stem}-test.png`), 'utf8'), 'protected screenshot');
  assert.equal(fs.readFileSync(path.join(root, 'device/screenshots/other-game.png'), 'utf8'), 'unrelated screenshot');
  assert.equal(fs.readFileSync(path.join(root, `device/saves/snes/${stem}.state7`), 'utf8'), 'protected save');
  for (const folder of ['Snes9x', '0QuickLoad']) {
    assert.equal(fs.readFileSync(path.join(root, `device/cheats/cht/${folder}/${stem}.cht`), 'utf8'), 'protected cheat');
  }
  const report = JSON.parse(fs.readFileSync(path.join(root, 'opening-preview-v99/deployment-verification.json')));
  assert.equal(report.fullReadbackVerified, true);
  assert.equal(report.screenshotsDeleted, 0);
  assert.equal(report.screenshotsPreserved, true);
  assert.equal(report.screenshotBackupsVerified, false);
  assert.equal(report.unchangedSaveFiles, 1);
  assert.equal(report.unchangedCheatFiles, 2);
  assert.equal(report.status, 'deployed-rom-readback-and-protected-files-verified');
});

test('install-only rejects conflicting screenshot-removal flags before device writes', context => {
  const { root, execute, previous } = fixture(context);
  assert.throws(() => execute(['--install-only', '--install-and-remove-related']), /cannot be combined/);
  assert.ok(fs.readFileSync(path.join(root, `device/roms/snes/${stem}.sfc`)).equals(previous));
  assert.ok(!fs.existsSync(path.join(root, 'opening-preview-v99/deployment-backup')));
});

test('install-only refuses a changed device ROM', context => {
  const { root, execute } = fixture(context);
  fs.writeFileSync(path.join(root, `device/roms/snes/${stem}.sfc`), 'unexpected ROM');
  assert.throws(() => execute(['--install-only']), /Device ROM changed/);
  assert.equal(fs.readFileSync(path.join(root, `device/roms/snes/${stem}.sfc`), 'utf8'), 'unexpected ROM');
  assert.ok(!fs.existsSync(path.join(root, 'opening-preview-v99/deployment-backup')));
});

function reviewedFixture(context) {
  const setup = fixture(context);
  fs.writeFileSync(path.join(setup.root, 'plan.json'), JSON.stringify({ version: 'v99', baseDirectory: 'opening-preview-v98', screenshotReview: 'review.json' }));
  const review = JSON.stringify({ version: 'v99', targetSha256: hash(setup.candidate), nativeDialoguePending: false,
    screenshots: [{ name: `${stem}-test.png`, sha256: hash(Buffer.from('protected screenshot')), reviewed: true, resolved: true }] });
  fs.writeFileSync(path.join(setup.root, 'review.json'), review);
  fs.writeFileSync(path.join(setup.root, 'opening-preview-v99/screenshot-review.json'), review);
  const releasePath = path.join(setup.root, 'opening-preview-v99/release-verification.json');
  const release = JSON.parse(fs.readFileSync(releasePath));
  release.screenshotCoveragePassed = true;
  release.artifactSha256['screenshot-review.json'] = hash(review);
  fs.writeFileSync(releasePath, JSON.stringify(release));
  fs.writeFileSync(path.join(setup.root, `device/screenshots/${stem}-new.png`), 'new unreviewed screenshot');
  return setup;
}

test('reviewed-only install rejects pending or changed review evidence before writes', context => {
  const { root, execute, previous } = reviewedFixture(context);
  const filename = path.join(root, 'review.json');
  const review = JSON.parse(fs.readFileSync(filename));
  for (const pending of [true, undefined]) {
    fs.writeFileSync(filename, JSON.stringify({ ...review, nativeDialoguePending: pending }));
    assert.throws(() => execute(['--install-and-remove-reviewed']), /verification is incomplete/);
  }
  fs.writeFileSync(filename, JSON.stringify({ ...review, changed: true }));
  assert.throws(() => execute(['--install-and-remove-reviewed']), /differs from packaged evidence/);
  assert.ok(fs.readFileSync(path.join(root, `device/roms/snes/${stem}.sfc`)).equals(previous));
  assert.ok(!fs.existsSync(path.join(root, 'opening-preview-v99/deployment-backup')));
});

test('reviewed-only install backs up and removes only reviewed screenshots', context => {
  const { root, execute } = reviewedFixture(context);
  execute(['--install-and-remove-reviewed']);
  assert.ok(!fs.existsSync(path.join(root, `device/screenshots/${stem}-test.png`)));
  assert.equal(fs.readFileSync(path.join(root, `device/screenshots/${stem}-new.png`), 'utf8'), 'new unreviewed screenshot');
  assert.equal(fs.readFileSync(path.join(root, 'device/screenshots/other-game.png'), 'utf8'), 'unrelated screenshot');
  assert.equal(fs.readFileSync(path.join(root, `opening-preview-v99/deployment-backup/screenshots/${stem}-test.png`), 'utf8'), 'protected screenshot');
  const report = JSON.parse(fs.readFileSync(path.join(root, 'opening-preview-v99/deployment-verification.json')));
  assert.equal(report.status, 'deployed-and-reviewed-screenshots-removed');
  assert.equal(report.screenshotsDeleted, 1);
  assert.equal(report.unchangedSaveFiles, 1);
  assert.equal(report.unchangedCheatFiles, 2);
});

test('reviewed-only install refuses a changed screenshot and broad deletion flag', context => {
  const { root, execute, previous } = reviewedFixture(context);
  assert.throws(() => execute(['--install-and-remove-related']), /requires reviewed-only/);
  fs.writeFileSync(path.join(root, `device/screenshots/${stem}-test.png`), 'changed screenshot');
  assert.throws(() => execute(['--install-and-remove-reviewed']));
  assert.ok(fs.readFileSync(path.join(root, `device/roms/snes/${stem}.sfc`)).equals(previous));
  assert.ok(!fs.existsSync(path.join(root, 'opening-preview-v99/deployment-backup')));
});

function battleFixture(context) {
  const setup = fixture(context);
  const repository = fileURLToPath(new URL('../', import.meta.url));
  for (const version of ['v47', 'v48']) {
    const original = path.join(repository, `opening-preview-${version}`);
    const destination = path.join(setup.root, `opening-preview-${version}`);
    const release = JSON.parse(fs.readFileSync(path.join(original, 'release-verification.json')));
    fs.mkdirSync(destination);
    for (const filename of release.files?.map(file => file.filename) ?? Object.keys(release.artifactSha256)) fs.copyFileSync(path.join(original, filename), path.join(destination, filename));
    fs.writeFileSync(path.join(destination, 'release-verification.json'), JSON.stringify({ ...release, status: 'locally-verified-not-deployed' }));
  }
  fs.writeFileSync(path.join(setup.root, 'plan.json'), JSON.stringify({ version: 'v48', baseDirectory: 'opening-preview-v98',
    translationBaseDirectory: 'opening-preview-v47', scope: 'battle-status-graphics-preview' }));
  return setup;
}

test('battle preview install preserves saves, cheats and all screenshots', context => {
  const { root, execute } = battleFixture(context);
  execute(['--install-only']);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'opening-preview-v48/deployment-verification.json')));
  assert.equal(report.fullReadbackVerified, true);
  assert.equal(report.screenshotsDeleted, 0);
  assert.equal(report.unchangedSaveFiles, 1);
  assert.equal(report.unchangedCheatFiles, 2);
});

test('battle preview rejects changed evidence before backups or device writes', context => {
  const { root, execute, previous } = battleFixture(context);
  fs.appendFileSync(path.join(root, 'opening-preview-v48/battle-status-verification.json'), ' ');
  assert.throws(() => execute(['--install-only']), /AssertionError/);
  assert.ok(fs.readFileSync(path.join(root, `device/roms/snes/${stem}.sfc`)).equals(previous));
  assert.ok(!fs.existsSync(path.join(root, 'opening-preview-v48/deployment-backup')));
});