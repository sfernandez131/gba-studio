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
- **"Volume change is not supported by the VGM player"** — `bn::dmg_music::set_volume` is a
  no-op, so music volume events silently stop working.
- **`set_position(pattern, row)` has no meaning** in a register log — which directly
  undercuts `VM_MUSIC_SETPOS`, the op matrix slice G just added.

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

So the PSG is shared, undocumented territory in this stack, and it has already produced one
silent-audio bug that took register-level tracing to find.

**M14a must therefore be a spike, not an implementation**: establish whether a custom PSG
writer can coexist with (or cleanly displace) Butano's DMG player, before committing to the
port. The answer decides whether Route C is viable or whether Route A's capability losses
have to be accepted after all.

## Slice plan

| Slice    | Scope                                                                                                                                                                                                                                        | Verify                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **M14a** | **Spike: PSG ownership.** Can gbavm drive the DMG channel registers directly while Butano's DMG player is idle/stopped? Play a hand-written note sequence with `bn::dmg_music` stopped and confirm audible output + expected register state. | mGBA I/O viewer + the Lua register-trace recipe already banked for the gbt debugging. |
| M14b     | Port the hUGE tick/player to C++ against the PSG, consuming the song structure `exportToC` already produces. Start with note playback on the two pulse channels.                                                                             | Frame-level register trace vs. the GB build playing the same track.                   |
| M14c     | Effects, wave channel, noise.                                                                                                                                                                                                                | Same trace, per effect.                                                               |
| M14d     | Eject `.uge` tracks (drop the skip warning) and route them to the new player.                                                                                                                                                                | The stock `gbs2` sample's music plays.                                                |
| M14e     | `VM_MUSIC_ROUTINE` — raise the routine effect as a music event and close the matrix slice G gap.                                                                                                                                             | The attached script runs; GDB assert on the handle, like the input-attach fixture.    |
| M14f     | `.vgm` SFX, and music events beyond play/stop.                                                                                                                                                                                               | Ears-on plus register asserts.                                                        |
| —        | If M14a says the PSG cannot be shared, fall back to Route A and **document the capability losses** (speed, volume, `SETPOS`) rather than shipping them silently.                                                                             | —                                                                                     |

## Verification

Music is the one area where the GDB-stub discipline does not fully reach — the ledger is
ears-on. But the banked gbt-player debugging recipe is the substitute that worked before:
find the player struct in `build/gbavm.map`, arm an mGBA Lua `frame` callback logging
on-change state plus `SOUNDCNT_L`, and compare frame-by-frame against the GB build playing
the same track. Register reads alone mislead — a non-looping song reads healthy until it
ends — so compare _traces_, not snapshots.
