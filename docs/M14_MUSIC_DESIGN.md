# M14 — music completeness (design, 2026-09-10)

The roadmap states M14 as: **`.uge`→`.vgm` at build time; `.vgm` SFX; music events beyond
play/stop.** This document scopes it against what the two codebases actually contain, and
recommends a different primary route than the roadmap names — for reasons worth reading
before committing.

## Where music stands today

**gbavm plays `.mod` only.** `ejectGbaBuild.ts` skips every other track with a warning:

> `GBA: skipping music "<name>" (only .mod tracks supported so far)`

Tracks route to one of two backends, chosen per track by `settings.gbaAudioBackend`:

| Backend         | Path                                | Player                                  |
| --------------- | ----------------------------------- | --------------------------------------- |
| `dmg` (default) | `dmg_audio/` → `bn::dmg_music_item` | gbt-player, the 4 Game Boy PSG channels |
| `maxmod`        | `audio/` → `bn::music_item`         | the GBA's native DirectSound mixer      |

**`.uge` is GB Studio's own native music format**, and the format the stock `gbs2` sample
uses. So today a real GB Studio project's music does not play on GBA at all. That is the
gap M14 exists to close, and it is a bigger user-visible hole than anything the event
matrix had left.

It also blocks one event outright: **`VM_MUSIC_ROUTINE`** (matrix slice G) attaches scripts
to callbacks hUGEDriver raises from `.uge` pattern data. With no `.uge` playback there is
no event source, which is why slice G dropped it rather than bridging a callback that could
never fire.

## What the editor already has

This is the part that changes the calculus. `shared/lib/uge/` contains a **complete UGE
song model in TypeScript**:

- `loadUGESong(data)` — parses a `.uge` file into a structured song
- `exportToC(song, name)` — emits the hUGEDriver C data the GB build compiles
- `mod2uge/import.ts` — `convertMODDataToUGESong`, a working MOD → UGE converter

So the _parsing_ half of any conversion is already written and battle-tested. What M14 needs
is a new **output** stage from that same in-memory song.

## Three routes, and why the roadmap's is not the recommendation

### Route A — `.uge` → `.vgm` (the roadmap's plan)

Butano's DMG pipeline does accept VGM: `butano_dmg_audio_tool.py` sends `.mod` to `mod2gbt`,
`.s3m` to `s3m2gbt`, and **anything else to `advgm`**, tagging the result `VGM`.

But VGM is a **register-write log**, not a pattern format. Producing one means _emulating
hUGEDriver over the song and recording every APU register write_ — effectively writing a
hUGE player in TypeScript or Python just to render it out. And the format costs capability
at runtime, per Butano's own API docs:

- **"VGM player only supports the default playback speed (1)"** — `set_speed` is dead, so
  GB Studio's music-speed handling has nothing to drive.
- **"Volume change is not supported by the VGM player"** — and it is not a quiet no-op.
  The implementation (`hw/src/bn_hw_dmg_audio_default.cpp.h`) is
  `BN_ERROR("Volume change not supported by advgm")`, which **halts the console**.
- **`set_position` with a non-zero row asserts** — `BN_BASIC_ASSERT(! row, ...)`, because a
  register log has no rows. So `VM_MUSIC_SETPOS`, the op matrix slice G just added, becomes
  a crash vector on a VGM track.

So Route A does not just lose features — it turns two ordinary GB Studio music events into
ways to halt the game, and every one of them would need guarding in the engine. (A first
draft of this document said volume changes "silently stop working"; reading the source
showed it is worse than that.)

A register log is also far larger than pattern data, and ROM size is a real constraint.

### Route B — `.uge` → `.mod`

Reuses the existing gbt-player path with no engine change. But it is a lossy translation in
the wrong direction: `mod2uge` exists precisely because MOD's model (samples, 4 generic
channels) and GB's PSG (2 pulse + wave + noise, with hUGE's own effect set) do not
correspond. Going backwards would drop the hUGE-specific effects that make a GB Studio
track sound like itself — and would still leave `VM_MUSIC_ROUTINE` dead, since MOD carries
no routine effect.

### Route C — port hUGEDriver to the GBA (recommended)

**The GBA's sound hardware includes the original Game Boy PSG channels.** That is why
gbt-player works here at all. hUGEDriver is a player for exactly those channels; it is
written in GB Z80 assembly, but what it _does_ is read UGE pattern data and write PSG
registers on a tick.

Reimplementing that player in C++ against the GBA's PSG registers gives:

- **format fidelity** — the song plays as authored, effects included, because it is the
  same player logic rather than a translation;
- **pattern/row semantics preserved** — so `VM_MUSIC_SETPOS` works, and speed and volume
  behave;
- **`VM_MUSIC_ROUTINE` becomes implementable** — the routine effect is a pattern effect the
  ported player can raise, closing the last matrix gap that had a real reason behind it;
- **data reuse** — `exportToC` already emits the song data the GB build uses; the GBA build
  can consume the same structure rather than inventing one.

The cost is a real engine component, and one clear risk (below).

## The risk that decides Route C: who owns the PSG

Butano's `bn::dmg_music` **is itself a GB-PSG player**, and it owns those channel registers.
A hand-written hUGE player writing them directly would fight it.

There is already a scar here worth heeding — `hw.cpp` carries this comment:

> GBA master sound enable (`REG_SOUNDCNT_X`, bit 7). Butano's audio init leaves this OFF in
> this build, and while it is off the sound hardware ignores every write to the channel
> registers — so gbt-player's notes and Maxmod's DirectSound never take effect and nothing
> is audible (verified via mGBA's I/O viewer: `SOUNDCNT_X` read `0x0000`).

So the PSG is shared territory in this stack, and it has already produced one silent-audio
bug that took register-level tracing to find.

### What the source already answers

Reading Butano's DMG layer and gbt-player resolves most of this before any spike runs:

- **A stopped gbt-player keeps its hands off the PSG.** Butano's per-frame `commit()` calls
  `gbt_update()`, which opens with `if (gbt.playing == 0) return;`. Nothing is written to the
  channel registers while no GBT track is playing.
- **Per-channel handover is a designed feature, not a hack.** gbt-player exposes
  `gbt_enable_channels(flags)`, and its own panning code says channels disabled that way
  "aren't owned by GBT Player, so their bits need to be preserved in case the user is
  modifying them manually". The header adds the one caveat: a released channel "keeps
  playing whatever it was playing before, so it needs to be silenced manually".
- **Butano's other PSG writes are narrow.** `enable()`/`disable()` save and restore
  `REG_SNDDMGCNT` (`SOUNDCNT_L`) around audio suspend; they do not touch the channels.

So the realistic model is simple: when a `.uge` track plays, stop any GBT track, then drive
the PSG from the ported player. A project that mixes `.mod` and `.uge` tracks just switches
owner on each Music Play, the way Butano already switches between GBT and VGM.

**M14a shrinks accordingly** — from an open question to a runtime confirmation: with
`bn::dmg_music` stopped, write a note to channel 1 directly and confirm over the GDB stub that
the registers hold across frames (nothing clobbers them), plus an ears-on listen. If that
holds, Route C is clear.

### M14a result (2026-09-11): handover works — with one ordering rule the source hid

A throwaway probe on the `gba_actor_test` fixture started GBT track 0 at frame 60, stopped it
at frame 120, then wrote channel 1 by hand: an A440 square, full volume, envelope held, length
disabled, routed to both speakers. Registers sampled over the GDB stub:

| Frame | `SOUNDCNT_L` | `SOUNDCNT_X` | `SOUND1CNT_H` | Reading                                       |
| ----- | ------------ | ------------ | ------------- | --------------------------------------------- |
| 100   | `0xFF77`     | `0x0084`     | —             | gbt owns all four channels (the control case) |
| 131   | `0x1177`     | `0x0087`     | `0xF080`      | our channel 1, routed L+R, running            |
| 402   | `0x1177`     | `0x0087`     | `0xF080`      | unchanged — nothing took the PSG back         |

**Route C is viable.** But the first attempt wrote channel 1 in the _same frame_ as the stop,
and `SOUNDCNT_L` read back `0x0077` — the channel ran, routed to neither speaker, i.e.
silently. The cause is one layer above the code the section above reasoned about:

- **`bn::dmg_music::stop()` does not stop.** It queues a `DMG_MUSIC_STOP` command
  (`bn_audio_manager.bn_noflto.cpp`, `stop_dmg_music()`), which `execute_commands()` runs
  during the frame's `bn::core::update()`. That queued `gbt_stop()` lands after any PSG write
  made earlier in the same frame and clears its routing bits.

So the rule for M14b: **stop the GBT track, then take the PSG from the next frame on** — never
in the same frame. Moving the probe's write to frame 122 is the whole difference between the
two runs above.

Two more things the probe showed, both for M14b:

- **Released channels keep running.** `SOUNDCNT_X = 0x0087` still flags channels 2 and 3 as on
  after the stop — gbt-player's documented caveat. They are inaudible only because their
  routing bits happen to be clear. The ported player must explicitly claim (and silence) all
  four channels on takeover rather than assume they are quiet.
- **Still owed: an ears-on listen.** Every register says an A440 tone is playing on both
  speakers; nobody has heard it yet.

## M14b result (2026-09-11): the player, pulse channels first

`gbavm/src/huge_player.cpp` (gbavm#79) ports hUGEDriver's tick/row/order machinery and
pulse-channel note playback. The song data is the editor's own `exportToC` output compiled as
C, so there is no second exporter to keep in step.

Three things the port turned up:

- **The driver ticks at 64 Hz, not once per frame.** GB Studio runs it from the timer
  interrupt — `TAC 0x07` is 16,384 Hz, `TMA 0xC0` overflows at 256 Hz, and `music_play_isr`
  runs the driver every 4th, so exactly 64 Hz. Ticking once per GBA frame (59.73 Hz) would
  play every song **~6.7% slow**, and no register check would catch it. The player
  accumulates in GBA clock cycles instead, so the long-run rate is exact; some frames run two
  ticks.
- **A rest row skips the instrument entirely.** The branch sits before the instrument block
  in the asm, which is easy to misread — the first pass of the port got it wrong.
- **The GB header's types would not compile.** It types the order tables and routines
  loosely; GCC 14+ makes _incompatible-pointer-types_ a hard error even in C. gbavm's
  `hUGEDriver.h` declares what the exporter actually emits, and the real output then compiles
  with zero warnings. Two SDCC-isms still have to be stripped (`#pragma bank`, `__at`) —
  `scripts/huge/gbaify.py`, which M14d folds into the eject.

**Verified** by a throwaway probe recording every note write, diffed against an independent
reference that predicts each one from the song data and the asm's rules
(`scripts/huge/README.md`). `Rulz_BattleTheme` (tempo 3, 56 writes) and `Rulz_GonaSpace`
(tempo 7, 52 writes), both across an order boundary: **every write matches** on frame, tick,
order, row, channel, and value.

**Not verified:** a trace against the GB build itself. The GDB stub cannot debug the GB's
SM83 CPU, so there is no headless way to capture one — which is why the check above uses an
independent reference instead, and why an ears-on listen still matters.

## Slice plan

| Slice    | Scope                                                                                                                                                                         | Verify                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| M14a     | **Done (2026-09-11).** PSG handover confirmed at runtime; see "M14a result" above for the one-frame ordering rule. Ears-on listen still owed.                                 | GDB stub register reads over a 400-frame walk.                                                                              |
| M14b     | **Done (2026-09-11), gbavm#79.** Tick/row/order machinery and pulse-channel notes; see "M14b result" above.                                                                   | 108 note writes across two songs match an independent reference exactly. The GB-build trace was not feasible (no SM83 GDB). |
| **M14c** | Effects, subpattern tables, wave channel, noise. Extend `scripts/huge/reference.py` with each rule, read from the asm.                                                        | The same probe-and-reference diff, per effect and channel.                                                                  |
| M14d     | Eject `.uge` tracks (drop the skip warning) and route them to the new player.                                                                                                 | The stock `gbs2` sample's music plays.                                                                                      |
| M14e     | `VM_MUSIC_ROUTINE` — raise the routine effect as a music event and close the matrix slice G gap.                                                                              | The attached script runs; GDB assert on the handle, like the input-attach fixture.                                          |
| M14f     | `.vgm` SFX, and music events beyond play/stop.                                                                                                                                | Ears-on plus register asserts.                                                                                              |
| —        | If M14a says the PSG cannot be shared after all, fall back to Route A and **guard every crash path it opens** (volume change, `SETPOS` with a row) rather than shipping them. | —                                                                                                                           |

## Verification

Music is the one area where the GDB-stub discipline does not fully reach — the ledger is
ears-on. But the banked gbt-player debugging recipe is the substitute that worked before:
find the player struct in `build/gbavm.map`, arm an mGBA Lua `frame` callback logging
on-change state plus `SOUNDCNT_L`, and compare frame-by-frame against the GB build playing
the same track. Register reads alone mislead — a non-looping song reads healthy until it
ends — so compare _traces_, not snapshots.
