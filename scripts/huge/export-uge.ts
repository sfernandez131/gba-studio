// Export a .uge song to C with the editor's OWN exporter - the same code the GB build
// uses - so M14 verification runs against real exporter output rather than a copy.
//
// Not part of the app build. Bundle and run it with esbuild, which honours the tsconfig
// baseUrl the `shared/...` import needs:
//
//   npx esbuild scripts/huge/export-uge.ts --bundle --platform=node \
//     --tsconfig=tsconfig.json --outfile=<work>/export-uge.js
//   node <work>/export-uge.js <song.uge> <symbol> <out.c>
//
// See scripts/huge/README.md for the whole verification recipe.
import { readFileSync, writeFileSync } from "fs";
import { loadUGESong, exportToC } from "shared/lib/uge/ugeHelper";

const [, , input, symbol, output] = process.argv;
if (!input || !symbol || !output) {
  throw new Error("usage: export-uge <song.uge> <symbol> <out.c>");
}
const song = loadUGESong(readFileSync(input));
writeFileSync(output, exportToC(song, symbol));
// eslint-disable-next-line no-console
console.log(
  `${symbol}: ticksPerRow=${song.ticksPerRow} orders=${song.sequence.length}`,
);
