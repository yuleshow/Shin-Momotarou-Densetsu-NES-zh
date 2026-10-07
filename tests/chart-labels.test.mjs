import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { commandChartLabels, familyChartLabels, patchCommandChart } from '../tools/chart-labels.mjs';
import { patchDefaultMonta, patchDefaultPochi, patchDefaultKiko } from '../tools/default-names.mjs';

const source = fs.readFileSync(new URL('../assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc', import.meta.url));
const characters = [...new Set(commandChartLabels.flatMap(label => [...label.text]))];
const fixture = () => {
  const target = Buffer.alloc(0x400000, 0xff);
  source.copy(target);
  return target;
};

test('command chart changes only its IDs, isolated lookup hooks and reserved space', () => {
  const target = fixture();
  const report = patchCommandChart(source, target, characters);
  assert.equal(report.cells.length, 44);
  assert.deepEqual(target.subarray(0x5c890, 0x5c928), source.subarray(0x5c890, 0x5c928));
  assert.deepEqual(target.subarray(0x70000, 0x70a0a), source.subarray(0x70000, 0x70a0a));
  const restored = Buffer.from(target);
  for (const write of report.writes) {
    const bytes = Buffer.from(write.hex, 'hex');
    assert.deepEqual(target.subarray(write.offset, write.offset + bytes.length), bytes);
    if (write.offset < source.length) source.copy(restored, write.offset, write.offset, write.offset + bytes.length);
    else restored.fill(0xff, write.offset, write.offset + bytes.length);
  }
  assert.deepEqual(restored, fixture());
  assert.equal(report.cells.filter(cell => cell.character === ' ').length, 3);
});

test('command chart rejects changed native coordinates, missing glyphs and occupied allocations', () => {
  const changed = Buffer.from(source);
  changed[0x5c809] ^= 1;
  assert.throws(() => patchCommandChart(changed, fixture(), characters));
  assert.throws(() => patchCommandChart(source, fixture(), []), /Missing chart glyph/);
  const occupied = fixture();
  occupied[0x3c2200] = 0;
  assert.throws(() => patchCommandChart(source, occupied, characters), /overlaps/);
});

test('default Monta patch guards its caller and leaves the stored default names untouched', () => {
  const target = fixture();
  const report = patchDefaultMonta(source, target, ['蒙', '太']);
  assert.equal(report.nameAddress, 0x7e3d3b);
  assert.equal(report.saveDataWritten, false);
  assert.deepEqual(target.subarray(0x4ade0, 0x4ae35), source.subarray(0x4ade0, 0x4ae35));
  assert.ok(report.writes[1].hex.length / 2 < 0x80);
  assert.throws(() => patchDefaultMonta(source, target, ['蒙', '太']), /overlaps/);
  const changed = Buffer.from(source);
  changed[0x4ae73] ^= 1;
  assert.throws(() => patchDefaultMonta(changed, fixture(), ['蒙', '太']));
});

test('optional Pochi display chains to the byte-identical Monta routine without changing stored names', () => {
  const metadata = JSON.parse(fs.readFileSync(new URL('../verification/residual-v55/build.json', import.meta.url)));
  const glyphs = metadata.glyphs.map(glyph => glyph.character);
  const target = fixture();
  const monta = patchDefaultMonta(source, target, glyphs);
  assert.deepEqual(monta, metadata.defaultMonta);
  const pochi = patchDefaultPochi(source, target, glyphs);
  assert.equal(pochi.originalHex, '04e7a000');
  assert.equal(pochi.nameAddress, 0x7e3d35);
  assert.equal(pochi.saveDataWritten, false);
  assert.ok(pochi.writes[1].hex.endsWith('5c8022fc'));
  assert.ok(pochi.writes[1].hex.length / 2 < 0x80);
  for (const write of monta.writes.slice(1)) {
    assert.equal(target.subarray(write.offset, write.offset + write.hex.length / 2).toString('hex'), write.hex);
  }
  assert.deepEqual(target.subarray(0x4ade0, 0x4ae35), source.subarray(0x4ade0, 0x4ae35));
  assert.throws(() => patchDefaultPochi(source, fixture(), glyphs), /requires the Monta/);
  const kiko = patchDefaultKiko(source, target, glyphs);
  assert.equal(kiko.originalHex, '0496809900');
  assert.equal(kiko.nameAddress, 0x7e3d41);
  assert.ok(kiko.writes[1].hex.endsWith('5c0023fc'));
  assert.ok(kiko.writes[1].hex.length / 2 < 0x80);
  for (const write of [...monta.writes, ...pochi.writes].filter(write => write.offset !== 0x4ae73)) {
    assert.equal(target.subarray(write.offset, write.offset + write.hex.length / 2).toString('hex'), write.hex);
  }
  assert.throws(() => patchDefaultKiko(source, fixture(), glyphs), /requires the Pochi/);
});

test('optional family chart isolates all 50 cells and preserves shared fragments and default-name space', () => {
  const glyphs = [...new Set([...characters, ...familyChartLabels.flatMap(label => [...label.text]), '蒙', '太'])];
  const target = fixture();
  const report = patchCommandChart(source, target, glyphs, { familyChart: true });
  assert.equal(report.cells.length, 44);
  assert.equal(report.familyCells.length, 50);
  assert.equal(report.otherChartUsesOriginalGroup, false);
  assert.deepEqual(target.subarray(0x70000, 0x70a0a), source.subarray(0x70000, 0x70a0a));
  for (const [index, cell] of report.familyCells.entries()) {
    assert.deepEqual([...target.subarray(0x5c890 + index * 3, 0x5c893 + index * 3)], [cell.x, cell.y, 45 + index]);
  }
  assert.deepEqual(target.subarray(0x5c926, 0x5c929), source.subarray(0x5c926, 0x5c929));
  const restored = Buffer.from(target);
  for (const write of report.writes) {
    const length = write.hex.length / 2;
    if (write.offset < source.length) source.copy(restored, write.offset, write.offset, write.offset + length);
    else restored.fill(0xff, write.offset, write.offset + length);
  }
  assert.deepEqual(restored, fixture());
  assert.doesNotThrow(() => patchDefaultMonta(source, target, glyphs));
  const changed = Buffer.from(source);
  changed[0x5c890] ^= 1;
  assert.throws(() => patchCommandChart(changed, fixture(), glyphs, { familyChart: true }));
  const occupied = fixture();
  occupied[0x3c2600] = 0;
  assert.throws(() => patchCommandChart(source, occupied, glyphs, { familyChart: true }), /overlaps/);
});

test('release gates require complete inherited family-chart and animal-name evidence', () => {
  const packager = fs.readFileSync(new URL('../tools/package-draft-release.mjs', import.meta.url), 'utf8');
  const start = packager.indexOf('if (manifest.commandChart || manifest.defaultMonta) {\n  const labels');
  const end = packager.indexOf('if (plan.nativeMenuFollowups) {', start);
  assert.ok(start > 0 && end > start);
  const metadata = JSON.parse(fs.readFileSync(new URL('../verification/default-animals-v56/build.json', import.meta.url)));
  const nameCases = names => names.map(name => ({ name, passed: true, nameRamUnchanged: true,
    outsideNamePixelsIdentical: true, translated: ['default', 'default-pochi', 'default-kiko'].includes(name) }));
  const evidence = {
    manifest: { commandChart: true, defaultMonta: true, defaultPochi: true, defaultKiko: true },
    metadata,
    checks: {
      'screenshot-labels': { fixtureUnchanged: true,
        commandChartCells: metadata.commandChart.cells.map(cell => ({ ...cell, rendered: true,
          code: cell.character === ' ' ? '50' : metadata.glyphs.find(glyph => glyph.character === cell.character).code })),
        outsideChartCellsUnchanged: true, familyChartCells: metadata.commandChart.familyCells,
        familyModeInitialized: true, outsideFamilyCellsUnchanged: true, otherChartPixelsIdentical: false,
        defaultNameCases: nameCases(['default', 'custom-suffix', 'custom-name', 'other-character']) },
      'animal-names': { fixtureUnchanged: true, defaultNameCases: nameCases([
        'default-pochi', 'custom-suffix', 'custom-name', 'other-character', 'default-monta',
        'default-kiko', 'kiko-custom-suffix', 'kiko-custom-name', 'kiko-other-character']) },
      'battle-status': { sourceFixturesAndRomsUnchanged: true,
        results: ['normal', 'poison', 'curse', 'paralysis', 'combined', 'injury', 'excellent', 'invincible'].map(name => ({
          name, exactNativeBattleFont: true, oldGlyphNegativeControlsPassed: true, otherGameplayBytesUnchanged: true })) },
    },
  };
  const validate = value => runInNewContext(`const { manifest, metadata, checks } = JSON.parse(payload);\n${packager.slice(start, end)}`,
    { assert, payload: JSON.stringify(value) });
  assert.doesNotThrow(() => validate(evidence));
  for (const alter of [
    value => value.checks['screenshot-labels'].familyChartCells.pop(),
    value => { value.checks['screenshot-labels'].outsideFamilyCellsUnchanged = false; },
    value => { value.checks['screenshot-labels'].otherChartPixelsIdentical = true; },
    value => value.checks['animal-names'].defaultNameCases.pop(),
    value => { value.checks['animal-names'].defaultNameCases[0].nameRamUnchanged = false; },
    value => { value.checks['animal-names'].defaultNameCases[1].translated = true; },
  ]) {
    const changed = structuredClone(evidence);
    alter(changed);
    assert.throws(() => validate(changed), { name: 'AssertionError' });
  }
});