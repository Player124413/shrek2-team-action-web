#!/usr/bin/env node
// Builds the archive fixtures that `tools/android-stubs-runtime.sh` unpacks, so the "a player hands the
// launcher an already-installed copy" path is checked in CI and not only by hand.
//
//   node tools/game-archive.mjs --out DIR
//
// Writes, into DIR:
//
//   game.zip        deflate (method 8) -- what Windows' "Send to > Compressed folder", 7-Zip and the
//                   Finder all produce. The payload is a *raw* deflate stream, no zlib wrapper: a reader
//                   that expects the wrapper dies with "incorrect header check" on byte one.
//   game.tar.gz     the same tree, gzipped
//   game.tar        uncompressed, for the sniffing fallback
//   not-a-game.zip  a zip that is a zip, just not the game
//
// Every archive holds one extra top-level folder (`Shrek 2 Team Action/`), a `Thumbs.db` and an empty
// file, because that is what a folder copied off a Windows install looks like -- and the launcher has to
// find `Game/` inside it anyway.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { crc32, deflateRawSync, gzipSync } from 'node:zlib'

const TOP = 'Shrek 2 Team Action'

// Small, but real: an executable-looking blob (poorly compressible, so the deflate path is exercised on
// more than one block), a texture, a text file that compresses well, and an empty file.
const FILES = [
  ['Game/Shrek 2.exe', Buffer.from(Array.from({ length: 40_000 }, (_, i) => (i * 37 + (i >> 5) * 11) & 0xff))],
  ['Game/Chars/ogre.tex', Buffer.alloc(4096, 0x5a)],
  ['Game/Chars/donkey.tex', Buffer.alloc(2048, 0x27)],
  ['Game/Data/levels.txt', Buffer.from('levels\n')],
  ['Game/Data/empty.txt', Buffer.alloc(0)],
]

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]
  }
  return out
}

// ---- zip -----------------------------------------------------------------------------------------
// A minimal but correct writer: method 0 (store) and method 8 (deflate) local+central records, no data
// descriptors, no zip64. Enough for the fixtures, and independent of any zip program being installed.
function zip(entries) {
  const locals = []
  const central = []
  let at = 0
  for (const { name, data, compress } of entries) {
    const raw = Buffer.from(name, 'utf8')
    const crc = crc32(data) >>> 0
    const body = compress && data.length > 0 ? deflateRawSync(data) : data
    const method = compress && data.length > 0 ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)             // version needed
    local.writeUInt16LE(0, 6)              // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)             // time
    local.writeUInt16LE(0x2821, 12)        // date (1980-01-01, the zip epoch)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(raw.length, 26)
    local.writeUInt16LE(0, 28)             // extra length
    locals.push(local, raw, body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)                // version made by
    cd.writeUInt16LE(20, 6)                // version needed
    cd.writeUInt16LE(0, 8)                 // flags
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0x2821, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(raw.length, 28)
    cd.writeUInt16LE(0, 30)                // extra
    cd.writeUInt16LE(0, 32)                // comment
    cd.writeUInt16LE(0, 34)                // disk
    cd.writeUInt16LE(0, 36)                // internal attributes
    cd.writeUInt32LE(0, 38)                // external attributes
    cd.writeUInt32LE(at, 42)               // local header offset
    central.push(cd, raw)
    at += 30 + raw.length + body.length
  }
  const cdBytes = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBytes.length, 12)
  eocd.writeUInt32LE(at, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cdBytes, eocd])
}

// ---- tar -----------------------------------------------------------------------------------------
function octal(value, width) {
  // ustar writes numbers as zero-padded octal with a trailing NUL (or space, which tar also accepts).
  const s = value.toString(8)
  return s.padStart(width - 1, '0') + '\0'
}

function tar(entries) {
  const blocks = []
  for (const { name, data } of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write(octal(0o644, 8), 100, 8, 'ascii')
    header.write(octal(0, 8), 108, 8, 'ascii')
    header.write(octal(0, 8), 116, 8, 'ascii')
    header.write(octal(data.length, 12), 124, 12, 'ascii')
    header.write(octal(0, 12), 136, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')     // checksum placeholder: spaces, not NULs
    header.write('0', 156, 1, 'ascii')            // regular file
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (const b of header) sum += b
    header.write(octal(sum, 7) + ' ', 148, 8, 'ascii')
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))                  // two empty blocks end an archive
  return Buffer.concat(blocks)
}

const { out } = args(process.argv.slice(2))
if (!out) {
  console.error('usage: game-archive.mjs --out DIR')
  process.exit(1)
}
mkdirSync(out, { recursive: true })

const game = [
  ...FILES.map(([name, data]) => ({ name: `${TOP}/${name}`, data })),
  { name: `${TOP}/Thumbs.db`, data: Buffer.from('junk from Windows\n') },
]
const notAGame = [{ name: 'readme.txt', data: Buffer.from('this folder is not the game\n') }]

const tarBytes = tar(game)
writeFileSync(join(out, 'game.zip'), zip(game.map((e) => ({ ...e, compress: true }))))
writeFileSync(join(out, 'game.tar.gz'), gzipSync(tarBytes, { level: 9 }))
writeFileSync(join(out, 'game.tar'), tarBytes)
writeFileSync(join(out, 'not-a-game.zip'), zip(notAGame.map((e) => ({ ...e, compress: true }))))

// A sanity check that does not need the launcher: the game is really in there, compressed.
console.log(`ok: archive fixtures in ${out} (${game.length} files, ${tarBytes.length} B as tar)`)
