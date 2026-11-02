import { playerSpriteSheetIdFor, spriteBoundsSubpx } from "./gbaPlayerSprite";

const defaults = {
  TOPDOWN: "hero",
  PLATFORM: "jumper",
  POINTNCLICK: "cursor",
};
const sprites = new Set(["hero", "jumper", "cursor", "wizard"]);

describe("playerSpriteSheetIdFor", () => {
  test("uses the scene's own override", () => {
    expect(
      playerSpriteSheetIdFor(
        { type: "TOPDOWN", playerSpriteSheetId: "wizard" },
        defaults,
        sprites,
      ),
    ).toBe("wizard");
  });

  test("falls back to the project default for the scene's type", () => {
    // Every scene of the stock gbs2 sample is like this.
    expect(
      playerSpriteSheetIdFor({ type: "POINTNCLICK" }, defaults, sprites),
    ).toBe("cursor");
    expect(
      playerSpriteSheetIdFor({ type: "PLATFORM" }, defaults, sprites),
    ).toBe("jumper");
  });

  test("a scene with no type is top-down", () => {
    expect(playerSpriteSheetIdFor({}, defaults, sprites)).toBe("hero");
  });

  test("an override pointing at a deleted sprite falls back to the default", () => {
    expect(
      playerSpriteSheetIdFor(
        { type: "TOPDOWN", playerSpriteSheetId: "gone" },
        defaults,
        sprites,
      ),
    ).toBe("hero");
  });

  test("no override and no usable default means no player", () => {
    expect(playerSpriteSheetIdFor({ type: "SHMUP" }, defaults, sprites)).toBe(
      undefined,
    );
    expect(
      playerSpriteSheetIdFor({ type: "TOPDOWN" }, undefined, sprites),
    ).toBe(undefined);
  });
});

describe("spriteBoundsSubpx", () => {
  test("matches GB Studio's compileBounds, as [left, right, top, bottom]", () => {
    // The gbs2 cursor: 16x16 from (0, -8).
    expect(
      spriteBoundsSubpx({
        boundsX: 0,
        boundsY: -8,
        boundsWidth: 16,
        boundsHeight: 16,
      }),
    ).toEqual([0, 511, -256, 255]);
  });

  test("defaults to a 16x16 box at the position", () => {
    expect(spriteBoundsSubpx(undefined)).toEqual([0, 511, 0, 511]);
    expect(spriteBoundsSubpx({})).toEqual([0, 511, 0, 511]);
  });
});
