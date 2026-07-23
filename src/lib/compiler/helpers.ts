type DirectionGBVMValue = "DIR_DOWN" | "DIR_LEFT" | "DIR_RIGHT" | "DIR_UP";

const DIR_ENUM_LOOKUP: Record<string, DirectionGBVMValue> = {
  down: "DIR_DOWN",
  left: "DIR_LEFT",
  right: "DIR_RIGHT",
  up: "DIR_UP",
} as const;

const KEY_BITS: Record<string, number> = {
  left: 0x02,
  right: 0x01,
  up: 0x04,
  down: 0x08,
  a: 0x10,
  b: 0x20,
  select: 0x40,
  start: 0x80,
  // M8a: GBA-exclusive L/R shoulder buttons (high byte). Only selectable via
  // the platform-gated GBA input UI, so GB masks never exceed 0xff.
  l: 0x100,
  r: 0x200,
} as const;

export const inputDec = (input: string | string[]) => {
  let output = 0;
  if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i++) {
      output |= KEY_BITS[input[i]];
    }
  } else {
    output = KEY_BITS[input];
  }
  if (output === 0) {
    // If no input set game would hang
    // as could not continue on, assume
    // this isn't what user wants and
    // instead allow any input
    output = 255;
  }
  return output;
};

export const dirEnum = (dir: unknown): DirectionGBVMValue =>
  DIR_ENUM_LOOKUP[dir as string] || "DIR_DOWN";
