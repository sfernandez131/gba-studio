import { parseGbvmAsm, parseGameGlobals } from "./parseGbvmAsm";
import { emitGbaBytecode } from "./emitGbaBytecode";

// The exact scene-init assembly GB Studio emits for a one-actor scene whose on-init
// script is [Activate Actor, Set Position]. Kept verbatim so the test tracks the
// real codegen, not a hand-massaged copy.
const SCENE_INIT = `
.module scene_test_init
.include "vm.i"
.globl _fade_frames_per_step
.area _CODE_255
.LOCAL_ACTOR = -4
_scene_test_init::
        VM_LOCK
        VM_RESERVE              4
        ; Set Sprite Mode: 8x16
        VM_SET_SPRITE_MODE      .MODE_8X16
        ; Actor Activate
        VM_SET_CONST            .LOCAL_ACTOR, 1
        VM_ACTOR_ACTIVATE       .LOCAL_ACTOR
        ; Actor Set Position
        VM_RPN
            .R_INT16    3840
            .R_REF_SET  ^/(.LOCAL_ACTOR + 1)/
            .R_INT16    2560
            .R_REF_SET  ^/(.LOCAL_ACTOR + 2)/
            .R_STOP
        VM_SET_CONST            .LOCAL_ACTOR, 1
        VM_ACTOR_SET_POS        .LOCAL_ACTOR
        VM_IDLE
        ; Fade In
        VM_SET_CONST_INT8       _fade_frames_per_step, 1
        VM_FADE_IN              1
        VM_STOP
`;

describe("parseGbvmAsm", () => {
  test("parses a real scene-init script into gbavm opcodes", () => {
    const { items, skipped } = parseGbvmAsm(SCENE_INIT);

    // Drop labels for op-level comparison (the entry label carries no bytes).
    const ops = items.filter((i) => i.kind !== "label");

    expect(ops).toEqual([
      { kind: "op", op: 0x25, operands: [] }, // VM_LOCK
      { kind: "op", op: 0x12, operands: [4] }, // VM_RESERVE 4
      { kind: "op", op: 0x5d, operands: [1] }, // VM_SET_SPRITE_MODE .MODE_8X16
      { kind: "op", op: 0x14, operands: [-4, 1] }, // VM_SET_CONST .LOCAL_ACTOR, 1
      { kind: "op", op: 0x31, operands: [-4] }, // VM_ACTOR_ACTIVATE
      // VM_RPN: INT16 3840; REF_SET -3; INT16 2560; REF_SET -2; STOP
      {
        kind: "rpn",
        bytes: [
          0xfe,
          0x00,
          0x0f, // INT16 3840
          0xfb,
          0xfd,
          0xff, // REF_SET (-4+1 = -3)
          0xfe,
          0x00,
          0x0a, // INT16 2560
          0xfb,
          0xfe,
          0xff, // REF_SET (-4+2 = -2)
          0x00, // STOP
        ],
      },
      { kind: "op", op: 0x14, operands: [-4, 1] }, // VM_SET_CONST
      { kind: "op", op: 0x35, operands: [-4] }, // VM_ACTOR_SET_POS
      { kind: "op", op: 0x18, operands: [] }, // VM_IDLE
      // VM_SET_CONST_INT8 _fade_frames_per_step, 1 -> RPN raw-memory write
      {
        kind: "rpn",
        bytes: [0xff, 0x01, 0xf8, 0x69, 0, 0, 0, 0, 0x00],
        relocs: [{ at: 4, symbol: "_fade_frames_per_step" }],
      },
      { kind: "op", op: 0x57, operands: [2] }, // VM_FADE_IN -> VM_FADE (no-op)
      { kind: "stop" }, // VM_STOP
    ]);

    // The engine-symbol write is now expanded to an RPN write (not dropped).
    expect(skipped).toEqual([]);
  });

  test("the parsed stream round-trips through the emitter", () => {
    const { items } = parseGbvmAsm(SCENE_INIT);
    const { bytes, relocations } = emitGbaBytecode(items);
    expect(bytes.length).toBeGreaterThan(0);
    expect(relocations).toEqual([]); // no code targets in this script
    expect(bytes[bytes.length - 1]).toBe(0x00); // ends at VM_STOP
  });

  test("throws on an unknown macro rather than dropping it silently", () => {
    expect(() => parseGbvmAsm("        VM_TOTALLY_MADE_UP 1, 2\n")).toThrow(
      /Unsupported GBVM macro "VM_TOTALLY_MADE_UP"/,
    );
  });

  test("evaluates SDCC expression wrappers and named constants", () => {
    const { items } = parseGbvmAsm(
      `.FOO = 10\n        VM_SET_CONST ^/(.FOO + 2)/, .MODE_8X16\n`,
    );
    expect(items).toEqual([{ kind: "op", op: 0x14, operands: [12, 1] }]);
  });

  // The walking-PoC input path: the editor's joypad read (VM_GET_INT8 from
  // _joypads) is retargeted to VM_INPUT_GET, and the IF_INPUT check compiles to
  // VM_IF_CONST against .ARG0. Both must bridge cleanly with a label relocation.
  test("bridges the GBA input read + VM_IF_CONST from an update script", () => {
    const asm = `
.LOCAL_IN = -4
_actor_update::
        VM_GET_INT8     .LOCAL_IN, ^/(_joypads + 1)/
        VM_RPN
            .R_REF      .LOCAL_IN
            .R_INT8     1
            .R_OPERATOR .B_AND
            .R_STOP
        VM_IF_CONST     .NE, .ARG0, 0, 1$, 1
        VM_JUMP         2$
1$:
        VM_IDLE
2$:
        VM_STOP
`;
    const { items } = parseGbvmAsm(asm);
    // joypad read -> INPUT_GET joyid 0, dest idx -4
    expect(items.find((i) => i.kind === "op" && i.op === 0x54)).toEqual({
      kind: "op",
      op: 0x54,
      operands: [0, -4],
    });
    // IF_INPUT -> IF_CONST .NE(6), .ARG0(-1), B=0, label 1$, n=1
    expect(items.find((i) => i.kind === "op" && i.op === 0x1a)).toEqual({
      kind: "op",
      op: 0x1a,
      operands: [6, -1, 0, { label: "1$" }, 1],
    });
    // The label targets resolve to relocations (IF_CONST ptr + JUMP ptr).
    const { relocations } = emitGbaBytecode(items);
    expect(relocations.length).toBe(2);
  });
});

// P0: cheap opcodes bridged to engine handlers the gbavm VM_STEP now implements.
describe("parseGbvmAsm — P0 opcodes", () => {
  test("bridges VM_LOOP to op 0x07 with a label operand", () => {
    const { items } = parseGbvmAsm(
      "        VM_LOOP .ARG0, 1$, 2\n1$:\n        VM_STOP\n",
    );
    expect(items.find((i) => i.kind === "op" && i.op === 0x07)).toEqual({
      kind: "op",
      op: 0x07,
      operands: [-1, { label: "1$" }, 2],
    });
  });

  test("bridges VM_TEST_TERMINATE to op 0x2a", () => {
    const { items } = parseGbvmAsm("        VM_TEST_TERMINATE 1\n");
    expect(items).toEqual([{ kind: "op", op: 0x2a, operands: [1] }]);
  });

  test("bridges VM_ACTOR_GET_ANGLE to op 0x86", () => {
    const { items } = parseGbvmAsm("        VM_ACTOR_GET_ANGLE .ARG1, .ARG0\n");
    expect(items).toEqual([{ kind: "op", op: 0x86, operands: [-2, -1] }]);
  });

  test("bridges VM_SIN_SCALE / VM_COS_SCALE to ops 0x89 / 0x8a", () => {
    const sin = parseGbvmAsm("        VM_SIN_SCALE .ARG0, .ARG1, 5\n").items;
    expect(sin).toEqual([{ kind: "op", op: 0x89, operands: [-1, -2, 5] }]);
    const cos = parseGbvmAsm("        VM_COS_SCALE .ARG0, .ARG1, 5\n").items;
    expect(cos).toEqual([{ kind: "op", op: 0x8a, operands: [-1, -2, 5] }]);
  });

  test("M10a: bridges VM_ACTOR_SET_MOVE_SPEED / SET_HIDDEN / GET_DIR to ops 0x3e / 0x3f / 0x40", () => {
    expect(
      parseGbvmAsm("        VM_ACTOR_SET_MOVE_SPEED .ARG0, 64\n").items,
    ).toEqual([{ kind: "op", op: 0x3e, operands: [-1, 64] }]);
    expect(
      parseGbvmAsm("        VM_ACTOR_SET_HIDDEN .ARG0, 1\n").items,
    ).toEqual([{ kind: "op", op: 0x3f, operands: [-1, 1] }]);
    expect(
      parseGbvmAsm("        VM_ACTOR_GET_DIR .ARG1, .ARG0\n").items,
    ).toEqual([{ kind: "op", op: 0x40, operands: [-2, -1] }]);
  });

  test("M10c: bridges VM_ACTOR_SET_ANIM_SET to op 0x41 resolving STATE_ globals", () => {
    const { items } = parseGbvmAsm(
      "        VM_ACTOR_SET_ANIM_SET .ARG0, STATE_ATTACK\n",
      { globals: { STATE_ATTACK: 2 } },
    );
    expect(items).toEqual([{ kind: "op", op: 0x41, operands: [-1, 2] }]);
  });

  test("M10d: expands VM_ACTOR_EMOTE to op 0x42 resolving the emote data symbol", () => {
    const { items } = parseGbvmAsm(
      "        VM_ACTOR_EMOTE .ARG0, ___bank_emote_shock, _emote_shock\n",
      { dataSymbols: { ["_emote_shock"]: 5 } },
    );
    expect(items).toEqual([{ kind: "op", op: 0x42, operands: [-1, 5] }]);
  });

  test("M10e: bridges actor flags / collision toggle / single-op Move To", () => {
    expect(
      parseGbvmAsm(
        "        VM_ACTOR_SET_FLAGS .ARG0, ^/(.ACTOR_FLAG_HIDDEN | .ACTOR_FLAG_ANIM_NOLOOP)/, .ACTOR_FLAG_ANIM_NOLOOP\n",
      ).items,
    ).toEqual([{ kind: "op", op: 0x44, operands: [-1, 6, 4] }]);
    expect(
      parseGbvmAsm("        VM_ACTOR_SET_COLL_ENABLED .ARG0, 1\n").items,
    ).toEqual([{ kind: "op", op: 0x45, operands: [-1, 1] }]);
    expect(parseGbvmAsm("        VM_ACTOR_MOVE_TO .ARG0\n").items).toEqual([
      { kind: "op", op: 0x46, operands: [-1] },
    ]);
  });

  test("M11c: bridges VM_OVERLAY_CLEAR to op 0x96 (box geometry)", () => {
    const { items, skipped } = parseGbvmAsm(
      "        VM_OVERLAY_CLEAR 0, 0, 10, 6, .UI_COLOR_WHITE, ^/(.UI_DRAW_FRAME | .UI_AUTO_SCROLL)/\n",
    );
    expect(items).toEqual([
      { kind: "op", op: 0x96, operands: [0, 0, 10, 6, 1, 3] },
    ]);
    expect(skipped).toEqual([]);
  });

  test("M11a: bridges VM_CHOICE + the trailing .MENUITEM table (the Choice event shape)", () => {
    const asm = [
      "        VM_CHOICE               VAR_RESULT, ^/(.UI_MENU_LAST_0 | .UI_MENU_CANCEL_B)/, 2",
      "        .MENUITEM               1, 1, 0, 0, 0, 2",
      "        .MENUITEM               1, 2, 0, 0, 1, 0",
    ].join("\n");
    const { items } = parseGbvmAsm(asm, { globals: { VAR_RESULT: 7 } });
    expect(items).toEqual([
      { kind: "op", op: 0x48, operands: [7, 3, 2] },
      { kind: "raw", bytes: [1, 1, 0, 0, 0, 2] },
      { kind: "raw", bytes: [1, 2, 0, 0, 1, 0] },
    ]);
  });

  test("M11a: keeps the goto text code (\\003 x y) inline for choice-line indenting", () => {
    const { items } = parseGbvmAsm(
      [
        "        VM_LOAD_TEXT 0",
        '        .asciz "\\001\\001\\003\\003\\002Yes\\n\\003\\003\\003No"',
        "        VM_DISPLAY_TEXT",
      ].join("\n"),
    );
    const display = items.find((i) => i.kind === "raw");
    // op 0x90, no avatar (0xff), 0 vars, then: speed code, goto(3,2), "Yes",
    // newline, goto(3,3), "No", terminator.
    expect(display).toEqual({
      kind: "raw",
      bytes: [
        0x90, 0xff, 0, 0x01, 0x01, 0x03, 0x03, 0x02, 0x59, 0x65, 0x73, 0x0a,
        0x03, 0x03, 0x03, 0x4e, 0x6f, 0,
      ],
    });
  });

  test("M10h: expands VM_ACTOR_SET_SPRITESHEET to op 0x47 resolving the sprite symbol", () => {
    const { items } = parseGbvmAsm(
      "        VM_ACTOR_SET_SPRITESHEET .ARG0, ___bank_sprite_static, _sprite_static\n",
      { dataSymbols: { ["_sprite_static"]: 3 } },
    );
    expect(items).toEqual([{ kind: "op", op: 0x47, operands: [-1, 3] }]);
  });

  test("M10h: drops VM_ACTOR_SET_SPRITESHEET when the sheet wasn't emitted", () => {
    const { items, skipped } = parseGbvmAsm(
      "        VM_ACTOR_SET_SPRITESHEET .ARG0, ___bank_sprite_x, _sprite_x\n",
    );
    expect(items).toEqual([]);
    expect(skipped).toContain(
      "VM_ACTOR_SET_SPRITESHEET .ARG0, ___bank_sprite_x, _sprite_x",
    );
  });

  test("M10f: bridges VM_PROJECTILE_LAUNCH to op 0x80 (slot + stack-args ref)", () => {
    expect(
      parseGbvmAsm("        VM_PROJECTILE_LAUNCH 1, .ARG2\n").items,
    ).toEqual([{ kind: "op", op: 0x80, operands: [1, -3] }]);
  });

  test("M10f: expands VM_PROJECTILE_LOAD_TYPE to op 0x81 resolving the table symbol", () => {
    const { items } = parseGbvmAsm(
      "        VM_PROJECTILE_LOAD_TYPE 2, 1, ___bank_global_projectiles_0, _global_projectiles_0\n",
      { dataSymbols: { ["_global_projectiles_0"]: 5 } },
    );
    expect(items).toEqual([{ kind: "op", op: 0x81, operands: [2, 1, 5] }]);
  });

  test("M10f: drops VM_PROJECTILE_LOAD_TYPE when the table symbol is unknown", () => {
    const { items, skipped } = parseGbvmAsm(
      "        VM_PROJECTILE_LOAD_TYPE 0, 0, ___bank_global_projectiles_9, _global_projectiles_9\n",
    );
    expect(items).toEqual([]);
    expect(skipped).toContain(
      "VM_PROJECTILE_LOAD_TYPE 0, 0, ___bank_global_projectiles_9, _global_projectiles_9",
    );
  });

  test("M6f: bridges VM_TIMER_SET / STOP / RESET to ops 0x71 / 0x72 / 0x73", () => {
    expect(parseGbvmAsm("        VM_TIMER_SET 1, 8\n").items).toEqual([
      { kind: "op", op: 0x71, operands: [1, 8] },
    ]);
    expect(parseGbvmAsm("        VM_TIMER_STOP 1\n").items).toEqual([
      { kind: "op", op: 0x72, operands: [1] },
    ]);
    expect(parseGbvmAsm("        VM_TIMER_RESET 1\n").items).toEqual([
      { kind: "op", op: 0x73, operands: [1] },
    ]);
  });

  test("M6f: bridges VM_TIMER_PREPARE to op 0x70 with a script ptr operand", () => {
    const { items } = parseGbvmAsm(
      "        VM_TIMER_PREPARE 1, ___bank_tmr, _tmr\n",
    );
    expect(items.find((i) => i.kind === "op" && i.op === 0x70)).toEqual({
      kind: "op",
      op: 0x70,
      operands: [1, 0, { label: "_tmr" }],
    });
  });

  test("drops VM_RANDOMIZE (no GBA equivalent) and reports it skipped", () => {
    const { items, skipped } = parseGbvmAsm("        VM_RANDOMIZE\n");
    expect(items).toEqual([]);
    expect(skipped).toContain("VM_RANDOMIZE");
  });

  test("M4: VM_LOAD_TEXT + VM_DISPLAY_TEXT -> op 0x90 with the captured inline text", () => {
    const { items, skipped } = parseGbvmAsm(
      [
        "        VM_OVERLAY_MOVE_TO 0, 14, .OVERLAY_IN_SPEED",
        "        VM_LOAD_TEXT 0",
        '        .asciz "Hello, GBA Studio!"',
        "        VM_DISPLAY_TEXT",
        "        VM_OVERLAY_WAIT .UI_MODAL, ^/(.UI_WAIT_WINDOW | .UI_WAIT_TEXT | .UI_WAIT_BTN_A)/",
        "        VM_OVERLAY_HIDE",
        "",
      ].join("\n"),
    );
    // VM_DISPLAY_TEXT emits op 0x90 + the captured text + a null terminator; the
    // overlay window ops bracket it (M4d), and VM_OVERLAY_WAIT is bridged to op 0x94
    // with [modal, condition] (M4q: the A-wait now lives here, not in the text op).
    const raw = items.find((i) => i.kind === "raw") as {
      kind: "raw";
      bytes: number[];
    };
    expect(raw.bytes[0]).toBe(0x90);
    expect(raw.bytes[1]).toBe(0xff); // avatar byte (none)
    expect(raw.bytes[2]).toBe(0); // var count (no interpolation)
    expect(raw.bytes[raw.bytes.length - 1]).toBe(0);
    expect(String.fromCharCode(...raw.bytes.slice(3, -1))).toBe(
      "Hello, GBA Studio!",
    );
    const wait = items.find((i) => i.kind === "op" && i.op === 0x94) as
      | { kind: "op"; op: number; operands: number[] }
      | undefined;
    expect(wait?.operands).toEqual([1, 1 | 2 | 4]); // modal=1, condition = WINDOW|TEXT|BTN_A
    expect(skipped).not.toContain("VM_DISPLAY_TEXT");
    expect(skipped).not.toContain("VM_LOAD_TEXT 0");
  });

  test("M4q: VM_DISPLAY_TEXT_EX -> op 0x95 with the preserve-pos flag + inline text", () => {
    const { items } = parseGbvmAsm(
      [
        "        VM_LOAD_TEXT 0",
        '        .asciz "World"',
        "        VM_DISPLAY_TEXT_EX .DISPLAY_PRESERVE_POS, .TEXT_TILE_CONTINUE",
        "",
      ].join("\n"),
    );
    const raw = items.find((i) => i.kind === "raw") as {
      kind: "raw";
      bytes: number[];
    };
    expect(raw.bytes[0]).toBe(0x95);
    expect(raw.bytes[1]).toBe(1); // .DISPLAY_PRESERVE_POS (append)
    expect(raw.bytes[2]).toBe(0xff); // avatar none
    expect(raw.bytes[3]).toBe(0); // var count
    expect(String.fromCharCode(...raw.bytes.slice(4, -1))).toBe("World");
  });

  test("M4d: bridges the dialogue overlay window ops (MOVE_TO / SHOW / HIDE)", () => {
    const { items, skipped } = parseGbvmAsm(
      [
        "        VM_OVERLAY_MOVE_TO 0, 18, .OVERLAY_SPEED_INSTANT",
        "        VM_OVERLAY_MOVE_TO 0, 14, .OVERLAY_IN_SPEED",
        "        VM_OVERLAY_SHOW 0, 14, .UI_COLOR_WHITE, .UI_DRAW_FRAME",
        "        VM_OVERLAY_HIDE",
        "",
      ].join("\n"),
    );
    expect(items).toEqual([
      { kind: "op", op: 0x91, operands: [0, 18, -3] }, // snap off-screen (row 18)
      { kind: "op", op: 0x91, operands: [0, 14, -1] }, // slide up to row 14
      { kind: "op", op: 0x92, operands: [0, 14, 1, 1] }, // show white framed box
      { kind: "op", op: 0x93, operands: [] }, // hide
    ]);
    expect(skipped).toEqual([]);
    // Speed -1 / -3 encode as signed bytes (0xff / 0xfd) in the emitted stream.
    const { bytes } = emitGbaBytecode(items);
    expect(bytes.slice(0, 4)).toEqual([0x91, 0x00, 0x12, 0xfd]);
  });

  test("M12c: VM_LOAD_PALETTE bridges mask/options + inline CGB_PAL rows as RGB555", () => {
    const { items, skipped } = parseGbvmAsm(
      [
        "        VM_LOAD_PALETTE 5, .PALETTE_COMMIT | .PALETTE_BKG",
        "        .CGB_PAL 31,0,0 0,31,0 0,0,31 31,31,31",
        "        .CGB_PAL 1,2,3 4,5,6 7,8,9 10,11,12",
        "",
      ].join("\n"),
    );
    expect(items).toEqual([
      { kind: "op", op: 0x7c, operands: [5, 3] }, // banks 0+2, commit|bkg
      // red, green, blue, white as little-endian RGB555 words
      { kind: "raw", bytes: [0x1f, 0x00, 0xe0, 0x03, 0x00, 0x7c, 0xff, 0x7f] },
      {
        kind: "raw",
        bytes: [0x41, 0x0c, 0xa4, 0x18, 0x07, 0x25, 0x6a, 0x31],
      },
    ]);
    expect(skipped).toEqual([]);
  });

  test("M11d: overlay colour + frame options ride SHOW/CLEAR (black cover = color 0, options 0)", () => {
    // The "Show Overlay" event's black screen cover: color .UI_COLOR_BLACK,
    // options literal 0 (the compiler never draws a frame on a cover).
    const { items, skipped } = parseGbvmAsm(
      [
        "        VM_OVERLAY_SHOW 0, 0, .UI_COLOR_BLACK, 0",
        "        VM_OVERLAY_CLEAR 0, 0, 20, 4, .UI_COLOR_WHITE, .UI_AUTO_SCROLL | .UI_DRAW_FRAME",
        "        VM_OVERLAY_CLEAR 0, 0, 20, 4, .UI_COLOR_WHITE, .UI_AUTO_SCROLL",
        "",
      ].join("\n"),
    );
    expect(items).toEqual([
      { kind: "op", op: 0x92, operands: [0, 0, 0, 0] }, // full-screen black, no frame
      { kind: "op", op: 0x96, operands: [0, 0, 20, 4, 1, 3] }, // white framed box
      { kind: "op", op: 0x96, operands: [0, 0, 20, 4, 1, 2] }, // white frameless box
    ]);
    expect(skipped).toEqual([]);
  });

  test("M4f: VM_DISPLAY_TEXT keeps newlines (multi-line) and control-code params intact", () => {
    const { items } = parseGbvmAsm(
      [
        "        VM_LOAD_TEXT 0",
        // \012 = newline, \003\041\041 = goto with two printable-range params. The
        // goto is kept INLINE since M11a (the engine indents the line); its param
        // bytes must travel with the code, not leak as "!!" glyphs.
        '        .asciz "Line one\\012\\003\\041\\041Line two"',
        "        VM_DISPLAY_TEXT",
        "",
      ].join("\n"),
    );
    const raw = items.find((i) => i.kind === "raw") as {
      kind: "raw";
      bytes: number[];
    };
    expect(raw.bytes[0]).toBe(0x90);
    const text = raw.bytes.slice(3, -1); // strip op + avatar + var-count + null
    expect(String.fromCharCode(...text)).toBe(
      "Line one\n\x03\x21\x21Line two", // newline kept, goto inline w/ params
    );
    expect(text).toContain(0x0a); // the newline byte survives
    // \004 goto-rel is still dropped with its params.
    const rel = parseGbvmAsm(
      [
        "        VM_LOAD_TEXT 0",
        '        .asciz "A\\004\\041\\041B"',
        "        VM_DISPLAY_TEXT",
        "",
      ].join("\n"),
    ).items.find((i) => i.kind === "raw") as { kind: "raw"; bytes: number[] };
    expect(String.fromCharCode(...rel.bytes.slice(3, -1))).toBe("AB");
  });

  test("M4g/M4p: VM_DISPLAY_TEXT keeps the set-speed (\\001) and set-font (\\002) codes inline", () => {
    const { items } = parseGbvmAsm(
      [
        "        VM_LOAD_TEXT 0",
        // \001\006 = set speed 5 (param speed+1=6); \002\001 = set font 0 (kept, M4p).
        '        .asciz "\\001\\006Hi\\002\\001!"',
        "        VM_DISPLAY_TEXT",
        "",
      ].join("\n"),
    );
    const raw = items.find((i) => i.kind === "raw") as {
      kind: "raw";
      bytes: number[];
    };
    const text = raw.bytes.slice(3, -1); // strip op + avatar + var-count + null
    // Both the speed code and the font code survive inline with their params (M4p).
    expect(Array.from(text)).toEqual([
      0x01, 0x06, 0x48, 0x69, 0x02, 0x01, 0x21,
    ]);
  });

  test("M4h: parseGameGlobals reads VAR_ = index defines (ignoring comments/junk)", () => {
    const globals = parseGameGlobals(
      [
        "VAR_SCORE = 0",
        "VAR_LIVES = 1 ; a comment",
        "MAX_GLOBAL_VARS = 2",
        '.include "foo.i"', // not a define
        "",
      ].join("\n"),
    );
    expect(globals).toEqual({ VAR_SCORE: 0, VAR_LIVES: 1, MAX_GLOBAL_VARS: 2 });
  });

  test("M4h: resolves VAR_ operands from the globals map (Set/If Variable)", () => {
    const globals = { VAR_SCORE: 3, VAR_LIVES: 7 };
    // VM_SET_CONST VAR_SCORE, 5 -> op 0x14 with idx 3; VM_IF_CONST .EQ, VAR_LIVES, 0
    const { items } = parseGbvmAsm(
      "        VM_SET_CONST VAR_SCORE, 5\n" +
        "        VM_IF_CONST .EQ, VAR_LIVES, 0, 1$, 0\n" +
        "1$:\n",
      { globals },
    );
    expect(items[0]).toEqual({ kind: "op", op: 0x14, operands: [3, 5] });
    expect(items[1]).toEqual({
      kind: "op",
      op: 0x1a,
      operands: [1 /* .EQ */, 7, 0, { label: "1$" }, 0],
    });
  });

  test("M4i: VM_LOAD_TEXT N + .dw vars -> op 0x90 with var count + indices + %d text", () => {
    const { items } = parseGbvmAsm(
      [
        "        VM_LOAD_TEXT 1",
        "        .dw VAR_SCORE",
        '        .asciz "Score: %d!"',
        "        VM_DISPLAY_TEXT",
        "",
      ].join("\n"),
      { globals: { VAR_SCORE: 5 } },
    );
    const raw = items.find((i) => i.kind === "raw") as {
      kind: "raw";
      bytes: number[];
    };
    // [0x90, avatar=0xff, nVars=1, idxLo=5, idxHi=0, "Score: %d!", 0]
    expect(raw.bytes.slice(0, 5)).toEqual([0x90, 0xff, 1, 5, 0]);
    expect(raw.bytes[raw.bytes.length - 1]).toBe(0);
    expect(String.fromCharCode(...raw.bytes.slice(5, -1))).toBe("Score: %d!");
  });

  test("M4l: strips a leading dialogue avatar font-glyph code (no garbage chars)", () => {
    // The real 16-byte avatar code from GB Studio (avatar 0): setSpeed0 \001\001,
    // setFont \002\002, chars \100\101 \012 \102\103, setSpeed2 \001\003, gotoRel
    // \004\001\377, setFont0 \002\001, then "Hi".
    const { items } = parseGbvmAsm(
      [
        "        VM_LOAD_TEXT 0",
        '        .asciz "\\001\\001\\002\\002\\100\\101\\012\\102\\103\\001\\003\\004\\001\\377\\002\\001Hi"',
        "        VM_DISPLAY_TEXT",
        "",
      ].join("\n"),
    );
    const raw = items.find((i) => i.kind === "raw") as {
      kind: "raw";
      bytes: number[];
    };
    // [0x90, avatar=0, nVars=0, "Hi", 0] - the avatar code (incl. its @ABC glyph
    // chars) is gone, and the avatar index (0) rides in the payload's avatar byte.
    expect(raw.bytes[1]).toBe(0); // avatar 0
    expect(raw.bytes[2]).toBe(0); // no vars
    expect(String.fromCharCode(...raw.bytes.slice(3, -1))).toBe("Hi");
  });

  // VM_SWITCH is unique: the macro is followed by SIZE `.dw value, label` case
  // lines (GB Studio's _switch emits one `_dw` per case). The parser collects
  // them into a single switch item with a relocatable jump table.
  test("parses VM_SWITCH + its .dw case table into one switch item", () => {
    const asm = `
        VM_SWITCH .ARG0, 3, 0
        .dw 1, 1$
        .dw 2, 2$
        .dw 3, 3$
1$:
        VM_IDLE
2$:
        VM_IDLE
3$:
        VM_STOP
`;
    const { items } = parseGbvmAsm(asm);
    expect(items.find((i) => i.kind === "switch")).toEqual({
      kind: "switch",
      operands: [-1, 3, 0],
      cases: [
        { value: 1, target: { label: "1$" } },
        { value: 2, target: { label: "2$" } },
        { value: 3, target: { label: "3$" } },
      ],
    });
    // 5-byte header (op + i16 idx + u8 size + u8 n) then 3 relocated case entries.
    const { bytes, relocations } = emitGbaBytecode(items);
    expect(bytes.slice(0, 5)).toEqual([0x08, 0xff, 0xff, 0x03, 0x00]);
    expect(relocations.length).toBe(3);
  });

  test("throws on an incomplete VM_SWITCH case table", () => {
    // Declares 2 cases but only one .dw follows before end-of-input.
    expect(() =>
      parseGbvmAsm("        VM_SWITCH .ARG0, 2, 0\n        .dw 1, 1$\n"),
    ).toThrow(/Incomplete VM_SWITCH case table/);
  });

  // The remaining P0 control-flow opcodes reference symbols OUTSIDE the blob:
  // VM_BEGINTHREAD -> another script proc, VM_INVOKE/VM_CALL_NATIVE -> a native
  // engine fn, VM_GET_FAR -> far data. The encoding is bridged (P0); resolving the
  // target is P1. The `___bank_*` bank symbol folds to 0 (GBA is flat, no banking).
  test("bridges VM_BEGINTHREAD encoding (bank symbol folds to 0; proc is a ptr label)", () => {
    const { items } = parseGbvmAsm(
      "        VM_BEGINTHREAD ___bank_my_thread, _my_thread, .ARG0, 0\n",
    );
    expect(items).toEqual([
      {
        kind: "op",
        op: 0x0e,
        operands: [0, { label: "_my_thread" }, -1, 0],
      },
    ]);
  });

  test("bridges VM_INVOKE / VM_CALL_NATIVE / VM_GET_FAR encodings", () => {
    expect(
      parseGbvmAsm("        VM_INVOKE ___bank_wait, _wait_frames, 1, .ARG0\n")
        .items,
    ).toEqual([
      { kind: "op", op: 0x0d, operands: [0, { label: "_wait_frames" }, 1, -1] },
    ]);
    expect(
      parseGbvmAsm("        VM_CALL_NATIVE ___bank_fn, _native_fn\n").items,
    ).toEqual([
      { kind: "op", op: 0x2d, operands: [0, { label: "_native_fn" }] },
    ]);
    // VM_GET_FAR IDX, SIZE, BANK, ADDR
    expect(
      parseGbvmAsm(
        "        VM_GET_FAR .ARG0, .GET_WORD, ___bank_data, _far_data\n",
      ).items,
    ).toEqual([
      { kind: "op", op: 0x06, operands: [-1, 1, 0, { label: "_far_data" }] },
    ]);
  });

  test("expands VM_SET_CONST_INT8 to an RPN raw-memory write with an engine-symbol reloc", () => {
    const { items } = parseGbvmAsm(
      "        VM_SET_CONST_INT8 _fade_frames_per_step, 1\n",
    );
    // RPN: R_INT8 1 (0xff,0x01), R_REF_MEM_SET MEM_I8 (0xf8,0x69), addr(4b @4), STOP.
    expect(items).toEqual([
      {
        kind: "rpn",
        bytes: [0xff, 0x01, 0xf8, 0x69, 0, 0, 0, 0, 0x00],
        relocs: [{ at: 4, symbol: "_fade_frames_per_step" }],
      },
    ]);
  });

  test("bridges the operand-less scene-stack opcodes (push/pop/pop_all)", () => {
    const { items } = parseGbvmAsm(
      "        VM_SCENE_PUSH\n        VM_SCENE_POP\n        VM_SCENE_POP_ALL\n",
    );
    expect(items).toEqual([
      { kind: "op", op: 0x68, operands: [] },
      { kind: "op", op: 0x69, operands: [] },
      { kind: "op", op: 0x6a, operands: [] },
    ]);
  });

  test("bridges VM_RAISE EXCEPTION_CHANGE_SCENE + IMPORT_FAR_PTR_DATA to a scene index", () => {
    const { items, skipped } = parseGbvmAsm(
      "        VM_RAISE EXCEPTION_CHANGE_SCENE, 3\n" +
        "            IMPORT_FAR_PTR_DATA _scene_second\n",
      { sceneIndex: (sym) => (sym === "_scene_second" ? 1 : undefined) },
    );
    expect(items).toEqual([
      { kind: "op", op: 0x27, operands: [2, 2] }, // VM_RAISE code=2 (CHANGE_SCENE), size=2
      { kind: "raw", bytes: [1, 0] }, // scene index 1 (little-endian), patched in place
    ]);
    expect(skipped).toEqual([]);
  });

  test("emitting an external symbol records it as a symbolic relocation (M1 linker resolves it)", () => {
    const { items } = parseGbvmAsm(
      "        VM_BEGINTHREAD ___bank_my_thread, _my_thread, .ARG0, 0\n",
    );
    const { symRelocs, relocations } = emitGbaBytecode(items);
    // BEGINTHREAD: op + bank(u8) => the proc ptr field starts at byte offset 2.
    expect(symRelocs).toEqual([{ at: 2, symbol: "_my_thread", kind: "code" }]);
    expect(relocations).toEqual([]);
  });
});
