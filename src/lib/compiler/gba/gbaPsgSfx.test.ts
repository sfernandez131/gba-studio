import {
  collectPsgSfx,
  parsePsgSfxC,
  psgSfxC,
  PSG_SFX_FLAG,
} from "./gbaPsgSfx";

// The shape compileFXHammer writes: several effects per file, binary literals.
const fxhammer = `#pragma bank 255

#include <gbdk/platform.h>
#include <stdint.h>

BANKREF(sound_fx_00)
const uint8_t sound_fx_00[] = {
0x31,0b01111001,0x40,0xB8,0x7B,0x87,0x03,0b00101001,0x00,0xC0,0b01000100,0xFF,0b00000111
};
void AT(0b00000010) __mute_mask_sound_fx_00;

BANKREF(sound_fx_01)
const uint8_t sound_fx_01[] = {
0xB1,0b01111001,0x80,0xB8,0x39,0x87,0b00000111
};
void AT(0b00001000) __mute_mask_sound_fx_01;
`;

// The shape the Play Tone / Beep / Crash events write: comments, several lines.
const legacy = `#pragma bank 255

BANKREF(sound_legacy_0)
const uint8_t sound_legacy_0[] = {
0xF1, 0b11111000,0x00,0x81,0xF0,0x40,0x86,
0xF0,
0x01, 0b00101000, 0x00,0xc0,      //shut ch1
0x01, 0b00000111,                 //stop
};
void AT(0b00000001) __mute_mask_sound_legacy_0;`;

describe("parsePsgSfxC", () => {
  test("reads every effect in an FX Hammer file, with its own mute mask", () => {
    const effects = parsePsgSfxC(fxhammer);
    expect(effects.map((e) => e.symbol)).toEqual([
      "sound_fx_00",
      "sound_fx_01",
    ]);
    expect(effects[0].muteMask).toBe(0x02);
    expect(effects[1].muteMask).toBe(0x08);
    expect(effects[1].bytes).toEqual([
      0xb1, 0x79, 0x80, 0xb8, 0x39, 0x87, 0x07,
    ]);
  });

  test("reads a legacy tone, skipping comments and the trailing comma", () => {
    const [tone] = parsePsgSfxC(legacy);
    expect(tone.symbol).toBe("sound_legacy_0");
    expect(tone.muteMask).toBe(1);
    expect(tone.bytes).toEqual([
      0xf1, 0xf8, 0x00, 0x81, 0xf0, 0x40, 0x86, 0xf0, 0x01, 0x28, 0x00, 0xc0,
      0x01, 0x07,
    ]);
  });

  test("refuses an effect without a mute mask", () => {
    expect(() => parsePsgSfxC("const uint8_t s[] = { 0x01, 0x07 };")).toThrow(
      /no mute mask for s/,
    );
  });

  test("refuses a value that is not a byte", () => {
    expect(() =>
      parsePsgSfxC("const uint8_t s[] = { 0x100 };\nvoid AT(1) __mute_mask_s;"),
    ).toThrow(/not a byte/);
  });
});

describe("collectPsgSfx", () => {
  test("takes sounds/*.c only, skipping the .wav sounds, in a stable order", () => {
    const effects = collectPsgSfx(
      {
        "sounds/sound_legacy_0.c": legacy,
        "sounds/sound_fx.c": fxhammer,
        "sounds/sound_beep.c":
          "const uint8_t sound_beep[] = { 0x01 };\nvoid AT(4) __mute_mask_sound_beep;",
        "scene_1.c": "const uint8_t not_a_sound[] = { 0x01 };",
      },
      new Set(["sound_beep"]),
    );
    expect(effects.map((e) => e.symbol)).toEqual([
      "sound_fx_00",
      "sound_fx_01",
      "sound_legacy_0",
    ]);
  });
});

describe("psgSfxC", () => {
  test("writes plain C arrays with the same bytes", () => {
    const c = psgSfxC(parsePsgSfxC(fxhammer));
    expect(c).toContain("#include <stdint.h>");
    expect(c).not.toContain("BANKREF");
    expect(c).not.toContain("AT(");
    expect(c).toContain(
      "const uint8_t sound_fx_01[] = {\n    0xB1, 0x79, 0x80, 0xB8, 0x39, 0x87, 0x07,\n};",
    );
  });

  test("the PSG flag sits above any byte index", () => {
    expect(PSG_SFX_FLAG & 0xff).toBe(0);
  });
});
