// Build a synthetic .uge-equivalent song that exercises every hUGE effect on every channel,
// and export it to C with the editor's own exporter - for M14c2 verification.
//
// The bundled songs between them use 13 of the 16 effects, but never master volume (5),
// note delay (7) or pattern break (D), and rarely the awkward cases: an effect on a rest,
// toneporta without an instrument, a note delay of 0, note cut on tick 0, vol slide on the
// wave channel (where NR32's read mask feeds the arithmetic), pitch effects on the noise
// channel (which treats a period's low byte as a note), and an arpeggio past the top of the
// note table. This song puts each of those somewhere distinctive, with a different value on
// each channel, so a transposed or swapped write cannot pass the diff by accident.
//
// Instruments and waves are borrowed from a real song; the patterns are all new. Orders:
//   0: rows 0-31, then D05 breaks to order 1 at row 4
//   1: rows 4-19, then B03 jumps to order 2
//   2: rows 0-15, then D01 breaks to the next order - which wraps to order 0
//
// Not part of the app build; bundle and run it like export-uge.ts:
//   npx esbuild scripts/huge/make-effects-song.ts --bundle --platform=node \
//     --tsconfig=tsconfig.json --outfile=<work>/make-effects-song.js
//   node <work>/make-effects-song.js <instruments-from.uge> <out.c>
import { readFileSync, writeFileSync } from "fs";
import { loadUGESong, exportToC } from "shared/lib/uge/ugeHelper";
import { createPattern } from "shared/lib/uge/song";

const [, , input, output] = process.argv;
if (!input || !output) {
  throw new Error("usage: make-effects-song <instruments-from.uge> <out.c>");
}

const song = loadUGESong(readFileSync(input));
for (const instrument of [
  ...song.dutyInstruments,
  ...song.waveInstruments,
  ...song.noiseInstruments,
]) {
  instrument.subpatternEnabled = false; // tables are M14c3; keep this song about effects
}

// [row, note, instrument (0-based) or null, effect code, effect param]. Notes count
// semitones from C3, so 24 is C5.
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
  [0, C5, 0, 0x0, 0x37], // arpeggio, starting on tick 0
  [1, null, null, 0x0, 0x37], // ... carried on a rest
  [2, C5 + 4, 0, 0x1, 0x05], // porta up
  [3, null, null, 0x2, 0x09], // porta down, on a rest
  [4, C5 + 7, 1, 0x3, 0x10], // toneporta with an instrument: retrigger on tick 1
  [5, null, null, 0x3, 0x10], // ... still sliding
  [6, C5 + 9, null, 0x3, 0x40], // toneporta with no instrument: no retrigger
  [7, C5 + 12, 0, 0x4, 0x35], // vibrato
  [8, C5 + 12, 0, 0x5, 0xdb], // master volume, with NR50's Vin bits (3, 7) set too
  [9, C5 + 2, 0, 0x6, 0x02], // call routine 2, every tick
  [10, C5 + 2, 0, 0x6, 0x00], // call routine 0: tick 0 only
  [11, C5 + 5, 0, 0x7, 0x02], // note delay 2
  [12, C5 + 5, 0, 0x7, 0x00], // note delay 0: never plays
  [13, C5 + 7, 0, 0x8, 0xed], // pan
  [14, C5 + 7, 0, 0x9, 0x40], // duty 25%
  [15, C5 + 9, 0, 0xa, 0x30], // vol slide up
  [16, C5 + 9, null, 0xa, 0x04], // vol slide down, no instrument
  [17, C5 + 11, 0, 0xc, 0x07], // set volume
  [18, C5 + 11, 0, 0xc, 0xab], // set volume with both nibbles
  [19, C5, 0, 0xe, 0x03], // note cut on tick 3
  [20, C5, 0, 0xe, 0x00], // note cut on tick 0
  [21, C5, 0, 0xf, 0x04], // speed 4
  [22, 69, 0, 0x0, 0xff], // arpeggio past the top of the note table
  [23, C5 + 4, 0, 0x1, 0xff], // a big porta up
  [24, C5 + 4, 0, 0xd, 0x00], // D00: row_break stays 0, so no break at all
  [26, C5 - 7, 1, 0x3, 0x07], // toneporta DOWN, from row 24's note
  [28, C5 + 1, 0, 0xf, 0x06], // speed back to 6
  [31, C5 + 3, 0, 0xd, 0x05], // pattern break to the next order's row 4
]);

const pulse2A = fill([
  [0, C5 + 3, 1, 0x4, 0x13], // vibrato, fast
  [2, null, null, 0x0, 0x47], // arpeggio on a rest, before any note of its own
  [3, C5 - 5, 0, 0x2, 0x03], // porta down
  [5, C5 - 5, 0, 0xc, 0x0c], // set volume
  [6, C5 + 1, 1, 0x9, 0xc0], // duty 75%
  [8, C5 + 6, 0, 0x7, 0x04], // note delay 4
  [10, C5 + 6, 0, 0xe, 0x05], // note cut on tick 5
  [12, C5 + 8, 0, 0xa, 0x0f], // vol slide all the way down
  [13, C5 + 8, 0, 0xa, 0xf0], // vol slide all the way up
  [15, C5 + 13, 1, 0x3, 0x02], // toneporta, slow
  [16, null, null, 0x3, 0x02],
  [17, null, null, 0x3, 0x02],
  [19, C5 + 10, 0, 0x6, 0x0f], // call routine 15
  [22, C5 + 10, 0, 0x8, 0x5a], // pan, from channel 2
  [25, C5 + 14, 1, 0x0, 0x0c], // arpeggio, one nibble only
]);

const waveA = fill([
  [0, C5 - 12, 0, 0x0, 0x7c], // arpeggio on the wave channel
  [2, C5 - 10, 1, 0x9, 0x02], // set "duty": load wave 2 and restart
  [4, C5 - 8, 0, 0xc, 0x0a], // set volume: quantises to 100% (the lowest value that does)
  [5, C5 - 8, 0, 0xc, 0x05], // ... 50% (likewise)
  [6, C5 - 8, 0, 0xc, 0x04], // ... 25% (the highest value that does)
  [7, C5 - 8, 0, 0xc, 0x00], // ... mute
  [8, C5 - 7, 0, 0xa, 0x21], // vol slide: NR32 reads back through its 0x9F mask
  [10, C5 - 5, 1, 0x4, 0x27], // vibrato
  [12, C5 - 3, 0, 0x1, 0x11], // porta up
  [14, C5 - 1, 0, 0x3, 0x08], // toneporta
  [15, null, null, 0x3, 0x08],
  [17, C5 - 12, 0, 0xe, 0x02], // note cut: CH3 zeroes NR32 and does NOT retrigger
  [19, C5 - 9, 1, 0x7, 0x01], // note delay 1
  [21, C5 - 9, 0, 0x9, 0x00], // back to wave 0
  [23, C5 - 6, 0, 0x2, 0x21], // porta down
]);

const noiseA = fill([
  [0, 30, 0, 0xc, 0x0a], // set volume: NR42 takes the swapped byte whole
  [2, 40, 1, 0x0, 0x25], // arpeggio: CH4 reads a PERIOD's low byte as a note
  [3, null, null, 0x9, 0x0c], // set "duty" on a rest: sets NR43 bits 2-3
  [4, 12, 0, 0x9, 0x00], // ... then clears bit 3 alone (read back, `res 3`, OR)
  [5, null, null, 0x9, 0x08], // ... and sets it again
  [6, 50, 1, 0x1, 0x30], // porta up
  [8, 50, 0, 0x2, 0x30], // porta down
  [10, 20, 1, 0x4, 0x1f], // vibrato
  [12, 35, 0, 0xa, 0x12], // vol slide
  [14, 64, 1, 0xe, 0x01], // note cut on tick 1
  [16, 7, 0, 0x3, 0x05], // toneporta, which CH4 "does not support"
  [17, null, null, 0x3, 0x05],
  [19, 45, 0, 0x7, 0x03], // note delay 3
  [21, null, null, 0x5, 0x71], // master volume, from a rest on channel 4
]);

// ---- order 1 (entered at row 4) ------------------------------------------------------
const pulse1B = fill([
  [0, C5 + 20, 0, 0x0, 0x00], // skipped by the break: must never be heard
  [4, C5 + 5, 0, 0x0, 0x58], // arpeggio, new phase
  [6, C5 + 2, 1, 0x4, 0x72], // vibrato, slow
  [9, C5 + 7, 0, 0x5, 0x77], // master volume back to full
  [12, C5 + 12, 0, 0x8, 0xff], // pan back to both
  [14, C5 + 9, null, 0x1, 0x02], // porta up, no instrument
  [19, C5 + 4, 0, 0xb, 0x03], // position jump to order index 2
]);
const pulse2B = fill([
  [5, C5, 0, 0x9, 0x80], // duty 50%
  [8, C5 + 3, 0, 0x7, 0x03], // note delay 3
  [11, C5 + 7, 1, 0xe, 0x02], // note cut
]);
const waveB = fill([
  [4, C5 - 12, 0, 0x9, 0x01], // wave 1
  [10, C5 - 5, 1, 0x0, 0x03], // arpeggio
]);
const noiseB = fill([
  [4, 22, 0, 0xc, 0x0f], // set volume
  [7, 60, 1, 0x9, 0x00], // clear the step width
  [13, 10, 0, 0x4, 0x33], // vibrato
]);

// ---- order 2 -------------------------------------------------------------------------
const pulse1C = fill([
  [0, C5 + 1, 1, 0xf, 0x03], // speed 3
  [3, C5 + 8, 0, 0x0, 0x9a], // arpeggio at the new speed
  [8, C5 + 13, 0, 0xf, 0x06], // speed 6
  [15, C5 + 6, 0, 0xd, 0x01], // break to the next order (wraps to 0), row 0
]);
const pulse2C = fill([[2, C5 - 2, 0, 0x1, 0x40]]);
const waveC = fill([[6, C5 - 4, 1, 0xa, 0x40]]);
const noiseC = fill([[1, 55, 0, 0xe, 0x00]]);

song.patterns = [
  pulse1A,
  pulse2A,
  waveA,
  noiseA,
  pulse1B,
  pulse2B,
  waveB,
  noiseB,
  pulse1C,
  pulse2C,
  waveC,
  noiseC,
];
song.sequence = [0, 4, 8].map((base) => ({
  splitPattern: true,
  channels: [base, base + 1, base + 2, base + 3] as [
    number,
    number,
    number,
    number,
  ],
}));
song.ticksPerRow = 6;

writeFileSync(output, exportToC(song, "song_Effects"));
// eslint-disable-next-line no-console
console.log(
  `song_Effects: ${song.sequence.length} orders, tempo ${song.ticksPerRow}`,
);
