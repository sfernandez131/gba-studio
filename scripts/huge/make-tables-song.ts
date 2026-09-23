// Build a synthetic song that exercises hUGE's instrument subpattern tables on every
// channel, and export it to C with the editor's own exporter - for M14c3 verification.
//
// A table runs one row per TICK, on every tick including 0, and effects run from a table
// enter their routine one byte past its start - which skips most effects' tick test and
// leaves three (toneporta, note delay, note cut) behaving quite differently from the same
// effect in a pattern. Among the bundled songs, the tables are mostly short drum pitch
// sweeps, and none of them runs an effect. This song puts each table path somewhere
// distinctive:
//   - pitch offsets up, down, and below note 0; a jump with bit 4 set; a loop
//   - every effect from a table, with the three odd ones on ticks where the table rule and
//     the pattern rule disagree (note cut with a param that matches the tick, and at a
//     tick-0 row; note delay 0 on tick 0; toneporta on tick 0)
//   - a position jump from a table on a later tick, which sets next_order but does NOT
//     arm the break - so a later pattern break goes where the table said
//   - a table whose last row has no jump, so it runs off the end of its 32 rows
//   - a table carried across rows with no instrument, stopped by an instrument without one,
//     and restarted from row 0 by its own instrument
//   - a wave table switching waves every tick, and a noise table
//
// Instruments and waves are borrowed from a real song; the tables and patterns are new.
// The song is tempo 5, so a table row r run from a note's first tick lands on tick r mod 5.
//
// Not part of the app build; bundle and run it like export-uge.ts:
//   npx esbuild scripts/huge/make-tables-song.ts --bundle --platform=node \
//     --tsconfig=tsconfig.json --outfile=<work>/make-tables-song.js
//   node <work>/make-tables-song.js <instruments-from.uge> <out.c>
import { readFileSync, writeFileSync } from "fs";
import { loadUGESong, exportToC } from "shared/lib/uge/ugeHelper";
import { createPattern, createSubPattern } from "shared/lib/uge/song";
import type { SubPatternCell } from "shared/lib/uge/types";

const [, , input, output] = process.argv;
if (!input || !output) {
  throw new Error("usage: make-tables-song <instruments-from.uge> <out.c>");
}

const song = loadUGESong(readFileSync(input));
for (const instrument of [
  ...song.dutyInstruments,
  ...song.waveInstruments,
  ...song.noiseInstruments,
]) {
  instrument.subpatternEnabled = false;
}

// [row, note offset in semitones or null, jump (1-based row) or null, effect code, param]
type TableRow = [number, number | null, number | null, number, number];

const table = (rows: TableRow[]): SubPatternCell[] => {
  const cells = createSubPattern();
  for (const [row, offset, jump, code, param] of rows) {
    cells[row] = {
      note: offset === null ? null : offset + 36, // stored pitch: 36 = no offset
      jump,
      effectCode: code,
      effectParam: param,
    };
  }
  return cells;
};

const setTable = (
  instrument: { subpatternEnabled: boolean; subpattern: SubPatternCell[] },
  rows: TableRow[],
) => {
  instrument.subpatternEnabled = true;
  instrument.subpattern = table(rows);
};

// Duty 0: pitch. Offsets up and down, a jump with bit 4 set (18 -> row 17), a loop back.
setTable(song.dutyInstruments[0], [
  [0, 12, null, 0x0, 0x00],
  [1, 7, null, 0x9, 0x80], // set duty, every tick
  [2, 0, null, 0xa, 0x01], // vol slide, every tick
  [3, -12, 18, 0x0, 0x00], // jump 18: bit 4 set -> row 17
  [17, 4, null, 0x1, 0x03], // porta up, tick 0 included
  [18, null, null, 0x2, 0x05], // porta down, no note
  [19, -36, 2, 0x4, 0x21], // below note 0 for a low note; vibrato; jump -> row 1
  [31, null, 1, 0x0, 0x00],
]);

// Duty 1: effects. Rows land on tick (row mod 5) when the table starts on a note.
setTable(song.dutyInstruments[1], [
  [0, null, null, 0x3, 0x20], // toneporta on tick 0: slides, never sets up
  [1, null, null, 0x7, 0x01], // note delay 1 on tick 1: plays
  [2, null, null, 0xe, 0x02], // note cut 2 on tick 2: table rule = no cut
  [3, null, null, 0xc, 0x0c], // set volume on tick 3
  [4, null, null, 0x5, 0x53], // master volume on tick 4
  [5, null, null, 0x8, 0xf5], // pan on tick 0
  [6, null, null, 0x0, 0x47], // arpeggio
  [7, 5, null, 0x7, 0x00], // note delay 0 on tick 2: nothing
  [8, null, null, 0x6, 0x03], // call routine 3
  [9, null, null, 0x5, 0x77], // master volume back
  [10, 2, null, 0xe, 0x05], // note cut 5 on tick 0: table rule = cut
  [11, null, null, 0x8, 0xff], // pan back
  [12, null, null, 0xb, 0x02], // position jump on tick 2: next_order only, NOT armed
  [13, -1, null, 0xf, 0x05], // set speed 5 (unchanged) from a table
  [15, null, null, 0x7, 0x00], // note delay 0 on tick 0: plays
  [16, 24, null, 0x0, 0x00], // far above: +24
  [31, 3, null, 0x0, 0x00], // a note, and no jump: the table runs off its end
]);

// Duty 2: a pattern break from a table.
setTable(song.dutyInstruments[2], [
  [3, null, null, 0xd, 0x09], // on tick 3: row_break = 9 (once: no jump, runs off the end)
]);

// Wave 0: switch waves every tick, and pitch.
setTable(song.waveInstruments[0], [
  [0, 0, null, 0x9, 0x01],
  [1, 12, null, 0x9, 0x02],
  [2, -7, null, 0xc, 0x08],
  [3, 5, 1, 0x0, 0x00],
]);

// Noise 0: offsets, and effects on the noise channel.
setTable(song.noiseInstruments[0], [
  [0, 4, null, 0x0, 0x00],
  [1, -6, null, 0xe, 0x03],
  [2, -16, null, 0x9, 0x08],
  [3, 14, 1, 0x1, 0x10],
]);
// Noise 1: a short drum sweep, the shape real songs use.
setTable(song.noiseInstruments[1], [
  [0, null, null, 0x0, 0x00],
  [1, 0, null, 0x0, 0x00],
  [2, 0, 3, 0x0, 0x00],
]);

// [row, note, instrument (0-based) or null, effect code, effect param]; 24 is C5.
type Row = [number, number | null, number | null, number, number];
const fill = (rows: Row[]) => {
  const pattern = createPattern();
  for (const [row, note, instrument, code, param] of rows) {
    pattern[row] = { note, instrument, effectCode: code, effectParam: param };
  }
  return pattern;
};
const C5 = 24;

// ---- order 0 -------------------------------------------------------------------------
const pulse1A = fill([
  [0, C5, 0, 0x0, 0x00], // table from row 0
  [8, C5 + 2, null, 0x0, 0x00], // no instrument: the table carries on, not reset
  [16, C5, 3, 0x0, 0x00], // an instrument with no table: the table stops
  [20, C5, 0, 0x0, 0x00], // restarts from row 0
  [30, 1, 0, 0x0, 0x00], // a low note: the -36 row goes below note 0
  [40, 70, 0, 0x0, 0x00], // a high note: +12 goes past the top
  [56, C5 + 5, 0, 0x3, 0x04], // pattern toneporta while the table runs
]);
const pulse2A = fill([
  [0, C5 + 7, 1, 0x0, 0x00], // the effects table
  [48, C5 + 3, 1, 0x3, 0x10], // again, from a pattern toneporta
  [60, C5, null, 0xd, 0x01], // pattern break: consumes the table's next_order
]);
const waveA = fill([
  [0, C5 - 12, 0, 0x0, 0x00],
  [24, C5 - 5, 1, 0x0, 0x00], // no table
  [36, C5 - 8, 0, 0x0, 0x00],
]);
const noiseA = fill([
  [0, 40, 0, 0x0, 0x00],
  [16, 30, 1, 0x0, 0x00],
  [20, 35, 1, 0x0, 0x00],
  [40, 20, 0, 0x0, 0x00],
]);

// ---- order 1 -------------------------------------------------------------------------
const pulse1B = fill([
  [0, C5 + 4, 2, 0x0, 0x00], // pattern break from a table, on tick 3
]);
const pulse2B = fill([[0, C5, 3, 0x0, 0x00]]);
const waveB = fill([[0, C5 - 12, 0, 0x0, 0x00]]);
const noiseB = fill([[0, 45, 0, 0x0, 0x00]]);

song.patterns = [
  pulse1A,
  pulse2A,
  waveA,
  noiseA,
  pulse1B,
  pulse2B,
  waveB,
  noiseB,
];
song.sequence = [0, 4].map((base) => ({
  splitPattern: true,
  channels: [base, base + 1, base + 2, base + 3] as [
    number,
    number,
    number,
    number,
  ],
}));
song.ticksPerRow = 5;

writeFileSync(output, exportToC(song, "song_Tables"));
// eslint-disable-next-line no-console
console.log(
  `song_Tables: ${song.sequence.length} orders, tempo ${song.ticksPerRow}`,
);
