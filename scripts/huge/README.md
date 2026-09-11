# hUGE player verification (M14)

How the GBA hUGE player (`gbavm/src/huge_player.cpp`) is checked against real songs.
Background and design: `docs/M14_MUSIC_DESIGN.md`.

The method: run a real `gbs2` song on the GBA with a throwaway probe that records every
note write, then diff that trace against an independent reference which predicts every
write from the song data and hUGEDriver's rules.

## What it proves, and what it does not

`reference.py` parses the song's C, applies the driver's rules **as read from
`hUGEDriver.asm`** (not from the C++), and runs GB Studio's 64 Hz tick schedule through
the GBA's frame clock. A match on every field — frame, tick, order, row, channel,
value — proves the C++ is a faithful transcription of those rules: pattern decoding,
instruments, the note table, row/order advance, and the tick accumulator.

It cannot prove the rules were _read_ correctly, because both implementations share that
reading. That needs an ears-on listen and, eventually, a trace from the GB build itself.

## The recipe

Paths below assume `gba-studio` and `gbavm` are sibling checkouts, and `<work>` is any
scratch directory.

1. **Export a song with the editor's own exporter.**

   ```bash
   npx esbuild scripts/huge/export-uge.ts --bundle --platform=node --tsconfig=tsconfig.json --outfile=<work>/export-uge.js
   ```

   ```bash
   node <work>/export-uge.js appData/templates/gbs2/assets/music/Rulz_BattleTheme.uge song_Rulz_BattleTheme <work>/BattleTheme.c
   ```

2. **Make it compile for the GBA.** `gbaify.py` strips the two SDCC-isms the exporter
   emits (`#pragma bank`, and `__at(...)`, which is a hard GCC error). This is the same
   post-process the eject will apply in M14d.

   ```bash
   python scripts/huge/gbaify.py <work>/BattleTheme.c <work>/BattleTheme.gba.c
   ```

3. **Add the probe to the gbavm checkout** (never commit it). It only defines
   `HUGE_TRACE` — which switches on the player's own compiled-out trace hook — compiles the
   song in, and starts it at the given frame. It never splices code into the player, so it
   keeps working as the player grows. **Commit your player changes before probing.**

   ```bash
   python scripts/huge/add_probe.py ../gbavm <work>/BattleTheme.gba.c song_Rulz_BattleTheme_Data 30
   ```

4. **Build any project against that engine, and dump the trace over the GDB stub.**
   Build with `GBAVM_ROOT` pointing at the probed checkout, launch mGBA with `-g`, then
   walk frames and print each of the `huge_trace_n` entries of `huge_trace` as one line:

   ```
   T <frame> <tick> <order> <row> <channel> <what> <value>
   ```

   `what` is 1 sweep, 2 length/envelope, 3 note, 4 wave load (the value is then the wave
   index). Only writes carrying musical state are traced — not routing mutes or DAC
   toggles.

   Walk far enough to cross an order boundary (64 rows × the song's tempo, in ticks).

5. **Diff against the reference.** The last argument is the frame of the first write —
   the play frame plus one, because the PSG is only claimed on the frame after a
   `huge_play()` (M14a: `bn::dmg_music::stop()` is deferred to the frame commit).

   ```bash
   python scripts/huge/reference.py <work>/BattleTheme.gba.c <work>/trace.txt 31
   ```

6. **Revert the probe** — with the script, never with git:

   ```bash
   python scripts/huge/add_probe.py ../gbavm --revert
   ```

   That removes exactly the `// PROBE` lines and the song file. `git checkout -- src`
   also throws away any uncommitted player work — which is how M14c1's first draft was
   lost (and rebuilt from the session transcript).

## Checking wave RAM

The trace logs _which_ wave loaded, not whether its bytes landed — and a debugger cannot
tell you: **mGBA's GDB stub reads wave RAM as zero and does not pass IO writes through**
(writing `0xBEEF` there over GDB reads back `0`). So under `HUGE_TRACE` the player reads the
bytes back through the emulated bus while their bank is still writable, into
`huge_wave_readback[16]`, which GDB can read like any RAM. Compare it to the song's
`waves[]`, and check `SOUND3CNT_L` reads `0x0080` (playing bank 0).

## Results so far

| Slice | Song               | Tempo | Writes | Result                                                                 |
| ----- | ------------------ | ----- | ------ | ---------------------------------------------------------------------- |
| M14b  | `Rulz_BattleTheme` | 3     | 56     | all match, across an order boundary                                    |
| M14b  | `Rulz_GonaSpace`   | 7     | 52     | all match, across an order boundary                                    |
| M14c1 | `Rulz_BattleTheme` | 3     | 221    | all match — all 4 channels, every write type; wave readback byte-exact |
| M14c1 | `Rulz_GonaSpace`   | 7     | 239    | all match — all 4 channels, every write type                           |

## Extending it

The reference now predicts every tick-0 write on all four channels. Effects (M14c2) and
subpattern tables (M14c3) write on other ticks too; each needs its rule added to
`reference.py` — read from the asm again, not from whatever the C++ ended up doing.
