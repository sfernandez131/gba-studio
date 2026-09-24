# gbs2 plays end to end (design, 2026-09-23)

The goal: GB Studio's stock sample game (`appData/templates/gbs2`) plays through on the GBA,
not just builds. That was M13's stated success criterion ("the stock gbs2 sample builds and
plays on GBA"). As of gba-studio#123 it builds and boots to its title; with M14 its music
and sound effects play. This document scopes what is left between "boots" and "plays",
from a scene-by-scene boot of the real sample and from GB Studio's own engine sources.

## What the sample is

17 scenes across four scene types, and about 55 distinct events. Every scene, forced to be
the start scene and booted for 300 frames under the GDB stub (with a breakpoint on
Butano's assert handler), **boots cleanly: no assert, no hang, in any of the 17**.

| Scene                    | Type        | Size   | Actors | Triggers | Gap found                                  |
| ------------------------ | ----------- | ------ | ------ | -------- | ------------------------------------------ |
| ui/Logo                  | TOPDOWN     | 20×18  | 0      | 0        | —                                          |
| ui/Title Screen          | TOPDOWN     | 20×18  | 0      | 0        | RNG seed (`VM_RANDOMIZE`) dropped          |
| ui/menu/Menu Page 1, 2   | TOPDOWN     | 20×18  | 6, 5   | 0        | —                                          |
| Player's House           | POINTNCLICK | 20×18  | 0      | 11       | **no cursor: point-and-click unsupported** |
| town/Sample Town         | TOPDOWN     | 56×56  | 9      | 14       | —                                          |
| town/Top House           | TOPDOWN     | 20×18  | 5      | 1        | —                                          |
| town/Music House         | TOPDOWN     | 20×18  | 9      | 1        | —                                          |
| town/Launch Site         | TOPDOWN     | 20×18  | 6      | 2        | —                                          |
| path/Path to Sample Town | PLATFORM    | 161×18 | 7      | 6        | **knockback / blank states ignored**       |
| path/Parallax Example    | PLATFORM    | 80×18  | 2      | 1        | **parallax unsupported**                   |
| caves/Cave               | TOPDOWN     | 20×18  | 6      | 1        | —                                          |
| caves/Underground        | TOPDOWN     | 32×32  | 6      | 2        | —                                          |
| caves/Deeper Underground | PLATFORM    | 32×18  | 1      | 1        | —                                          |
| space/Deep Space         | TOPDOWN     | 32×32  | 3      | 1        | —                                          |
| space/Space Battle       | SHMUP       | 255×18 | 16     | 1        | —                                          |
| Dream                    | TOPDOWN     | 20×18  | 0      | 0        | —                                          |

"—" means nothing found by booting the scene and reading its events; it does not yet
mean the scene plays right. That is what the playthrough slice is for.

**Performance is not a problem.** Timed per main-loop section with a hardware timer (a
throwaway probe), **no scene missed a single frame** in 241 measured frames, and mGBA's
own counter shows about 60 fps for the sample. The heaviest scene, Space Battle, uses at
most 32% of a frame. The hUGE player and the sound effects together cost under 1%.
(Windows of mGBA that run under the GDB stub show about 18 fps, because the stub pauses
at a breakpoint every frame; that is the test harness, not the game.)

## The gaps

### Compile-time: four macros dropped

The build drops these with a warning (counts are occurrences in the sample):

- **`VM_SWITCH_TEXT_LAYER .TEXT_LAYER_WIN`** (76). gbvm points text rendering at the window
  layer or the background. gbavm always draws text in its overlay, which is the window
  layer, so `.TEXT_LAYER_WIN` is exactly what already happens: bridge it as a no-op.
  `.TEXT_LAYER_BKG` (text drawn into the scene) stays dropped with a note.
- **`VM_OVERLAY_SET_SCROLL x, y, w, h, color`** (69). This sets the region gbvm scrolls when
  a text runs past the bottom of its box. Whether gbavm needs it depends on how its
  dialogue already handles overflow; check that first, against a long text from the
  sample.
- **`VM_RANDOMIZE`** (1, the title screen's "Seed RNG" event). gbvm reseeds its RNG from
  the timer. gbavm seeds once at boot from a free-running timer; bridge this to reseed the
  same way, so the seed depends on when the player pressed Start, as on the GB.
- **Platformer state scripts**, `_plat_callback_attach` for **KNOCKBACK** and **BLANK** (2).
  #123 drops these deliberately, because gbavm's platformer has no such states. See below.

### Runtime: three features gbavm does not have

1. **Point-and-click scenes.** In gbvm's `pointnclick.c`, the player actor becomes a
   cursor: the d-pad moves it freely, and A runs the script of the actor or trigger under
   it. gbavm treats POINTNCLICK as "the player does not move", so Player's House, the
   sample's hub, cannot be used.
2. **Platformer knockback and blank states.** In Path to Sample Town, a turnip hitting the
   player sets the **knockback** state. Its start script sets **blank**, a no-control state
   with its own gravity (`plat_blank_grav`), and blank's start script restores **ground**.
   Two triggers also set blank. On the GBA:

   - "Set Platformer State" compiles to a write of `plat_next_state`, which gbavm lacks. The
     linker gives it a dummy variable (#123's weak engine vars), so the write is lost.
   - The same happens to `plat_blank_grav`.

   gbvm's `platform.c` is 2,566 lines of states (dash, wall slide, float, knockback, blank,
   run styles). The sample needs only knockback, blank, their start/end scripts, and the
   engine fields they read.

3. **Parallax** (Parallax Example only). Three bands, each scrolling at its own fraction of
   the camera. On the GB this is a mid-frame SCX change per band; on the GBA it maps
   naturally onto Butano's H-blank effects (`regular_bg_position_hbe`).

## G1 result (2026-09-23): the small bridges

gbavm#86 and gba-studio#127.

- **`VM_SWITCH_TEXT_LAYER .TEXT_LAYER_WIN` is handled, and emits nothing.** gbavm's overlay is
  the window layer, so this is already true. `.TEXT_LAYER_BKG` still drops with a note.
- **`VM_RANDOMIZE` is op `0x6D`.** The engine seeds with gbvm's `DIV + game_time * 256`, using
  a Butano timer for `DIV` and `sys_time` for `game_time`. Checked on the gbs2 title with a
  temporary probe pressing Start at frame 90: the seed was 23,269 = 229 + 90 × 256.
- **`VM_OVERLAY_SET_SCROLL` stays dropped, because gbs2 never needs it.** Its dialogue pages
  are at most 3 lines, in a 5-line text region, so no text overflows its box. It can be
  bridged when a project does overflow.

The gbs2 build now drops only the scroll region (69) and the two platformer state scripts
(G3). Matrix: 124/151 bridgeable (82%).

## G2 result (2026-09-24): the player exists, and point-and-click works

gbavm#87 and gba-studio#128.

- **No gbs2 scene had a player.** In GB Studio, a scene with no player sprite of its own
  uses the project's default for its scene type. The GBA eject read only the scene's own
  override, and none of the sample's 17 scenes sets one. So the sample had no player
  anywhere. The scene smoke test above could not see it, because a scene with no player
  still boots. The eject now applies GB Studio's rule, and all 17 scenes boot with a
  player.
- **Point-and-click.** gbvm's `pointnclick.c` is ported: 8-way cursor movement by angle,
  gbvm's clamp arithmetic, the bounding-box hover test against triggers and actors, and A
  to run the hit's script. That arithmetic is 16-bit and unsigned, as SDCC does it. Actors
  now carry their sprite's bounding box, which the editor converts exactly as GB Studio's
  `compileBounds` does.
- **Verified** on Player's House with a temporary input probe. The cursor's position
  matched gbvm's arithmetic to the subpixel (x 880, y 897 after 40 frames moving
  diagonally), it hovered the (4,4) text trigger, and A opened that trigger's dialogue.

## Slice plan

| Slice  | Scope                                                                                                                                                                   | Verify                                                                                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| G1     | **Done (2026-09-23), gbavm#86 / gba-studio#127.** Text layer no-op, `VM_RANDOMIZE`; the scroll region is not needed by gbs2. See "G1 result".                           | Unit tests; seed checked on the title (23,269 at frame 90).                                                                                     |
| G2     | **Done (2026-09-24), gbavm#87 / gba-studio#128.** Point-and-click, and the player-sprite default: gbs2 had no player in any scene. See "G2 result".                     | Cursor position exact against gbvm's arithmetic; a trigger hovered and fired on Player's House.                                                 |
| **G3** | Platformer knockback + blank: the two states, `plat_next_state`, their start/end scripts (unblocks #123's dropped callbacks), and `plat_blank_grav` / knockback fields. | Fixture: set knockback, assert the state sequence knockback → blank → ground and the callback runs; then the turnip hit in Path to Sample Town. |
| **G4** | Parallax bands via H-blank effects.                                                                                                                                     | GDB: per-band scroll values vs the camera; eyes-on in Parallax Example.                                                                         |
| **G5** | Playthrough: drive the sample from the title through each area with scripted input (a probe replaying a button sequence), log what breaks, fix or ledger it.            | Every area reached; an eyes-on playthrough by the user closes the milestone.                                                                    |

Order: G1 first (small, clears the build log), then G2 (it blocks the hub, so it blocks
G5), then G3 and G4, then G5.

## Verification

The GDB-stub discipline from M14 applies: independent references built from gbvm's sources
where behaviour is computable, forced-input probes (gated on `sys_time`, never on a call
counter) where it depends on the player, and one CI runtime assert per slice in
`scripts/gba-runtime-test.sh`. Test runs launch mGBA minimised and muted, so they do not
appear on the user's desktop. Anything that is about how the game _feels_ ends in an
eyes-on check by the user.
