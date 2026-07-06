// GBA Studio - GBA bytecode emitter (Milestone M1).
//
// Serializes a GBVM opcode stream into the byte layout the ported gbavm engine's
// VM_STEP expects (see D:/source/gbavm/src/vm.c): little-endian operands, and
// 32-bit native pointers for code targets (jump/call/loop/if labels).
//
// GB Studio's GB path defers byte encoding to the SDCC assembler via the vm.i
// macros (which emit big-endian, reversed-order, 16-bit operands). The GBA engine
// has no assembler, so this module performs the encoding directly. Code targets
// can't be known until the bytecode blob is placed in ROM, so each is emitted as a
// 4-byte placeholder plus a relocation entry; the engine patches them to real
// pointers at load time (generalizing the single hand-patched jump in gbavm's
// current main.cpp).

export type GbaOperandType = "u8" | "i8" | "u16" | "i16" | "ptr";

// Fixed operand layout per opcode, in the order gbavm's VM_STEP reads them.
// "ptr" = a 32-bit code target (a label) -> emitted as a 4-byte relocation.
// Covers the opcodes the engine implements today (system + control flow + the
// initial hardware ops); more are added here as the engine gains handlers.
export const GBA_OPCODE_SPECS: Record<number, GbaOperandType[]> = {
  0x01: ["u16"], // PUSH_CONST val
  0x02: ["u8"], // POP n
  0x04: ["ptr"], // CALL addr
  0x05: ["u8"], // RET n
  0x06: ["i16", "u8", "u8", "ptr"], // GET_FAR idx, size, bank, addr (addr = far DATA symbol; resolved in P1)
  0x07: ["i16", "ptr", "u8"], // LOOP idx, label, n
  0x08: ["i16", "u8", "u8"], // SWITCH idx, size, n (+ a 6-byte-per-case jump table)
  0x09: ["ptr"], // JUMP label
  0x0a: ["u8", "ptr"], // CALL_FAR bank, addr
  0x0b: ["u8"], // RET_FAR n
  0x0d: ["u8", "ptr", "u8", "i16"], // INVOKE bank, fn, nparams, idx (fn = native engine symbol; resolved in P1)
  0x0e: ["u8", "ptr", "i16", "u8"], // BEGINTHREAD bank, proc, handle, nargs (proc = cross-blob script symbol; resolved in P1)
  0x0f: ["u8", "i16", "i16", "ptr", "u8"], // IF cond, idxA, idxB, label, n
  0x10: ["i16"], // PUSH_VALUE_IND idx
  0x11: ["i16"], // PUSH_VALUE idx
  0x12: ["i8"], // RESERVE ofs
  0x13: ["i16", "i16"], // SET idxA, idxB
  0x14: ["i16", "u16"], // SET_CONST idx, val
  0x16: ["i16"], // JOIN idx
  0x17: ["i16"], // TERMINATE idx
  0x18: [], // IDLE
  0x19: ["i16", "i16"], // GET_TLOCAL idxA, idxB
  0x1a: ["u8", "i16", "i16", "ptr", "u8"], // IF_CONST cond, idxA, B, label, n
  0x1c: ["u16", "i16", "ptr"], // RATE_LIMIT_CONST nFrames, idx, label
  0x23: ["i16"], // INIT_RNG idx
  0x24: ["i16", "u16", "u16"], // RAND idx, min, limit
  0x25: [], // LOCK
  0x26: [], // UNLOCK
  0x27: ["u8", "u8"], // RAISE code, size
  0x28: ["i16", "i16"], // SET_INDIRECT idxA, idxB
  0x29: ["i16", "i16"], // GET_INDIRECT idxA, idxB
  0x2a: ["u8"], // TEST_TERMINATE flags
  0x2b: ["i16"], // POLL_LOADED idx
  0x2c: ["i16"], // PUSH_REFERENCE idx
  0x2d: ["u8", "ptr"], // CALL_NATIVE bank, ptr
  0x31: ["i16"], // ACTOR_ACTIVATE actor
  0x33: ["i16"], // ACTOR_DEACTIVATE actor
  0x35: ["i16"], // ACTOR_SET_POS idx
  0x3a: ["i16"], // ACTOR_GET_POS idx
  // actor movement (M3b): an i16 actor-ref; the move/dir ops add a u8 (attr or dir)
  0x32: ["i16", "u8"], // ACTOR_MOVE_TO_INIT ref, attr
  0x34: ["i16", "u8"], // ACTOR_SET_DIR ref, dir
  0x36: ["i16", "u8"], // ACTOR_MOVE_TO_X ref, attr (blocking)
  0x37: ["i16", "u8"], // ACTOR_MOVE_TO_Y ref, attr (blocking)
  0x38: ["i16", "u8"], // ACTOR_MOVE_TO_XY ref, attr (blocking)
  0x39: ["i16"], // ACTOR_MOVE_TO_SET_DIR_X ref
  0x3b: ["i16"], // ACTOR_MOVE_TO_SET_DIR_Y ref
  0x3c: ["i16"], // ACTOR_SET_ANIM_MOVING ref
  0x3d: ["i16"], // ACTOR_MOVE_CANCEL ref
  // actor properties (M10a)
  0x3e: ["i16", "u8"], // ACTOR_SET_MOVE_SPEED ref, subpx/frame
  0x3f: ["i16", "u8"], // ACTOR_SET_HIDDEN ref, hidden
  0x40: ["i16", "i16"], // ACTOR_GET_DIR ref, dest var
  0x41: ["i16", "u8"], // ACTOR_SET_ANIM_SET ref, global state index (M10c)
  0x42: ["i16", "u8"], // ACTOR_EMOTE ref, emote sprite index (M10d)
  0x44: ["i16", "u8", "u8"], // ACTOR_SET_FLAGS ref, flags, mask (M10e)
  0x45: ["i16", "u8"], // ACTOR_SET_COLL_ENABLED ref, enabled (M10e)
  0x46: ["i16"], // ACTOR_MOVE_TO ref {ID,X,Y,ATTR} (blocking) (M10e)
  0x51: ["u8"], // SET_SPRITES_VISIBLE mode
  0x54: ["u8", "i16"], // INPUT_GET joyid, idx
  0x57: ["u8"], // FADE flags (gbavm: no-op stub - screen always shown)
  0x5d: ["u8"], // SET_SPRITE_MODE mode (gbavm: no-op stub)
  // projectiles (M10f). LAUNCH's idx resolves to the {x, y, angle} stack block.
  0x80: ["u8", "i16"], // PROJECTILE_LAUNCH slot, idx
  0x81: ["u8", "u8", "u8"], // PROJECTILE_LOAD_TYPE dest, src, global-table base index
  0x86: ["i16", "i16"], // ACTOR_GET_ANGLE idx, dest
  0x89: ["i16", "i16", "u8"], // SIN_SCALE idx, idxAngle, scale
  0x8a: ["i16", "i16", "u8"], // COS_SCALE idx, idxAngle, scale
  0x76: ["i16", "i16", "i16"], // MEMSET idx, value, count
  0x77: ["i16", "i16", "i16"], // MEMCPY idxA, idxB, count
  0x68: [], // SCENE_PUSH  (save current scene on the stack)
  0x69: [], // SCENE_POP   (return to the pushed scene)
  0x6a: [], // SCENE_POP_ALL (return to the base scene)
  0x60: ["u8", "u8"], // MUSIC_PLAY track, loop (M5a)
  0x61: [], // MUSIC_STOP (M5a)
  0x66: ["u8"], // SFX_PLAY sfx index (M5b)
  0x63: ["u8"], // SOUND_MASTERVOL vol (M5c)
  // SRAM save (M6a). SAVE_PEEK macro args are RES, DEST, SOUR, COUNT, SLOT.
  0x2e: ["i16", "i16", "u16", "u16", "u8"], // SAVE_PEEK res, dest, sour, count, slot
  0x2f: ["u8"], // SAVE_CLEAR slot
  0x90: [], // DISPLAY_TEXT (dialogue: render text + wait for A)
  // dialogue overlay window box (M4d). The box geometry is derived from Y (GB rows
  // from the top of an 18-row screen); the engine draws a panel behind the text.
  0x91: ["u8", "u8", "i8"], // OVERLAY_MOVE_TO x, y, speed (speed signed: -1 in, -2 out, -3 instant)
  0x92: ["u8", "u8", "u8", "u8"], // OVERLAY_SHOW x, y, color, options
  0x93: [], // OVERLAY_HIDE
  0x94: ["u8", "u8"], // OVERLAY_WAIT modal, condition (UI_WAIT_* bitfield) -- M4q
  // Timers (M6f). TIMER_PREPARE's addr is the timer script proc (resolved like BEGINTHREAD).
  0x70: ["u8", "u8", "ptr"], // TIMER_PREPARE context, bank, addr
  0x71: ["u8", "u8"], // TIMER_SET context, interval (ticks)
  0x72: ["u8"], // TIMER_STOP context
  0x73: ["u8"], // TIMER_RESET context
};

export const GBA_OP_STOP = 0x00;

export type GbaItem =
  | { kind: "label"; name: string }
  | { kind: "op"; op: number; operands: (number | { label: string })[] }
  | { kind: "stop" }
  | {
      // raw RPN stream incl. terminator. `relocs` mark 4-byte engine-symbol
      // address fields inside the stream (RPN raw-memory ops, .R_REF_MEM*), which
      // the linker resolves like any other symbolic relocation (kind "ram").
      kind: "rpn";
      bytes: number[];
      relocs?: { at: number; symbol: string }[]; // `at` is an offset within `bytes`
    }
  | {
      // VM_SWITCH: a fixed header + a 6-byte-per-case relocatable jump table.
      kind: "switch";
      operands: [number, number, number]; // idx, size, n
      cases: { value: number; target: { label: string } }[];
    }
  | {
      // Raw inline bytes emitted verbatim - e.g. the scene-index data that follows
      // a VM_RAISE EXCEPTION_CHANGE_SCENE (the engine reads it as the raise's args).
      kind: "raw";
      bytes: number[];
    };

export interface GbaReloc {
  at: number; // byte offset of the 4-byte field to patch
  target: number; // byte offset of the target label within the blob
}

// A reference to a symbol defined outside this blob. `kind` says what it is, which
// determines how the project linker (linkGbaProgram, M1) resolves it:
//   "code" - another script proc (&proc array) or a native engine fn / far data.
//   "ram"  - a writable engine RAM variable (the target of an RPN raw-memory write,
//            e.g. VM_SET_CONST_INT8 _fade_frames_per_step). The linker allocates it.
// The byte offset is known here, but the address isn't (it's a C/linker symbol), so
// the linker emits a `&symbol` field the engine patches in at load.
export type GbaSymKind = "code" | "ram";
export interface GbaSymReloc {
  at: number; // byte offset of the 4-byte field to patch
  symbol: string; // the external symbol name (as written in the GBVM .s, e.g. "_other_script")
  kind: GbaSymKind;
}

export interface GbaProgram {
  bytes: number[];
  relocations: GbaReloc[];
  symRelocs: GbaSymReloc[];
}

const operandSize = (t: GbaOperandType): number =>
  t === "u8" || t === "i8" ? 1 : t === "ptr" ? 4 : 2;

const opByteSize = (types: GbaOperandType[]): number =>
  1 + types.reduce((n, t) => n + operandSize(t), 0);

function itemSize(item: GbaItem): number {
  switch (item.kind) {
    case "label":
      return 0;
    case "stop":
      return 1;
    case "rpn":
      return 1 + item.bytes.length; // 0x15 opcode + stream
    case "raw":
      return item.bytes.length; // emitted verbatim
    case "switch":
      // 5-byte header (op + i16 idx + u8 size + u8 n) + 6 bytes per case entry.
      return opByteSize(GBA_OPCODE_SPECS[0x08]) + item.cases.length * 6;
    case "op": {
      const spec = GBA_OPCODE_SPECS[item.op];
      if (!spec) {
        throw new Error(`No GBA encoding for opcode 0x${item.op.toString(16)}`);
      }
      return opByteSize(spec);
    }
  }
}

/**
 * Encode an opcode stream into gbavm bytes + a relocation table.
 * Two passes: resolve label byte-offsets, then emit bytes and relocations.
 */
export function emitGbaBytecode(items: GbaItem[]): GbaProgram {
  const labelOffsets = new Map<string, number>();
  let offset = 0;
  for (const item of items) {
    if (item.kind === "label") {
      if (labelOffsets.has(item.name)) {
        throw new Error(`Duplicate label ${item.name}`);
      }
      labelOffsets.set(item.name, offset);
    }
    offset += itemSize(item);
  }

  const bytes: number[] = [];
  const relocations: GbaReloc[] = [];
  const symRelocs: GbaSymReloc[] = [];
  const push8 = (v: number) => bytes.push(v & 0xff);
  const push16 = (v: number) => {
    bytes.push(v & 0xff);
    bytes.push((v >> 8) & 0xff);
  };
  const push32placeholder = () => {
    for (let i = 0; i < 4; i++) bytes.push(0);
  };

  for (const item of items) {
    if (item.kind === "label") continue;
    if (item.kind === "stop") {
      push8(GBA_OP_STOP);
      continue;
    }
    if (item.kind === "raw") {
      for (const b of item.bytes) push8(b);
      continue;
    }
    if (item.kind === "rpn") {
      push8(0x15);
      const rpnStart = bytes.length;
      for (const b of item.bytes) push8(b);
      // Engine-symbol address fields inside the RPN stream become "ram" symbolic
      // relocations at their absolute offset in the proc.
      for (const r of item.relocs ?? []) {
        symRelocs.push({ at: rpnStart + r.at, symbol: r.symbol, kind: "ram" });
      }
      continue;
    }
    if (item.kind === "switch") {
      // Header: op + idx(i16) + size(u8) + n(u8). Then one 6-byte entry per case:
      // value(i16 LE) + a 4-byte code pointer (relocated like a "ptr" operand).
      push8(0x08);
      push16(item.operands[0]);
      push8(item.operands[1]);
      push8(item.operands[2]);
      for (const c of item.cases) {
        push16(c.value);
        const target = labelOffsets.get(c.target.label);
        if (target === undefined) {
          throw new Error(`Unknown switch label "${c.target.label}"`);
        }
        relocations.push({ at: bytes.length, target });
        push32placeholder();
      }
      continue;
    }
    const spec = GBA_OPCODE_SPECS[item.op];
    if (!spec)
      throw new Error(`No GBA encoding for opcode 0x${item.op.toString(16)}`);
    push8(item.op);
    spec.forEach((t, i) => {
      const operand = item.operands[i];
      if (t === "ptr") {
        if (typeof operand !== "object" || !("label" in operand)) {
          throw new Error(
            `Opcode 0x${item.op.toString(16)} operand ${i} must be a {label}`,
          );
        }
        const target = labelOffsets.get(operand.label);
        if (target !== undefined) {
          relocations.push({ at: bytes.length, target });
        } else if (operand.label.startsWith("_")) {
          // A "_"-prefixed name is an external code symbol — another script proc
          // (VM_BEGINTHREAD/CALL_FAR), a native engine function (VM_INVOKE/
          // VM_CALL_NATIVE), or far data (VM_GET_FAR) — not a label in this blob.
          // Record it as a symbolic relocation; the project linker (linkGbaProgram)
          // resolves it to a `&symbol` field the engine patches in at load.
          symRelocs.push({
            at: bytes.length,
            symbol: operand.label,
            kind: "code",
          });
        } else {
          throw new Error(`Unknown label "${operand.label}"`);
        }
        push32placeholder();
      } else {
        if (typeof operand !== "number") {
          throw new Error(
            `Opcode 0x${item.op.toString(16)} operand ${i} must be a number`,
          );
        }
        if (t === "u8" || t === "i8") push8(operand);
        else push16(operand);
      }
    });
  }

  return { bytes, relocations, symRelocs };
}

/** Format an emitted program as C source for the gbavm build (used in M2). */
export function formatGbaProgramC(name: string, program: GbaProgram): string {
  const hex = program.bytes.map((b) => `0x${b.toString(16).padStart(2, "0")}`);
  const rows: string[] = [];
  for (let i = 0; i < hex.length; i += 12) {
    rows.push("    " + hex.slice(i, i + 12).join(", ") + ",");
  }
  // Flat [at0, target0, at1, target1, ...] pairs (flat = trivially C/C++ linkable).
  // C forbids zero-size arrays, so emit a dummy pair when there are no
  // relocations; the engine iterates by `_relocs_count` (0 here), ignoring it.
  const relocPairs =
    program.relocations.length > 0
      ? program.relocations.map((r) => `    ${r.at}, ${r.target},`).join("\n")
      : "    0, 0, /* none (count is 0) */";
  return [
    "// Generated by GBA Studio - gbavm bytecode + relocation table.",
    "// Non-const: relocations are patched in place at load, so it must live in RAM.",
    `unsigned char ${name}[] = {`,
    ...rows,
    "};",
    `const unsigned int ${name}_len = ${program.bytes.length};`,
    "// Flat {field_offset, target_offset} pairs. At load the engine sets:",
    `//   *(const unsigned char **)(${name} + field) = ${name} + target;`,
    `const unsigned short ${name}_relocs[] = {`,
    relocPairs,
    "};",
    `const unsigned int ${name}_relocs_count = ${program.relocations.length};`,
  ].join("\n");
}
