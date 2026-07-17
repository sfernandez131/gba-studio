# M13 — Platformer & scene types on GBA: design (2026-07-16)

Design-first per the roadmap, like M12. Facts verified against the fork's engine
sources (`appData/engine/gbvm/src/states/platform.c`, 2566 lines) and the current
GBA engine on 2026-07-16.

## The GB Studio model (facts)

- **Scene types**: LOGO, TOPDOWN, PLATFORM, ADVENTURE, SHMUP, POINTNCLICK. Each is an
  engine "state" with its own update loop; the scene's `type` picks it at load.
  (The stock gbs2 _template_ uses only TOPDOWN + POINTNCLICK — the platformer bar
  comes from sample games and real projects.)
- **platform.c structure**: a player state machine — `FALL, GROUND, JUMP, DASH,
LADDER, WALL, KNOCKBACK, BLANK, RUN, FLOAT` — driven by ~40 `plat_*` engine-field
  tunables (walk/run acc + dec, jump vel + hold vel/frames, gravity + hold gravity,
  max fall, coyote frames, jump buffer, extra jumps + reduction, wall slide/kick,
  dash family, float, knockback, air control...). Velocities are Q8.8-ish WORDs
  (`VEL_TO_SUBPX` shifts >>8 then <<1 into subpixels).
- **Engine fields flow**: `plat_*` are engine globals written by the compiled
  scene-init (engine field values) and by runtime "Engine Field Update" events.
  **On GBA these already plumb through**: M1b auto-allocates a RAM var for every
  written engine symbol, so `short plat_jump_vel` etc. materialize in
  `gba_program.c` the moment a project writes them. The platformer controller
  reads those same symbols — zero new plumbing for tuning.
- **Collision**: one byte per tile. `COLLISION_TOP 0x1 / BOTTOM 0x2 / LEFT 0x4 /
RIGHT 0x8` + `TILE_PROP_LADDER 0x10`. One-way platforms = TOP-only tiles;
  ladders = the 0x10 flag.

## The GBA side (facts)

- **The full collision byte already ships**: eject packs `scene.collisions`
  unmasked (`& 0xff`) and the engine stores it per tile; today's solid check just
  masks the direction bits (`& 0x0f`, `is_solid_subpx`). One-way platforms and
  ladders need **no data-model change** — only directional interpretation.
- **Scene type is NOT plumbed**: `GbaScene` has no `type`; the player controller in
  `hw.cpp` (`gba_check_input`) is hardcoded top-down. PLATFORM scenes compile today
  but move like top-down.
- Actor motion is 16.4-ish subpixels (32 subpx = 1px, `move_speed` per frame);
  platform physics integrate velocity per frame in the same space (GB's
  `VEL_TO_SUBPX` output is directly portable).

## Mapping (the design)

Plumb `type` through `GbaScene`, dispatch per-type player controllers in the
engine, and port platform.c's state machine **incrementally by feature tier** —
each tier is a GB-parity subset that real projects can ship on:

| Slice | Scope                                                                                                                                                                                                                                                 | Repos              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| M13a  | Scene-type plumbing: `GbaScene.type` (eject emits it), controller dispatch; LOGO/POINTNCLICK = no player movement (near-free); TOPDOWN = current controller.                                                                                          | engine + editor    |
| M13b  | Core platform physics: GROUND/JUMP/FALL states; walk acc/dec, gravity + hold-gravity, jump vel + hold frames, max fall, directional collision (land on TOP bits, head-bump on BOTTOM). Reads the M1b `plat_*` vars with GB's defaults when unwritten. | engine (+ fixture) |
| M13c  | One-way platforms (TOP-only tiles from above) + ladders (0x10 tiles, LADDER state, climb vel) + drop-through.                                                                                                                                         | engine             |
| M13d  | Feel parity: coyote frames, jump buffer, extra jumps + reduction, RUN state + run boost, air/turn control.                                                                                                                                            | engine             |
| M13e  | Advanced (usage-gated): DASH, WALL slide/kick, FLOAT, KNOCKBACK. Port only when a target project needs them; each is an isolated state.                                                                                                               | engine             |
| M13f  | ADVENTURE (8-dir top-down variant — mostly the existing controller minus grid facing rules) and SHMUP (auto-scroll + axis lock).                                                                                                                      | engine + editor    |

**Defaults**: when a project never writes a `plat_*` field, GB's engine.json
defaults apply — bake the same defaults as the GBA vars' initializers so
untouched projects feel identical.

**Verification**: physics are exactly GDB-shaped — break `hw_render`, sample the
player's y/x subpixels per frame and assert the integration (e.g. jump apex frame
count = f(plat_jump_vel, plat_grav); landing snaps to the platform row). Add a
platformer scene to gba_actor_test (second scene or third) with a TOP-only ledge
and a ladder column; runtime tests assert state transitions via a
`plat_state`-style exported global (LTO: keep it exported, not anonymous).

## Risks

1. **platform.c fidelity** — 2566 lines of accumulated feel fixes (Coyote time,
   buffer edge cases). Mitigate by porting _states_, not lines: keep the GB state
   enum and transition conditions literally, diff behavior frame-by-frame in GDB
   against expectations derived from the constants.
2. **Actor attachment** (moving platforms ride actors in GB) — defer past M13c;
   needs actor-relative motion the GBA actor model doesn't do yet.
3. **Camera**: platform camera deadzones (`plat_camera_deadzone_x`, dash override)
   differ from the top-down follow — M13b ships with the current camera, deadzones
   land with M13d feel work.
4. **SHMUP/ADVENTURE input semantics** are small but have their own engine states
   upstream — scope from `shmup.c`/`adventure.c` before M13f, don't guess.
