import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const root = new URL('../walkthrough/', import.meta.url);
const data = JSON.parse(fs.readFileSync(new URL('world-map-locations.json', root)));
const romFile = new URL('../opening-preview-v65/opening-zh-Hant.sfc', import.meta.url);

test('world atlas accounts for 87 names, seven inns and thirteen hermits', () => {
  assert.equal(data.atlas.catalog.length, 87);
  assert.deepEqual(data.atlas.catalog.map(entry => entry.index), Array.from({ length: 87 }, (_, index) => index));
  for (const entry of data.atlas.catalog) {
    const mapped = data.atlas.points.some(point => point.places.some(place => place.index === entry.index));
    assert.ok(mapped || entry.note, entry.name);
    if ((entry.index >= 4 && entry.index <= 10) || (entry.index >= 64 && entry.index <= 76)) assert.ok(mapped, entry.name);
  }
  for (const point of data.atlas.points) {
    assert.equal(point.x, Math.floor(point.worldX / 2));
    assert.equal(point.y, Math.floor(point.worldY / 2));
    assert.ok(point.x >= 0 && point.x < 128 && point.y >= 0 && point.y < 128);
    assert.ok(['surface', 'moon', 'undersea'].includes(point.layer));
  }
  assert.ok(data.atlas.points.some(point => point.placeIndex === 45 && point.worldX === 123 && point.worldY === 119));
  assert.ok(data.atlas.points.some(point => point.layer === 'undersea' && point.placeIndex === 62));
  assert.ok(data.atlas.points.some(point => point.placeIndex === 26 && point.places.some(place => place.index === 73)));
});

test('walkthrough includes all thirteen hermits and seven inns with matching map references', () => {
  const text = fs.readFileSync(new URL('README.md', root), 'utf8');
  for (const [anchor, first, last] of [['hermits', 64, 76], ['inns', 4, 10]]) {
    const section = text.split(`<a id="${anchor}"></a>`)[1]?.split('<a id=')[0];
    assert.ok(section, anchor);
    const rows = [...section.matchAll(/^\| (\d{2}) \| ([^|]+) \| ([^|]+) \|/gm)];
    assert.equal(rows.length, last - first + 1);
    assert.deepEqual(rows.map(row => Number(row[1]) - 1), Array.from({ length: last - first + 1 }, (_, index) => first + index));
    for (const row of rows) {
      const index = Number(row[1]) - 1;
      assert.equal(row[2].trim(), data.atlas.catalog[index].name);
      const points = data.atlas.points.filter(point => point.layer === 'surface' && point.places.some(place => place.index === index));
      const grids = [...new Set(points.map(point => `${String.fromCharCode(65 + Math.floor(point.x / 16))}${Math.floor(point.y / 16) + 1}`))];
      assert.deepEqual(row[3].trim().split('、').sort(), grids.sort());
    }
  }
});

test('atlas entrance evidence matches untouched official ROM', { skip: !fs.existsSync(romFile) }, () => {
  const rom = fs.readFileSync(romFile);
  assert.equal(createHash('sha256').update(rom).digest('hex'), data.romSha256);
  for (const point of data.atlas.points) {
    const offset = Number(point.pointer);
    assert.ok([0x69, 0x5d].includes(rom[offset]));
    assert.equal(rom[offset + 1], point.worldX);
    assert.equal(rom[offset + 2], point.worldY);
    const transition = Number(point.transitionPointer);
    assert.equal(rom[transition], 0x53);
    assert.equal(rom[transition + 1], point.scene);
    assert.equal(rom[transition + 2], point.entry);
    if (point.namePointer) {
      const nameOffset = Number(point.namePointer);
      if (point.hermit) assert.equal(rom[nameOffset], point.placeIndex);
      else assert.deepEqual([...rom.subarray(nameOffset, nameOffset + 2)], [0x2b, point.placeIndex]);
    }
  }
});

test('combined map directly labels located names instead of only listing a legend', () => {
  const { layouts } = JSON.parse(fs.readFileSync(new URL('world-map-verification.json', root))).placeLabels;
  const surface = layouts.find(layout => layout.layer === 'surface');
  const moon = layouts.find(layout => layout.layer === 'moon');
  assert.equal(surface.inset.sourceLayer, 'moon');
  assert.equal(surface.inset.pixelsMatch, true);
  assert.ok(surface.inset.left >= 2680);
  assert.ok(surface.inset.left + surface.inset.width <= surface.width);
  assert.ok(surface.inset.top + surface.inset.height <= 2150);
  assert.deepEqual(surface.inset.placeIndexes, moon.placeIndexes);
  const visible = new Set([...surface.labels, ...moon.labels].flatMap(label => label.placeIndexes));
  assert.deepEqual(data.atlas.catalog.filter(entry => !visible.has(entry.index)).map(entry => entry.index), [59, 60, 77, 81, 84, 85]);
  for (const layout of [surface, moon]) for (const label of layout.labels) {
    assert.ok(data.atlas.points.some(point => point.layer === label.layer && point.x === label.x && point.y === label.y));
    for (const index of label.placeIndexes) assert.ok(label.text.includes(data.atlas.catalog[index].name));
  }
  for (const index of [20, 33, 62, 63]) assert.ok(surface.labels.some(label => label.layer === 'undersea' && label.placeIndexes.includes(index) && label.text.includes('海底入口投影')));
  const island = surface.labels.find(label => label.placeIndexes.includes(45));
  for (let index = 46; index <= 54; index++) assert.ok(island.placeIndexes.includes(index));
  assert.ok(moon.labels.some(label => label.placeIndexes.includes(44) && label.placeIndexes.includes(86)));
});

test('atlas images, layout bounds and coordinate hash match the report', () => {
  const report = JSON.parse(fs.readFileSync(new URL('world-map-verification.json', root)));
  assert.equal(report.placeLabels.catalogNames, 87);
  assert.equal(report.placeLabels.hermits, 13);
  assert.equal(report.placeLabels.inns, 7);
  assert.equal(report.placeLabels.sha256, createHash('sha256').update(fs.readFileSync(new URL('world-map-locations.json', root))).digest('hex'));
  assert.equal(report.differencesOutsideNativeMarkers, 0);
  assert.equal(report.nativePngRoundTripExact, true);
  assert.deepEqual(report.placeLabels.layouts.map(layout => layout.layer), ['surface', 'undersea', 'moon']);
  for (const layout of report.placeLabels.layouts) for (const [index, box] of layout.labelBoxes.entries()) {
    assert.ok(box.left >= 0 && box.top >= 0 && box.right <= layout.width && box.bottom <= layout.height);
    for (const other of layout.labelBoxes.slice(index + 1)) assert.ok(!(box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top));
  }
  for (const image of report.images) assert.equal(createHash('sha256').update(fs.readFileSync(new URL(image.path, root))).digest('hex'), image.sha256);
});