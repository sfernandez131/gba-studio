import { makeIndexedImage } from "shared/lib/tiles/indexedImage";
import { buildSpriteSheet, gbaSpriteFrameSize } from "./writeSpriteSheet";

describe("gbaSpriteFrameSize", () => {
  test.each([
    // already a GBA shape: unchanged
    [16, 16, 16, 16],
    [32, 16, 32, 16],
    [16, 32, 16, 32],
    [64, 64, 64, 64],
    // not a GBA shape: the smallest shape that holds it
    [24, 24, 32, 32],
    [24, 16, 32, 16],
    [8, 24, 8, 32],
    [48, 16, 64, 32],
    [40, 40, 64, 64],
  ])("%ix%i canvas -> %ix%i frame, uncropped", (cw, ch, w, h) => {
    expect(gbaSpriteFrameSize(cw, ch)).toEqual({
      width: w,
      height: h,
      cropped: false,
    });
  });

  test.each([
    // gbs2's elephant: too wide for any shape
    [80, 48, 64, 64],
    [72, 16, 64, 32],
    [8, 72, 32, 64],
    [160, 160, 64, 64],
  ])("%ix%i canvas -> %ix%i frame, cropped", (cw, ch, w, h) => {
    expect(gbaSpriteFrameSize(cw, ch)).toEqual({
      width: w,
      height: h,
      cropped: true,
    });
  });
});

describe("buildSpriteSheet frame fitting", () => {
  // A source image whose 8x8 tile at (sliceX, 0) is solid colour 3.
  const solidTileSource = (width: number) => {
    const src = makeIndexedImage(width, 8);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < width; x++) src.data[y * width + x] = 3;
    }
    return src;
  };
  const oneTileSprite = (
    canvasWidth: number,
    canvasHeight: number,
    x: number,
    y: number,
  ) => ({
    canvasWidth,
    canvasHeight,
    states: [
      {
        name: "",
        animationType: "fixed",
        flipLeft: false,
        animations: [
          {
            frames: [
              {
                tiles: [
                  { x, y, sliceX: 0, sliceY: 0, flipX: false, flipY: false },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const pixel = (
    sheet: ReturnType<typeof buildSpriteSheet>,
    x: number,
    y: number,
  ) => sheet.sheet.data[y * sheet.frameWidth + x];

  test("centres a 24x16 canvas in a 32x16 frame (4px each side)", () => {
    const sheet = buildSpriteSheet(
      oneTileSprite(24, 16, 0, 0),
      solidTileSource(8),
      "8x8",
    );
    expect(sheet.frameWidth).toBe(32);
    expect(sheet.frameHeight).toBe(16);
    expect(sheet.cropped).toBe(false);
    expect(sheet.sheet.width).toBe(32);
    // The tile at canvas x 0..7 lands at frame x 4..11.
    expect(pixel(sheet, 3, 0)).toBe(0);
    expect(pixel(sheet, 4, 0)).toBe(3);
    expect(pixel(sheet, 11, 7)).toBe(3);
    expect(pixel(sheet, 12, 0)).toBe(0);
  });

  test("an 80x48 canvas is cropped to 64 wide and padded to 64 high", () => {
    const edge = buildSpriteSheet(
      oneTileSprite(80, 48, 0, 0),
      solidTileSource(8),
      "8x8",
    );
    expect(edge.frameWidth).toBe(64);
    expect(edge.frameHeight).toBe(64);
    expect(edge.cropped).toBe(true);
    // A tile on the canvas's outer 8 columns falls outside the frame entirely.
    expect(edge.sheet.data.slice(0, 64 * 64).every((v) => v === 0)).toBe(true);

    const inside = buildSpriteSheet(
      oneTileSprite(80, 48, 8, 0),
      solidTileSource(8),
      "8x8",
    );
    // Canvas x 8 -> frame x 0; canvas y 0 -> frame y 8 (8px of padding above).
    expect(pixel(inside, 0, 7)).toBe(0);
    expect(pixel(inside, 0, 8)).toBe(3);
    expect(pixel(inside, 7, 15)).toBe(3);
    expect(pixel(inside, 8, 8)).toBe(0);
  });
});
