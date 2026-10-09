import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { addInlineMenuData, encodeInlineLabel } from '../tools/inline-text.mjs';

const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc', root));
const menus = JSON.parse(fs.readFileSync(new URL('translations/screenshot-workshop-menus.json', root))).inlineMenus;
const build = JSON.parse(fs.readFileSync(new URL('verification/followup-v51/build.json', root)));
const glyphCode = character => {
  const glyph = build.glyphs.find(entry => entry.character === character);
  return glyph && Buffer.from(glyph.code, 'hex');
};

test('shop follow-up and recipient headings preserve source, party fields and both entry points', () => {
  const plan = JSON.parse(fs.readFileSync(new URL('translations/shop-followup-v60.plan.json', root)));
  const baseline = JSON.parse(fs.readFileSync(new URL('verification/quiz-menus-v59/resolved-translation-manifest.json', root)));
  const changed = structuredClone(baseline.inlineMenus);
  addInlineMenuData(changed, plan.inlineMenuAdditions, source);
  assert.equal(encodeInlineLabel(plan.inlineMenuAdditions[0].entries[0], glyphCode).toString('hex'), '1ecd1bd0');
  const menu = JSON.parse(fs.readFileSync(new URL('translations/recipient-menu.json', root))).inlineMenus[0];
  for (const reference of [menu, ...menu.alternatePointers]) {
    assert.equal(source.readUInt16LE(Number(reference.pointerOperand)), (Number(menu.start) + (reference.skip ?? 0)) & 65535);
    assert.equal(source[Number(reference.bankOperand)], 0x85);
  }
  assert.equal(source.subarray(0x5bc2a, 0x5bc2e).toString('hex'), menu.entries[0].originalHex);
  assert.equal(encodeInlineLabel(menu.entries[0], glyphCode).toString('hex'), '1c8b1c77');
  assert.equal(source.subarray(Number(menu.end) - 13, Number(menu.end)).toString('hex'), `00${menu.trailerHex}`);
  assert.equal(source.subarray(0x5bc1c, 0x5bc24).toString('hex'), '334dbd853847bd85');
});

test('restaurant cancellation preserves dish fields, prices and native callback', () => {
  const menu = JSON.parse(fs.readFileSync(new URL('translations/restaurant-menu.json', root))).inlineMenus[0];
  assert.equal(source.readUInt16LE(Number(menu.pointerOperand)), Number(menu.start) & 65535);
  assert.equal(source[Number(menu.bankOperand)], 0x83);
  assert.equal(source.readUIntLE(Number(menu.start) + 4, 3), 0x83cb69);
  const original = source.subarray(Number(menu.start), Number(menu.end));
  const trailer = Buffer.from(menu.trailerHex, 'hex');
  assert.deepEqual(original.subarray(-trailer.length), trailer);
  assert.equal(original[original.length - trailer.length - 1], 0);
  const entry = menu.entries[0], offset = Number(entry.offset) - Number(menu.start);
  assert.equal(entry.translation, '取消');
  assert.equal(original.subarray(offset, offset + 3).toString('hex'), entry.originalHex);
  const translated = Buffer.concat([original.subarray(0, offset), encodeInlineLabel(entry, glyphCode), original.subarray(offset + 3)]);
  assert.equal(translated.length, original.length + 1);
  assert.deepEqual(translated.subarray(0, offset), original.subarray(0, offset));
  assert.deepEqual(translated.subarray(offset + 4), original.subarray(offset + 3));
  assert.equal(source.subarray(Number(menu.end), Number(menu.end) + 6).toString('hex'), 'ade4123a8d65');
});

test('recipient party-size probes clear only trailing party slots and are opt-in', () => {
  const verifier = fs.readFileSync(new URL('tools/verify-workshop-menus.mjs', root), 'utf8');
  const start = verifier.indexOf('    const partySetup = ');
  const end = verifier.indexOf('\n    Buffer.concat([Buffer.from', start);
  assert.ok(start >= 0 && end > start);
  for (const partySize of [1, 2, 3, 4]) {
    const run = enabled => runInNewContext(`${verifier.slice(start, end)}; partySetup`, {
      Buffer, recipientPartySizes: enabled, ammunition: partySize,
    });
    assert.equal(run(false).length, 0);
    const bytes = run(true);
    assert.equal(bytes.length, (4 - partySize) * 3);
    for (let offset = 0; offset < bytes.length; offset += 3) {
      assert.equal(bytes[offset], 0x9c);
      assert.equal(bytes.readUInt16LE(offset + 1), 0x1569 + partySize + offset / 3);
    }
  }
});

test('quiz headings preserve native answer references, score field and selection callback', () => {
  const definition = JSON.parse(fs.readFileSync(new URL('translations/quiz-menus.json', root)));
  assert.equal(definition.inlineMenus.length, 3);
  for (const menu of definition.inlineMenus) {
    assert.equal(source.readUInt16LE(Number(menu.pointerOperand)), Number(menu.start) & 65535, menu.name);
    assert.equal(source[Number(menu.bankOperand)], 0x85, menu.name);
    const trailer = Buffer.from(menu.trailerHex, 'hex');
    assert.equal(source[Number(menu.end) - trailer.length - 1], 0, menu.name);
    assert.deepEqual(source.subarray(Number(menu.end) - trailer.length, Number(menu.end)), trailer, menu.name);
    const entry = menu.entries[0];
    assert.equal(source.subarray(Number(entry.offset), Number(entry.offset) + entry.originalHex.length / 2).toString('hex'), entry.originalHex);
    assert.equal(encodeInlineLabel(entry, glyphCode).length, 4);
  }
  for (const menu of definition.inlineMenus.slice(0, 2)) {
    assert.equal(source.readUIntLE(Number(menu.start) + 2, 3), 0x85dd21);
  }
  assert.equal(source.subarray(0x5dd21, 0x5dd2b).toString('hex'), 'ade4128d57195c0db084');
});

test('quiz RAM exception accepts only the guarded 19/76 event selector difference', () => {
  const verifier = fs.readFileSync(new URL('tools/verify-quiz-menus.mjs', root), 'utf8');
  const start = verifier.indexOf('function compareGameData(');
  const end = verifier.indexOf('\nconst report = ', start);
  assert.ok(start >= 0 && end > start);
  const compare = runInNewContext(`${verifier.slice(start, end)}; compareGameData`, { assert, source });
  const original = Buffer.alloc(0x2000);
  const changed = Buffer.from(original);
  changed[0x1882] = 7;
  assert.throws(() => compare(original, changed));
  original[0x1882] = 0x19;
  assert.throws(() => compare(original, changed));
  changed[0x1882] = 0x76;
  assert.doesNotThrow(() => compare(original, changed));
  assert.doesNotThrow(() => compare(changed, original));
  for (const address of [0x151d, 0x160b, 0x180a, 0x1880, 0x1881, 0x1883, 0x193f]) {
    const corrupted = Buffer.from(original);
    corrupted[address] = 1;
    assert.throws(() => compare(original, corrupted));
  }
  const badSource = Buffer.from(source);
  badSource[0x1b45b] ^= 1;
  const wrongLookup = runInNewContext(`${verifier.slice(start, end)}; compareGameData`, { assert, source: badSource });
  assert.throws(() => wrongLookup(original, changed));
});

test('quiz verifier rejects unknown or duplicated coverage flags before reading inputs', () => {
  for (const options of [['--unknown'], ['--all-questions', '--all-questions']]) {
    const result = spawnSync(process.execPath, [new URL('tools/verify-quiz-menus.mjs', root).pathname,
      'missing-runner', 'missing-core', 'missing-candidate', 'missing-baseline', 'missing-fixture', 'missing-output', ...options],
    { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid quiz verification option/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
});

test('castle battle labels preserve the complete native descriptor and action callbacks', () => {
  const menu = JSON.parse(fs.readFileSync(new URL('translations/castle-battle-menu.json', root))).inlineMenus[0];
  assert.equal(source.readUInt16LE(Number(menu.pointerOperand)), Number(menu.start) & 65535);
  assert.equal(source[Number(menu.bankOperand)], 0x82);
  const original = source.subarray(Number(menu.start), Number(menu.end));
  assert.equal(original.toString('hex'), '320101346de382384ff182213e1ac31a190126391980213e18401a202c01213e19be1a315050213e1a1dd3b80100');
  const fragments = [];
  let cursor = 0;
  for (const entry of menu.entries) {
    const offset = Number(entry.offset) - Number(menu.start);
    assert.equal(original.subarray(offset, offset + 4).toString('hex'), entry.originalHex);
    const bytes = encodeInlineLabel(entry, glyphCode);
    assert.equal(bytes.length, 4);
    fragments.push(original.subarray(cursor, offset), bytes, Buffer.alloc(entry.padding ?? 0, 0x50));
    cursor = offset + 4;
  }
  fragments.push(original.subarray(cursor));
  assert.equal(Buffer.concat(fragments).toString('hex'), '320101346de382384ff182213e1f111bc10126391980213e18401a202c01213e19be1a315050213e1d2f1d3050500100');
  assert.equal(source.subarray(Number(menu.end), Number(menu.end) + 3).toString('hex'), '9c8519');
});

test('castle ammunition label retains the name and complete numeric field trailer', () => {
  const menu = JSON.parse(fs.readFileSync(new URL('translations/castle-battle-menu.json', root))).inlineMenus[1];
  assert.equal(source.readUInt16LE(Number(menu.pointerOperand)), Number(menu.start) & 65535);
  assert.equal(source[Number(menu.bankOperand)], 0x82);
  const original = source.subarray(Number(menu.start), Number(menu.end));
  assert.equal(original.toString('hex'), '32110121533450505019a1011b7b1b0c1849214434505050011acc5050505050214432500100021503011603001803');
  const entry = menu.entries[0];
  assert.equal(source.subarray(Number(entry.offset), Number(entry.offset) + 2).toString('hex'), entry.originalHex);
  assert.equal(encodeInlineLabel(entry, glyphCode).toString('hex'), '1ffa');
  assert.equal(original.subarray(-9).toString('hex'), menu.trailerHex);
  assert.equal(source.subarray(Number(menu.end), Number(menu.end) + 3).toString('hex'), '9cc81f');
});

test('workshop menus retain exact native source anchors, callbacks and safe glyph encodings', () => {
  let labels = 0;
  for (const menu of menus) {
    assert.equal(source.readUInt16LE(Number(menu.pointerOperand)), Number(menu.start) & 65535);
    assert.equal(source[Number(menu.bankOperand)], 0x83);
    const trailer = Buffer.from(menu.trailerHex ?? '', 'hex');
    assert.equal(source[Number(menu.end) - trailer.length - 1], 0);
    assert.deepEqual(source.subarray(Number(menu.end) - trailer.length, Number(menu.end)), trailer);
    const callback = source.readUIntLE(Number(menu.start) + 4, 3) - 0x800000;
    assert.ok(callback >= Number(menu.end));
    let cursor = Number(menu.start);
    for (const entry of menu.entries) {
      const offset = Number(entry.offset);
      assert.ok(offset >= cursor);
      cursor = offset + entry.originalHex.length / 2;
      assert.ok(cursor <= Number(menu.end));
      assert.equal(source.subarray(offset, cursor).toString('hex'), entry.originalHex);
      assert.ok(encodeInlineLabel(entry, glyphCode).length);
      labels++;
    }
  }
  assert.equal(labels, 11);
  const supplies = menus.find(menu => menu.name === 'castle-workshop-supplies');
  assert.equal(supplies.end, '0x3d116');
  assert.equal(supplies.trailerHex, '005118');
});

test('formation menu includes all dynamic actor descriptors and original callbacks', () => {
  const definition = JSON.parse(fs.readFileSync(new URL('translations/formation-menu.json', root)));
  const menu = definition.inlineMenus[0];
  assert.equal(source.readUInt16LE(Number(menu.pointerOperand)), Number(menu.start) & 65535);
  assert.equal(source[Number(menu.bankOperand)], 0x81);
  assert.equal(menu.end, '0x1f2ff');
  assert.equal(source.subarray(0x1f2e6, Number(menu.end)).toString('hex'), '2c500100041503041603041703041803fff281fff281fff281');
  assert.equal(source.subarray(Number(menu.end), Number(menu.end) + 3).toString('hex'), 'aee412');
  const entry = menu.entries[0];
  assert.equal(source.subarray(Number(entry.offset), Number(entry.offset) + 4).toString('hex'), entry.originalHex);
  assert.equal(encodeInlineLabel(entry, glyphCode).toString('hex'), '1d101d11');
  assert.equal(encodeInlineLabel(entry, glyphCode).length, entry.originalHex.length / 2);
});

test('ability injury label uses existing safe glyphs and leaves condition controls outside the replacement', () => {
  const plan = JSON.parse(fs.readFileSync(new URL('translations/residual-v55.plan.json', root)));
  const baseline = JSON.parse(fs.readFileSync(new URL('verification/formation-menu-v54/resolved-translation-manifest.json', root)));
  const changed = structuredClone(baseline.inlineMenus);
  addInlineMenuData(changed, plan.inlineMenuAdditions, source);
  const entry = changed.find(menu => menu.name === 'ability-status').entries.find(entry => entry.offset === '0x5bfdb');
  assert.equal(entry.translation, '重傷');
  assert.equal(source.subarray(0x5bfd6, 0x5bfe0).toString('hex'), '2628038050184098d02b');
  assert.equal(encodeInlineLabel(entry, glyphCode).toString('hex'), '1cf91c99');
});

test('native inline glyph exceptions cannot introduce controls or replace unknown source glyphs', () => {
  const entry = { translation: '砲１', originalHex: '1a2052', nativeGlyphs: { '砲': '1a20', '１': '52' } };
  assert.equal(encodeInlineLabel(entry, glyphCode).toString('hex'), '1a2052');
  assert.throws(() => encodeInlineLabel({ ...entry, nativeGlyphs: { '砲': '25' } }, glyphCode), /Unapproved/);
  assert.throws(() => encodeInlineLabel({ ...entry, originalHex: '52' }, glyphCode), /absent/);
  assert.throws(() => encodeInlineLabel({ ...entry, translation: '１' }, glyphCode), /Unused/);
  assert.throws(() => encodeInlineLabel({ translation: '砲', originalHex: '1a20' }, glyphCode), /legacy glyph/);
  assert.throws(() => encodeInlineLabel({ translation: '設', originalHex: '1a20' }, glyphCode), /legacy glyph/);
});

test('field-menu additions preserve existing labels and validate the compact special-menu entry', () => {
  const baseline = JSON.parse(fs.readFileSync(new URL('verification/screenshots-v52/resolved-translation-manifest.json', root)));
  const plan = JSON.parse(fs.readFileSync(new URL('translations/field-menu-v53.plan.json', root)));
  const changed = structuredClone(baseline.inlineMenus);
  addInlineMenuData(changed, plan.inlineMenuAdditions, source);
  const field = changed.find(menu => menu.name === 'field-menu-expanded');
  assert.equal(field.entries.length, 9);
  assert.deepEqual(field.entries.filter(entry => entry.offset !== '0x1efa2'), baseline.inlineMenus.find(menu => menu.name === field.name).entries);
  assert.equal(encodeInlineLabel(field.entries.find(entry => entry.offset === '0x1efa2'), glyphCode).toString('hex'), '1f841c371cc7');
  const special = changed.find(menu => menu.name === 'special-menu');
  assert.deepEqual(special.entries, baseline.inlineMenus.find(menu => menu.name === special.name).entries);
  assert.deepEqual(special.alternatePointers, [{ pointerOperand: '0x1f06d', bankOperand: '0x1f074', skip: 3 }]);
  assert.throws(() => addInlineMenuData(changed, plan.inlineMenuAdditions, source), /overlaps/);
  for (const mutate of [
    value => { value[0].name = 'missing'; },
    value => { value[0].entries[0].originalHex = '0000000000'; },
    value => { value[0].entries[0].offset = '0x0'; },
    value => { value[1].alternatePointers[0].skip = 4; },
    value => { value[1].alternatePointers[0].bankOperand = '0x1f075'; },
  ]) {
    const additions = structuredClone(plan.inlineMenuAdditions);
    mutate(additions);
    assert.throws(() => addInlineMenuData(structuredClone(baseline.inlineMenus), additions, source));
  }
  assert.throws(() => addInlineMenuData(changed, [plan.inlineMenuAdditions[1]], source), /already registered/);
});