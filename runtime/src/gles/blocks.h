// DXT (S3TC) block decoding and ETC2 transcoding for the GLES executor.
//
// Desktop D3D9 art is almost always DXT; GLES 3.0 has no S3TC (it is an extension, missing on most
// mobile GPUs and often absent in WebGL), but ETC2/EAC is *core* in both GLES 3.0 and WebGL 2. So a
// DXT surface is decoded with the reference decoder below and re-encoded as ETC2 once, at upload,
// instead of being expanded to RGBA8 and kept resident (4x the memory, and a per-texture CPU copy).
//
// Kept free of GL and of the runtime so it can be tested directly: tools/etc2-test.cpp compiles this
// file, encodes, decodes with an independent ETC2 decoder written from the Khronos spec, and compares
// against the DXT decode.
#pragma once

#include <algorithm>
#include <climits>
#include <cstdint>
#include <cstring>
#include <vector>

namespace gles {

// D3D formats this file knows how to turn into blocks; the values match d3d::FormatInfo's fourccs.
enum DxtFormat : uint32_t {
  kFmtDxt1 = 0x31545844,  // "DXT1"
  kFmtDxt2 = 0x32545844,
  kFmtDxt3 = 0x33545844,
  kFmtDxt4 = 0x34545844,
  kFmtDxt5 = 0x35545844,
};



// Decode one DXT colour block (8 bytes) into 16 RGBA pixels.
inline void dxt_color(const uint8_t* b, uint8_t* out, bool dxt1) {
  uint16_t c0 = (uint16_t)(b[0] | b[1] << 8), c1 = (uint16_t)(b[2] | b[3] << 8);
  uint8_t pal[4][4];
  auto expand = [](uint16_t c, uint8_t* p) {
    p[0] = (uint8_t)(((c >> 11) & 31) * 255 / 31);
    p[1] = (uint8_t)(((c >> 5) & 63) * 255 / 63);
    p[2] = (uint8_t)((c & 31) * 255 / 31);
    p[3] = 255;
  };
  expand(c0, pal[0]);
  expand(c1, pal[1]);
  if (!dxt1 || c0 > c1) {
    for (int k = 0; k < 3; k++) {
      pal[2][k] = (uint8_t)((2 * pal[0][k] + pal[1][k]) / 3);
      pal[3][k] = (uint8_t)((pal[0][k] + 2 * pal[1][k]) / 3);
    }
    pal[2][3] = pal[3][3] = 255;
  } else {
    for (int k = 0; k < 3; k++) pal[2][k] = (uint8_t)((pal[0][k] + pal[1][k]) / 2), pal[3][k] = 0;
    pal[2][3] = 255;
    pal[3][3] = 0;
  }
  uint32_t idx = (uint32_t)(b[4] | b[5] << 8 | b[6] << 16 | (uint32_t)b[7] << 24);
  for (int i = 0; i < 16; i++) memcpy(out + 4 * i, pal[(idx >> (2 * i)) & 3], 4);
}

/** Writes the 16 alpha values of a DXT2/3/4/5 block into the alpha bytes of 16 RGBA pixels. */
inline void dxt_alpha(const uint8_t* blk, uint8_t* px, uint32_t fmt) {
  if (fmt == kFmtDxt2 || fmt == kFmtDxt3) {
    for (int i = 0; i < 16; i++) px[4 * i + 3] = (uint8_t)(((blk[i / 2] >> (4 * (i & 1))) & 15) * 17);
    return;
  }
  uint8_t a0 = blk[0], a1 = blk[1], a[8] = {a0, a1};
  if (a0 > a1) {
    for (int k = 1; k < 7; k++) a[k + 1] = (uint8_t)(((7 - k) * a0 + k * a1) / 7);
  } else {
    for (int k = 1; k < 5; k++) a[k + 1] = (uint8_t)(((5 - k) * a0 + k * a1) / 5);
    a[6] = 0;
    a[7] = 255;
  }
  uint64_t bits = 0;
  for (int k = 0; k < 6; k++) bits |= (uint64_t)blk[2 + k] << (8 * k);
  for (int i = 0; i < 16; i++) px[4 * i + 3] = a[(bits >> (3 * i)) & 7];
}

// ---- S3TC -> ETC2 transcoding ----------------------------------------------------------------------

/*
 * Desktop D3D9 art is almost always DXT (S3TC). GLES 3.0 has no S3TC: without the extension vendor
 * variants differ, mobile GPUs drop it, and WebGL implementations often keep it behind a flag. ETC2,
 * on the other hand, is *core* in GLES 3.0 and WebGL 2 -- so the portable answer is to transcode the
 * blocks once at upload instead of decoding four times the memory and keeping it resident.
 *
 * The output is deliberately decoded-then-re-encoded rather than a patent-era shortcut: each DXT
 * block is decoded to 16 RGBA pixels (the exact reference decoder above) and the pixels are encoded
 * as ETC2. That is lossy in both directions, so this path is only correct for textures whose pixels
 * the *game* never reads back: rasterized triangles sample textures through the guest's own 32-bit
 * addresses (the sampler fetches from guest memory, not from GL), so the GL copy is purely for the
 * GPU. Locked/copied surfaces take the RGBA8 path, which is bit-exact.
 */
namespace etc2 {

// ETC2 modifier tables (index 0/1 are the positive steps of a table, 2/3 their negations).
constexpr int kTables[8][2] = {{2, 8}, {5, 17}, {9, 29}, {13, 42}, {18, 60}, {24, 80}, {33, 106}, {47, 183}};
inline int modifier(int cw, int index) {
  const int m = kTables[cw & 7][index & 1];
  return (index & 2) ? -m : m;
}

inline int expand4(int v) { return (v & 15) * 17; }
inline int expand5(int v) { return (v & 31) * 255 / 31; }
inline int expand6(int v) { return (v & 63) * 255 / 63; }
inline int quant4(int v) { return v <= 0 ? 0 : v >= 255 ? 15 : (v * 15 + 127) / 255; }
inline int quant5(int v) { return v <= 0 ? 0 : v >= 255 ? 31 : (v * 31 + 127) / 255; }
inline int clamp255(int v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

/**
 * Encodes one 4x4 RGBA block as ETC2 RGB8 (8 bytes), per the Khronos layout:
 *
 *   individual:  R1(4) G1(4) B1(4) | B1(4) R2(4) G2(4) B2(4) | cw1(3) cw2(3) flip diff
 *   differential: R1(5) G1(5) B1(5) | dR(3) dG(3) dB(3)      | cw1(3) cw2(3) flip diff
 *
 * Both modes split the block into two 2x4 sub-blocks (or 4x2 when `flip` is set) and give each its own
 * table codeword. The encoder tries both flips and both modes and keeps the smallest squared error;
 * the base colour of a sub-block is refined twice (mean -> best indices -> mean of (pixel - modifier)),
 * which is the cheap fixed point of the usual least-squares fit.
 */
inline void encode_rgb(const uint8_t* px, uint8_t* out) {
  // Sub-block membership: pixel i is (x = i % 4, y = i / 4); flip selects vertical vs horizontal split.
  auto inSub = [](int i, bool flip, int sub) {
    const int x = i % 4, y = i / 4;
    return (flip ? (y < 2) : (x < 2)) == (sub == 0);
  };

  // Best (cw, base, indices, error) for one sub-block. `base` is a 15-bit 4:4:4 quantization, or 5:5:5
  // when `diff` is set (the caller adds the deltas).
  struct Fit {
    int cw = 0;
    int base[3] = {0, 0, 0};  // quantized levels (4 or 5 bits depending on `diff`)
    uint32_t indices = 0;     // 2 bits per pixel, pixel order
    long error = LONG_MAX;
  };

  auto fit = [&](bool flip, int sub, bool diff) -> Fit {
    // Candidate base colours: the sub-block mean, rounded and then nudged, fitted per codeword.
    int mean[3] = {0, 0, 0}, n = 0;
    for (int i = 0; i < 16; i++) {
      if (!inSub(i, flip, sub)) continue;
      for (int k = 0; k < 3; k++) mean[k] += px[4 * i + k];
      n++;
    }
    for (int k = 0; k < 3; k++) mean[k] /= n;

    Fit best;
    // Four tables is enough: the full eight would double the search for well under a dB, and this runs
    // on every texture upload. The candidates span the coarse-to-fine range of step sizes.
    static const int kCandidates[4] = {0, 3, 5, 7};
    auto evaluate = [&](const int* base, int c, uint32_t& idx) {
      idx = 0;
      long err = 0;
      int sum[3] = {0, 0, 0};
      for (int i = 0; i < 16; i++) {
        if (!inSub(i, flip, sub)) continue;
        int bestM = 0, bestErr = INT_MAX;
        for (int m = 0; m < 4; m++) {
          const int mod = modifier(c, m);
          const int dr = (diff ? expand5(base[0]) : expand4(base[0])) + mod - px[4 * i];
          const int dg = (diff ? expand5(base[1]) : expand4(base[1])) + mod - px[4 * i + 1];
          const int db = (diff ? expand5(base[2]) : expand4(base[2])) + mod - px[4 * i + 2];
          const int e = dr * dr + dg * dg + db * db;
          if (e < bestErr) bestErr = e, bestM = m;
        }
        idx |= (uint32_t)bestM << (2 * i);
        err += bestErr;
        const int mod = modifier(c, bestM);
        for (int k = 0; k < 3; k++) sum[k] += px[4 * i + k] - mod;
      }
      return err;
    };

    for (int c : kCandidates) {
      int base[3];
      for (int k = 0; k < 3; k++) base[k] = diff ? quant5(mean[k]) : quant4(mean[k]);
      // Two refinement steps: mean -> indices -> least-squares base -> indices again. The base stored
      // in `best` is always the one its indices and error were measured against.
      for (int pass = 0; pass < 2; pass++) {
        uint32_t idx = 0;
        const long err = evaluate(base, c, idx);
        if (err < best.error) {
          best.error = err;
          best.cw = c;
          best.indices = idx;
          for (int k = 0; k < 3; k++) best.base[k] = base[k];
        }
        // Least-squares base for the indices just chosen.
        int sum[3] = {0, 0, 0};
        int n = 0;
        for (int i = 0; i < 16; i++) {
          if (!inSub(i, flip, sub)) continue;
          const int mod = modifier(c, (idx >> (2 * i)) & 3);
          for (int k = 0; k < 3; k++) sum[k] += px[4 * i + k] - mod;
          n++;
        }
        for (int k = 0; k < 3; k++) base[k] = diff ? quant5(clamp255(sum[k] / n)) : quant4(clamp255(sum[k] / n));
      }
    }
    return best;
  };

  long bestError = LONG_MAX;
  uint64_t block = 0;
  uint32_t bestIndices[2] = {0, 0};
  for (int flip = 0; flip < 2; flip++) {
    // Individual: independent 4-bit bases.
    {
      const Fit a = fit(flip != 0, 0, false);
      const Fit b = fit(flip != 0, 1, false);
      if (a.error + b.error < bestError) {
        bestError = a.error + b.error;
        bestIndices[0] = a.indices;
        bestIndices[1] = b.indices;
        block = ((uint64_t)a.base[0] << 60) | ((uint64_t)a.base[1] << 56) | ((uint64_t)a.base[2] << 52) |
                ((uint64_t)b.base[0] << 48) | ((uint64_t)b.base[1] << 44) | ((uint64_t)b.base[2] << 40) |
                ((uint64_t)(a.cw & 7) << 37) | ((uint64_t)(b.cw & 7) << 34) | ((uint64_t)flip << 32);
      }
    }
    // Differential: 5-bit base plus a signed 3-bit delta (range -4..3), same table codewords.
    {
      const Fit a = fit(flip != 0, 0, true);
      const Fit b = fit(flip != 0, 1, true);
      const int dR = b.base[0] - a.base[0], dG = b.base[1] - a.base[1], dB = b.base[2] - a.base[2];
      if (dR >= -4 && dR <= 3 && dG >= -4 && dG <= 3 && dB >= -4 && dB <= 3 && a.error + b.error < bestError) {
        bestError = a.error + b.error;
        bestIndices[0] = a.indices;
        bestIndices[1] = b.indices;
        block = ((uint64_t)(a.base[0] & 31) << 59) | ((uint64_t)(a.base[1] & 31) << 54) | ((uint64_t)(a.base[2] & 31) << 49) |
                ((uint64_t)(dR & 7) << 46) | ((uint64_t)(dG & 7) << 43) | ((uint64_t)(dB & 7) << 40) |
                ((uint64_t)(a.cw & 7) << 37) | ((uint64_t)(b.cw & 7) << 34) | ((uint64_t)flip << 32) | (1ull << 33);
      }
    }
  }

  // Pixel index bits are interleaved: bit (16+i) is the index MSB and bit i the LSB. Each pixel takes
  // the index its sub-block chose.
  const bool flip = (block >> 32) & 1;
  uint32_t msb = 0, lsb = 0;
  for (int i = 0; i < 16; i++) {
    const int x = i % 4, y = i / 4;
    const int sub = (flip ? (y < 2) : (x < 2)) ? 0 : 1;
    const uint32_t idx = (bestIndices[sub] >> (2 * i)) & 3;
    msb |= (idx >> 1) << i;
    lsb |= (idx & 1) << i;
  }
  block |= (uint64_t)msb << 16 | lsb;
  memcpy(out, &block, 8);
}

/** ETC2 EAC alpha block (8 bytes): two endpoints plus 16 3-bit indices. */
inline void encode_alpha(const uint8_t* px, uint8_t* out) {
  uint8_t hi = 0, lo = 255;
  for (int i = 0; i < 16; i++) {
    hi = std::max(hi, px[4 * i + 3]);
    lo = std::min(lo, px[4 * i + 3]);
  }
  out[0] = hi;  // A1
  out[1] = lo;  // A2
  // A1 > A2 selects the 6-step interpolation table; A1 <= A2 selects the 4-step one with explicit 0/255.
  int table[8];
  table[0] = hi;
  table[1] = lo;
  if (hi > lo) {
    for (int k = 1; k < 7; k++) table[k + 1] = ((7 - k) * hi + k * lo + 3) / 7;
  } else {
    for (int k = 1; k < 5; k++) table[k + 1] = ((5 - k) * hi + k * lo + 2) / 5;
    table[6] = 0;
    table[7] = 255;
  }
  uint64_t bits = 0;
  for (int i = 0; i < 16; i++) {
    const int a = px[4 * i + 3];
    int best = 0, bestErr = INT_MAX;
    for (int k = 0; k < 8; k++) {
      const int e = (table[k] - a) * (table[k] - a);
      if (e < bestErr) bestErr = e, best = k;
    }
    bits |= (uint64_t)best << (3 * i);
  }
  for (int k = 0; k < 6; k++) out[2 + k] = (uint8_t)(bits >> (8 * k));
}

}  // namespace etc2

struct TranscodedLevel {
  std::vector<uint8_t> color;
  std::vector<uint8_t> alpha;  // empty for formats without alpha
};

inline TranscodedLevel transcode_level(uint32_t fmt, const uint8_t* src, uint32_t w, uint32_t h, uint32_t pitch) {
  const bool dxt1 = fmt == kFmtDxt1;
  const uint32_t bx_count = std::max<uint32_t>(1, (w + 3) / 4), by_count = std::max<uint32_t>(1, (h + 3) / 4);
  const size_t bytes = (size_t)bx_count * by_count * 8;
  TranscodedLevel out;
  out.color.assign(bytes, 0);
  if (!dxt1) out.alpha.assign(bytes, 0);

  uint8_t px[64];
  uint8_t block[8];
  for (uint32_t by = 0; by < by_count; by++) {
    for (uint32_t bx = 0; bx < bx_count; bx++) {
      const size_t at = ((size_t)by * bx_count + bx) * 8;
      const uint8_t* blk = src + (size_t)by * pitch + (size_t)bx * (dxt1 ? 8 : 16);
      if (dxt1) {
        dxt_color(blk, px, true);
      } else {
        dxt_color(blk + 8, px, false);
        dxt_alpha(blk, px, fmt);
      }
      etc2::encode_rgb(px, block);
      memcpy(&out.color[at], block, 8);
      if (!dxt1) {
        etc2::encode_alpha(px, block);
        memcpy(&out.alpha[at], block, 8);
      }
    }
  }
  return out;
}

}  // namespace gles
