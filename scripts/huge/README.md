# hUGE player verification (M14)

How the GBA hUGE player (`gbavm/src/huge_player.cpp`) is checked against real songs.
Background and design: `docs/M14_MUSIC_DESIGN.md`.

The method: run a real song on the GBA with a throwaway probe that records every Game Boy
sound-register write the player makes, then diff that trace against an independent
reference which predicts every write from the song data and hUGEDriver's rules.

## What it proves, and what it does not

`reference.py` parses the song's C, applies the driver's rules **as read from
`hUGEDriver.asm`** (not from the C++), and runs GB Studio's 64 Hz tick schedule through
the GBA's frame clock. A match on every field — frame, tick, order, row, register,
value — proves the C++ is a faithful transcription of those rules: pattern decoding,
instruments, the note table, every effect, subpattern tables, row/order advance, and the
tick accumulator. That is the whole of hUGEDriver.

A match only means something if a wrong rule would fail. `mutations.py` checks that: it
breaks the reference in small, plausible ways — 23 for effects, 15 for tables — and
confirms each one produces mismatches against a real trace.

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

   To exercise every effect, or every table path, build one of the two synthetic songs
   instead. Both borrow a real song's instruments; `make-tables-song.ts` works the same
   way, writing `<work>/Tables.c`:

   ```bash
   npx esbuild scripts/huge/make-effects-song.ts --bundle --platform=node --tsconfig=tsconfig.json --outfile=<work>/make-effects-song.js
   ```

   ```bash
   node <work>/make-effects-song.js appData/templates/gbs2/assets/music/Rulz_GonaSpace.uge <work>/Effects.c
   ```

2. **Make it compile for the GBA.** `gbaify.py` strips the two SDCC-isms the exporter
   emits (`#pragma bank`, and `__at(...)`, which is a hard GCC error), and pads each
   instrument table to 15 slots so pattern data naming an undefined instrument cannot read
   out of bounds. This is the same post-process the eject will apply in M14d.

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
   Build with `GBAVM_ROOT` pointing at the probed checkout, launch mGBA with `-g`, and run
   `dump-trace.gdb` against the build's ELF (from PowerShell on Windows). It writes
   `trace.bin`: one 12-byte record per write — frame, tick, order, row, register, value.

   The register is the GB address's low byte (`0x10` = NR10 ... `0x25` = NR51), exactly as
   the driver's `ldh` writes it — every write, routing mutes and DAC toggles included. Two
   pseudo-registers stand for events that are not one byte: `0x30` a wave loaded into wave
   RAM (value = wave index) and `0x40` a "call routine" (value = channel << 8 | param).

   Check the reference's `orders reached` line: the walk should cross an order boundary.

5. **Diff against the reference.** The last argument is the frame of the first write —
   the play frame plus one, because the PSG is only claimed on the frame after a
   `huge_play()` (M14a: `bn::dmg_music::stop()` is deferred to the frame commit).

   ```bash
   python scripts/huge/reference.py <work>/BattleTheme.gba.c <work>/trace.bin 31
   ```

   It also prints which effects ran on the compared rows and from tables, so you can see
   what a song actually exercised. Then, against a synthetic song's trace, check the diff
   has teeth — `effects` for the effects song, `tables` for the tables song:

   ```bash
   python scripts/huge/mutations.py effects <work>/Effects.gba.c <work>/trace.bin 31
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

From M14c2 the trace records register bytes rather than paired writes, so the counts are not
comparable with the rows above. All nine songs below match, each run for ~567 ticks:

| Song                     | Tempo | Writes | Effects run on compared rows     |
| ------------------------ | ----- | ------ | -------------------------------- |
| synthetic (`Effects`)    | 6     | 1753   | all 16; 23/23 mutations caught   |
| `Coffee Bat - Wyrmhole`  | 2     | 2739   | 2, C                             |
| `zilog_headbang_routine` | 7     | 1969   | 0, 2, 4, 6, B, C, E              |
| `unreal_superhero2`      | 7     | 1843   | 3, C (sweep byte patched, below) |
| `Rulz_BattleTheme`       | 3     | 2109   | C, E                             |
| `Rulz_GonaSpace`         | 7     | 1726   | 2, A, C, E                       |
| `dizzy`                  | 7     | 1466   | 0, 4, C (instruments padded)     |
| `Rulz_SpaceEmergency`    | 8     | 923    | 1, 8, C, E                       |
| `Rulz_Into the woods`    | 7     | 631    | B, C, F                          |

From M14c3 every song runs its subpattern tables too. All 18 below match against the same
engine (gbavm#82), each run for up to ~567 ticks or the trace's 4096 writes:

| Song                     | Tempo | Writes | Tables (rows run) | Effects on compared rows         |
| ------------------------ | ----- | ------ | ----------------- | -------------------------------- |
| synthetic (`Tables`)     | 5     | 4096   | 6 (1212)          | all 16 from tables; 15/15 caught |
| synthetic (`Effects`)    | 6     | 1753   | 0                 | all 16; 23/23 mutations caught   |
| `Rulz_BattleTheme`       | 3     | 3195   | 1 (567)           | C, E                             |
| `Rulz_FastPaceSpeedRace` | 6     | 2341   | 1 (375)           | 2, B, E                          |
| `Rulz_GonaSpace`         | 7     | 2424   | 1 (385)           | 2, A, C, E                       |
| `Rulz_Into the woods`    | 7     | 631    | 0                 | B, C, F                          |
| `Rulz_Intro`             | 7     | 1926   | 1 (567)           | C, E                             |
| `Rulz_LightMood`         | 4     | 1632   | 2 (567)           | C, E                             |
| `Rulz_Outside`           | 8     | 1663   | 1 (567)           | 0, C, E                          |
| `Rulz_Pause_Underground` | 8     | 1801   | 1 (567)           | 2, C, E                          |
| `Rulz_SpaceEmergency`    | 8     | 1997   | 1 (559)           | 1, 8, C, E                       |
| `Rulz_UndergroundCave`   | 15    | 1672   | 1 (567)           | 0, C, E                          |
| `Tronimal_DrumsExample`  | 5     | 1892   | 3 (567)           | 2, C, E                          |
| `Tronimal_EchoExample`   | 6     | 1346   | 1 (519)           | C, E                             |
| `Coffee Bat - Wyrmhole`  | 2     | 3693   | 3 (567)           | 2, C                             |
| `zilog_headbang_routine` | 7     | 1969   | 0                 | 0, 2, 4, 6, B, C, E              |
| `unreal_superhero2`      | 7     | 1843   | 0                 | 3, C (sweep byte patched, below) |
| `dizzy`                  | 7     | 1466   | 0                 | 0, 4, C (instruments padded)     |

"Tables" counts the tables the song defines and the table rows the compared ticks ran. No
real song runs an effect from a table; the synthetic song is the only coverage for that.

`unreal_superhero2` does not compile as exported: the exporter writes `0x-4` for a duty
instrument whose sweep time loads as -1, which no C compiler accepts (the GB build's either).
Its byte was patched to `0x00` for this run; sweep does not affect any effect.

## Extending it

The reference covers the whole driver. If the player ever changes — or the vendored
hUGEDriver is updated — change `reference.py` from the asm, not from whatever the C++ ended
up doing, and add a mutation and a synthetic-song case for each new rule. A mutation that
survives means the songs never exercised that rule.

## Sound effects (M14f)

`reference_sfx.py` does the same for gbavm's PSG sound-effect player. It reads one effect's
array from any compiled `sounds/*.c`, applies `sfx_play_isr` as read from gbvm's
`sfx_player.c`, runs the 256 Hz clock through the frame clock, and diffs every register
write, frame for frame.

Probe it like a song, but in a project with no hUGE song playing, so the trace is the
effect's alone. Define `HUGE_TRACE` (the trace hook logs every PSG write, whoever makes it),
compile the effect's array into the engine, and call `psg_sfx_play(<array>, <mask>,
<priority>)` from `main.cpp` at a fixed `sys_time`, just before `psg_sfx_update()`. Then
diff:

```bash
python scripts/huge/reference_sfx.py <sound.c> <symbol> <work>/trace.bin <play frame>
```

Result: FX Hammer effect 5 of the gbs2 sample's `Tronimal_Sound_Effects.sav`, played at frame
30 in `gba_demo`: 153 ticks, 70 register writes, all match. Six deliberate breaks of the
reference are all caught.
