import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeGlyph } from './font-codec.mjs';
import { chineseCode, chineseDispatchMaximum, chineseFontGroup, chineseGlyphCapacity, chineseGlyphOffset, fontPointerTable, fontBankTable, isGlyphPrefix } from './chinese-font.mjs';
import { compileTextDraft, staticReferences } from './text-catalog.mjs';
import { decodeHuffman, encodeHuffman, huffmanCodes, decodeLz, encodeLzLiterals, readLzTextBlock } from './text-codec.mjs';
import { installWelcomeScreen, welcomeOffset } from './welcome-screen.mjs';
import { commandChartLabels, familyChartLabels, patchCommandChart } from './chart-labels.mjs';
import { encodeInlineLabel } from './inline-text.mjs';
import { patchDefaultMonta, patchDefaultPochi, patchDefaultKiko } from './default-names.mjs';
import { patchEnglishNameEntry } from './english-name-entry.mjs';
import { patchChineseNameQuiz } from './name-quiz.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.resolve(process.env.MOMOTARO_MANIFEST ?? path.join(root, 'translations/menu.zh-Hant.json'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const glyphPrefixRoutine = Buffer.from('c918900ec9209008c9249006c92db002386b186b', 'hex');

function checksum(rom) {
  rom.writeUInt16LE(0xffff, 0xffdc);
  rom.writeUInt16LE(0, 0xffde);
  const sum = rom.reduce((total, byte) => (total + byte) & 0xffff, 0);
  rom.writeUInt16LE(sum ^ 0xffff, 0xffdc);
  rom.writeUInt16LE(sum, 0xffde);
  return sum;
}

function ipsPatch(source, target) {
  const parts = [Buffer.from('PATCH')];
  let offset = 0;
  while (offset < target.length) {
    if (offset < source.length && source[offset] === target[offset]) {
      offset++;
      continue;
    }
    let start = offset;
    if (start === 0x454f46) start--;
    offset++;
    while (offset < target.length && offset - start < 65535 && (offset >= source.length || source[offset] !== target[offset])) offset++;
    const header = Buffer.alloc(5);
    header.writeUIntBE(start, 0, 3);
    header.writeUInt16BE(offset - start, 3);
    parts.push(header, target.subarray(start, offset));
  }
  parts.push(Buffer.from('EOF'));
  return Buffer.concat(parts);
}

function applyIps(source, patch, length) {
  assert.equal(patch.toString('ascii', 0, 5), 'PATCH');
  const target = Buffer.alloc(length);
  source.copy(target);
  let cursor = 5;
  while (patch.toString('ascii', cursor, cursor + 3) !== 'EOF') {
    const offset = patch.readUIntBE(cursor, 3);
    const size = patch.readUInt16BE(cursor + 3);
    assert.ok(size > 0 && cursor + 5 + size <= patch.length && offset + size <= length);
    patch.copy(target, offset, cursor + 5, cursor + 5 + size);
    cursor += 5 + size;
  }
  assert.equal(cursor + 3, patch.length);
  return target;
}

function validateIndexedReplacement(original, replacement, isTextBlock, offset) {
  assert.ok(replacement.length > 0 || (isTextBlock && original.length === 0), `Nonempty indexed text cannot be cleared: ${offset}`);
}

function renderGlyph(character, font) {
  const baseline = manifest.glyphAlignment === 'baseline';
  const result = spawnSync('magick', [
    '-size', '12x16', 'xc:black', '-font', font, '-pointsize', character === '末' ? '13' : '12',
    '-fill', 'white', '-gravity', baseline ? 'None' : 'NorthWest', '-draw', `text 0,${baseline ? 13 : 2} '${character}'`,
    '-colorspace', 'gray', '-depth', '8', 'gray:-',
  ], { maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString() || 'ImageMagick failed');
  assert.equal(result.stdout.length, 192);
  const pixels = new Uint8Array(192);
  for (let row = 1; row < 16; row++) {
    for (let column = 0; column < 12; column++) {
      if (result.stdout[row * 12 + column] < 80) continue;
      pixels[row * 12 + column] |= 2;
      for (let deltaRow = -1; deltaRow <= 1; deltaRow++) {
        for (let deltaColumn = -1; deltaColumn <= 1; deltaColumn++) {
          const neighborRow = row + deltaRow;
          const neighborColumn = column + deltaColumn;
          if (neighborRow >= 1 && neighborRow < 16 && neighborColumn >= 0 && neighborColumn < 12) pixels[neighborRow * 12 + neighborColumn] |= 1;
        }
      }
    }
  }
  assert.ok(pixels.some(pixel => pixel & 2), `Empty glyph: ${character}`);
  return encodeGlyph(pixels, 1, 15);
}

function validTextAllocation(destination, length) {
  return Number.isInteger(destination) && Number.isInteger(length) && length > 0
    && ((destination >= 0x260000 && destination < 0x3c0000 && (destination >>> 16) !== 0x30)
      || (destination >= 0x3d0000 && destination < 0x3e0000))
    && (destination & 0xffff) + length <= 0x10000;
}

function scriptControls(bytes) {
  const controls = [];
  for (let cursor = 0; cursor < bytes.length; cursor++) {
    const byte = bytes[cursor];
    if (isGlyphPrefix(byte)) {
      assert.ok(cursor + 1 < bytes.length, 'Truncated multibyte glyph');
      cursor++;
    } else if (byte === 2) {
      assert.ok(cursor + 1 < bytes.length, 'Truncated dictionary reference');
      controls.push(`02:${bytes[++cursor].toString(16)}`);
    } else if (byte < 0x18) controls.push(byte.toString(16).padStart(2, '0'));
  }
  return controls;
}

function patchCompactHpFont(source, target, font) {
  assert.equal(source.subarray(0x30008, 0x30010).toString('hex'), '8044000666fcdf03');
  const decoded = decodeLz(source.subarray(0x1ffc66), 0x600);
  assert.equal(decoded.consumed, 716);
  assert.equal(decoded.bytes.subarray(0xc0, 0xd0).toString('hex'), 'ff00ff00ff24ff24ff3fff44ff4effd6');
  assert.equal(decoded.bytes.subarray(0x1c0, 0x1d0).toString('hex'), 'ff55ff65ff65ff7fff65ff44ff44ff00');
  const glyphs = [
    { index: 0x0c, label: '血', meaning: '體力' },
    { index: 0x1b, label: '兩', meaning: '金錢單位' },
    { index: 0x1c, label: '咒', meaning: '詛咒' },
    { index: 0x1e, label: '痺', meaning: '麻痺' },
    { index: 0x2c, label: '血', meaning: '體力（另一組字形）' },
  ];
  for (const glyph of glyphs) {
    const rendered = spawnSync('magick', ['-size', '16x16', 'xc:black', '-font', font, '-pointsize', '16',
      '-fill', 'white', '-gravity', 'Center', '-annotate', '+0+0', glyph.label, '-resize', '8x16!',
      '-threshold', '35%', '-depth', '8', 'gray:-']);
    assert.equal(rendered.status, 0, rendered.stderr?.toString());
    assert.equal(rendered.stdout.length, 128);
    const rows = Buffer.alloc(16);
    for (let row = 0; row < 16; row++) {
      for (let column = 0; column < 8; column++) if (rendered.stdout[row * 8 + column]) rows[row] |= 1 << (7 - column);
      const offset = Math.floor(glyph.index / 16) * 0x200 + (glyph.index % 16) * 16
        + (row >= 8 ? 0x100 : 0) + (row % 8) * 2 + 1;
      decoded.bytes[offset] = rows[row];
    }
    assert.ok(rows.some(byte => byte), `Compact status glyph is empty: ${glyph.label}`);
    glyph.rows = rows.toString('hex');
  }
  const stored = encodeLzLiterals(decoded.bytes);
  assert.ok(decodeLz(stored, 0x600).bytes.equals(decoded.bytes));
  assert.ok(target.subarray(0x3c0000, 0x3c0000 + stored.length).every(byte => byte === 0xff), 'Compact font allocation overlaps data');
  stored.copy(target, 0x3c0000);
  target.writeUIntLE(0xfc0000, 0x3000c, 3);
  return { label: '血', meaning: '體力', sourceStart: 0x1ffc66, sourceBytes: decoded.consumed,
    target: 0x3c0000, storedBytes: stored.length, decodedBytes: decoded.bytes.length, rows: glyphs[0].rows, glyphs };
}

function patchBattleStatusFont(source, target, font, hpRows) {
  assert.equal(source.subarray(0x30048, 0x30050).toString('hex'), '0038400fff30d702');
  const decoded = decodeLz(source.subarray(0x1730ff), 0xf40);
  assert.equal(decoded.consumed, 0x700);
  const hp = { tile: 0x08, tiles: 2, label: '血', layout: 'vertical', originalHex: decoded.bytes.subarray(0x100, 0x140).toString('hex') };
  for (const [row, bits] of Buffer.from(hpRows, 'hex').entries()) {
    const offset = 0x100 + Math.floor(row / 8) * 32 + (row % 8) * 2;
    assert.equal(decoded.bytes[offset], 0xff);
    assert.equal(decoded.bytes[offset + 16], 0);
    assert.equal(decoded.bytes[offset + 17], 0);
    decoded.bytes[offset + 1] = bits;
  }
  hp.hex = decoded.bytes.subarray(0x100, 0x140).toString('hex');
  const labels = [
    { tile: 0x0c, tiles: 2, label: '麻痺', foreground: 13 },
    { tile: 0x0e, tiles: 2, label: '中毒', foreground: 15 },
    { tile: 0x10, tiles: 2, label: '詛咒', foreground: 6 },
    { tile: 0x12, tiles: 6, label: '絕好調', foreground: 2 },
    { tile: 0x19, tiles: 3, label: '無敵', foreground: 15 },
  ];
  for (const label of labels) {
    const width = label.tiles * 8;
    const textWidth = [...label.label].length * 8;
    const rendered = spawnSync('magick', ['-size', `${textWidth * 2}x16`, 'xc:black', '-font', font,
      '-pointsize', '16', '-fill', 'white', '-gravity', 'Center', '-annotate', '+0+0', label.label,
      '-resize', `${textWidth}x8!`, '-threshold', '35%', '-depth', '8', 'gray:-']);
    assert.equal(rendered.status, 0, rendered.stderr?.toString());
    assert.equal(rendered.stdout.length, textWidth * 8);
    assert.ok(rendered.stdout.some(byte => byte), `Empty battle status: ${label.label}`);
    const left = Math.floor((width - textWidth) / 2);
    const foreground = (column, row) => row >= 0 && row < 8 && column >= left && column < left + textWidth
      && rendered.stdout[row * textWidth + column - left] !== 0;
    const original = Buffer.from(decoded.bytes.subarray(label.tile * 32, (label.tile + label.tiles) * 32));
    for (let row = 0; row < 8; row++) for (let column = 0; column < width; column++) {
      const position = (label.tile + (column >> 3)) * 32 + row * 2;
      let colour = label.foreground === 2 ? (row === 0 || row === 7 ? 9 : 14) : (row < 3 ? 2 : 1);
      if (foreground(column, row)) colour = label.foreground;
      else if (label.foreground !== 2 && [-1, 0, 1].some(vertical => [-1, 0, 1].some(horizontal => foreground(column + horizontal, row + vertical)))) colour = 2;
      const mask = 1 << (7 - column % 8);
      for (let plane = 0; plane < 4; plane++) {
        const offset = position + (plane >> 1) * 16 + (plane & 1);
        decoded.bytes[offset] = (decoded.bytes[offset] & ~mask) | ((colour >> plane & 1) ? mask : 0);
      }
    }
    label.originalHex = original.toString('hex');
    label.hex = decoded.bytes.subarray(label.tile * 32, (label.tile + label.tiles) * 32).toString('hex');
  }
  const stored = encodeLzLiterals(decoded.bytes);
  assert.deepEqual(decodeLz(stored, 0xf40).bytes, decoded.bytes);
  assert.ok(target.subarray(0x3c0800, 0x3c0800 + stored.length).every(byte => byte === 0xff), 'Battle font allocation overlaps data');
  stored.copy(target, 0x3c0800);
  target.writeUIntLE(0xfc0800, 0x3004c, 3);
  return { sourceStart: 0x1730ff, sourceBytes: decoded.consumed, target: 0x3c0800,
    storedBytes: stored.length, decodedBytes: decoded.bytes.length, vramOffset: 0x7000, hp, labels };
}

function build(source, font, opening, translateOpening = true, welcome) {
  assert.equal(createHash('sha256').update(source).digest('hex'), manifest.sourceSha256, 'Unsupported source ROM');
  assert.ok(manifest.chineseNameQuizExperimental === undefined || typeof manifest.chineseNameQuizExperimental === 'boolean');
  assert.ok(!manifest.chineseNameQuizExperimental || manifest.englishNameEntryExperimental, 'Chinese quiz requires experimental English naming');
  const quizDraft = manifest.chineseNameQuizExperimental
    ? JSON.parse(fs.readFileSync(path.join(root, 'translations/name-quiz.zh-Hant.json'))) : undefined;
  const sections = opening ? [opening, ...(opening.continuation ?? [])] : [];
  const textBlocks = [...(manifest.textBlocks ?? []), ...(manifest.textDrafts ?? []).map(filename =>
    compileTextDraft(source, JSON.parse(fs.readFileSync(path.join(root, 'translations', filename)))))];
  for (const reference of staticReferences.values()) {
    assert.ok(source.subarray(reference.offset, reference.offset + reference.hex.length / 2).equals(Buffer.from(reference.hex, 'hex')), 'Static dictionary source differs');
  }
  const target = Buffer.alloc(0x400000, 0xff);
  source.copy(target);
  const expect = (offset, hex, replacement) => {
    assert.deepEqual(source.subarray(offset, offset + hex.length / 2), Buffer.from(hex, 'hex'), `Unexpected code at ${offset.toString(16)}`);
    Buffer.from(replacement).copy(target, offset);
  };
  const originalFontStart = 0x1a382c;
  const originalFontEnd = 0x1af944 + 64 * 46;
  assert.ok(originalFontEnd - originalFontStart + 0x200100 <= fontPointerTable);
  source.copy(target, 0x200100, originalFontStart, originalFontEnd);
  for (let group = 0; group < 22; group++) {
    const originalOffset = 0x1a0000 + source.readUInt16LE(0x1a3800 + group * 2);
    target.writeUInt16LE(originalOffset - originalFontStart + 0x100, fontPointerTable + group * 2);
    target[fontBankTable + group * 2] = 0xe0;
  }
  const newGroup = 0x240000;
  expect(0x49e03, 'c9189007c920b0033880011860', [0x22, 0x20, 0xff, 0xe4, 0x60, ...Array(8).fill(0xea)]);
  glyphPrefixRoutine.copy(target, 0x24ff20);
  expect(0x4a613, 'ff072aa6', [chineseDispatchMaximum & 255, chineseDispatchMaximum >> 8, 0x2a, 0xa6]);
  expect(0x4a634, '29c007', [0x29, 0xc0, 0x1f]);
  expect(0x4a9b5, '0038da', [fontPointerTable & 255, (fontPointerTable >> 8) & 255, 0xe0]);
  expect(0x4a9bb, '0138da', [(fontPointerTable + 1) & 255, (fontPointerTable >> 8) & 255, 0xe0]);
  expect(0x4a9c0, 'a9da852c', [0x22, 0x00, 0xff, 0xe4]);
  Buffer.from([0xbf, fontBankTable & 255, (fontBankTable >> 8) & 255, 0xe0, 0x85, 0x2c, 0x6b]).copy(target, 0x24ff00);
  const characters = [...new Set([
    ...(manifest.glyphOrder ?? []),
    ...manifest.entries.flatMap(entry => entry.segments
      ? entry.segments.flatMap(segment => [...(segment.text ?? '')]) : [...entry.translation]),
    ...sections.flatMap(section => section.segments.flatMap(segment => [...(segment.text ?? '')])),
    ...(manifest.inlineMenus ?? []).flatMap(menu => menu.entries.flatMap(entry => [...entry.translation])),
    ...(manifest.nameBlocks ?? []).flatMap(block => block.entries.flatMap(entry => [...entry.translation])),
    ...(manifest.commandChart ? commandChartLabels.flatMap(label => [...label.text].filter(character => character !== ' ')) : []),
    ...(manifest.familyChart ? familyChartLabels.flatMap(label => [...label.text].filter(character => character !== ' ')) : []),
    ...(manifest.defaultMonta ? ['蒙', '太'] : []),
    ...(manifest.defaultPochi ? ['波', '奇'] : []),
    ...(manifest.defaultKiko ? ['琪', '可'] : []),
    ...textBlocks.flatMap(block => block.entries.flatMap(entry => entry.segments.flatMap(segment => [...(segment.text ?? '')]))),
    ...(quizDraft?.questions ?? []).flatMap(question => [...question.clue, ...question.answer]),
  ])];
  assert.ok(characters.length <= chineseGlyphCapacity, 'Chinese font capacity exceeded');
  const groupCount = Math.ceil(characters.length / 64);
  const groupSize = 1 + 64 * 46;
  for (let group = 0; group < groupCount; group++) {
    const { number, offset } = chineseFontGroup(group * 64);
    assert.ok(number <= 128 && offset + groupSize <= (group < 17 ? 0x24ff00 : group < 37 ? 0x310000 : 0x260000), 'Chinese font allocation overlaps reserved data');
    assert.ok(target.subarray(offset, offset + groupSize).every(byte => byte === 0xff), 'Chinese font allocation is occupied');
    target.writeUInt16LE(offset & 65535, fontPointerTable + (number - 1) * 2);
    target[fontBankTable + (number - 1) * 2] = (offset + 0xc00000) >> 16;
    target[offset] = 0x1f;
    target.fill(0, offset + 1, offset + groupSize);
  }
  const glyphs = characters.map(character => renderGlyph(character, font));
  glyphs.forEach((bytes, index) => bytes.copy(target, chineseGlyphOffset(index)));
  const renderedCharacters = new Map();
  for (const [index, glyph] of glyphs.entries()) {
    const key = glyph.toString('hex');
    const previous = renderedCharacters.get(key);
    const sharedHorizontalStroke = manifest.glyphAlignment === 'baseline'
      && [previous, characters[index]].sort().join('') === '\u2500\u4e00';
    assert.ok(!renderedCharacters.has(key) || sharedHorizontalStroke,
      `Duplicate rendered glyphs: ${previous} / ${characters[index]}; check font coverage`);
    renderedCharacters.set(key, characters[index]);
  }
  const encode = text => Buffer.from([...text].flatMap(character => chineseCode(characters.indexOf(character))));
  const encodeSegments = segments => Buffer.concat(segments.map(segment => {
    assert.ok((typeof segment.hex === 'string') !== (typeof segment.text === 'string'));
    if (segment.text !== undefined) return encode(segment.text);
    assert.match(segment.hex, /^(?:[0-9a-f]{2})+$/i);
    return Buffer.from(segment.hex, 'hex');
  }));
  const nameBlockReports = [];
  for (const names of [...(manifest.nameBlocks ?? []), ...textBlocks]) {
    const isTextBlock = textBlocks.includes(names);
    const pointer = Number(names.pointerOffset);
    const start = source.readUIntLE(pointer, 3) - 0xc00000;
    const end = source.readUIntLE(pointer + 3, 3) - 0xc00000;
    const destination = Number(names.target);
    assert.ok(start >= 0 && end > start && end <= source.length);
    const sourceType = source[start];
    const compressed = isTextBlock && [1, 2].includes(sourceType);
    assert.ok(compressed || sourceType === 0, 'Expected raw, LZ or Huffman indexed text');
    let blockSource = source.subarray(start, end);
    if (sourceType === 1) blockSource = Buffer.concat([Buffer.from([0]), readLzTextBlock(source, pointer).bytes]);
    if (sourceType === 2) {
      assert.ok(Number.isInteger(names.decodedBytes) && names.decodedBytes > 0, 'Huffman block needs an explicit decoded length');
      const decoded = decodeHuffman(source, source.subarray(start + 1, end), names.decodedBytes);
      assert.ok(encodeHuffman(decoded.bytes, huffmanCodes(source)).bytes.equals(source.subarray(start + 1, end)), 'Original Huffman block must round trip exactly');
      blockSource = Buffer.concat([Buffer.from([0]), decoded.bytes]);
    }
    const fragments = [];
    let cursor = 0;
    for (const entry of names.entries) {
      const offset = compressed ? Number(entry.offset) + 1 : Number(entry.offset) - start;
      const original = Buffer.from(entry.originalHex, 'hex');
      if (names.complete) assert.equal(offset, cursor + 1, 'Complete dialogue block has an untranslated gap');
      assert.ok(offset >= cursor && offset + original.length < blockSource.length);
      assert.ok(blockSource.subarray(offset, offset + original.length).equals(original), `Name source differs: ${entry.offset}`);
      assert.equal(blockSource[offset + original.length], 0);
      const replacement = isTextBlock ? encodeSegments(entry.segments) : encode(entry.translation);
      validateIndexedReplacement(original, replacement, isTextBlock, entry.offset);
      if (isTextBlock) assert.deepEqual(scriptControls(replacement), scriptControls(original).filter(control => !staticReferences.has(control)), `Indexed text controls differ: ${entry.offset}`);
      fragments.push(blockSource.subarray(cursor, offset), translateOpening ? replacement : original);
      cursor = offset + original.length;
    }
    fragments.push(blockSource.subarray(cursor));
    if (names.complete) assert.equal(cursor, blockSource.length - 1, 'Complete dialogue block has an untranslated tail');
    const data = Buffer.concat(fragments);
    if (!translateOpening) assert.ok(data.equals(blockSource), 'Round-trip control indexed text changed');
    const countStrings = bytes => scriptControls(bytes.subarray(1)).filter(control => control === '00').length;
    assert.equal(countStrings(data), countStrings(blockSource), 'Name indexes changed');
    const stored = sourceType === 2 ? Buffer.concat([Buffer.from([2]), encodeHuffman(data.subarray(1), huffmanCodes(source)).bytes])
      : compressed ? Buffer.concat([Buffer.from([1]), encodeLzLiterals(data.subarray(1))]) : data;
    if (sourceType === 1) assert.ok(decodeLz(stored.subarray(1)).bytes.equals(data.subarray(1)), 'Indexed story LZ round trip failed');
    if (sourceType === 2) assert.ok(decodeHuffman(source, stored.subarray(1), data.length - 1).bytes.equals(data.subarray(1)), 'Indexed story Huffman round trip failed');
    assert.ok(isTextBlock
      ? validTextAllocation(destination, stored.length)
      : destination >= 0x250000 && destination + data.length <= 0x255000 && data.length <= 0x1000);
    assert.ok(target.subarray(destination, destination + stored.length).every(byte => byte === 0xff), `Indexed text allocation overlaps data: ${names.name} at 0x${destination.toString(16)} (${stored.length} bytes)`);
    stored.copy(target, destination);
    expect(pointer, source.subarray(pointer, pointer + 3).toString('hex'), [destination & 255, (destination >> 8) & 255, 0xc0 + (destination >> 16)]);
    nameBlockReports.push({ name: names.name, kind: isTextBlock ? 'text' : 'names', sourceStart: start, sourceEnd: end, relocatedOffset: names.target, strings: countStrings(data), translatedNames: translateOpening ? names.entries.length : 0, complete: translateOpening && names.complete === true, compressed, sourceType, decodedBytes: data.length - 1, storedBytes: stored.length });
  }
  for (const menu of manifest.inlineMenus ?? []) {
    const start = Number(menu.start);
    const end = Number(menu.end);
    const destination = Number(menu.target);
    const fragments = [];
    let position = start;
    for (const entry of menu.entries) {
      const offset = Number(entry.offset);
      const original = Buffer.from(entry.originalHex, 'hex');
      assert.ok(offset >= position && offset + original.length <= end);
      assert.ok(source.subarray(offset, offset + original.length).equals(original), `Inline menu source differs: ${entry.offset}`);
      const padding = entry.padding ?? 0;
      assert.ok(Number.isInteger(padding) && padding >= 0 && padding <= 8);
      fragments.push(source.subarray(position, offset), encodeInlineLabel(entry, character => encode(character)), Buffer.alloc(padding, 0x50));
      position = offset + original.length;
    }
    fragments.push(source.subarray(position, end));
    const data = Buffer.concat(fragments);
    assert.ok(destination >= 0x230000 && destination + data.length <= 0x23e000 && data.length <= 0x1000);
    assert.ok(target.subarray(destination, destination + data.length).every(byte => byte === 0xff), `Inline menu allocation overlaps data: ${menu.name}`);
    data.copy(target, destination);
    for (const reference of [menu, ...(menu.alternatePointers ?? [])]) {
      const skip = reference.skip ?? 0;
      assert.ok(Number.isInteger(skip) && skip >= 0 && start + skip <= Number(menu.entries[0].offset), 'Alternate pointer must precede translated text');
      const oldPointer = Buffer.alloc(2);
      oldPointer.writeUInt16LE((start + skip) & 65535);
      const relocated = destination + skip;
      expect(Number(reference.pointerOperand), oldPointer.toString('hex'), [relocated & 255, (relocated >> 8) & 255]);
      expect(Number(reference.bankOperand), menu.originalBank ?? '81', [0xe3]);
    }
  }
  const blockStart = 0x704f2;
  const blockEnd = 0x70a0a;
  const pieces = [];
  let cursor = blockStart;
  for (const entry of manifest.entries) {
    const offset = Number(entry.offset);
    const original = Buffer.from(entry.originalHex, 'hex');
    assert.ok(offset >= cursor && offset + original.length < blockEnd);
    assert.deepEqual(source.subarray(offset, offset + original.length), original);
    assert.equal(source[offset + original.length], 0);
    const replacement = entry.segments ? encodeSegments(entry.segments) : encode(entry.translation);
    assert.deepEqual(scriptControls(replacement), scriptControls(original).filter(control => !staticReferences.has(control)), `Main text controls differ: ${entry.offset}`);
    pieces.push(source.subarray(cursor, offset), replacement);
    cursor = offset + original.length;
  }
  pieces.push(source.subarray(cursor, blockEnd));
  const block = Buffer.concat(pieces);
  assert.equal(scriptControls(block.subarray(1)).filter(control => control === '00').length,
    scriptControls(source.subarray(blockStart + 1, blockEnd)).filter(control => control === '00').length);
  block.copy(target, 0x210000);
  expect(0x70003, 'f204c7', [0x00, 0x00, 0xe1]);
  let openingReport;
  if (opening) {
    const originalBlock = readLzTextBlock(source, Number(opening.pointerOffset));
    const originalParagraph = Buffer.concat(sections.map(section => Buffer.from(section.originalHex, 'hex')));
    assert.deepEqual(originalBlock.bytes.subarray(0, originalParagraph.length), originalParagraph, 'Opening source text differs');
    assert.equal(originalParagraph.at(-1), 0);
    const replacement = Buffer.concat(sections.map(section => {
      const original = Buffer.from(section.originalHex, 'hex');
      assert.equal(original.at(-1), 0);
      const translatedSection = Buffer.concat(section.segments.map(segment => {
        assert.ok((typeof segment.hex === 'string') !== (typeof segment.text === 'string'));
        if (segment.text !== undefined) return encode(segment.text);
        assert.match(segment.hex, /^(?:[0-9a-f]{2})+$/i);
        return Buffer.from(segment.hex, 'hex');
      }));
      assert.equal(translatedSection.at(-1), 0);
      assert.deepEqual(scriptControls(translatedSection), scriptControls(original).filter(control => !staticReferences.has(control)), `Opening controls differ: ${section.source}`);
      return translatedSection;
    }));
    assert.equal(replacement.at(-1), 0);
    const suffix = originalBlock.bytes.subarray(originalParagraph.length);
    const translated = translateOpening ? Buffer.concat([replacement, suffix]) : originalBlock.bytes;
    const compressed = encodeLzLiterals(translated);
    assert.deepEqual(decodeLz(compressed).bytes, translated);
    assert.deepEqual(translated.subarray(translateOpening ? replacement.length : originalParagraph.length), suffix);
    assert.ok(compressed.length + 1 <= 0x10000);
    target[0x220000] = 1;
    compressed.copy(target, 0x220001);
    expect(originalBlock.pointerOffset, source.subarray(originalBlock.pointerOffset, originalBlock.pointerOffset + 3).toString('hex'), [0x00, 0x00, 0xe2]);
    openingReport = {
      translated: translateOpening,
      pointerOffset: opening.pointerOffset,
      sourceStart: originalBlock.start,
      originalDecodedBytes: originalBlock.bytes.length,
      originalParagraphBytes: originalParagraph.length,
      replacementParagraphBytes: translateOpening ? replacement.length : originalParagraph.length,
      suffixPreserved: true,
      relocatedOffset: '0x220000',
      compressedBytes: compressed.length,
    };
  }
  expect(0xffd7, '0b', [0x0c]);
  const compactHpFont = patchCompactHpFont(source, target, font);
  const battleStatusFont = patchBattleStatusFont(source, target, font, compactHpFont.rows);
  assert.ok(!manifest.familyChart || manifest.commandChart, 'Family chart requires the isolated chart lookup');
  const commandChart = manifest.commandChart ? patchCommandChart(source, target, characters, { familyChart: manifest.familyChart }) : undefined;
  const defaultMonta = manifest.defaultMonta ? patchDefaultMonta(source, target, characters) : undefined;
  assert.ok(!manifest.defaultPochi || manifest.defaultMonta, 'Default Pochi requires the Monta display hook');
  const defaultPochi = manifest.defaultPochi ? patchDefaultPochi(source, target, characters) : undefined;
  assert.ok(!manifest.defaultKiko || manifest.defaultPochi, 'Default Kiko requires the Pochi display hook');
  const defaultKiko = manifest.defaultKiko ? patchDefaultKiko(source, target, characters) : undefined;
  assert.ok(manifest.englishNameEntryExperimental === undefined || typeof manifest.englishNameEntryExperimental === 'boolean');
  const englishNameEntry = manifest.englishNameEntryExperimental ? patchEnglishNameEntry(source, target) : undefined;
  if (englishNameEntry) {
    const keyboardBlock = nameBlockReports.find(block => block.sourceStart === source.readUIntLE(0x70033, 3) - 0xc00000);
    assert.ok(keyboardBlock, 'English keyboard requires its indexed text block in the manifest');
    keyboardBlock.relocatedOffset = `0x${englishNameEntry.textOffset.toString(16)}`;
    keyboardBlock.decodedBytes = englishNameEntry.textBytes - 1;
    keyboardBlock.storedBytes = englishNameEntry.textBytes;
    keyboardBlock.englishKeyboardRows = englishNameEntry.replacedRowIndexes;
  }
  const chineseNameQuiz = quizDraft ? patchChineseNameQuiz(source, target, characters, quizDraft) : undefined;
  const welcomeScreen = welcome ? installWelcomeScreen(target, { ...welcome, font }) : undefined;
  const sum = checksum(target);
  return { target, characters, checksum: sum, newGroup, groupCount, openingReport, nameBlockReports, welcomeScreen, compactHpFont, battleStatusFont, commandChart, defaultMonta, defaultPochi, defaultKiko, englishNameEntry, chineseNameQuiz };
}

const [command, font, destination, openingPath, cover, version] = process.argv.slice(2);
if (command === 'self-test') {
  const emptyRecord = Buffer.alloc(0);
  const textRecord = Buffer.from([0x90]);
  validateIndexedReplacement(emptyRecord, emptyRecord, true, 0);
  validateIndexedReplacement(textRecord, textRecord, true, 0);
  validateIndexedReplacement(textRecord, textRecord, false, 0);
  assert.throws(() => validateIndexedReplacement(textRecord, emptyRecord, true, 0), /cannot be cleared/);
  assert.throws(() => validateIndexedReplacement(emptyRecord, emptyRecord, false, 0), /cannot be cleared/);
  const occupiedWelcomeBank = Buffer.alloc(0x400000, 0xff);
  Buffer.from('78a90048', 'hex').copy(occupiedWelcomeBank, 0xf002);
  occupiedWelcomeBank[welcomeOffset] = 0;
  assert.throws(() => installWelcomeScreen(occupiedWelcomeBank, {}), /already allocated/);
  const confirmation = manifest.inlineMenus.find(menu => menu.name === 'yes-no');
  assert.equal(Number(confirmation.start), 0x5bb17);
  assert.equal(Number(confirmation.end), 0x5bb2a, 'Yes/no relocation must include both three-byte selection callbacks');
  const sumo = manifest.inlineMenus.find(menu => menu.name === 'sumo-techniques');
  assert.equal(Number(sumo.start), 0x2e8fa);
  assert.equal(Number(sumo.end), 0x2e927, 'Sumo relocation must include all three three-byte selection callbacks');
  for (let value = 0; value < 256; value++) {
    let offset = 0, carry = false, returned = false;
    for (let step = 0; step < 20; step++) {
      const opcode = glyphPrefixRoutine[offset++];
      if (opcode === 0xc9) carry = value >= glyphPrefixRoutine[offset++];
      else if (opcode === 0x90 || opcode === 0xb0) {
        const relative = glyphPrefixRoutine.readInt8(offset++);
        if (opcode === 0x90 ? !carry : carry) offset += relative;
      } else if (opcode === 0x38) carry = true;
      else if (opcode === 0x18) carry = false;
      else if (opcode === 0x6b) { returned = true; break; }
      else assert.fail(`Invalid prefix classifier instruction at ${offset - 1}`);
    }
    assert.ok(returned, 'Prefix classifier did not return');
    assert.equal(carry, isGlyphPrefix(value), `Native prefix classification differs for ${value}`);
  }
  assert.deepEqual(chineseCode(0), [0x1b, 0xc0]);
  assert.deepEqual(chineseCode(63), [0x1b, 0xff]);
  assert.deepEqual(chineseCode(64), [0x1c, 0x00]);
  assert.deepEqual(chineseCode(255), [0x1c, 0xbf]);
  assert.deepEqual(chineseCode(256), [0x1c, 0xc0]);
  assert.deepEqual(chineseCode(1087), [0x1f, 0xff]);
  assert.deepEqual(chineseCode(1088), [0x24, 0x00]);
  assert.deepEqual(chineseCode(1599), [0x25, 0xff]);
  assert.deepEqual(chineseCode(1600), [0x26, 0x00]);
  assert.deepEqual(chineseCode(1856), [0x27, 0x00]);
  assert.deepEqual(chineseCode(2111), [0x27, 0xff]);
  assert.deepEqual(chineseCode(2112), [0x28, 0x00]);
  assert.deepEqual(chineseCode(2367), [0x28, 0xff]);
  assert.deepEqual(chineseCode(2368), [0x29, 0x00]);
  assert.deepEqual(chineseCode(3327), [0x2c, 0xbf]);
  assert.equal(chineseDispatchMaximum, 0x15bf);
  for (let index = 0; index < chineseGlyphCapacity; index++) {
    const [prefix, suffix] = chineseCode(index);
    const nativeCode = ((prefix - 0x17) << 8) | suffix;
    assert.ok(nativeCode <= chineseDispatchMaximum, `Glyph ${index} bypasses the native font dispatcher`);
    assert.equal((((nativeCode - 0x100) & 0x1fc0) >> 6) + 8, chineseFontGroup(index).number);
  }
  assert.throws(() => chineseCode(chineseGlyphCapacity), /exceeds/);
  assert.deepEqual(chineseFontGroup(1088), { number: 56, offset: 0x300000 });
  assert.equal(chineseFontGroup(1599).number, 63);
  assert.equal(chineseFontGroup(2111).number, 71);
  assert.equal(chineseFontGroup(2112).number, 72);
  assert.equal(chineseFontGroup(2367).number, 75);
  assert.ok(chineseFontGroup(2367).offset + 2945 <= 0x310000);
  assert.deepEqual(chineseFontGroup(2368), { number: 76, offset: 0x255000 });
  assert.equal(chineseFontGroup(3327).number, 90);
  assert.ok(chineseFontGroup(3327).offset + 2945 <= 0x260000);
  for (let index = 0; index < 2368; index++) {
    const previousCode = 0x4c0 + index + (index >= 1088 ? 0x400 : 0);
    assert.deepEqual(chineseCode(index), [0x17 + (previousCode >> 8), previousCode & 255]);
  }
  assert.ok(fontPointerTable + 128 * 2 <= fontBankTable);
  assert.ok(fontBankTable + 128 * 2 <= 0x210000);
  assert.ok([0x20, 0x21, 0x22, 0x23].every(byte => !isGlyphPrefix(byte)));
  assert.deepEqual(scriptControls(Buffer.from('240025ff0102a0', 'hex')), ['01', '02:a0']);
  assert.deepEqual(scriptControls(Buffer.from('27ff280028ff0102a0', 'hex')), ['01', '02:a0']);
  assert.deepEqual(scriptControls(Buffer.from('28ff290029ff2a002b002cbf0102a0', 'hex')), ['01', '02:a0']);
  assert.deepEqual(scriptControls(Buffer.from([0x1c, 0, 0x1c, 1, 1, 2, 0xa0, 0])), ['01', '02:a0', '00']);
  assert.throws(() => scriptControls(Buffer.from([0x1c])), /Truncated/);
  for (const destination of [0x260000, 0x2c2000, 0x31f000, 0x3dfe00]) assert.ok(validTextAllocation(destination, 0x100));
  for (const destination of [0x250000, 0x300000, 0x300001, 0x30ffff, 0x3c0000, 0x3e0000]) assert.ok(!validTextAllocation(destination, 1));
  assert.ok(validTextAllocation(0x2cff00, 0x100));
  assert.ok(!validTextAllocation(0x2cff00, 0x101));
  assert.ok(!validTextAllocation(0x2c2000, 0));
  const source = Buffer.from([0, 1, 2, 3]);
  const target = Buffer.from([0, 9, 2, 3, 4, 5]);
  assert.deepEqual(applyIps(source, ipsPatch(source, target), target.length), target);
  const large = Buffer.alloc(0x20010, 0xaa);
  assert.deepEqual(applyIps(source, ipsPatch(source, large), large.length), large);
  const rom = Buffer.alloc(0x10000, 0xff);
  const sum = checksum(rom);
  assert.equal(rom.reduce((total, byte) => (total + byte) & 65535, 0), sum);
  console.log('IPS round trips and SNES checksum tests passed.');
} else if (['build', 'build-roundtrip', 'build-welcome'].includes(command) && font && destination) {
  assert.ok(command !== 'build-roundtrip' || openingPath, 'Round-trip build requires an opening manifest');
  assert.ok(command !== 'build-welcome' || (openingPath && cover && version), 'Welcome build requires opening manifest, cover image and version');
  const opening = openingPath ? JSON.parse(fs.readFileSync(openingPath, 'utf8')) : undefined;
  const source = fs.readFileSync(path.join(root, 'assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc'));
  const result = build(source, font, opening, command !== 'build-roundtrip', command === 'build-welcome' ? { cover, version } : undefined);
  const patch = ipsPatch(source, result.target);
  assert.deepEqual(applyIps(source, patch, result.target.length), result.target);
  const prefix = opening ? 'opening-zh-Hant' : 'menu-zh-Hant';
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, `${prefix}.sfc`), result.target, { flag: 'wx' });
  fs.writeFileSync(path.join(destination, `${prefix}.ips`), patch, { flag: 'wx' });
  if (result.welcomeScreen) {
    const preview = spawnSync('magick', ['-size', '256x224', '-depth', '8', 'rgb:-', path.join(destination, result.welcomeScreen.metadata.previewFilename)],
      { input: result.welcomeScreen.preview });
    assert.equal(preview.status, 0, preview.stderr?.toString() || 'Welcome preview conversion failed');
  }
  fs.writeFileSync(path.join(destination, 'build.json'), JSON.stringify({
    status: result.chineseNameQuiz ? 'experimental-english-input-chinese-quiz-not-release-verified'
      : result.englishNameEntry ? 'experimental-english-input-not-release-verified'
      : command === 'build-roundtrip' ? 'opening-roundtrip-control' : opening?.status ?? manifest.status,
    manifestPath,
    romFilename: `${prefix}.sfc`,
    sourceSha256: manifest.sourceSha256,
    targetSha256: createHash('sha256').update(result.target).digest('hex'),
    fontSha256: createHash('sha256').update(fs.readFileSync(font)).digest('hex'),
    font: path.basename(font),
    glyphs: result.characters.map((character, index) => ({ character, code: Buffer.from(chineseCode(index)).toString('hex'), offset: chineseGlyphOffset(index) })),
    checksum: result.checksum.toString(16),
    newFontGroupOffset: result.newGroup.toString(16),
    newFontGroupCount: result.groupCount,
    fontPointerTable,
    fontBankTable,
    nameBlocks: result.nameBlockReports.filter(block => block.kind === 'names'),
    textBlocks: result.nameBlockReports.filter(block => block.kind === 'text'),
    inlineMenus: (manifest.inlineMenus ?? []).map(menu => ({ name: menu.name, sourceStart: menu.start, sourceEnd: menu.end, target: menu.target, translatedLabels: menu.entries.length })),
    opening: result.openingReport,
    welcome: result.welcomeScreen?.metadata,
    compactHpFont: result.compactHpFont,
    battleStatusFont: result.battleStatusFont,
    glyphAlignment: manifest.glyphAlignment ?? 'legacy-top',
    commandChart: result.commandChart,
    defaultMonta: result.defaultMonta,
    defaultPochi: result.defaultPochi,
    defaultKiko: result.defaultKiko,
    englishNameEntry: result.englishNameEntry,
    chineseNameQuiz: result.chineseNameQuiz,
  }, null, 2));
  console.log(`Built ${prefix} and verified IPS patch in ${destination}`);
} else {
  throw new Error('Usage: node tools/build-menu-patch.mjs self-test | build FONT_FILE NEW_OUTPUT_DIRECTORY [OPENING_MANIFEST] | build-roundtrip FONT_FILE NEW_OUTPUT_DIRECTORY OPENING_MANIFEST | build-welcome FONT_FILE NEW_OUTPUT_DIRECTORY OPENING_MANIFEST COVER_IMAGE VERSION\nMOMOTARO_MANIFEST overrides translations/menu.zh-Hant.json; relative override paths resolve from the working directory. Text draft paths remain relative to the project translations directory.');
}