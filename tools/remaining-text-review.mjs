import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { catalog, splitRecords } from './text-catalog.mjs';
import { isGlyphPrefix } from './chinese-font.mjs';
import { commandChartLabels, familyChartLabels, patchCommandChart } from './chart-labels.mjs';
import { patchDefaultMonta, patchDefaultPochi, patchDefaultKiko } from './default-names.mjs';

export function reviewDefaultNameCallers(source, target, characters) {
  const expected = Buffer.alloc(target.length, 0xff);
  source.copy(expected);
  const definitions = [patchDefaultMonta, patchDefaultPochi, patchDefaultKiko].map(patch => patch(source, expected, characters));
  const writes = new Map(definitions.flatMap(definition => definition.writes.map(write => [write.offset, write.hex])));
  for (const [offset, hex] of writes) {
    assert.equal(target.subarray(offset, offset + hex.length / 2).toString('hex'), hex,
      `Default-name display hook differs at ${offset.toString(16)}`);
  }
  assert.equal(source.subarray(0x4ae06, 0x4ae18).toString('hex'), '04e7a000000004b2bd9f0000049680990000');
  assert.deepEqual(target.subarray(0x4ae06, 0x4ae18), source.subarray(0x4ae06, 0x4ae18));
  assert.deepEqual(target.subarray(0x4ae7e, 0x4aeb1), source.subarray(0x4ae7e, 0x4aeb1));
  return definitions.map(definition => {
    const dispatchIndex = [0x7e3d41, 0x7e3d3b, 0x7e3d35].indexOf(definition.nameAddress);
    assert.equal(source[0x4ae89 + dispatchIndex], 4);
    assert.equal(source.readUIntLE(0x4ae94 + dispatchIndex * 3, 3), definition.nameAddress);
    return { pointerOffset: '0x70009', index: source[0x4ae7e + dispatchIndex] - 1,
      disposition: 'preserve-fallback-known-dynamic-default-localized', label: definition.label,
      nameAddress: definition.nameAddress, originalHex: definition.originalHex,
      knownDisplayHookVerified: true, initialNamesUnchanged: true, allNativeCallersVerified: false,
      countedAsNewTranslation: false };
  }).sort((first, second) => first.index - second.index);
}

export function reviewChartFragmentCallers(source, target, characters) {
  const expected = Buffer.alloc(target.length, 0xff);
  source.copy(expected);
  const chart = patchCommandChart(source, expected, characters, { familyChart: true });
  for (const write of chart.writes) {
    const bytes = Buffer.from(write.hex, 'hex');
    assert.deepEqual(target.subarray(write.offset, write.offset + bytes.length), bytes,
      `Released chart differs at ${write.offset.toString(16)}`);
  }
  const labels = [...commandChartLabels, ...familyChartLabels];
  const indexes = [...new Set(labels.flatMap(label => label.indexes))].sort((first, second) => first - second);
  assert.deepEqual(indexes, Array.from({ length: 64 }, (_, index) => index + 36));
  return indexes.map(index => ({ pointerOffset: '0x70003', index,
    disposition: 'preserve-shared-source-known-chart-callers-localized',
    localizedLabels: labels.filter(label => label.indexes.includes(index)).map(label => label.text.trim()),
    knownChartWritesVerified: true, allNativeCallersVerified: false, countedAsNewTranslation: false }));
}

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

export function reviewResidualFragmentCallers(source, target, manifest, opening, inventory, metadata) {
  const review = reviewRemainingText(source, manifest, opening);
  const dictionary = review.tables.find(table => table.pointerOffset === '0x70000');
  const records = [];
  for (const [pointerOffset, entries] of Object.entries(inventory.fragmentsNeedingCallerReview)) {
    const table = review.tables.find(table => table.pointerOffset === pointerOffset);
    assert.ok(table, `Missing residual table: ${pointerOffset}`);
    const start = target.readUIntLE(Number(pointerOffset), 3) - 0xc00000;
    assert.ok(start >= 0 && start < target.length && target[start] === 0, 'Residual table must use raw indexed records');
    const sourceStart = source.readUIntLE(Number(pointerOffset), 3) - 0xc00000;
    const block = [...(metadata?.nameBlocks ?? []), ...(metadata?.textBlocks ?? [])]
      .find(block => Number(block.sourceStart) === sourceStart && Number(block.relocatedOffset) === start);
    const commonMenu = pointerOffset === '0x70003' && start === 0x210000;
    assert.ok(start === sourceStart || block || commonMenu, 'Relocated residual table requires exact build metadata');
    let end = block ? start + 1 + block.decodedBytes : source.readUIntLE(Number(pointerOffset) + 3, 3) - 0xc00000;
    if (commonMenu) {
      assert.equal(sourceStart, 0x704f2);
      assert.equal(end, 0x70a0a);
      end = start + end - sourceStart + manifest.entries.reduce((difference, entry) => {
        const replacementBytes = entry.segments
          ? entry.segments.reduce((length, segment) => length + (segment.hex ? segment.hex.length / 2 : [...segment.text].length * 2), 0)
          : [...entry.translation].length * 2;
        return difference + replacementBytes - entry.originalHex.length / 2;
      }, 0);
    }
    const current = splitRecords(target.subarray(start + 1, end));
    for (const [index, text] of Object.entries(entries)) {
      const record = table.records.find(record => record.index === Number(index));
      assert.ok(record, `Residual record is no longer unselected: ${pointerOffset}:${index}`);
      assert.equal(current[record.index].originalHex, record.originalHex, 'Preserved residual fragment changed');
      const visited = new Set();
      const roots = new Map();
      const visit = fragment => {
        if (visited.has(fragment.index)) return;
        visited.add(fragment.index);
        for (const caller of fragment.retainedIndexedCallers ?? []) {
          if (caller.pointerOffset !== '0x70000') roots.set(`${caller.pointerOffset}:${caller.index}`, caller);
          else {
            const parent = dictionary.records.find(entry => entry.index === caller.index);
            assert.ok(parent, 'Translated dictionary caller requires explicit effective-record tracing');
            visit(parent);
          }
        }
      };
      if (pointerOffset === '0x70000') visit(record);
      records.push({ pointerOffset, index: record.index, source: text, originalHex: record.originalHex,
        disposition: pointerOffset === '0x70000' ? 'preserve-fragment-indexed-callers-reviewed' : 'preserve-label-direct-callers-pending',
        sourceIndexedCallerCount: record.sourceIndexedCallers?.length,
        retainedIndexedCallers: record.retainedIndexedCallers,
        retainedNonDictionaryRoots: pointerOffset === '0x70000' ? [...roots.values()] : undefined,
        preservedBytesVerified: true, nativeDirectCallersVerified: false, countedAsNewTranslation: false });
    }
  }
  assert.equal(records.length, 23);
  return { status: 'indexed-callers-reviewed-native-direct-callers-pending', records,
    completeTranslation: false, countedAsNewTranslation: false,
    limitations: ['Retained indexed roots include nested dictionary references, but exclude native-generated strings, inline scripts and opening-script references.',
      'No retained indexed root does not establish that a fragment is globally unused. Original bytes remain preserved.'] };
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