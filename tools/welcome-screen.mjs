import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export const welcomeOffset = 0x3e0000;

export function renderWelcomeCover(cover, font, version) {
  assert.match(version, /^v[1-9][0-9]{0,3}$/, 'Expected a version such as v18');
  const convert = args => {
    const result = spawnSync('magick', args, { maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr?.toString() || 'Welcome image conversion failed');
    return result.stdout;
  };
  const pixels = convert([cover, '-auto-orient', '-resize', '208x208', '-background', 'black', '-alpha', 'remove',
    '-alpha', 'off', '-gravity', 'North', '-extent', '256x224', '-colorspace', 'sRGB',
    '-dither', 'FloydSteinberg', '-colors', '254', '-depth', '8', 'rgb:-']);
  const caption = convert(['-size', '256x224', 'xc:black', '-font', font, '-pointsize', '12', '+antialias',
    '-fill', 'white', '-gravity', 'SouthWest', '-annotate', '+8+0', 'START',
    '-gravity', 'SouthEast', '-annotate', '+8+0', version, '-colorspace', 'Gray', '-depth', '8', 'gray:-']);
  assert.equal(pixels.length, 256 * 224 * 3);
  assert.equal(caption.length, 256 * 224);
  const palette = Buffer.alloc(512);
  palette.writeUInt16LE(0x7fff, 510);
  const colors = new Map([[0, 0]]);
  const indices = Buffer.alloc(256 * 224);
  for (let index = 0; index < indices.length; index++) {
    const color = (pixels[index * 3] >> 3) | ((pixels[index * 3 + 1] >> 3) << 5) | ((pixels[index * 3 + 2] >> 3) << 10);
    if (!colors.has(color)) {
      assert.ok(colors.size < 255, 'Cover exceeds the SNES palette');
      palette.writeUInt16LE(color, colors.size * 2);
      colors.set(color, colors.size);
    }
    indices[index] = caption[index] >= 128 ? 255 : colors.get(color);
  }
  const tiles = Buffer.alloc(32 * 28 * 64);
  const tilemap = Buffer.alloc(32 * 32 * 2);
  const preview = Buffer.alloc(pixels.length);
  for (let row = 0; row < 224; row++) {
    for (let column = 0; column < 256; column++) {
      const index = row * 256 + column;
      const tile = (row >> 3) * 32 + (column >> 3);
      tilemap.writeUInt16LE(tile, tile * 2);
      for (let plane = 0; plane < 8; plane++) {
        const offset = tile * 64 + (plane >> 1) * 16 + (row & 7) * 2 + (plane & 1);
        tiles[offset] |= ((indices[index] >> plane) & 1) << (7 - (column & 7));
      }
      const color = palette.readUInt16LE(indices[index] * 2);
      for (let channel = 0; channel < 3; channel++) {
        const component = (color >> (channel * 5)) & 31;
        preview[index * 3 + channel] = channel === 1
          ? Math.floor(((component << 1) | (component >> 4)) * 255 / 63)
          : Math.floor(component * 255 / 31);
      }
    }
  }
  assert.ok(caption.some(pixel => pixel >= 128), 'Welcome caption is empty');
  return { palette, tiles, tilemap, preview, colors: colors.size + 1 };
}

export function installWelcomeScreen(rom, { cover, font, version }) {
  assert.equal(rom.subarray(0xf002, 0xf006).toString('hex'), '78a90048');
  assert.ok(rom.subarray(welcomeOffset, welcomeOffset + 0x10000).every(byte => byte === 0xff), 'Welcome bank is already allocated');
  const image = renderWelcomeCover(cover, font, version);
  const bytes = [];
  const labels = new Map();
  const references = [];
  const emit = (...values) => bytes.push(...values);
  const label = name => labels.set(name, bytes.length);
  const branch = (opcode, name) => {
    emit(opcode, 0);
    references.push({ offset: bytes.length - 1, name });
  };
  const store = (address, value) => emit(0xa9, value, 0x8d, address & 255, address >> 8);
  const dma = (source, length, port, mode) => {
    store(0x4300, mode);
    store(0x4301, port);
    store(0x4302, source & 255);
    store(0x4303, (source >> 8) & 255);
    store(0x4304, 0xfe);
    store(0x4305, length & 255);
    store(0x4306, length >> 8);
    store(0x420b, 1);
  };
  const frame = () => {
    const name = `frame-${bytes.length}`;
    label(`${name}-active`);
    emit(0xad, 0x12, 0x42);
    branch(0x30, `${name}-active`);
    label(`${name}-blank`);
    emit(0xad, 0x12, 0x42);
    branch(0x10, `${name}-blank`);
    label(`${name}-joy`);
    emit(0xad, 0x12, 0x42, 0x29, 1);
    branch(0xd0, `${name}-joy`);
  };
  emit(0x78, 0xd8, 0x18, 0xfb, 0xc2, 0x30, 0xa9, 0xff, 1, 0x1b, 0xa9, 0, 0, 0x5b, 0xe2, 0x20);
  emit(0xa9, 0, 0x48, 0xab);
  for (const address of [0x4200, 0x420b, 0x420c, 0x212c, 0x212d, 0x212e, 0x212f, 0x2123, 0x2124, 0x2125, 0x2130, 0x2131, 0x2133]) store(address, 0);
  store(0x2100, 0x80);
  store(0x2105, 3);
  store(0x2106, 0);
  store(0x2107, 0x70);
  store(0x210b, 0);
  store(0x210d, 0);
  store(0x210d, 0);
  store(0x210e, 0xff);
  store(0x210e, 0xff);
  store(0x2115, 0x80);
  store(0x2116, 0);
  store(0x2117, 0);
  dma(0x0800, image.tiles.length, 0x18, 1);
  store(0x2116, 0);
  store(0x2117, 0x70);
  dma(0xe800, image.tilemap.length, 0x18, 1);
  store(0x2121, 0);
  dma(0x0400, image.palette.length, 0x22, 0);
  store(0x212c, 1);
  store(0x4200, 1);
  store(0x2100, 15);
  label('initial-release');
  frame();
  emit(0xad, 0x19, 0x42, 0x29, 0x10);
  branch(0xd0, 'initial-release');
  label('press');
  frame();
  emit(0xad, 0x19, 0x42, 0x29, 0x10);
  branch(0xf0, 'press');
  label('release');
  frame();
  emit(0xad, 0x19, 0x42, 0x29, 0x10);
  branch(0xd0, 'release');
  store(0x2100, 0x80);
  store(0x4200, 0);
  emit(0xe2, 0x30, 0x38, 0xfb, 0xa9, 0, 0x48, 0x5c, 0x06, 0xf0, 0);
  for (const reference of references) {
    assert.ok(labels.has(reference.name));
    const delta = labels.get(reference.name) - reference.offset - 1;
    assert.ok(delta >= -128 && delta <= 127, 'Welcome branch out of range');
    bytes[reference.offset] = delta & 255;
  }
  assert.ok(bytes.length <= 0x400, 'Welcome code overlaps palette');
  Buffer.from(bytes).copy(rom, welcomeOffset);
  image.palette.copy(rom, welcomeOffset + 0x400);
  image.tiles.copy(rom, welcomeOffset + 0x800);
  image.tilemap.copy(rom, welcomeOffset + 0xe800);
  Buffer.from([0x5c, 0, 0, 0xfe]).copy(rom, 0xf002);
  return {
    metadata: { offset: welcomeOffset, codeBytes: bytes.length, version,
      sourceImageSha256: createHash('sha256').update(fs.readFileSync(cover)).digest('hex'),
      width: 256, height: 224, colors: image.colors, previewFilename: 'welcome-preview.png',
      continueButton: 'Start', waitsForRelease: true },
    preview: image.preview,
  };
}