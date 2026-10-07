import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileTextDraft, splitRecords } from './text-catalog.mjs';
import { chineseCode } from './chinese-font.mjs';
import { addInlineMenuData } from './inline-text.mjs';
import { decodeHuffman, decodeLz, encodeHuffman, encodeLzLiterals, huffmanCodes } from './text-codec.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = filename => JSON.parse(fs.readFileSync(path.join(root, filename)));
const source = fs.readFileSync(path.join(root, 'assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc'));
const planIndex = process.argv.indexOf('--plan');
const plan = planIndex < 0 ? null : read(process.argv[planIndex + 1]);
const baseDirectory = plan?.baseDirectory ?? 'opening-preview-v42-sumo-fix';
const base = read(`${baseDirectory}/resolved-translation-manifest.json`);
const manifest = structuredClone(base);
if (plan?.commandChart) manifest.commandChart = true;
if (plan?.familyChart) manifest.familyChart = true;
if (plan?.defaultMonta) manifest.defaultMonta = true;
if (plan?.defaultPochi) manifest.defaultPochi = true;
if (plan?.defaultKiko) manifest.defaultKiko = true;
const audit = plan ? null : read('translations/screenshot-review-20261003.json');
if (audit) {
  assert.equal(audit.screenshots.length, 108);
  assert.ok(audit.screenshots.every(entry => entry.reviewed));
}
assert.equal(manifest.textDrafts.length, 0);
const build = read(`${baseDirectory}/build.json`);
if (plan) manifest.glyphOrder = build.glyphs.map(glyph => glyph.character);
for (const change of plan?.inlineMenuPadding ?? []) {
  const entry = manifest.inlineMenus.find(menu => menu.name === change.name)?.entries.find(item => Number(item.offset) === Number(change.offset));
  assert.ok(entry, `Missing inline alignment entry: ${change.name}`);
  assert.ok(Number.isInteger(change.padding) && change.padding >= 0 && change.padding <= 8);
  entry.padding = change.padding;
}
const occupied = build.textBlocks.map(block => [
  Number(block.relocatedOffset), Number(block.relocatedOffset) + block.storedBytes,
]);
const additions = [];
function allocate(length) {
  for (let offset = 0x310000; offset + length <= 0x3c0000; offset += 0x100) {
    if ((offset & 0xffff) + length > 0x10000) continue;
    if (occupied.some(([start, end]) => offset < end && offset + length > start)) continue;
    occupied.push([offset, offset + length]);
    return `0x${offset.toString(16)}`;
  }
  assert.fail(`No bank-contained text allocation for ${length} bytes`);
}
function mergeEntries(destination, entries, context) {
  for (const entry of entries) {
    const existing = destination.find(item => Number(item.offset) === Number(entry.offset));
    if (existing) {
      assert.deepEqual(existing, entry, `Conflicting existing translation: ${context} ${entry.offset}`);
    } else {
      destination.push(entry);
      additions.push({ context, offset: entry.offset, originalHex: entry.originalHex });
    }
  }
  destination.sort((first, second) => Number(first.offset) - Number(second.offset));
}
const files = plan ? plan.drafts : [...new Set(audit.screenshots.map(entry => entry.translationFile).filter(Boolean)),
  'translations/screenshot-battle-status-escape.draft.zh-Hant.json',
  'translations/screenshot-yashahime-battle.draft.zh-Hant.json'];
for (const filename of files) {
  const draft = read(filename);
  const compiled = compileTextDraft(source, draft);
  if (draft.sourceRecords) {
    for (const [index, expected] of Object.entries(draft.sourceRecords)) {
      const actual = compiled.entries.find(entry => entry.offset === expected.offset);
      assert.ok(actual, `Raw source record missing: ${filename}:${index}`);
      assert.equal(actual.originalHex, expected.originalHex);
    }
  }
  const existing = manifest.textBlocks.find(block => Number(block.pointerOffset) === Number(compiled.pointerOffset));
  const names = manifest.nameBlocks.find(block => Number(block.pointerOffset) === Number(compiled.pointerOffset));
  if (Number(compiled.pointerOffset) === 0x70003) {
    mergeEntries(manifest.entries, compiled.entries, 'main-messages');
  } else if (names) {
    const entries = compiled.entries.map(entry => {
      assert.ok(entry.segments.every(segment => !segment.hex || /^(?:03|04)*$/.test(segment.hex)),
        `Name table has meaningful controls: ${filename}:${entry.offset}`);
      return { offset: entry.offset, originalHex: entry.originalHex,
        translation: entry.segments.map(segment => segment.text ?? '').join('') };
    });
    mergeEntries(names.entries, entries, names.name);
  } else if (existing) {
    mergeEntries(existing.entries, compiled.entries, existing.name);
    if (compiled.complete) existing.complete = true;
  } else {
    compiled.target = '0x0';
    manifest.textBlocks.push(compiled);
    additions.push(...compiled.entries.map(entry => ({ context: compiled.name, offset: entry.offset, originalHex: entry.originalHex })));
  }
}
let addedInlineMenus = 0;
addInlineMenuData(manifest.inlineMenus, plan?.inlineMenuAdditions ?? [], source);
for (const filename of plan?.inlineMenuFiles ?? []) {
  const additions = read(filename);
  assert.equal(additions.sourceSha256, base.sourceSha256);
  for (const menu of additions.inlineMenus) {
    assert.ok(!manifest.inlineMenus.some(existing => existing.name === menu.name), `Duplicate inline menu: ${menu.name}`);
    manifest.inlineMenus.push(menu);
    addedInlineMenus++;
  }
}
if (!plan) {
const inline = read('translations/screenshot-inline-animal-references.draft.zh-Hant.json');
const statLabels = read('translations/screenshot-stat-labels.draft.zh-Hant.json');
const compiledStatLabels = compileTextDraft(source, statLabels);
for (const record of Object.values(statLabels.sourceRecords)) {
  assert.equal(compiledStatLabels.entries.find(entry => entry.offset === record.offset)?.originalHex, record.originalHex);
}
mergeEntries(manifest.entries, compiledStatLabels.entries, 'main-messages');
for (const block of inline.indexedNames) {
  assert.equal(Number(block.pointerOffset), 0x70003);
  const records = splitRecords(source.subarray(Number(block.sourceStart) + 1, Number(block.sourceEnd)));
  for (const entry of block.entries) {
    const record = records[entry.recordIndex];
    assert.equal(record.originalHex, entry.originalHex);
    assert.equal(Number(block.sourceStart) + 1 + record.decodedOffset, Number(entry.offset));
  }
  mergeEntries(manifest.entries, block.entries.map(({ offset, originalHex, segments }) =>
    ({ offset, originalHex, segments })), 'main-messages');
}
const inlinePath = 'translations/screenshot-inline-menus.release.json';
assert.ok(fs.existsSync(path.join(root, inlinePath)), 'Inline menu integration must be ready before preparing release');
const menus = read(inlinePath);
for (const menu of menus.inlineMenus) {
  assert.ok(!manifest.inlineMenus.some(existing => existing.name === menu.name));
  manifest.inlineMenus.push(menu);
}
addedInlineMenus = menus.inlineMenus.length;
}
const opening = read('translations/opening.zh-Hant.json');
const sections = [opening, ...(opening.continuation ?? [])];
const characters = [...new Set([
  ...(manifest.glyphOrder ?? []),
  ...manifest.entries.flatMap(entry => entry.segments
    ? entry.segments.flatMap(segment => [...(segment.text ?? '')]) : [...entry.translation]),
  ...sections.flatMap(section => section.segments.flatMap(segment => [...(segment.text ?? '')])),
  ...manifest.inlineMenus.flatMap(menu => menu.entries.flatMap(entry => [...entry.translation])),
  ...manifest.nameBlocks.flatMap(block => block.entries.flatMap(entry => [...entry.translation])),
  ...manifest.textBlocks.flatMap(block => block.entries.flatMap(entry => entry.segments.flatMap(segment => [...(segment.text ?? '')]))),
])];
const encode = segments => Buffer.concat(segments.map(segment => segment.hex
  ? Buffer.from(segment.hex, 'hex')
  : Buffer.from([...segment.text].flatMap(character => chineseCode(characters.indexOf(character))))));
const codes = huffmanCodes(source);
const sizes = manifest.textBlocks.map(block => {
  const pointer = Number(block.pointerOffset);
  const start = source.readUIntLE(pointer, 3) - 0xc00000;
  const end = source.readUIntLE(pointer + 3, 3) - 0xc00000;
  const type = source[start];
  const raw = type === 0 ? source.subarray(start, end) : Buffer.concat([Buffer.from([0]), type === 1
    ? decodeLz(source.subarray(start + 1, end)).bytes
    : decodeHuffman(source, source.subarray(start + 1, end), block.decodedBytes).bytes]);
  const fragments = [];
  let cursor = 0;
  for (const entry of block.entries) {
    const offset = Number(entry.offset) + (type === 0 ? -start : 1);
    assert.ok(offset >= cursor);
    assert.equal(raw.subarray(offset, offset + entry.originalHex.length / 2).toString('hex'), entry.originalHex);
    fragments.push(raw.subarray(cursor, offset), encode(entry.segments));
    cursor = offset + entry.originalHex.length / 2;
  }
  fragments.push(raw.subarray(cursor));
  const data = Buffer.concat(fragments);
  return type === 0 ? data.length : 1 + (type === 1
    ? encodeLzLiterals(data.subarray(1)).length : encodeHuffman(data.subarray(1), codes).bytes.length);
});
occupied.splice(0, occupied.length, ...manifest.textBlocks.map((block, index) =>
  [Number(block.target), Number(block.target) + sizes[index]]));
const resizedAllocations = [];
for (const [index, block] of manifest.textBlocks.entries()) {
  const [start, end] = occupied[index];
  const overlaps = occupied.some(([otherStart, otherEnd], otherIndex) =>
    otherIndex !== index && start < otherEnd && end > otherStart);
  if (start === 0 || overlaps || (start & 0xffff) + sizes[index] > 0x10000) {
    occupied[index] = [0, 0];
    const previous = block.target;
    block.target = allocate(sizes[index]);
    occupied[index] = occupied.pop();
    resizedAllocations.push({ name: block.name, previous, target: block.target, storedBytes: sizes[index] });
  }
}
for (const old of base.textBlocks) {
  const current = manifest.textBlocks.find(block => block.name === old.name);
  for (const entry of old.entries) {
    assert.deepEqual(current.entries.find(item => item.offset === entry.offset), entry);
  }
}
assert.equal(manifest.inlineMenus.find(menu => menu.name === 'sumo-techniques').end, '0x2e927');
if (plan) {
  assert.equal(additions.length, plan.addedIndexedEntries);
  for (const old of base.entries) assert.deepEqual(manifest.entries.find(entry => entry.offset === old.offset), old);
  for (const old of base.nameBlocks) {
    const current = manifest.nameBlocks.find(block => block.name === old.name);
    assert.equal(current.target, old.target);
    for (const entry of old.entries) assert.deepEqual(current.entries.find(item => item.offset === entry.offset), entry);
  }
  const expectedMenus = structuredClone(base.inlineMenus);
  addInlineMenuData(expectedMenus, plan.inlineMenuAdditions ?? [], source);
  for (const filename of plan.inlineMenuFiles ?? []) expectedMenus.push(...read(filename).inlineMenus);
  for (const change of plan.inlineMenuPadding ?? []) {
    expectedMenus.find(menu => menu.name === change.name).entries.find(entry => Number(entry.offset) === Number(change.offset)).padding = change.padding;
  }
  assert.deepEqual(manifest.inlineMenus, expectedMenus);
}
const output = path.join(root, plan?.manifest ?? 'translations/screenshots-v44.release.json');
fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', { flag: process.argv.includes('--replace-generated') ? 'w' : 'wx' });
console.log(JSON.stringify({ output, screenshots: audit?.screenshots.length, addedIndexedEntries: additions.length,
  glyphs: characters.length, resizedAllocations,
  addedInlineMenus, previousTranslationsPreserved: true,
  newBlocks: manifest.textBlocks.slice(base.textBlocks.length).map(block => ({
    name: block.name, target: block.target, entries: block.entries.length,
  })) }, null, 2));
