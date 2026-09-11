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

3. **Add the probe to the gbavm checkout** (never commit it).

   ```bash
   python scripts/huge/add_probe.py ../gbavm <work>/BattleTheme.gba.c song_Rulz_BattleTheme_Data 30
   ```

4. **Build any project against that engine, and dump the trace over the GDB stub.**
   Build with `GBAVM_ROOT` pointing at the probed checkout, launch mGBA with `-g`, then
   walk frames and print each of the `huge_trace_n` entries of `huge_trace` as one line:

   ```
   T <frame> <tick> <order> <row> <channel> <value>
   ```

   Walk far enough to cross an order boundary (64 rows × the song's tempo, in ticks).

5. **Diff against the reference.** The last argument is the frame of the first write —
   the play frame plus one, because the PSG is only claimed on the frame after a
   `huge_play()` (M14a: `bn::dmg_music::stop()` is deferred to the frame commit).

   ```bash
   python scripts/huge/reference.py <work>/BattleTheme.gba.c <work>/trace.txt 31
   ```

6. **Revert the probe:** `git checkout -- src && rm src/probe_song.c` in gbavm.

## Results so far

| Slice | Song               | Tempo | Writes | Result                              |
| ----- | ------------------ | ----- | ------ | ----------------------------------- |
| M14b  | `Rulz_BattleTheme` | 3     | 56     | all match, across an order boundary |
| M14b  | `Rulz_GonaSpace`   | 7     | 52     | all match, across an order boundary |

## Extending it

M14b covers tick-0 note writes on the two pulse channels, so the reference predicts only
those. As M14c adds effects and the wave/noise channels, the probe needs to record their
writes too, and `reference.py` needs the matching rules — read from the asm again, not
from whatever the C++ ended up doing.
