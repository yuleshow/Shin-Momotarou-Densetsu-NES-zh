import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { encodeGlyph } from '../tools/font-codec.mjs';

const font = process.env.MOMOTARO_TEST_FONT ?? '/tmp/momotaro-NotoSansCJKtc-Regular.otf';
const source = fs.readFileSync(new URL('../tools/build-menu-patch.mjs', import.meta.url), 'utf8');
const renderSource = source.slice(source.indexOf('function renderGlyph('), source.indexOf('\nfunction validTextAllocation('));
function render(character, alignment) {
  let pixels;
  const renderGlyph = vm.runInNewContext(`${renderSource}\nrenderGlyph`, {
    assert, spawnSync, Uint8Array, manifest: { glyphAlignment: alignment },
    encodeGlyph: (value, ...args) => { pixels = value; return encodeGlyph(value, ...args); },
  });
  const encoded = renderGlyph(character, font);
  const rows = Array.from({ length: 16 }, (_, row) => row).filter(row => pixels.slice(row * 12, (row + 1) * 12).some(pixel => pixel & 2));
  return { encoded, rows, pixels };
}

test('fixed font baseline preserves ideograph position and restores short glyph alignment', { skip: !fs.existsSync(font) }, () => {
  assert.deepEqual(render('桃', 'baseline').encoded, render('桃').encoded);
  assert.deepEqual(render('一').rows, [2]);
  assert.deepEqual(render('一', 'baseline').rows, [7]);
  assert.deepEqual(render('一', 'baseline').encoded, render('\u2500', 'baseline').encoded);
  for (const character of ['，', '、', '。']) {
    assert.equal(render(character).rows[0], 2);
    const corrected = render(character, 'baseline');
    assert.ok(corrected.rows[0] >= 6 && corrected.rows.at(-1) <= 10, character);
  }
  assert.deepEqual(render(',', 'baseline').rows, [11, 12, 13, 14]);
  for (const character of ['末', '！', '？', '「', '」']) {
    const corrected = render(character, 'baseline');
    assert.ok(corrected.rows.length > 0 && corrected.rows[0] >= 1 && corrected.rows.at(-1) <= 15, character);
  }
});

test('every released punctuation and symbol retains all ink at a fixed baseline', { skip: !fs.existsSync(font) }, () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../translations/followup-v49.release.json', import.meta.url)));
  const punctuation = [...manifest.glyphOrder].filter(character => /[\p{Punctuation}\p{Symbol}]/u.test(character));
  assert.equal(punctuation.filter(character => /\p{Punctuation}/u.test(character)).length, 20);
  assert.equal(new Set(punctuation).size, 24);
  for (const character of punctuation) {
    const corrected = render(character, 'baseline');
    const reference = spawnSync('magick', ['-size', '32x40', 'xc:black', '-font', font, '-pointsize', '12',
      '-fill', 'white', '-gravity', 'None', '-draw', `text 8,21 '${character}'`, '-colorspace', 'gray', '-depth', '8', 'gray:-']);
    assert.equal(reference.status, 0, reference.stderr.toString());
    let ink = 0;
    for (let row = 0; row < 40; row++) for (let column = 0; column < 32; column++) {
      if (reference.stdout[row * 32 + column] < 80) continue;
      ink++;
      assert.ok(row >= 9 && row < 24 && column >= 8 && column < 20, `Clipped punctuation: ${character} at ${column - 8},${row - 8}`);
      assert.ok(corrected.pixels[(row - 8) * 12 + column - 8] & 2, `Lost punctuation ink: ${character}`);
    }
    assert.equal(corrected.pixels.filter(pixel => pixel & 2).length, ink, character);
  }
});