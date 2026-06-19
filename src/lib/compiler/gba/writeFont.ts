// GBA Studio - GB Studio font -> Butano sprite_font glyph sheet (P3).
//
// GB Studio compiles a font to CompiledFontData: table[codepoint] -> unique-tile
// index, widths[uniqueTile] (variable-width), and data = concatenated 2bpp planar
// 8x8 tiles (16 bytes each; row y = data[t*16+y*2] low plane + [..+1] high plane,
// pixel x at bit 7-x). Butano's bn::sprite_font wants the 94 printable ASCII glyphs
// '!'(33)..'~'(126) as 8x8 sprite graphics (space (32) is rendered blank), plus a
// character-widths array of [spaceWidth, w33, ..., w126] (95 entries). We expand the
// on/off glyph pixels into a contiguous 4bpp sheet (index 0 transparent, 1 = text).

import { writeFile } from "fs-extra";
import Path from "path";
import { indexedImageToBmp, hexToRgb } from "./writeIndexedBmp";
import type { Rgb } from "./writeIndexedBmp";

export interface CompiledFontLike {
  table: number[]; // codepoint -> unique-tile index
  widths: number[]; // per unique-tile pixel width
  data: Uint8Array; // concatenated 2bpp planar 8x8 tiles
}

export interface FontConversion {
  name: string; // the grit sprite-item name (font_<symbol>)
  include: string; // the generated grit header include line
  widths: number[]; // 95 entries: [space, cp33..cp126]
}

const FIRST = 33; // '!'
const LAST = 126; // '~'
const GLYPHS = LAST - FIRST + 1; // 94

export async function writeFont(
  font: CompiledFontLike,
  symbol: string,
  gbaEngineRoot: string,
  textColorHex: string,
): Promise<FontConversion> {
  const name = `font_${symbol}`;
  const tileOf = (cp: number) => (cp < font.table.length ? font.table[cp] | 0 : 0);
  const pixelOn = (tile: number, x: number, y: number): boolean => {
    const base = tile * 16 + y * 2;
    if (base + 1 >= font.data.length) return false;
    const lo = font.data[base];
    const hi = font.data[base + 1];
    const bit = 7 - x;
    return (((lo >> bit) & 1) | (((hi >> bit) & 1) << 1)) !== 0;
  };

  // 8px-wide sheet, 94 glyphs stacked vertically -> grit slices it into 8x8 frames.
  const cols = 8;
  const rows = GLYPHS * 8;
  const data = new Uint8Array(cols * rows);
  for (let g = 0; g < GLYPHS; g++) {
    const tile = tileOf(FIRST + g);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        if (pixelOn(tile, x, y)) data[(g * 8 + y) * cols + x] = 1;
      }
    }
  }

  const palette: Rgb[] = [
    [0, 0, 0], // 0: transparent (sprite colour key)
    hexToRgb(textColorHex), // 1: text colour
  ];
  const bmp = indexedImageToBmp({ width: cols, height: rows, data }, palette, {
    align: 8,
  });
  await writeFile(Path.join(gbaEngineRoot, "graphics", `${name}.bmp`), bmp);
  await writeFile(
    Path.join(gbaEngineRoot, "graphics", `${name}.json`),
    JSON.stringify({ type: "sprite", height: 8 }) + "\n",
  );

  const clamp = (w: number) => Math.max(1, Math.min(8, w | 0));
  const widthOf = (cp: number) => clamp(font.widths[tileOf(cp)] ?? 8);
  const widths = [widthOf(32)]; // [0] = space width
  for (let cp = FIRST; cp <= LAST; cp++) widths.push(widthOf(cp));

  return { name, include: `#include "bn_sprite_items_${name}.h"`, widths };
}
