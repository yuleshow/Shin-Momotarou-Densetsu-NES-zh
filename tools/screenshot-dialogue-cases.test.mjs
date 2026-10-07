import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compileTextDraft, splitRecords } from './text-catalog.mjs';
import { screenshotDialogueCases } from './screenshot-dialogue-cases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = filename => JSON.parse(fs.readFileSync(path.join(root, filename)));
const original = fs.readFileSync(path.join(root, 'assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc'));
const review = read('translations/screenshot-review-20261003.json');

function fixture() {
  const manifest = read('translations/menu.zh-Hant.json');
  manifest.textBlocks.push(...manifest.textDrafts.map(filename => compileTextDraft(original, read(`translations/${filename}`))));
  for (const filename of new Set([...review.screenshots.map(item => item.translationFile).filter(Boolean), ...review.supplementalFiles])) {
    const draft = read(filename);
    if (!draft.records) continue;
    const block = compileTextDraft(original, draft);
    const existing = manifest.textBlocks.find(item => Number(item.pointerOffset) === Number(block.pointerOffset));
    if (!existing) manifest.textBlocks.push(block);
    else for (const entry of block.entries) {
      const index = existing.entries.findIndex(item => Number(item.offset) === Number(entry.offset));
      if (index < 0) existing.entries.push(entry);
      else existing.entries[index] = entry;
    }
  }
  // Mapping tests need synthetic labels, not a built/released candidate.
  const records = splitRecords(original.subarray(0x704f3, 0x70a0a));
  for (const index of [12, 13, 14, 126, 131]) {
    const record = records[index], offset = 0x704f3 + record.decodedOffset;
    if (!manifest.entries.some(entry => Number(entry.offset) === offset)) {
      manifest.entries.push({ offset, originalHex: record.originalHex, segments: [{ text: '測試' }] });
    }
  }
  manifest.textBlocks.push({ name: 'main-messages', pointerOffset: '0x70003', entries: manifest.entries });
  const metadata = { sourceSha256: review.sourceSha256, textBlocks: manifest.textBlocks.map(block => {
    const pointer = Number(block.pointerOffset);
    const sourceStart = original.readUIntLE(pointer, 3) - 0xc00000;
    return { name: block.name, sourceStart, sourceEnd: original.readUIntLE(pointer + 3, 3) - 0xc00000,
      sourceType: original[sourceStart] };
  }) };
  return { manifest, metadata };
}

test('every screenshot mapping is covered, skipped explicitly, or delegated to the inline verifier', () => {
  const { manifest, metadata } = fixture();
  const { cases, coverage } = screenshotDialogueCases(root, original, manifest, metadata);
  const covered = new Set([...cases.flatMap(scene => scene.screenshotIds),
    ...coverage.skipped.map(item => item.screenshotId), ...coverage.external.map(item => item.screenshotId)]);
  assert.deepEqual([...covered].sort((a, b) => a - b), review.screenshots.map(item => item.id).sort((a, b) => a - b));
  assert.equal(new Set(cases.map(scene => `${scene.name}:${scene.firstIndex}`)).size, cases.length);
  for (const screenshot of review.screenshots.filter(item => item.translationFile)) {
    const draft = read(screenshot.translationFile);
    for (const index of screenshot.records) assert.ok(cases.some(scene => Number(scene.pointerOffset) === Number(draft.pointerOffset)
      && scene.firstIndex === index && scene.screenshotIds.includes(screenshot.id)));
  }
  const yashahime = cases.filter(scene => scene.pointerOffset === '0x70051');
  assert.deepEqual(yashahime.map(scene => scene.firstIndex).sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index));
  assert.ok(yashahime.find(scene => scene.firstIndex === 17).words.includes('帶我一起走吧'));
  const court = cases.filter(scene => scene.name === 'vajra-court-deceptions');
  for (const index of [4, 6, 7, 8, 9]) assert.ok(court.some(scene => scene.firstIndex === index));
  assert.ok(cases.some(scene => scene.pointerOffset === '0x7004b' && scene.firstIndex === 86 && scene.screenshotIds.includes(90)));
  for (const index of [12, 13, 14]) assert.ok(cases.some(scene => scene.pointerOffset === '0x70003' && scene.firstIndex === index));
  assert.deepEqual(coverage.skipped.map(item => item.screenshotId), [6, 9, 18, 26, 31, 34]);
});

test('missing screenshot block fails instead of silently dropping mappings', () => {
  const { manifest, metadata } = fixture();
  const pointer = Number(read(review.screenshots[0].translationFile).pointerOffset);
  const start = original.readUIntLE(pointer, 3) - 0xc00000;
  metadata.textBlocks = metadata.textBlocks.filter(block => block.sourceStart !== start);
  assert.throws(() => screenshotDialogueCases(root, original, manifest, metadata), /Screenshot block missing/);
});

test('draft release plan covers all 112 Hope Capital records without unrelated screenshots', () => {
  const plan = read('translations/hope-capital-v45.plan.json');
  const manifest = read(plan.manifest);
  const metadata = { sourceSha256: manifest.sourceSha256, textBlocks: manifest.textBlocks.map(block => {
    const pointer = Number(block.pointerOffset);
    const sourceStart = original.readUIntLE(pointer, 3) - 0xc00000;
    return { name: block.name, sourceStart, sourceEnd: original.readUIntLE(pointer + 3, 3) - 0xc00000,
      sourceType: original[sourceStart] };
  }) };
  const result = screenshotDialogueCases(root, original, manifest, metadata, plan.drafts);
  assert.equal(result.cases.length, plan.addedIndexedEntries);
  assert.equal(new Set(result.cases.map(scene => scene.name)).size, 7);
  assert.ok(result.cases.every(scene => scene.screenshotIds.length === 0));
  for (const filename of plan.drafts) {
    const draft = read(filename);
    assert.deepEqual(result.cases.filter(scene => scene.name === draft.name).map(scene => scene.firstIndex),
      Object.keys(draft.records).map(Number));
  }
  metadata.textBlocks = metadata.textBlocks.filter(block => block.name !== 'hope-capital-temple');
  assert.throws(() => screenshotDialogueCases(root, original, manifest, metadata, plan.drafts), /Screenshot block missing/);
});

test('name-table drafts map to their original indexes for native probes', () => {
  const manifest = read('translations/remaining-v47.release.json');
  const plan = read('translations/remaining-v47.plan.json');
  const draftFiles = plan.drafts.filter(filename => {
    const draft = read(filename);
    return manifest.nameBlocks.some(block => Number(block.pointerOffset) === Number(draft.pointerOffset));
  });
  assert.ok(draftFiles.length > 0);
  const metadata = { sourceSha256: manifest.sourceSha256, textBlocks: [],
    nameBlocks: manifest.nameBlocks.map(block => {
      const pointer = Number(block.pointerOffset);
      const sourceStart = original.readUIntLE(pointer, 3) - 0xc00000;
      return { name: block.name, sourceStart, sourceEnd: original.readUIntLE(pointer + 3, 3) - 0xc00000,
        sourceType: original[sourceStart] };
    }) };
  const { cases } = screenshotDialogueCases(root, original, manifest, metadata, draftFiles);
  for (const filename of draftFiles) {
    const draft = read(filename);
    assert.deepEqual(cases.filter(scene => Number(scene.pointerOffset) === Number(draft.pointerOffset))
      .map(scene => scene.firstIndex), Object.keys(draft.records).map(Number));
  }
  assert.ok(cases.every(scene => scene.words.length > 0));
  metadata.nameBlocks = [];
  assert.throws(() => screenshotDialogueCases(root, original, manifest, metadata, draftFiles), /Screenshot block missing/);
});

test('native reading expectations include translated dictionary prefixes', () => {
  const filenames = ['shared-dictionary-remaining', 'item-readings-remaining', 'equipment-readings-remaining']
    .map(name => `translations/${name}.draft.zh-Hant.json`);
  const manifest = { textBlocks: filenames.map(filename => compileTextDraft(original, read(filename))) };
  const metadata = { sourceSha256: review.sourceSha256, textBlocks: manifest.textBlocks.map(block => {
    const pointer = Number(block.pointerOffset);
    const sourceStart = original.readUIntLE(pointer, 3) - 0xc00000;
    return { name: block.name, sourceStart, sourceEnd: original.readUIntLE(pointer + 3, 3) - 0xc00000,
      sourceType: original[sourceStart] };
  }) };
  const { cases } = screenshotDialogueCases(root, original, manifest, metadata, filenames.slice(1));
  assert.deepEqual(cases.find(scene => scene.pointerOffset === '0x7001e' && scene.firstIndex === 155).words, ['勇氣之鏡']);
  assert.deepEqual(cases.find(scene => scene.pointerOffset === '0x70021' && scene.firstIndex === 59).words, ['正義魚叉']);
  assert.deepEqual(cases.find(scene => scene.pointerOffset === '0x70021' && scene.firstIndex === 216).words, ['勇氣頭盔']);
});

test('punctuation around a dynamic name still produces native pixel targets', () => {
  const filename = 'translations/karura-epilogue.draft.zh-Hant.json';
  const definition = compileTextDraft(original, read(filename));
  const pointer = Number(definition.pointerOffset);
  const sourceStart = original.readUIntLE(pointer, 3) - 0xc00000;
  const metadata = { sourceSha256: review.sourceSha256, textBlocks: [{ name: definition.name,
    sourceStart, sourceEnd: original.readUIntLE(pointer + 3, 3) - 0xc00000, sourceType: original[sourceStart] }] };
  const { cases } = screenshotDialogueCases(root, original, { textBlocks: [definition] }, metadata, [filename]);
  assert.deepEqual(cases.find(scene => scene.firstIndex === 25).words, ['「', '！」']);
});
