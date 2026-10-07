import assert from 'node:assert/strict';
import test from 'node:test';
import { chineseCode, chineseDispatchMaximum, fontDispatchCases, fontDispatchControls,
  verifyFontDispatchReport, verifyGlyphExtension } from '../tools/chinese-font.mjs';

const match = { frame: 'frame-1020.ppm', x: 32, y: 80 };
test('glyph regression accepts append-only extensions but rejects changes to existing codes', () => {
  const previous = [{ character: '甲', code: '1bc0', offset: 0x240001 }, { character: '乙', code: '1bc1', offset: 0x24002f }];
  verifyGlyphExtension(structuredClone(previous), previous);
  verifyGlyphExtension([...previous, { character: '丙', code: '1bc2', offset: 0x24005d }], previous);
  assert.throws(() => verifyGlyphExtension(previous.slice(0, 1), previous), /removed/);
  assert.throws(() => verifyGlyphExtension([...previous].reverse(), previous), /metadata changed/);
  for (const field of ['character', 'code', 'offset']) {
    const changed = structuredClone(previous);
    changed[0][field] = changed[1][field];
    assert.throws(() => verifyGlyphExtension(changed, previous), /metadata changed/);
  }
  assert.throws(() => verifyGlyphExtension(previous, []), /removed/);
});

const fixture = () => ({
  dispatchMaximum: chineseDispatchMaximum,
  cases: fontDispatchCases.map(indexes => ({ indexes: [...indexes],
    codes: indexes.map(index => Buffer.from(chineseCode(index)).toString('hex')), match: { ...match } })),
  negativeControls: fontDispatchControls.map(probe => ({ ...structuredClone(probe), match: probe.rendered ? { ...match } : null })),
});

test('font release gate accepts all expanded boundaries and stale-bound controls', () => {
  assert.equal(fontDispatchCases.length, 23);
  assert.equal(fontDispatchControls.length, 6);
  assert.deepEqual(fontDispatchCases.at(-1), [3326, 3327]);
  assert.ok(fontDispatchCases.some(indexes => indexes[0] === 2367 && indexes[1] === 2368));
  assert.equal(chineseDispatchMaximum, 0x15bf);
  verifyFontDispatchReport(fixture());
});

test('font release gate rejects the old 2368-glyph report', () => {
  const report = fixture();
  report.dispatchMaximum = 0x11ff;
  assert.throws(() => verifyFontDispatchReport(report), /Stale font dispatch/);
});

test('font release gate rejects missing or duplicated probes even with successful matches', () => {
  const missing = fixture();
  missing.cases = missing.cases.slice(0, 15);
  assert.throws(() => verifyFontDispatchReport(missing), /boundary probes/);
  const duplicated = fixture();
  duplicated.cases[13] = structuredClone(duplicated.cases[0]);
  assert.throws(() => verifyFontDispatchReport(duplicated), /boundary probes/);
});

test('font release gate rejects incorrect codes and missing positive pixel matches', () => {
  const report = fixture();
  report.cases.at(-1).codes[1] = '2cb0';
  assert.throws(() => verifyFontDispatchReport(report));
  const missing = fixture();
  missing.cases.at(-1).match = null;
  assert.throws(() => verifyFontDispatchReport(missing), /Font boundary failed/);
});

test('font release gate checks every old limit and its expected result', () => {
  for (const mutate of [
    report => report.negativeControls.pop(),
    report => { report.negativeControls[4].maximum = 0x15bf; },
    report => { report.negativeControls[4].rendered = true; },
    report => { report.negativeControls[4].indexes = [0, 1]; },
  ]) {
    const report = fixture();
    mutate(report);
    assert.throws(() => verifyFontDispatchReport(report), /stale-bound controls/);
  }
});

test('font release gate rejects contradictory control pixel evidence', () => {
  const unexpected = fixture();
  unexpected.negativeControls[4].match = { ...match };
  assert.throws(() => verifyFontDispatchReport(unexpected));
  const missing = fixture();
  missing.negativeControls[3].match = null;
  assert.throws(() => verifyFontDispatchReport(missing));
});