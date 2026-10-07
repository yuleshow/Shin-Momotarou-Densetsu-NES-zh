import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { decodeGlyph } from './font-codec.mjs';
import { encodeInlineLabel } from './inline-text.mjs';

const [runner, core, candidate, baseline, fixture, output] = process.argv.slice(2);
assert.ok(output, 'Usage: verify-workshop-menus.mjs RUNNER CORE CANDIDATE BASELINE FIELD_STATE NEW_OUTPUT');
const read = filename => JSON.parse(fs.readFileSync(filename));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = fs.readFileSync(new URL('../assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc', import.meta.url));
const castleBattle = process.argv.includes('--castle-battle');
const shopFollowup = process.argv.includes('--shop-followup');
const recipientPartySizes = process.argv.includes('--recipient-party-sizes');
assert.ok(!recipientPartySizes || shopFollowup, 'Recipient party-size checks require --shop-followup');
assert.ok(!(castleBattle && shopFollowup), 'Choose one native menu verification mode');
const definition = read(new URL(castleBattle ? '../translations/castle-battle-menu.json' : '../translations/screenshot-workshop-menus.json', import.meta.url));
const metadata = read(path.join(candidate, 'build.json'));
const previous = read(path.join(baseline, 'build.json'));
const target = fs.readFileSync(path.join(candidate, metadata.romFilename));
const before = fs.readFileSync(path.join(baseline, previous.romFilename));
assert.equal(hash(source), definition.sourceSha256);
assert.equal(hash(target), metadata.targetSha256);
assert.equal(hash(before), previous.targetSha256);
assert.deepEqual(metadata.glyphs, previous.glyphs);
const fixtureHash = hash(fs.readFileSync(fixture));
fs.mkdirSync(output);

function run(filename, name, inputs, state, frames = 360) {
  const directory = path.join(output, name);
  const result = spawnSync(runner, [core, filename, directory, String(frames), inputs, state], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, MOMOTARO_CHEATS: '', MOMOTARO_TRACE: '', MOMOTARO_CAPTURE_EVERY: String(frames) },
  });
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  return { directory, state: path.join(directory, 'state.bin'), ram: fs.readFileSync(path.join(directory, `wram-${frames}.bin`)),
    frame: fs.readFileSync(path.join(directory, `frame-${frames}.ppm`)) };
}

function compareGameData(actual, expected) {
  assert.deepEqual(actual.subarray(0x160b, 0x187f), expected.subarray(0x160b, 0x187f));
  assert.deepEqual(actual.subarray(0x1880, 0x1940), expected.subarray(0x1880, 0x1940));
  assert.deepEqual(actual.subarray(0x151d, 0x1520), expected.subarray(0x151d, 0x1520));
  return [...Array.from({ length: 11 }, (_, index) => 0x1600 + index), 0x187f]
    .filter(address => actual[address] !== expected[address])
    .map(address => ({ address, source: expected[address], target: actual[address] }));
}

function probe(bytes, menu, mask, name, ammunition) {
  const rom = Buffer.from(bytes);
  assert.equal(rom.subarray(0x1eee6, 0x1eeea).toString('hex'), '228ab385');
  assert.ok(rom.subarray(0x23e000, 0x23e080).every(byte => byte === 255));
  Buffer.from('5c00e0e3', 'hex').copy(rom, 0x1eee6);
  const wrapper = Buffer.alloc(4);
  wrapper[0] = 0x22;
  wrapper.writeUIntLE(Number(menu.pointerOperand) - 3 + 0x800000, 1, 3);
  const setup = Buffer.from(`228ab38522d4be83a97f8d57199c69199c6a19a9${mask.toString(16).padStart(2, '0')}8d3919a9${ammunition.toString(16).padStart(2, '0')}8d51189c5218`, 'hex');
  if (castleBattle) assert.equal(source.subarray(0x2f09d, 0x2f0a7).toString('hex'), 'a9648d1503c220ad4f18');
  Buffer.concat([setup, ...(castleBattle ? [Buffer.from('c220a9e8038d4f18e220229df082a97f8dc81f9cc91f', 'hex')] : []), wrapper, Buffer.from('5c13ef81', 'hex')]).copy(rom, 0x23e000);
  if (shopFollowup) {
    assert.equal(source.subarray(0x5bb35, 0x5bb40).toString('hex'), 'ad55038d5a19a9018d5503');
    assert.equal(source.subarray(0x3be66, 0x3be69).toString('hex'), 'c220a9');
    const call = menu.name === 'shop-services' ? `a9${mask.toString(16).padStart(2, '0')}8d6619a97f8d57192266be83`
      : 'a9038d5503a97f8d58192235bb85';
    rom.fill(255, 0x23e000, 0x23e080);
    const partySetup = recipientPartySizes ? Buffer.concat(Array.from({ length: 4 - ammunition }, (_, index) => {
      const instruction = Buffer.from([0x9c, 0, 0]);
      instruction.writeUInt16LE(0x1569 + ammunition + index, 1);
      return instruction;
    })) : Buffer.alloc(0);
    Buffer.concat([Buffer.from('228ab38522d4be83', 'hex'), partySetup, Buffer.from(`${call}5c13ef81`, 'hex')]).copy(rom, 0x23e000);
  }
  rom.writeUInt16LE(65535, 0xffdc);
  rom.writeUInt16LE(0, 0xffde);
  const sum = rom.reduce((total, byte) => (total + byte) & 65535, 0);
  rom.writeUInt16LE(sum ^ 65535, 0xffdc);
  rom.writeUInt16LE(sum, 0xffde);
  const filename = path.join(output, `${name}.sfc`);
  fs.writeFileSync(filename, rom, { flag: 'wx' });
  return filename;
}

function pixelsFor(character, entry) {
  const native = entry.nativeGlyphs?.[character];
  if (native) {
    const code = Buffer.from(native, 'hex');
    return code.length === 1 ? decodeGlyph(source, 1, code[0] - 0x50)
      : decodeGlyph(source, 8 + ((((code[0] - 0x17) << 8) + code[1] - 0x100) >> 6), code[1] & 63);
  }
  const glyph = metadata.glyphs.find(glyph => glyph.character === character);
  assert.ok(glyph, character);
  const pixels = new Uint8Array(192);
  for (let row = 0; row < 15; row++) for (let column = 0; column < 12; column++) {
    for (let plane = 0; plane < 2; plane++) {
      const value = column < 8 ? (target[glyph.offset + plane * 23 + row] >> (7 - column)) & 1
        : (target[glyph.offset + plane * 23 + 15 + (row >> 1)] >> ((row % 2 === 0 ? 4 : 0) + 11 - column)) & 1;
      pixels[(row + 1) * 12 + column] |= value << plane;
    }
  }
  return pixels;
}

function matchLabel(frame, entry) {
  const header = /^P6\n256 224\n255\n/.exec(frame.subarray(0, 64).toString());
  assert.ok(header);
  const image = frame.subarray(header[0].length);
  const points = [];
  [...entry.translation].forEach((character, index) => {
    const pixels = pixelsFor(character, entry);
    for (let row = 0; row < 16; row++) for (let column = 0; column < 12; column++) {
      const pixel = pixels[row * 12 + column];
      if (pixel & 1) points.push({ offset: row * 256 + index * 12 + column, foreground: Boolean(pixel & 2) });
    }
  });
  assert.ok(points.length);
  for (let row = 0; row <= 208; row++) for (let column = 0; column <= 256 - [...entry.translation].length * 12; column++) {
    if (points.every(point => {
      const offset = ((row * 256 + column) + point.offset) * 3;
      const brightness = Math.max(...image.subarray(offset, offset + 3));
      return point.foreground ? brightness >= 140 : brightness <= 110;
    })) return { x: column, y: row };
  }
  assert.fail(`Missing native label: ${entry.translation}`);
}

function sameRectangle(first, second, x, y, width, height) {
  const pixels = frame => frame.subarray(frame.indexOf(Buffer.from('\n255\n')) + 5);
  const before = pixels(first), after = pixels(second);
  for (let row = y; row < y + height; row++) {
    const offset = (row * 256 + x) * 3;
    assert.deepEqual(after.subarray(offset, offset + width * 3), before.subarray(offset, offset + width * 3),
      `Numeric display or alignment changed at ${x},${row}`);
  }
}

const report = { targetSha256: metadata.targetSha256, baselineSha256: previous.targetSha256, fixtureSha256: fixtureHash,
  deviceModified: false, syntheticWrapperEntry: true, menus: [],
  limitations: ['Original menu wrappers and callbacks invoked from a scoped field-menu hook, not natural NPC traversal.',
    'Checks menu selection and quoted prices, not subsequent event-script payment or castle upgrade effects.',
    'Differences at 7E1600-7E160A remain unclassified; 7E187F is a native scene-object cursor (81B19B/81A3C1). All are recorded, not asserted equal; full gameplay RAM or scene timing equality is not claimed.'] };

if (shopFollowup) {
  const plan = read(new URL('../translations/shop-followup-v60.plan.json', import.meta.url));
  const manifest = read(new URL('../translations/menu.zh-Hant.json', import.meta.url));
  const shop = { ...manifest.inlineMenus.find(menu => menu.name === 'shop-services'), entries: plan.inlineMenuAdditions[0].entries };
  const recipient = read(new URL('../translations/recipient-menu.json', import.meta.url)).inlineMenus[0];
  for (const [start, end] of [[0x3beca, 0x3bed5], [0x5bb35, 0x5bbd8], [0x5bd3b, 0x5be13]]) {
    assert.deepEqual(target.subarray(start, end), before.subarray(start, end));
  }
  const scenarios = recipientPartySizes ? [1, 2, 3, 4].map(partySize => ({ menu: recipient, mask: 3, rows: partySize + 1, labelRow: 0, partySize })) : [
    { menu: shop, mask: 2, rows: 5, labelRow: 2 },
    { menu: shop, mask: 34, rows: 4, labelRow: 1 },
    { menu: shop, mask: 0, rows: 4 },
    { menu: shop, mask: 1, rows: 5 },
    { menu: shop, mask: 8, rows: 4 },
    { menu: recipient, mask: 3, rows: 5, labelRow: 0 },
  ];
  const results = [];
  for (const { menu, mask, rows, labelRow, partySize } of scenarios) {
    const isShop = menu === shop;
    const variants = [before, target].map((bytes, index) => {
      const name = `${menu.name}-${mask}${partySize ? `-party-${partySize}` : ''}-${index ? 'target' : 'baseline'}`;
      const filename = probe(bytes, menu, mask, name, partySize ?? 0);
      return { name, filename, opened: run(filename, `${name}-open`, '30:3:a', fixture, 600) };
    });
    const label = { x: 24, y: (isShop ? 128 : 56) + (labelRow ?? 0) * 16, width: isShop ? 60 : 48, height: 16 };
    const bounds = isShop ? { x: 8, y: 120, width: 88, height: 96 } : { x: 8, y: 48, width: 72, height: 96 };
    if (labelRow !== undefined) {
      const found = matchLabel(variants[1].opened.frame, menu.entries[0]);
      assert.deepEqual(found, { x: label.x, y: label.y });
      assert.throws(() => matchLabel(variants[0].opened.frame, menu.entries[0]), /Missing native label/);
    } else assert.throws(() => matchLabel(variants[1].opened.frame, menu.entries[0]), /Missing native label/);
    for (let row = bounds.y; row < bounds.y + bounds.height; row++) for (let column = bounds.x; column < bounds.x + bounds.width; column++) {
      if (labelRow !== undefined && column >= label.x && column < label.x + label.width && row >= label.y && row < label.y + label.height) continue;
      sameRectangle(variants[0].opened.frame, variants[1].opened.frame, column, row, 1, 1);
    }
    const cases = [];
    const party = [...variants[0].opened.ram.subarray(0x1569, 0x156d)];
    if (partySize) {
      assert.equal(party.filter(actor => actor !== 0).length, partySize);
      assert.ok(party.slice(partySize).every(actor => actor === 0));
      assert.deepEqual([...variants[1].opened.ram.subarray(0x1569, 0x156d)], party);
    }
    for (const choice of Array.from({ length: rows + 1 }, (_, index) => index)) {
      const inputs = choice ? [...Array.from({ length: choice - 1 }, (_, index) => `${30 + index * 60}:3:down`), '360:3:a'].join(',') : '30:3:b';
      const selected = variants.map(variant => run(variant.filename, `${variant.name}-choice-${choice}`, inputs, variant.opened.state, 600));
      const address = isShop ? 0x1957 : 0x1958;
      assert.equal(selected[1].ram[address], selected[0].ram[address]);
      for (const [index, result] of selected.entries()) {
        if (isShop) {
          const commandIds = mask === 34 ? [1, 3, 4, 5] : mask === 0 ? [1, 2, 4, 5] : [1, 2, 3, 4, 5];
          assert.equal(result.ram[address], choice ? commandIds[choice - 1] : 127);
        }
        else if (!choice) assert.equal(result.ram[address], 0);
        else if (choice === 1) assert.ok(party.includes(result.ram[address]) && result.ram[address] !== 0);
        else assert.equal(result.ram[address], party[choice - 2]);
        assert.deepEqual(result.ram.subarray(0x1621, 0x1623), variants[index].opened.ram.subarray(0x1621, 0x1623));
        assert.deepEqual(result.ram.subarray(0x1569, 0x156d), variants[index].opened.ram.subarray(0x1569, 0x156d));
        assert.deepEqual(result.ram.subarray(0x3d20, 0x3d70), variants[index].opened.ram.subarray(0x3d20, 0x3d70));
      }
      cases.push({ choice, selected: selected[1].ram[address], unclassifiedRamDifferences: compareGameData(selected[1].ram, selected[0].ram) });
    }
    const image = `${menu.name}-${mask}${partySize ? `-party-${partySize}` : ''}.png`;
    assert.equal(spawnSync('magick', [path.join(variants[1].opened.directory, 'frame-600.ppm'), path.join(output, image)]).status, 0);
    results.push({ menu: menu.name, mask, rows, partySize, label: labelRow === undefined ? null : label, bounds,
      nonLabelPanelPixelsIdentical: true, party, cases, image });
    console.log(`PASS ${menu.name} flags ${mask}${partySize ? ` party ${partySize}` : ''}: ${rows} selections, cancel, label visibility and panel pixels`);
  }
  assert.equal(hash(fs.readFileSync(fixture)), fixtureHash);
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ targetSha256: metadata.targetSha256,
    baselineSha256: previous.targetSha256, fixtureSha256: fixtureHash, originalFixtureUnchanged: true,
    deviceModified: false, syntheticWrapperEntry: true, scenarios: results,
    limitations: ['Native wrappers entered from a test-only field hook, not natural NPC traversal or a completed purchase.',
      recipientPartySizes ? 'Party slots truncated only in test ROMs to exercise one through four eligible members; full-inventory and all-ineligible cases are not covered.'
        : 'Automatic recipient tested with the supplied eligible four-member party; full-inventory and all-ineligible cases are not covered.',
      'Only menu panels and specified gameplay ranges compared; field animation and unclassified RAM differences do not imply full-scene equality.'] }, null, 2) + '\n', { flag: 'wx' });
  process.exit(0);
}

if (castleBattle) {
  const menu = definition.inlineMenus[0];
  const statusMenu = definition.inlineMenus[1];
  const scenarios = [];
  const ammunitionImages = [];
  for (const { mask, ammunition } of [{ mask: 0, ammunition: 0 }, { mask: 0x80, ammunition: 0 }, { mask: 0x80, ammunition: 10 }]) {
  const variants = [before, target].map((bytes, index) => {
    const name = `${index ? 'target' : 'source'}-${mask}-${ammunition}`;
    const filename = probe(bytes, menu, mask, name, ammunition);
    return { name, filename, opened: run(filename, `${name}-open`, '30:3:a', fixture) };
  });
  const entries = [...menu.entries, ...statusMenu.entries];
  const labels = entries.map(entry => ({ text: entry.translation, ...matchLabel(variants[1].opened.frame, entry) }));
  for (const entry of entries) assert.throws(() => matchLabel(variants[0].opened.frame, entry), /Missing native label/);
  for (const variant of variants) {
    const cannon = () => matchLabel(variant.opened.frame, { translation: '大砲', nativeGlyphs: { '大': '1840', '砲': '1a20' } });
    if (mask) cannon();
    else assert.throws(cannon, /Missing native label/);
    assert.equal(variant.opened.ram.readUInt16LE(0x184f), 1000);
    assert.equal(variant.opened.ram.readUInt16LE(0x1851), ammunition);
    assert.equal(variant.opened.ram.readUInt16LE(0x0316), 1000);
    assert.equal(variant.opened.ram[0x0318], ammunition);
  }
  const rectangles = labels.map(label => ({ ...label, width: label.text === '逃跑' ? 36 : [...label.text].length * 12, height: 16 }));
  const menuBounds = [{ x: 8, y: 8, width: 112, height: 64 }, { x: 136, y: 8, width: 88, height: 64 }];
  const image = frame => frame.subarray(frame.indexOf(Buffer.from('\n255\n')) + 5);
  const images = variants.map(variant => image(variant.opened.frame));
  let outsideMenuChangedPixels = 0;
  for (let row = 0; row < 224; row++) for (let column = 0; column < 256; column++) {
    if (rectangles.some(rectangle => column >= rectangle.x && column < rectangle.x + rectangle.width && row >= rectangle.y && row < rectangle.y + rectangle.height)) continue;
    if (menuBounds.some(bounds => column >= bounds.x && column < bounds.x + bounds.width && row >= bounds.y && row < bounds.y + bounds.height)) {
      sameRectangle(variants[0].opened.frame, variants[1].opened.frame, column, row, 1, 1);
    } else {
      const offset = (row * 256 + column) * 3;
      if (!images[0].subarray(offset, offset + 3).equals(images[1].subarray(offset, offset + 3))) outsideMenuChangedPixels++;
    }
  }
  if (mask) ammunitionImages.push(Buffer.concat(Array.from({ length: 16 }, (_, row) => {
    const offset = ((48 + row) * 256 + 184) * 3;
    return images[1].subarray(offset, offset + 32 * 3);
  })));
  const cases = [];
  for (const [name, inputs, selection] of (mask ? [
    ['charge', '240:3:a', 1],
    ['cannon', '30:3:down,240:3:a', 2],
    ['repair', '30:3:down,90:3:down,240:3:a', 3],
    ['escape', '30:3:down,90:3:down,150:3:right,240:3:a', 4],
  ] : [])) {
    const results = variants.map(variant => run(variant.filename, `${variant.name}-${name}`, inputs, variant.opened.state));
    for (const result of results) assert.equal(result.ram.readUInt16LE(0x1fc8), selection, `${name}: wrong castle action`);
    const differences = compareGameData(results[1].ram, results[0].ram);
    cases.push({ name, selection, checkedGameDataEqual: true, unclassifiedRamDifferences: differences });
  }
  const filename = `castle-battle-${mask}-${ammunition}.png`;
  assert.equal(spawnSync('magick', [path.join(variants[1].opened.directory, 'frame-360.ppm'), path.join(output, filename)]).status, 0);
  scenarios.push({ mask, ammunition, durability: 1000, labels, menuBounds, menuOutsideLabelPixelsIdentical: true,
    outsideMenuChangedPixels, originalGlyphNegativeControlsPassed: true, cases, image: filename });
  }
  assert.equal(hash(fs.readFileSync(fixture)), fixtureHash);
  assert.equal(ammunitionImages.length, 2);
  assert.ok(!ammunitionImages[0].equals(ammunitionImages[1]), 'Ammunition display did not change between 0 and 10');
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ targetSha256: metadata.targetSha256,
    baselineSha256: previous.targetSha256, fixtureSha256: fixtureHash, originalFixtureUnchanged: true,
    scenarios, ammunitionDisplayChangesWithValue: true,
    selectionAddress: '7E1FC8', deviceModified: false, syntheticWrapperEntry: true,
    limitations: ['Native castle menu invoked through a scoped field-menu hook, not a natural castle battle.',
      'Checks four selected command IDs, not subsequent cannon damage, repair consumption or escape outcomes.',
        'Scene animation and unclassified RAM differences are reported; full scene or gameplay RAM equality is not claimed.'] }, null, 2) + '\n', { flag: 'wx' });
      console.log('PASS castle battle: three labels, eight command selections, 0/10 ammunition, original name/numeric pixels');
  process.exit(0);
}

for (const menu of definition.inlineMenus) {
  const fragments = [];
  let cursor = Number(menu.start);
  for (const entry of menu.entries) {
    fragments.push(source.subarray(cursor, Number(entry.offset)), encodeInlineLabel(entry, character => {
      const glyph = metadata.glyphs.find(glyph => glyph.character === character);
      return glyph && Buffer.from(glyph.code, 'hex');
    }), Buffer.alloc(entry.padding ?? 0, 0x50));
    cursor = Number(entry.offset) + entry.originalHex.length / 2;
  }
  fragments.push(source.subarray(cursor, Number(menu.end)));
  const encoded = Buffer.concat(fragments);
  assert.deepEqual(target.subarray(Number(menu.target), Number(menu.target) + encoded.length), encoded);
  assert.equal(target.readUInt16LE(Number(menu.pointerOperand)), Number(menu.target) & 65535);
  assert.equal(target[Number(menu.bankOperand)], 0xe3);
  const callback = source.readUIntLE(Number(menu.start) + 4, 3) - 0x800000;
  assert.deepEqual(target.subarray(callback, callback + 32), source.subarray(callback, callback + 32));
  const prices = menu.name === 'castle-workshop-upgrades' ? [20000, 30000, 35000]
    : menu.name === 'castle-workshop-supplies' ? [300, 2700, 300] : undefined;
  const scenarios = menu.name === 'castle-workshop-upgrades' ? [{ mask: 0, ammunition: 0 }, { mask: 0x40, ammunition: 0 }]
    : menu.name === 'castle-workshop-supplies' ? [{ mask: 0, ammunition: 0 }, { mask: 0, ammunition: 42 }]
      : [{ mask: 0, ammunition: 0 }];
  for (const { mask, ammunition } of scenarios) {
    const scenario = `${mask}${ammunition ? `-ammo${ammunition}` : ''}`;
    const variants = [before, target].map((bytes, index) => {
      const prefix = `${menu.name}-${scenario}-${index ? 'target' : 'source'}`;
      const filename = probe(bytes, menu, mask, prefix, ammunition);
      return { filename, prefix, opened: run(filename, `${prefix}-open`, '30:3:a', fixture) };
    });
    const selections = [1, 2, 3].filter(selection => !(mask & (0x20 << (selection - 1))));
    const enabled = menu.entries.filter((entry, index) => index >= 3 || selections.includes(index + 1));
    const labels = enabled.map(entry => ({ text: entry.translation, ...matchLabel(variants[1].opened.frame, entry) }));
    assert.ok(!variants[0].opened.frame.equals(variants[1].opened.frame));
    if (prices) sameRectangle(variants[0].opened.frame, variants[1].opened.frame,
      menu.name === 'castle-workshop-upgrades' ? 112 : 136, 8,
      menu.name === 'castle-workshop-upgrades' ? 48 : 24, selections.length * 16);
    if (menu.name === 'castle-workshop-supplies') {
      for (const variant of variants) assert.equal(variant.opened.ram.readUInt16LE(0x1851), ammunition);
      sameRectangle(variants[0].opened.frame, variants[1].opened.frame, 120, 56, 16, 16);
    }
    const cases = [];
    for (const [row, selection] of selections.entries()) {
      const inputs = [...Array.from({ length: row }, (_, index) => `${30 + index * 60}:3:down`), '240:3:a'].join(',');
      const selected = variants.map(variant => run(variant.filename, `${variant.prefix}-select-${selection}`, inputs, variant.opened.state));
      for (const result of selected) {
        assert.equal(result.ram[0x1957], selection);
        if (prices) assert.equal(result.ram.readUInt16LE(0x1969), prices[selection - 1]);
      }
      const unclassifiedRamDifferences = compareGameData(selected[1].ram, selected[0].ram);
      cases.push({ selection, price: prices?.[selection - 1], checkedGameDataEqual: true, unclassifiedRamDifferences });
    }
    const cancelled = variants.map(variant => run(variant.filename, `${variant.prefix}-cancel`, '30:3:b', variant.opened.state));
    assert.equal(cancelled[1].ram[0x1957], cancelled[0].ram[0x1957]);
    assert.equal(cancelled[1].ram[0x1957], 0x7f);
    const cancellationRamDifferences = compareGameData(cancelled[1].ram, cancelled[0].ram);
    const image = `${menu.name}-${scenario}.png`;
    const converted = spawnSync('magick', [path.join(variants[1].opened.directory, 'frame-360.ppm'), path.join(output, image)]);
    assert.equal(converted.status, 0);
    report.menus.push({ name: menu.name, mask, ammunition, labels, cases, cancellation: 0x7f, cancellationRamDifferences,
      pricesRenderedIdentically: Boolean(prices), ammunitionCountRenderedIdentically: menu.name === 'castle-workshop-supplies', callbackUnchanged: true, image });
    console.log(`PASS ${menu.name}/${scenario}: ${labels.length} labels, ${cases.length} selections and cancellation`);
  }
}
assert.equal(hash(fs.readFileSync(fixture)), fixtureHash);
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });