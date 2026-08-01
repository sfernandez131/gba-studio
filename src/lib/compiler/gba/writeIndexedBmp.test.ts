import {
  composeBankedImage,
  indexedImageToBmp,
} from "lib/compiler/gba/writeIndexedBmp";
import { dominantPaletteIndex } from "lib/compiler/gba/writeSpriteSheet";

describe("composeBankedImage (M12a GBC palette banks)", () => {
  // Two 8x8 tiles side by side: left tile shades 0..3, right tile all shade 1.
  const shades = {
    width: 16,
    height: 8,
    data: new Uint8Array(16 * 8).map((_, i) => {
      const x = i % 16;
      return x < 8 ? x % 4 : 1;
    }),
  };
  const palA = ["E8F8E0", "B0F088", "509878", "202850"];
  const palB = ["FFFFFF", "FF0000", "880000", "000000"];

  test("maps each tile's shades into its bank's 16-colour window", () => {
    const { img } = composeBankedImage(shades, [0, 3], [palA, palB, [], palB]);
    // Left tile (bank 0): shade s -> 1 + s.
    expect(img.data[0]).toBe(1); // shade 0
    expect(img.data[3]).toBe(4); // shade 3
    // Right tile (bank 3): shade 1 -> 3*16 + 2 = 50.
    expect(img.data[8]).toBe(50);
  });

  test("lays each bank's 4 colours at indices bank*16 + 1..4", () => {
    const { palette } = composeBankedImage(
      shades,
      [0, 3],
      [palA, [], [], palB],
    );
    expect(palette).toHaveLength(128);
    expect(palette[1]).toEqual([0xe8, 0xf8, 0xe0]); // bank 0 colour 1
    expect(palette[4]).toEqual([0x20, 0x28, 0x50]); // bank 0 colour 4
    expect(palette[3 * 16 + 2]).toEqual([0xff, 0x00, 0x00]); // bank 3 colour 2
    expect(palette[0]).toEqual([0, 0, 0]); // backdrop stays 0
  });

  test("missing tile banks and palettes fall back to bank 0 / black", () => {
    const { img, palette } = composeBankedImage(shades, [], [palA]);
    expect(img.data[8]).toBe(2); // right tile defaults to bank 0
    expect(palette[17]).toEqual([0, 0, 0]); // unused bank 1 padded black
  });
});

describe("indexedImageToBmp multi-bank passthrough", () => {
  test("keeps indices above 15 (bank bits) intact", () => {
    const bmp = indexedImageToBmp(
      { width: 8, height: 8, data: new Uint8Array(64).fill(50) },
      new Array(128).fill([1, 2, 3]),
      { align: 8 },
    );
    const pixelOffset = bmp.readUInt32LE(10);
    // 8x8 at align 8 stays 8x8; every pixel byte must still be 50, not 50 & 0x0f.
    expect(bmp[pixelOffset]).toBe(50);
    // >16-colour palette emits the full 256-entry table.
    expect(bmp.readUInt32LE(46)).toBe(256);
  });
});

describe("indexedImageToBmp square affine canvas (M8d)", () => {
  test("forces a square SxS 8bpp canvas and centres the source", () => {
    // 16x8 source (index 7) padded onto a 256x256 affine canvas.
    const bmp = indexedImageToBmp(
      { width: 16, height: 8, data: new Uint8Array(16 * 8).fill(7) },
      new Array(256).fill([0, 0, 0]),
      { square: 256 },
    );
    // BITMAPINFOHEADER: width/height both 256, 8bpp.
    expect(bmp.readInt32LE(18)).toBe(256); // canvas width
    expect(bmp.readInt32LE(22)).toBe(256); // canvas height
    expect(bmp.readUInt16LE(28)).toBe(8); // bits per pixel
    const pixelOffset = bmp.readUInt32LE(10);
    // Rows are stored bottom-up; the 16x8 block is centred at
    // offX=(256-16)/2=120, offY=(256-8)/2=124. Probe its centre pixel.
    const cx = 120 + 8;
    const cy = 124 + 4;
    const bottomUpRow = 256 - 1 - cy;
    expect(bmp[pixelOffset + bottomUpRow * 256 + cx]).toBe(7);
    // A corner stays backdrop (index 0).
    expect(bmp[pixelOffset]).toBe(0);
  });

  test("square side overrides align and stays power-of-two divisible by 4", () => {
    const bmp = indexedImageToBmp(
      { width: 8, height: 8, data: new Uint8Array(64).fill(1) },
      new Array(256).fill([0, 0, 0]),
      { square: 128 },
    );
    expect(bmp.readInt32LE(18)).toBe(128);
    expect(bmp.readInt32LE(22)).toBe(128);
  });
});

describe("dominantPaletteIndex (M12b sprite palettes)", () => {
  const sheet = (indices: number[]) => ({
    states: [
      {
        animations: [
          {
            frames: [
              { tiles: indices.map((paletteIndex) => ({ paletteIndex })) },
            ],
          },
        ],
      },
    ],
  });

  test("picks the modal slot, lowest wins ties", () => {
    expect(dominantPaletteIndex(sheet([2, 2, 5]))).toBe(2);
    expect(dominantPaletteIndex(sheet([5, 2]))).toBe(2); // tie -> lowest
  });

  test("empty sheets and missing indices default to slot 0", () => {
    expect(dominantPaletteIndex({ states: [] })).toBe(0);
    expect(
      dominantPaletteIndex({
        states: [{ animations: [{ frames: [{ tiles: [{}] }] }] }],
      }),
    ).toBe(0);
  });
});
