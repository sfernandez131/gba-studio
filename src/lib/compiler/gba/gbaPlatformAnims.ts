/**
 * The platformer's per-state animation overrides (gbs2 G3).
 *
 * GB Studio's PLATFORM_*_ANIM engine fields are compile-time defines. compileData writes
 * each one that is set to states_defines.h as the animation-state row it selects (its
 * statesOrder index), and platform.c applies it on entering that state - but only where
 * the state's feature flag is defined too, because the enter function lives inside that
 * flag's #ifdef. This reads the same header and applies the same guards.
 *
 * The result is one row per state in GB's state_e order (FALL, GROUND, JUMP, DASH, LADDER,
 * WALL, KNOCKBACK, BLANK, RUN, FLOAT), -1 for none, for gbavm's GBA_PLAT_STATE_ANIM.
 */
const PLAT_STATE_ANIMS: { anim?: string; requires: string[] }[] = [
  { anim: "PLATFORM_FALL_ANIM", requires: [] },
  { requires: [] }, // GROUND has no override; entering it restores the default
  { anim: "PLATFORM_JUMP_ANIM", requires: ["FEAT_PLATFORM_JUMP"] },
  { anim: "PLATFORM_DASH_ANIM", requires: ["FEAT_PLATFORM_DASH"] },
  { anim: "PLATFORM_LADDERS_ANIM", requires: ["FEAT_PLATFORM_LADDERS"] },
  {
    anim: "PLATFORM_WALL_SLIDE_ANIM",
    requires: ["FEAT_PLATFORM_WALL_JUMP", "FEAT_PLATFORM_JUMP"],
  },
  { anim: "PLATFORM_KNOCKBACK_ANIM", requires: ["FEAT_PLATFORM_KNOCKBACK"] },
  { anim: "PLATFORM_BLANK_ANIM", requires: ["FEAT_PLATFORM_BLANK"] },
  { anim: "PLATFORM_RUN_ANIM", requires: ["FEAT_PLATFORM_RUN"] },
  { anim: "PLATFORM_FLOAT_ANIM", requires: ["FEAT_PLATFORM_FLOAT"] },
];

export const platStateAnimRows = (statesDefines: string): number[] => {
  const defines = new Map<string, string>();
  for (const m of statesDefines.matchAll(/^#define\s+(\w+)[ \t]*(\S*)/gm)) {
    defines.set(m[1], m[2]);
  }
  return PLAT_STATE_ANIMS.map(({ anim, requires }) => {
    if (!anim || !requires.every((flag) => defines.has(flag))) return -1;
    const row = parseInt(defines.get(anim) ?? "", 10);
    return Number.isFinite(row) ? row : -1;
  });
};
