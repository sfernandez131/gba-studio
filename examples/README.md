# GBA example & regression projects

Sample projects used to develop and verify the GBA target. Build any of them with:

```
GBAVM_ROOT=<path-to-gbavm> DEVKITPRO=C:/devkitPro \
  node out/cli/gb-studio-cli.js make:gba <project>/project.gbsproj <out>.gba
```

(Re-build the CLI first with `npm run make:cli` after TypeScript changes.)

- **gba_demo** — the "Lost Gem" sample game (M6 deliverable). Village + Cave scenes,
  dialogue, music and sound effects; used as the testbed for the per-track DMG/Maxmod
  audio backend (Mc) and the side-by-side audio demo (Md).
- **gba_min_project** — minimal regression fixture: one POINTNCLICK scene + a player
  actor whose update script is the verified "If Input → Set Position Relative" d-pad
  pattern. Fastest smoke test that the GBVM→GBA bytecode bridge still builds green.
- **gba_actor_test** — actor/scene fixture grown across milestones: TOPDOWN scene with
  the built-in player controller, a collision wall (M3d), scrolling camera bg (M2c),
  and multi-line/variable-speed dialogue (M4f/M4g). The standard visual-verification
  project for mGBA runs.
