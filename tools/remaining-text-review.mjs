import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { catalog } from './text-catalog.mjs';
import { isGlyphPrefix } from './chinese-font.mjs';

export function dictionaryReferences(bytes) {
  const references = [];
  for (let offset = 0; offset < bytes.length; offset++) {
    const byte = bytes[offset];
    if (isGlyphPrefix(byte)) {
      assert.ok(offset + 1 < bytes.length, 'Truncated glyph');
      offset++;
    } else if (byte === 2) {
      assert.ok(offset + 1 < bytes.length, 'Truncated dictionary reference');
      const reference = bytes[++offset];
      if (reference >= 0xa0 && reference <= 0xd9) references.push(reference - 0xa0);
    }
  }
  return references;
}

function remainingWorkKind(block, record, blocks) {
  const pointer = block.pointerOffset;
  const bytes = Buffer.from(record.originalHex, 'hex');
  if ([...bytes].every(byte => byte < 0x18)) return 'preserve-dynamic-controls';
  if (pointer === '0x7002a' && record.index < 36) {
    assert.equal(bytes.length, 1);
    assert.equal(bytes[0], record.index < 10 ? 0x51 + record.index : 0x61 + record.index - 10);
    return 'preserve-alphanumeric';
  }
  const reserveTables = new Map([
    ['0x70015', '0x7001e'], ['0x70018', '0x70021'],
    ['0x7001e', '0x7001e'], ['0x70021', '0x70021'],
  ]);
  if (reserveTables.has(pointer)) {
    const readings = blocks.find(table => table.pointerOffset === reserveTables.get(pointer));
    assert.ok(readings, `Missing paired readings: ${pointer}`);
    if (readings.records[record.index]?.originalHex === 'b5df') return 'preserve-reserved-slot';
  }
  if (pointer === '0x70033') return 'input-system-review';
  if (pointer === '0x70036') return 'preserve-credit-attribution';
  if (['0x7019e', '0x701a4'].includes(pointer)) return 'preserve-fictional-language';
  if (pointer === '0x70000') return 'shared-fragment-caller-review';
  if (pointer === '0x70009') return 'name-and-caller-review';
  if (['0x70045', '0x70048'].includes(pointer)) return 'diagnostic-caller-review';
  return 'label-and-caller-review';
}

export function reviewRemainingText(rom, manifest, opening) {
  const source = catalog(rom, manifest, opening);
  assert.equal(source.summary.reviewBlocks, 0);
  const sourceReferences = new Map();
  const retainedReferences = new Map();
  for (const block of source.blocks) for (const record of block.records) {
    const caller = { pointerOffset: block.pointerOffset, index: record.index, status: record.status };
    const original = Buffer.from(record.originalHex, 'hex');
    for (const index of new Set(dictionaryReferences(original))) {
      const references = sourceReferences.get(index) ?? [];
      references.push(caller);
      sourceReferences.set(index, references);
    }
    const effective = record.status === 'untranslated' ? original
      : Buffer.concat((record.segments ?? []).map(segment => Buffer.from(segment.hex ?? '', 'hex')));
    for (const index of new Set(dictionaryReferences(effective))) {
      const references = retainedReferences.get(index) ?? [];
      references.push(caller);
      retainedReferences.set(index, references);
    }
  }
  const callerTables = new Set(['0x70000', '0x70003', '0x70009']);
  const tables = source.blocks.map(block => ({
    pointerOffset: block.pointerOffset,
    name: block.name,
    disposition: callerTables.has(block.pointerOffset) ? 'caller-review' : 'preserve-or-technical-review',
    records: block.records.filter(record => record.status === 'untranslated').map(record => ({
      index: record.index,
      originalHex: record.originalHex,
      workKind: remainingWorkKind(block, record, source.blocks),
      sourceOffset: block.sourceType === 0 ? Number(block.sourceStart) + 1 + record.decodedOffset : undefined,
      ...(block.pointerOffset === '0x70000' ? {
        sourceIndexedCallers: sourceReferences.get(record.index) ?? [],
        retainedIndexedCallers: retainedReferences.get(record.index) ?? [],
        runtimeCallersVerified: false,
      } : {}),
    })),
  })).filter(table => table.records.length);
  const workKinds = {};
  for (const table of tables) for (const record of table.records) {
    workKinds[record.workKind] = (workKinds[record.workKind] ?? 0) + 1;
  }
  assert.equal(Object.values(workKinds).reduce((total, count) => total + count, 0), source.summary.untranslatedRecords);
  return {
    sourceSha256: source.sourceSha256,
    summary: source.summary,
    callerReviewRecords: tables.filter(table => table.disposition === 'caller-review').reduce((count, table) => count + table.records.length, 0),
    otherRecords: tables.filter(table => table.disposition !== 'caller-review').reduce((count, table) => count + table.records.length, 0),
    workKinds,
    completeTranslation: false,
    limitations: [
      'Zero indexed callers does not prove a record is unused: native code, inline scripts and dynamic references need separate review.',
      'Opening-script references and references introduced outside indexed segments are not included in retainedIndexedCallers.',
      'Preserved records include symbols, names, input mappings and reserved data, not only untranslated prose.',
      'Work kinds are review dispositions, not additional translated records or proof that a runtime caller is unreachable.',
      'Input-system-review requires matching displayed keys, emitted bytes and saved-name decoding; changing labels alone is insufficient.',
    ],
    tables,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifestFile, output] = process.argv.slice(2);
  assert.ok(output, 'Usage: remaining-text-review.mjs MANIFEST NEW_REPORT');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = filename => JSON.parse(fs.readFileSync(filename));
  const report = reviewRemainingText(fs.readFileSync(path.join(root, 'assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc')),
    read(manifestFile), read(path.join(root, 'translations/opening.zh-Hant.json')));
  report.manifestSha256 = createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex');
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ ...report.summary, callerReviewRecords: report.callerReviewRecords, otherRecords: report.otherRecords,
    workKinds: report.workKinds, output }, null, 2));
}