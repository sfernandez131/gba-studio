# M15 — The Lost Gem: showcase demo game (design, 2026-08-06)

Per the roadmap: *"A complete game (not a fixture): multiple scene types, color,
menus/saves, both audio backends, affine effect, L/R usage — every GBA capability
visible. This is both the marketing artifact and the final integration test; build
it early-iteratively (expand Lost Gem) rather than big-bang."*

M15 grows the existing `examples/gba_demo` ("The Lost Gem") from a 2-scene vertical
slice into a short but complete game whose every section exists to *show off* a
shipped capability. **CI already builds this project every PR** (`gba-integration`
→ `out-ci/lost_gem.gba`), so each slice is self-guarding: if a capability breaks,
the demo stops building.

## Where the demo stands today

| Aspect | Today |
| --- | --- |
| Scenes | 2 — Village, Cave (both `TOPDOWN`) |
| Story | A gem is lost in the cave south of the village; find it, become a hero |
| Shown off | colour palettes (M12), DMG music **and** Maxmod tracker (M5/Md), SFX, SRAM save, camera shake, dialogue |
| Event types used | 8 (`TEXT`, `SWITCH_SCENE`, `MUSIC_PLAY`, `IF_TRUE`, `SOUND_PLAY_EFFECT`, `SET_VALUE`, `SAVE_DATA`, `CAMERA_SHAKE`) |
| Assets | 2 backgrounds, 3 sprite sheets, 5 music, 3 sounds |

Everything shipped since — menus, the platformer, SHMUP, Mode-7, L/R, projectiles,
emotes, animation states, runtime palette swaps, timers, the 21-actor cap, custom
C++ — is **invisible in the demo**. M15 fixes that.

## The expanded game

The existing quest stays; the middle act grows so each new section is a genuine
gameplay beat, not a tech demo bolted on:

1. **Title** *(new)* — logo, a menu: New Game / Continue (Continue only when a save
   exists).
2. **Village** *(exists)* — the Elder gives the quest. Grows: a crowd, NPC emotes,
   animation states, a day→dusk palette shift.
3. **Cave** *(exists)* — the entrance; leads deeper.
4. **Mine Shaft** *(new)* — a `PLATFORM` descent: jumps, ladders, one-way ledges.
5. **Gem Vision** *(new)* — touching the Gem triggers a Mode-7 vision; **L/R steer**
   the rotating world, and it zooms as the vision intensifies.
6. **Escape** *(new)* — the mine collapses: a `SHMUP` auto-scroll flight with
   projectiles.
7. **Ending** — back to the Village as a hero; a custom-C++ flourish + final palette.

## Capability → scene map (the point of the milestone)

| Capability | Milestone | Where it shows | Slice |
| --- | --- | --- | --- |
| TOPDOWN scenes | M13a | Village, Cave | have |
| Colour palettes (bg + sprite) | M12a/b | every scene | have |
| DMG music / Maxmod tracker | M5a / Md | Village / Cave | have |
| SFX, camera shake, dialogue | M5b/M6h/M4 | throughout | have |
| SRAM save | M6a | Village save point | have |
| **Menus (VM_CHOICE)** | M11a | **Title** | M15b |
| **Save-peek → "Continue"** | M6a | **Title** | M15b |
| **PLATFORM physics + ladders/one-ways** | M13b–d | **Mine Shaft** | M15c |
| **Affine Mode-7 (0x97/0x98/0x99/0x9A)** | M8d | **Gem Vision** | M15d |
| **L/R buttons** | M8a | **Gem Vision** steering | M15d |
| **SHMUP auto-scroll** | M13f | **Escape** | M15e |
| **Projectiles** | M10f | **Escape** | M15e |
| **Emotes / animation states** | M10d / M10c | Village NPCs | M15f |
| **Runtime palette swaps** | M12c/d | day→dusk, gem glow | M15f |
| **Timers** | M6f | Escape countdown | M15f |
| **21-actor cap** | M8b | Village crowd | M15f |
| **Custom C++ (0x9B)** | M8e | ending flourish | M15f |
| Avatars in dialogue | M4m | Elder portrait | M15f |

## Slice plan

| Slice | Scope | Verify |
| --- | --- | --- |
| **M15a** | This design doc. | — |
| **M15b** | **Title + menu**: a Title scene, `VM_CHOICE` menu (New Game / Continue), Continue gated on save-peek; wire the existing save. | GDB: the choice-result variable + the branch taken; ROM builds. |
| **M15c** | **Mine Shaft** (`PLATFORM`): collision art with ledges + a ladder; the descent connects Cave → Gem. | GDB: `plat_state` / `plat_vel_y` during a fall+land. |
| **M15d** | **Gem Vision** (affine): an affine scene; the Gem's vision rotates, L/R steer (angle-from-variable), scale pulses. | GDB: `gba_bg_angle` tracks the heading var; DISPCNT mode 1. |
| **M15e** | **Escape** (`SHMUP`): auto-scroll flight out of the mine, projectiles vs falling rocks. | GDB: `shmup_cam_y` advancing; a projectile launch. |
| **M15f** | **Polish + ending**: emotes, animation states, day→dusk palette swap, a timer, the Village crowd (>12 actors), a custom-C++ flourish, avatars, the ending. | GDB spot-asserts; eyes-on. |

Each slice is a normal PR: build `examples/gba_demo` via the CLI, GDB-assert the
capability it adds, ship an eyes-on ROM at the repos root, and keep the loose +
`examples/` copies in sync (the fixture rule applies to the demo too).

## Art strategy

The demo's art is small indexed PNGs. New scenes need new art, and there's no
artist in the loop, so: **generate it programmatically** — a small pure-stdlib
Python PNG writer (`zlib` + `struct`, no PIL on this machine), emitting 4-shade
GB-palette tile art (the same approach already used for the generated
`cave_theme.mod` and the M8d affine BMP).

The goal is *legible and on-model*, not beautiful: flat tiles, clear silhouettes,
readable collision (a ledge looks like a ledge). **Accepted trade-off:** the demo
proves the engine, not the artist — a real art pass is explicitly out of scope and
would be a later, purely-content PR. Backgrounds stay within the engine's limits
(≤512 px per axis for regular bgs; affine art is square 8bpp per M8d).

## Verification

Per-slice GDB asserts on the exported globals each capability already publishes
(`plat_state`, `shmup_cam_y`, `gba_bg_angle`, `gba_bg_scale`, `script_memory[...]`
for menu results) — the same headless discipline as every milestone so far, now
run against the *demo* rather than the fixture. Plus: CI builds the demo on every
PR, and `reportRomStats` keeps ROM/IWRAM/EWRAM visible in the build log.

## Risks

1. **Art quality.** Programmatic art is functional, not pretty. Mitigated by
   scoping it as "legible", and by keeping art in separate, replaceable PNGs.
2. **ROM / VRAM growth.** More scenes + more sprite sheets push sprite tile VRAM
   (the real limit found in M8b) and ROM size. Watch `reportRomStats` each slice;
   keep per-scene distinct-sprite counts modest.
3. **Scene-count complexity.** More scenes means more save/scene-stack surface;
   keep the flow linear (no deep scene-stack nesting) so a broken transition is
   obvious.
4. **Demo vs fixture divergence.** `gba_actor_test` stays the *unit* fixture with
   its GDB asserts; the demo is the *integration* artifact. Capabilities keep their
   fixture coverage — the demo is additive, never the only proof.
5. **Modal dialogue pauses actor update scripts** (banked in M8c): any per-frame
   demo logic must not sit behind an undismissed textbox.
