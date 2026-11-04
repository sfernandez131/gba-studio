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

## G3 result (2026-11-01): knockback, blank, and state scripts

gbavm#88 and gba-studio#129.

- **`plat_next_state` is real.** "Set Platformer State" writes it, and the platformer
  applies it at the top of its next update, with the leaving state's exit and the
  entering state's enter, as gbvm does. gbavm's own transitions still happen inline, a
  frame ahead of gbvm, so their hooks run at the end of that update instead.
- **KNOCKBACK and BLANK are ported**, with GB's four tunables at their `engine.json`
  defaults. BLANK's collision pass is Y-only and tests no trigger, as in gbvm.
- **State scripts run.** The bridge rewrites "Set/Remove Platformer Script" into two new
  ops that carry the script as a real pointer (a 16-bit stack slot cannot hold a GBA
  address), and gbavm keeps gbvm's 21-slot table. gbs2's two state scripts are no longer
  dropped; the build now drops only the scroll region.
- **Animation overrides.** GB's `PLATFORM_*_ANIM` fields ("Hurt" on knockback and blank in
  gbs2) are read from the compiled `states_defines.h` and shown on entering their state.
- **A new editor test** checks every op the editor emits against the engine's
  `vm_args_len`, the class of bug that killed scripts silently in M14.
- **Verified.** In CI, the fixture's four state scripts chain knockback → blank → ground in
  order, and knockback's entry velocities are GB's. On a scratch copy of gbs2 started in
  Path to Sample Town: a pit sets BLANK, shows "Hurt" and runs the sample's On Blank; a
  scripted knockback runs On Knockback to its end, lands after 30 frames, and restores the
  default animation.

**The turnip hit could not be checked, and that is a gap of its own.** The turnips knock
the player back from their "On Hit: Player" script. GB runs that when the player overlaps
an actor that has a collision group (`actor_overlapping_player` in every scene type's
collision pass, then `actors_handle_player_collision` in the main loop: the scene's
player-hit script with the group, the actor's script, and 20 frames of invincibility).
gbavm runs actor scripts only on an A-press or a projectile hit. Space Battle's enemies
need the same thing. Slice **G3b** below.

### Found along the way (not G3, each a fix of its own)

- **The platformer runs at twice GB's speed.** `plat_delta_subpx` converts velocity with
  `(v >> 8) << 2`; its comment assumes GB uses 16 subpixels per pixel, but GB Studio 4
  uses 32 (`SUBPX_TO_PX` is `>> 5`), as gbavm does, and its `VEL_TO_SUBPX` is
  `(v >> 8) << 1`. So walking, jumping and knockback all cover double the distance: a
  gbs2 knockback moved the player 2,388 subpixels (about 9 tiles). The SHMUP drag carries
  the same 16-per-pixel premise in its comment. GB also clamps each step to `MAX_DELTA`
  (127 subpixels); gbavm does not. This changes the feel of every platformer project,
  including the Lost Gem's mine shaft, so it wants an eyes-on comparison against a GB
  build.
- **The player moves while the VM is locked.** gbvm skips its whole state update under a
  lock (a scene's init, a modal dialogue, a menu); gbavm's `hw_player_update` does not
  check. G2 added `vm_is_locked` and uses it for point-and-click only.
- **On Blank's respawn lands at the wrong place.** The scene calls the On Blank custom
  event with ResetPosX 50 and ResetPosY 13, passed by value; the player arrives at tile
  (7, 0). The state change itself is right, so the by-value arguments look lost on the way
  into the custom event. G5 territory. **Fixed** (see "Custom-event arguments"): it now
  lands at (50, 13).

## G3b result (2026-11-02): player-vs-actor collision

gbavm#91 and gba-studio#132.

- **The overlap test** is gbvm's `actor_overlapping_player`: the first actor whose box
  overlaps the player's, skipping actors with collisions off, in 16-bit unsigned
  arithmetic. Point-and-click now shares it.
- **Each controller registers the hit** when that actor has a collision group: the
  platformer in every state but BLANK, SHMUP on even frames, and TOPDOWN/ADVENTURE every
  frame (gbvm's grid-stepped TOPDOWN tests on each tile). Registering is skipped while
  the VM is locked, as is the rest of gbvm's state update.
- **The hit runs from the main loop**, once a frame after `hw_render`, locked or not
  (gbvm's `actors_handle_player_collision`). It runs the scene's player-hit script with
  the group, then the actor's script with 0 (its On Hit: Player tab). Then come 20 frames
  of invincibility, which count down every frame, touching or not.
- **A-to-interact skips an actor with a collision group**, as gbvm does. In the
  platformer A is also jump, so before this a jump beside a turnip ran its hit script.
- **Verified.** In CI, the fixture's player stands on an actor in group 1. Both scripts
  have run once on the frame after the hit (invincibility 20) and still once on the last
  invincible frame (1), then twice two frames later (20 again). On a scratch copy of
  gbs2 started in Path to Sample Town:
  - Walking into Turnip 1 from the side starts the turnip's own script. Its Set
    Platformer State enters KNOCKBACK (`plat_state` 6) on the next frame, pushing the
    player back.
  - Falling onto it from above takes the script's stomp branch: collisions off, Player
    Bounce (the player rises), the turnip removed 30 frames later. KNOCKBACK never
    fires.

Two setup changes were needed, and each is a gap of its own (below). Turnip 1 moved from
x=72 to x=12. The stomp's drop was placed with GDB once the scene's init had unlocked the
VM.

### Found along the way (not G3b, each a fix of its own)

- **gbavm caps a scene at 512 px (64 tiles) on each axis**, and three gbs2 scenes are
  wider: Parallax Example (80 tiles), Path to Sample Town (161) and Space Battle (255).
  Past the cap there is no collision grid: in Path to Sample Town the player falls out of
  the world at x=64, and all three turnips (x=72, 95, 103) are beyond it. Space Battle's
  enemies are spread across 255 tiles. This blocks G5 in all three scenes. **Lifted in
  G3c** (below): Butano streams a bigger regular background by itself, so removing the
  eject's cap was most of the fix.
- **The player falls during a scene's init.** That init holds the VM lock for its first
  15 frames, and gbavm's player keeps moving (the lock gap above). Started above a turnip,
  the player had already landed beside it when touching first registered, so the stomp
  read as a side hit. The fix for the lock gap covers this.
- **The turnips walk the wrong way.** On GBA, Turnip 1 walks right without stopping,
  away from the player. Its update script should step 4 tiles toward the player, then
  wait a second. Its hit script resolves the same "self" actor correctly. **Fixed:**
  gbavm ignored Move Relative's relative flag (see "Move Relative fix").
- **Pinned actors collide.** GB Studio gives a pinned actor no collision flag; the eject
  doesn't pass "pinned", so on GBA it collides like any other actor. gbs2's two (the
  health display in Path to Sample Town, one in Space Battle) have no group, but as the
  first overlapping actor one could hide a hit behind it.

## G3c result (2026-11-04): scenes wider than 512 px

gbavm#92 and gba-studio#133.

- **Butano already streams big backgrounds.** A regular background over 512 px on an
  axis becomes a "big map": any multiple of 256 px, up to 16384. Butano copies the part
  around the camera into a 256 × 256 hardware map as the view moves. The eject was already
  writing full-size BMPs, so Butano was building big maps for the three wide scenes. Only
  the scene size the engine got was capped. Without the cap, the camera clamp, the
  collision grid, triggers and actor bounds all take the real size. GB Studio's 255-tile
  limit keeps positions inside the engine's 16-bit subpixels (2040 px at most).
- **The scene now sits on the tile grid.** The eject centres a scene on its padded map.
  With an odd tile width (161, 255), that put it half a tile off the grid. Each hardware
  tile then held halves of two scene tiles, but a GBA tile has only one 16-colour bank, so
  in a colour scene half of such a tile drew in the wrong palette. In Path to Sample Town,
  8 of the 600 tiles on screen at x≈716 did. The eject now rounds the placement down onto
  the grid, and creates the bg 4 px right (or down) to make up for it.
- **One engine fix:** `hw_actor_set_pos` inferred facing from `int16_t` positions, which
  wrap at 1024 px, so a step across that line faced backwards. The engine also exports the
  rendered camera centre, `gba_camera_px_x/y`, for the runtime test.
- **Verified.** In CI, after the hit test, the fixture enters a 151 × 18-tile PLATFORM
  scene at tile (140, 12). `hw_load_scene` gets 1208 × 144. The player lands on the floor
  at (1120, 120) px, a trigger at tiles 136–143 fires, and the camera centre clamps at the
  real right edge, 1088 (the old cap pinned it at 392). On scratch copies of gbs2:
  - **Path to Sample Town**, started at tile 66 holding right (an input probe): the player
    walks on the floor out to tile 89, the camera follows from x=528 to 716, and Turnip 1
    knocks the player back at x≈77.
  - **Space Battle** scrolls its full length: the camera centre goes from 120 to 1920
    (2040 − 120) at 1 px a frame, then the scroll ends. This needed the enemies' scripts
    emptied, for the two bugs below.
  - **The streamed map is right.** With VRAM dumped at the end of both runs, every tile on
    screen (620 in each) matches the BMP the eject wrote.

### Found along the way (not G3c, each a fix of its own)

- **Move Relative moves to the offset, not by it.** gbavm ignores
  `.ACTOR_ATTR_RELATIVE_SNAP_PX` and `_TILE` on `VM_ACTOR_MOVE_TO_INIT`, so it treats the
  relative offset as an absolute destination. Space Battle's init moves the player "+4
  tiles" to x=1024 subpixels (tile 4). This is the likely cause of the turnips walking
  the wrong way (G3b). **Fixed** (see "Move Relative fix").
- **A custom event's actor argument resolves to the player.** All 15 Space Battle
  enemies run "Enemy Ship Movement" with themselves as the actor, but every move reached
  `hw_actor_move_init` with actor 0. So they all steer the player. The first contact runs
  "Enemy Ship Destroy", which deactivates the player, and the scroll stops. This is
  probably the same lost-argument bug as On Blank's respawn (G3). It blocks Space Battle
  in G5. **Fixed** (see "Custom-event arguments"): it was, and each enemy now moves itself.
- **Replace Tile addresses the padded map, not the scene.** `hw_replace_bg_tile_xy` uses
  the scene's tile x, y as map cells without the centring offset. So it hits the right
  cell only in a scene whose size is a multiple of 32 tiles on both axes (no padding).
  Anywhere else it is off by the padding, whatever the scene's size.

## Custom-event arguments (2026-11-04): the call frame

gbavm#94 and gba-studio#135, before G5. They fix two of the bugs found above: On Blank's
respawn (G3) and the enemies steering the player (G3c).

- **The cause.** GB Studio passes a custom event's arguments on the VM stack. The callee
  reads them past the call's frame: `.SCRIPT_ARG_n = -(3 + locals + n)`, and two of
  those three words are gbvm's far-call frame (the PC and the bank). gbavm keeps its
  32-bit return addresses on a separate return stack, and its calls put nothing on the
  data stack. So every argument read landed two words low, in the caller's own stack.
  Space Battle's enemies read 0 for their actor, which is the player.
- **The fix (engine only).** A call now takes gbvm's words on the data stack: 1 for a near
  call and 2 for a far one, holding gbvm's contents (the PC's low half, then the bank).
  The real return address stays on the return stack, and the returns drop the frame words
  before the arguments. The compiler and the bridge are unchanged.
- **Verified.** In CI, the Wide scene's init calls a custom event with an actor (Target),
  X 20 and Y 3 by value, and a variable by reference. Target ends at (160, 24) px, which
  is tile (20, 3), and the run is counted once. On the old engine the player moved
  instead, Target stayed at (80, 32), and the count stayed 0. On scratch copies of gbs2:
  - **Space Battle:** the first 12 moves reach `hw_actor_move_init` with actor 0 (the
    player's own scene move), then 2, 3 … 12, each enemy itself. Before, all 12 had 0.
  - **Path to Sample Town**, with BLANK forced at the end of its init: On Blank sets the
    player to (12800, 3328) subpixels, which is tile (50, 13).
- **Space Battle also needed the Move Relative fix** (next section): the enemies moved
  themselves, but still to their offsets taken as absolute positions.

## Move Relative fix (2026-11-04)

gbavm#93 and gba-studio#134.

- **What gbavm did.** `VM_ACTOR_MOVE_TO_INIT` took the block's X, Y as the destination
  and ignored its attribute byte, so a relative move's offset became the target. Turnip
  1's "−4 tiles" arrived as 0xFC00 subpixels (tile 252), past the scene's right edge, so
  it walked right for good.
- **Now it does what gbvm's `vm_actor_move_to_init` does.** The init snaps the actor to a
  whole pixel. With `RELATIVE_SNAP_PX` or `_TILE` set, it adds the offset to that
  position (clamped to 0..0xFFFF), snaps the result to a pixel or a tile, and writes it
  back into the block. The single-op `VM_ACTOR_MOVE_TO` does the same on its first run
  only, like gbvm, so the offset isn't added again every frame.
- **The bridge's attribute numbers were its own.** `parseGbvmAsm` gave `.ACTOR_ATTR_*`
  made-up values (relative px / tile at 0x20 / 0x40). They are now gbvm's `vm.i` numbers
  (0x08 / 0x10), which the engine reads. gbavm still ignores the collision bits: walls
  stop an actor as it steps, and other actors don't (`CHECK_COLL_ACTORS`).
- **Verified.** In CI, a timer in the Wide scene moves the Walker from tile (120, 13) by
  +4 tiles in x, then by −10 px in y, and it lands at (992, 94) px. Before the fix it
  read (0, 0) at the check: it was still walking toward x = 4 tiles. On a scratch copy of
  gbs2 started in Path to Sample Town at tile (6, 13), Turnip 1 starts a move every 124
  frames (64 walking at 0.5 px a frame, then the 1 s wait), to tiles 68, 64, 60 and 56:
  4 tiles toward the player each time. Before, its first destination was tile 252, and
  no second move came within 400 frames.

## G4 result (2026-11-04): parallax

gbavm#96 and gba-studio#PENDING.

- **What gbvm does.** `compileParallax` emits up to three `PARALLAX_STEP` rows, and
  gbvm's LCD interrupt walks them down the screen. A row with an end is an upper band: it
  scrolls to the view's left edge `>> shift` and keeps SCY 0, so it does not move
  vertically. The first row without an end is the normal view, at camera speed whatever
  speed it was given. "Fixed position" is speed 128, which wraps to shift −128; gbvm
  shifts left by 128, gets 0, and the band holds still.
- **Each upper band is its own background.** The eject writes `scene<s>_parallax<b>`:
  the scene's background with only that band's rows, on the same canvas with the same
  palette and offset, and index 0 (transparent) everywhere else. The engine creates
  the bands over the scene bg, at the same priority with a lower z order, and places
  them from the camera each frame. No masking is needed: the eject maps every GB shade to
  indices 1–4, so a band's rows are opaque and cover the scene bg's copy of them.
  The design said H-blank effects, which scroll lines of one background. But Parallax
  Example is 640 px wide, so Butano streams it as a big map, and only the columns near
  the camera are in VRAM. A band at 1/16 speed needs columns far from those.
- **Four backgrounds.** The scene bg, two bands and the dialogue panel fill the GBA's
  four. The engine frees the old scene's bands before it creates the new scene bg,
  because both scene bgs hold a slot for a moment. An affine scene runs in Mode 1, which
  has no regular bg to spare, so the eject drops its parallax with a warning.
- **The GBA's bigger screen.** A band stays where the scene's top rows sit with the
  camera at the top of the scene. On the GB that is the top of the screen. On the GBA a
  144 px scene is centred, so the bands start 8 px down with the rest of the scene. The
  band's scroll counts from the leftmost view. For a scene at least 240 px wide, that is
  the scene's left edge, and the formula is exactly gbvm's. A narrower scene does not
  scroll on the GBA, so its view is centred, and the bands stay lined up with the scene.
  A band that reaches the GB screen's bottom (row 18) also fills the GBA's two extra rows.
- **Verified.** In CI the Wide scene has bands at 1/4 and 1/2 speed. With the camera at
  the right clamp, the view's left edge is at 968 px, and the bands scroll to 242 and
  484 px. The main scene has already created the dialogue panel, so this check runs with
  all four backgrounds. On a scratch copy of gbs2 started in Parallax Example, the script
  camera was moved so the view's left edge was at 0, 200 and 400 px; the bands scrolled
  to (0, 0), (12, 100) and (25, 200). The frame captured at 400 matches one composed from
  `parallax.png` with each band at its scroll. Without the bands, the mountain would be
  off the screen there.
- **Not covered.** Replace Tile in a band's rows changes the scene bg's tile, which the
  band covers. Walking through Parallax Example on the GBA is the user's eyes-on check.

## Slice plan

| Slice  | Scope                                                                                                                                                                                                                           | Verify                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1     | **Done (2026-09-23), gbavm#86 / gba-studio#127.** Text layer no-op, `VM_RANDOMIZE`; the scroll region is not needed by gbs2. See "G1 result".                                                                                   | Unit tests; seed checked on the title (23,269 at frame 90).                                                                                                |
| G2     | **Done (2026-09-24), gbavm#87 / gba-studio#128.** Point-and-click, and the player-sprite default: gbs2 had no player in any scene. See "G2 result".                                                                             | Cursor position exact against gbvm's arithmetic; a trigger hovered and fired on Player's House.                                                            |
| G3     | **Done (2026-11-01), gbavm#88 / gba-studio#129.** Knockback + blank, `plat_next_state`, state scripts and animation overrides. See "G3 result".                                                                                 | CI: the scripted chain knockback → blank → ground; gbs2: a pit and a scripted knockback. The turnip hit moved to G3b.                                      |
| G3b    | **Done (2026-11-02), gbavm#91 / gba-studio#132.** Player-vs-actor collision: the overlap test in each controller, then the scene's player-hit script, the actor's On Hit: Player and 20 invincibility frames. See "G3b result". | CI: both scripts once inside the invincibility window, again after it; gbs2: a turnip from the side knocks back, a stomp does not.                         |
| G3c    | **Done (2026-11-04), gbavm#92 / gba-studio#133.** Scenes wider than 512 px: no cap in the eject (Butano streams big maps), the scene on the tile grid, set-pos facing past 1024 px. See "G3c result".                           | CI: a 151-tile scene's size, landing, trigger and camera clamp; gbs2: Path to Sample Town walked to a turnip, Space Battle's full scroll, VRAM vs the BMP. |
| G4     | **Done (2026-11-04), gbavm#96 / gba-studio#PENDING.** Parallax: each upper band is its own background over the scene bg, scrolled from the camera each frame (not H-blank effects: big maps). See "G4 result".                  | CI: both bands' scroll at the Wide scene's right clamp; gbs2: three camera positions in Parallax Example, a captured frame vs the source art.              |
| **G5** | Playthrough: drive the sample from the title through each area with scripted input (a probe replaying a button sequence), log what breaks, fix or ledger it.                                                                    | Every area reached; an eyes-on playthrough by the user closes the milestone.                                                                               |

Order: G1 first (small, clears the build log), then G2 (it blocks the hub, so it blocks
G5), then G3 and G4, then G5. G3b goes before G5: the playthrough cannot take a hit
without it. G3c goes before G4 and G5: Parallax Example, Path to Sample Town and Space
Battle are all wider than 512 px.

## Verification

The GDB-stub discipline from M14 applies: independent references built from gbvm's sources
where behaviour is computable, forced-input probes (gated on `sys_time`, never on a call
counter) where it depends on the player, and one CI runtime assert per slice in
`scripts/gba-runtime-test.sh`. Test runs launch mGBA minimised and muted, so they do not
appear on the user's desktop. Anything that is about how the game _feels_ ends in an
eyes-on check by the user.
