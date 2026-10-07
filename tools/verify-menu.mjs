import assert from 'node:assert/strict';
import { chineseCode, chineseFontGroup, chineseGlyphOffset, isGlyphPrefix } from './chinese-font.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeHuffman, decodeLz, readLzTextBlock } from './text-codec.mjs';
import { splitRecords } from './text-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [runner, core, previewDirectory, outputDirectory, controlDirectory, serviceState, caveState] = process.argv.slice(2);
assert.ok(runner && core && previewDirectory && outputDirectory, 'Usage: node tools/verify-menu.mjs RUNNER CORE PREVIEW_DIRECTORY NEW_OUTPUT_DIRECTORY [CONTROL_PREVIEW_DIRECTORY [SHOP_STATE [CAVE_STATE]]]');
const originalRom = path.join(root, 'assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc');
const metadata = JSON.parse(fs.readFileSync(path.join(previewDirectory, 'build.json')));
const translatedRom = path.join(previewDirectory, metadata.romFilename ?? 'menu-zh-Hant.sfc');
const hasTranslatedOpening = metadata.opening?.translated === true;
assert.ok(!hasTranslatedOpening || controlDirectory, 'Translated opening verification requires an untranslated control build');
const sha256 = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
assert.equal(sha256(originalRom), metadata.sourceSha256);
assert.equal(sha256(translatedRom), metadata.targetSha256);
const target = fs.readFileSync(translatedRom);
assert.equal(target.length, 0x400000);
assert.ok(target.subarray(0x4bb81, 0x4bb89).equals(fs.readFileSync(originalRom).subarray(0x4bb81, 0x4bb89)), 'Inline parser must preserve the original 24/25 menu controls');
assert.equal(target.reduce((total, byte) => (total + byte) & 65535, 0), target.readUInt16LE(0xffde));
assert.equal(target.readUInt16LE(0xffdc) ^ target.readUInt16LE(0xffde), 65535);
const sumoMenu = metadata.inlineMenus?.find(menu => menu.name === 'sumo-techniques');
if (sumoMenu) {
  assert.equal(Number(sumoMenu.sourceEnd), 0x2e927, 'Sumo menu must include all three selection callbacks');
  const callbacks = Buffer.from('2c0027e98227e98227e982', 'hex');
  assert.ok(target.subarray(Number(sumoMenu.target), Number(sumoMenu.target) + 0x100).includes(callbacks),
    'Sumo menu is missing its native selection callbacks');
  assert.ok(target.subarray(0x2e927, 0x2e934).equals(fs.readFileSync(originalRom).subarray(0x2e927, 0x2e934)),
    'Sumo action selection handler changed');
}
fs.mkdirSync(outputDirectory);

function run(rom, name, frames, inputs, state, captureEvery = 300, cheats) {
  const destination = path.join(outputDirectory, name);
  if (!state && metadata.welcome && fs.readFileSync(rom).subarray(0xf002, 0xf006).toString('hex') === '5c0000fe') inputs = `30:3:start,${inputs}`;
  const args = [core, rom, destination, String(frames), inputs];
  if (state) args.push(state);
  const result = spawnSync(runner, args, { stdio: 'inherit', timeout: 120000, env: { ...process.env, MOMOTARO_CAPTURE_EVERY: String(captureEvery), ...(cheats ? { MOMOTARO_CHEATS: cheats } : {}) } });
  assert.equal(result.status, 0, `Emulator failed: ${name}`);
  return destination;
}

function assertRenderedWords(filename, words, expectedPositions = {}) {
  const image = fs.readFileSync(filename);
  const header = /^P6\n(\d+) (\d+)\n255\n/.exec(image.subarray(0, 64).toString('ascii'));
  assert.ok(header, 'Unsupported screenshot format');
  const width = Number(header[1]);
  const height = Number(header[2]);
  const pixels = image.subarray(header[0].length);
  assert.equal(pixels.length, width * height * 3);
  const brightness = Uint8Array.from({ length: width * height }, (_, index) => Math.max(...pixels.subarray(index * 3, index * 3 + 3)));
  const matches = {};
  for (const word of words) {
    const points = [];
    [...word].forEach((character, characterIndex) => {
      const index = metadata.glyphs.findIndex(glyph => glyph.character === character);
      assert.ok(index >= 0, `Missing glyph: ${character}`);
      const offset = metadata.glyphs[index].offset ?? parseInt(metadata.newFontGroupOffset, 16) + Math.floor(index / 64) * (1 + 64 * 46) + 1 + (index % 64) * 46;
      for (let row = 0; row < 15; row++) {
        for (let column = 0; column < 12; column++) {
          const plane = number => column < 8
            ? (target[offset + number * 23 + row] >> (7 - column)) & 1
            : (target[offset + number * 23 + 15 + (row >> 1)] >> ((row % 2 === 0 ? 4 : 0) + 11 - column)) & 1;
          if (plane(0)) points.push({ offset: (row + 1) * width + characterIndex * 12 + column, foreground: Boolean(plane(1)) });
        }
      }
    });
    const expected = expectedPositions[word];
    for (let row = expected?.y ?? 0; row <= (expected?.y ?? height - 16) && !matches[word]; row++) {
      for (let column = expected?.x ?? 0; column <= (expected?.x ?? width - [...word].length * 12); column++) {
        const position = row * width + column;
        if (points.every(point => point.foreground ? brightness[position + point.offset] >= 140 : brightness[position + point.offset] <= 80)) {
          matches[word] = { x: column, y: row };
          break;
        }
      }
    }
    assert.ok(matches[word], `Rendered glyphs not found: ${word} in ${filename}`);
  }
  return matches;
}

function encodeWord(word) {
  return Buffer.concat([...word].map(character => {
    const glyph = metadata.glyphs.find(entry => entry.character === character);
    assert.ok(glyph, `Missing layout-probe glyph: ${character}`);
    return Buffer.from(glyph.code, 'hex');
  }));
}

function readNames(block) {
  const offset = Number(block.relocatedOffset);
  const names = [];
  let start = offset + 1;
  let cursor = start;
  for (let index = 0; index < block.strings; index++) {
    while (target[cursor] !== 0) {
      assert.ok(cursor < offset + 0x1000, 'Unterminated name in layout probe');
      cursor += isGlyphPrefix(target[cursor]) || target[cursor] === 2 ? 2 : 1;
    }
    names.push(target.subarray(start, cursor));
    start = ++cursor;
  }
  return names;
}

function nameLayoutProbe(block, replacements, filename) {
  let replaced = 0;
  const names = [Buffer.from([0])];
  for (const original of readNames(block)) {
    const replacement = replacements.get(original.toString('hex'));
    if (replacement) replaced++;
    names.push(replacement ? encodeWord(replacement) : original, Buffer.from([0]));
  }
  assert.equal(replaced, replacements.size);
  const data = Buffer.concat(names);
  assert.ok(data.length < 0x1000);
  const layoutRom = Buffer.from(target);
  data.copy(layoutRom, Number(block.relocatedOffset));
  layoutRom.writeUInt16LE(65535, 0xffdc);
  layoutRom.writeUInt16LE(0, 0xffde);
  const sum = layoutRom.reduce((total, byte) => (total + byte) & 65535, 0);
  layoutRom.writeUInt16LE(sum ^ 65535, 0xffdc);
  layoutRom.writeUInt16LE(sum, 0xffde);
  fs.writeFileSync(filename, layoutRom, { flag: 'wx' });
}

function translatedNameIndexes(block) {
  const manifest = JSON.parse(fs.readFileSync(process.env.MOMOTARO_MANIFEST ?? path.join(root, 'translations/menu.zh-Hant.json')));
  const definition = manifest.nameBlocks.find(entry => entry.name === block.name);
  const source = fs.readFileSync(originalRom);
  const start = source.readUIntLE(Number(definition.pointerOffset), 3) - 0xc00000;
  const end = source.readUIntLE(Number(definition.pointerOffset) + 3, 3) - 0xc00000;
  const records = splitRecords(source.subarray(start + 1, end));
  const names = readNames(block);
  assert.equal(names.length, records.length);
  const translated = [];
  for (const record of records) {
    const entry = definition.entries.find(entry => Number(entry.offset) === start + 1 + record.decodedOffset);
    if (entry) {
      assert.equal(entry.originalHex, record.originalHex);
      assert.ok(names[record.index].equals(encodeWord(entry.translation)), `${block.name} index ${record.index}`);
      assert.ok([...entry.translation].length * 12 <= 104, `Item exceeds column width: ${entry.translation}`);
      translated.push([record.index, entry.translation]);
    } else {
      assert.equal(names[record.index].toString('hex'), record.originalHex);
      assert.ok(!record.originalHex || record.originalHex.includes('1a491820'), `Untranslated usable ${block.name}: ${record.index}`);
    }
  }
  assert.equal(translated.length, definition.entries.length);
  return translated;
}

function serviceMenuProbe(filename, menu, sourceTemplate = false, relocateOriginal = false) {
  const rom = Buffer.from(target);
  const pointer = sourceTemplate && !relocateOriginal ? Number(menu.sourceStart) : Number(menu.target);
  if (relocateOriginal) fs.readFileSync(originalRom).copy(rom, pointer, Number(menu.sourceStart), Number(menu.sourceEnd));
  rom.writeUInt16LE(pointer & 65535, 0x1eef2);
  rom[0x1eef9] = 0xc0 + (pointer >> 16);
  rom.writeUInt16LE(65535, 0xffdc);
  rom.writeUInt16LE(0, 0xffde);
  const sum = rom.reduce((total, byte) => (total + byte) & 65535, 0);
  rom.writeUInt16LE(sum ^ 65535, 0xffdc);
  rom.writeUInt16LE(sum, 0xffde);
  fs.writeFileSync(filename, rom, { flag: 'wx' });
}

function fontBoundaryProbe(filename, indexedText = false) {
  const rom = Buffer.from(target);
  const cases = indexedText
    ? [['交談', 1598], ['能力', 1600], ['調查', 1662], ['道具', 1664], ['裝備', 1856], ['特別', 2110]]
    : [['交談', 766], ['能力', 768], ['調查', 830], ['道具', 832], ['裝備', 1022], ['特別', 1086]];
  const dialogue = [0];
  for (const [word, firstIndex] of cases) {
    const replacement = [];
    [...word].forEach((character, characterIndex) => {
      const glyph = metadata.glyphs.find(entry => entry.character === character);
      assert.ok(Number.isInteger(glyph?.offset), 'Font boundary probe requires explicit glyph offsets');
      const index = firstIndex + characterIndex;
      const { number, offset } = chineseFontGroup(index);
      rom.writeUInt16LE(offset & 65535, metadata.fontPointerTable + (number - 1) * 2);
      rom[metadata.fontBankTable + (number - 1) * 2] = (offset + 0xc00000) >> 16;
      rom[offset] = 0x1f;
      target.copy(rom, chineseGlyphOffset(index), glyph.offset, glyph.offset + 46);
      replacement.push(...chineseCode(index));
    });
    const location = rom.indexOf(encodeWord(word), 0x230000);
    assert.ok(location >= 0x230000 && location + replacement.length <= 0x231000, `Missing compact menu label: ${word}`);
    Buffer.from(replacement).copy(rom, location);
    dialogue.push(...replacement);
  }
  if (indexedText) {
    Buffer.from([...dialogue, ...Array(20).fill(0)]).copy(rom, 0x3f0000);
    rom.writeUIntLE(0xff0000, 0x702c4, 3);
  }
  rom.writeUInt16LE(65535, 0xffdc);
  rom.writeUInt16LE(0, 0xffde);
  const sum = rom.reduce((total, byte) => (total + byte) & 65535, 0);
  rom.writeUInt16LE(sum ^ 65535, 0xffdc);
  rom.writeUInt16LE(sum, 0xffde);
  fs.writeFileSync(filename, rom, { flag: 'wx' });
  return cases;
}

function verifyConfirmation(shop, sourceShop) {
  const menu = metadata.inlineMenus.find(entry => entry.name === 'yes-no');
  assert.ok(menu, 'Missing yes/no template');
  const callbacks = Buffer.from('002abb852abb85', 'hex');
  const template = target.subarray(Number(menu.target), Number(menu.target) + 32);
  assert.ok(template.includes(callbacks), 'Yes/no template is missing its native selection callbacks');
  const results = [];
  for (const [choice, inputs, expectedResult] of [
    ['yes', '30:3:a', 1],
    ['no', '30:3:down,90:3:a', 0],
    ['cancel', '30:3:b', 0],
  ]) {
    const selected = run(translatedRom, `confirmation-${choice}`, 900, inputs, path.join(shop, 'state.bin'), 60);
    const sourceSelected = run(originalRom, `source-confirmation-${choice}`, 900, inputs, path.join(sourceShop, 'state.bin'), 60);
    const sourceValues = fs.readFileSync(path.join(sourceSelected, 'wram-900.bin'));
    const values = fs.readFileSync(path.join(selected, 'wram-900.bin'));
    assert.equal(sourceValues[0x1957], expectedResult, `Unexpected original confirmation result: ${choice}`);
    assert.equal(values[0x1957], expectedResult, `Confirmation did not return: ${choice}`);
    assert.equal(values[0x12e4], sourceValues[0x12e4], `Post-confirmation cursor differs: ${choice}`);
    assert.ok(values.subarray(0x1600, 0x1940).equals(sourceValues.subarray(0x1600, 0x1940)), `Game data differs after confirmation: ${choice}`);
    results.push({ choice, result: values[0x1957], gameDataMatchesOriginal: true });
  }
  return results;
}

function verifySumoBattle(state) {
  const opened = run(translatedRom, 'sumo-open', 300, '30:3:down,90:3:a', state, 60);
  const sourceOpened = run(originalRom, 'source-sumo-open', 300, '30:3:down,90:3:a', state, 60);
  assert.equal(fs.readFileSync(path.join(opened, 'wram-300.bin'))[0x12e4], 1);
  assert.equal(fs.readFileSync(path.join(sourceOpened, 'wram-300.bin'))[0x12e4], 1);
  assertRenderedWords(path.join(opened, 'frame-300.ppm'), ['拍掌', '推掌', '頭槌']);
  const results = [];
  for (const [choice, inputs, expectedAction] of [
    ['palm', '30:3:a', 0xb2],
    ['push', '30:3:down,90:3:a', 0xb3],
    ['headbutt', '30:3:down,90:3:down,150:3:a', 0xb4],
    ['cancel', '30:3:b', null],
  ]) {
    const selected = run(translatedRom, `sumo-${choice}`, 300, inputs, path.join(opened, 'state.bin'), 15);
    const sourceSelected = run(originalRom, `source-sumo-${choice}`, 300, inputs, path.join(sourceOpened, 'state.bin'), 15);
    const actions = directory => Array.from({ length: 20 }, (_, index) =>
      fs.readFileSync(path.join(directory, `wram-${(index + 1) * 15}.bin`))[0x1987]);
    const observed = actions(selected);
    const sourceObserved = actions(sourceSelected);
    if (expectedAction !== null) {
      assert.ok(sourceObserved.includes(expectedAction), `Original sumo callback did not execute: ${choice}`);
      assert.ok(observed.includes(expectedAction), `Translated sumo callback did not execute: ${choice}`);
      assert.deepEqual(observed, sourceObserved, `Sumo callback timing differs: ${choice}`);
      for (const [rom, directory, prefix] of [[translatedRom, selected, 'sumo'], [originalRom, sourceSelected, 'source-sumo']]) {
        const continued = run(rom, `${prefix}-${choice}-round`, 1800,
          '30:3:a,330:3:a,630:3:a,930:3:a,1230:3:a,1530:3:a', path.join(directory, 'state.bin'), 120);
        const before = fs.readFileSync(path.join(directory, 'wram-300.bin')).subarray(0x1a35, 0x1a5f);
        assert.ok(Array.from({ length: 15 }, (_, index) => (index + 1) * 120).some(frame =>
          !fs.readFileSync(path.join(continued, `wram-${frame}.bin`)).subarray(0x1a35, 0x1a5f).equals(before)),
        `Battle HP never changed after using ${choice}: ${prefix}`);
      }
    } else {
      assert.deepEqual(observed, sourceObserved, 'Sumo cancel action differs from original');
      const reopened = run(translatedRom, 'sumo-cancel-reopen', 300, '30:3:down,90:3:a', path.join(selected, 'state.bin'), 60);
      assertRenderedWords(path.join(reopened, 'frame-300.ppm'), ['拍掌', '推掌', '頭槌']);
    }
    results.push({ choice, expectedAction, callbackMatchesOriginal: true,
      ...(expectedAction === null ? { cancelReopenPassed: true } : { translatedAndOriginalBattleProgressed: true }), observed, sourceObserved });
  }
  let brokenReproduction = null;
  if (process.env.MOMOTARO_SUMO_BROKEN_ROM) {
    const broken = run(process.env.MOMOTARO_SUMO_BROKEN_ROM, 'sumo-broken-palm', 300, '30:3:a', path.join(opened, 'state.bin'), 60);
    const observed = Array.from({ length: 5 }, (_, index) =>
      fs.readFileSync(path.join(broken, `wram-${(index + 1) * 60}.bin`))[0x1987]);
    assert.ok(!observed.includes(0xb2), 'Broken ROM unexpectedly executed the palm callback');
    assert.ok(fs.readFileSync(path.join(broken, 'frame-60.ppm')).equals(fs.readFileSync(path.join(broken, 'frame-300.ppm'))),
      'Broken ROM did not reproduce the stationary selection screen');
    brokenReproduction = { palmCallbackMissing: true, screenUnchangedFrames: [60, 300], observed };
  }
  return { choices: results, brokenReproduction };
}

if (process.env.MOMOTARO_SUMO_STATE) {
  const sumo = verifySumoBattle(process.env.MOMOTARO_SUMO_STATE);
  fs.writeFileSync(path.join(outputDirectory, 'verification.json'), JSON.stringify({ targetSha256: metadata.targetSha256, sumo }, null, 2));
  console.log('Sumo selection callbacks and cancel match the original ROM.');
  process.exit(0);
}

if (process.env.MOMOTARO_CONFIRMATION_STATES) {
  const states = process.env.MOMOTARO_CONFIRMATION_STATES;
  const confirmation = verifyConfirmation(path.join(states, 'saved-shop-confirmation'), path.join(states, 'source-saved-shop-confirmation'));
  fs.writeFileSync(path.join(outputDirectory, 'verification.json'), JSON.stringify({ targetSha256: metadata.targetSha256, confirmation }, null, 2));
  console.log('Yes/no/cancel confirmation callbacks and game-state comparisons passed.');
  process.exit(0);
}

const originalMenu = run(originalRom, 'original-menu', 1380, '1201:2:start');
const translatedMenu = run(translatedRom, 'translated-menu', 1380, '1201:2:start');
assert.deepEqual(fs.readFileSync(path.join(originalMenu, 'frame-1200.ppm')), fs.readFileSync(path.join(translatedMenu, 'frame-1200.ppm')));
assert.notDeepEqual(fs.readFileSync(path.join(originalMenu, 'frame-1380.ppm')), fs.readFileSync(path.join(translatedMenu, 'frame-1380.ppm')));
const openingFrameCount = metadata.opening ? 2100 : 1080;
const originalOpening = run(originalRom, 'original-opening', openingFrameCount, '1:2:a', path.join(originalMenu, 'state.bin'));
const translatedOpening = run(translatedRom, 'translated-opening', openingFrameCount, '1:2:a', path.join(translatedMenu, 'state.bin'));
const identicalFrames = hasTranslatedOpening ? [300, 600, 900] : metadata.opening ? [300, 600, 900, 1200, 1500, 2100] : [300, 600, 900, 1080];
for (const frame of identicalFrames) {
  assert.ok(fs.readFileSync(path.join(originalOpening, `frame-${frame}.ppm`)).equals(fs.readFileSync(path.join(translatedOpening, `frame-${frame}.ppm`))), `Opening image mismatch at frame ${frame}`);
}
if (hasTranslatedOpening) {
  const originalBlock = readLzTextBlock(fs.readFileSync(originalRom), Number(metadata.opening.pointerOffset));
  const offset = Number(metadata.opening.relocatedOffset);
  const translatedBlock = decodeLz(target.subarray(offset + 1, offset + 1 + metadata.opening.compressedBytes)).bytes;
  assert.ok(originalBlock.bytes.subarray(metadata.opening.originalParagraphBytes).equals(translatedBlock.subarray(metadata.opening.replacementParagraphBytes)), 'Following script was changed');
  assert.notDeepEqual(fs.readFileSync(path.join(originalOpening, 'frame-1200.ppm')), fs.readFileSync(path.join(translatedOpening, 'frame-1200.ppm')), 'Narration image did not change');
  const controlMetadata = JSON.parse(fs.readFileSync(path.join(controlDirectory, 'build.json')));
  assert.equal(controlMetadata.status, 'opening-roundtrip-control');
  assert.equal(controlMetadata.sourceSha256, metadata.sourceSha256);
  assert.ok([...controlMetadata.nameBlocks, ...controlMetadata.textBlocks].every(block => block.translatedNames === 0),
    'Round-trip control must retain original indexed names and dialogue');
  const controlRom = path.join(controlDirectory, controlMetadata.romFilename);
  assert.equal(sha256(controlRom), controlMetadata.targetSha256);
  const controlMenu = run(controlRom, 'control-menu', 1380, '1201:2:start');
  const controlOpening = run(controlRom, 'control-opening', 2100, '1:2:a', path.join(controlMenu, 'state.bin'));
  for (const frame of [300, 600, 900, 1200, 1500, 2100]) {
    assert.ok(fs.readFileSync(path.join(originalOpening, `frame-${frame}.ppm`)).equals(fs.readFileSync(path.join(controlOpening, `frame-${frame}.ppm`))), `Recompressed control mismatch at frame ${frame}`);
  }
}
let fieldMenuVerification;
if (hasTranslatedOpening && metadata.inlineMenus?.length) {
  const field = run(translatedRom, 'field-arrival', 24000, '1:2:a', path.join(translatedMenu, 'state.bin'));
  const commands = run(translatedRom, 'field-menu', 180, '30:3:a,90:3:a', path.join(field, 'state.bin'));
  const commandWords = assertRenderedWords(path.join(commands, 'frame-180.ppm'), ['交談', '術', '能力', '調查', '道具', '裝備', '特別']);
  const fieldManifest = JSON.parse(fs.readFileSync(process.env.MOMOTARO_MANIFEST ?? path.join(root, 'translations/menu.zh-Hant.json')));
  if (fieldManifest.inlineMenus.find(menu => menu.name === 'field-menu-compact').entries.find(entry => Number(entry.offset) === 0x1ef51).padding === 2) {
    for (const word of ['道具', '裝備', '特別']) assert.equal(commandWords[word].x, 64, `Misaligned field command: ${word}`);
  }
  let compactHpFont;
  if (metadata.compactHpFont) {
    const font = metadata.compactHpFont;
    const expected = decodeLz(fs.readFileSync(originalRom).subarray(font.sourceStart), font.decodedBytes).bytes;
    const glyphs = font.glyphs ?? [{ index: 0x0c, label: font.label, rows: font.rows }];
    for (const glyph of glyphs) {
      const rows = Buffer.from(glyph.rows, 'hex');
      assert.equal(rows.length, 16);
      for (let row = 0; row < 16; row++) {
        const offset = Math.floor(glyph.index / 16) * 0x200 + (glyph.index % 16) * 16
          + (row >= 8 ? 0x100 : 0) + (row % 8) * 2 + 1;
        expected[offset] = rows[row];
      }
    }
    assert.deepEqual(decodeLz(target.subarray(font.target), font.decodedBytes).bytes, expected, 'Other compact font glyphs changed');
    const vram = fs.readFileSync(path.join(commands, 'vram-180.bin'));
    assert.deepEqual(vram.subarray(0x8900, 0x8900 + expected.length), expected, 'Cold-boot compact font VRAM differs');
    compactHpFont = { label: font.label, labels: glyphs.map(glyph => glyph.label), exactVramMatch: true, otherFontBytesUnchanged: true };
  }
  const serviceMenus = [];
  const travelPairs = [
    ['啟程村', '飯糰村'], ['麻雀旅館一號店', '花咲村'], ['金太郎村', '麻雀旅館二號店'],
    ['浦島村', '寧靜村'], ['寢太郎村左側', '麻雀旅館三號店'], ['微笑村', '希望之都'],
    ['麻雀旅館四號店', '麻雀旅館五號店'], ['新村', '夢之村'], ['猴蟹村', '麻雀旅館六號店'],
    ['機關村', '七夕村'], ['麻雀旅館七號店', '竹取村'], ['風暴村', '月之宮殿'], ['豐饒村', '鬼島'],
  ];
  for (const [name, words, destinationIndexes] of [
    ...travelPairs.map((words, index) => ['travel-destinations', words, [index * 2, index * 2 + 1]]),
    ['travel-destinations', ['啟程村', '麻雀旅館一號店', '花咲村'], [0, 2, 3]],
    ['battle-enemy-count', ['一人']],
    ['spell-actions', ['使用', '說明', '場所']],
    ['battle-spell-actions', ['使用', '說明']],
    ['sumo-techniques', ['拍掌', '推掌', '頭槌']],
    ['chest-sizes', ['大藤箱', '小藤箱']],
    ['storage-services', ['寄存', '取回', '取消']],
    ['storage-main', ['金錢', '道具', '說明', '取消']],
    ['boss-spell-choice', ['小波', '倍力', '軟化']],
    ['shop-services', ['購買', '製藥', '說明', '取消']],
    ['doctor-services', ['解毒', '解除麻痺', '治療重傷', '全部治療', '取消']],
    ['fortune-services', ['附近敵情', '人氣']],
    ['shrine-services', ['記錄旅程', '祓除詛咒', '取消']],
  ]) {
    const menu = metadata.inlineMenus.find(entry => entry.name === name);
    if (!menu) continue;
    const cheats = destinationIndexes ? Array.from({ length: 26 }, (_, index) =>
      `7E${(0x0315 + index).toString(16).padStart(4, '0')}${destinationIndexes.includes(index) ? '01' : '00'}`).join(',')
      : name === 'battle-enemy-count' ? '7E031D02,7E031901,7E0315EF'
      : name === 'shop-services' ? '7E196608' : name === 'sumo-techniques' ? '7E03151E' : undefined;
    if (destinationIndexes) {
      assert.equal(menu.translatedLabels, 26);
      assert.equal(target.subarray(Number(menu.target) + 4, Number(menu.target) + 7).toString('hex'), '11e181');
      assert.deepEqual(target.subarray(0x1e111, 0x1e130), fs.readFileSync(originalRom).subarray(0x1e111, 0x1e130), 'Travel callback changed');
    }
    if (name === 'battle-enemy-count') {
      const callbackStart = Number(menu.target) + Number(menu.sourceEnd) - Number(menu.sourceStart) + 4 - 24;
      assert.deepEqual(target.subarray(callbackStart, callbackStart + 24), fs.readFileSync(originalRom).subarray(0x2e4d2, 0x2e4ea), 'Enemy-count callback table changed');
    }
    const outputs = {};
    const frames = destinationIndexes ? 900 : 180;
    const inputs = destinationIndexes ? '30:3:a,90:3:a,240:3:down,360:3:down,480:3:down,600:3:down' : '30:3:a,90:3:a';
    for (const variant of ['source', 'control', 'translated']) {
      const label = `${name}${destinationIndexes ? `-${destinationIndexes.join('-')}` : ''}-${variant}`;
      const filename = path.join(outputDirectory, `${label}.sfc`);
      serviceMenuProbe(filename, menu, variant !== 'translated', variant === 'control');
      outputs[variant] = run(filename, label, frames, inputs, path.join(field, 'state.bin'), 60, cheats);
    }
    for (const frame of destinationIndexes ? [60, 120, 180, 300, 600, 900] : [60, 120, 180]) {
      assert.ok(fs.readFileSync(path.join(outputs.source, `frame-${frame}.ppm`)).equals(fs.readFileSync(path.join(outputs.control, `frame-${frame}.ppm`))), `Service template relocation differs: ${name} frame ${frame}`);
    }
    serviceMenus.push({ name, destinationIndexes, synthetic: true, originalRelocationFramesIdentical: true,
      words: assertRenderedWords(path.join(outputs.translated, `frame-${frames}.ppm`), words) });
  }
  const boundaryFilename = path.join(outputDirectory, 'font-boundaries.sfc');
  const boundaryCases = fontBoundaryProbe(boundaryFilename);
  const boundaryMenu = run(boundaryFilename, 'font-boundaries', 180, '30:3:a,90:3:a', path.join(field, 'state.bin'));
  const boundaryWords = assertRenderedWords(path.join(boundaryMenu, 'frame-180.ppm'), boundaryCases.map(([word]) => word));
  const indexedBoundaryFilename = path.join(outputDirectory, 'indexed-font-boundaries.sfc');
  const indexedBoundaryCases = fontBoundaryProbe(indexedBoundaryFilename, true);
  const indexedBoundary = run(indexedBoundaryFilename, 'indexed-font-boundaries', 1200, '1:2:a', path.join(translatedMenu, 'state.bin'), 60);
  let indexedBoundaryWords;
  let indexedBoundaryFrame;
  for (let frame = 60; frame <= 1200 && !indexedBoundaryWords; frame += 60) {
    try {
      indexedBoundaryWords = assertRenderedWords(path.join(indexedBoundary, `frame-${frame}.ppm`), boundaryCases.map(([word]) => word));
      indexedBoundaryFrame = frame;
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
    }
  }
  assert.ok(indexedBoundaryWords, 'Expanded indexed font glyphs never rendered together');
  const special = run(translatedRom, 'special-menu', 360, '30:3:right,60:3:down,90:3:down,120:3:down,180:3:a', path.join(commands, 'state.bin'));
  const specialWords = assertRenderedWords(path.join(special, 'frame-360.ppm'), ['語速', '隊列', '步行', '飛行', '音樂']);
  const walking = run(translatedRom, 'walking-speed', 360, '30:3:down,60:3:down,120:3:a', path.join(special, 'state.bin'));
  const speedWords = assertRenderedWords(path.join(walking, 'frame-360.ppm'), ['步行速度', '快速', '普通', '慢速']);
  const selected = run(translatedRom, 'walking-speed-selected', 180, '30:3:left,60:3:left,120:3:a', path.join(walking, 'state.bin'));
  assert.equal(fs.readFileSync(path.join(selected, 'wram-180.bin'))[0x155a], 4, 'Fast walking setting was not applied');
  fieldMenuVerification = { commandWords, compactHpFont, specialWords, speedWords, walkingSpeedApplied: true, expandedLayoutRuntimeVerified: false,
    syntheticFontBoundaries: { cases: boundaryCases, indexedCases: indexedBoundaryCases, inlineWords: boundaryWords, indexedWords: indexedBoundaryWords, indexedFrame: indexedBoundaryFrame }, serviceMenus };
  if (metadata.textBlocks.some(block => block.name === 'field-messages')) {
    const searched = run(translatedRom, 'search-ahead', 900, '30:3:down,60:3:down,90:3:down,150:3:a,600:3:a', path.join(commands, 'state.bin'));
    fieldMenuVerification.searchWords = assertRenderedWords(path.join(searched, 'frame-900.ppm'), ['調查了眼前', '但什麼也沒找到']);
  }
  if (caveState) {
    const inputs = '120:3:b,360:3:b,600:3:a,780:3:a';
    const cave = run(translatedRom, 'saved-cave-dialogue', 1200, inputs, caveState);
    const sourceCave = run(originalRom, 'source-saved-cave-dialogue', 1200, inputs, caveState);
    assert.deepEqual(fs.readFileSync(path.join(cave, 'wram-1200.bin')).subarray(0x1600, 0x1940),
      fs.readFileSync(path.join(sourceCave, 'wram-1200.bin')).subarray(0x1600, 0x1940), 'Cave dialogue changed actor data');
    fieldMenuVerification.savedCave = { stateSha256: sha256(caveState), actorDataMatchesOriginal: true,
      words: assertRenderedWords(path.join(cave, 'frame-1200.ppm'), ['好可怕', '地裂的底下', '有好多鬼']) };
  }
  if (serviceState) {
    const inputs = '120:3:b,360:3:b,600:3:a,780:3:a';
    const shop = run(translatedRom, 'saved-shop-confirmation', 1800, inputs, serviceState, 60);
    const sourceShop = run(originalRom, 'source-saved-shop-confirmation', 1800, inputs, serviceState, 60);
    fieldMenuVerification.savedShop = {
      services: assertRenderedWords(path.join(shop, 'frame-600.ppm'), ['購買', '出售', '折價換購', '說明', '取消'], { '出售': { x: 24, y: 144 } }),
      goods: assertRenderedWords(path.join(shop, 'frame-780.ppm'), ['木刀', '刀', '樹皮護甲', '便服', '頭巾', '草鞋'], { '刀': { x: 24, y: 24 } }),
      confirmation: assertRenderedWords(path.join(shop, 'frame-1800.ppm'), ['是', '否', '要買', '草鞋']),
      actorDataUnchanged: fs.readFileSync(path.join(shop, 'wram-1800.bin')).subarray(0x1600, 0x1640)
        .equals(fs.readFileSync(path.join(sourceShop, 'wram-1800.bin')).subarray(0x1600, 0x1640)),
    };
    assert.equal(fieldMenuVerification.savedShop.actorDataUnchanged, true, 'Actor data changed before confirming a purchase');
    fieldMenuVerification.savedShop.selectionResults = verifyConfirmation(shop, sourceShop);
  }
  if (metadata.nameBlocks?.length) {
    const ability = run(translatedRom, 'ability-status', 360, '30:3:down,60:3:down,120:3:a', path.join(commands, 'state.bin'));
    fieldMenuVerification.abilityWords = assertRenderedWords(path.join(ability, 'frame-360.ppm'), ['心值', '體力', '技力', '攻擊力', '防禦力', '速度', '勇氣之劍', '勇氣頭盔', '勇氣鎧甲', '勇氣長靴']);
    const sourceField = run(originalRom, 'source-field-arrival', 24000, '1:2:a', path.join(originalMenu, 'state.bin'));
    const sourceCommands = run(originalRom, 'source-field-menu', 180, '30:3:a,90:3:a', path.join(sourceField, 'state.bin'));
    const sourceAbility = run(originalRom, 'source-ability-status', 360, '30:3:down,60:3:down,120:3:a', path.join(sourceCommands, 'state.bin'));
    const sourceValues = fs.readFileSync(path.join(sourceAbility, 'wram-360.bin'));
    const translatedValues = fs.readFileSync(path.join(ability, 'wram-360.bin'));
    assert.ok(sourceValues.subarray(0x315, 0x336).equals(translatedValues.subarray(0x315, 0x336)), 'Displayed ability values changed');
    assert.ok(sourceValues.subarray(0x1600, 0x1640).equals(translatedValues.subarray(0x1600, 0x1640)), 'Actor data changed');
    fieldMenuVerification.abilityValuesUnchanged = true;
    const items = run(translatedRom, 'item-names', 360, '30:3:right,120:3:a', path.join(commands, 'state.bin'));
    fieldMenuVerification.itemWords = assertRenderedWords(path.join(items, 'frame-360.ppm'), ['月之水晶', '黍糰']);
    const techniques = run(translatedRom, 'technique-names', 360, '30:3:down,120:3:a', path.join(commands, 'state.bin'));
    fieldMenuVerification.techniqueWords = assertRenderedWords(path.join(techniques, 'frame-360.ppm'), ['金丹', '萬金丹', '稻妻', '鹿角', '飛燕', '浮游']);
    const itemActions = run(translatedRom, 'item-actions', 360, '120:3:a', path.join(items, 'state.bin'));
    fieldMenuVerification.itemActionWords = assertRenderedWords(path.join(itemActions, 'frame-360.ppm'), ['使用', '說明', '交付', '丟棄']);
    if (metadata.textBlocks?.some(block => block.name === 'item-descriptions')) {
      const description = run(translatedRom, 'moon-crystal-description', 360, '30:3:down,120:3:a', path.join(itemActions, 'state.bin'));
      fieldMenuVerification.descriptionWords = assertRenderedWords(path.join(description, 'frame-360.ppm'), ['輝夜姬贈予的', '月之寶物', '永久']);
      const closedDescription = run(translatedRom, 'description-closed', 360, '60:3:b,150:3:a,300:3:a', path.join(description, 'state.bin'));
      fieldMenuVerification.descriptionClosedWords = assertRenderedWords(path.join(closedDescription, 'frame-360.ppm'), ['交談', '調查', '道具']);
      const foodActions = run(translatedRom, 'food-actions', 360, '30:3:right,120:3:a', path.join(items, 'state.bin'));
      const foodDescription = run(translatedRom, 'food-description', 360, '30:3:down,120:3:a', path.join(foodActions, 'state.bin'));
      fieldMenuVerification.foodDescriptionWords = assertRenderedWords(path.join(foodDescription, 'frame-360.ppm'), ['食用後', '體力', '回復', '點', '次限定']);
      const originalItems = run(originalRom, 'source-item-names', 360, '30:3:right,120:3:a', path.join(sourceCommands, 'state.bin'));
      const originalFoodActions = run(originalRom, 'source-food-actions', 360, '30:3:right,120:3:a', path.join(originalItems, 'state.bin'));
      const originalFoodDescription = run(originalRom, 'source-food-description', 360, '30:3:down,120:3:a', path.join(originalFoodActions, 'state.bin'));
      assert.ok(fs.readFileSync(path.join(foodDescription, 'wram-360.bin')).subarray(0x315, 0x336).equals(fs.readFileSync(path.join(originalFoodDescription, 'wram-360.bin')).subarray(0x315, 0x336)), 'Food description parameters changed');
      fieldMenuVerification.foodDescriptionParametersUnchanged = true;
      const foodUsed = run(translatedRom, 'food-used', 360, '120:3:a', path.join(foodActions, 'state.bin'));
      const originalFoodUsed = run(originalRom, 'source-food-used', 360, '120:3:a', path.join(originalFoodActions, 'state.bin'));
      fieldMenuVerification.foodUsedWords = assertRenderedWords(path.join(foodUsed, 'frame-360.ppm'), ['吃下了', '黍糰']);
      assert.ok(fs.readFileSync(path.join(foodUsed, 'wram-360.bin')).subarray(0x1600, 0x1640).equals(fs.readFileSync(path.join(originalFoodUsed, 'wram-360.bin')).subarray(0x1600, 0x1640)), 'Actor data differs after eating');
      fieldMenuVerification.foodUsedActorDataUnchanged = true;
      const itemBlock = metadata.nameBlocks.find(block => block.name === 'items');
      assert.deepEqual(readNames(itemBlock)[131], encodeWord('耙鋤'));
      const replacements = new Map([
        [encodeWord('月之水晶').toString('hex'), '腐敗沙丁魚'],
        [encodeWord('黍糰').toString('hex'), '替身地藏'],
      ]);
      const layoutFilename = path.join(outputDirectory, 'name-layout-probe.sfc');
      nameLayoutProbe(itemBlock, replacements, layoutFilename);
      const layout = run(layoutFilename, 'name-layout-probe', 360, '30:3:right,120:3:a', path.join(commands, 'state.bin'));
      fieldMenuVerification.syntheticNameLayout = assertRenderedWords(path.join(layout, 'frame-360.ppm'), [...replacements.values()]);
      assert.equal(fieldMenuVerification.syntheticNameLayout['腐敗沙丁魚'].x, 48);
      assert.equal(fieldMenuVerification.syntheticNameLayout['替身地藏'].x, 152);
      const toolFilename = path.join(outputDirectory, 'digging-tool-layout.sfc');
      nameLayoutProbe(itemBlock, new Map([[encodeWord('月之水晶').toString('hex'), '耙鋤']]), toolFilename);
      const toolLayout = run(toolFilename, 'digging-tool-layout', 360, '30:3:right,120:3:a', path.join(commands, 'state.bin'));
      fieldMenuVerification.diggingToolName = {
        index: 131, synthetic: true,
        words: assertRenderedWords(path.join(toolLayout, 'frame-360.ppm'), ['耙鋤'], { '耙鋤': { x: 48, y: fieldMenuVerification.syntheticNameLayout['腐敗沙丁魚'].y } }),
      };
    }
    const techniqueBlock = metadata.nameBlocks.find(block => block.name === 'techniques');
    if (techniqueBlock.translatedNames === techniqueBlock.strings - 1) {
      const glyphByCode = new Map(metadata.glyphs.map(glyph => [glyph.code, glyph.character]));
      const decodedNames = readNames(techniqueBlock).map(bytes => {
        assert.equal(bytes.length % 2, 0, 'Incomplete Chinese technique code');
        const characters = [];
        for (let offset = 0; offset < bytes.length; offset += 2) {
          const character = glyphByCode.get(bytes.subarray(offset, offset + 2).toString('hex'));
          assert.ok(character, 'Untranslated technique glyph');
          characters.push(character);
        }
        return characters.join('');
      });
      assert.equal(decodedNames.filter(name => !name).length, 1);
      const uniqueNames = [...new Set(decodedNames.filter(Boolean))];
      const slots = Object.keys(fieldMenuVerification.techniqueWords);
      const layouts = [];
      for (let page = 0; page * slots.length < uniqueNames.length; page++) {
        const words = uniqueNames.slice(page * slots.length, (page + 1) * slots.length);
        const positions = Object.fromEntries(words.map((word, index) => [word, fieldMenuVerification.techniqueWords[slots[index]]]));
        for (const word of words) assert.ok([...word].length * 12 <= 104, `Technique exceeds column width: ${word}`);
        const replacements = new Map(words.map((word, index) => [encodeWord(slots[index]).toString('hex'), word]));
        const name = `technique-layout-${page}`;
        const filename = path.join(outputDirectory, `${name}.sfc`);
        nameLayoutProbe(techniqueBlock, replacements, filename);
        const screen = run(filename, name, 360, '30:3:down,120:3:a', path.join(commands, 'state.bin'));
        layouts.push(assertRenderedWords(path.join(screen, 'frame-360.ppm'), words, positions));
      }
      fieldMenuVerification.syntheticTechniqueLayouts = { translatedIndexes: decodedNames.filter(Boolean).length, uniqueNames: uniqueNames.length, layouts, battleEffectsVerified: false };
      const battleCommands = metadata.nameBlocks.find(block => block.name === 'battle-commands');
      const enemies = metadata.nameBlocks.find(block => block.name === 'enemies');
      if (battleCommands && enemies) {
        const commandWords = ['攻擊', '防禦', '術', '掩護', '道具', '逃跑'];
        const commandNames = readNames(battleCommands);
        commandWords.forEach((word, index) => assert.deepEqual(commandNames[index + 2], encodeWord(word)));
        assert.deepEqual(commandNames[8], encodeWord('相撲技'));
        const prince = encodeWord('達伊達王子');
        assert.equal(readNames(enemies).filter(bytes => bytes.equals(prince)).length, 5);
        assert.deepEqual(readNames(enemies)[239], encodeWord('金丹仙人'));
        assert.deepEqual(readNames(enemies)[11], encodeWord('鬼火'));
        assert.deepEqual(readNames(enemies)[15], encodeWord('渦蜘蛛'));
        assert.deepEqual(readNames(enemies)[18], encodeWord('土蜘蛛'));
        assert.deepEqual(readNames(enemies)[71], encodeWord('兩鐵'));
        const equipment = metadata.nameBlocks.find(block => block.name === 'equipment');
        assert.ok(equipment);
        const screenshotEquipment = [
          [3, '斬葉刀'], [4, '劈竹刀'], [5, '碎瓦刀'], [6, '斬岩刀'], [7, '斬鎖刀'], [8, '破釜刀'],
          [9, '破盔刀'], [10, '斬鬼丸'], [11, '百鬼斬丸'], [12, '毘沙門劍'], [16, '玄武刀'],
          [17, '白虎刀'], [18, '朱雀刀'], [19, '青龍刀'], [20, '酒吞劍'], [23, '麻線護甲'],
          [24, '竹護甲'], [25, '單片護甲'], [26, '雙片護甲'], [27, '三片護甲'], [28, '鎧甲'],
          [29, '大鎧甲'], [30, '武者鎧甲'],
          [35, '斧頭'], [36, '大斧頭'], [37, '銅斧'], [38, '銀斧'], [39, '金斧'], [40, '希望之斧'],
          [44, '肚兜'], [45, '棉肚兜'], [46, '銀肚兜'], [47, '金肚兜'], [48, '希望肚兜'],
          [214, '護額'], [215, '頭盔'], [217, '紅頭巾'],
          [221, '兔子足袋'], [222, '狐狸足袋'], [223, '鹿足袋'], [224, '雪鞋'], [225, '獅子足袋'],
          [226, '豹足袋'], [227, '白象足袋'], [228, '黃泉足袋'], [229, '愛心足袋'],
        ];
        for (const [index, word] of screenshotEquipment) assert.deepEqual(readNames(equipment)[index], encodeWord(word));
        const screenshotEnemies = [[3, '雷鬼'], [21, '地蟲'], [51, '巴坎鬼'], [74, '龍燈鬼'], [217, '天賊鬼']];
        const screenshotItems = [[44, '珊瑚護符'], [45, '搖錢樹'], [53, '隱身蓑衣'], [58, '動物之友'], [59, '狗兒最愛'], [60, '雉雞豆'], [61, '猴子薤頭'], [63, '天女羽衣']];
        const items = metadata.nameBlocks.find(block => block.name === 'items');
        assert.ok(items);
        for (const [index, word] of screenshotEnemies) assert.deepEqual(readNames(enemies)[index], encodeWord(word));
        for (const [index, word] of screenshotItems) assert.deepEqual(readNames(items)[index], encodeWord(word));
        const screenshotLayouts = [];
        const allEquipment = translatedNameIndexes(equipment);
        const allItems = translatedNameIndexes(items);
        const allEnemies = translatedNameIndexes(enemies);
        assert.equal(allEnemies.length, 247, 'Enemy names must cover every nonempty slot');
        const readingBlock = metadata.textBlocks.find(block => block.name === 'enemy-readings');
        assert.ok(readingBlock, 'Missing enemy reading labels');
        const readingStart = Number(readingBlock.relocatedOffset);
        const readingBytes = decodeHuffman(target, target.subarray(readingStart + 1, readingStart + readingBlock.storedBytes), readingBlock.decodedBytes).bytes;
        const readingRecords = splitRecords(readingBytes);
        assert.equal(readingRecords.length, 248);
        assert.equal(readingRecords[0].originalHex, '');
        const allReadings = allEnemies.map(([index, name]) => [index, index === 247 ? '嗚喲' : name]);
        for (const [index, name] of allReadings) assert.equal(readingRecords[index].originalHex, encodeWord(name).toString('hex'), `Enemy reading ${index}`);
        const allNames = [...new Set([...allItems, ...allEquipment, ...allEnemies, ...allReadings].map(entry => entry[1]))];
        const itemPages = Array.from({ length: Math.ceil(allNames.length / slots.length) }, (_, page) =>
          allNames.slice(page * slots.length, (page + 1) * slots.length));
        for (const [page, words] of [commandWords, ['相撲技'], ['達伊達王子', '金丹仙人', '土蜘蛛', '兩鐵', '鬼火', '渦蜘蛛'], ['兔子足袋', ...screenshotEnemies.map(entry => entry[1])], ...itemPages].entries()) {
          const positions = Object.fromEntries(words.map((word, index) => [word, fieldMenuVerification.techniqueWords[slots[index]]]));
          const replacements = new Map(words.map((word, index) => [encodeWord(slots[index]).toString('hex'), word]));
          const name = `screenshot-name-layout-${page}`;
          const filename = path.join(outputDirectory, `${name}.sfc`);
          nameLayoutProbe(techniqueBlock, replacements, filename);
          const screen = run(filename, name, 360, '30:3:down,120:3:a', path.join(commands, 'state.bin'));
          screenshotLayouts.push(assertRenderedWords(path.join(screen, 'frame-360.ppm'), words, positions));
        }
        fieldMenuVerification.screenshotNameChecks = { commandIndexes: 7, princeIndexes: 5, teacherIndex: 239, caveEnemyIndexes: [11, 15, 18, 71], equipmentIndexes: allEquipment.map(entry => entry[0]), enemyIndexes: allEnemies.map(entry => entry[0]), enemyReadingIndexes: allReadings.map(entry => entry[0]), itemIndexes: allItems.map(entry => entry[0]), syntheticTechniqueMenuLayouts: screenshotLayouts, actualBattleMenuVerified: false };
      }
    }
  }
  if (metadata.inlineMenus.some(menu => menu.name === 'speech-speed')) {
    const speech = run(translatedRom, 'speech-speed', 360, '90:3:a', path.join(special, 'state.bin'));
    fieldMenuVerification.speechWords = assertRenderedWords(path.join(speech, 'frame-360.ppm'), ['訊息速度', '極速', '快速', '普通', '慢速']);
    const selectedSpeech = run(translatedRom, 'speech-speed-selected', 180, '30:3:left,60:3:left,120:3:a', path.join(speech, 'state.bin'));
    assert.equal(fs.readFileSync(path.join(selectedSpeech, 'wram-180.bin'))[0x12b6], 1, 'Fastest speech setting was not applied');
    fieldMenuVerification.speechSpeedApplied = true;
    const flight = run(translatedRom, 'flight-speed', 360, '30:3:down,60:3:down,90:3:down,150:3:a', path.join(special, 'state.bin'));
    fieldMenuVerification.flightWords = assertRenderedWords(path.join(flight, 'frame-360.ppm'), ['飛行速度', '極速', '快速', '普通', '慢速']);
    const audio = run(translatedRom, 'audio-mode', 360, '30:3:down,60:3:down,90:3:down,120:3:down,180:3:a', path.join(special, 'state.bin'));
    fieldMenuVerification.audioWords = assertRenderedWords(path.join(audio, 'frame-360.ppm'), ['立體聲', '單聲道']);
  }
}
assert.equal(sha256(originalRom), metadata.sourceSha256);
const report = {
  sourceSha256: metadata.sourceSha256,
  targetSha256: metadata.targetSha256,
  sourceUnchanged: true,
  checksumValid: true,
  titlePixelIdentical: true,
  menuImageChanged: true,
  openingFramesPixelIdentical: identicalFrames,
  narrationImageChanged: hasTranslatedOpening,
  untranslatedControlVerified: hasTranslatedOpening,
  followingScriptByteIdentical: hasTranslatedOpening && metadata.opening.originalParagraphBytes < metadata.opening.originalDecodedBytes ? true : null,
  fieldMenuVerification,
  typewriterTimingIdentical: hasTranslatedOpening ? false : null,
  notVerified: ['Full playthrough', 'Battle', 'Saving and loading', 'Correctness and legibility of every translated glyph'],
};
fs.writeFileSync(path.join(outputDirectory, 'verification.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(`PASS: source identity, checksum, title, menu, ${identicalFrames.length} unchanged scene frames${hasTranslatedOpening ? ', changed narration and six matching recompressed-control frames' : ''}${fieldMenuVerification ? ', translated UI glyphs and setting behavior' : ''}.`);