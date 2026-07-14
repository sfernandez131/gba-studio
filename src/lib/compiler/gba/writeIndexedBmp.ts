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
  data: Uint8Array | number[]; // one palette index (0..255) per pixel, top-down row-major
}

const ceilTo = (v: number, m: number): number =>
  Math.max(m, Math.ceil(v / m) * m);

/**
 * Compose a GBC-style banked background image (M12a): per-pixel GB shades
 * (0..3) + a per-8x8-tile palette index (0..7) become bank*16 + 1 + shade,
 * with a 128-entry palette laying each bank's 4 colours at indices 1..4
 * (index 0 of every bank = transparent/backdrop, GBA convention). Feed the
 * result to indexedImageToBmp and give the Butano item json
 * `"bpp_mode": "bpp_4_manual"` so per-tile bank attribution is preserved.
 */
export function composeBankedImage(
  shades: IndexedSource,
  tileBanks: number[],
  bankPalettes: string[][],
): { img: IndexedSource; palette: Rgb[] } {
  const tilesPerRow = Math.ceil(shades.width / 8);
  const data = new Uint8Array(shades.width * shades.height);
  for (let y = 0; y < shades.height; y++) {
    for (let x = 0; x < shades.width; x++) {
      const tile = (y >> 3) * tilesPerRow + (x >> 3);
      const bank = (tileBanks[tile] ?? 0) & 0x07;
      data[y * shades.width + x] =
        bank * 16 + 1 + (shades.data[y * shades.width + x] & 0x03);
    }
  }
  const palette: Rgb[] = new Array(128).fill([0, 0, 0] as Rgb);
  for (let b = 0; b < 8; b++) {
    const colors = bankPalettes[b];
    for (let c = 0; c < 4; c++) {
      palette[b * 16 + 1 + c] = hexToRgb(colors?.[c] ?? "000000");
    }
  }
  return { img: { width: shades.width, height: shades.height, data }, palette };
}

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

  // Canvas is top-down here; index 0 = backdrop, source image centred. Indices
  // above 15 are legal: multi-bank images (M12) address 16-colour banks as
  // bank*16 + colour (the old & 0x0f mask silently folded banks together).
  const canvas = new Uint8Array(canvasW * canvasH);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      canvas[(offY + y) * canvasW + (offX + x)] =
        src.data[y * src.width + x] & 0xff;
    }
  }

  // A 16-colour BMP is copied straight to grit (one palette); a >16-colour BMP
  // needs a 256-entry palette (butano/tools/bmp.py) and its bpp handling comes
  // from the item json: bpp_4_manual reads the palette as 16-colour banks with
  // each tile using exactly one bank (M12); no bpp_mode means 8bpp.
  const PALETTE_COLORS = palette.length > 16 ? 256 : 16;
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
