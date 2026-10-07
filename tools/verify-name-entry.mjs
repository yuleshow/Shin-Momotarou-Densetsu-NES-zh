import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function nameEntryContract(rom) {
  assert.equal(rom.subarray(0x5d176, 0x5d180).toString('hex'), 'ad5c19d00200ea226791');
  assert.equal(rom.subarray(0x5d569, 0x5d57c).toString('hex'), '20d3d5ac8419b98919ac8519970698209ed560');
  assert.equal(rom.subarray(0x5d5d3, 0x5d5ec).toString('hex'), 'daad5c193a0aaabfecd5858506bfedd5858507a97e8508fa60');
  return Array.from({ length: 12 }, (_, index) => {
    const mode = index + 1;
    const address = rom.readUInt16LE(0x5d5ec + index * 2);
    const capacity = rom[0x5d591 + mode];
    const katakana = Boolean(rom[0x5d603 + mode]);
    assert.ok(address >= 0x3d2b && address <= 0x5f4a);
    assert.ok(capacity === 4 || capacity === 5);
    return { mode, address, capacity, katakana };
  });
}

function verify() {
  const [runner, core, candidate, fixture, output] = process.argv.slice(2);
  assert.ok(output, 'Usage: verify-name-entry.mjs RUNNER CORE CANDIDATE FIELD_STATE NEW_OUTPUT');
  const metadata = JSON.parse(fs.readFileSync(path.join(candidate, 'build.json')));
  const baseline = fs.readFileSync(path.join(candidate, metadata.romFilename));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(baseline), metadata.targetSha256);
  const source = fs.readFileSync('assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc');
  assert.equal(digest(source), metadata.sourceSha256);
  const modes = nameEntryContract(source);
  assert.deepEqual(nameEntryContract(baseline), modes);
  assert.equal(baseline.subarray(0x1eee6, 0x1eeea).toString('hex'), '228ab385');
  assert.ok(baseline.subarray(0x23e000, 0x23e080).every(byte => byte === 255));
  const fixtureBytes = fs.readFileSync(fixture);
  fs.mkdirSync(output);
  const results = [];
  const run = (rom, directory, frames, inputs, state) => {
    const result = spawnSync(runner, [core, rom, directory, String(frames), inputs, state], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, MOMOTARO_CHEATS: '', MOMOTARO_TRACE: '', MOMOTARO_CAPTURE_EVERY: '60' },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return fs.readFileSync(path.join(directory, `wram-${frames}.bin`));
  };
  const ranges = [[0x3d2a, 0x3d69], [0x5f4a, 0x5f50]];
  for (const mode of modes) {
    const directory = path.join(output, `mode-${mode.mode}`);
    fs.mkdirSync(directory);
    const probe = Buffer.from(baseline);
    Buffer.from('5c00e0e3', 'hex').copy(probe, 0x1eee6);
    Buffer.concat([Buffer.from('228ab38522d4be83a9', 'hex'), Buffer.from([mode.mode]),
      Buffer.from('8d5c192276d1855c13ef81', 'hex')]).copy(probe, 0x23e000);
    probe.writeUInt16LE(65535, 0xffdc);
    probe.writeUInt16LE(0, 0xffde);
    const checksum = probe.reduce((sum, byte) => (sum + byte) & 65535, 0);
    probe.writeUInt16LE(checksum ^ 65535, 0xffdc);
    probe.writeUInt16LE(checksum, 0xffde);
    const romPath = path.join(directory, 'probe.sfc');
    fs.writeFileSync(romPath, probe, { flag: 'wx' });
    const openedPath = path.join(directory, 'opened');
    const opened = run(romPath, openedPath, 600, '30:3:a', fixture);
    assert.equal(opened[0x1984], 0);
    assert.equal(opened[0x1985], 0);
    const typedPath = path.join(directory, 'capacity');
    const typed = run(romPath, typedPath, 720,
      Array.from({ length: 10 }, (_, index) => `${30 + index * 60}:3:a`).join(','),
      path.join(openedPath, 'state.bin'));
    const samples = [];
    for (let frame = 60; frame <= 720; frame += 60) {
      const ram = fs.readFileSync(path.join(typedPath, `wram-${frame}.bin`));
      const written = Math.min(frame / 60, mode.capacity);
      assert.equal(ram[0x1985], Math.min(frame / 60, mode.capacity - 1));
      assert.ok(ram.subarray(mode.address, mode.address + written).every(byte => byte === 0x90));
      assert.equal(ram[mode.address + mode.capacity], opened[mode.address + mode.capacity]);
      for (const [start, end] of ranges) for (let address = start; address < end; address++) {
        if (address >= mode.address && address < mode.address + mode.capacity) continue;
        assert.equal(ram[address], opened[address], `Mode ${mode.mode} changed adjacent name at ${address.toString(16)}`);
      }
      samples.push({ frame, cursor: ram[0x1985], bytes: ram.subarray(mode.address, mode.address + mode.capacity + 1).toString('hex') });
    }
    const backPath = path.join(directory, 'back');
    const backed = run(romPath, backPath, 180, '30:3:b', path.join(typedPath, 'state.bin'));
    assert.equal(backed[0x1985], mode.capacity - 2);
    for (const [start, end] of ranges) assert.deepEqual(backed.subarray(start, end), typed.subarray(start, end));
    const confirmState = fs.readFileSync(path.join(backPath, 'state.bin'));
    const ramOffset = confirmState.indexOf('RAM:131072:') + 11;
    assert.ok(ramOffset > 11);
    confirmState[ramOffset + 0x1984] = 79;
    confirmState[ramOffset + mode.address] = 0;
    const confirmFixture = path.join(directory, 'confirm-fixture.bin');
    fs.writeFileSync(confirmFixture, confirmState, { flag: 'wx' });
    const confirmedPath = path.join(directory, 'confirmed');
    const confirmed = run(romPath, confirmedPath, 180, '30:3:a', confirmFixture);
    const expected = Buffer.from(typed);
    expected[mode.address] = 0x50;
    assert.equal(confirmed[mode.address], 0x50, 'Confirmation did not normalize the internal name gap');
    for (const [start, end] of ranges) assert.deepEqual(confirmed.subarray(start, end), expected.subarray(start, end));
    const restored = run(romPath, path.join(directory, 'restored'), 120, '', path.join(confirmedPath, 'state.bin'));
    for (const [start, end] of ranges) assert.deepEqual(restored.subarray(start, end), confirmed.subarray(start, end));
    results.push({ ...mode, samples, backMovesCursorWithoutUndo: true, adjacentNamesPreserved: true,
      confirmationNormalizesOnlySeededGap: true, emulatorStateReloadPreservesBytes: true });
    console.log(`PASS native name mode ${mode.mode}: ${mode.capacity} bytes, overflow, back, confirm and state reload`);
  }
  assert.ok(fs.readFileSync(fixture).equals(fixtureBytes));
  const report = { targetSha256: metadata.targetSha256, sourceSha256: metadata.sourceSha256,
    fixtureSha256: digest(fixtureBytes), originalFixtureUnchanged: true, modes: results,
    chineseInputImplemented: false, saveFileWrites: false, deviceWrites: false,
    limitations: [
      'Synthetic field-menu entry for each mode; not natural name-entry scene navigation or layout.',
      'Confirmation is selected with cursor 79 and one internal zero byte in a local state copy; the native finalizer must normalize that gap to a space. Natural movement to that key is not tested.',
      'Only fixed name ranges are compared; full gameplay RAM equality is not claimed.',
      'Emulator state reload is not in-game SRAM save/load verification.',
      'Native single-byte entry only; two-byte Chinese input, mixed old names and cancellation semantics remain unresolved.',
    ] };
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('PASS all 12 native name-storage contracts; no Chinese keyboard is shipped');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verify();