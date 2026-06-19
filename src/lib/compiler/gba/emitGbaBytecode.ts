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
  0x51: ["u8"], // SET_SPRITES_VISIBLE mode
  0x54: ["u8", "i16"], // INPUT_GET joyid, idx
  0x57: ["u8"], // FADE flags (gbavm: no-op stub - screen always shown)
  0x5d: ["u8"], // SET_SPRITE_MODE mode (gbavm: no-op stub)
  0x86: ["i16", "i16"], // ACTOR_GET_ANGLE idx, dest
  0x89: ["i16", "i16", "u8"], // SIN_SCALE idx, idxAngle, scale
  0x8a: ["i16", "i16", "u8"], // COS_SCALE idx, idxAngle, scale
  0x76: ["i16", "i16", "i16"], // MEMSET idx, value, count
  0x77: ["i16", "i16", "i16"], // MEMCPY idxA, idxB, count
};

export const GBA_OP_STOP = 0x00;

export type GbaItem =
  | { kind: "label"; name: string }
  | { kind: "op"; op: number; operands: (number | { label: string })[] }
  | { kind: "stop" }
  | { kind: "rpn"; bytes: number[] } // raw RPN stream incl. terminator (pre-encoded for now)
  | {
      // VM_SWITCH: a fixed header + a 6-byte-per-case relocatable jump table.
      kind: "switch";
      operands: [number, number, number]; // idx, size, n
      cases: { value: number; target: { label: string } }[];
    };

export interface GbaReloc {
  at: number; // byte offset of the 4-byte field to patch
  target: number; // byte offset of the target label within the blob
}

export interface GbaProgram {
  bytes: number[];
  relocations: GbaReloc[];
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
 * Two passes over one item stream: resolve label byte-offsets, then emit bytes
 * and relocations. Also returns the resolved label table, which linkGbaImage uses
 * to locate each proc's entry offset within a combined whole-project image.
 */
function encodeImage(items: GbaItem[]): {
  program: GbaProgram;
  labelOffsets: Map<string, number>;
} {
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
    if (item.kind === "rpn") {
      push8(0x15);
      for (const b of item.bytes) push8(b);
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
    if (!spec) throw new Error(`No GBA encoding for opcode 0x${item.op.toString(16)}`);
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
        if (target === undefined) {
          // A "_"-prefixed name is a symbol outside this proc. After whole-project
          // linkGbaImage, cross-proc script symbols ARE in labelOffsets and resolve
          // here as ordinary in-image relocations. The ones that remain unresolved
          // are classified by their opcode: native engine functions
          // (VM_INVOKE/VM_CALL_NATIVE) and far data (VM_GET_FAR) need an engine-side
          // symbol registry that is a later phase; a leftover script symbol means
          // the proc wasn't linked with the rest of the project.
          if (operand.label.startsWith("_")) {
            if (item.op === 0x0d || item.op === 0x2d) {
              throw new Error(
                `Native-function symbol "${operand.label}" (VM_INVOKE/VM_CALL_NATIVE) can't be ` +
                  `linked yet — native-fn resolution needs an engine-side symbol registry (a later phase).`,
              );
            }
            if (item.op === 0x06) {
              throw new Error(
                `Far-data symbol "${operand.label}" (VM_GET_FAR) can't be linked yet — ` +
                  `far-data resolution is a later phase.`,
              );
            }
            throw new Error(
              `Unresolved script symbol "${operand.label}" — the whole project must be linked ` +
                `together (use linkGbaImage), not emitted as a standalone blob.`,
            );
          }
          throw new Error(`Unknown label "${operand.label}"`);
        }
        relocations.push({ at: bytes.length, target });
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

  return { program: { bytes, relocations }, labelOffsets };
}

/**
 * Encode a single opcode stream into gbavm bytes + a relocation table.
 * (Standalone: any cross-proc `_<sym>` reference is unresolved here — use
 * linkGbaImage to link a whole project where such symbols resolve.)
 */
export function emitGbaBytecode(items: GbaItem[]): GbaProgram {
  return encodeImage(items).program;
}

/** A compiled GBVM proc: its exported entry symbol plus its opcode stream. */
export interface GbaProc {
  symbol: string; // the `_<name>` entry label this proc exports
  items: GbaItem[];
}

export interface GbaLinkResult {
  program: GbaProgram;
  entryOffsets: Map<string, number>; // proc symbol -> byte offset in the image
}

// The relocation table stores `at`/`target` as unsigned 16-bit offsets (see
// formatGbaProgramC + the engine's apply_relocations), so one combined image
// cannot exceed this. Widening to 32-bit offsets is deliberately out of P1 scope.
export const GBA_IMAGE_MAX_BYTES = 0x10000;

// Prefix a proc's LOCAL labels (numeric `1$` etc. — anything not starting with
// "_") so two procs reusing the same local label don't collide when merged into
// one image. Global `_<sym>` link symbols are left untouched: they ARE the
// cross-proc resolution targets. Returns a fresh item list (no mutation).
function namespaceLocals(items: GbaItem[], prefix: string): GbaItem[] {
  const ns = (name: string) => (name.startsWith("_") ? name : `${prefix}@${name}`);
  return items.map((item) => {
    if (item.kind === "label") return { ...item, name: ns(item.name) };
    if (item.kind === "switch") {
      return {
        ...item,
        cases: item.cases.map((c) => ({
          ...c,
          target: { label: ns(c.target.label) },
        })),
      };
    }
    if (item.kind === "op") {
      return {
        ...item,
        operands: item.operands.map((o) =>
          typeof o === "object" && o !== null && "label" in o
            ? { label: ns(o.label) }
            : o,
        ),
      };
    }
    return item;
  });
}

/**
 * Whole-project link: lay every compiled proc back-to-back into ONE image with a
 * single merged label map, so a cross-proc `_<sym>` reference (VM_CALL_FAR,
 * VM_BEGINTHREAD, ...) resolves to the `_<sym>::` entry another proc defines, as
 * an ordinary in-image relocation. The existing reloc format and the engine's
 * apply_relocations loader are reused verbatim — the bytecode just spans procs.
 */
export function linkGbaImage(procs: GbaProc[]): GbaLinkResult {
  const merged: GbaItem[] = [];
  for (const proc of procs) merged.push(...namespaceLocals(proc.items, proc.symbol));

  const { program, labelOffsets } = encodeImage(merged);

  if (program.bytes.length > GBA_IMAGE_MAX_BYTES) {
    throw new Error(
      `GBA image is ${program.bytes.length} bytes; the 16-bit relocation format ` +
        `cannot address past ${GBA_IMAGE_MAX_BYTES} (P1 scope — widening is a later phase).`,
    );
  }

  const entryOffsets = new Map<string, number>();
  for (const proc of procs) {
    const offset = labelOffsets.get(proc.symbol);
    if (offset === undefined) {
      throw new Error(`Linked proc "${proc.symbol}" has no entry label in its stream`);
    }
    entryOffsets.set(proc.symbol, offset);
  }
  return { program, entryOffsets };
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
