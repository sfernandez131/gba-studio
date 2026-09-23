import { readFileSync } from "fs";
import { join } from "path";
import { loadUGESong } from "shared/lib/uge/ugeHelper";
import {
  compileGbaHugeSong,
  gbaifyHugeC,
  HUGE_INSTRUMENT_SLOTS,
} from "./gbaHugeSong";

const entries = (c: string, table: string) => {
  const body = new RegExp(`${table}\\[\\] = \\{([\\s\\S]*?)\\};`).exec(c);
  if (!body) throw new Error(`no ${table}`);
  return body[1].split("\n").filter((line) => /^\s*\{/.test(line));
};

// The shape exportToC writes, trimmed to what gbaifyHugeC touches.
const exported = (
  duty: number,
  wave: number,
  noise: number,
) => `#pragma bank 255

#include "hUGEDriver.h"
#include <stddef.h>
#include "hUGEDriverRoutines.h"

static const unsigned char order_cnt = 2;
static const hUGEDutyInstr_t duty_instruments[] = {
${"    { 0x00, 0x80, 0xF0, 0, 0x80 },\n".repeat(duty)}};
static const hUGEWaveInstr_t wave_instruments[] = {
${"    { 0x00, 0x20, 0x00, subpattern_0, 0x80 },\n".repeat(wave)}};
static const hUGENoiseInstr_t noise_instruments[] = {
${"    { 0xF0, 0, 0x00, 0, 0 },\n".repeat(noise)}};

const void __at(255) __bank_song_x_Data;
const hUGESong_t song_x_Data = {
    6,
};
`;

describe("gbaifyHugeC", () => {
  test("strips the SDCC banking syntax GCC rejects", () => {
    const c = gbaifyHugeC(exported(15, 15, 15));
    expect(c).not.toContain("#pragma bank");
    expect(c).not.toContain("__at(");
    expect(c).toContain('#include "hUGEDriverRoutines.h"');
    expect(c).toContain("const hUGESong_t song_x_Data = {");
  });

  test("pads each instrument table to 15 silent slots, after the real ones", () => {
    const c = gbaifyHugeC(exported(9, 2, 4));
    const duty = entries(c, "duty_instruments");
    const wave = entries(c, "wave_instruments");
    const noise = entries(c, "noise_instruments");
    expect(duty).toHaveLength(HUGE_INSTRUMENT_SLOTS);
    expect(wave).toHaveLength(HUGE_INSTRUMENT_SLOTS);
    expect(noise).toHaveLength(HUGE_INSTRUMENT_SLOTS);
    // The defined instruments keep their slots (IDs are positional)...
    expect(wave[1]).toContain("subpattern_0");
    // ...and the padding is silent, with no subpattern table.
    expect(wave[2].trim()).toBe("{ 0x00, 0x00, 0x00, 0, 0x00 },");
    expect(noise[4].trim()).toBe("{ 0x00, 0, 0x00, 0, 0 },");
    expect(duty[14].trim()).toBe("{ 0x00, 0x00, 0x00, 0, 0x00 },");
  });

  test("leaves a full table alone", () => {
    const c = gbaifyHugeC(exported(15, 15, 15));
    expect(entries(c, "duty_instruments")).toHaveLength(15);
    expect(c.match(/\{ 0x00, 0x00, 0x00, 0, 0x00 \}/g)).toBeNull();
  });

  test("handles CRLF line endings", () => {
    const c = gbaifyHugeC(exported(1, 1, 1).replace(/\n/g, "\r\n"));
    expect(c).not.toContain("__at(");
    expect(c).not.toContain("#pragma bank");
    expect(c.match(/\{ 0x00, 0, 0x00, 0, 0 \}/g)).toHaveLength(14);
  });

  test("refuses a table hUGE could not address", () => {
    expect(() => gbaifyHugeC(exported(16, 1, 1))).toThrow(/duty_instruments/);
  });
});

describe("compileGbaHugeSong", () => {
  test("turns a real .uge into one GBA translation unit", () => {
    const song = loadUGESong(
      readFileSync(join(__dirname, "../../../../test/data/music/sparse.uge")),
    );
    if (!song) throw new Error("fixture did not load");
    const c = compileGbaHugeSong(song, "song_sparse");
    expect(c).toContain("const hUGESong_t song_sparse_Data = {");
    expect(c).not.toContain("__at(");
    expect(c).not.toContain("#pragma bank");
    for (const table of [
      "duty_instruments",
      "wave_instruments",
      "noise_instruments",
    ]) {
      expect(entries(c, table)).toHaveLength(HUGE_INSTRUMENT_SLOTS);
    }
  });
});
