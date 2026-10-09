import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { encodeEnglishName, nativeSaveContract, readLegacySaveSlot } from './name-storage.mjs';

const [runner, core, candidate, fixtures, confirmation, output] = process.argv.slice(2);
assert.ok(output, 'Usage: verify-name-storage.mjs RUNNER CORE CANDIDATE NAME_FIXTURES CONFIRM_STATE NEW_OUTPUT');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = JSON.parse(fs.readFileSync(path.join(candidate, 'build.json')));
const target = fs.readFileSync(path.join(candidate, metadata.romFilename));
const source = fs.readFileSync(new URL('../assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc', import.meta.url));
assert.equal(hash(target), metadata.targetSha256);
assert.equal(hash(source), metadata.sourceSha256);
assert.deepEqual(target.subarray(0x58000, 0x58675), source.subarray(0x58000, 0x58675));
const contract = nativeSaveContract(source);
const persistent = contract.modes.filter(mode => mode.persistent);
const confirmed = fs.readFileSync(confirmation);
const originalPath = path.join(fixtures, 'mode-1', 'opened', 'state.bin');
const original = fs.readFileSync(originalPath);
const originalHash = hash(original), confirmationHash = hash(confirmed);
const ramTag = Buffer.from('RAM:131072:');
const sramTag = Buffer.from('SRA:524288:');
function section(state, tag) {
  const offset = state.indexOf(tag);
  assert.ok(offset > 0 && state.indexOf(tag, offset + 1) === -1, `Missing or ambiguous ${tag}`);
  return offset + tag.length;
}
const originalRam = section(original, ramTag);
const defaults = metadata.englishNameEntry?.chineseDefaults?.definitions;
const cases = ['english', 'mixed', 'legacy', ...(defaults ? ['preset'] : [])]
  .flatMap(kind => [1, 2, 3].map(slot => ({ kind, slot })));
const limit = Number(process.env.MOMOTARO_STORAGE_CASE_LIMIT ?? cases.length);
assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= cases.length);
fs.mkdirSync(output);

function probe(operation, slot, from = slot) {
  const rom = Buffer.from(target);
  assert.equal(rom.subarray(0x5d203, 0x5d207).toString('hex'), '2235ad80');
  assert.ok(rom.subarray(0x3ce380, 0x3ce3a0).every(byte => byte === 255));
  Buffer.from('2280e3fc', 'hex').copy(rom, 0x5d203);
  let helper = Buffer.from('2235ad80a9018d4a1122ee80856b', 'hex');
  helper[5] = slot;
  const address = { save: 0x8580ee, load: 0x858138, copy: 0x85822e, delete: 0x858079 }[operation];
  assert.ok(address);
  helper.writeUIntLE(address, 10, 3);
  if (operation === 'copy') {
    assert.equal(source.subarray(0x5822e, 0x58238).toString('hex'), '5adaaac220a93000852a');
    helper = Buffer.concat([helper.subarray(0, 9), Buffer.from([0xa9, from]), helper.subarray(9)]);
  }
  if (operation === 'delete') assert.equal(source.subarray(0x58079, 0x58082).toString('hex'), 'da20a780b026aaa900');
  helper.copy(rom, 0x3ce380);
  rom.writeUInt16LE(65535, 0xffdc);
  rom.writeUInt16LE(0, 0xffde);
  const checksum = rom.reduce((sum, byte) => (sum + byte) & 65535, 0);
  rom.writeUInt16LE(checksum ^ 65535, 0xffdc);
  rom.writeUInt16LE(checksum, 0xffde);
  const filename = path.join(output, operation === 'copy' ? `copy-${from}-to-${slot}.sfc` : `${operation}-${slot}.sfc`);
  fs.writeFileSync(filename, rom, { flag: 'wx' });
  return filename;
}
const probes = [1, 2, 3].map(slot => ({ save: probe('save', slot), load: probe('load', slot) }));
function run(filename, name, state) {
  const fixture = path.join(output, `${name}.state`);
  fs.writeFileSync(fixture, state, { flag: 'wx' });
  const directory = path.join(output, name);
  const env = { ...process.env, MOMOTARO_CHEATS: '', MOMOTARO_TRACE: '', MOMOTARO_CAPTURE_EVERY: '600' };
  delete env.MOMOTARO_SRAM_FILE;
  const result = spawnSync(runner, [core, filename, directory, '600', '30:3:a', fixture], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `${name}: ${result.stderr || result.error?.message}`);
  assert.ok(fs.existsSync(path.join(directory, 'frame-600.ppm')), `${name}: no video output`);
  return { ram: fs.readFileSync(path.join(directory, 'wram-600.bin')), sram: fs.readFileSync(path.join(directory, 'sram.bin')) };
}

const results = [];
for (const { kind, slot } of cases.slice(0, limit)) {
  const state = Buffer.from(confirmed);
  const ramStart = section(state, ramTag), sramStart = section(state, sramTag);
  assert.equal(state[ramStart + 0x195c], 1);
  assert.equal(state[ramStart + 0x1984], 79);
  const beforeSram = Buffer.from(state.subarray(sramStart, sramStart + contract.sramBytes));
  const names = persistent.map(mode => {
    const bytes = Buffer.from(original.subarray(originalRam + mode.legacyAddress, originalRam + mode.legacyAddress + mode.legacyBytes));
    const english = kind === 'english' || (kind === 'mixed' && mode.mode % 2 === 1);
    if (english) encodeEnglishName(`${String.fromCharCode(64 + mode.mode)}${mode.mode % 2 ? ' ' : 'Z'}${slot}${mode.mode % 10}`, mode).copy(bytes, Number(mode.katakana));
    if (kind === 'preset') {
      const definition = defaults.find(entry => entry.mode === mode.mode);
      assert.ok(definition);
      const token = Buffer.from(definition.tokenHex, 'hex');
      assert.equal(token.length, mode.capacity + 1);
      token.copy(bytes, Number(mode.katakana));
    }
    bytes.copy(state, ramStart + mode.legacyAddress);
    return { mode: mode.mode, english, bytes };
  });
  const saved = run(probes[slot - 1].save, `${kind}-${slot}-saved`, state);
  const decoded = readLegacySaveSlot(saved.sram, contract, slot);
  assert.equal(decoded.occupied, true);
  assert.equal(decoded.checksumValid, true);
  for (const name of names) assert.deepEqual(decoded.names.find(entry => entry.mode === name.mode).bytes, name.bytes, `${kind}/${slot}/mode${name.mode}: stored bytes`);
  for (const other of [1, 2, 3].filter(value => value !== slot)) {
    const start = contract.slotOffsets[other - 1];
    assert.deepEqual(saved.sram.subarray(start, start + contract.slotBytes), beforeSram.subarray(start, start + contract.slotBytes), 'Other save slot changed');
  }
  const tail = contract.slotOffsets[slot - 1] + contract.payloadBytes;
  assert.deepEqual(saved.sram.subarray(tail, contract.slotOffsets[slot - 1] + contract.slotBytes), beforeSram.subarray(tail, contract.slotOffsets[slot - 1] + contract.slotBytes), 'Unused slot extension changed');
  const loadState = Buffer.from(confirmed);
  saved.sram.copy(loadState, sramStart);
  for (const mode of persistent) encodeEnglishName('ZZZZ', mode).copy(loadState, ramStart + mode.address);
  const loaded = run(probes[slot - 1].load, `${kind}-${slot}-loaded`, loadState);
  for (const mode of persistent) assert.deepEqual(loaded.ram.subarray(mode.legacyAddress, mode.legacyAddress + mode.legacyBytes), names.find(entry => entry.mode === mode.mode).bytes, `${kind}/${slot}/mode${mode.mode}: loaded bytes`);
  assert.deepEqual(loaded.sram, saved.sram, 'Loading changed SRAM');
  results.push({ kind, slot, names: names.map(name => ({ mode: name.mode, english: name.english, hex: name.bytes.toString('hex') })), checksumValid: true, otherSlotsUnchanged: true, unusedExtensionUnchanged: true, loadedSramUnchanged: true });
  console.log(`PASS ${kind}, slot ${slot}: 11 native names saved and loaded, other slots unchanged`);
}
const copies = [], deletions = [], coldBoots = [];
if (limit === cases.length) {
  const ramStart = section(confirmed, ramTag), sramStart = section(confirmed, sramTag);
  for (const from of [1, 2, 3]) for (const to of [1, 2, 3].filter(slot => slot !== from)) {
    const sram = fs.readFileSync(path.join(output, `english-${from}-saved`, 'sram.bin'));
    const state = Buffer.from(confirmed);
    sram.copy(state, sramStart);
    const copied = run(probe('copy', to, from), `copy-${from}-to-${to}`, state);
    const expected = Buffer.from(sram);
    const sourceStart = contract.slotOffsets[from - 1], destination = contract.slotOffsets[to - 1];
    sram.subarray(sourceStart, sourceStart + contract.slotBytes).copy(expected, destination);
    expected.writeUInt16LE(sram.readUInt16LE(0x22 + from * 2), 0x22 + to * 2);
    expected[0x20 + to] = to;
    expected[0x20] = to;
    assert.deepEqual(copied.sram, expected, `Native copy ${from} to ${to} changed unexpected SRAM bytes`);
    assert.equal(readLegacySaveSlot(copied.sram, contract, to).checksumValid, true);
    const loadState = Buffer.from(confirmed);
    copied.sram.copy(loadState, sramStart);
    for (const mode of persistent) encodeEnglishName('ZZZZ', mode).copy(loadState, ramStart + mode.address);
    const loaded = run(probes[to - 1].load, `copy-${from}-to-${to}-loaded`, loadState);
    for (const name of results.find(result => result.kind === 'english' && result.slot === from).names) {
      const mode = persistent.find(mode => mode.mode === name.mode);
      assert.equal(loaded.ram.subarray(mode.legacyAddress, mode.legacyAddress + mode.legacyBytes).toString('hex'), name.hex);
    }
    assert.deepEqual(loaded.sram, copied.sram);
    copies.push({ from, to, allSramBytesMatched: true, loadedNamesVerified: 11 });
    console.log(`PASS native copy ${from} to ${to}: exact SRAM and 11 loaded names`);
  }
  let sram = fs.readFileSync(path.join(output, 'english-1-saved', 'sram.bin'));
  assert.deepEqual([...sram.subarray(0x21, 0x24)], [1, 2, 3]);
  for (const slot of [1, 2, 3]) {
    const state = Buffer.from(confirmed);
    sram.copy(state, sramStart);
    const deleted = run(probe('delete', slot), `delete-${slot}`, state);
    const expected = Buffer.from(sram);
    expected[0x20 + slot] = 0;
    if (expected[0x20] === slot) expected[0x20] = [1, 2, 3].find(index => expected[0x20 + index] === index) ?? 0;
    assert.deepEqual(deleted.sram, expected, `Native delete ${slot} changed unexpected SRAM bytes`);
    assert.equal(readLegacySaveSlot(deleted.sram, contract, slot).occupied, false);
    deletions.push({ slot, selectedAfter: expected[0x20], allSramBytesMatched: true, payloadPreserved: true });
    sram = deleted.sram;
    console.log(`PASS native delete ${slot}: occupancy cleared, selected slot ${expected[0x20]}, payload retained`);
  }
  for (const result of results) {
    const name = `${result.kind}-${result.slot}-cold`;
    const directory = path.join(output, name);
    const sramFile = path.resolve(output, `${result.kind}-${result.slot}-saved`, 'sram.bin');
    const before = fs.readFileSync(sramFile);
    const env = { ...process.env, MOMOTARO_CHEATS: '', MOMOTARO_TRACE: '', MOMOTARO_CAPTURE_EVERY: '3600', MOMOTARO_SRAM_FILE: sramFile };
    const execution = spawnSync(runner, [core, path.join(candidate, metadata.romFilename), directory, '3600', '30:3:start,1201:2:start,1450:3:a,1600:3:a'], { env, encoding: 'utf8', timeout: 120000 });
    assert.equal(execution.status, 0, `${name}: ${execution.stderr || execution.error?.message}`);
    const ram = fs.readFileSync(path.join(directory, 'wram-3600.bin'));
    assert.equal(ram[0x114a], result.slot, `${name}: wrong slot selected`);
    for (const entry of result.names) {
      const mode = persistent.find(mode => mode.mode === entry.mode);
      assert.equal(ram.subarray(mode.legacyAddress, mode.legacyAddress + mode.legacyBytes).toString('hex'), entry.hex, `${name}: mode ${mode.mode}`);
    }
    assert.deepEqual(fs.readFileSync(path.join(directory, 'sram.bin')), before, `${name}: cold loading changed SRAM`);
    assert.deepEqual(fs.readFileSync(sramFile), before, `${name}: input SRAM changed`);
    const frame = fs.readFileSync(path.join(directory, 'frame-3600.ppm'));
    const header = Buffer.from('P6\n256 224\n255\n');
    assert.deepEqual(frame.subarray(0, header.length), header);
    assert.equal(frame.length, header.length + 256 * 224 * 3);
    assert.ok(frame.subarray(header.length).filter(value => value > 32).length > 1000, `${name}: blank frame`);
    coldBoots.push({ kind: result.kind, slot: result.slot, loadedNamesVerified: 11, unhookedRom: true, sramUnchanged: true, inputSramSha256: hash(before), frameSha256: hash(frame) });
    console.log(`PASS cold boot ${result.kind}, slot ${result.slot}: 11 names, unhooked ROM, unchanged SRAM`);
  }
}
assert.equal(hash(fs.readFileSync(originalPath)), originalHash);
assert.equal(hash(fs.readFileSync(confirmation)), confirmationHash);
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ targetSha256: metadata.targetSha256,
  sourceSha256: metadata.sourceSha256, runnerSha256: hash(fs.readFileSync(runner)), coreSha256: hash(fs.readFileSync(core)),
  originalFixtureSha256: originalHash, confirmationFixtureSha256: confirmationHash, originalFixturesUnchanged: true,
  synthetic: true, nativeSaveLoadRoutinesUnchanged: true, sramBytes: contract.sramBytes, results,
  copies, deletions, coldBoots, deviceWrites: false, naturalSaveMenuVerified: false, coldBootVerified: coldBoots.length === cases.length,
  nativeCopyDeleteVerified: copies.length === 6 && deletions.length === 3,
  limitations: ['Names are seeded in copies of existing native editor fixtures, not entered through natural gameplay.',
    'Test-only confirmation hooks call original save/load/copy/delete routines; their natural save/copy/delete menus and visible legacy-name glyphs are not verified.',
    'Cold boots use the unmodified candidate and normal title/load-menu input, but the input SRAM was produced from synthetic fixtures with non-natural stats.',
    'Only name fields, slot checksums, other slots, unused extensions and load-time SRAM preservation are asserted.'] }, null, 2) + '\n', { flag: 'wx' });