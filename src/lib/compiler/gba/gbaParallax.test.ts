import { gbaParallaxBands, parallaxBandImage } from "./gbaParallax";

describe("gbaParallaxBands", () => {
  test("no parallax, or a scene no wider than the GB screen", () => {
    expect(gbaParallaxBands(undefined, 80)).toEqual([]);
    expect(gbaParallaxBands([], 80)).toEqual([]);
    // compileParallax drops the layers for a 20-tile scene.
    expect(
      gbaParallaxBands(
        [
          { height: 4, speed: 2 },
          { height: 0, speed: 0 },
        ],
        20,
      ),
    ).toEqual([]);
  });

  test("gbs2's Parallax Example: two bands over the normal view", () => {
    // PARALLAX_STEP(0, 10, 4), (10, 13, 1), (13, 0, 1): the last row has no end,
    // so it is the normal view and its speed is ignored.
    expect(
      gbaParallaxBands(
        [
          { height: 10, speed: 4 },
          { height: 3, speed: 1 },
          { height: 1, speed: 0 },
        ],
        80,
      ),
    ).toEqual([
      { startRow: 0, endRow: 10, shift: 4 },
      { startRow: 10, endRow: 13, shift: 1 },
    ]);
  });

  test("a last layer at camera speed is the normal view", () => {
    expect(
      gbaParallaxBands(
        [
          { height: 6, speed: 2 },
          { height: 12, speed: 0 },
        ],
        40,
      ),
    ).toEqual([{ startRow: 0, endRow: 6, shift: 2 }]);
  });

  test("a slower last layer reaches the bottom of the GBA screen", () => {
    // compileParallax ends it at GB row 18 and appends PARALLAX_STEP(18, 0, 0).
    expect(
      gbaParallaxBands(
        [
          { height: 6, speed: 0 },
          { height: 12, speed: 3 },
        ],
        40,
      ),
    ).toEqual([
      { startRow: 0, endRow: 6, shift: 0 },
      { startRow: 6, endRow: 20, shift: 3 },
    ]);
    expect(gbaParallaxBands([{ height: 18, speed: 1 }], 40)).toEqual([
      { startRow: 0, endRow: 20, shift: 1 },
    ]);
  });

  test("a single layer at camera speed is no parallax", () => {
    expect(gbaParallaxBands([{ height: 18, speed: 0 }], 40)).toEqual([]);
  });

  test("fixed position is gbvm's -128", () => {
    expect(
      gbaParallaxBands(
        [
          { height: 4, speed: 128 },
          { height: 14, speed: 0 },
        ],
        40,
      ),
    ).toEqual([{ startRow: 0, endRow: 4, shift: -128 }]);
  });

  test("a first band with no height ends the chain, as in gbvm", () => {
    // PARALLAX_STEP(0, 0, 2) has no end, so gbvm treats the scene as having none.
    expect(
      gbaParallaxBands(
        [
          { height: 0, speed: 2 },
          { height: 4, speed: 1 },
          { height: 14, speed: 0 },
        ],
        40,
      ),
    ).toEqual([]);
  });
});

describe("parallaxBandImage", () => {
  test("keeps only the band's rows", () => {
    // 2 px wide, 3 tile rows tall; each row's pixels hold the row index + 1.
    const width = 2;
    const height = 24;
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) data.fill((y >> 3) + 1, y * 2, y * 2 + 2);
    const band = parallaxBandImage(
      { width, height, data },
      { startRow: 1, endRow: 2, shift: 1 },
    );
    expect(band.width).toBe(width);
    expect(band.height).toBe(height);
    expect(Array.from(band.data.slice(0, 16))).toEqual(new Array(16).fill(0));
    expect(Array.from(band.data.slice(16, 32))).toEqual(new Array(16).fill(2));
    expect(Array.from(band.data.slice(32))).toEqual(new Array(16).fill(0));
  });

  test("a band past the image's bottom is clipped", () => {
    const band = parallaxBandImage(
      { width: 1, height: 8, data: new Uint8Array(8).fill(3) },
      { startRow: 0, endRow: 20, shift: 1 },
    );
    expect(Array.from(band.data)).toEqual(new Array(8).fill(3));
  });
});
