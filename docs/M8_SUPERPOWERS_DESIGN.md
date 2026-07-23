# M8 — GBA superpowers: design (2026-07-23)

Design-first per the roadmap. M8 is the "plus" in the superset: GBA-exclusive
capabilities the Game Boy can't do, exposed as **additive, GBA-gated** features so
GB/GBC projects are untouched. Facts verified against the fork's engine + editor and
Butano 21.7.0 on 2026-07-23.

## The big de-riskers (Butano already ships these)

Scoping found that most M8 hardware is already wrapped by Butano — the work is
bridging, not bare-metal:

- **L/R buttons**: `bn::keypad::l_held()` / `r_held()` exist. Engine cost ~2 lines.
- **Affine / Mode-7**: `bn::affine_bg_ptr` (rotation/scale backgrounds) + affine
  sprites are first-class Butano types.
- **Link cable**: **Butano has a full multiplayer stack** — `bn_link.h`,
  `bn_link_player.h`, `bn_link_state.h`, `bn_config_link.h`. No bare SIO register work.
- **128 sprites**: pure hardware headroom; the limit is the engine's `MAX_ACTORS = 8`
  (`hw.cpp`), not the GBA.

## The GBA side today (facts)

- **Input**: `hw_input_get` (op 0x54) builds GB Studio's 8-bit `KEY_BITS` mask
  (right 0x01 … start 0x80) into a **uint16_t** dst — bits 8/9 are free for L/R.
  Editor `KEY_BITS` (`lib/compiler/helpers.ts`) has no l/r; the "If Input" event's
  gamepad field lists the 8 GB buttons.
- **Actors**: `MAX_ACTORS = 8`, `Actor actors[8]`, per-scene sprite tables sized to
  the placed-actor count. Raising the cap touches the actor array + the eject sprite
  tables, not the render loop shape.
- **Background**: scenes use one `bn::regular_bg_ptr` (`gba_create_scene_bg`). Affine
  is a _different_ bg type (`bn::affine_bg_ptr`) with its own item pipeline.
- **Platform gating**: `settings.platform === "gba"` already gates GBA-only editor UI
  (M7b pattern) — every M8 editor surface rides it.

## Slice plan (smallest / highest-leverage first)

| Slice | Scope                                                                                                                                                                                                                                                           | Repos                               | Verify                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| M8a   | **L/R buttons**: engine sets mask bits 0x100/0x200 from `l_held`/`r_held`; editor adds `l`/`r` to KEY_BITS + the If-Input / Input-Attach gamepad options, GBA-gated.                                                                                            | engine + editor                     | GDB: poke KEYINPUT? no (Butano latches) → read the mask via a fixture "If Input L" branch that sets a var; assert the var. Eyes-on for the press. |
| M8b   | **128-sprite budget**: raise `MAX_ACTORS` (8 → e.g. 32, a safe Butano sprite budget alongside projectiles/emote/text) and confirm the eject sprite tables + collision scan scale.                                                                               | engine (+ editor if per-scene caps) | GDB: MAX_ACTORS symbol / a fixture scene with >8 actors all active.                                                                               |
| M8c   | **L/R as camera / affine control demo** — deferred until M8d lands.                                                                                                                                                                                             | —                                   | —                                                                                                                                                 |
| M8d   | **Affine background event**: a GBA-only "Set Background Mode-7 / rotate+scale" event → engine swaps the scene bg to `bn::affine_bg_ptr` and applies rotation/scale from script vars. Needs an affine-bg asset path in eject (distinct from the regular_bg BMP). | engine + editor                     | GDB: read the affine matrix / bg angle global per frame; eyes-on for the visual.                                                                  |
| M8e   | **C++/Butano escape-hatch event**: a GBA-only "Custom C++" event whose text body is emitted verbatim into a generated `gba_user_<n>()` function, called from a bridged op. Sandboxed to a documented API surface.                                               | engine + editor                     | Build a fixture using it; GDB assert the hook ran (a var write).                                                                                  |
| M8f   | **Link cable** (largest): design a minimal protocol over `bn::link` (2-player state exchange), a "Link: Send/Receive" event pair. Verify with **two mGBA instances** wired via the link socket (mGBA supports `--link`).                                        | engine + editor                     | 2-instance mGBA; assert exchanged values. Scope `bn_link_player.h` FIRST.                                                                         |

**Order rationale**: M8a (L/R) and M8b (sprite budget) are small, additive, and
independently shippable. Affine (M8d) is the marquee visual superpower and wants its
own asset pipeline slice. The escape hatch (M8e) and link cable (M8f) are the
design-heavy tail — each deserves its own scoping pass before coding (M8f especially:
protocol + 2-instance test harness).

## M8d affine spike result (2026-07-23)

**The affine asset pipeline is de-risked.** A generated 256x256 8bpp BMP with a
256-colour palette + `{"type": "affine_bg"}` json imports cleanly through Butano's
graphics tool (`bn_affine_bg_items_<name>.h` generated, ~5KB tiles+map). Confirmed
constraints: affine bgs are **8bpp, square, side in {128, 256, 512, 1024}** (non-`big`),
with 8-bit `affine_bg_map_cell`s (vs regular_bg's 16-bit). The `bn::affine_bg_ptr` API
(`create_bg`, `set_rotation_angle`, `set_scale`, `set_camera`) is standard Butano.

**M8d implementation plan (next):**

1. **Scene opt-in** — a GBA-only scene flag (or a distinct affine scene setting) gates
   the affine path; regular scenes are untouched.
2. **Eject** — for an affine scene, emit the bg as an 8bpp square BMP (pad the scene
   image onto a 256x256 canvas, index 0 backdrop) + affine json, and generate a
   `gba_create_scene_affine_bg(idx)` switch beside `gba_create_scene_bg`.
3. **Engine** — `hw_load_scene` creates a `bn::affine_bg_ptr` for affine scenes (store
   it alongside the regular `scene_bg`); a new op **VM_SET_BG_TRANSFORM** (rotate/scale)
   from script vars drives `set_rotation_angle`/`set_scale`. Export the angle for GDB.
4. **Editor** — a GBA-gated "Rotate/Scale Background (Mode-7)" event bridged to the op.
5. **Verify** — GDB reads the exported rotation angle advancing per frame; eyes-on for
   the visual. Fixture: an affine scene rotating slowly.

Deferred within M8d: affine sprites, per-scanline Mode-7 (HDMA) perspective.

## Cross-cutting rules

- **Additive + GBA-gated**: no M8 feature may change GB/GBC output. Editor UI gates on
  `platform === "gba"`; engine additions are new ops / new globals, never changes to
  existing GB-shared opcodes.
- **Verification**: same discipline — GDB frame-sampling of exported globals for the
  headless-observable parts, eyes-on ROMs for input/visual parts, and a runtime-test
  assert for any new engine-field default (the plat\_\*/shooter_scroll_speed pattern).
- **Upstream-merge surface (M16)**: keep each superpower a clean parallel backend
  addition, not a modification of shared code — the 19-file divergence discipline.

## Risks

1. **Affine asset pipeline** — affine bgs have different size/format constraints
   (square power-of-two maps) than regular bgs; the eject BMP path needs a separate
   branch. Spike the Butano affine_bg import before M8d.
2. **Link cable verification** — needs a two-instance mGBA harness that doesn't exist
   yet; the biggest unknown. Prototype the harness during M8f scoping, not after.
3. **Escape hatch safety** — arbitrary C++ can break the build or the VM; constrain to
   a documented, reviewed API and mark projects using it as non-portable.
4. **Sprite budget vs VRAM** — 128 OAM entries is HW; Butano sprite VRAM/tiles are the
   real limit. **Measured (M8b, 2026-07-23): 6/10/12 total actors run at a full 60fps
   alongside the fixture's dialogue text + projectile sprites, but 14 trips Butano's
   sprite budget (60fps -> a hard ~0.6fps cliff, i.e. an assert). MAX_ACTORS was raised
   8 -> 12 (conservative, GDB-verified); going higher needs sprite-VRAM budgeting -
   shared actor tiles for same-sprite actors and/or a larger Butano sprite pool
   (BN_CFG). That budgeting is its own follow-up slice.**
