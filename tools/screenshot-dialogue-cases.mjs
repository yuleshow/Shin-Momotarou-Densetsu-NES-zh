import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeHuffman, decodeLz } from './text-codec.mjs';
import { splitRecords } from './text-catalog.mjs';

export function screenshotDialogueCases(root, original, manifest, metadata, draftFiles) {
  const review = draftFiles ? { sourceSha256: metadata.sourceSha256, screenshots: [], supplementalFiles: draftFiles }
    : JSON.parse(fs.readFileSync(path.join(root, 'translations/screenshot-review-20261003.json')));
  assert.equal(review.sourceSha256, metadata.sourceSha256);
  const cases = new Map();
  const skipped = [];
  const external = [];
  const dynamicLabelLimitations = [];
  const drafts = new Map();
  const dictionary = new Map();
  const dictionaryDefinition = manifest.textBlocks.find(block => Number(block.pointerOffset) === 0x70000);
  if (dictionaryDefinition) {
    const start = original.readUIntLE(0x70000, 3) - 0xc00000;
    const end = original.readUIntLE(0x70003, 3) - 0xc00000;
    for (const record of splitRecords(original.subarray(start + 1, end))) {
      const entry = dictionaryDefinition.entries.find(item => Number(item.offset) === start + 1 + record.decodedOffset);
      if (entry) dictionary.set(record.index + 0xa0, entry.segments ?? [{ text: entry.translation }]);
    }
  }
  function visibleText(segments, visiting = new Set()) {
    return segments.map(segment => {
      if (segment.text !== undefined) return segment.text;
      const bytes = Buffer.from(segment.hex, 'hex');
      let text = '';
      for (let cursor = 0; cursor < bytes.length; cursor++) {
        const byte = bytes[cursor];
        if (byte === 2) {
          const reference = bytes[++cursor];
          if (!dictionary.has(reference)) text += '\n';
          else {
            assert.ok(!visiting.has(reference), 'Cyclic screenshot dictionary reference');
            text += visibleText(dictionary.get(reference), new Set([...visiting, reference]));
          }
        } else if (byte !== 3 && byte !== 4) text += '\n';
      }
      return text;
    }).join('');
  }
  const readDraft = filename => {
    if (!drafts.has(filename)) drafts.set(filename, JSON.parse(fs.readFileSync(path.join(root, filename))));
    return drafts.get(filename);
  };
  function add(pointer, index, screenshotId, filename, reason) {
    const sourceStart = original.readUIntLE(Number(pointer), 3) - 0xc00000;
    const block = [...metadata.textBlocks, ...(metadata.nameBlocks ?? [])].find(item => item.sourceStart === sourceStart);
    assert.ok(block, `Screenshot block missing: ${pointer}:${index}`);
    const definition = [...manifest.textBlocks, ...(manifest.nameBlocks ?? [])].find(item => item.name === block.name);
    assert.ok(definition, `Screenshot manifest block missing: ${block.name}`);
    const bytes = original.subarray(block.sourceStart + 1, block.sourceEnd);
    const records = splitRecords(block.sourceType === 2 ? decodeHuffman(original, bytes, definition.decodedBytes).bytes
      : block.sourceType === 1 ? decodeLz(bytes).bytes : bytes);
    const record = records[index];
    assert.ok(record, `Screenshot source record missing: ${pointer}:${index}`);
    const offset = record.decodedOffset + (block.sourceType === 0 ? block.sourceStart + 1 : 0);
    const entry = definition.entries.find(item => Number(item.offset) === offset);
    assert.ok(entry, `Screenshot translation missing: ${block.name}:${index}`);
    assert.equal(entry.originalHex, record.originalHex);
    const key = `${block.name}:${index}`;
    if (!cases.has(key)) {
      // Every visible clause is checked, including intermediate pages in long scenes.
      const segments = entry.segments ?? [{ text: entry.translation }];
      const text = visibleText(segments);
      const phrases = text.split(/[，。！：？「」〈〉（）…、─\s]+/u).filter(Boolean);
      const words = [...new Set(phrases.length ? phrases : text.split(/\s+/u).filter(Boolean))];
      assert.ok(words.length, `No screenshot text: ${key}`);
      const controls = segments.flatMap(segment => segment.hex ? [...Buffer.from(segment.hex, 'hex')] : []);
      const lines = controls.filter(byte => byte === 1).length;
      const pauses = controls.filter(byte => byte === 15 || byte === 11).length;
      cases.set(key, { name: block.name, firstIndex: index, words,
        frames: Math.max(1620, (Math.ceil((lines + 1) / 3) + pauses + 2) * 600 + 1800),
        pointerOffset: `0x${Number(pointer).toString(16)}`, screenshotIds: [], mappings: [] });
    }
    const scene = cases.get(key);
    if (screenshotId !== undefined && !scene.screenshotIds.includes(screenshotId)) scene.screenshotIds.push(screenshotId);
    scene.mappings.push({ file: filename, reason, ...(screenshotId !== undefined ? { screenshotId } : {}) });
  }
  for (const screenshot of review.screenshots) {
    let mapped = false;
    if (screenshot.translationFile) {
      const draft = readDraft(screenshot.translationFile);
      for (const index of screenshot.records) {
        add(draft.pointerOffset, index, screenshot.id, screenshot.translationFile, 'reviewed candidate');
        mapped = true;
      }
    }
    for (const reference of screenshot.supplementalReferences ?? []) {
      if (reference.record !== undefined) {
        add(reference.pointerOffset, reference.record, screenshot.id, reference.file,
          reference.ambiguous ? 'ambiguous candidate' : 'supplemental record');
        mapped = true;
      } else {
        assert.ok(reference.menu, `Unknown supplemental screenshot reference: ${screenshot.id}`);
        external.push({ screenshotId: screenshot.id, ...reference, reason: 'inline-menu verifier owns this mapping' });
        mapped = true;
      }
    }
    if (!mapped) {
      assert.match(screenshot.note, /already|overlay|saved|Chinese|中文/i,
        `Unaccounted screenshot: ${screenshot.id}`);
      skipped.push({ screenshotId: screenshot.id, reason: screenshot.note });
    }
  }
  // Also cover the complete tightly coupled supplemental battle section, not just pictured responses.
  for (const filename of review.supplementalFiles ?? []) {
    const draft = readDraft(filename);
    if (draft.records) for (const index of Object.keys(draft.records)) {
      add(draft.pointerOffset, Number(index), undefined, filename, 'supplemental section');
    }
    for (const block of draft.indexedNames ?? []) for (const entry of block.entries) {
      add(block.pointerOffset, entry.recordIndex, undefined, filename, 'supplemental indexed label');
    }
  }
  if (!draftFiles) {
  // The ambiguous attack-drop alternative and dynamic labels/sentences are separate records.
  for (const [pointer, index, screenshotId, reason] of [
    [0x7004b, 86, 90, 'other ambiguous attack-drop candidate'],
    [0x70039, 35, 24, 'dynamic animal sentence'],
    [0x70039, 36, 25, 'dynamic animal sentence'],
  ]) add(pointer, index, screenshotId, 'translations/screenshot-review-20261003.json', reason);
  const mainStart = original.readUIntLE(0x70003, 3) - 0xc00000;
  const mainEnd = original.readUIntLE(0x70006, 3) - 0xc00000;
  const mainRecords = splitRecords(original.subarray(mainStart + 1, mainEnd));
  for (const [index, screenshotId, label] of [[12, 20, 'attack'], [13, 87, 'defense'], [14, undefined, 'speed']]) {
    if (manifest.entries.some(entry => Number(entry.offset) === mainStart + 1 + mainRecords[index].decodedOffset)) {
      add(0x70003, index, screenshotId, 'translations/screenshot-review-20261003.json', `dynamic ${label} label`);
    } else dynamicLabelLimitations.push({ pointerOffset: '0x70003', record: index, label,
      reason: 'Untranslated in candidate; static prose probes do not certify this runtime-inserted label.' });
  }
  for (const name of ['hidden-passage-training', 'prince-and-mirror-hints']) {
    const definition = manifest.textBlocks.find(block => block.name === name);
    assert.ok(definition, `Missing allocation regression block: ${name}`);
    add(definition.pointerOffset, 0, undefined, 'release allocation regression', 'Huffman neighbor/relocation regression');
  }
  }
  return { cases: [...cases.values()], coverage: { reviewedScreenshots: review.screenshots.length, skipped, external, dynamicLabelLimitations } };
}
