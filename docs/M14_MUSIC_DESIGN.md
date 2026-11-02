# M14 — music completeness (design, 2026-09-10; closed 2026-09-23)

> **Closed 2026-09-23.** GB Studio's own music and sound now play on the GBA. See
> [Outcome](#outcome-2026-09-23) at the end; the sections below are the design as it was
> written, followed by each slice's result.

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

## M14c1 result (2026-09-11): wave and noise

The wave and noise channels (gbavm#80) complete the tick-0 path on all four channels, so
songs now have their bass and drums.

- **The wave channel could not be ported literally.** The GB restarts CH3 with
  `NR30 = 0xFF`, and on the GB only bit 7 of `NR30` means anything. The GBA's
  `SOUND3CNT_L` uses bit 6 for the wave **bank** and bit 5 for 64-sample mode, so `0xFF`
  would switch banks and double the wave; and the CPU can only write the wave-RAM bank that
  is _not_ playing. The player follows gbt-player's GBA recipe instead.
- **The noise polynomial needs a real Z80 `SWAP`**, not a shift: notes 64+ wrap
  `note + 192` and produce values where the two disagree.
- **A debugger cannot check wave RAM.** mGBA's GDB stub reads it as zero and does not pass
  IO writes through. Under the verification trace, the player reads the bytes back through
  the emulated bus instead; the result is byte-exact.

Verified: 460 writes across two songs, all four channels, every write type — all match the
reference. Known gap: `Rulz_BattleTheme`'s noise instrument 1 carries a subpattern, so those
drum hits play their first tick but not their table until M14c3.

## M14c2 result (2026-09-15): all 16 effects

The player runs every hUGEDriver effect (gbavm#81), on tick 0 and on every later tick.

- **The port now writes the PSG a Game Boy register byte at a time**, mirroring each `ldh`
  in the driver, instead of M14b/c1's paired halfwords. The effects write registers alone:
  set duty writes `NR11` without `NR12`, and a halfword would rewrite the neighbour too,
  reloading a length counter the GB never touched. The GBA exposes each GB byte at a fixed
  offset, and mGBA dispatches those byte writes straight to its `NRxx` handlers. Two
  registers still need mapping: `NR30` keeps bit 7 only, and `NR32` drops bit 7, which
  forces 75% volume on the GBA.
- **The driver reads registers back and depends on the GB's read masks.** Vol slide, for
  example, ORs `0x80` into a read of `NRx4` (which reads back ORed with `0xBF`), and on the
  wave channel does arithmetic on `NR32` as read through its `0x9F` mask. The GBA's masks
  differ, so reads come from a shadow of the GB registers.
- **Driver quirks are kept, not fixed.** Pitch effects on CH4 hand a _period's_ low byte to
  the note-to-poly formula; toneporta stores the period even on a muted channel; tick 0 runs
  an effect whose param is 0 (so `E00` cuts at once) while later ticks skip it.
- **Where the GB would read past a table, the GBA holds the value in range instead**: a note
  past the note table plays the top note; an out-of-range break row, jump order or wave
  index is clamped. And pattern data can name an instrument the song never defined: `dizzy`
  plays wave instrument 3 on 307 cells but defines two. `hUGESong_t` carries no counts to
  check against, so the GBA post-process (`scripts/huge/gbaify.py`, which the M14d eject
  absorbs) pads each instrument table to 15 silent slots. The channel stays quiet, as it
  does on the GB, and nothing reads out of bounds.

Verified: **15,159 register writes across nine songs match the reference** — a synthetic
song (`scripts/huge/make-effects-song.ts`) that runs all 16 effects on all four channels,
including the awkward cases, and eight real songs that between them exercise 12 of the 16.
**All 23 deliberate mutations of the reference are caught** (`scripts/huge/mutations.py`), so
a wrong rule would have failed the diff; the first run had five survivors, which exposed
three gaps in the synthetic song (now filled) and two mutations that could never fail (now
documented). Known gap: subpattern tables, M14c3. First ears-on candidate with no tables at
all: `zilog_headbang_routine`.

Found on the way, not an M14 issue: the editor's exporter writes `0x-4` for a duty
instrument whose sweep time loads as -1 (`unreal_superhero2`), which no C compiler accepts —
on the GB build either.

## M14c3 result (2026-09-23): subpattern tables — the whole driver

Instrument subpattern tables run (gbavm#82), which completes the port: every note,
instrument, effect and table rule in hUGEDriver.

- **Tables run one row per tick**, on every tick including 0. On tick 0 the table runs after
  the row's note. Tables also run on a muted channel. A table row reuses the instrument slot
  as a 5-bit jump, offsets the channel's note without retriggering, and runs an effect.
- **An effect run from a table enters its routine one byte in** (`do_effect.no_set_offset`).
  For most effects that skips the tick test, so from a table they run on every tick. For
  toneporta and note delay, the skipped byte is the opcode of a two-byte `jr z`, and the CPU
  runs its _operand_ as an instruction. What that does depends on the assembled bytes, so
  they were read from GBVM's `lib/hUGEDriver.lib` rather than counted by hand. A hand count
  of note delay's operand was off by three, which would have predicted `ret nz` (`C0`) where
  the real byte is `cp l` (`BD`). Both real operands turn out to be harmless:
  - Toneporta slides every tick and never sets its target.
  - Note delay plays when the tick equals its param.
  - Note cut, with its `cp c` skipped, cuts on tick 0 whatever its param.
- **A position jump from a table on a later tick sets `next_order` without arming the
  break**, because `or [hl]` assumes A is 0, which only holds on tick 0.
- **The driver's note lookup is really `note mod 128`** (`add a` doubles it in 8 bits), which
  the port now matches.
- **GBA-side decisions:**
  - A table offset below note 0 holds the bottom note.
  - Rows past the 32 the exporter writes read as empty. The editor can make a table whose
    last row has no jump, which on the GB reads whatever data follows.

Verified: **37,340 register writes across 18 songs match** the reference. That covers a
synthetic tables song (`scripts/huge/make-tables-song.ts`), the M14c2 effects song, and 16
real songs, including all 12 in the gbs2 template. **15/15 table mutations** and 23/23
effect mutations are caught. The first table run had one survivor: a table ran off its end
into rows that looked the same as its empty last row. Giving that last row a note closed
the gap. No real song runs an effect from a table, so the synthetic song is the only
coverage there.

## M14d result (2026-09-23): `.uge` tracks play in games

The eject compiles every `.uge` track into the engine, and the music ops reach the hUGE
player (gbavm#83). A project's `.uge` music no longer gets the "skipping music" warning.

- **The editor's own exporter, adapted for GCC.** `src/lib/compiler/gba/gbaHugeSong.ts`
  runs `exportToC` - the C the GB build compiles - then strips the two SDCC-isms and pads
  the instrument tables to 15 slots, as `scripts/huge/gbaify.py` did during verification.
  Each song becomes one translation unit, `src/gba_song_<symbol>.c`. The track lookup gains
  a third backend, `2` = hUGE, beside gbt-player and Maxmod.
- **The music ops follow GBVM's `music_manager`**, not Butano's players:
  - Playing the track that is already playing does nothing, so music carries on across
    scenes that start the same track.
  - `VM_MUSIC_SETPOS` is `hUGE_set_position`, which ignores the row, as GBVM does.
  - `VM_SOUND_MASTERVOL` is a raw NR50 write that persists across songs. GBVM's sound cut
    resets NR51 on every track change but never touches NR50.
- **The bundled engine was still pinned before M14b**, so this is the first editor build that
  contains the hUGE player at all.

Verified:

- **CI now covers it.** The runtime-test fixture (`examples/gba_actor_test`) plays
  `Rulz_BattleTheme.uge` from its main scene, and `gba-runtime-test.sh` asserts that
  `huge_ticks` advances 65-66 across its 61-frame walk. That is 64 Hz; ticking once per
  frame would give 61. The assert fails on both "not playing" and "per-frame ticking". My
  first version expected 64-65 for a walk I had counted as 60 frames, and the run said 66.
  `ignore 9 60` stops on the 61st crossing.
- **The ejected song matches the reference end to end.** A traced build of that fixture
  produced 3,374 register writes across all four orders, compared against the C exactly as
  the eject wrote it. All match.

**Not verified: the stock `gbs2` sample**, which this slice's plan named. It does not build
for the GBA at all, for a reason unrelated to music: its scripts reference the platformer
knockback callback `_plat_callback_PLATFORM_KNOCKBACK_INIT`, which the GBA linker does not
know. That is a separate gap, recorded for follow-up. All 12 of its songs were verified
through the player in M14c3.

Known difference: a GB project whose music driver is hUGE plays its `.mod` tracks through
hUGE, converted with `convertMODDataToUGESong`. On the GBA, `.mod` tracks still go to
gbt-player or Maxmod, per track, as before M14.

## M14e result (2026-09-23): music routines

A `.uge` song's "call routine" effect now runs the scripts attached with the Music Routine
event (gbavm#84). This closes the gap matrix slice G left: `VM_MUSIC_ROUTINE` is bridged, and
the matrix moves to 121/151 bridgeable (80%).

The port follows gbvm's `music_manager.c`:

- **Raising.** The routine callback queues the effect param on tick 0 only, into a 4-entry
  ring where the newest overwrites the oldest.
- **Running.** Each frame, while the VM is not locked, slot `param & 3` runs with
  `param >> 4` as its one argument, if its previous run has finished.
- **An empty slot.** A slot with no script consumes its event and ends that frame's drain.

It is a new gbavm opcode, 0x6B, because gbvm's own 0x65 is `CAMERA_SET_POS` on gbavm.

- **The operand length had to be added too.** gbavm steps the VM with an operand-length
  table, `vm_args_len`, and my first build left 0x6B out of it. The VM then ran the
  operand bytes as opcodes, and the fixture's scene script died before its first event.
  The runtime test caught that: the run hung waiting for the first breakpoint.

Verified:

- **CI asserts the mapping.** The fixture now plays `fixture_routines.uge`, which is
  BattleTheme with routine effects added (`scripts/huge/make-routines-fixture.ts`):
  - `0x21` (slot 1), `0x13` (slot 3), and two raises on slot 0, which has no script.
  - The scene attaches counters to slots 1, 3 and 2. Slots 1 and 3 must count and slot 2
    must not. A port that took the slot from the high nibble would count on slot 2.
  - Both counts are 1, not 2. Six routines are raised while a Choice dialog locks the VM,
    and the ring keeps only the last three: `0x21`, `0x13`, `0x00`. Those run slot 1, then
    slot 3, then reach the unscripted slot 0.
- **The script arguments were checked once, by probe.** A temporary probe line recorded
  each dispatch's argument: 2 for slot 1 and 1 for slot 3 (`param >> 4`). It has been
  reverted.

Found on the way, not a product issue: two sessions on this machine share mGBA's GDB stub
port. The concurrent gbs2 task's builds also shared `%TEMP%/_gbsbuild` with mine, and my
`Stop-Process mGBA` killed its emulator. Verification now builds in its own temp directory,
starts and stops only its own mGBA, and waits for the port to be idle.

## M14f result (2026-09-23): PSG sound effects

GB Studio's non-`.wav` sounds now play on the GBA's Game Boy channels (gbavm#85): `.vgm`, FX
Hammer, and the Play Tone / Beep / Crash events. The GB compile turns all of them into gbvm's
`sfx_player` stream, so the eject reuses that output. It lifts each effect array and mute
mask out of the compiled `sounds/*.c` files (`src/lib/compiler/gba/gbaPsgSfx.ts`), and gbavm
plays the stream with a port of `sfx_play_isr` and of `music_manager`'s sound-effect half.
`.wav` stays on DirectSound, as since M5b.

- **Timing:** gbvm's 256 Hz sound clock, four times the music's rate, run from the frame loop
  by the same cycle accumulator as the hUGE player. Effects step before the music, as in the
  timer interrupt.
- **Sharing with music:**
  - A lower-priority effect is ignored.
  - A replaced effect's channels are cut.
  - While an effect plays, the hUGE player is muted on the channels it borrows; on release,
    the player's wave reloads.
  - `VM_MUSIC_MUTE` is bridged too, to gbvm's own `0x62`. The matrix moves to 122/151
    bridgeable (81%).
- **The bridge tells the two players apart by index:**
  - A PSG effect's index carries `PSG_SFX_FLAG` (`0x100`), so `VM_SFX_PLAY` emits `0x6C`
    (index, mute mask, priority).
  - A `.wav` stays on `0x66`.
- **The Game Boy register shadow belongs to the machine now, not the song**, because the
  player and the effects share it.
- **NR52 is never written.** The stream's master-register group can reach it, and on the
  GBA it would also switch off DirectSound.
- **Found by a new test, fixed:** the bridge's expression evaluator read `0x0F` as `0`
  followed by an unknown symbol `x0F`. Every mask the editor writes in hex failed, including
  every `VM_MUSIC_MUTE`. Numbers and identifiers are now tokenised in a single pass.

Verified:

- **Exact against a reference.** A probed build played FX Hammer effect 5 (`gba_demo`, no
  hUGE song, so the trace is the effect's alone). All 70 register writes match
  `scripts/huge/reference_sfx.py`, frame for frame; the reference is built from
  `sfx_player.c`. Six deliberate breaks of the reference are all caught, from ticking per
  frame down to a tick phase off by one frame.
- **CI now covers it.** The fixture plays effect 3 right after its `.uge` starts, and the
  runtime test asserts it played to its end exactly once, in exactly 57 ticks: the length
  its data defines at 256 Hz.

Known limits:

- Over a gbt-player `.mod` track, effects and music collide, because Butano's gbt player
  cannot be muted per channel. With hUGE music the channels are shared as on the GB.
- Not checked at runtime: the tone/beep events end to end (their parsing is unit-tested and
  they use the same player), and the music mute while an effect plays (a direct port).

## Slice plan

| Slice | Scope                                                                                                                                                                         | Verify                                                                                                                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M14a  | **Done (2026-09-11).** PSG handover confirmed at runtime; see "M14a result" above for the one-frame ordering rule. Ears-on listen still owed.                                 | GDB stub register reads over a 400-frame walk.                                                                                                                              |
| M14b  | **Done (2026-09-11), gbavm#79.** Tick/row/order machinery and pulse-channel notes; see "M14b result" above.                                                                   | 108 note writes across two songs match an independent reference exactly. The GB-build trace was not feasible (no SM83 GDB).                                                 |
| M14c1 | **Done (2026-09-11), gbavm#80.** Wave and noise channels; see "M14c1 result" above.                                                                                           | 460 writes across two songs match; wave RAM readback byte-exact.                                                                                                            |
| M14c2 | **Done (2026-09-15), gbavm#81.** All 16 effects, over a GB register layer; see "M14c2 result" above.                                                                          | 15,159 writes across nine songs match; 23/23 reference mutations caught.                                                                                                    |
| M14c3 | **Done (2026-09-23), gbavm#82.** Subpattern tables; the port is now the whole driver. See "M14c3 result" above.                                                               | 37,340 writes across 18 songs match; 15/15 table and 23/23 effect mutations caught.                                                                                         |
| M14d  | **Done (2026-09-23), gbavm#83.** `.uge` tracks eject and play; see "M14d result" above.                                                                                       | CI asserts a fixture's `.uge` plays at 64 Hz; the ejected song's trace matches (3,374 writes). The stock gbs2 sample does not build for GBA (unrelated knockback callback). |
| M14e  | **Done (2026-09-23), gbavm#84.** Music routines; see "M14e result" above.                                                                                                     | CI asserts slots 1 and 3 run and slot 2 does not; a probe confirmed the arguments.                                                                                          |
| M14f  | **Done (2026-09-23), gbavm#85.** PSG sound effects (.vgm, FX Hammer, tones) and `VM_MUSIC_MUTE`; see "M14f result" above.                                                     | 70 writes exact against a reference; CI asserts an FX Hammer effect runs 57 ticks.                                                                                          |
| —     | If M14a says the PSG cannot be shared after all, fall back to Route A and **guard every crash path it opens** (volume change, `SETPOS` with a row) rather than shipping them. | —                                                                                                                                                                           |

## Verification

Music is the one area where the GDB-stub discipline does not fully reach — the ledger is
ears-on. But the banked gbt-player debugging recipe is the substitute that worked before:
find the player struct in `build/gbavm.map`, arm an mGBA Lua `frame` callback logging
on-change state plus `SOUNDCNT_L`, and compare frame-by-frame against the GB build playing
the same track. Register reads alone mislead — a non-looping song reads healthy until it
ends — so compare _traces_, not snapshots.

## Outcome (2026-09-23)

M14 is closed. It shipped Route C, not the roadmap's `.uge` → `.vgm`. The recommendation
held: M14a showed the PSG can be shared, so no crash-path guards were needed.

**What shipped (a–f).** gbavm has a port of hUGEDriver, the whole driver: notes,
instruments, all 16 effects, and subpattern tables. It ticks at GB Studio's 64 Hz. The eject
compiles every `.uge` into the engine with the editor's own exporter. The music ops follow
gbvm's `music_manager`: play (a no-op for the track already playing), stop, set position,
master volume, mute, and routines raised from pattern data into attached scripts. Every
non-`.wav` sound effect plays on the same channels through a port of gbvm's `sfx_player`,
borrowing channels from the song as on the GB. That covers `.vgm`, FX Hammer, and the
Tone/Beep/Crash events. The matrix went from 120 to **122/151 bridgeable (81%)**.

**How it was checked.** Each layer was diffed against an independent reference built from
the GB sources, not from the port:

- **The driver:** 37,340 register writes across 18 songs (M14c3).
- **The ejected song, end to end:** 3,374 writes (M14d).
- **Sound effects:** 70 writes, frame for frame (M14f).

Every reference was mutation-tested, because a first-try match proves nothing until a wrong
rule is shown to fail. That turned up four coverage gaps and one real engine bug before
anything shipped. CI's runtime test now asserts:

- A `.uge` track ticks at 64 Hz.
- Music routines 1 and 3 run and routine 2 does not.
- An FX Hammer effect runs its exact 57 ticks.

**The stock `gbs2` sample's music plays.** That was M14d's named check, and it had to wait
for the sample to build for the GBA at all, which gba-studio#123 does. On a local merge of
develop with #123, the title scene starts `Rulz_Intro.uge` on the hUGE backend, and it
advances 321 driver ticks in the 300 frames after the handover: 64 Hz. It is re-checkable
once #123 merges.

**Things found along the way that were not music:**

- **The editor's engine pin.** The submodule had never been bumped past pre-M14b, so M14d was
  the first editor build that contained the player at all.
- **The bridge's expression evaluator** could not read hex literals with letter digits
  (`0x0F`). Every hex mask the editor writes failed, `VM_MUSIC_MUTE` among them.
- **The exporter** writes `0x-4` for a negative sweep time (`unreal_superhero2`), which no C
  compiler accepts, on the GB build either. Offered as a separate fix.
- **Every new gbavm opcode needs a `vm_args_len` entry.** Without one, the VM runs the operand
  bytes as opcodes, and the scene script dies silently.

**Known limits:**

- A `.mod` track on gbt-player and a PSG sound effect collide, because Butano's gbt player
  cannot be muted per channel. `.uge` music shares the channels properly.
- On the GB, a project using the hUGE driver converts `.mod` tracks to hUGE. The GBA still
  plays `.mod` through gbt-player or Maxmod, per track.
- Not checked at runtime: the Tone/Beep/Crash events end to end (their parsing is
  unit-tested), and `VM_MUSIC_MUTE` while an effect plays (a direct port).

**Still owed: ears.** Every check above is on register writes, which cannot say whether the
music _sounds_ right. Listen ROMs, at the repos root:

- `builds/m14a_psg_handover_listen.gba`
- `builds/m14c1_battle_theme_listen.gba`
- `builds/m14c2_zilog_headbang_listen.gba`
- `builds/m14c3_battle_theme_listen.gba`
- `builds/m14c3_drums_example_listen.gba`
- `builds/m14f_sfx_over_music_listen.gba`
- `builds/m14_gbs2_sample_listen.gba`: the whole gbs2 sample, from the local #123 merge.
