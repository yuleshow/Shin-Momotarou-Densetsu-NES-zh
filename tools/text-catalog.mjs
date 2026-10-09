import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeLz, encodeHuffman, huffmanCodes } from './text-codec.mjs';
import { decodeGlyph } from './font-codec.mjs';
import { isGlyphPrefix } from './chinese-font.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hex = value => `0x${value.toString(16)}`;

export const staticReferences = new Map([
  ['02:a6', { offset: 0x703d6, hex: '9dbda5bd00' }],
  ['02:a7', { offset: 0x703db, hex: 'dbf65c7e00' }],
  ['02:ab', { offset: 0x703f7, hex: '909f939f00' }],
  ['02:ac', { offset: 0x703fc, hex: '0494a50300' }],
  ['02:a8', { offset: 0x703e0, hex: '0492aaf6aaf6035f00' }],
  ['02:a9', { offset: 0x703e9, hex: '91b6f59bf6809100' }],
  ['02:b0', { offset: 0x7040e, hex: '96bd9fbd00' }],
  ['02:b1', { offset: 0x70413, hex: 'd6f7a100' }],
  ['02:b3', { offset: 0x7041b, hex: 'a1959200' }],
  ['02:b4', { offset: 0x7041f, hex: '19de19df9b9f5c00' }],
  ['02:b5', { offset: 0x70427, hex: '04a0f7a0f7bd035c00' }],
  ['02:b6', { offset: 0x70430, hex: '94ae9300' }],
  ['02:bd', { offset: 0x70448, hex: '90b7d0a392d4d591ae00' }],
  ['02:be', { offset: 0x70452, hex: '9f95b600' }],
  ['02:bf', { offset: 0x70456, hex: 'd6d99200' }],
  ['02:c0', { offset: 0x7045a, hex: '94a5d1b700' }],
  ['02:c1', { offset: 0x7045f, hex: '9496f69700' }],
  ['02:c2', { offset: 0x70464, hex: '7d94945c00' }],
  ['02:c4', { offset: 0x70471, hex: 'a195f59f5c00' }],
  ['02:c5', { offset: 0x70477, hex: '97da9a9100' }],
  ['02:c8', { offset: 0x70485, hex: '9cd7b100' }],
  ['02:c9', { offset: 0x70489, hex: 'bb9f9b00' }],
  ['02:ca', { offset: 0x7048d, hex: 'b39bf6aab100' }],
  ['02:cc', { offset: 0x70498, hex: 'aea1b700' }],
  ['02:cd', { offset: 0x7049c, hex: 'a095b600' }],
  ['02:ce', { offset: 0x704a0, hex: '909bf7b600' }],
  ['02:d0', { offset: 0x704a9, hex: '04ac91035c5004ac91035c00' }],
  ['02:d1', { offset: 0x704b5, hex: '02c19abd5c00' }],
  ['02:d2', { offset: 0x704bb, hex: 'd4b592be5b7e00' }],
  ['02:d3', { offset: 0x704c2, hex: '919fda96ae9c00' }],
  ['02:d4', { offset: 0x704c9, hex: 'd4d591ae9c955b00' }],
  ['02:d5', { offset: 0x704d1, hex: '7ddda49fd05000' }],
  ['02:d6', { offset: 0x704d8, hex: '181c181d19c200' }],
  ['02:d7', { offset: 0x704df, hex: '5002d6d000' }],
  ['02:d8', { offset: 0x704e4, hex: 'a4b7ae9c955b00' }],
  ['02:d9', { offset: 0x704eb, hex: '5096f892a95000' }],
]);

export function compileTextDraft(rom, draft) {
  assert.equal(createHash('sha256').update(rom).digest('hex'), draft.sourceSha256);
  const pointer = Number(draft.pointerOffset);
  assert.ok(pointer >= 0x70000 && pointer < 0x702eb && (pointer - 0x70000) % 3 === 0);
  const start = rom.readUIntLE(pointer, 3) - 0xc00000;
  const end = rom.readUIntLE(pointer + 3, 3) - 0xc00000;
  assert.ok(start >= 0 && end > start && end <= rom.length, 'Invalid indexed source bounds');
  assert.ok([0, 1, 2].includes(rom[start]), 'Draft compiler requires raw, LZ or Huffman source');
  for (const reference of staticReferences.values()) {
    assert.equal(rom.subarray(reference.offset, reference.offset + reference.hex.length / 2).toString('hex'), reference.hex);
  }
  let decoded;
  if (rom[start] === 0) decoded = rom.subarray(start + 1, end);
  else if (rom[start] === 1) decoded = decodeLz(rom.subarray(start + 1, end)).bytes;
  else {
    const candidates = huffmanCandidates(rom.subarray(start + 1, end), huffmanCodes(rom));
    const selected = draft.decodedBytes ? candidates.find(candidate => candidate.bytes.length === draft.decodedBytes)
      : candidates.length === 1 ? candidates[0] : undefined;
    assert.ok(selected, 'Huffman draft requires one exact boundary or an explicit decodedBytes value');
    decoded = selected.bytes;
  }
  const records = splitRecords(decoded);
  const complete = draft.complete !== false;
  const selected = complete ? records : records.filter(record => Object.hasOwn(draft.records, record.index));
  assert.equal(Object.keys(draft.records).length, selected.length, 'Draft must cover every selected indexed record');
  assert.ok(selected.length > 0, 'Draft has no indexed records');
  const entries = selected.map(record => {
    const bytes = Buffer.from(record.originalHex, 'hex');
    const controls = [];
    for (let cursor = 0; cursor < bytes.length; cursor++) {
      const byte = bytes[cursor];
      if (isGlyphPrefix(byte)) cursor++;
      else if (byte === 2) {
        const reference = bytes[++cursor].toString(16).padStart(2, '0');
        if (!staticReferences.has(`02:${reference}`)) controls.push(`02${reference}`);
      } else if (byte < 0x18) controls.push(byte.toString(16).padStart(2, '0'));
    }
    const translation = draft.records[record.index];
    assert.equal(typeof translation, 'string', `Missing translation ${record.index}`);
    const parts = translation.replaceAll('\n', '[01]').split(/\[([0-9a-f]+)\]/);
    const meaningful = controls.filter(control => !['03', '04'].includes(control));
    assert.deepEqual(parts.filter((part, index) => index % 2 === 1), meaningful, `Draft controls differ: ${record.index}`);
    const segments = [];
    let controlIndex = 0;
    for (let index = 0; index < parts.length; index += 2) {
      assert.ok(!/[\[\]]/.test(parts[index]), 'Unrecognized draft placeholder');
      for (const part of parts[index].split(/([ \u3000]+)/)) {
        if (!part) continue;
        segments.push(/^[ \u3000]+$/.test(part)
          ? { hex: Buffer.alloc([...part].reduce((width, character) => width + (character === '\u3000' ? 2 : 1), 0), 0x50).toString('hex') }
          : { text: part });
      }
      while (['03', '04'].includes(controls[controlIndex])) segments.push({ hex: controls[controlIndex++] });
      if (index + 1 < parts.length) {
        assert.equal(controls[controlIndex++], parts[index + 1]);
        segments.push({ hex: parts[index + 1] });
      }
    }
    assert.equal(controlIndex, controls.length);
    return { offset: hex(record.decodedOffset + (rom[start] === 0 ? start + 1 : 0)), originalHex: record.originalHex, segments };
  });
  return { name: draft.name, pointerOffset: draft.pointerOffset, target: draft.target, decodedBytes: decoded.length, complete, entries };
}

export function splitRecords(bytes) {
  const records = [];
  let begin = 0;
  for (let cursor = 0; cursor < bytes.length; cursor++) {
    const byte = bytes[cursor];
    if (isGlyphPrefix(byte) || byte === 2) {
      assert.ok(cursor + 1 < bytes.length, 'Truncated glyph or dictionary reference');
      cursor++;
    } else if (byte === 0) {
      records.push({ index: records.length, decodedOffset: begin, originalHex: bytes.subarray(begin, cursor).toString('hex') });
      begin = cursor + 1;
    }
  }
  assert.equal(begin, bytes.length, 'Unterminated text record');
  return records;
}

function huffmanCandidates(input, codes) {
  const byBits = new Map([...codes].map(([byte, bits]) => [bits.join(''), byte]));
  const output = [];
  const candidates = [];
  let pending = '';
  for (let bitOffset = 0; bitOffset < input.length * 8; bitOffset++) {
    pending += (input[bitOffset >> 3] >> (7 - (bitOffset & 7))) & 1;
    if (!byBits.has(pending)) continue;
    output.push(byBits.get(pending));
    pending = '';
    if (input.length * 8 - bitOffset - 1 >= 8) continue;
    const bytes = Buffer.from(output);
    if (!encodeHuffman(bytes, codes).bytes.equals(input)) continue;
    try {
      const records = splitRecords(bytes);
      candidates.push({ bytes, records, bitLength: bitOffset + 1 });
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
    }
  }
  assert.ok(candidates.length, 'No complete, byte-exact Huffman text boundary');
  return candidates;
}

export function catalog(rom, manifest, opening) {
  assert.equal(createHash('sha256').update(rom).digest('hex'), manifest.sourceSha256);
  const codes = huffmanCodes(rom);
  const definitions = [...manifest.nameBlocks, ...manifest.textBlocks,
    ...(manifest.textDrafts ?? []).map(filename => compileTextDraft(rom, JSON.parse(fs.readFileSync(path.join(root, 'translations', filename)))))];
  const blocks = [];
  for (let pointer = 0x70000; pointer < 0x702eb; pointer += 3) {
    const start = rom.readUIntLE(pointer, 3) - 0xc00000;
    const end = rom.readUIntLE(pointer + 3, 3) - 0xc00000;
    const block = { pointerOffset: hex(pointer), sourceStart: hex(start), sourceEnd: hex(end), sourceType: rom[start] };
    blocks.push(block);
    try {
      assert.ok(start >= 0 && end > start && end <= rom.length, 'Invalid pointer bounds');
      const definition = definitions.find(entry => Number(entry.pointerOffset) === pointer);
      let bytes;
      if (block.sourceType === 0) bytes = rom.subarray(start + 1, end);
      else if (block.sourceType === 1) {
        const decoded = decodeLz(rom.subarray(start + 1, end));
        assert.equal(decoded.consumed, end - start - 1);
        bytes = decoded.bytes;
      } else if (block.sourceType === 2) {
        const candidates = huffmanCandidates(rom.subarray(start + 1, end), codes);
        block.boundaryCandidates = candidates.map(candidate => ({ decodedBytes: candidate.bytes.length, strings: candidate.records.length, bitLength: candidate.bitLength }));
        const selected = definition?.decodedBytes ? candidates.find(candidate => candidate.bytes.length === definition.decodedBytes)
          : candidates.length === 1 ? candidates[0] : undefined;
        if (!selected) {
          block.status = 'boundary-review';
          block.candidateRecords = candidates[0].records;
          continue;
        }
        bytes = selected.bytes;
      } else throw new Error('Unknown text encoding');
      block.decodedBytes = bytes.length;
      block.records = splitRecords(bytes);
      block.name = definition?.name;
      for (const record of block.records) {
        const offset = block.sourceType === 0 ? start + 1 + record.decodedOffset : record.decodedOffset;
        const entries = pointer === 0x70003 ? manifest.entries : definition?.entries ?? [];
        const entry = entries.find(candidate => Number(candidate.offset) === offset && candidate.originalHex === record.originalHex);
        record.status = !record.originalHex ? 'empty' : entry ? 'translated' : 'untranslated';
        if (entry) {
          record.source = entry.source;
          record.translation = entry.translation;
          record.segments = entry.segments;
        }
      }
      if (pointer === Number(opening.pointerOffset)) {
        let cursor = 0;
        for (const section of [opening, ...(opening.continuation ?? [])]) {
          const original = Buffer.from(section.originalHex, 'hex');
          assert.ok(bytes.subarray(cursor, cursor + original.length).equals(original), 'Opening source differs');
          cursor += original.length;
        }
        assert.equal(cursor, bytes.length, 'Opening manifest leaves an uncovered tail');
        for (const record of block.records) if (record.status !== 'empty') record.status = 'translated-opening';
        block.translationFile = 'translations/opening.zh-Hant.json';
      }
      block.status = 'extracted';
    } catch (error) {
      block.status = 'decode-review';
      block.error = error.message;
    }
  }
  const records = blocks.flatMap(block => block.records ?? []);
  return {
    sourceSha256: manifest.sourceSha256,
    scope: 'Known indexed text table only; inline menus, image text and undiscovered text are not included.',
    completeTranslation: false,
    summary: {
      blocks: blocks.length,
      extractedBlocks: blocks.filter(block => block.status === 'extracted').length,
      reviewBlocks: blocks.filter(block => block.status !== 'extracted').length,
      extractedRecords: records.length,
      translatedRecords: records.filter(record => record.status === 'translated' || record.status === 'translated-opening').length,
      untranslatedRecords: records.filter(record => record.status === 'untranslated').length,
      emptyRecords: records.filter(record => record.status === 'empty').length,
    },
    blocks,
  };
}

export function renderRecord(rom, bytes, dictionary) {
  const lines = [[]];
  let katakana = false;
  const append = pixels => {
    if (lines.at(-1).length === 24) lines.push([]);
    lines.at(-1).push(pixels);
  };
  const parse = (input, depth = 0) => {
    assert.ok(depth < 16, 'Recursive dictionary reference');
    for (let cursor = 0; cursor < input.length; cursor++) {
      const byte = input[cursor];
      if (byte === 1) { lines.push([]); continue; }
      if (byte === 3 || byte === 4) { katakana = byte === 4; continue; }
      if (byte === 2) {
        const reference = input[++cursor] - 0xa0;
        assert.ok(dictionary[reference], 'Unknown dictionary reference');
        parse(Buffer.from(dictionary[reference].originalHex, 'hex'), depth + 1);
        continue;
      }
      if (byte < 0x18) {
        if ([9, 10, 17].includes(byte)) append(new Uint8Array(192));
        continue;
      }
      if (isGlyphPrefix(byte)) {
        const code = (byte - 0x17) * 256 + input[++cursor];
        append(decodeGlyph(rom, 8 + ((code - 0x100) >> 6), code & 63));
      } else if (byte >= 0x50 && byte <= 0x8d) append(decodeGlyph(rom, 1, byte - 0x50));
      else if (byte >= 0x90 && byte <= 0xbe) append(decodeGlyph(rom, katakana ? 5 : 2, byte - 0x90));
      else if (byte >= 0xd0 && byte <= 0xe7) {
        const index = byte - 0xd0;
        const base = decodeGlyph(rom, katakana ? 5 : 2, rom[0x4a949 + index]);
        const marks = decodeGlyph(rom, katakana ? 6 : 3, index);
        append(Uint8Array.from(base, (pixel, offset) => marks[offset] & 1 ? marks[offset] : pixel));
      } else if (byte >= 0xf0 && byte <= (katakana ? 0xf8 : 0xf9)) append(decodeGlyph(rom, katakana ? 7 : 4, byte - 0xf0));
      else throw new Error(`Unsupported display byte ${hex(byte)}`);
    }
  };
  parse(bytes);
  const width = 24 * 12 + 16;
  const height = lines.length * 20 + 16;
  const pixels = Buffer.alloc(width * height, 255);
  lines.forEach((line, lineIndex) => line.forEach((glyph, characterIndex) => {
    for (let row = 0; row < 16; row++) for (let column = 0; column < 12; column++) {
      if (glyph[row * 12 + column] & 2) pixels[(lineIndex * 20 + row + 8) * width + characterIndex * 12 + column + 8] = 0;
    }
  }));
  return Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), pixels]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, destination] = process.argv.slice(2);
  if (command === 'self-test') {
    assert.deepEqual(splitRecords(Buffer.from('1c000002a00000', 'hex')).map(record => record.originalHex), ['1c00', '02a0', '']);
    assert.deepEqual(splitRecords(Buffer.from('240025ff0000', 'hex')).map(record => record.originalHex), ['240025ff', '']);
    assert.throws(() => splitRecords(Buffer.from('1c', 'hex')), /Truncated/);
    assert.throws(() => splitRecords(Buffer.from('90', 'hex')), /Unterminated/);
    console.log('PASS: multibyte payloads, dictionary references, empty records and truncated records');
  } else if (['extract', 'check-complete', 'render'].includes(command) && destination) {
    const rom = fs.readFileSync(path.join(root, 'assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc'));
    const manifest = JSON.parse(fs.readFileSync(path.resolve(root, process.env.MOMOTARO_MANIFEST ?? 'translations/menu.zh-Hant.json')));
    const opening = JSON.parse(fs.readFileSync(path.join(root, 'translations/opening.zh-Hant.json')));
    const result = catalog(rom, manifest, opening);
    if (command === 'render') {
      fs.mkdirSync(destination);
      const requested = process.argv[4];
      const failures = [];
      for (const block of result.blocks.filter(block => !requested || block.pointerOffset === requested)) {
        for (const record of block.records ?? []) {
          if (!record.originalHex) continue;
          const name = `${block.pointerOffset}-${record.index}`;
          try {
            const image = renderRecord(rom, Buffer.from(record.originalHex, 'hex'), result.blocks[0].records);
            fs.writeFileSync(path.join(destination, `${name}.pgm`), image, { flag: 'wx' });
          } catch (error) {
            failures.push({ name, error: error.message });
          }
        }
      }
      fs.writeFileSync(path.join(destination, 'review.json'), JSON.stringify({ note: 'Source review only, not gameplay layout; dynamic values are blank. OCR requires review.', failures }, null, 2), { flag: 'wx' });
      console.log('Source previews requiring review:', failures.length);
    } else fs.writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify(result.summary, null, 2));
    if (command === 'check-complete') {
      assert.equal(result.summary.reviewBlocks, 0, 'Unresolved text blocks remain');
      assert.equal(result.summary.untranslatedRecords, 0, 'Untranslated indexed records remain');
      throw new Error('Indexed coverage alone cannot certify inline menus, image text or a full playthrough');
    }
  } else throw new Error('Usage: node tools/text-catalog.mjs self-test | extract NEW_OUTPUT.json | check-complete NEW_OUTPUT.json | render NEW_DIRECTORY [POINTER]');
}