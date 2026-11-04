// GBA Studio - a scene's parallax bands, as gbvm draws them (gbs2 G4).
//
// GB Studio's compileParallax (generateGBVMData.ts) turns a scene's parallax
// layers into up to three PARALLAX_STEP(start, end, shift) rows. gbvm's LCD
// interrupt walks them down the screen: each row with an end is an upper band
// (screen tile rows start..end, scrolled to camera x >> shift, pinned vertically),
// and the first row without one (end 0) is the normal view for the rest of the
// screen, whatever its speed. The GBA eject draws each upper band as its own
// background, so this returns just those.

import { SCREEN_WIDTH } from "consts";
import { wrapSigned8Bit } from "shared/lib/helpers/8bit";
import type { SceneParallaxLayer } from "shared/lib/resources/types";

export interface GbaParallaxBand {
  /** First tile row of the scene (and of the screen) the band shows. */
  startRow: number;
  /** One past its last tile row. */
  endRow: number;
  /** gbvm's shift: camera x >> shift (<< -shift when negative; 127 and -128 hold still). */
  shift: number;
}

// compileParallax stretches a band to the GB screen's bottom row; on the GBA the
// screen is two tile rows taller, and the band fills those too.
const GB_SCREEN_ROWS = 18;
const GBA_SCREEN_ROWS = 20;

export const gbaParallaxBands = (
  parallax: SceneParallaxLayer[] | undefined,
  sceneWidthTiles: number,
): GbaParallaxBand[] => {
  // GB Studio compiles parallax only for a scene wider than the GB screen.
  if (!parallax || parallax.length === 0 || sceneWidthTiles <= SCREEN_WIDTH) {
    return [];
  }
  // The PARALLAX_STEP rows compileParallax emits, as (start, end, shift).
  const steps: GbaParallaxBand[] = [];
  let row = 0;
  parallax.forEach((layer, layerIndex) => {
    const shift = wrapSigned8Bit(layer.speed);
    if (layerIndex === parallax.length - 1) {
      // With one or two layers, a last layer not at camera speed reaches the
      // screen's bottom, and a terminator row follows it.
      if (parallax.length < 3 && layer.speed !== 0) {
        steps.push({ startRow: row, endRow: GB_SCREEN_ROWS, shift });
      } else {
        steps.push({ startRow: row, endRow: 0, shift });
      }
      return;
    }
    steps.push({ startRow: row, endRow: row + layer.height, shift });
    row += layer.height;
  });
  const bands: GbaParallaxBand[] = [];
  for (const step of steps) {
    if (step.endRow === 0) break; // the normal view: the interrupt chain ends here
    if (step.endRow <= step.startRow) continue; // no lines to draw
    bands.push({
      ...step,
      endRow: step.endRow === GB_SCREEN_ROWS ? GBA_SCREEN_ROWS : step.endRow,
    });
  }
  return bands;
};

/**
 * A copy of a scene background holding only one band's rows: every pixel outside
 * them becomes index 0, which the GBA draws as transparent.
 */
export const parallaxBandImage = <
  T extends { width: number; height: number; data: Uint8Array | number[] },
>(
  img: T,
  band: GbaParallaxBand,
): { width: number; height: number; data: Uint8Array } => {
  const data = new Uint8Array(img.width * img.height);
  const top = Math.min(img.height, band.startRow * 8);
  const bottom = Math.min(img.height, band.endRow * 8);
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < img.width; x++) {
      data[y * img.width + x] = img.data[y * img.width + x];
    }
  }
  return { width: img.width, height: img.height, data };
};
