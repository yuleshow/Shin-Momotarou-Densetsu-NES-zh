import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeHuffman, encodeHuffman, huffmanCodes } from './text-codec.mjs';
import { splitRecords } from './text-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [baselineDirectory, outputDirectory] = process.argv.slice(2);
assert.ok(baselineDirectory && outputDirectory, 'Usage: node tools/patch-biron-forest.mjs BASELINE_DIRECTORY NEW_OUTPUT_DIRECTORY');
const metadata = JSON.parse(fs.readFileSync(path.join(baselineDirectory, 'build.json')));
const original = fs.readFileSync(path.join(baselineDirectory, metadata.romFilename));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(digest(original), metadata.targetSha256);
assert.equal(metadata.targetSha256, 'b74ddb417f2cb5936c75c9046e21b731c3b8658788617a66deb2bf07d33f5a1e');
const manifest = JSON.parse(fs.readFileSync(metadata.manifestPath));
const block = metadata.textBlocks.find(entry => entry.name === 'screenshot-locations');
const compiled = manifest.textBlocks.find(entry => entry.name === block.name);
const draft = JSON.parse(fs.readFileSync(path.join(root, 'translations/screenshot-locations.draft.zh-Hant.json')));
assert.equal(draft.records[28], '比隆森林');
assert.deepEqual(compiled.entries[28].segments, [{ text: '伸長怪森林' }]);
const start = Number(block.relocatedOffset);
assert.equal(block.sourceType, 2);
assert.equal(original[start], 2);
assert.equal(original.readUIntLE(Number(compiled.pointerOffset), 3), start + 0xc00000);
const decoded = decodeHuffman(original, original.subarray(start + 1, start + block.storedBytes), block.decodedBytes).bytes;
const encode = text => Buffer.concat([...text].map(character => {
  const glyph = metadata.glyphs.find(entry => entry.character === character);
  assert.ok(glyph, `Missing existing glyph: ${character}`);
  return Buffer.from(glyph.code, 'hex');
}));
const oldName = encode('伸長怪森林');
const newName = encode(draft.records[28]);
const records = splitRecords(decoded);
assert.equal(records.length, 87);
const record = records[28];
assert.equal(record.originalHex, oldName.toString('hex'));
const replacement = Buffer.concat([decoded.subarray(0, record.decodedOffset), newName, decoded.subarray(record.decodedOffset + oldName.length)]);
const nextRecords = splitRecords(replacement);
assert.equal(nextRecords.length, records.length);
for (const [index, entry] of records.entries()) {
  assert.equal(nextRecords[index].originalHex, index === 28 ? newName.toString('hex') : entry.originalHex);
}
const stored = Buffer.concat([Buffer.from([2]), encodeHuffman(replacement, huffmanCodes(original)).bytes]);
assert.ok(stored.length <= block.storedBytes, 'Replacement exceeds the existing allocation');
assert.deepEqual(decodeHuffman(original, stored.subarray(1), replacement.length).bytes, replacement);
const target = Buffer.from(original);
target.fill(0xff, start, start + block.storedBytes);
stored.copy(target, start);
target.writeUInt16LE(0xffff, 0xffdc);
target.writeUInt16LE(0, 0xffde);
const checksum = target.reduce((sum, byte) => (sum + byte) & 0xffff, 0);
target.writeUInt16LE(checksum ^ 0xffff, 0xffdc);
target.writeUInt16LE(checksum, 0xffde);
const changedOffsets = [];
for (let offset = 0; offset < target.length; offset++) {
  if (target[offset] === original[offset]) continue;
  assert.ok((offset >= start && offset < start + block.storedBytes) || (offset >= 0xffdc && offset < 0xffe0));
  changedOffsets.push(offset);
}
compiled.entries[28].segments = [{ text: draft.records[28] }];
block.decodedBytes = replacement.length;
block.storedBytes = stored.length;
const baselineSha256 = metadata.targetSha256;
metadata.targetSha256 = digest(target);
metadata.checksum = checksum.toString(16);
metadata.manifestPath = path.resolve(outputDirectory, 'manifest.json');
metadata.bironForest = { baselineSha256, recordIndex: 28, name: draft.records[28] };
const report = {
  status: 'binary-verified-native-pending', baselineSha256, targetSha256: metadata.targetSha256,
  blockOffset: start, allocationBytes: 1059, storedBytes: stored.length,
  recordIndex: 28, previousName: '伸長怪森林', name: draft.records[28],
  unchangedOtherRecords: 86, changedBytes: changedOffsets.length,
  onlyLocationBlockAndChecksumChanged: true, glyphsAndCodeUnchanged: true,
  nativeVerified: false, deployed: false,
};
fs.mkdirSync(outputDirectory);
fs.writeFileSync(path.join(outputDirectory, metadata.romFilename), target, { flag: 'wx' });
fs.writeFileSync(metadata.manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(path.join(outputDirectory, 'build.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(path.join(outputDirectory, 'biron-verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));