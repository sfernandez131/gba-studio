# Event-matrix completion (design, 2026-08-12)

The roadmap's quality program defines three ledgers, and this is the second:

> **GBA event-matrix coverage** — a generated matrix of every GB Studio event ×
> "compiles on GBA". Target: zero errors, every gameplay event bridged.

Ledgers 1 (GB non-regression) and 3 (runtime behaviour tests) are green in CI. This one
sits at **105 / 156 macros (67%)**, with 42 unbridged and 9 skipped. That number is the
honest answer to "is this a superset yet", and it is the gap most likely to stop a real
GB Studio project building on GBA.

## Scoped from evidence, not from the list

The 42 unbridged macros are not equally important, and guessing which matter would waste
the effort. Exporting the **stock `gbs2` template** — the sample the roadmap names as the
parity exit criterion — and counting macro usage across its 690 compiled `.s` files gives
a priority order directly:

| Cluster                                  | Macros                                                                                                   | Uses in `gbs2` |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------- |
| **Tile replacement**                     | `VM_REPLACE_TILE_XY`, `VM_REPLACE_TILE`                                                                  | **105**        |
| **Input attach / wait**                  | `VM_CONTEXT_PREPARE`, `VM_INPUT_ATTACH`, `VM_INPUT_WAIT`, `VM_INPUT_DETACH`                              | **64**         |
| **Actor animation control**              | `VM_ACTOR_SET_ANIM_FRAME`, `VM_ACTOR_TERMINATE_UPDATE`, `VM_ACTOR_SET_ANIM_TICK`                         | **40**         |
| **Real-time clock**                      | `VM_RTC_GET`, `VM_RTC_SET`, `VM_RTC_LATCH`, `VM_RTC_START`                                               | **40**         |
| **Music callbacks**                      | `VM_MUSIC_ROUTINE`                                                                                       | 8              |
| **Camera control**                       | `VM_CAMERA_MOVE_TO`, `VM_CAMERA_SET_POS`                                                                 | 4              |
| **Overlay / print extras**               | `VM_PRINT_OVERLAY`, `VM_SET_PRINT_DIR`, `VM_OVERLAY_SET_MAP`, `VM_OVERLAY_SET_SUBMAP`, `VM_LOAD_TEXT_EX` | 6              |
| **Tilesets**                             | `VM_LOAD_TILESET`                                                                                        | 1              |
| **Hardware GB Studio has, GBA does not** | `VM_ASM`/`VM_ENDASM`, `VM_SGB_TRANSFER`, `VM_SIO_*`                                                      | 5              |

**27 of the 42 are used by the stock sample.** The other 15 —
`VM_ACTOR_BEGIN_UPDATE`, `VM_ACTOR_GET_ANIM_FRAME`, `VM_ACTOR_REPLACE_TILE`,
`VM_ACTOR_SET_ANIM`, `VM_ACTOR_SET_BOUNDS`, `VM_ACTOR_SET_SPRITESHEET_BY_REF`,
`VM_GET_INT16`, `VM_GET_TILE_XY`, `VM_HIDE_SPRITES`, `VM_MUSIC_SETPOS`,
`VM_OVERLAY_SETPOS`, `VM_POLL`, `VM_RUMBLE`, `VM_SCENE_STACK_RESET`, `VM_SHOW_SPRITES` —
are real events users can reach, just not exercised by that project. They are the tail,
not the target.

## 67% is the wrong denominator

Some of these macros **cannot** be bridged, and counting them as missing work misstates
the goal:

- **`VM_ASM` / `VM_ENDASM`** inline **Z80 assembly** into the ROM. The GBA is an ARM7TDMI.
  There is no translation; a project using inline GB asm cannot run on GBA, and pretending
  otherwise would produce a silently wrong ROM. This must **fail loud**, permanently.
- **`VM_SGB_TRANSFER`** drives the Super Game Boy. No SGB exists on GBA. A **safe no-op** is
  the correct behaviour — the game plays, minus a border it could never have shown.
- **`VM_SIO_*`** is the GB link cable. The GBA has its own serial hardware, and Butano wraps
  it — but the protocol and API are different enough that this belongs to M8f (link cable),
  not here.
- **`VM_RTC_*`** needs a real-time clock in the cartridge. GB Studio assumes MBC3-with-RTC;
  a GBA cart can carry one, but no emulator default provides it. Bridgeable in principle,
  but the honest options are a software clock or failing loud, and that is a product
  decision rather than a bridging one.

So the matrix should grow a category — **"not applicable to the target"** — distinct from
"not done yet". Zero errors remains the goal; "every macro bridged" was never achievable,
and saying so plainly is more useful than a percentage that can't reach 100.

## Slice plan

Ordered by usage in the sample, which is also roughly by user-visible value.

| Slice | Scope                                                                                                                                                                                          | Verify                                                                                                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **A** | Re-categorise the impossible ones: `VM_ASM`/`VM_ENDASM` fail loud with an explanation, `VM_SGB_TRANSFER` becomes a documented no-op, matrix gains an N/A column.                               | The matrix reports an honest denominator; a project with inline asm gets a clear error naming the event. |
| **B** | **Tile replacement** — `VM_REPLACE_TILE_XY`, `VM_REPLACE_TILE`. Engine: write tiles into a loaded bg at runtime.                                                                               | GDB: a poked tile index changes the rendered map; fixture scene swaps a tile.                            |
| **C** | **Input attach / wait** — `VM_CONTEXT_PREPARE`, `VM_INPUT_ATTACH`, `VM_INPUT_DETACH`, `VM_INPUT_WAIT`. The "Attach Script to Button" and "Wait for Input" features; today only If-Input works. | GDB: an attached script's context runs on the button; a waiting thread resumes.                          |
| **D** | **Actor animation control** — `VM_ACTOR_SET_ANIM_FRAME`, `VM_ACTOR_SET_ANIM_TICK`, `VM_ACTOR_BEGIN_UPDATE`/`TERMINATE_UPDATE`.                                                                 | GDB: frame index and tick rate observable on a fixture actor.                                            |
| **E** | **Camera control** — `VM_CAMERA_MOVE_TO`, `VM_CAMERA_SET_POS`. Small, and the engine already has a camera.                                                                                     | GDB: camera position follows the op.                                                                     |
| **F** | **Overlay / print extras** + `VM_LOAD_TILESET`, `VM_LOAD_TEXT_EX`, `VM_SET_PRINT_DIR`.                                                                                                         | Eyes-on plus a GDB assert on the overlay state.                                                          |
| **G** | **Music callbacks** — `VM_MUSIC_ROUTINE`, `VM_MUSIC_SETPOS`.                                                                                                                                   | Ears-on plus a GDB assert that the routine fires.                                                        |
| **H** | The tail: the remaining unused-by-`gbs2` macros, as demand appears.                                                                                                                            | Per macro.                                                                                               |
| —     | **RTC** and **SIO** are deliberately out of scope: RTC needs a product decision, SIO belongs to M8f.                                                                                           | —                                                                                                        |

Slice A first because it makes every later number honest. B and C are the two that most
determine whether a real project builds.

## Verification

Same discipline as every milestone so far: unit tests on the bridge for each new macro
(operand shapes, `emitGbaBytecode` specs), a fixture that exercises the op so CI builds it
every PR, and a GDB spot-assert on the engine state the op is supposed to change. The
matrix is regenerated by `npm run gba:matrix` and its totals are the slice's headline.

The end state worth aiming at is not a percentage but a sentence: **the stock `gbs2`
sample builds and plays on GBA**. Slices A–G are what stands between here and being able
to say it.

## Risks

1. **Engine work, not just bridging.** Unlike the M8 ops, several of these need real gbavm
   features (runtime tile writes, an input-attach context model). Each slice is an engine
   PR plus an editor PR, with the engine merging first — the established shape.
2. **`VM_CONTEXT_PREPARE` is shared machinery.** It backs input-attach _and_ timers
   (already bridged). Changing it risks the timer path; the M6f fixture coverage is the
   guard.
3. **The tail may not be worth finishing.** 15 macros no sample uses may cost more than
   they return. Slice H is deliberately demand-driven rather than completionist.
