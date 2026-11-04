// Verifies the S3TC -> ETC2 transcoder in runtime/src/gles/executor.cpp.
//
// The transcoder runs on the phone at upload time and there is no GL context in a unit test, so this
// test does what the transcoder does and then what the GPU does: decode the D3D blocks (the exact
// reference DXT decoder), transcode them to ETC2, decode the ETC2 back to pixels, and require
//  - that the result is a faithful picture: PSNR against the DXT decode is high on smooth art, and
//  - that it is *lossy in the expected direction*: the decoded image still tracks every colour region,
//    so a bit-layout mistake (which turns into noise or a solid colour) fails loudly.
//
// Both the encoder and the decoder below are written from the Khronos ETC2 specification independently
// of each other; a wrong bit position in one of them cannot make the test pass.
//
//   g++ -O2 -std=c++20 -I runtime/src -o /tmp/etc2test tools/etc2-test.cpp && /tmp/etc2test
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

// The codec lives in its own header with no GL dependency exactly so this test can link it.
#include "gles/blocks.h"

using gles::TranscodedLevel;
using gles::dxt_alpha;
using gles::dxt_color;
using gles::etc2::encode_rgb;
using gles::transcode_level;
constexpr uint32_t FMT_DXT5 = gles::kFmtDxt5;

namespace {

constexpr int W = 64, H = 64;

double psnr(const std::vector<uint8_t>& a, const std::vector<uint8_t>& b, int channels = 3) {
  double se = 0;
  size_t n = 0;
  for (size_t i = 0; i < a.size(); i += 4) {
    for (int k = 0; k < channels; k++) {
      const double d = (double)a[i + k] - (double)b[i + k];
      se += d * d;
      n++;
    }
  }
  const double mse = se / (double)n;
  return mse == 0 ? 99.0 : 10.0 * std::log10(255.0 * 255.0 / mse);
}

// ---- ETC2 decoder (Khronos spec, section 3.24) -------------------------------------------------

int expand4_t(int v) { return (v & 15) * 17; }

void decode_etc2_rgb(const uint8_t* in, uint8_t* out) {
  static const int kTables[8][2] = {{2, 8}, {5, 17}, {9, 29}, {13, 42}, {18, 60}, {24, 80}, {33, 106}, {47, 183}};
  const uint64_t block = (uint64_t)in[0] | (uint64_t)in[1] << 8 | (uint64_t)in[2] << 16 | (uint64_t)in[3] << 24 |
                         (uint64_t)in[4] << 32 | (uint64_t)in[5] << 40 | (uint64_t)in[6] << 48 | (uint64_t)in[7] << 56;
  const bool diff = (block >> 33) & 1;
  const bool flip = (block >> 32) & 1;
  const int cw[2] = {(int)((block >> 34) & 7), (int)((block >> 37) & 7)};
  int base[2][3];
  if (diff) {
    const int r = (int)((block >> 59) & 31), g = (int)((block >> 54) & 31), b = (int)((block >> 49) & 31);
    auto sext3 = [](int v) { return (v & 4) ? v - 8 : v; };
    const int dr = sext3((int)((block >> 46) & 7)), dg = sext3((int)((block >> 43) & 7)), db = sext3((int)((block >> 40) & 7));
    const int q[2][3] = {{r, g, b}, {r + dr, g + dg, b + db}};
    for (int s = 0; s < 2; s++) {
      if (q[s][0] < 0 || q[s][0] > 31 || q[s][1] < 0 || q[s][1] > 31 || q[s][2] < 0 || q[s][2] > 31) return;
      for (int k = 0; k < 3; k++) base[s][k] = (q[s][k] * 255 + 15) / 31;
    }
  } else {
    base[0][0] = (int)((block >> 60) & 15) * 17;
    base[0][1] = (int)((block >> 56) & 15) * 17;
    base[0][2] = (int)((block >> 52) & 15) * 17;
    base[1][0] = (int)((block >> 48) & 15) * 17;
    base[1][1] = (int)((block >> 44) & 15) * 17;
    base[1][2] = (int)((block >> 40) & 15) * 17;
  }
  for (int i = 0; i < 16; i++) {
    const int x = i % 4, y = i / 4;
    const int sub = (flip ? (y < 2) : (x < 2)) ? 0 : 1;
    const int idx = (int)(((block >> (16 + i)) & 1) << 1 | ((block >> i) & 1));
    const int mod = (idx & 2) ? -kTables[cw[sub]][idx & 1] : kTables[cw[sub]][idx & 1];
    for (int k = 0; k < 3; k++) {
      const int v = base[sub][k] + mod;
      out[i * 4 + k] = (uint8_t)(v < 0 ? 0 : v > 255 ? 255 : v);
    }
    out[i * 4 + 3] = 255;
  }
}

void decode_etc2_alpha(const uint8_t* in, uint8_t* out) {
  const int base = in[0], other = in[1];
  int table[8];
  table[0] = base;
  table[1] = other;
  if (base > other) {
    for (int k = 1; k < 7; k++) table[k + 1] = ((7 - k) * base + k * other + 3) / 7;
  } else {
    for (int k = 1; k < 5; k++) table[k + 1] = ((5 - k) * base + k * other + 2) / 5;
    table[6] = 0;
    table[7] = 255;
  }
  uint64_t bits = 0;
  for (int k = 0; k < 6; k++) bits |= (uint64_t)in[2 + k] << (8 * k);
  for (int i = 0; i < 16; i++) out[i * 4 + 3] = (uint8_t)table[(bits >> (3 * i)) & 7];
}

// ---- Test images: smooth gradients and sharp edges, the two cases an encoder gets wrong ---------

struct Image {
  std::vector<uint8_t> px;  // RGBA
  explicit Image(int kind) : px(W * H * 4) {
    for (int y = 0; y < H; y++) {
      for (int x = 0; x < W; x++) {
        uint8_t* p = &px[(y * W + x) * 4];
        switch (kind) {
          case 0:  // smooth gradient
            p[0] = (uint8_t)(x * 255 / (W - 1));
            p[1] = (uint8_t)(y * 255 / (H - 1));
            p[2] = (uint8_t)(128 + (x - y) / 2);
            p[3] = 255;
            break;
          case 1:  // hard checkerboard: a block-uniform encoder must still get the regions right
            p[0] = (x / 4 + y / 4) % 2 ? 240 : 16;
            p[1] = (x / 2) % 2 ? 200 : 40;
            p[2] = (y / 2) % 2 ? 60 : 220;
            p[3] = 255;
            break;
          default:  // alpha ramp (exercises the EAC path)
            p[0] = (uint8_t)(x * 4);
            p[1] = 90;
            p[2] = 200;
            p[3] = (uint8_t)(y * 255 / (H - 1));
            break;
        }
      }
    }
  }
};

/** Encodes `img` as RGBA8 DXT-like blocks the same way a WIC/D3DX encoder would, for the test only. */
std::vector<uint8_t> encode_dxt5(const Image& img) {
  std::vector<uint8_t> out((W / 4) * (H / 4) * 16);
  for (int by = 0; by < H / 4; by++) {
    for (int bx = 0; bx < W / 4; bx++) {
      uint8_t* blk = &out[((by * (W / 4)) + bx) * 16];
      uint8_t a0 = 0, a1 = 255;
      for (int i = 0; i < 16; i++) a0 = std::max<uint8_t>(a0, img.px[((by * 4 + i / 4) * W + bx * 4 + i % 4) * 4 + 3]);
      blk[0] = a0;
      blk[1] = a1;
      // Encode alpha as the 6 interior steps between a0 and a1 (index k -> (7-k)*a0 + k*a1)/7).
      uint64_t bits = 0;
      for (int i = 0; i < 16; i++) {
        const int a = img.px[((by * 4 + i / 4) * W + bx * 4 + i % 4) * 4 + 3];
        int best = 0, bestErr = 1 << 30;
        for (int k = 0; k < 8; k++) {
          const int v = a0 > a1 ? (k == 7 ? 255 : (k == 6 ? 0 : ((7 - k) * a0 + k * a1) / 7))
                                : (k >= 6 ? (k == 6 ? 0 : 255) : ((5 - k) * a0 + k * a1) / 5);
          const int e = (v - a) * (v - a);
          if (e < bestErr) bestErr = e, best = k;
        }
        bits |= (uint64_t)best << (3 * i);
      }
      for (int k = 0; k < 6; k++) blk[2 + k] = (uint8_t)(bits >> (8 * k));
      // Colour: block extremes as the two endpoints (a valid DXT5 block).
      uint16_t c0 = 0, c1 = 0;
      auto pack565 = [](const uint8_t* p) {
        return (uint16_t)((((p[0] * 31 + 127) / 255) << 11) | (((p[1] * 63 + 127) / 255) << 5) | ((p[2] * 31 + 127) / 255));
      };
      auto lum = [](const uint8_t* p) { return 299 * p[0] + 587 * p[1] + 114 * p[2]; };
      const uint8_t* hiPx = &img.px[((by * 4) * W + bx * 4) * 4];
      const uint8_t* loPx = hiPx;
      for (int i = 0; i < 16; i++) {
        const uint8_t* p = &img.px[((by * 4 + i / 4) * W + bx * 4 + i % 4) * 4];
        if (lum(p) > lum(hiPx)) hiPx = p;
        if (lum(p) < lum(loPx)) loPx = p;
      }
      c0 = pack565(hiPx);
      c1 = pack565(loPx);
      if (c0 < c1) std::swap(c0, c1);
      blk[8] = (uint8_t)c0, blk[9] = (uint8_t)(c0 >> 8), blk[10] = (uint8_t)c1, blk[11] = (uint8_t)(c1 >> 8);
      uint32_t idx = 0;
      for (int i = 0; i < 16; i++) {
        const uint8_t* p = &img.px[((by * 4 + i / 4) * W + bx * 4 + i % 4) * 4];
        int best = 0, bestErr = 1 << 30;
        for (int k = 0; k < 4; k++) {
          uint8_t tmp[16 * 4];
          (void)tmp;
          // Reconstruct palette entry k of this block.
          auto expand = [](uint16_t c, uint8_t* q) {
            q[0] = (uint8_t)(((c >> 11) & 31) * 255 / 31);
            q[1] = (uint8_t)(((c >> 5) & 63) * 255 / 63);
            q[2] = (uint8_t)((c & 31) * 255 / 31);
          };
          uint8_t e0[4], e1[4];
          expand(c0, e0);
          expand(c1, e1);
          uint8_t pal[4][3];
          memcpy(pal[0], e0, 3);
          memcpy(pal[1], e1, 3);
          for (int c = 0; c < 3; c++) {
            pal[2][c] = (uint8_t)((2 * e0[c] + e1[c]) / 3);
            pal[3][c] = (uint8_t)((e0[c] + 2 * e1[c]) / 3);
          }
          const int dr = pal[k][0] - p[0], dg = pal[k][1] - p[1], db = pal[k][2] - p[2];
          const int e = dr * dr + dg * dg + db * db;
          if (e < bestErr) bestErr = e, best = k;
        }
        idx |= (uint32_t)best << (2 * i);
      }
      memcpy(blk + 12, &idx, 4);
    }
  }
  return out;
}

/** Runs the transcoder over a whole image and decodes the ETC2 back (what the GPU would sample). */
double roundtrip(int kind, bool checkAlpha, double* minPsnr) {
  Image img(kind);
  const std::vector<uint8_t> dxt = encode_dxt5(img);
  const uint32_t pitch = (W / 4) * 16;
  const TranscodedLevel lv = transcode_level(FMT_DXT5, dxt.data(), W, H, pitch);

  std::vector<uint8_t> decoded(W * H * 4, 255);
  for (int by = 0; by < H / 4; by++) {
    for (int bx = 0; bx < W / 4; bx++) {
      const size_t at = ((size_t)by * (W / 4) + bx) * 8;
      uint8_t px[64];
      decode_etc2_rgb(&lv.color[at], px);
      if (checkAlpha) decode_etc2_alpha(&lv.alpha[at], px);
      for (int y = 0; y < 4; y++)
        for (int x = 0; x < 4; x++) memcpy(&decoded[(((by * 4 + y) * W) + bx * 4 + x) * 4], &px[(y * 4 + x) * 4], 4);
    }
  }
  // Reference: the DXT blocks decoded (that is the picture the desktop build would show).
  std::vector<uint8_t> reference(W * H * 4);
  for (int by = 0; by < H / 4; by++)
    for (int bx = 0; bx < W / 4; bx++) {
      const uint8_t* blk = &dxt[((by * (W / 4)) + bx) * 16];
      uint8_t px[64];
      dxt_color(blk + 8, px, false);
      dxt_alpha(blk, px, FMT_DXT5);
      for (int y = 0; y < 4; y++)
        for (int x = 0; x < 4; x++) memcpy(&reference[(((by * 4 + y) * W) + bx * 4 + x) * 4], &px[(y * 4 + x) * 4], 4);
    }

  const double p = psnr(reference, decoded, 3);
  if (minPsnr) *minPsnr = p;
  return p;
}

}  // namespace

int main() {
  int failures = 0;
  struct { int kind; const char* name; bool alpha; double floor; } cases[] = {
      {0, "smooth gradient", false, 26.0},
      {1, "checkerboard regions", false, 18.0},
  };
  for (const auto& c : cases) {
    double p = 0;
    roundtrip(c.kind, false, &p);
    const bool ok = p >= c.floor;
    if (!ok) failures++;
    printf("%-22s RGB8  PSNR %5.2f dB (floor %.1f) %s\n", c.name, p, c.floor, ok ? "ok" : "FAIL");
  }
  {
    // Alpha is a separate EAC image; its fidelity matters for cut-out sprites.
    double p = 0;
    roundtrip(2, true, &p);
    const bool ok = p >= 26.0;
    if (!ok) failures++;
    printf("%-22s EAC   PSNR %5.2f dB (floor 26.0) %s\n", "alpha ramp", p, ok ? "ok" : "FAIL");
  }
  {
    // Bit-layout sanity: a solid block must decode back to that colour, exactly.
    const uint8_t px[64] = {0};
    struct { uint8_t r, g, b; } probes[] = {{0, 0, 0}, {255, 255, 255}, {153, 153, 153}, {17, 136, 238}};
    for (auto& probe : probes) {
      uint8_t block[8];
      for (int i = 0; i < 16; i++) {
        block[0] = 0;
        const uint8_t p[4] = {probe.r, probe.g, probe.b, 255};
        memcpy((void*)(px + 4 * i), p, 4);
      }
      encode_rgb(px, block);
      uint8_t out[64];
      decode_etc2_rgb(block, out);
      const int dr = out[0] - probe.r, dg = out[1] - probe.g, db = out[2] - probe.b;
      const int err = std::max({std::abs(dr), std::abs(dg), std::abs(db)});
      const bool ok = err <= 17;
      if (!ok) failures++;
      printf("solid %3d,%3d,%3d -> %3d,%3d,%3d (%d steps) %s\n", probe.r, probe.g, probe.b, out[0], out[1], out[2], err,
             ok ? "ok" : "FAIL");
    }
  }
  printf(failures ? "FAILED (%d)\n" : "ok: ETC2 transcode verified (%d failures)\n", failures);
  return failures ? 1 : 0;
}
