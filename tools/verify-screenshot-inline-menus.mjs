import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [runner, core, preview, output, suppliedState] = process.argv.slice(2);
assert.ok(runner && core && preview && output,
  'Usage: node tools/verify-screenshot-inline-menus.mjs RUNNER CORE PREVIEW NEW_OUTPUT [FIELD_STATE]');
const definition = JSON.parse(fs.readFileSync(path.join(root, 'translations/screenshot-inline-menus.release.json')));
const metadata = JSON.parse(fs.readFileSync(path.join(preview, 'build.json')));
const source = fs.readFileSync(path.join(root, 'assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc'));
const target = fs.readFileSync(path.join(preview, metadata.romFilename ?? 'opening-zh-Hant.sfc'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(source), definition.sourceSha256);
assert.equal(sha256(target), metadata.targetSha256);
fs.mkdirSync(output);

function checksum(rom) {
  rom.writeUInt16LE(65535, 0xffdc);
  rom.writeUInt16LE(0, 0xffde);
  const sum = rom.reduce((total, value) => (total + value) & 65535, 0);
  rom.writeUInt16LE(sum ^ 65535, 0xffdc);
  rom.writeUInt16LE(sum, 0xffde);
}

function run(rom, name, frames, inputs, state) {
  const directory = path.join(output, name);
  const args = [core, rom, directory, String(frames), inputs];
  if (state) args.push(state);
  const result = spawnSync(runner, args, {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, MOMOTARO_CAPTURE_EVERY: '30', MOMOTARO_CHEATS: '', MOMOTARO_TRACE: '' },
  });
  assert.equal(result.status, 0, `${name}: ${result.stderr}\n${result.stdout}`);
  return directory;
}

const ram = (directory, frame) => fs.readFileSync(path.join(directory, `wram-${frame}.bin`));
const statePath = directory => path.join(directory, 'state.bin');

function encodeMenu(menu) {
  const pieces = [];
  let cursor = Number(menu.start);
  assert.equal(source.subarray(cursor, Number(menu.end)).toString('hex'), menu.originalHex);
  for (const entry of menu.entries) {
    const offset = Number(entry.offset);
    assert.equal(source.subarray(offset, offset + entry.originalHex.length / 2).toString('hex'), entry.originalHex);
    pieces.push(source.subarray(cursor, offset));
    for (const character of entry.translation) {
      const glyph = metadata.glyphs.find(glyph => glyph.character === character);
      assert.ok(glyph, `Missing ${character}`);
      const code = Buffer.from(glyph.code, 'hex');
      assert.ok(code[0] !== 0x24 && code[0] !== 0x25, `Unsafe inline glyph prefix: ${character}`);
      pieces.push(code);
    }
    cursor = offset + entry.originalHex.length / 2;
  }
  pieces.push(source.subarray(cursor, Number(menu.end)));
  return Buffer.concat(pieces);
}

function assertWords(filename, words) {
  const image = fs.readFileSync(filename);
  const header = /^P6\n(\d+) (\d+)\n255\n/.exec(image.subarray(0, 64).toString('ascii'));
  assert.ok(header);
  const width = Number(header[1]), height = Number(header[2]);
  const pixels = image.subarray(header[0].length);
  const brightness = Uint8Array.from({ length: width * height }, (_, index) =>
    Math.max(...pixels.subarray(index * 3, index * 3 + 3)));
  for (const word of words) {
    const points = [];
    [...word].forEach((character, index) => {
      const glyph = metadata.glyphs.find(entry => entry.character === character);
      assert.ok(Number.isInteger(glyph?.offset));
      for (let row = 0; row < 15; row++) {
        for (let column = 0; column < 12; column++) {
          const plane = number => column < 8
            ? (target[glyph.offset + number * 23 + row] >> (7 - column)) & 1
            : (target[glyph.offset + number * 23 + 15 + (row >> 1)] >> ((row % 2 === 0 ? 4 : 0) + 11 - column)) & 1;
          if (plane(0)) points.push({ offset: (row + 1) * width + index * 12 + column, foreground: Boolean(plane(1)) });
        }
      }
    });
    assert.ok(points.length);
    let found = false;
    for (let row = 0; row <= height - 16 && !found; row++) {
      for (let column = 0; column <= width - [...word].length * 12; column++) {
        const origin = row * width + column;
        if (points.every(point => point.foreground ? brightness[origin + point.offset] >= 140 : brightness[origin + point.offset] <= 80)) {
          found = true;
          break;
        }
      }
    }
    assert.ok(found, `Missing rendered word ${word}: ${filename}`);
  }
}

// Only synthetic copies redirect the ordinary field-menu entry to a real event
// wrapper. The wrapper operands, menu parser and outcome callbacks remain intact.
function probeRom(bytes, menu, mask, name) {
  const rom = Buffer.alloc(0x400000, 255);
  bytes.copy(rom);
  assert.equal(source.subarray(0x1eee6, 0x1eeea).toString('hex'), '228ab385');
  assert.ok(rom.subarray(0x23e000, 0x23e040).every(value => value === 255));
  Buffer.from('5c00e0e3', 'hex').copy(rom, 0x1eee6);
  const wrapper = menu.name === 'karura-three-stories' ? '2268e784' : '22a2e784';
  Buffer.from(`228ab385a97f8d57198d5f198d60198d61199c6419a9${mask.toString(16).padStart(2, '0')}8d8619${wrapper}5c13ef81`, 'hex').copy(rom, 0x23e000);
  checksum(rom);
  const filename = path.join(output, `${name}.sfc`);
  fs.writeFileSync(filename, rom, { flag: 'wx' });
  return filename;
}

const originalFilename = path.join(root, 'assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc');
let fieldState = suppliedState;
if (!fieldState) {
  const local = path.join(root, 'opening-preview-v34/slot47-source/slot47-core.bin');
  assert.ok(fs.existsSync(local), 'Supply a native field state with its command menu closed');
  fieldState = statePath(run(originalFilename, 'field-fixture', 300, '30:3:b,120:3:b', local));
}
const report = {
  targetSha256: sha256(target), sourceSha256: sha256(source),
  runnerSha256: sha256(fs.readFileSync(runner)), coreSha256: sha256(fs.readFileSync(core)),
  synthetic: true, deviceWrites: false, fieldStateSha256: sha256(fs.readFileSync(fieldState)),
  fixture: 'Field-menu hook invokes original event wrappers; sentinel outcome values, slot zero and explicit exclusion masks are initialized in test copies only.',
  limitations: 'Tests cover native menu rendering, selectors and event outcome callbacks, not subsequent story scripts or full opponent battles.',
  menus: [],
};

for (const menu of definition.inlineMenus) {
  const encoded = encodeMenu(menu);
  assert.ok(target.subarray(Number(menu.target), Number(menu.target) + encoded.length).equals(encoded));
  assert.equal(target.readUInt16LE(Number(menu.pointerOperand)), Number(menu.target) & 65535);
  assert.equal(target[Number(menu.bankOperand)], 0xe3);
  assert.ok(target.subarray(Number(menu.end), menu.name === 'karura-three-stories' ? 0x4e7a2 : 0x4e81c)
    .equals(source.subarray(Number(menu.end), menu.name === 'karura-three-stories' ? 0x4e7a2 : 0x4e81c)), 'Native callbacks changed');
  const choices = menu.entries.length;
  const menuReport = { name: menu.name, storedBytes: encoded.length, cases: [] };
  // Mask 5 hides opponents one and three, exercising the 25 exclusion control
  // and the distinction between displayed row and original one-based index.
  for (const mask of choices === 4 ? [0, 5] : [0]) {
    const variants = {};
    for (const [variant, bytes] of [['source', source], ['target', target]]) {
      const prefix = `${menu.name}-${mask}-${variant}`;
      const filename = probeRom(bytes, menu, mask, prefix);
      const opened = run(filename, `${prefix}-open`, 300, '30:3:a', fieldState);
      variants[variant] = { filename, opened, prefix };
    }
    const enabled = menu.entries.map((entry, index) => ({ entry, selection: index + 1 }))
      .filter(({ selection }) => !(mask & (1 << (selection - 1))));
    assertWords(path.join(variants.target.opened, 'frame-300.ppm'), enabled.map(({ entry }) => entry.translation));
    for (const [row, { selection }] of enabled.entries()) {
      const cursorInputs = Array.from({ length: row }, (_, index) => `${30 + index * 60}:3:down`).join(',');
      const observations = {};
      for (const [variant, { filename, opened, prefix }] of Object.entries(variants)) {
        const cursor = run(filename, `${prefix}-cursor-${selection}`, 240, cursorInputs, statePath(opened));
        const selected = run(filename, `${prefix}-select-${selection}`, 300, '30:3:a', statePath(cursor));
        const values = ram(selected, 300);
        assert.equal(ram(cursor, 240)[0x137f], row * 4, `${prefix} selector row ${row}`);
        const outcome = choices === 3 ? values[0x1957] : values[0x195f];
        const expected = choices === 3 ? selection : source[0x4e817 + selection];
        assert.equal(outcome, expected, `${prefix} selection ${selection} callback`);
        if (choices === 4) assert.equal(values[0x1986], mask | (1 << (selection - 1)));
        observations[variant] = {
          cursor: ram(cursor, 240)[0x137f], outcome, mask: values[0x1986],
          timeline: Array.from({ length: 10 }, (_, index) => {
            const snapshot = ram(selected, (index + 1) * 30);
            return [snapshot[0x1957], snapshot[0x195f], snapshot[0x1986]];
          }),
        };
      }
      assert.deepEqual(observations.target, observations.source, `Selector/outcome/timing differs: ${menu.name}/${mask}/${selection}`);
      menuReport.cases.push({ mask, selection, ...observations });
    }
    for (const { filename, opened, prefix } of Object.values(variants)) {
      const cancelled = run(filename, `${prefix}-cancel`, 300, '30:3:b', statePath(opened));
      const values = ram(cancelled, 300);
      assert.equal(values[0x1957], 0x7f);
      assert.equal(values[0x195f], 0x7f);
      assert.equal(values[0x1986], mask);
      assert.equal(values[0x1380] & 0x80, 0x80, 'Header 37 must keep cancellation disabled');
      if (prefix.endsWith('-target')) {
        assertWords(path.join(cancelled, 'frame-300.ppm'), enabled.map(({ entry }) => entry.translation));
      }
      const selected = run(filename, `${prefix}-cancel-then-select`, 300, '30:3:a', statePath(cancelled));
      assert.equal(ram(selected, 300)[choices === 3 ? 0x1957 : 0x195f],
        choices === 3 ? enabled[0].selection : source[0x4e817 + enabled[0].selection],
        'Disabled cancel must leave menu usable');
    }
    menuReport.cases.push({ mask, cancel: 'disabled by native header 37; B ignored; subsequent A executes first enabled callback' });
  }
  report.menus.push(menuReport);
}
fs.writeFileSync(path.join(output, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
if (process.env.MOMOTARO_KEEP_INLINE_CAPTURES !== '1') {
  for (const entry of fs.readdirSync(output, { withFileTypes: true })) {
    const filename = path.join(output, entry.name);
    if (entry.isDirectory() && /-(open|cancel)$/.test(entry.name)) {
      for (const capture of fs.readdirSync(filename)) {
        if (capture !== 'frame-300.ppm') fs.rmSync(path.join(filename, capture));
      }
    } else if (entry.isDirectory() || entry.name.endsWith('.sfc')) {
      fs.rmSync(filename, { recursive: true });
    }
  }
}
console.log('Screenshot inline menus: native labels, all selectors, callbacks, exclusion masks and disabled cancel passed.');
