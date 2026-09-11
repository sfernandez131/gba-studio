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
      /"VM_TOTALLY_MADE_UP" is not bridged to the GBA target yet/,
    );
  });

  // Macros describing hardware the GBA does not have. These are not a to-do
  // list, and the two kinds must behave differently: one would produce a ROM
  // that is silently wrong, the other only loses something the GBA never had.
  describe("hardware the GBA does not have", () => {
    test("inline Z80 assembly fails the build and says why", () => {
      expect(() => parseGbvmAsm("        VM_ASM\n")).toThrow(
        /cannot be supported on the Game Boy Advance/,
      );
      expect(() => parseGbvmAsm("        VM_ASM\n")).toThrow(
        /Z80.*cannot run on the GBA's ARM processor/,
      );
    });

    test("the error names an action, not just a refusal", () => {
      expect(() => parseGbvmAsm("        VM_ENDASM\n")).toThrow(
        /Remove the event that uses it, or keep that project on the GB target/,
      );
    });

    // A Super Game Boy border is absent by design on GBA: the game itself is
    // unaffected, so refusing to build would be worse than dropping it.
    test("Super Game Boy transfers are dropped with a note, not fatal", () => {
      const { items, skipped } = parseGbvmAsm(
        "        VM_SGB_TRANSFER         _sgb_packet\n",
      );
      expect(items).toEqual([]);
      expect(skipped).toEqual([
        expect.stringContaining("VM_SGB_TRANSFER (not applicable on GBA:"),
      ]);
      expect(skipped[0]).toMatch(/Super Game Boy does not exist/);
    });
  });

  // Replace Tile at XY (matrix slice B) - the most-used unbridged macro in the
  // stock gbs2 sample (104 uses), so its operand handling is worth pinning down.
  describe("VM_REPLACE_TILE_XY", () => {
    test("drops the GB bank and keeps the tile index as a variable", () => {
      const { items } = parseGbvmAsm(
        "        VM_REPLACE_TILE_XY 3, 5, 255, _tileset_grass, .ARG0\n",
        { dataSymbols: { ["_tileset_grass"]: 2 } },
      );
      // x, y, tileset index (from dataSymbols), tile-index VARIABLE (.ARG0 = -1).
      expect(items).toEqual([
        { kind: "op", op: 0x9c, operands: [3, 5, 2, -1] },
      ]);
    });

    // A project can reference art the eject did not emit; that should cost the
    // one event, not the whole build.
    test("drops with a note when the tileset symbol is unknown", () => {
      const { items, skipped } = parseGbvmAsm(
        "        VM_REPLACE_TILE_XY 0, 0, 255, _tileset_missing, .ARG0\n",
      );
      expect(items).toEqual([]);
      expect(skipped.length).toBe(1);
    });
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

  test("M8d: bridges VM_SET_BG_TRANSFORM to op 0x97 (affine angle, scale)", () => {
    const { items, skipped } = parseGbvmAsm(
      "        VM_SET_BG_TRANSFORM 45, 512\n",
    );
    expect(items).toEqual([{ kind: "op", op: 0x97, operands: [45, 512] }]);
    expect(skipped).toEqual([]);
  });

  test("M8d: bridges VM_SET_BG_SPIN to op 0x98 (affine spin velocity)", () => {
    const { items, skipped } = parseGbvmAsm("        VM_SET_BG_SPIN 512\n");
    expect(items).toEqual([{ kind: "op", op: 0x98, operands: [512] }]);
    expect(skipped).toEqual([]);
    // Negative velocity (spin the other way) survives as a two's-complement i16.
    expect(parseGbvmAsm("        VM_SET_BG_SPIN -512\n").items).toEqual([
      { kind: "op", op: 0x98, operands: [-512] },
    ]);
  });

  test("M8d: bridges VM_SET_BG_ANGLE_VAR to op 0x99 resolving the variable index", () => {
    const { items, skipped } = parseGbvmAsm(
      "        VM_SET_BG_ANGLE_VAR VAR_ANGLE\n",
      { globals: { VAR_ANGLE: 7 } },
    );
    // The operand is the variable's script_memory index (7), not an immediate.
    expect(items).toEqual([{ kind: "op", op: 0x99, operands: [7] }]);
    expect(skipped).toEqual([]);
  });

  test("M8d: bridges VM_SET_BG_SCALE_VAR to op 0x9a resolving the variable index", () => {
    const { items, skipped } = parseGbvmAsm(
      "        VM_SET_BG_SCALE_VAR VAR_ZOOM\n",
      { globals: { VAR_ZOOM: 4 } },
    );
    expect(items).toEqual([{ kind: "op", op: 0x9a, operands: [4] }]);
    expect(skipped).toEqual([]);
  });

  test("M8e: bridges VM_USER_CODE to op 0x9b resolving the snippet symbol", () => {
    const { items, skipped } = parseGbvmAsm(
      "        VM_USER_CODE _gba_user_abc123\n",
      { dataSymbols: { ["_gba_user_abc123"]: 2 } },
    );
    // The operand resolves to the eject-assigned snippet index (2), not a literal.
    expect(items).toEqual([{ kind: "op", op: 0x9b, operands: [2] }]);
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

  // Music callbacks (matrix slice G) - one real bridge, one honest drop.
  describe("music callbacks (slice G)", () => {
    test("VM_MUSIC_SETPOS keeps GB's opcode and its pattern, row operands", () => {
      const { items } = parseGbvmAsm("        VM_MUSIC_SETPOS 3, 16\n");
      expect(items).toEqual([{ kind: "op", op: 0x67, operands: [3, 16] }]);
      const { bytes } = emitGbaBytecode(items);
      expect(Array.from(bytes)).toEqual([0x67, 0x03, 0x10]);
    });

    // The events these attach to come from hUGEDriver's routine effect in .uge pattern
    // data, and gbavm cannot play .uge tracks at all yet - so nothing would ever fire.
    test("VM_MUSIC_ROUTINE is dropped with a note rather than bridged", () => {
      const { items, skipped } = parseGbvmAsm(
        "        VM_MUSIC_ROUTINE 0, ___bank_rtn, _rtn\n",
      );
      expect(items).toEqual([]);
      expect(skipped[0]).toMatch(/^VM_MUSIC_ROUTINE/);
    });
  });

  // Overlay window family (matrix slice F2).
  describe("overlay window (slice F2)", () => {
    test("VM_OVERLAY_SETPOS becomes an instant OVERLAY_MOVE_TO", () => {
      const { items } = parseGbvmAsm("        VM_OVERLAY_SETPOS 3, 14\n");
      // -3 is .OVERLAY_SPEED_INSTANT: place the window rather than slide it.
      expect(items).toEqual([{ kind: "op", op: 0x91, operands: [3, 14, -3] }]);
    });

    // These copy tiles into GB's window TILEMAP, which gbavm's drawn-panel overlay does
    // not have. Dropping them costs the scene-behind-the-window effect, not the game -
    // and it makes them consistent with the _EX / _TILES siblings already skipped.
    test("the tilemap-copy forms are skipped, not fatal", () => {
      for (const asm of [
        "        VM_OVERLAY_SET_MAP 0, 0, 0, 4, 4\n",
        "        VM_OVERLAY_SET_SUBMAP 0, 0, 4, 4, 2, 2\n",
      ]) {
        const { items, skipped } = parseGbvmAsm(asm);
        expect(items).toEqual([]);
        expect(skipped).toHaveLength(1);
      }
    });
  });

  // Engine-symbol reads (matrix slice F). VM_GET_*INT8 used to accept only the joypad
  // and throw for everything else, which took out more than it looked: "If Device GBA"
  // reads _is_GBA this way and the GB Printer codegen reads _is_CGB before anything else.
  describe("engine-symbol reads (slice F)", () => {
    test("still retargets the joypad read to VM_INPUT_GET", () => {
      const { items } = parseGbvmAsm(
        "        VM_GET_UINT8 .ARG0, ^/(_joypads + 1)/\n",
      );
      expect(items).toEqual([{ kind: "op", op: 0x54, operands: [0, -1] }]);
    });

    test("reads any other engine symbol instead of failing the build", () => {
      const { items } = parseGbvmAsm("        VM_GET_UINT8 .ARG0, __is_GBA\n");
      expect(items).toHaveLength(1);
      const item = items[0];
      if (item.kind !== "rpn") throw new Error("expected an RPN read");
      // The 32-bit address is a relocation the linker resolves to the engine var.
      expect(item.relocs).toEqual([{ at: 2, symbol: "__is_GBA" }]);
      // raw-memory read of .MEM_U8, then REF_SET into .ARG0.
      expect(item.bytes.slice(0, 2)).toEqual([0xf9, 0x75]);
    });

    test("still reports a missing source rather than reading nothing", () => {
      expect(() => parseGbvmAsm("        VM_GET_UINT8 .ARG0\n")).toThrow(
        /missing its source address/,
      );
    });
  });

  // The GB Printer (matrix slice F). There is no printer on GBA, and GB Studio's own
  // codegen branches on the detect result - so reporting "no printer" is what makes a
  // Print event behave correctly rather than claiming a print succeeded.
  describe("GB Printer (slice F)", () => {
    test("VM_PRINTER_DETECT reports the missing-printer status", () => {
      const { items } = parseGbvmAsm("        VM_PRINTER_DETECT .ARG0, 30\n");
      // 0xF0 is gbvm's PRN_STATUS_MASK_ERRORS - what printer_wait() returns on timeout.
      expect(items).toEqual([{ kind: "op", op: 0x14, operands: [-1, 0xf0] }]);
    });

    test("VM_PRINT_OVERLAY is dropped as not-applicable, not fatal", () => {
      const { items, skipped } = parseGbvmAsm(
        "        VM_PRINT_OVERLAY .ARG0, 0, 4, 2\n",
      );
      expect(items).toEqual([]);
      expect(skipped[0]).toMatch(
        /Game Boy Printer cannot be connected to a GBA/,
      );
    });

    test("VM_SET_PRINT_DIR is skipped rather than silently inert", () => {
      const { items, skipped } = parseGbvmAsm(
        "        VM_SET_PRINT_DIR .UI_PRINT_RIGHTTOLEFT\n",
      );
      expect(items).toEqual([]);
      expect(skipped[0]).toMatch(/^VM_SET_PRINT_DIR/);
    });
  });

  // Camera control (matrix slice E). Both macros are renumbered: GB gives them 0x70/0x71,
  // which gbavm already spends on the timer ops.
  describe("camera control (slice E)", () => {
    test("bridges VM_CAMERA_MOVE_TO to 0x64 as ref, speed, after_lock", () => {
      const { items } = parseGbvmAsm(
        "        VM_CAMERA_MOVE_TO .ARG1, 32, .CAMERA_UNLOCK\n",
      );
      expect(items).toEqual([{ kind: "op", op: 0x64, operands: [-2, 32, 0] }]);
    });

    test("resolves the axis lock flags the codegen unions together", () => {
      const { items } = parseGbvmAsm(
        "        VM_CAMERA_MOVE_TO .ARG1, 8, ^/(.CAMERA_LOCK_X | .CAMERA_LOCK_Y)/\n",
      );
      // Bit 0 = lock X, bit 1 = lock Y; both set is GB's .CAMERA_LOCK.
      expect(items).toEqual([{ kind: "op", op: 0x64, operands: [-2, 8, 3] }]);
    });

    test("bridges VM_CAMERA_SET_POS to 0x65 with just the ref block", () => {
      const { items } = parseGbvmAsm("        VM_CAMERA_SET_POS .ARG1\n");
      expect(items).toEqual([{ kind: "op", op: 0x65, operands: [-2] }]);
      const { bytes } = emitGbaBytecode(items);
      expect(Array.from(bytes)).toEqual([0x65, 0xfe, 0xff]);
    });
  });

  // Actor animation control (matrix slice D). The FRAME ops carry GB's {ID, FRAME}
  // pseudo-struct as one stack ref, so the operand is a single index, not a pair.
  describe("actor animation control (slice D)", () => {
    test("bridges the frame ops to 0x75 / 0x83 with the ref block index", () => {
      expect(
        parseGbvmAsm(
          ".LOCAL_ACTOR = -4\n        VM_ACTOR_SET_ANIM_FRAME .LOCAL_ACTOR\n",
        ).items,
      ).toEqual([{ kind: "op", op: 0x75, operands: [-4] }]);
      expect(
        parseGbvmAsm("        VM_ACTOR_GET_ANIM_FRAME .ARG0\n").items,
      ).toEqual([{ kind: "op", op: 0x83, operands: [-1] }]);
    });

    // GB spends opcode 0x3D on SET_ANIM_TICK; gbavm already uses that number for
    // MOVE_CANCEL, so this one is deliberately renumbered.
    test("renumbers SET_ANIM_TICK to 0x43 and keeps ref, tick order", () => {
      const { items } = parseGbvmAsm(
        "        VM_ACTOR_SET_ANIM_TICK .ARG0, 15\n",
      );
      expect(items).toEqual([{ kind: "op", op: 0x43, operands: [-1, 15] }]);
      const { bytes } = emitGbaBytecode(items);
      // i16 ref (-1, little-endian) then the u8 tick MASK.
      expect(Array.from(bytes)).toEqual([0x43, 0xff, 0xff, 0x0f]);
    });

    test("bridges BEGIN_UPDATE to 0x8e and TERMINATE_UPDATE to 0x74", () => {
      expect(
        parseGbvmAsm("        VM_ACTOR_BEGIN_UPDATE .ARG0\n").items,
      ).toEqual([{ kind: "op", op: 0x8e, operands: [-1] }]);
      expect(
        parseGbvmAsm("        VM_ACTOR_TERMINATE_UPDATE .ARG0\n").items,
      ).toEqual([{ kind: "op", op: 0x74, operands: [-1] }]);
    });
  });

  describe("input attach/wait (slice C)", () => {
    test("bridges VM_CONTEXT_PREPARE to op 0x55 with a script ptr operand", () => {
      const { items } = parseGbvmAsm(
        "        VM_CONTEXT_PREPARE 3, ___bank_input_0, _input_0\n",
      );
      expect(items).toEqual([
        { kind: "op", op: 0x55, operands: [3, 0, { label: "_input_0" }] },
      ]);
    });

    test("bridges VM_INPUT_ATTACH to op 0x53 as mask, slot", () => {
      const { items } = parseGbvmAsm("        VM_INPUT_ATTACH 16, 4\n");
      expect(items).toEqual([{ kind: "op", op: 0x53, operands: [16, 4] }]);
    });

    test("resolves .OVERRIDE_DEFAULT into the attach slot operand", () => {
      const { items } = parseGbvmAsm(
        "        VM_INPUT_ATTACH 16, ^/(4 | .OVERRIDE_DEFAULT)/\n",
      );
      expect(items).toEqual([
        { kind: "op", op: 0x53, operands: [16, 4 | 0x80] },
      ]);
    });

    test("keeps the GBA-only L/R bits in the 16-bit attach mask", () => {
      // M8a put L/R at KEY_BITS 0x100/0x200; GB packs the mask into a byte, so the
      // GBA operand has to be a u16 or a shoulder-button attach would encode as 0.
      const { items } = parseGbvmAsm("        VM_INPUT_ATTACH 768, 1\n");
      expect(items).toEqual([{ kind: "op", op: 0x53, operands: [768, 1] }]);
    });

    test("bridges VM_INPUT_DETACH to op 0x5f and VM_INPUT_WAIT to op 0x52", () => {
      expect(parseGbvmAsm("        VM_INPUT_DETACH 16\n").items).toEqual([
        { kind: "op", op: 0x5f, operands: [16] },
      ]);
      expect(parseGbvmAsm("        VM_INPUT_WAIT 255\n").items).toEqual([
        { kind: "op", op: 0x52, operands: [255] },
      ]);
    });

    test("emits the attach mask as two bytes and the slot as one", () => {
      const { items } = parseGbvmAsm(
        "        VM_INPUT_ATTACH 768, ^/(1 | .OVERRIDE_DEFAULT)/\n",
      );
      const { bytes } = emitGbaBytecode(items);
      expect(Array.from(bytes)).toEqual([0x53, 0x00, 0x03, 0x81]);
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
