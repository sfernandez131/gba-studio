import { exportToC } from "shared/lib/uge/ugeHelper";
import type { Song } from "shared/lib/uge/types";

/** hUGE instrument IDs are a nibble (1-15, 0 = none), so a song can name 15 of each kind. */
export const HUGE_INSTRUMENT_SLOTS = 15;

// Each instrument table the exporter writes, and a silent, table-less entry for it.
const EMPTY_INSTRUMENTS: [string, string][] = [
  ["duty_instruments", "{ 0x00, 0x00, 0x00, 0, 0x00 }"],
  ["wave_instruments", "{ 0x00, 0x00, 0x00, 0, 0x00 }"],
  ["noise_instruments", "{ 0x00, 0, 0x00, 0, 0 }"],
];

/**
 * Adapts the C that `exportToC` writes for the GB build so GCC compiles it for gbavm's
 * hUGE player (M14d). Two SDCC-isms are stripped: `#pragma bank`, which is meaningless on
 * the flat GBA, and `const void __at(N) __bank_X;`, which is SDCC-only syntax and a hard
 * GCC error. Everything else is plain C and compiles against gbavm's hUGEDriver.h.
 *
 * It also pads each instrument table to 15 slots. Pattern data can name an instrument the
 * song never defined: GBVM's own `dizzy.uge` plays wave instrument 3 but defines two. The
 * exporter writes only the instruments that exist, and hUGESong_t carries no counts for
 * the player to check. On the GB the driver reads on past the table, into data that
 * leaves the channel effectively silent. On the GBA the same read runs off the end of a
 * C array, and its subpattern field becomes a wild pointer. So the missing slots become
 * all-zero instruments: silent, with no table.
 */
export const gbaifyHugeC = (c: string): string => {
  let text = c
    .replace(/^#pragma bank \d+[ \t]*\r?\n/gm, "")
    .replace(/^const void __at\(\d+\) __bank_\w+;[ \t]*\r?\n/gm, "");
  if (text.includes("__at(") || text.includes("#pragma bank")) {
    throw new Error(
      "gbaifyHugeC: unexpected SDCC banking syntax in exported song",
    );
  }
  for (const [name, empty] of EMPTY_INSTRUMENTS) {
    const table = new RegExp(
      `(static const \\w+ ${name}\\[\\] = \\{\\r?\\n)([\\s\\S]*?)(\\};)`,
    );
    const match = table.exec(text);
    if (!match) {
      throw new Error(`gbaifyHugeC: no ${name} table in exported song`);
    }
    const count = (match[2].match(/^\s*\{/gm) ?? []).length;
    if (count > HUGE_INSTRUMENT_SLOTS) {
      throw new Error(
        `gbaifyHugeC: ${name} has ${count} entries, more than hUGE can address`,
      );
    }
    const fill = `    ${empty},\n`.repeat(HUGE_INSTRUMENT_SLOTS - count);
    const end = match.index + match[1].length + match[2].length;
    text = text.slice(0, end) + fill + text.slice(end);
  }
  return text;
};

/** A .uge song as one GBA C translation unit, defining `<symbol>_Data`. */
export const compileGbaHugeSong = (song: Song, symbol: string): string =>
  gbaifyHugeC(exportToC(song, symbol));
