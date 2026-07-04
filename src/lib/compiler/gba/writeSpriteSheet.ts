// GBA Studio - actor spritesheet -> Butano sprite converter (Phase 1).
//
// GB Studio sprites are metasprites: a frame is composed of 8x8 / 8x16 tiles
// sliced from the source PNG and placed at offsets (with optional flips). Each
// sprite has a state whose stored animations expand - via the same
// animationMapBySpriteType + toEngineOrder logic the GB engine uses - into 8
// engine animations: idle/moving x Down/Right/Up/Left (left often a flipped
// right). See shared/lib/sprites/helpers.ts.
//
// We assemble every engine animation's frames into a single canvasW x
// (canvasH * frameCount) indexed image (frames stacked top-to-bottom) plus the
// per-animation frame ranges. ejectGbaBuild turns the image into a Butano
// sprite_item BMP (index 0 stays transparent, as GBA sprites require) and emits
// the ranges so the engine can pick a frame by the actor's facing direction.

import { IndexedImage, makeIndexedImage } from "shared/lib/tiles/indexedImage";
import {
  animationMapBySpriteType,
  toEngineOrder,
} from "shared/lib/sprites/helpers";

interface SpriteTile {
  x: number;
  y: number;
  sliceX: number;
  sliceY: number;
  flipX: boolean;
  flipY: boolean;
}
interface SpriteFrame {
  tiles: SpriteTile[];
}
interface SpriteAnimation {
  frames: SpriteFrame[];
}
interface SpriteState {
  name: string;
  animationType: string;
  flipLeft: boolean;
  animations: SpriteAnimation[];
}
export interface SpriteSheetInput {
  canvasWidth: number;
  canvasHeight: number;
  states: SpriteState[];
}

export interface AnimRange {
  start: number; // first frame index
  len: number; // number of frames
}

export interface SpriteSheet {
  sheet: IndexedImage; // frameWidth x (frameHeight * frameCount), frames stacked
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  // statesOrder.length rows of 8 ranges in toEngineOrder (Down, Right, Up,
  // Left, then the moving variants), row-major. A global state the sprite
  // doesn't define reuses the default state's row, so switching to it is a
  // safe no-op (M10c).
  animRanges: AnimRange[];
}

// Assemble one frame's canvasW x canvasH indexed image from its metasprite tiles.
const assembleFrame = (
  frame: SpriteFrame,
  src: IndexedImage,
  fw: number,
  fh: number,
  tileW: number,
  tileH: number,
  mirror: boolean, // whole-frame horizontal flip (left-facing from right)
): IndexedImage => {
  const out = makeIndexedImage(fw, fh);
  for (const tile of frame.tiles) {
    const flipX = tile.flipX !== mirror;
    const baseX = mirror ? fw - tileW - tile.x : tile.x;
    for (let ty = 0; ty < tileH; ty++) {
      for (let tx = 0; tx < tileW; tx++) {
        const sx = tile.sliceX + tx;
        const sy = tile.sliceY + ty;
        if (sx < 0 || sx >= src.width || sy < 0 || sy >= src.height) continue;
        const value = src.data[sy * src.width + sx];
        const dx = baseX + (flipX ? tileW - 1 - tx : tx);
        const dy = tile.y + (tile.flipY ? tileH - 1 - ty : ty);
        if (dx >= 0 && dx < fw && dy >= 0 && dy < fh) {
          out.data[dy * fw + dx] = value;
        }
      }
    }
  }
  return out;
};

/**
 * Build a stacked Butano-ready sprite sheet + per-direction frame ranges from a
 * GB Studio sprite resource and its decoded source image.
 */
export function buildSpriteSheet(
  sprite: SpriteSheetInput,
  src: IndexedImage,
  spriteMode: string,
  statesOrder: string[] = [""],
): SpriteSheet {
  const fw = sprite.canvasWidth;
  const fh = sprite.canvasHeight;
  const tileW = 8;
  const tileH = spriteMode === "8x16" ? 16 : 8;

  const frames: IndexedImage[] = [];

  // Expand ONE sprite state into its 8 engine-order animation ranges,
  // appending its frames to the shared frame stack.
  const buildStateRanges = (state: SpriteState): AnimRange[] => {
    const engineAnims = toEngineOrder(
      animationMapBySpriteType(
        state.animations,
        state.animationType as Parameters<typeof animationMapBySpriteType>[1],
        state.flipLeft,
        (animation, flip) => ({ animation, flip }),
      ),
    );
    const ranges: AnimRange[] = [];
    for (const ea of engineAnims) {
      const start = frames.length;
      const frameList = ea && ea.animation ? ea.animation.frames : [];
      if (frameList.length === 0) {
        frames.push(makeIndexedImage(fw, fh)); // blank frame keeps the range valid
      } else {
        for (const frame of frameList) {
          frames.push(
            assembleFrame(frame, src, fw, fh, tileW, tileH, !!(ea && ea.flip)),
          );
        }
      }
      ranges.push({ start, len: frames.length - start });
    }
    return ranges;
  };

  // Frames are emitted once per state the sprite actually defines; the
  // project-global state table then maps each global state to its sheet
  // state's ranges (default state when the sprite doesn't define it).
  const rangesByStateName = new Map<string, AnimRange[]>();
  for (const state of sprite.states) {
    if (!rangesByStateName.has(state.name)) {
      rangesByStateName.set(state.name, buildStateRanges(state));
    }
  }
  const defaultRanges =
    rangesByStateName.get(sprite.states[0]?.name ?? "") ??
    rangesByStateName.values().next().value ??
    [];

  const animRanges: AnimRange[] = [];
  for (const globalState of statesOrder) {
    animRanges.push(...(rangesByStateName.get(globalState) ?? defaultRanges));
  }

  // Stack frames into one tall image.
  const sheet = makeIndexedImage(fw, fh * frames.length);
  frames.forEach((frame, i) => {
    const oy = i * fh;
    for (let y = 0; y < fh; y++) {
      sheet.data.set(frame.data.subarray(y * fw, y * fw + fw), (oy + y) * fw);
    }
  });

  return {
    sheet,
    frameWidth: fw,
    frameHeight: fh,
    frameCount: frames.length,
    animRanges,
  };
}
