// Build the runtime-test fixture's music (M14e): Rulz_BattleTheme with "call routine"
// effects added early in order 0, saved as a .uge with the editor's own writer, so
// gba-runtime-test.sh can check that the effect reaches the scripts attached to it.
//
// The effects sit on cells of the noise channel that had none, so the music is unchanged
// except for when the routines fire. Params are chosen so a wrong mapping fails the test:
//   0x21 -> slot 1 (param & 3), argument 2 (param >> 4)
//   0x13 -> slot 3, argument 1
//   0x40, 0x00 -> slot 0, which has no script: gbvm drops the event and ends that frame's
//   drain, so the others must still arrive on later frames.
// Nothing raises slot 2. A port that took the slot from the high nibble would run slot 2
// for 0x21, and the test watches for that.
//
// Not part of the app build; bundle and run it like export-uge.ts:
//   npx esbuild scripts/huge/make-routines-fixture.ts --bundle --platform=node \
//     --tsconfig=tsconfig.json --outfile=<work>/make-routines-fixture.js
//   node <work>/make-routines-fixture.js \
//     appData/templates/gbs2/assets/music/Rulz_BattleTheme.uge \
//     examples/gba_actor_test/assets/music/fixture_routines.uge
import { readFileSync, writeFileSync } from "fs";
import { loadUGESong, saveUGESong } from "shared/lib/uge/ugeHelper";

const [, , input, output] = process.argv;
if (!input || !output) {
  throw new Error("usage: make-routines-fixture <song.uge> <out.uge>");
}

const song = loadUGESong(readFileSync(input));
if (!song) throw new Error(`could not load ${input}`);

const NOISE = 3;
const pattern = song.patterns[song.sequence[0].channels[NOISE]];
const ROUTINES: [number, number][] = [
  [2, 0x21],
  [4, 0x13],
  [5, 0x40],
  [8, 0x21],
  [10, 0x13],
  [14, 0x00],
];
for (const [row, param] of ROUTINES) {
  const cell = pattern[row];
  if (cell.effectCode !== null) {
    throw new Error(`row ${row} already has effect ${cell.effectCode}`);
  }
  cell.effectCode = 0x6;
  cell.effectParam = param;
}

writeFileSync(output, saveUGESong(song));
// eslint-disable-next-line no-console
console.log(`wrote ${output}: ${ROUTINES.length} routine effects in order 0`);
