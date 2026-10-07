import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { catalog, compileTextDraft, splitRecords } from './text-catalog.mjs';
import { decodeHuffman, decodeLz } from './text-codec.mjs';
import { addInlineMenuData, encodeInlineLabel } from './inline-text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(process.argv[2] ?? path.join(root, 'opening-preview-v44'));
const read = filename => JSON.parse(fs.readFileSync(filename));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = read(path.join(directory, 'build.json'));
const planIndex = process.argv.indexOf('--plan');
const plan = planIndex < 0 ? null : read(path.resolve(root, process.argv[planIndex + 1]));
const manifest = read(path.join(root, plan?.manifest ?? 'translations/screenshots-v44.release.json'));
const baseDirectory = plan?.translationBaseDirectory ?? plan?.baseDirectory ?? 'opening-preview-v42-sumo-fix';
const base = read(path.join(root, baseDirectory, 'resolved-translation-manifest.json'));
const audit = plan ? null : read(path.join(root, 'translations/screenshot-review-20261003.json'));
const source = fs.readFileSync(path.join(root, 'assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc'));
const target = fs.readFileSync(path.join(directory, metadata.romFilename));
assert.equal(hash(source), manifest.sourceSha256);
assert.equal(hash(target), metadata.targetSha256);
assert.equal(target.length, 0x400000);
assert.equal(target.reduce((sum, byte) => (sum + byte) & 65535, 0), target.readUInt16LE(0xffde));
assert.equal(target.readUInt16LE(0xffdc) ^ target.readUInt16LE(0xffde), 65535);
const glyphs = new Map(metadata.glyphs.map(glyph => [glyph.character, Buffer.from(glyph.code, 'hex')]));
const encode = entry => Buffer.concat((entry.segments ?? [{ text: entry.translation }]).map(segment => {
  if (segment.hex) return Buffer.from(segment.hex, 'hex');
  return Buffer.concat([...segment.text].map(character => {
    assert.ok(glyphs.has(character), `Missing glyph ${character}`);
    return glyphs.get(character);
  }));
}));
const decode = (rom, start, end, length) => rom[start] === 0 ? rom.subarray(start + 1, end)
  : rom[start] === 1 ? decodeLz(rom.subarray(start + 1, end)).bytes
    : decodeHuffman(rom, rom.subarray(start + 1, end), length).bytes;
let checkedRecords = 0;
let unchangedRecords = 0;
const translated = new Set();
for (const definition of [...manifest.textBlocks, ...manifest.nameBlocks]) {
  const block = [...metadata.textBlocks, ...metadata.nameBlocks].find(item => item.name === definition.name);
  assert.ok(block);
  const pointer = Number(definition.pointerOffset);
  assert.equal(target.readUIntLE(pointer, 3) - 0xc00000, Number(definition.target));
  const before = splitRecords(decode(source, block.sourceStart, block.sourceEnd, definition.decodedBytes));
  const after = splitRecords(decode(target, Number(block.relocatedOffset),
    Number(block.relocatedOffset) + block.storedBytes, block.decodedBytes));
  assert.equal(before.length, after.length);
  for (const record of before) {
    const offset = record.decodedOffset + (block.sourceType === 0 ? block.sourceStart + 1 : 0);
    const entry = definition.entries.find(item => Number(item.offset) === offset);
    const expected = entry ? encode(entry).toString('hex') : record.originalHex;
    assert.equal(after[record.index].originalHex, expected, `${definition.name}:${record.index}`);
    if (entry) translated.add(`${pointer}:${record.index}`);
    else unchangedRecords++;
    checkedRecords++;
  }
}
const mainStart = source.readUIntLE(0x70003, 3) - 0xc00000;
const mainEnd = source.readUIntLE(0x70006, 3) - 0xc00000;
const mainLength = mainEnd - mainStart + manifest.entries.reduce((size, entry) =>
  size + encode(entry).length - entry.originalHex.length / 2, 0);
const beforeMain = splitRecords(source.subarray(mainStart + 1, mainEnd));
const afterMain = splitRecords(target.subarray(0x210001, 0x210000 + mainLength));
assert.equal(beforeMain.length, afterMain.length);
for (const record of beforeMain) {
  const entry = manifest.entries.find(item => Number(item.offset) === mainStart + 1 + record.decodedOffset);
  assert.equal(afterMain[record.index].originalHex, entry ? encode(entry).toString('hex') : record.originalHex);
  if (entry) translated.add(`${0x70003}:${record.index}`);
}
for (const key of ['entries', 'nameBlocks', 'textBlocks', 'inlineMenus']) {
  for (const old of base[key]) {
    const current = manifest[key].find(item => key === 'entries' ? item.offset === old.offset : item.name === old.name);
    assert.ok(current, `Missing previous ${key} ${old.name ?? old.offset}`);
    if (key === 'textBlocks' || key === 'nameBlocks') {
      for (const entry of old.entries) assert.deepEqual(current.entries.find(item => item.offset === entry.offset), entry);
      if (key === 'nameBlocks') {
        const { entries: oldEntries, ...oldMetadata } = old;
        const { entries: currentEntries, ...currentMetadata } = current;
        assert.deepEqual(currentMetadata, oldMetadata);
      }
    } else if (key === 'inlineMenus') {
      const expected = structuredClone(old);
      addInlineMenuData([expected], (plan?.inlineMenuAdditions ?? []).filter(change => change.name === old.name), source);
      for (const change of (plan?.inlineMenuPadding ?? []).filter(change => change.name === old.name)) {
        expected.entries.find(entry => Number(entry.offset) === Number(change.offset)).padding = change.padding;
      }
      assert.deepEqual(current, expected);
    } else assert.deepEqual(current, old);
  }
}
const inlineVerified = new Set();
for (const menu of manifest.inlineMenus) {
  const fragments = [];
  let cursor = Number(menu.start);
  for (const entry of menu.entries) {
    fragments.push(source.subarray(cursor, Number(entry.offset)), encodeInlineLabel(entry, character => glyphs.get(character)), Buffer.alloc(entry.padding ?? 0, 0x50));
    cursor = Number(entry.offset) + entry.originalHex.length / 2;
  }
  fragments.push(source.subarray(cursor, Number(menu.end)));
  const expected = Buffer.concat(fragments);
  assert.ok(target.subarray(Number(menu.target), Number(menu.target) + expected.length).equals(expected));
  for (const reference of [menu, ...(menu.alternatePointers ?? [])]) {
    assert.equal(target.readUInt16LE(Number(reference.pointerOperand)), (Number(menu.target) + (reference.skip ?? 0)) & 65535);
    assert.equal(target[Number(reference.bankOperand)], 0xe3);
  }
  inlineVerified.add(menu.name);
}
let screenshotMappings = 0;
for (const screenshot of audit?.screenshots ?? []) {
  if (screenshot.translationFile) {
    const draft = read(path.join(root, screenshot.translationFile));
    const compiled = compileTextDraft(source, draft);
    const definition = manifest.textBlocks.find(item => item.pointerOffset === draft.pointerOffset);
    for (const index of screenshot.records) {
      assert.ok(translated.has(`${Number(draft.pointerOffset)}:${index}`));
      const entries = compileTextDraft(source, { ...draft, complete: false, records: { [index]: draft.records[index] } }).entries;
      for (const entry of entries) assert.deepEqual(definition.entries.find(item => item.offset === entry.offset), entry);
      screenshotMappings++;
    }
    assert.ok(compiled.entries.length);
  }
  for (const reference of screenshot.supplementalReferences ?? []) {
    if (reference.pointerOffset) {
      assert.ok(translated.has(`${Number(reference.pointerOffset)}:${reference.record}`));
    } else {
      assert.ok(inlineVerified.has(reference.menu ?? reference.name), `Unverified inline reference ${JSON.stringify(reference)}`);
    }
    screenshotMappings++;
  }
}
let draftRecords = 0;
let checkedDraftRecords = 0;
let previousGlyphsPreserved;
let previousGlyphCodesPreserved;
const realignedGlyphs = [];
if (plan) {
  for (const filename of plan.drafts) {
    const draft = read(path.join(root, filename));
    const compiled = compileTextDraft(source, draft);
    const names = manifest.nameBlocks.find(item => item.pointerOffset === draft.pointerOffset);
    const entries = Number(draft.pointerOffset) === 0x70003 ? manifest.entries
      : (names ?? manifest.textBlocks.find(item => item.pointerOffset === draft.pointerOffset)).entries;
    for (const entry of compiled.entries) {
      if (names) assert.ok(entry.segments.every(segment => !segment.hex || /^(?:03|04)*$/.test(segment.hex)));
      const expected = names ? { offset: entry.offset, originalHex: entry.originalHex,
        translation: entry.segments.map(segment => segment.text ?? '').join('') } : entry;
      assert.deepEqual(entries.find(item => Number(item.offset) === Number(entry.offset)), expected);
    }
    for (const index of Object.keys(draft.records)) assert.ok(translated.has(`${Number(draft.pointerOffset)}:${index}`));
    checkedDraftRecords += compiled.entries.length;
  }
  const opening = read(path.join(root, 'translations/opening.zh-Hant.json'));
  draftRecords = catalog(source, manifest, opening).summary.translatedRecords - catalog(source, base, opening).summary.translatedRecords;
  assert.equal(draftRecords, plan.addedIndexedEntries);
  const oldBuild = read(path.join(root, baseDirectory, 'build.json'));
  const oldRom = fs.readFileSync(path.join(root, baseDirectory, oldBuild.romFilename));
  assert.equal(hash(oldRom), oldBuild.targetSha256);
  const realignment = plan.glyphAlignment === 'baseline';
  if (realignment) {
    assert.equal(manifest.glyphAlignment, 'baseline');
    assert.equal(metadata.glyphAlignment, 'baseline');
    assert.deepEqual(metadata.glyphs, oldBuild.glyphs);
    assert.deepEqual({ ...manifest, glyphAlignment: undefined }, { ...base, glyphAlignment: undefined });
    const unchanged = Buffer.from(target);
    for (const old of oldBuild.glyphs) oldRom.copy(unchanged, old.offset, old.offset, old.offset + 46);
    for (const [start, end] of [[0xffdc, 0xffe0], [0x3e0000, 0x3f0000]]) oldRom.copy(unchanged, start, start, end);
    assert.deepEqual(unchanged, oldRom, 'Non-font game data changed during realignment');
  }
  for (const old of oldBuild.glyphs) {
    const current = metadata.glyphs.find(glyph => glyph.character === old.character);
    assert.equal(current?.code, old.code, `Changed previous glyph code: ${old.character}`);
    if (!target.subarray(current.offset, current.offset + 46).equals(oldRom.subarray(old.offset, old.offset + 46))) {
      assert.ok(realignment, `Changed previous glyph bitmap: ${old.character}`);
      realignedGlyphs.push(old.character);
    }
  }
  previousGlyphCodesPreserved = oldBuild.glyphs.length;
  previousGlyphsPreserved = oldBuild.glyphs.length - realignedGlyphs.length;
}
const patch = fs.readFileSync(path.join(directory, 'opening-zh-Hant.ips'));
assert.equal(patch.subarray(0, 5).toString(), 'PATCH');
const restored = Buffer.alloc(target.length);
source.copy(restored);
let cursor = 5;
while (patch.subarray(cursor, cursor + 3).toString() !== 'EOF') {
  const offset = patch.readUIntBE(cursor, 3);
  const size = patch.readUInt16BE(cursor + 3);
  assert.ok(size > 0 && cursor + 5 + size <= patch.length && offset + size <= restored.length);
  patch.copy(restored, offset, cursor + 5, cursor + 5 + size);
  cursor += size + 5;
}
assert.equal(cursor + 3, patch.length);
assert.ok(restored.equals(target));
const report = { targetSha256: metadata.targetSha256, screenshots: audit?.screenshots.length,
  draftRecords: plan ? draftRecords : undefined, checkedDraftRecords: plan ? checkedDraftRecords : undefined, previousGlyphsPreserved,
  previousGlyphCodesPreserved, realignedGlyphs,
  screenshotMappings, checkedRecords, unchangedRecords, translatedRecords: translated.size,
  previousTranslationsPreserved: true, unselectedRecordsPreserved: true,
  inlineMenusVerified: [...inlineVerified], ipsRoundtripPassed: true, checksumPassed: true,
  nativeValidation: false };
fs.writeFileSync(path.join(directory, 'source-verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
