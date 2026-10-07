import assert from 'node:assert/strict';

export const chineseGlyphCapacity = 3328;
export const fontPointerTable = 0x20f000;
export const fontBankTable = 0x20f100;

export function isGlyphPrefix(byte) {
  return (byte >= 0x18 && byte <= 0x1f) || (byte >= 0x24 && byte <= 0x2c);
}

export function chineseCode(index) {
  assert.ok(Number.isInteger(index) && index >= 0 && index < chineseGlyphCapacity, 'Chinese glyph index exceeds allocated font range');
  const code = 0x4c0 + index + (index >= 1088 ? 0x400 : 0);
  return [0x17 + (code >> 8), code & 255];
}

export function verifyGlyphExtension(current, previous) {
  assert.ok(previous.length > 0 && current.length >= previous.length, 'Previous glyphs were removed');
  assert.deepEqual(current.slice(0, previous.length), previous, 'Previous glyph codes or metadata changed');
}

// The native dispatcher compares the combined code before subtracting 0x100.
export const chineseDispatchMaximum = (() => {
  const [prefix, suffix] = chineseCode(chineseGlyphCapacity - 1);
  return ((prefix - 0x17) << 8) | suffix;
})();

export const fontDispatchCases = [[0, 1], ...[64, 320, 576, 832, 1088, 1344, 1600, 1856, 2112, 2176, 2240, 2304,
  2368, 2432, 2496, 2560, 2624, 2688, 2880, 3136]
  .map(index => [index - 1, index]), [2112, 2113], [chineseGlyphCapacity - 2, chineseGlyphCapacity - 1]];

export const fontDispatchControls = [
  { indexes: [2110, 2111], rendered: true, maximum: 0x10ff },
  { indexes: [2112, 2113], rendered: false, maximum: 0x10ff },
  { indexes: [2366, 2367], rendered: false, maximum: 0x10ff },
  { indexes: [2366, 2367], rendered: true, maximum: 0x11ff },
  { indexes: [2368, 2369], rendered: false, maximum: 0x11ff },
  { indexes: [3326, 3327], rendered: false, maximum: 0x11ff },
];

export function verifyFontDispatchReport(report) {
  assert.equal(report.dispatchMaximum, chineseDispatchMaximum, 'Stale font dispatch report');
  assert.deepEqual(report.cases.map(probe => probe.indexes), fontDispatchCases, 'Missing or duplicate font boundary probes');
  for (const probe of report.cases) {
    assert.deepEqual(probe.codes, probe.indexes.map(index => Buffer.from(chineseCode(index)).toString('hex')));
    assert.ok(probe.match, `Font boundary failed: ${probe.indexes}`);
  }
  assert.deepEqual(report.negativeControls.map(({ indexes, maximum, rendered }) => ({ indexes, maximum, rendered })),
    fontDispatchControls, 'Missing or incorrect stale-bound controls');
  for (const probe of report.negativeControls) assert.equal(Boolean(probe.match), probe.rendered);
}

export function chineseFontGroup(index) {
  chineseCode(index);
  const group = Math.floor(index / 64);
  const offset = group < 17 ? 0x240000 + group * 2945
    : group < 37 ? 0x300000 + (group - 17) * 2945
      : 0x255000 + (group - 37) * 2945;
  return { number: 23 + group + (group >= 17 ? 16 : 0), offset };
}

export function chineseGlyphOffset(index) {
  return chineseFontGroup(index).offset + 1 + index % 64 * 46;
}