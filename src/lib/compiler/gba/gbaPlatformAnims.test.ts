import { platStateAnimRows } from "./gbaPlatformAnims";

// states_defines.h as compileStateDefines writes it: checkboxes bare, animation
// states as their statesOrder row, both padded to 32 columns.
const header = (lines: string[]) =>
  `#ifndef STATES_DEFINES_H\n#define STATES_DEFINES_H\n\n${lines.join(
    "\n",
  )}\n\n#endif\n`;

describe("platStateAnimRows", () => {
  test("no platform scenes, no overrides", () => {
    expect(platStateAnimRows("")).toEqual([
      -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    ]);
  });

  test("the stock gbs2 sample: Hurt on knockback and blank", () => {
    // gbs2 sets PLATFORM_KNOCKBACK_ANIM and PLATFORM_BLANK_ANIM to "Hurt", and both
    // feature flags default on.
    const rows = platStateAnimRows(
      header([
        "#define FEAT_PLATFORM_KNOCKBACK         ",
        "#define PLATFORM_KNOCKBACK_ANIM          3",
        "#define FEAT_PLATFORM_BLANK             ",
        "#define PLATFORM_BLANK_ANIM              3",
      ]),
    );
    expect(rows[6]).toBe(3); // KNOCKBACK
    expect(rows[7]).toBe(3); // BLANK
    expect(rows.filter((r) => r !== -1)).toHaveLength(2);
  });

  test("an override needs its state's feature flag, as platform.c does", () => {
    const rows = platStateAnimRows(
      header([
        "#define PLATFORM_KNOCKBACK_ANIM          3",
        "#define PLATFORM_JUMP_ANIM               2",
        "#define FEAT_PLATFORM_JUMP              ",
      ]),
    );
    expect(rows[6]).toBe(-1); // FEAT_PLATFORM_KNOCKBACK switched off
    expect(rows[2]).toBe(2);
  });

  test("the fall override has no flag, and ground has no override", () => {
    const rows = platStateAnimRows(
      header(["#define PLATFORM_FALL_ANIM               4"]),
    );
    expect(rows[0]).toBe(4);
    expect(rows[1]).toBe(-1);
  });

  test("the wall slide override needs both wall jump and jump", () => {
    const anim = "#define PLATFORM_WALL_SLIDE_ANIM         5";
    expect(
      platStateAnimRows(header([anim, "#define FEAT_PLATFORM_WALL_JUMP"]))[5],
    ).toBe(-1);
    expect(
      platStateAnimRows(
        header([
          anim,
          "#define FEAT_PLATFORM_WALL_JUMP",
          "#define FEAT_PLATFORM_JUMP",
        ]),
      )[5],
    ).toBe(5);
  });
});
