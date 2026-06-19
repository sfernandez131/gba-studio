import { parseGbvmAsm } from "./parseGbvmAsm";
import { emitGbaBytecode, GbaItem } from "./emitGbaBytecode";

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
          0xfe, 0x00, 0x0f, // INT16 3840
          0xfb, 0xfd, 0xff, // REF_SET (-4+1 = -3)
          0xfe, 0x00, 0x0a, // INT16 2560
          0xfb, 0xfe, 0xff, // REF_SET (-4+2 = -2)
          0x00, // STOP
        ],
      },
      { kind: "op", op: 0x14, operands: [-4, 1] }, // VM_SET_CONST
      { kind: "op", op: 0x35, operands: [-4] }, // VM_ACTOR_SET_POS
      { kind: "op", op: 0x18, operands: [] }, // VM_IDLE
      { kind: "op", op: 0x57, operands: [2] }, // VM_FADE_IN -> VM_FADE (no-op)
      { kind: "stop" }, // VM_STOP
    ]);

    // The engine-symbol write is intentionally dropped, and reported.
    expect(skipped).toEqual(["VM_SET_CONST_INT8 _fade_frames_per_step, 1"]);
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

  test("drops VM_RANDOMIZE (no GBA equivalent) and reports it skipped", () => {
    const { items, skipped } = parseGbvmAsm("        VM_RANDOMIZE\n");
    expect(items).toEqual([]);
    expect(skipped).toContain("VM_RANDOMIZE");
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
    expect(parseGbvmAsm("        VM_INVOKE ___bank_wait, _wait_frames, 1, .ARG0\n").items).toEqual([
      { kind: "op", op: 0x0d, operands: [0, { label: "_wait_frames" }, 1, -1] },
    ]);
    expect(parseGbvmAsm("        VM_CALL_NATIVE ___bank_fn, _native_fn\n").items).toEqual([
      { kind: "op", op: 0x2d, operands: [0, { label: "_native_fn" }] },
    ]);
    // VM_GET_FAR IDX, SIZE, BANK, ADDR
    expect(parseGbvmAsm("        VM_GET_FAR .ARG0, .GET_WORD, ___bank_data, _far_data\n").items).toEqual([
      { kind: "op", op: 0x06, operands: [-1, 1, 0, { label: "_far_data" }] },
    ]);
  });

  test("a standalone emit of a cross-proc symbol asks for whole-project linking", () => {
    const { items } = parseGbvmAsm(
      "        VM_BEGINTHREAD ___bank_my_thread, _my_thread, .ARG0, 0\n",
    );
    // Emitted on its own, _my_thread is in no blob; linkGbaImage is the real path.
    expect(() => emitGbaBytecode(items)).toThrow(
      /Unresolved script symbol "_my_thread".*linked/s,
    );
  });

  test("captures the proc entry symbol on ParseResult", () => {
    const { entrySymbol } = parseGbvmAsm(
      "_scene1_init::\n        VM_IDLE\n1$:\n        VM_STOP\n",
    );
    expect(entrySymbol).toBe("_scene1_init");
  });
});

// P2: scene-runtime opcodes — actor direction, the scene stack, and the
// change-scene raise (rewritten from the GB far-pointer to an inline scene index).
describe("parseGbvmAsm — P2 scene opcodes", () => {
  test("bridges VM_ACTOR_SET_DIR to op 0x32 [actor, dir]", () => {
    const { items } = parseGbvmAsm("        VM_ACTOR_SET_DIR .ARG0, .DIR_RIGHT\n");
    expect(items).toEqual([{ kind: "op", op: 0x32, operands: [-1, 1] }]);
  });

  test("bridges the zero-operand scene-stack opcodes", () => {
    const { items } = parseGbvmAsm(
      "        VM_SCENE_PUSH\n        VM_SCENE_POP\n        VM_SCENE_POP_ALL\n        VM_SCENE_STACK_RESET\n",
    );
    expect(items).toEqual([
      { kind: "op", op: 0x68, operands: [] },
      { kind: "op", op: 0x69, operands: [] },
      { kind: "op", op: 0x6a, operands: [] },
      { kind: "op", op: 0x6b, operands: [] },
    ]);
  });

  test("rewrites the change-scene raise+far-ptr pair into an inline scene index", () => {
    // The exact sequence sceneSwitchUsingScriptValues emits (scriptBuilder.ts).
    const asm = `
        VM_ACTOR_SET_DIR .ARG0, .DIR_DOWN
        VM_SET_CONST_INT8 _camera_settings, 1
        VM_RAISE EXCEPTION_CHANGE_SCENE, 3
        IMPORT_FAR_PTR_DATA _scene_2
`;
    const { items, skipped } = parseGbvmAsm(asm, undefined, { _scene_2: 1 });
    expect(items).toEqual([
      { kind: "op", op: 0x32, operands: [-1, 0] }, // SET_DIR .ARG0, DOWN
      { kind: "changeScene", sceneIndex: 1 },
    ]);
    // the camera_settings engine write is dropped (SKIP_MACROS), reported.
    expect(skipped.some((s) => s.startsWith("VM_SET_CONST_INT8"))).toBe(true);
  });

  test("encodes a changeScene item as RAISE(2) + size 2 + LE scene index", () => {
    const { bytes, relocations } = emitGbaBytecode([
      { kind: "changeScene", sceneIndex: 1 },
    ]);
    expect(bytes).toEqual([0x27, 0x02, 0x02, 0x01, 0x00]);
    expect(relocations).toEqual([]); // index is inline, never a reloc target
  });

  test("drops a non-scene IMPORT_FAR_PTR_DATA (e.g. a font) with a note", () => {
    const { items, skipped } = parseGbvmAsm("        IMPORT_FAR_PTR_DATA _font_0\n");
    expect(items).toEqual([]);
    expect(skipped).toContain("IMPORT_FAR_PTR_DATA _font_0");
  });

  test("throws if a change-scene raise has no following far-ptr", () => {
    expect(() =>
      parseGbvmAsm("        VM_RAISE EXCEPTION_CHANGE_SCENE, 3\n", undefined, {}),
    ).toThrow(/EXCEPTION_CHANGE_SCENE not followed by IMPORT_FAR_PTR_DATA/);
  });

  test("a non-change-scene VM_RAISE still encodes via the generic path", () => {
    const { items } = parseGbvmAsm("        VM_RAISE EXCEPTION_RESET, 0\n");
    expect(items).toEqual([{ kind: "op", op: 0x27, operands: [1, 0] }]);
  });
});

// P3: dialogue/text — VM_LOAD_TEXT carries its string INLINE as a trailing .asciz,
// so the bridge must parse + lay the string bytes into the image (byte contract).
describe("parseGbvmAsm — P3 text", () => {
  test("parses VM_LOAD_TEXT + inline .asciz into loadText + bytes items", () => {
    const { items } = parseGbvmAsm(
      '        VM_LOAD_TEXT 0\n        .asciz "Hi"\n        VM_DISPLAY_TEXT\n',
    );
    expect(items).toEqual([
      { kind: "loadText", nargs: 0, vars: [] },
      { kind: "bytes", data: [0x48, 0x69, 0x00] }, // "Hi\0"
      { kind: "op", op: 0x41, operands: [0, 0xff] }, // DISPLAY_TEXT_EX default, continue
    ]);
  });

  test("octal-unescapes control codes in the .asciz body", () => {
    // \001 speed, \004 gotoxy-rel, \012 newline (all 3-digit octal in the source).
    const { items } = parseGbvmAsm(
      '        VM_LOAD_TEXT 0\n        .asciz "A\\001\\004B\\012C"\n',
    );
    const bytes = items.find((i) => i.kind === "bytes");
    expect(bytes).toEqual({
      kind: "bytes",
      data: [0x41, 0x01, 0x04, 0x42, 0x0a, 0x43, 0x00],
    });
  });

  test("bridges the overlay/font/text-layer opcodes (signature order)", () => {
    const { items } = parseGbvmAsm(
      "        VM_OVERLAY_MOVE_TO 0, 18, .OVERLAY_SPEED_INSTANT\n" +
        "        VM_OVERLAY_WAIT .UI_MODAL, .UI_WAIT_BTN_A\n" +
        "        VM_SWITCH_TEXT_LAYER .TEXT_LAYER_WIN\n" +
        "        VM_SET_FONT 0\n" +
        "        VM_OVERLAY_HIDE\n",
    );
    expect(items).toEqual([
      { kind: "op", op: 0x45, operands: [0, 18, -3] },
      { kind: "op", op: 0x44, operands: [1, 4] },
      { kind: "op", op: 0x85, operands: [1] },
      { kind: "op", op: 0x4b, operands: [0] },
      { kind: "op", op: 0x42, operands: [0, 0x12] }, // HIDE -> SETPOS 0, MENU_CLOSED_Y
    ]);
  });

  test("VM_CHOICE is rejected with a clear later-phase message", () => {
    expect(() => parseGbvmAsm("        VM_CHOICE .ARG0, 2\n")).toThrow(
      /later phase/,
    );
  });

  test("a font IMPORT_FAR_PTR_DATA is recognized (not warned) given the registry", () => {
    const { items, skipped } = parseGbvmAsm(
      "        IMPORT_FAR_PTR_DATA _font_0\n",
      undefined,
      undefined,
      { _font_0: 0 },
    );
    expect(items).toEqual([]);
    expect(skipped).toEqual([]); // recognized as a font, no "deferred" note
  });
});

describe("emitGbaBytecode — P3 text byte contract", () => {
  test("encodes loadText + bytes inline with exact PC-length agreement", () => {
    const items: GbaItem[] = [
      { kind: "loadText", nargs: 0, vars: [] },
      { kind: "bytes", data: [0x48, 0x69, 0x00] }, // "Hi\0"
      { kind: "label", name: "after" },
      { kind: "op", op: 0x18, operands: [] }, // IDLE — must land at offset 5
    ];
    const { bytes, relocations } = emitGbaBytecode(items);
    // 0x40, nargs=0, then "Hi\0" = 5 bytes, then IDLE.
    expect(bytes).toEqual([0x40, 0x00, 0x48, 0x69, 0x00, 0x18]);
    expect(relocations).toEqual([]); // inline string adds no relocations
  });

  test("loadText with nargs emits the i16 var indices before the string", () => {
    const { bytes } = emitGbaBytecode([
      { kind: "loadText", nargs: 1, vars: [-1] }, // one var, .ARG0
      { kind: "bytes", data: [0x25, 0x64, 0x00] }, // "%d\0"
    ]);
    // 0x40, nargs=1, var -1 (0xFFFF LE), then "%d\0"
    expect(bytes).toEqual([0x40, 0x01, 0xff, 0xff, 0x25, 0x64, 0x00]);
  });
});
