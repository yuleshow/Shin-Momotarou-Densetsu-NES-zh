import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function huffmanCodes(rom) {
  const codes = new Map();
  const walk = (node, bits, ancestors) => {
    assert.ok(node < 255 && !ancestors.has(node), 'Invalid Huffman tree');
    const visited = new Set([...ancestors, node]);
    for (const branch of [0, 1]) {
      const child = rom[(branch ? 0xbf0b : 0xbdec) + node];
      const internal = rom[(branch ? 0xc00a : 0xbeeb) + (node >> 3)] & (0x80 >> (node & 7));
      const sequence = [...bits, branch];
      if (internal) walk(child, sequence, visited);
      else {
        assert.ok(!codes.has(child), `Duplicate leaf ${child}`);
        codes.set(child, sequence);
      }
    }
  };
  walk(0, [], new Set());
  return codes;
}

export function encodeHuffman(bytes, codes) {
  const bits = [...bytes].flatMap(byte => {
    assert.ok(codes.has(byte), `No Huffman code for ${byte}`);
    return codes.get(byte);
  });
  const encoded = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => encoded[index >> 3] |= bit << (7 - (index & 7)));
  return { bytes: encoded, bitLength: bits.length };
}

export function decodeHuffman(rom, input, count) {
  const output = [];
  let bitOffset = 0;
  while (output.length < count) {
    let node = 0;
    for (let depth = 0; ; depth++) {
      assert.ok(depth < 255 && bitOffset < input.length * 8, 'Truncated or invalid Huffman stream');
      const branch = (input[bitOffset >> 3] >> (7 - (bitOffset & 7))) & 1;
      bitOffset++;
      const child = rom[(branch ? 0xbf0b : 0xbdec) + node];
      const internal = rom[(branch ? 0xc00a : 0xbeeb) + (node >> 3)] & (0x80 >> (node & 7));
      if (!internal) {
        output.push(child);
        break;
      }
      node = child;
    }
  }
  return { bytes: Buffer.from(output), bitLength: bitOffset };
}

export function decodeLz(input, count = Infinity) {
  const dictionary = Buffer.alloc(256);
  const output = [];
  let writeCursor = 0xef;
  let cursor = 0;
  let flags = 0;
  let mask = 0;
  let lengthByte = 0;
  let lowLengthPending = false;
  let outputCursor = 0;
  const read = () => {
    assert.ok(cursor < input.length, 'Truncated LZ stream');
    return input[cursor++];
  };
  const emit = value => {
    output.push(value);
    outputCursor++;
    dictionary[writeCursor] = value;
    writeCursor = (writeCursor + 1) & 255;
  };
  while (outputCursor < count && cursor < input.length) {
    if (!mask) {
      flags = read();
      mask = 0x80;
    }
    const value = read();
    const literal = flags & mask;
    mask >>= 1;
    if (literal) emit(value);
    else {
      let length;
      if (lowLengthPending) length = (lengthByte & 15) + 2;
      else {
        lengthByte = read();
        length = (lengthByte >> 4) + 2;
      }
      lowLengthPending = !lowLengthPending;
      for (let index = 0; index < length && outputCursor < count; index++) emit(dictionary[(value + index) & 255]);
    }
  }
  assert.ok(count === Infinity || outputCursor === count, 'Truncated LZ stream');
  return { bytes: Buffer.from(output), consumed: cursor };
}

export function readLzTextBlock(rom, pointerOffset) {
  assert.ok(Number.isInteger(pointerOffset) && pointerOffset >= 0x70000 && pointerOffset < 0x702eb && (pointerOffset - 0x70000) % 3 === 0);
  const start = rom.readUIntLE(pointerOffset, 3) - 0xc00000;
  const end = rom.readUIntLE(pointerOffset + 3, 3) - 0xc00000;
  assert.ok(start >= 0 && end > start && end <= rom.length);
  assert.equal(rom[start], 1, 'Expected type-1 LZ text block');
  const decoded = decodeLz(rom.subarray(start + 1, end));
  assert.equal(decoded.consumed, end - start - 1);
  return { pointerOffset, start, end, bytes: decoded.bytes };
}

export function encodeLzLiterals(input) {
  const pieces = [];
  for (let cursor = 0; cursor < input.length; cursor += 8) pieces.push(Buffer.from([0xff]), input.subarray(cursor, cursor + 8));
  return Buffer.concat(pieces);
}

function verifyLzTrace(rom, filename, reportFilename) {
  const trace = fs.readFileSync(filename);
  assert.equal(trace.length % 16, 0);
  const streams = [];
  const directText = [];
  let stream;
  let mask = 0;
  let flags = 0;
  let initializations = 0;
  for (let cursor = 0; cursor < trace.length; cursor += 16) {
    const pc = trace.readUInt32LE(cursor);
    const address = trace.readUInt32LE(cursor + 4);
    const value = trace.readUInt32LE(cursor + 8);
    if (pc === 0x80bcfa && trace.readUInt32LE(cursor + 12) === 0) {
      stream = undefined;
      mask = 0;
      initializations++;
      continue;
    }
    if (pc === 0x849e59 && address >= 0x7e0000) directText.push([address.toString(16), value.toString(16)]);
    if ([0x80bd3d, 0x80bd51, 0x80bd67].includes(pc) && address < 0x200000 && address !== 0xffea) {
      if (!stream || address !== stream.start + stream.input.length) {
        stream = { start: address, input: [], output: [], startsWithFlags: pc === 0x80bd3d };
        streams.push(stream);
        mask = 0;
      }
      stream.input.push(value);
      if (pc === 0x80bd3d) {
        flags = value;
        mask = 0x80;
      } else if (pc === 0x80bd51) {
        if (flags & mask) stream.output.push(value);
        mask >>= 1;
      }
    } else if (pc === 0x80bd30 && address >= 0x7e0200 && address < 0x7e0300 && trace.readUInt32LE(cursor + 12) === 1 && stream) stream.output.push(value);
  }
  let verified = 0;
  const fixtures = new Map();
  for (const candidate of streams) {
    if (!candidate.startsWithFlags || !candidate.output.length) continue;
    assert.deepEqual(Buffer.from(candidate.input), rom.subarray(candidate.start, candidate.start + candidate.input.length), 'Captured source bytes differ from ROM');
    const decoded = decodeLz(Buffer.from(candidate.input), candidate.output.length);
    assert.deepEqual(decoded.bytes, Buffer.from(candidate.output), `LZ mismatch at ${candidate.start.toString(16)}`);
    verified++;
    const fixture = {
      offset: candidate.start,
      inputBytes: candidate.input.length,
      outputBytes: candidate.output.length,
      outputSha256: createHash('sha256').update(Buffer.from(candidate.output)).digest('hex'),
    };
    fixtures.set(JSON.stringify(fixture), fixture);
    if (candidate.start >= 0x70000 && candidate.start < 0xb0000) {
      console.log(JSON.stringify({ start: `0x${candidate.start.toString(16)}`, inputBytes: candidate.input.length, outputBytes: candidate.output.length, decodedPreviewHex: decoded.bytes.subarray(0, 256).toString('hex') }));
    }
  }
  assert.ok(verified > 0);
  assert.ok(initializations > 0, 'Trace must include decompressor initialization events');
  if (reportFilename) {
    fs.mkdirSync(path.dirname(reportFilename), { recursive: true });
    fs.writeFileSync(reportFilename, JSON.stringify({
      sourceSha256: createHash('sha256').update(rom).digest('hex'),
      coreRevision: '1bcc369e89f08243e0a462882fb1f3e42e51de3a',
      scenario: '1380-frame boot with Start at 1201, then 1080 frames with A at 1; initialization-aware ROM and dictionary read trace',
      verifiedStreams: verified,
      fixtures: [...fixtures.values()],
    }, null, 2), { flag: 'wx' });
  }
  console.log(JSON.stringify({ verifiedStreams: verified, initializations, directText }));
}

function verifyTrace(rom, filename) {
  const trace = fs.readFileSync(filename);
  assert.equal(trace.length % 16, 0);
  const input = [];
  const output = [];
  const ranges = [];
  let pending;
  for (let cursor = 0; cursor < trace.length; cursor += 16) {
    const pc = trace.readUInt32LE(cursor);
    const address = trace.readUInt32LE(cursor + 4);
    const value = trace.readUInt32LE(cursor + 8);
    if (pc < 0x80bd98 || pc > 0x80bde4) continue;
    if (address >= 0x70000) {
      input.push(value);
      const last = ranges.at(-1);
      if (last && last.end + 1 === address) last.end = address;
      else ranges.push({ start: address, end: address });
    } else if (address >= 0xbdec && address < 0xbeeb) {
      pending = { node: address - 0xbdec, child: value, branch: 0 };
    } else if (address >= 0xbf0b && address < 0xc00a) {
      pending = { node: address - 0xbf0b, child: value, branch: 1 };
    } else if (pending && address === (pending.branch ? 0xc00a : 0xbeeb) + (pending.node >> 3)) {
      if (!(value & (0x80 >> (pending.node & 7)))) output.push(pending.child);
      pending = undefined;
    }
  }
  assert.ok(input.length > 0 && output.length > 0, 'No Huffman reads found');
  assert.equal(ranges.length, 1, 'Trace spans multiple streams; verify each separately');
  const decoded = decodeHuffman(rom, Buffer.from(input), output.length);
  assert.deepEqual(decoded.bytes, Buffer.from(output));
  const encoded = encodeHuffman(decoded.bytes, huffmanCodes(rom));
  assert.equal(encoded.bitLength, decoded.bitLength);
  for (let bit = 0; bit < decoded.bitLength; bit++) {
    assert.equal((encoded.bytes[bit >> 3] >> (7 - (bit & 7))) & 1, (input[bit >> 3] >> (7 - (bit & 7))) & 1);
  }
  console.log(JSON.stringify({ verifiedRuntimeBytes: output.length, compressedRange: ranges.map(range => ({ start: `0x${range.start.toString(16)}`, end: `0x${range.end.toString(16)}` })), decodedHex: decoded.bytes.toString('hex') }, null, 2));
}

function verifyOpeningTraces(rom, originalTrace, translatedTrace, buildFilename, reportFilename, allowPartial = false) {
  const metadata = JSON.parse(fs.readFileSync(buildFilename, 'utf8'));
  assert.equal(metadata.opening?.translated, true);
  assert.equal(createHash('sha256').update(rom).digest('hex'), metadata.sourceSha256);
  const target = fs.readFileSync(path.join(path.dirname(buildFilename), metadata.romFilename));
  assert.equal(createHash('sha256').update(target).digest('hex'), metadata.targetSha256);
  const originalBlock = readLzTextBlock(rom, Number(metadata.opening.pointerOffset));
  const relocated = Number(metadata.opening.relocatedOffset);
  const translatedBlock = decodeLz(target.subarray(relocated + 1, relocated + 1 + metadata.opening.compressedBytes)).bytes;
  const collect = (filename, pointer, expected) => {
    const trace = fs.readFileSync(filename);
    assert.equal(trace.length % 16, 0);
    const streams = [];
    let active;
    for (let cursor = 0; cursor < trace.length; cursor += 16) {
      const pc = trace.readUInt32LE(cursor);
      const value = trace.readUInt32LE(cursor + 8);
      const kind = trace.readUInt32LE(cursor + 12);
      if (pc === 0x80bcfa && kind === 0) {
        active = value === pointer ? [] : undefined;
        if (active) streams.push(active);
      }
      if (pc === 0x80bd36 && kind === 0x80000001 && active) active.push(value);
    }
    assert.ok(streams.length > 0, 'No matching decoded-output trace');
    const decoded = streams.map(bytes => Buffer.from(bytes));
    for (const bytes of decoded) assert.ok(bytes.equals(expected.subarray(0, bytes.length)), 'Runtime output differs from decoded ROM');
    return decoded.sort((left, right) => right.length - left.length)[0];
  };
  const originalOutput = collect(originalTrace, originalBlock.start + 1 + 0xc00000, originalBlock.bytes);
  const translatedOutput = collect(translatedTrace, relocated + 1 + 0xc00000, translatedBlock);
  const suffix = originalOutput.subarray(metadata.opening.originalParagraphBytes);
  const completeBlockTranslated = metadata.opening.originalParagraphBytes === originalBlock.bytes.length;
  const completeBlockRuntimeVerified = completeBlockTranslated && originalOutput.length === originalBlock.bytes.length && translatedOutput.length === translatedBlock.length;
  if (completeBlockTranslated && !allowPartial) {
    assert.equal(originalOutput.length, originalBlock.bytes.length, 'Original trace must cover the complete block');
    assert.equal(translatedOutput.length, translatedBlock.length, 'Translated trace must cover the complete block');
  } else if (!completeBlockTranslated) {
    assert.ok(suffix.length > 10, 'Trace must extend beyond the translated prefix');
    assert.ok(suffix.equals(translatedOutput.subarray(metadata.opening.replacementParagraphBytes, metadata.opening.replacementParagraphBytes + suffix.length)), 'Following runtime text differs');
  }
  const report = {
    sourceSha256: metadata.sourceSha256,
    targetSha256: metadata.targetSha256,
    originalTraceSha256: createHash('sha256').update(fs.readFileSync(originalTrace)).digest('hex'),
    translatedTraceSha256: createHash('sha256').update(fs.readFileSync(translatedTrace)).digest('hex'),
    followingRuntimeBytesIdentical: suffix.length,
    originalRuntimeBytes: originalOutput.length,
    translatedRuntimeBytes: translatedOutput.length,
    originalBlockBytes: originalBlock.bytes.length,
    translatedBlockBytes: translatedBlock.length,
    completeBlockTranslated,
    completeBlockRuntimeVerified,
    allCapturedOutputsMatchDecodedRom: true,
    visualTimingIdentical: false,
  };
  fs.writeFileSync(reportFilename, JSON.stringify(report, null, 2), { flag: 'wx' });
  const coverage = completeBlockTranslated
    ? completeBlockRuntimeVerified ? 'the entire translated opening block was consumed' : `PARTIAL coverage: ${translatedOutput.length}/${translatedBlock.length} translated bytes consumed; later events are NOT runtime verified`
    : `${suffix.length} following dialogue bytes match the original`;
  console.log(`PASS: all captured decoded outputs match ROM; ${coverage}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const rom = fs.readFileSync(new URL('../assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc', import.meta.url));
  if (command === 'self-test') {
    const codes = huffmanCodes(rom);
    assert.equal(codes.size, 256);
    const source = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    const encoded = encodeHuffman(source, codes);
    assert.deepEqual(decodeHuffman(rom, encoded.bytes, source.length).bytes, source);
    assert.throws(() => decodeHuffman(rom, Buffer.alloc(0), 1), /Truncated/);
    assert.deepEqual(decodeLz(encodeLzLiterals(source), source.length).bytes, source);
    assert.deepEqual(decodeLz(encodeLzLiterals(source)).bytes, source);
    assert.deepEqual(decodeLz(Buffer.from([0x80, 0x41, 0xef, 0x30, 0xef]), 8).bytes, Buffer.from('AAAAAAAA'));
    assert.throws(() => decodeLz(Buffer.alloc(0), 1), /Truncated/);
    console.log('All 256 byte values round-trip through Huffman and literal LZ; overlapping dictionary copies verified.');
  } else if (command === 'verify-trace' && args.length === 1) verifyTrace(rom, args[0]);
  else if (command === 'verify-lz-trace' && args.length >= 1 && args.length <= 2) verifyLzTrace(rom, args[0], args[1]);
  else if (command === 'verify-opening-traces' && (args.length === 4 || args.length === 5)) {
    assert.ok(args.length === 4 || args[4] === '--allow-partial', 'Unknown trace verification option');
    verifyOpeningTraces(rom, ...args.slice(0, 4), args[4] === '--allow-partial');
  }
  else if (command === 'verify-fixtures' && args.length === 1) {
    const report = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    assert.equal(createHash('sha256').update(rom).digest('hex'), report.sourceSha256);
    for (const fixture of report.fixtures) {
      const decoded = decodeLz(rom.subarray(fixture.offset, fixture.offset + fixture.inputBytes), fixture.outputBytes);
      assert.equal(createHash('sha256').update(decoded.bytes).digest('hex'), fixture.outputSha256, `Fixture mismatch at ${fixture.offset.toString(16)}`);
    }
    console.log(`Verified ${report.fixtures.length} unique runtime-derived LZ fixtures.`);
  }
  else if (command === 'extract-block' && args.length === 2) {
    const block = readLzTextBlock(rom, Number(args[0]));
    const rebuilt = encodeLzLiterals(block.bytes);
    assert.deepEqual(decodeLz(rebuilt).bytes, block.bytes);
    const document = { pointerOffset: block.pointerOffset, sourceStart: block.start, sourceEnd: block.end, decodedBytes: block.bytes.length, decodedHex: block.bytes.toString('hex') };
    fs.writeFileSync(args[1], JSON.stringify(document, null, 2), { flag: 'wx' });
    console.log(`Extracted ${block.bytes.length} bytes; literal-LZ rebuild verified: ${args[1]}`);
  } else throw new Error('Usage: node tools/text-codec.mjs self-test | verify-trace TRACE.bin | verify-lz-trace TRACE.bin [REPORT.json] | verify-opening-traces ORIGINAL_TRACE TRANSLATED_TRACE BUILD.json REPORT.json [--allow-partial] | verify-fixtures REPORT.json | extract-block POINTER_OFFSET OUTPUT.json');
}