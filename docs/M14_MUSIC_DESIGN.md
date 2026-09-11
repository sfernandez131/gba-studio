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

## Slice plan

| Slice    | Scope                                                                                                                                                                                                             | Verify                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **M14a** | **Confirm PSG handover at runtime** (mostly answered by source, see above). With `bn::dmg_music` stopped, write a note to channel 1 directly; confirm the registers hold across frames and nothing clobbers them. | GDB stub register reads over a frame walk, plus an ears-on listen.                 |
| M14b     | Port the hUGE tick/player to C++ against the PSG, consuming the song structure `exportToC` already produces. Start with note playback on the two pulse channels.                                                  | Frame-level register trace vs. the GB build playing the same track.                |
| M14c     | Effects, wave channel, noise.                                                                                                                                                                                     | Same trace, per effect.                                                            |
| M14d     | Eject `.uge` tracks (drop the skip warning) and route them to the new player.                                                                                                                                     | The stock `gbs2` sample's music plays.                                             |
| M14e     | `VM_MUSIC_ROUTINE` — raise the routine effect as a music event and close the matrix slice G gap.                                                                                                                  | The attached script runs; GDB assert on the handle, like the input-attach fixture. |
| M14f     | `.vgm` SFX, and music events beyond play/stop.                                                                                                                                                                    | Ears-on plus register asserts.                                                     |
| —        | If M14a says the PSG cannot be shared after all, fall back to Route A and **guard every crash path it opens** (volume change, `SETPOS` with a row) rather than shipping them.                                     | —                                                                                  |

## Verification

Music is the one area where the GDB-stub discipline does not fully reach — the ledger is
ears-on. But the banked gbt-player debugging recipe is the substitute that worked before:
find the player struct in `build/gbavm.map`, arm an mGBA Lua `frame` callback logging
on-change state plus `SOUNDCNT_L`, and compare frame-by-frame against the GB build playing
the same track. Register reads alone mislead — a non-looping song reads healthy until it
ends — so compare _traces_, not snapshots.
