import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderWorldAtlas } from './render-world-atlas.mjs';

const [snapshotFile, captureFile, font] = process.argv.slice(2);
assert.ok(font, 'Usage: render-world-map.mjs MOON_MIRROR_STATE CAPTURE_PPM FONT');
assert.ok(fs.existsSync(font));
const directory = path.dirname(fileURLToPath(import.meta.url));
const imageDirectory = path.join(directory, 'images');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const snapshot = fs.readFileSync(snapshotFile);
const capture = fs.readFileSync(captureFile);
assert.equal(snapshot.subarray(0, 14).toString(), '#!s9xsnp:0012\n');
const sections = new Map();
let position = 14;
while (position < snapshot.length) {
  const header = snapshot.subarray(position, position + 11).toString();
  assert.match(header, /^[A-Z0-9]{3}:\d{6}:$/);
  const size = Number(header.slice(4, 10));
  const start = position + 11;
  assert.ok(start + size <= snapshot.length);
  sections.set(header.slice(0, 3), snapshot.subarray(start, start + size));
  position = start + size;
}
const ppu = sections.get('PPU');
const vram = sections.get('VRA');
assert.equal(ppu?.length, 2652);
assert.equal(vram?.length, 65536);
assert.equal(ppu[58], 1, 'Expected SNES mode 1');
const background = {
  screen: ppu.readUInt16BE(25) * 2,
  horizontal: ppu.readUInt16BE(27),
  vertical: ppu.readUInt16BE(29),
  size: ppu[31],
  base: ppu.readUInt16BE(32) * 2,
  layout: ppu.readUInt16BE(34),
};
assert.deepEqual(background, { screen: 4096, horizontal: 0, vertical: 0, size: 0, base: 0, layout: 1 });
const captureHeader = Buffer.from('P6\n256 224\n255\n');
assert.ok(capture.subarray(0, captureHeader.length).equals(captureHeader));
const capturedPixels = capture.subarray(captureHeader.length);
assert.equal(capturedPixels.length, 256 * 224 * 3);
const markers = [];
for (let index = 0; index < 128; index++) {
  const offset = 576 + index * 11;
  const marker = {
    x: ppu.readInt16BE(offset), y: ppu.readUInt16BE(offset + 2) - 1,
    tile: ppu.readUInt16BE(offset + 6), size: ppu[offset + 10], palette: ppu[offset + 9],
  };
  if (marker.size === 0 && marker.palette === 2 && [105, 121].includes(marker.tile) && marker.x >= 64 && marker.x < 192 && marker.y >= 47 && marker.y < 175) markers.push(marker);
}
assert.ok(markers.length > 0, 'Expected native Moon Mirror markers');
const crop = { x: 64, y: 47, width: 128, height: 128 };
const terrain = Buffer.alloc(crop.width * crop.height * 3);
let matchingPixels = 0;
let markerDifferences = 0;
for (let mapY = 0; mapY < crop.height; mapY++) for (let mapX = 0; mapX < crop.width; mapX++) {
  const screenX = crop.x + mapX;
  const screenY = crop.y + mapY;
  const column = screenX;
  const row = screenY + 1;
  const entry = vram.readUInt16LE(background.screen + ((row >> 3) * 32 + (column >> 3)) * 2);
  const localX = entry & 0x4000 ? 7 - (column & 7) : column & 7;
  const localY = entry & 0x8000 ? 7 - (row & 7) : row & 7;
  const tile = entry & 1023;
  let color = 0;
  for (let plane = 0; plane < 4; plane++) {
    const address = background.base + tile * 32 + (plane >> 1) * 16 + localY * 2 + (plane & 1);
    color |= ((vram[address & 65535] >> (7 - localX)) & 1) << plane;
  }
  const paletteIndex = color ? ((entry >> 10) & 7) * 16 + color : 0;
  const rgb = ppu.readUInt16BE(64 + paletteIndex * 2);
  const green = (rgb >> 5) & 31;
  const offset = (mapY * crop.width + mapX) * 3;
  terrain[offset] = Math.floor((rgb & 31) * 255 / 31);
  terrain[offset + 1] = Math.floor(((green << 1) | (green >> 4)) * 255 / 63);
  terrain[offset + 2] = Math.floor(((rgb >> 10) & 31) * 255 / 31);
  const screenOffset = (screenY * 256 + screenX) * 3;
  if (terrain.subarray(offset, offset + 3).equals(capturedPixels.subarray(screenOffset, screenOffset + 3))) matchingPixels++;
  else {
    assert.ok(markers.some(marker => screenX >= marker.x && screenX < marker.x + 8 && screenY >= marker.y && screenY < marker.y + 8), `Terrain differs outside native markers at ${screenX},${screenY}`);
    markerDifferences++;
  }
}
assert.ok(matchingPixels / 16384 > 0.98);
assert.ok(markerDifferences > 0);
const magick = (args, input) => {
  const result = spawnSync('magick', args, { input, encoding: input ? undefined : 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
  return result.stdout;
};
fs.mkdirSync(imageDirectory, { recursive: true });
const nativeFile = path.join(imageDirectory, 'world-map-native.png');
magick(['ppm:-', nativeFile], Buffer.concat([Buffer.from('P6\n128 128\n255\n'), terrain]));
const sourceFile = path.join(imageDirectory, 'world-map-capture.png');
magick(['ppm:-', sourceFile], capture);
const locationData = JSON.parse(fs.readFileSync(path.join(directory, 'world-map-locations.json'), 'utf8'));
const atlas = renderWorldAtlas({ data: locationData, nativeFile, font, outputDirectory: imageDirectory });
const roundTrip = magick([nativeFile, '-depth', '8', 'rgb:-'], Buffer.alloc(0));
assert.deepEqual(roundTrip, terrain);
assert.equal(hash(fs.readFileSync(snapshotFile)), hash(snapshot));
assert.equal(hash(fs.readFileSync(captureFile)), hash(capture));
const report = {
  description: 'Native Moon Mirror surface-world BG2, not a reconstructed or imagined geography map',
  romSha256: '6a726fb79df36a21b46a1eeec33409930ec282d110c312e4025e5538af25d470',
  snapshotVersion: 12, snapshotSha256: hash(snapshot), captureSha256: hash(capture),
  vramSha256: hash(vram), ppuSha256: hash(ppu), background, crop,
  matchingPixels, nativeSpriteDifferences: markerDifferences, differencesOutsideNativeMarkers: 0,
  markers, terrainRgbSha256: hash(terrain), nativePngRoundTripExact: true,
  originalInputsUnchanged: true, snapshotModifiedByRenderer: false,
  naturalPlaythroughCapture: false,
  fixtureLimitation: 'Read-only existing formation fixture has previously altered character stats; normal inputs open the map. No stats are included in these map images.',
  placeLabels: { catalogNames: atlas.catalogNames, hermits: atlas.hermits, inns: atlas.inns, layouts: atlas.layouts, source: 'world-map-locations.json', sha256: hash(fs.readFileSync(path.join(directory, 'world-map-locations.json'))), textOverlap: false },
  limitations: ['128x128 surface overview, not full-resolution walking terrain', 'Undersea entrances projected onto surface terrain; moon panel is a coordinate plot, not decoded moon terrain', 'Interior names use parent entrances; dynamic, regional and unresolved names are explicitly listed in the catalog, not invented as fixed points', 'All 87 names listed does not mean all 87 have independent verified world coordinates'],
  images: [nativeFile, sourceFile, ...atlas.files].map(filename => ({ path: `images/${path.basename(filename)}`, sha256: hash(fs.readFileSync(filename)) })),
};
fs.writeFileSync(path.join(directory, 'world-map-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`PASS: ${matchingPixels}/16384 exact pixels; ${markerDifferences} native marker pixels; zero differences elsewhere; PNG round-trip exact`);