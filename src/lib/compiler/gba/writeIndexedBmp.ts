// GBA Studio - minimal indexed-BMP encoder for the GBA asset pipeline.
//
// Butano's graphics importer (grit) consumes BMP files: a 40-byte
// BITMAPINFOHEADER, no compression, 4bpp/8bpp paletted (see
// butano/tools/bmp.py). A <=16-colour image is copied straight through to grit
// with no quantization, so we emit 8bpp with a 16-colour palette - that avoids
// 4bpp nibble packing and keeps the encoder trivial.
//
// Regular backgrounds must be sized in multiples of 256 (butano_graphics_tool.py
// RegularBgItem), so the source image is centred on a 256-multiple canvas and the
// surround is filled with palette index 0 (the backdrop).

export type Rgb = [number, number, number];

export interface IndexedSource {
  width: number;
  height: number;
  data: Uint8Array | number[]; // one palette index (0..15) per pixel, top-down row-major
}

const ceilTo = (v: number, m: number): number => Math.max(m, Math.ceil(v / m) * m);

/**
 * Encode an indexed image as an 8bpp BMP (16-colour palette), centred on a
 * canvas whose dimensions are rounded up to a multiple of `align` (256 for
 * regular backgrounds). Returns the BMP file bytes.
 */
export function indexedImageToBmp(
  src: IndexedSource,
  palette: Rgb[],
  opts: { align?: number } = {},
): Buffer {
  const align = opts.align ?? 256;
  const canvasW = ceilTo(src.width, align);
  const canvasH = ceilTo(src.height, align);
  const offX = Math.floor((canvasW - src.width) / 2);
  const offY = Math.floor((canvasH - src.height) / 2);

  // Canvas is top-down here; index 0 = backdrop, source image centred.
  const canvas = new Uint8Array(canvasW * canvasH);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      canvas[(offY + y) * canvasW + (offX + x)] = src.data[y * src.width + x] & 0x0f;
    }
  }

  const PALETTE_COLORS = 16;
  const FILE_HEADER = 14;
  const DIB_HEADER = 40;
  const paletteBytes = PALETTE_COLORS * 4;
  const pixelOffset = FILE_HEADER + DIB_HEADER + paletteBytes;
  const rowSize = canvasW; // 8bpp; canvasW is a multiple of 256, so already 4-byte aligned
  const pixelBytes = rowSize * canvasH;
  const fileSize = pixelOffset + pixelBytes;

  const buf = Buffer.alloc(fileSize);
  // BITMAPFILEHEADER
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(pixelOffset, 10);
  // BITMAPINFOHEADER (40 bytes)
  buf.writeUInt32LE(DIB_HEADER, 14);
  buf.writeInt32LE(canvasW, 18);
  buf.writeInt32LE(canvasH, 22); // positive height -> rows stored bottom-up
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(8, 28); // bits per pixel
  buf.writeUInt32LE(0, 30); // BI_RGB, no compression
  buf.writeUInt32LE(pixelBytes, 34);
  buf.writeInt32LE(0, 38); // x pixels-per-metre
  buf.writeInt32LE(0, 42); // y pixels-per-metre
  buf.writeUInt32LE(PALETTE_COLORS, 46);
  buf.writeUInt32LE(0, 50);
  // Palette (stored B, G, R, 0)
  for (let i = 0; i < PALETTE_COLORS; i++) {
    const [r, g, b] = palette[i] ?? [0, 0, 0];
    const o = FILE_HEADER + DIB_HEADER + i * 4;
    buf[o + 0] = b & 0xff;
    buf[o + 1] = g & 0xff;
    buf[o + 2] = r & 0xff;
    buf[o + 3] = 0;
  }
  // Pixel data, bottom-up
  for (let y = 0; y < canvasH; y++) {
    const srcRow = canvasH - 1 - y;
    const dst = pixelOffset + y * rowSize;
    for (let x = 0; x < canvasW; x++) {
      buf[dst + x] = canvas[srcRow * canvasW + x];
    }
  }
  return buf;
}

/** Parse a GB Studio hex palette ("E8F8E0") to an [r,g,b] triple. */
export function hexToRgb(hex: string): Rgb {
  const h = hex.replace(/^#/, "");
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}
