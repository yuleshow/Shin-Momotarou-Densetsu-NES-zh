import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { patchCrystalList, crystalListAllocation } from './crystal-list.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [baselineDirectory, outputDirectory] = process.argv.slice(2);
assert.ok(baselineDirectory && outputDirectory, 'Usage: patch-crystal-list.mjs BASELINE_DIRECTORY NEW_OUTPUT_DIRECTORY');
const metadata = JSON.parse(fs.readFileSync(path.join(baselineDirectory, 'build.json')));
const manifest = JSON.parse(fs.readFileSync(metadata.manifestPath));
const baseline = fs.readFileSync(path.join(baselineDirectory, metadata.romFilename));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(baseline), metadata.targetSha256);
assert.ok(metadata.bironForest, 'Use the Biron-name candidate as the baseline');
const source = fs.readFileSync(path.join(root, 'assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc'));
const target = Buffer.from(baseline);
const field = manifest.textBlocks.find(block => block.name === 'field-messages');
const segments = field.entries.find(entry => Number(entry.offset) === 0x1cdc).segments;
metadata.crystalList = patchCrystalList(source, target, metadata.glyphs, segments);
target.writeUInt16LE(0xffff, 0xffdc);
target.writeUInt16LE(0, 0xffde);
const checksum = target.reduce((sum, byte) => (sum + byte) & 65535, 0);
target.writeUInt16LE(checksum ^ 65535, 0xffdc);
target.writeUInt16LE(checksum, 0xffde);
const { start, end, hook } = crystalListAllocation;
for (let offset = 0; offset < target.length; offset++) {
  if (target[offset] === baseline[offset]) continue;
  assert.ok((offset >= start && offset < end) || (offset >= hook && offset < hook + 4)
    || (offset >= 0xffdc && offset < 0xffe0));
}
metadata.crystalList.baselineSha256 = metadata.targetSha256;
metadata.targetSha256 = hash(target);
metadata.checksum = checksum.toString(16);
fs.mkdirSync(outputDirectory);
fs.writeFileSync(path.join(outputDirectory, metadata.romFilename), target, { flag: 'wx' });
fs.writeFileSync(path.join(outputDirectory, 'build.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ targetSha256: metadata.targetSha256, variants: metadata.crystalList.variants.length,
  onlyHookAllocationAndChecksumChanged: true }, null, 2));