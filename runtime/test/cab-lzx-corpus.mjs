#!/usr/bin/env node
// Builds the conformance corpus that pins the Android installer to the web build's installer.
//
// `installer/src/{iso9660,cab,lzx,msi,cfb}.ts` is the reference: it installs real discs, and its LZX
// decoder is verified byte-for-byte against cabextract. The Android launcher needs the same decoders in
// Kotlin (`android/app/src/main/java/org/shrek2/launcher/install/`), and a divergence there would only
// surface as a player's install failing half-way through on a phone. So this script synthesises a
// disc-shaped image -- a Joliet ISO 9660 volume containing an MSI database and an LZX-compressed
// cabinet, laid out the way the retail disc is -- and records everything the Kotlin code must produce.
//
// The image is generated data, not a game asset: the payload is synthetic text/binary, and the disc
// structure is this file's own invention. Nothing here is derived from the game.
//
//   node runtime/test/cab-lzx-corpus.mjs [--out <dir>]
//
// It writes <dir>/shrek2.iso and <dir>/manifest.json, and *self-checks* the corpus by running the
// TypeScript installer over the image: if the reference cannot install it, the corpus is wrong.
import { execFileSync } from "node:child_process";
// The reference decoder, for the generator's own round-trip check (below).
import { LzxDecoder } from "../../installer/src/lzx.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? (args[outIdx + 1].startsWith("/") ? args[outIdx + 1] : join(ROOT, args[outIdx + 1])) : join(HERE, "fixtures");

// ---------------------------------------------------------------------------------------------
// Deterministic payloads
// ---------------------------------------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

/** Text-like data: what game files look like, and what LZX compresses well (long matches). */
function textPayload(size, seed) {
  const r = rng(seed);
  const words = ["shrek", "fiona", "donkey", "gingy", "puss", "dragon", "farquaad", "duloc", "swamp", "ogre"];
  const out = Buffer.alloc(size);
  let o = 0;
  let line = 0;
  while (o < size) {
    for (let i = 0; i < 6 && o < size; i++) {
      const s = `${words[r() % words.length]} ${line % 997} ${(r() >>> 0).toString(16)} `;
      const b = Buffer.from(s, "latin1");
      b.copy(out, o, 0, Math.min(b.length, size - o));
      o += Math.min(b.length, size - o);
    }
    if (o < size) out[o++] = 0x0a;
    line++;
  }
  return out;
}

/** Binary data with runs, repeats and noise: forces the encoder to emit matches, not just literals. */
function binaryPayload(size, seed) {
  const r = rng(seed);
  const out = Buffer.alloc(size);
  let o = 0;
  while (o < size) {
    const kind = r() % 4;
    const n = Math.min(size - o, 1 + (r() % 300));
    if (kind === 0) {
      out.fill(r() & 0xff, o, o + n);
    } else if (kind === 1 && o > 64) {
      const from = r() % (o - 32);
      for (let i = 0; i < n; i++) out[o + i] = out[from + i] ?? 0;
    } else {
      for (let i = 0; i < n; i++) out[o + i] = (r() >>> 24) & 0xff;
    }
    o += n;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// MD5 (also checked against the JVM's MessageDigest by the Kotlin test)
// ---------------------------------------------------------------------------------------------

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

function md5(data) {
  const n = data.length;
  const padded = Buffer.alloc(((n + 8) >> 6) * 64 + 64);
  data.copy(padded);
  padded[n] = 0x80;
  const bits = n * 8;
  padded.writeUInt32LE(bits >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor(bits / 2 ** 32), padded.length - 4);
  let a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476 | 0;
  for (let off = 0; off < padded.length; off += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const t = d;
      d = c;
      c = b;
      const x = (a + f + MD5_K[i] + padded.readInt32LE(off + g * 4)) | 0;
      b = (b + ((x << MD5_S[i]) | (x >>> (32 - MD5_S[i])))) | 0;
      a = t;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = Buffer.alloc(16);
  [a0, b0, c0, d0].forEach((v, i) => out.writeInt32LE(v, i * 4));
  return out;
}

const hex = (b) => Buffer.from(b).toString("hex");

// ---------------------------------------------------------------------------------------------
// LZX encoder (MS-CAB LZX, verbatim blocks only)
// ---------------------------------------------------------------------------------------------
//
// The decoder's contract, as `Lzx.kt` implements it:
//   * the stream is a sequence of 16-bit words, each word read little-endian, bits consumed MSB-first;
//   * each CFDATA block (one output frame) starts on a 16-bit boundary;
//   * the very first frame starts with the 1-bit Intel-E8 flag (0 = "no file size", so no E8 rewrite);
//   * a block header is 3 bits of type + 24 bits of length (16 then 8);
//   * code lengths are deltas from the *previous block's* lengths for the same symbol index, coded
//     with a pretree, with runs 17/18 (zeros) and 19 (repeats).

class BitWriter {
  // The LZX bit stream is a sequence of 16-bit words stored little-endian on disk, with bits consumed
  // MSB-first *within* the word: the first bit is bit 15 of word 0. Collect 16 bits, then emit the
  // word low byte first.
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.n = 0;
  }
  bit(b) {
    this.acc = ((this.acc << 1) | (b & 1)) & 0xffff;
    if (++this.n === 16) {
      this.bytes.push(this.acc & 0xff, (this.acc >> 8) & 0xff); // words are little-endian on disk
      this.acc = 0;
      this.n = 0;
    }
  }
  bits(value, count) {
    for (let i = count - 1; i >= 0; i--) this.bit((value >>> i) & 1);
  }
  /** Pad with zeros to a whole word: every frame/block starts on a 16-bit boundary. */
  align16() {
    while (this.n !== 0) this.bit(0);
  }
  take() {
    return Buffer.from(this.bytes);
  }
}

/** Canonical Huffman codes for a code-length table (what the decoder rebuilds from those lengths). */
function canonicalCodes(lens) {
  const count = new Array(17).fill(0);
  for (const l of lens) count[l]++;
  count[0] = 0;
  let code = 0;
  const first = new Array(17).fill(0);
  for (let len = 1; len <= 16; len++) {
    code = (code + count[len - 1]) << 1;
    first[len] = code;
  }
  const next = first.slice();
  const codes = new Array(lens.length).fill(0);
  for (let s = 0; s < lens.length; s++) if (lens[s]) codes[s] = next[lens[s]]++;
  return codes;
}

/** Huffman code lengths by frequency, with a complete-tree fallback when the tree would be too deep. */
function codeLengths(freqs, maxBits = 16) {
  const used = [];
  for (let s = 0; s < freqs.length; s++) if (freqs[s] > 0) used.push(s);
  const lens = new Array(freqs.length).fill(0);
  if (used.length === 0) return lens;
  if (used.length === 1) {
    // A one-symbol table is incomplete (Kraft sum 1/2) and the decoder rejects it, so pad with a
    // second, never-sent symbol: the tree is then complete and decodes correctly.
    lens[used[0]] = 1;
    lens[used[0] === 0 ? 1 : 0] = 1;
    return lens;
  }
  let nodes = used.map((s) => ({ f: freqs[s], syms: [s], children: null }));
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.f - b.f);
    const [x, y] = nodes.splice(0, 2);
    nodes.push({ f: x.f + y.f, syms: [...x.syms, ...y.syms], children: [x, y] });
  }
  const depth = new Array(freqs.length).fill(0);
  let deepest = 0;
  const walk = (node, d) => {
    if (!node.children) {
      depth[node.syms[0]] = Math.max(1, d);
      deepest = Math.max(deepest, depth[node.syms[0]]);
      return;
    }
    for (const c of node.children) walk(c, d + 1);
  };
  walk(nodes[0], 0);
  if (deepest <= maxBits) {
    for (const s of used) lens[s] = depth[s];
    return lens;
  }
  // Too deep: use a complete, balanced tree instead. With n leaves, d = floor(log2 n) and r = n - 2^d,
  // a full tree has (2^d - r) leaves at depth d and 2r at depth d + 1 (Kraft sum exactly 1).
  const n = used.length;
  const d = Math.floor(Math.log2(n));
  const r = n - 2 ** d;
  const byFreq = [...used].sort((a, b) => freqs[a] - freqs[b] || a - b); // rarest first
  for (let i = 0; i < byFreq.length; i++) lens[byFreq[i]] = i < 2 * r ? d + 1 : d;
  return lens;
}

const POSITION_SLOTS = { 15: 30, 16: 32, 17: 34, 18: 36, 19: 38, 20: 42, 21: 50 };
const EXTRA_BITS = new Array(52).fill(0);
const POSITION_BASE = new Array(52).fill(0);
{
  let j = 0;
  for (let i = 0; i < 52; i += 2) {
    EXTRA_BITS[i] = j;
    EXTRA_BITS[i + 1] = j;
    if (i !== 0 && j < 17) j++;
  }
  let base = 0;
  for (let i = 0; i < 52; i++) {
    POSITION_BASE[i] = base;
    base += 1 << EXTRA_BITS[i];
  }
}

function positionSlot(off) {
  for (let s = 3; s < 52; s++) {
    if (off <= POSITION_BASE[s] - 2 + (1 << EXTRA_BITS[s]) - 1) return s;
  }
  throw new Error(`position ${off} out of range`);
}

/**
 * Greedy LZ77 over the whole folder: matches of 2..257 bytes within the (persistent) window.
 *
 * Most positions look only a short way back, but every 32nd position searches the whole window: that
 * is what produces the long-distance matches (large position slots, and offsets that cross a frame or
 * wrap the window) the decoder must handle.
 */
function lz77(data, windowSize, frameSize = Infinity) {
  const ops = [];
  let i = 0;
  while (i < data.length) {
    let bestLen = 0;
    let bestOff = 0;
    // A match may not run past the frame it starts in: a block must produce exactly its own length.
    const untilFrameEnd = frameSize - (i % frameSize);
    const maxLen = Math.min(257, data.length - i, untilFrameEnd);
    const limit = Math.min(i, windowSize - 1, i % 32 === 0 ? windowSize - 1 : 96);
    for (let off = 1; off <= limit; off++) {
      let len = 0;
      while (len < maxLen && data[i + len] === data[i - off + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestOff = off;
        if (len === maxLen) break;
      }
    }
    if (bestLen >= 2) {
      ops.push({ len: bestLen, off: bestOff });
      i += bestLen;
    } else {
      ops.push({ byte: data[i] });
      i++;
    }
  }
  return ops;
}

/** Encode the delta-coded lengths of `lens[first, last)`, given what the decoder still holds. */
/**
 * Encode the delta-coded lengths of `lens[first, last)`, given what the decoder still holds.
 *
 * Every delta is sent as its own pretree symbol. The run codes (17/18/19) would compress this, but they
 * exist to shrink the table, add two more ways to get the arithmetic wrong, and a corpus does not need
 * them: the decoder handles plain symbols on an equal footing.
 */
function writeLengths(bw, lens, prev, first, last) {
  const deltas = [];
  for (let i = first; i < last; i++) deltas.push((((prev[i] ?? 0) - lens[i]) % 17 + 17) % 17);

  const preFreq = new Array(20).fill(0);
  for (const d of deltas) preFreq[d]++;
  // The transmitted tree must be complete: a single-symbol table is not (Kraft sum 1/2) and the
  // decoder rejects it. Pad with a second symbol, which is never sent.
  let used = preFreq.filter((f) => f > 0).length;
  for (let spare = 0; used < 2 && spare < 20; spare++) {
    if (preFreq[spare] === 0) {
      preFreq[spare] = 1;
      used++;
    }
  }
  const preLens = codeLengths(preFreq, 15);
  for (let s = 0; s < 20; s++) bw.bits(preLens[s], 4);
  const preCodes = canonicalCodes(preLens);
  for (const d of deltas) bw.bits(preCodes[d], preLens[d]);
}

/**
 * One LZX folder: one verbatim block per 32 KiB output frame.
 *
 * A block boundary has to coincide with a frame boundary, because the decoder restarts its bit reader
 * for every CFDATA block and pads to a whole 16-bit word in between. So each frame is its own block,
 * with its own code-length tables -- and those tables are delta-coded against the previous block's,
 * which is the cross-block state the decoder keeps.
 */
class LzxEncoder {
  constructor(windowBits) {
    this.windowBits = windowBits;
    const slots = POSITION_SLOTS[windowBits];
    if (!slots) throw new Error(`window 2^${windowBits} is not supported`);
    this.numChars = 256 + slots * 8;
  }

  /** Encode the whole folder; returns [{ frame, data }] with one entry per output frame. */
  encode(payload, frameSize) {
    // The largest offset the position slots can express: the window is 2^w bytes, but the slot table
    // stops short of the last two positions, and a decoder has no symbol for those.
    const slots = POSITION_SLOTS[this.windowBits];
    const maxOffset = POSITION_BASE[slots - 1] - 2 + (1 << EXTRA_BITS[slots - 1]) - 1;
    const ops = lz77(payload, maxOffset, frameSize);
    const zerosMain = new Uint8Array(this.numChars);
    const zerosLen = new Uint8Array(249);
    let prevMain = zerosMain;
    let prevLen = zerosLen;
    const frames = [];
    let i = 0;
    let produced = 0;
    while (produced < payload.length) {
      const frameLen = Math.min(frameSize, payload.length - produced);
      // Take the ops that belong to this frame.
      const mine = [];
      let bytes = 0;
      while (i < ops.length && bytes < frameLen) {
        mine.push(ops[i]);
        bytes += ops[i].byte !== undefined ? 1 : ops[i].len;
        i++;
      }
      if (bytes !== frameLen) throw new Error(`frame ${frames.length}: ops cover ${bytes} bytes, expected ${frameLen}`);

      const mainFreq = new Array(this.numChars).fill(0);
      const lenFreq = new Array(249).fill(0);
      for (const op of mine) {
        if (op.byte !== undefined) {
          mainFreq[op.byte]++;
        } else {
          const slot = positionSlot(op.off);
          const l = op.len - 2;
          mainFreq[256 + slot * 8 + Math.min(l, 7)]++;
          if (l >= 7) lenFreq[l - 7]++;
        }
      }
      const mainLens = codeLengths(mainFreq, 16);
      const lenLens = codeLengths(lenFreq, 16);
      const mainCodes = canonicalCodes(mainLens);
      const lenCodes = canonicalCodes(lenLens);

      const bw = new BitWriter();
      if (frames.length === 0) bw.bits(0, 1); // Intel E8: no file size (read once, from the first frame)
      bw.bits(1, 3); // verbatim block
      bw.bits((frameLen >>> 8) & 0xffff, 16);
      bw.bits(frameLen & 0xff, 8);
      writeLengths(bw, mainLens, prevMain, 0, 256);
      writeLengths(bw, mainLens, prevMain, 256, this.numChars);
      writeLengths(bw, lenLens, prevLen, 0, 249);
      for (const op of mine) {
        if (op.byte !== undefined) {
          bw.bits(mainCodes[op.byte], mainLens[op.byte]);
          continue;
        }
        const slot = positionSlot(op.off);
        const l = op.len - 2;
        const sym = 256 + slot * 8 + Math.min(l, 7);
        bw.bits(mainCodes[sym], mainLens[sym]);
        if (l >= 7) bw.bits(lenCodes[l - 7], lenLens[l - 7]);
        bw.bits(op.off - (POSITION_BASE[slot] - 2), EXTRA_BITS[slot]);
      }
      bw.align16();
      frames.push({ frame: frameLen, data: bw.take() });
      prevMain = mainLens;
      prevLen = lenLens;
      produced += frameLen;
    }
    return frames;
  }
}

// ---------------------------------------------------------------------------------------------
// CAB writer (one LZX folder, 16-bit window, one CFDATA block per 32 KiB frame)
// ---------------------------------------------------------------------------------------------

function encodeCabFrames(members, windowBits, frameSize) {
  const payload = Buffer.concat(members.map((m) => m.data));
  const pieces = new LzxEncoder(windowBits).encode(payload, frameSize);

  // Decode every block with the reference decoder: a corpus the reference cannot read proves nothing.
  const checker = new LzxDecoder(windowBits);
  let at = 0;
  for (const [i, p] of pieces.entries()) {
    const want = payload.subarray(at, at + p.frame);
    const got = Buffer.from(checker.decodeFrame(p.data, p.frame));
    if (!got.equals(want)) throw new Error(`frame ${i}: the reference LZX decoder does not reproduce the input`);
    at += p.frame;
  }

  const fileEntries = [];
  let inFolder = 0;
  for (const m of members) {
    fileEntries.push({ name: m.name, size: m.data.length, offset: inFolder });
    inFolder += m.data.length;
  }

  const headerSize = 36;
  const blocksOffset = headerSize + 8;
  let cursor = blocksOffset;
  const blockBuffers = [];
  for (const p of pieces) {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(0, 0); // checksum (the reader does not verify it)
    h.writeUInt16LE(p.data.length, 4);
    h.writeUInt16LE(p.frame, 6);
    blockBuffers.push(h, p.data);
    cursor += 8 + p.data.length;
  }
  const coffFiles = cursor;
  const fileTable = [];
  for (const e of fileEntries) {
    const rec = Buffer.alloc(16 + e.name.length + 1);
    rec.writeUInt32LE(e.size, 0);
    rec.writeUInt32LE(e.offset, 4);
    rec.writeUInt16LE(0, 8); // folder index
    rec.writeUInt16LE(0x6000, 10); // date
    rec.writeUInt16LE(0x6000, 12); // time
    rec.writeUInt16LE(0x20, 14); // attributes: archive
    Buffer.from(e.name, "latin1").copy(rec, 16);
    fileTable.push(rec);
  }
  const tableBytes = Buffer.concat(fileTable);
  const total = coffFiles + tableBytes.length;

  const header = Buffer.alloc(headerSize);
  header.write("MSCF", 0, "latin1");
  header.writeUInt32LE(0, 4);
  header.writeUInt32LE(total, 8); // cbCabinet
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(coffFiles, 16);
  header.writeUInt32LE(0, 20);
  header.writeUInt8(3, 24); // versionMinor
  header.writeUInt8(3, 25); // versionMajor
  header.writeUInt16LE(1, 26); // cFolders
  header.writeUInt16LE(fileEntries.length, 28); // cFiles
  header.writeUInt16LE(0, 30); // flags: no reserve, standalone cabinet
  header.writeUInt16LE(0, 32); // setID
  header.writeUInt16LE(0, 34); // iCabinet

  const folder = Buffer.alloc(8);
  folder.writeUInt32LE(blocksOffset, 0); // coffCabStart
  folder.writeUInt16LE(pieces.length, 4); // cCFData
  folder.writeUInt16LE(3 | (windowBits << 8), 6); // LZX with the same window
  return Buffer.concat([header, folder, ...blockBuffers, tableBytes]);
}

// ---------------------------------------------------------------------------------------------
// Compound File writer (for the MSI)
// ---------------------------------------------------------------------------------------------

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;

class CfbWriter {
  constructor() {
    this.streams = [];
  }
  add(name, data) {
    this.streams.push({ name, data });
    return this;
  }
  build() {
    const SECTOR = 512;
    const MINI = 64;
    const CUTOFF = 4096; // the reader's miniCutoff is taken from the header, same value

    const small = [];
    const big = [];
    this.streams.forEach((s, i) => (s.data.length < CUTOFF ? small : big).push(i));

    // Mini stream: every small stream, padded to the mini-sector size.
    const miniParts = [];
    const miniStart = new Map();
    let miniOff = 0;
    for (const i of small) {
      const d = this.streams[i].data;
      const padded = Buffer.alloc(Math.max(MINI, Math.ceil(d.length / MINI) * MINI));
      d.copy(padded);
      miniStart.set(i, miniOff / MINI);
      miniParts.push(padded);
      miniOff += padded.length;
    }
    const miniStream = Buffer.concat(miniParts);
    const miniFat = [];
    for (const i of small) {
      const d = this.streams[i].data;
      const n = Math.max(1, Math.ceil(d.length / MINI));
      const start = miniStart.get(i);
      for (let k = 0; k < n; k++) miniFat.push(k === n - 1 ? ENDOFCHAIN : start + k + 1);
    }
    const miniFatBytes = Buffer.alloc(Math.max(SECTOR, Math.ceil(Math.max(1, miniFat.length) * 4 / SECTOR) * SECTOR));
    miniFatBytes.fill(0xff);
    miniFat.forEach((v, i) => miniFatBytes.writeUInt32LE(v, i * 4));

    const sectors = [];
    const fat = [];
    const push = (buf) => {
      const start = sectors.length;
      const n = Math.max(1, Math.ceil(buf.length / SECTOR));
      for (let k = 0; k < n; k++) {
        const s = Buffer.alloc(SECTOR);
        buf.copy(s, 0, k * SECTOR, Math.min(buf.length, (k + 1) * SECTOR));
        sectors.push(s);
        fat.push(k === n - 1 ? ENDOFCHAIN : start + k + 1);
      }
      return start;
    };

    // Directory: entry 0 is the root, the streams follow as its children.
    const entries = [{ name: "Root Entry", type: 5, start: ENDOFCHAIN, size: 0 }];
    for (const s of this.streams) entries.push({ name: s.name, type: 2, start: ENDOFCHAIN, size: s.data.length });

    const dirStart = push(Buffer.alloc(Math.ceil((entries.length * 128) / SECTOR) * SECTOR));
    const miniStreamStart = miniStream.length ? push(miniStream) : ENDOFCHAIN;
    const miniFatStart = miniFat.length ? push(miniFatBytes) : ENDOFCHAIN;

    const dir = Buffer.alloc(Math.ceil((entries.length * 128) / SECTOR) * SECTOR, 0);
    entries.forEach((e, i) => {
      const o = i * 128;
      const nameBuf = Buffer.from(e.name + "\0", "utf16le");
      nameBuf.copy(dir, o, 0, Math.min(nameBuf.length, 64));
      dir.writeUInt16LE(nameBuf.length, o + 0x40);
      dir[o + 0x42] = e.type;
      dir[o + 0x43] = 1; // black
      dir.writeUInt32LE(FREESECT, o + 0x44); // left sibling
      dir.writeUInt32LE(FREESECT, o + 0x48); // right sibling
      // Root's child is entry 1; the streams chain through their right siblings.
      const child = i === 0 ? (entries.length > 1 ? 1 : FREESECT) : i + 1 < entries.length ? i + 1 : FREESECT;
      dir.writeUInt32LE(child, o + 0x4c);
      dir.writeUInt32LE(FREESECT, o + 0x74);
      dir.writeUInt32LE(0, o + 0x78);
    });

    // Big streams get their own chains.
    const bigStart = new Map();
    for (const i of big) bigStart.set(i, push(this.streams[i].data));

    entries.forEach((e, i) => {
      const o = i * 128;
      if (i === 0) {
        dir.writeUInt32LE(miniStream.length ? miniStreamStart : ENDOFCHAIN, o + 0x74);
        dir.writeUInt32LE(miniStream.length, o + 0x78);
        return;
      }
      const idx = i - 1;
      const smallStream = this.streams[idx].data.length < CUTOFF;
      dir.writeUInt32LE(smallStream ? miniStart.get(idx) : bigStart.get(idx), o + 0x74);
      dir.writeUInt32LE(this.streams[idx].data.length, o + 0x78);
    });
    for (let k = 0; k < dir.length / SECTOR; k++) dir.copy(sectors[dirStart + k], 0, k * SECTOR, (k + 1) * SECTOR);

    // FAT sectors, then the header.
    const fatPerSector = SECTOR / 4;
    const fatSectors = Math.ceil(fat.length / fatPerSector);
    const fatStart = sectors.length;
    for (let i = 0; i < fatSectors; i++) fat.push(i === fatSectors - 1 ? ENDOFCHAIN : fatStart + i + 1);
    const fatBytes = Buffer.alloc(fatSectors * SECTOR, 0xff);
    fat.forEach((v, i) => fatBytes.writeUInt32LE(v, i * 4));
    for (let i = 0; i < fatSectors; i++) sectors.push(fatBytes.subarray(i * SECTOR, (i + 1) * SECTOR));

    const header = Buffer.alloc(SECTOR, 0);
    [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].forEach((v, i) => (header[i] = v));
    header.writeUInt16LE(0x003e, 24);
    header.writeUInt16LE(0x0003, 26);
    header.writeUInt16LE(0xfffe, 28);
    header.writeUInt16LE(9, 30);
    header.writeUInt16LE(6, 32);
    header.writeUInt32LE(fatSectors, 44);
    header.writeUInt32LE(dirStart, 48);
    header.writeUInt32LE(CUTOFF, 56);
    header.writeUInt32LE(miniFat.length ? miniFatStart : ENDOFCHAIN, 60);
    header.writeUInt32LE(Math.ceil(miniFat.length * 4 / SECTOR), 64);
    header.writeUInt32LE(ENDOFCHAIN, 68);
    header.writeUInt32LE(0, 72);
    for (let i = 0; i < 109; i++) header.writeUInt32LE(i < fatSectors ? fatStart + i : FREESECT, 76 + i * 4);
    return Buffer.concat([header, ...sectors]);
  }
}

// ---------------------------------------------------------------------------------------------
// MSI writer (string pool + column-major table streams)
// ---------------------------------------------------------------------------------------------

const T = { STRING: 0x0800, INT: 0x0102, INT32: 0x0103 };

class MsiWriter {
  constructor() {
    this.strings = [""]; // index 0 is the null string, so interning starts at 1
    this.tables = new Map(); // name -> { cols, rows }
  }
  /** Intern a string; index 0 is the null string. */
  s(value) {
    const i = this.strings.indexOf(value);
    if (i >= 0) return i;
    this.strings.push(value);
    return this.strings.length - 1;
  }
  table(name, cols, rows) {
    this.tables.set(name, { cols, rows });
    return this;
  }
  build() {
    // _Columns describes every table, itself included.
    const colRows = [];
    const all = new Map([["_Columns", {
      cols: [
        { name: "Table", type: T.STRING },
        { name: "Number", type: T.INT },
        { name: "Name", type: T.STRING },
        { name: "Type", type: T.INT },
      ],
      rows: [],
    }], ...this.tables]);
    for (const [name, t] of all) {
      t.cols.forEach((c, i) => colRows.push([this.s(name), i + 1, this.s(c.name), c.type]));
    }
    all.get("_Columns").rows = colRows;

    const streams = [];
    streams.push({ name: "!_StringPool", data: this.stringPool() });
    streams.push({ name: "!_StringData", data: this.stringData() });
    const declared = []; // tables with no rows still need a schema, not a stream
    for (const [name, t] of all) {
      if (t.rows.length === 0) {
        declared.push(name);
        continue;
      }
      streams.push({ name: "!" + name, data: tableStream(t.cols, t.rows) });
    }

    const cfb = new CfbWriter();
    for (const s of streams) cfb.add(encodedName(s.name), s.data);
    return { bytes: cfb.build(), columns: colRows.length, declared, tables: [...all.keys()] };
  }
  stringPool() {
    const n = this.strings.length;
    // word 0-1: codepage 1252 (the high word's top bit would mean 3-byte references)
    const pool = Buffer.alloc(4 + n * 4);
    pool.writeUInt16LE(1252, 0);
    pool.writeUInt16LE(0, 2);
    let off = 0;
    for (let i = 0; i < n; i++) {
      const len = Buffer.byteLength(this.strings[i], "latin1");
      if (i === 0) continue; // index 0 is the null string; entries start at word 2 (byte 4)
      pool.writeUInt16LE(len, i * 4);
      pool.writeUInt16LE(1, i * 4 + 2); // a non-zero "reference" count: not an empty entry
      off += len;
    }
    void off;
    return pool;
  }
  stringData() {
    return Buffer.concat(this.strings.map((s) => Buffer.from(s, "latin1")));
  }
}

/** MSI stream names live in code points 0x3800..0x4840 ("!" is 0x4840). */
function encodedName(name) {
  return name.split("").map((ch) => (ch === "!" ? String.fromCharCode(0x4840) : ch)).join("");
}

function tableStream(cols, rows) {
  // Integer width follows the MSI type code (low byte): 2 = 16-bit, 3 = 32-bit. Both are stored as an
  // offset unsigned value; the reader subtracts 0x8000 / 0x80000000, so the range is signed.
  const widths = cols.map((c) => (c.type & T.STRING ? 2 : (c.type & 0xff) <= 2 ? 2 : 4));
  const rowSize = widths.reduce((a, b) => a + b, 0);
  const buf = Buffer.alloc(rowSize * rows.length);
  let o = 0; // the reader walks column by column: all rows of column 0, then column 1, ...
  for (let c = 0; c < cols.length; c++) {
    const w = widths[c];
    for (let r = 0; r < rows.length; r++) {
      const v = rows[r][c] ?? 0;
      const at = o + r * w;
      if (cols[c].type & T.STRING) buf.writeUInt16LE(v, at);
      else if (w === 2) buf.writeUInt16LE((v + 0x8000) & 0xffff, at);
      else buf.writeUInt32LE(((v + 0x80000000) >>> 0), at);
    }
    o += w * rows.length;
  }
  return buf;
}

// ---------------------------------------------------------------------------------------------
// ISO 9660 writer (Joliet + ISO names, both directory extents)
// ---------------------------------------------------------------------------------------------

const SECTOR = 2048;

function utf16be(s) {
  const le = Buffer.from(s, "utf16le");
  const be = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}

function dirRecord(nameBytes, isDir, extent, size) {
  const pad = (nameBytes.length % 2 === 0) ? 1 : 0;
  const len = 33 + nameBytes.length + pad;
  const b = Buffer.alloc(len, 0);
  b[0] = len;
  b.writeUInt32LE(extent, 2);
  b.writeUInt32BE(extent, 6);
  b.writeUInt32LE(size, 10);
  b.writeUInt32BE(size, 14);
  b.writeUInt8(126, 18); // 2026 - 1900
  b.writeUInt8(1, 19);
  b.writeUInt8(1, 20);
  b.writeUInt8(0, 21);
  b.writeUInt8(0, 22);
  b.writeUInt8(0, 23);
  b.writeUInt8(0, 24);
  b[25] = isDir ? 2 : 0;
  b.writeUInt8(0, 26);
  b.writeUInt8(0, 27);
  b.writeUInt16LE(1, 28);
  b.writeUInt16BE(1, 30);
  b[32] = nameBytes.length;
  nameBytes.copy(b, 33);
  return b;
}

/** Lay out directory records, never letting one straddle a sector boundary. */
function buildDirExtent(records) {
  const out = [];
  let used = 0;
  for (const r of records) {
    if (used + r.length > SECTOR) {
      out.push(Buffer.alloc(SECTOR - used));
      used = 0;
    }
    out.push(r);
    used += r.length;
  }
  if (used < SECTOR) out.push(Buffer.alloc(SECTOR - used));
  return Buffer.concat(out);
}

function buildIso(files, volumeId = "SHREK2_TEST") {
  // 16 = PVD, 17 = SVD (Joliet), 18 = terminator, 19 = Joliet root dir, 20 = ISO root dir, 21.. data
  const dataStart = 21;
  let sector = dataStart;
  const placed = files.map((f) => {
    const e = { ...f, sector };
    sector += Math.max(1, Math.ceil(f.data.length / SECTOR));
    return e;
  });
  const totalSectors = sector;

  const jolietRecords = [
    dirRecord(Buffer.from([0]), true, 19, SECTOR),
    dirRecord(Buffer.from([1]), true, 19, SECTOR),
    // Joliet stores UCS-2 big-endian (the reader decodes (hi << 8) | lo).
    ...placed.map((f) => dirRecord(utf16be(f.name), false, f.sector, f.data.length)),
  ];
  const isoRecords = [
    dirRecord(Buffer.from([0]), true, 20, SECTOR),
    dirRecord(Buffer.from([1]), true, 20, SECTOR),
    ...placed.map((f) => dirRecord(Buffer.from(f.name.toUpperCase(), "latin1"), false, f.sector, f.data.length)),
  ];
  const jolietDir = buildDirExtent(jolietRecords);
  const isoDir = buildDirExtent(isoRecords);
  if (jolietDir.length !== SECTOR || isoDir.length !== SECTOR) throw new Error("directory extents must be one sector here");

  const vd = (type, escape) => {
    const b = Buffer.alloc(SECTOR, 0);
    b[0] = type;
    b.write("CD001", 1, "latin1");
    b[6] = 1;
    Buffer.alloc(32, 0x20).copy(b, 40);
    Buffer.from(volumeId, "latin1").copy(b, 40);
    Buffer.alloc(128, 0x20).copy(b, 80);
    if (escape) {
      b[88] = 0x25;
      b[89] = 0x2f;
      b[90] = escape; // 0x45: UCS-2 level 3
    }
    b.writeUInt32LE(totalSectors, 80);
    b.writeUInt32BE(totalSectors, 84);
    b.writeUInt16LE(1, 120);
    b.writeUInt16BE(1, 122);
    b.writeUInt16LE(1, 124);
    b.writeUInt16BE(1, 126);
    b.writeUInt16LE(SECTOR, 128);
    b.writeUInt16BE(SECTOR, 130);
    b[156 + 0] = 34; // root directory record: length
    b.writeUInt32LE(type === 2 ? 19 : 20, 156 + 2);
    b.writeUInt32BE(type === 2 ? 19 : 20, 156 + 6);
    b.writeUInt32LE(SECTOR, 156 + 10);
    b.writeUInt32BE(SECTOR, 156 + 14);
    b.writeUInt8(126, 156 + 18);
    b.writeUInt8(1, 156 + 19);
    b.writeUInt8(1, 156 + 20);
    b[156 + 25] = 2;
    b.writeUInt16LE(1, 156 + 28);
    b.writeUInt16BE(1, 156 + 30);
    b[156 + 32] = 1;
    b[156 + 33] = 0;
    return b;
  };
  const terminator = Buffer.alloc(SECTOR, 0);
  terminator[0] = 255;
  terminator.write("CD001", 1, "latin1");
  terminator[6] = 1;

  const parts = [Buffer.alloc(16 * SECTOR)];
  parts.push(vd(1, 0), vd(2, 0x45), terminator, jolietDir, isoDir);
  for (const f of placed) {
    const padded = Buffer.alloc(Math.max(1, Math.ceil(f.data.length / SECTOR)) * SECTOR, 0);
    f.data.copy(padded);
    parts.push(padded);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// The disc: a "Shrek 2 Team Action" MSI plus its cabinet, on a Joliet ISO
// ---------------------------------------------------------------------------------------------

function buildDisc() {
  const files = [
    { key: "fileGameExe", path: "Game/Shrek 2.exe", name: "Shrek 2.exe", dir: "GameDir", data: binaryPayload(40000, 0x51e1) },
    { key: "fileOgreTex", path: "Game/Chars/ogre.tex", name: "ogre.tex", dir: "CharsDir", data: binaryPayload(90000, 0x7a3d) },
    { key: "fileDonkeyTex", path: "Game/Chars/donkey.tex", name: "donkey.tex", dir: "CharsDir", data: textPayload(70000, 0x1234) },
    { key: "fileThemeWav", path: "Game/Audio/theme.wav", name: "theme.wav", dir: "AudioDir", data: binaryPayload(60000, 0xbeef) },
    { key: "fileLevels", path: "Game/Data/levels.txt", name: "levels.txt", dir: "DataDir", data: textPayload(20000, 0x4242) },
    { key: "fileTiny", path: "Game/Data/tiny.txt", name: "tiny.txt", dir: "DataDir", data: textPayload(17, 0x0011) },
    { key: "fileEmpty", path: "Game/Data/empty.txt", name: "empty.txt", dir: "DataDir", data: Buffer.alloc(0) },
  ];

  // The cabinet's members are keyed by the MSI File key, which is how install.ts matches them.
  // A 64 KiB window with 32 KiB frames: the retail cabinet's shape, and it makes the decoder wrap its
  // sliding window (position 0xffff -> 0) while matches still refer into the previous frame.
  // One CFDATA block per 32 KiB of output: the retail cabinet's shape (a 64 KiB LZX window over 32 KiB
  // frames), which also makes the decoder wrap its sliding window mid-stream.
  const cab = encodeCabFrames(files.map((f) => ({ name: f.key, data: f.data })), 16, 32768);

  const msi = new MsiWriter();
  const dirs = [
    ["TARGETDIR", "TARGETDIR", "SourceDir"],
    ["INSTALLDIR", "TARGETDIR", "Shrek2"],
    ["GameDir", "INSTALLDIR", "Game"],
    ["CharsDir", "GameDir", "Chars"],
    ["AudioDir", "GameDir", "Audio"],
    ["DataDir", "GameDir", "Data"],
  ];
  msi.table(
    "Directory",
    [
      { name: "Directory", type: T.STRING },
      { name: "Directory_Parent", type: T.STRING },
      { name: "DefaultDir", type: T.STRING },
    ],
    dirs.map(([id, parent, def]) => [msi.s(id), msi.s(parent), msi.s(def)]),
  );
  msi.table(
    "Component",
    [
      { name: "Component", type: T.STRING },
      { name: "ComponentId", type: T.STRING },
      { name: "Directory_", type: T.STRING },
    ],
    files.map((f, i) => [msi.s(`comp${i}`), msi.s(`{00000000-0000-0000-0000-00000000000${i}}`), msi.s(f.dir)]),
  );
  msi.table(
    "File",
    [
      { name: "File", type: T.STRING },
      { name: "Component_", type: T.STRING },
      { name: "FileName", type: T.STRING },
      { name: "FileSize", type: T.INT32 },
      { name: "Version", type: T.STRING },
      { name: "Language", type: T.STRING },
      { name: "Attributes", type: T.INT },
      { name: "Sequence", type: T.INT },
    ],
    files.map((f, i) => [
      msi.s(f.key),
      msi.s(`comp${i}`),
      msi.s(f.name),
      f.data.length,
      0,
      0,
      1, // compressed: msidbFileAttributesNoncompressed (0x2000) is clear
      i + 1,
    ]),
  );
  msi.table(
    "Media",
    [
      { name: "DiskId", type: T.INT },
      { name: "LastSequence", type: T.INT },
      { name: "Cabinet", type: T.STRING },
      { name: "VolumeLabel", type: T.STRING },
    ],
    [[1, files.length, msi.s("#game.cab"), 0]],
  );
  msi.table(
    "Property",
    [
      { name: "Property", type: T.STRING },
      { name: "Value", type: T.STRING },
    ],
    [
      [msi.s("ProductName"), msi.s("Shrek 2 Team Action")],
      [msi.s("ProductVersion"), msi.s("1.00.0000")],
    ],
  );
  // Declared but empty: MsiFileHash (checksums) and Registry (the installer reads both).
  msi.table(
    "MsiFileHash",
    [
      { name: "File_", type: T.STRING },
      { name: "Options", type: T.INT },
      { name: "HashPart1", type: T.INT },
      { name: "HashPart2", type: T.INT },
      { name: "HashPart3", type: T.INT },
      { name: "HashPart4", type: T.INT },
    ],
    [],
  );
  msi.table(
    "Registry",
    [
      { name: "Root", type: T.INT },
      { name: "Key", type: T.STRING },
      { name: "Name", type: T.STRING },
      { name: "Value", type: T.STRING },
    ],
    [],
  );

  const msiBytes = msi.build().bytes;
  const iso = buildIso([
    { name: "SHREK2.MSI", data: msiBytes },
    { name: "GAME.CAB", data: cab },
  ]);
  return { iso, msiBytes, cab, files };
}

// ---------------------------------------------------------------------------------------------
// Self-check through the reference installer, then write the corpus
// ---------------------------------------------------------------------------------------------

async function main() {
  const { iso, msiBytes, cab, files } = buildDisc();

  const tmp = mkdtempSync(join(tmpdir(), "shrek2-corpus-"));
  try {
    const isoPath = join(tmp, "disc.iso");
    writeFileSync(isoPath, iso);

    // Run the reference (TypeScript) installer over the image: it must find the MSI, match the product
    // name, and write every file with the bytes this script generated.
    const bundle = join(tmp, "installer.mjs");
    execFileSync(join(ROOT, "node_modules/.bin/esbuild"), [
      join(ROOT, "installer/src/cli.ts"),
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--outfile=" + bundle,
      "--log-level=warning",
    ], { stdio: "inherit" });
    const outDir = join(tmp, "install");
    try {
      execFileSync(process.execPath, [bundle, isoPath, outDir], { stdio: "pipe" });
    } catch (e) {
      // The reference's own message is the useful part ("no ... installer database found" means the ISO
      // or the MSI is wrong). Its progress line shares stderr, so quote the last lines only.
      const err = (e.stderr?.toString() ?? e.message).trim().split("\n").slice(-12).join("\n");
      throw new Error(`the reference installer rejected the generated disc:\n${err}`);
    }

    for (const f of files) {
      const got = readFileSync(join(outDir, ...f.path.split("/")));
      if (!got.equals(f.data)) {
        throw new Error(`the reference installer produced different bytes for ${f.path}`);
      }
    }
    // The reference verifies nothing here (no MsiFileHash), but the layout must be exact.
    const listing = execFileSync("find", [outDir, "-type", "f"], { encoding: "utf8" }).trim().split("\n");
    if (listing.length !== files.length) {
      throw new Error(`the reference installer wrote ${listing.length} files, expected ${files.length}:\n${listing.join("\n")}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const payload = Buffer.concat(files.map((f) => f.data));
  const manifest = {
    description:
      "Conformance corpus for android/app/src/main/java/org/shrek2/launcher/install: " +
      "a synthetic Joliet ISO 9660 disc holding an MSI database and an LZX cabinet, in the layout of " +
      "the retail disc. Generated by runtime/test/cab-lzx-corpus.mjs, which also proves that the " +
      "TypeScript installer (installer/src) installs it byte-for-byte.",
    image: "shrek2.iso",
    imageBytes: iso.length,
    imageMd5: hex(md5(iso)),
    volumeId: "SHREK2_TEST",
    productName: "Shrek 2 Team Action",
    cabinet: "GAME.CAB",
    cabinetBytes: cab.length,
    cabinetMd5: hex(md5(cab)),
    msiBytes: msiBytes.length,
    folderMd5: hex(md5(payload)),
    files: files.map((f) => ({ path: f.path, size: f.data.length, md5: hex(md5(f.data)) })),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "shrek2.iso"), iso);
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `ok: ${join(OUT, "shrek2.iso")} (${iso.length} bytes) installs as ${files.length} files ` +
      `(${payload.length} bytes, folder md5 ${manifest.folderMd5}); manifest written`,
  );
}

await main();
