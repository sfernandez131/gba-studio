// GBA Studio - GBVM assembly bridge (Milestone M2b: "code bridge").
//
// GB Studio compiles each script to GBVM assembly (.s) full of `VM_*` macro calls
// (see appData/engine/gbvm/include/vm.i). The GB build hands those to the SDCC
// assembler, which expands the macros into bytes (big-endian, reversed operand
// order) and resolves symbols/labels via the linker.
//
// The GBA engine (gbavm) has no SDCC. This module re-reads the .s text and turns
// the macro calls back into a structured opcode stream (GbaItem[]), which
// emitGbaBytecode() then serialises in gbavm's byte order (little-endian, signature
// order) with a relocation table. Because macros appear *unexpanded* in the .s
// (e.g. `VM_SET_CONST .LOCAL_ACTOR, 1`), we read their arguments in signature order
// - exactly the order emitGbaBytecode/VM_STEP expect - so no byte-order juggling.
//
// Scope (bring-up): the opcodes gbavm implements today, plus the scene-boot ops it
// accepts as no-ops. Ops that need machinery not yet ported (asset far-pointers,
// engine-symbol memory writes) are listed in SKIP_MACROS and dropped with a note;
// genuinely unknown macros throw so surprises surface instead of silently vanishing.

import { GbaItem, GBA_OPCODE_SPECS, GbaOperandType } from "./emitGbaBytecode";

// VM_* macro name -> gbavm opcode. Operand kinds come from GBA_OPCODE_SPECS[op],
// which is already in signature (== gbavm read) order, so this is just the map of
// which macros we can encode directly.
const MACRO_TO_OP: Record<string, number> = {
  VM_STOP: 0x00,
  VM_PUSH_CONST: 0x01,
  VM_POP: 0x02,
  VM_CALL: 0x04,
  VM_JUMP: 0x09,
  VM_CALL_FAR: 0x0a,
  VM_LOOP: 0x07,
  VM_SWITCH: 0x08, // special-cased below (consumes a trailing .dw case table)
  // Cross-blob / native / far-data opcodes: the encoding is bridged here (P0), but
  // their ptr targets are symbols outside this blob (another script proc, a native
  // engine fn, or far data). Those only resolve once P1 adds whole-project linking;
  // until then the emitter raises a precise "resolved in P1" error if one is used.
  VM_GET_FAR: 0x06,
  VM_INVOKE: 0x0d,
  VM_BEGINTHREAD: 0x0e,
  VM_CALL_NATIVE: 0x2d,
  VM_PUSH_VALUE_IND: 0x10,
  VM_PUSH_VALUE: 0x11,
  VM_RESERVE: 0x12,
  VM_SET: 0x13,
  VM_SET_CONST: 0x14,
  VM_IF: 0x0f,
  VM_IF_CONST: 0x1a,
  VM_JOIN: 0x16,
  VM_TERMINATE: 0x17,
  VM_IDLE: 0x18,
  VM_GET_TLOCAL: 0x19,
  VM_RATE_LIMIT_CONST: 0x1c,
  VM_INIT_RNG: 0x23,
  VM_RAND: 0x24,
  VM_LOCK: 0x25,
  VM_UNLOCK: 0x26,
  VM_RAISE: 0x27,
  VM_SET_INDIRECT: 0x28,
  VM_GET_INDIRECT: 0x29,
  VM_TEST_TERMINATE: 0x2a,
  VM_POLL_LOADED: 0x2b,
  VM_PUSH_REFERENCE: 0x2c,
  VM_ACTOR_ACTIVATE: 0x31,
  VM_ACTOR_DEACTIVATE: 0x33,
  VM_ACTOR_SET_POS: 0x35,
  VM_ACTOR_GET_POS: 0x3a,
  VM_SET_SPRITE_VISIBLE: 0x51,
  VM_INPUT_GET: 0x54,
  VM_FADE: 0x57, // gbavm no-op
  VM_SET_SPRITE_MODE: 0x5d, // gbavm no-op
  VM_ACTOR_GET_ANGLE: 0x86,
  VM_SIN_SCALE: 0x89,
  VM_COS_SCALE: 0x8a,
  VM_MEMSET: 0x76,
  VM_MEMCPY: 0x77,
  // scene stack (no operands): push current scene, pop back to it, pop to the base.
  VM_SCENE_PUSH: 0x68,
  VM_SCENE_POP: 0x69,
  VM_SCENE_POP_ALL: 0x6a,
};

// On GBA, the editor's joypad read (VM_GET_*INT8 from _joypads) is retargeted to
// VM_INPUT_GET (0x54), which reads the live keypad bitmask via the hardware bridge.
// vm.i declares `VM_GET_INT8 IDX, ADDR`; INPUT_GET's spec is [joyid, idx], so we emit
// joyid 0 + the destination index. Keeps all GBA-specific input handling in the
// bridge (no change to the shared codegen / GB path).
const gbaInputGet = (args: string[], ev: (s: string) => number): GbaItem[] => {
  const [idx, addr] = args;
  if (addr === undefined || !/_joypads/.test(addr)) {
    throw new Error(
      `VM_GET_*INT8 source "${addr ?? ""}" is not supported on GBA (only the joypad read is bridged)`,
    );
  }
  return [{ kind: "op", op: 0x54, operands: [0, ev(idx)] }];
};

// Macros that are GBVM convenience wrappers (vm.i expands them); we expand them too.
// Each returns the GbaItems it represents, or null to drop it (with a logged note).
type ExpandFn = (args: string[], ev: (s: string) => number) => GbaItem[] | null;
const EXPAND_MACROS: Record<string, ExpandFn> = {
  // GBA input: read the live keypad bitmask instead of GB Studio's _joypads WRAM.
  VM_GET_INT8: (a, ev) => gbaInputGet(a, ev),
  VM_GET_UINT8: (a, ev) => gbaInputGet(a, ev),
  // VM_FADE_IN/OUT IS_MODAL -> VM_FADE <flags>. gbavm's fade is a no-op, so the
  // exact flag bits are irrelevant; we keep the IN/OUT distinction for readability.
  VM_FADE_IN: () => [{ kind: "op", op: 0x57, operands: [0x02] }],
  VM_FADE_OUT: () => [{ kind: "op", op: 0x57, operands: [0x00] }],
  // VM_RET[_FAR][_N] -> opcode with explicit arg count (0 when omitted).
  VM_RET: (a, ev) => [{ kind: "op", op: 0x05, operands: [a.length ? ev(a[0]) : 0] }],
  VM_RET_N: (a, ev) => [{ kind: "op", op: 0x05, operands: [ev(a[0])] }],
  VM_RET_FAR: (a, ev) => [{ kind: "op", op: 0x0b, operands: [a.length ? ev(a[0]) : 0] }],
  VM_RET_FAR_N: (a, ev) => [{ kind: "op", op: 0x0b, operands: [ev(a[0])] }],
  // Engine-symbol writes -> an RPN raw-memory write to the symbol's address (mirrors
  // vm.i). ADDR is arg 0, the value/source is arg 1. The 32-bit address is a "ram"
  // symbolic relocation the linker resolves to the engine var it allocates.
  // VM_SET_CONST_*: write a constant.  VM_SET_*: write VM variable IDXA's value.
  VM_SET_CONST_INT8: (a, ev) => [memSetItem(MEM_I8, [RPN_INT8, ev(a[1]) & 0xff], a[0], ev)],
  VM_SET_CONST_UINT8: (a, ev) => [memSetItem(MEM_U8, [RPN_INT8, ev(a[1]) & 0xff], a[0], ev)],
  VM_SET_CONST_INT16: (a, ev) => {
    const v = ev(a[1]);
    return [memSetItem(MEM_I16, [RPN_INT16, v & 0xff, (v >> 8) & 0xff], a[0], ev)];
  },
  VM_SET_CONST_UINT16: (a, ev) => {
    const v = ev(a[1]);
    return [memSetItem(MEM_I16, [RPN_INT16, v & 0xff, (v >> 8) & 0xff], a[0], ev)];
  },
  VM_SET_INT8: (a, ev) => {
    const i = ev(a[1]);
    return [memSetItem(MEM_I8, [RPN_REF, i & 0xff, (i >> 8) & 0xff], a[0], ev)];
  },
  VM_SET_UINT8: (a, ev) => {
    const i = ev(a[1]);
    return [memSetItem(MEM_U8, [RPN_REF, i & 0xff, (i >> 8) & 0xff], a[0], ev)];
  },
  VM_SET_INT16: (a, ev) => {
    const i = ev(a[1]);
    return [memSetItem(MEM_I16, [RPN_REF, i & 0xff, (i >> 8) & 0xff], a[0], ev)];
  },
  VM_SET_UINT16: (a, ev) => {
    const i = ev(a[1]);
    return [memSetItem(MEM_I16, [RPN_REF, i & 0xff, (i >> 8) & 0xff], a[0], ev)];
  },
};

// Macros we intentionally drop during bring-up (need machinery not yet ported).
// Dropping is safe for these specific ops on gbavm's stubbed scaffold; each drop
// is reported so nothing disappears silently.
const SKIP_MACROS = new Set<string>([
  // VM_RANDOMIZE expands to an RPN read of GB-only _DIV_REG/_game_time; gbavm seeds
  // its RNG once at boot from a hardware timer instead (P0).
  "VM_RANDOMIZE",
  // VM_ACTOR_SET_DIR sets an actor's explicit facing; gbavm infers facing from
  // movement, so drop it for now (cosmetic on scene entry).
  "VM_ACTOR_SET_DIR",
]);

// GBVM constants referenced by name in operands/RPN. Local `.X = n` defines found
// in the .s are layered on top of these.
const BASE_CONSTS: Record<string, number> = {
  // sprite mode
  ".MODE_8X8": 0, ".MODE_8X16": 1,
  // VM_GET_FAR object size
  ".GET_BYTE": 0, ".GET_WORD": 1,
  // directions
  ".DIR_DOWN": 0, ".DIR_RIGHT": 1, ".DIR_UP": 2, ".DIR_LEFT": 3,
  // fade
  ".FADE_OUT": 0x00, ".FADE_IN": 0x02, ".FADE_MODAL": 0x01, ".FADE_NONMODAL": 0x00,
  // VM_RAISE exception codes (vm_exceptions.h)
  EXCEPTION_RESET: 1, EXCEPTION_CHANGE_SCENE: 2, EXCEPTION_SAVE: 3,
  EXCEPTION_LOAD: 4, EXCEPTION_TERMINATE: 5,
  // camera lock flags (written to _camera_settings)
  ".CAMERA_LOCK": 0x03, ".CAMERA_LOCK_X": 0x01, ".CAMERA_LOCK_Y": 0x02,
  ".CAMERA_UNLOCK": 0x00, ".CAMERA_LOCK_X_MIN": 0x04, ".CAMERA_LOCK_X_MAX": 0x08,
  ".CAMERA_LOCK_Y_MIN": 0x10, ".CAMERA_LOCK_Y_MAX": 0x20,
  // if / rpn conditions
  ".EQ": 1, ".LT": 2, ".LTE": 3, ".GT": 4, ".GTE": 5, ".NE": 6,
  // rpn operators
  ".AND": 7, ".OR": 8, ".NOT": 9, ".ADD": 10, ".SUB": 11, ".MUL": 12, ".DIV": 13,
  ".MOD": 14, ".B_AND": 15, ".B_OR": 16, ".B_XOR": 17, ".SHL": 18, ".SHR": 19,
  ".MIN": 20, ".MAX": 21, ".ATAN2": 22, ".ABS": 23, ".B_NOT": 24, ".NEG": 25,
  ".ISQRT": 26, ".RND": 27,
  // rpn memory-access type tags (char codes) - only needed if REF_MEM is supported
  ".MEM_I8": 0x69, ".MEM_U8": 0x75, ".MEM_I16": 0x49,
  // stack-arg aliases (vm.i: .ARG0 = -1 .. .ARG16 = -17)
  ".ARG0": -1, ".ARG1": -2, ".ARG2": -3, ".ARG3": -4, ".ARG4": -5, ".ARG5": -6,
  ".ARG6": -7, ".ARG7": -8, ".ARG8": -9, ".ARG9": -10, ".ARG10": -11, ".ARG11": -12,
  ".ARG12": -13, ".ARG13": -14, ".ARG14": -15, ".ARG15": -16, ".ARG16": -17,
};

// RPN sub-instruction (.R_*) opcode bytes (signed VM_OP_* values as unsigned bytes).
const RPN_INT8 = 0xff; // -1
const RPN_INT16 = 0xfe; // -2
const RPN_REF = 0xfd; // -3
const RPN_REF_IND = 0xfc; // -4
const RPN_REF_SET = 0xfb; // -5
const RPN_REF_SET_IND = 0xfa; // -6
const RPN_REF_MEM = 0xf9; // -7  raw-memory read  (engine symbol; 32-bit addr on GBA)
const RPN_REF_MEM_SET = 0xf8; // -8  raw-memory write (engine symbol)
const RPN_REF_MEM_IND = 0xf7; // -9  raw-memory indirect
const RPN_STOP = 0x00;

// RPN raw-memory type tags (vm.h VM_OP_MEM_*): the access width.
const MEM_I8 = 0x69; // 'i'
const MEM_U8 = 0x75; // 'u'
const MEM_I16 = 0x49; // 'I'

// A 4-byte address field inside an RPN stream that targets an engine symbol; the
// linker resolves `symbol` to its address. `at` is the offset within the rpn bytes.
interface RpnReloc {
  at: number;
  symbol: string;
}

// Extract a bare engine symbol ("_fade_frames_per_step") from an RPN address
// operand, unwrapping SDCC's ^!..! / ^/(..)/ forms. Returns undefined for a
// numeric/computed address (handled as a literal instead).
const bareSymbol = (raw: string): string | undefined => {
  let s = raw.trim();
  const w = s.match(/^\^\/\((.*)\)\/$/) || s.match(/^\^!(.*)!$/);
  if (w) s = w[1].trim();
  s = s.replace(/:+$/, "");
  return /^_[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : undefined;
};

// Push a 4-byte raw-memory address into an RPN stream: a relocation when ADDR is
// an engine symbol (the linker patches in &symbol), else a literal little-endian
// address. Used by .R_REF_MEM* and the VM_SET_*INT8/16 expansions.
const pushMemAddr = (
  addrArg: string,
  out: number[],
  relocs: RpnReloc[],
  ev: (s: string) => number,
): void => {
  const sym = bareSymbol(addrArg);
  if (sym) {
    relocs.push({ at: out.length, symbol: sym });
    out.push(0, 0, 0, 0); // placeholder, patched at load
  } else {
    const v = ev(addrArg);
    out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  }
};

// Build the RPN GbaItem for a "write to engine symbol ADDR" macro
// (VM_SET_CONST_INT8/16, VM_SET_INT8/16). `leadBytes` push the value/source onto
// the RPN stack; then a raw-memory write of width `memTag` to the 32-bit ADDR.
const memSetItem = (
  memTag: number,
  leadBytes: number[],
  addrArg: string,
  ev: (s: string) => number,
): GbaItem => {
  const bytes: number[] = [...leadBytes, RPN_REF_MEM_SET, memTag];
  const relocs: RpnReloc[] = [];
  pushMemAddr(addrArg, bytes, relocs, ev);
  bytes.push(RPN_STOP);
  return { kind: "rpn", bytes, relocs };
};

export interface ParseResult {
  items: GbaItem[];
  skipped: string[]; // human-readable notes for dropped macros
}

const stripComment = (line: string): string => {
  const i = line.indexOf(";");
  return (i >= 0 ? line.slice(0, i) : line).trim();
};

// Split a macro argument list on top-level commas (parentheses may nest, but the
// GBVM macros we read never put a comma inside an expression).
const splitArgs = (s: string): string[] =>
  s.trim() === "" ? [] : s.split(",").map((a) => a.trim()).filter((a) => a !== "");

/**
 * Build an expression evaluator bound to a constant table. Handles SDCC's
 * `^/(...)/ ` and `^!...!` expression wrappers, named constants, and integer
 * arithmetic (+ - * / % | & ^ << >> ~ and parentheses).
 */
function makeEvaluator(consts: Record<string, number>) {
  return function evalExpr(raw: string): number {
    let s = raw.trim();
    const wrapped = s.match(/^\^\/\((.*)\)\/$/) || s.match(/^\^!(.*)!$/);
    if (wrapped) s = wrapped[1].trim();
    // Substitute identifiers (.NAME or NAME) with their constant values.
    s = s.replace(/\.?[A-Za-z_][A-Za-z0-9_]*/g, (tok) => {
      if (tok in consts) return `(${consts[tok]})`;
      // Bank-number linker symbols: the long `___bank_<symbol>` form and the short
      // `b_<symbol>` form (e.g. VM_INVOKE's bank operand, `b_wait_frames`). The GBA
      // is flat (no banking) and every engine handler ignores the bank operand, so
      // any bank symbol folds to 0.
      if (tok.startsWith("___bank_") || tok.startsWith("b_")) return "(0)";
      throw new Error(`Unknown symbol "${tok}" in expression "${raw}"`);
    });
    if (!/^[-+*/%|&^<>()~\s0-9xX]+$/.test(s)) {
      throw new Error(`Unsafe/unsupported expression "${raw}" -> "${s}"`);
    }
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict";return (${s});`)() as number;
    if (!Number.isFinite(v)) throw new Error(`Expression "${raw}" did not evaluate to a number`);
    return v | 0;
  };
}

const encodeRpnRef = (op: number, idx: number): number[] => [op, idx & 0xff, (idx >> 8) & 0xff];

/**
 * Parse one RPN block body (the lines between `VM_RPN` and `.R_STOP`) into the raw
 * byte stream gbavm's vm_rpn() reads (terminated with 0x00). Stack/heap refs only;
 * raw-memory refs (.R_REF_MEM*) are not supported on GBA yet and throw.
 */
function parseRpnLine(
  mnemonic: string,
  args: string[],
  ev: (s: string) => number,
  out: number[],
  relocs: RpnReloc[],
): boolean {
  switch (mnemonic) {
    case ".R_INT8": out.push(RPN_INT8, ev(args[0]) & 0xff); return false;
    case ".R_INT16": { const v = ev(args[0]); out.push(RPN_INT16, v & 0xff, (v >> 8) & 0xff); return false; }
    case ".R_REF": out.push(...encodeRpnRef(RPN_REF, ev(args[0]))); return false;
    case ".R_REF_IND": out.push(...encodeRpnRef(RPN_REF_IND, ev(args[0]))); return false;
    case ".R_REF_SET": out.push(...encodeRpnRef(RPN_REF_SET, ev(args[0]))); return false;
    case ".R_REF_SET_IND": out.push(...encodeRpnRef(RPN_REF_SET_IND, ev(args[0]))); return false;
    case ".R_OPERATOR": out.push(ev(args[0]) & 0xff); return false;
    case ".R_STOP": out.push(RPN_STOP); return true; // block complete
    // Raw-memory ops: `.R_REF_MEM* TYPE, ADDR` -> opcode + type tag + 32-bit ADDR
    // (an engine-symbol relocation, the GBA-specific part).
    case ".R_REF_MEM_SET":
      out.push(RPN_REF_MEM_SET, ev(args[0]) & 0xff);
      pushMemAddr(args[1], out, relocs, ev);
      return false;
    case ".R_REF_MEM":
      out.push(RPN_REF_MEM, ev(args[0]) & 0xff);
      pushMemAddr(args[1], out, relocs, ev);
      return false;
    case ".R_REF_MEM_IND":
      out.push(RPN_REF_MEM_IND, ev(args[0]) & 0xff);
      pushMemAddr(args[1], out, relocs, ev);
      return false;
    default:
      throw new Error(`Unknown RPN sub-instruction "${mnemonic}"`);
  }
}

/**
 * Parse a GBVM assembly script into a GbaItem[] opcode stream.
 * `entrySymbol`, when given, restricts parsing to that routine's body (handy when a
 * file defines several `_name::` routines); otherwise the whole file is parsed.
 */
export function parseGbvmAsm(
  asm: string,
  opts: {
    entrySymbol?: string;
    // Resolve a scene far-ptr symbol (e.g. "_scene_main") to its gba_scenes[] index;
    // used to bridge VM_RAISE EXCEPTION_CHANGE_SCENE + IMPORT_FAR_PTR_DATA.
    sceneIndex?: (symbol: string) => number | undefined;
  } = {},
): ParseResult {
  const { entrySymbol, sceneIndex } = opts;
  const consts: Record<string, number> = { ...BASE_CONSTS };

  // First pass: collect local `.X = n` / `SYM = n` constant defines so forward
  // references resolve regardless of order.
  for (const rawLine of asm.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    const m = line.match(/^([.\w$]+)\s*=\s*(.+)$/);
    if (m && !line.startsWith("VM_")) {
      try {
        consts[m[1]] = makeEvaluator(consts)(m[2]);
      } catch {
        /* non-numeric assignment (rare); ignore - only numeric defines are used */
      }
    }
  }
  const ev = makeEvaluator(consts);

  const items: GbaItem[] = [];
  const skipped: string[] = [];
  let inRpn = false;
  let rpnBytes: number[] = [];
  let rpnRelocs: RpnReloc[] = [];
  // VM_SWITCH accumulates the ".dw value, label" case table that follows it.
  let pendingSwitch:
    | {
        operands: [number, number, number];
        size: number;
        cases: { value: number; target: { label: string } }[];
      }
    | null = null;
  // VM_RAISE EXCEPTION_CHANGE_SCENE is followed by an IMPORT_FAR_PTR_DATA scene
  // pointer; this flag bridges that pair into a 2-byte scene index.
  let pendingSceneChange = false;
  let active = entrySymbol === undefined; // when scoping to an entry, wait for it

  const DIRECTIVES = /^\.(module|include|globl|area|org|optsdcc|ds|incbin|bndry)\b/;

  for (const rawLine of asm.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line === "") continue;

    // Entry scoping: start at `_entry::`, stop at the next top-level routine label.
    if (entrySymbol !== undefined) {
      const lbl = line.match(/^([A-Za-z_][\w]*)::?$/);
      if (lbl) {
        if (lbl[1] === entrySymbol) { active = true; continue; }
        if (active) break; // reached the following routine
      }
      if (!active) continue;
    }

    if (DIRECTIVES.test(line)) continue;
    if (/^[.\w$]+\s*=\s*.+$/.test(line) && !line.startsWith("VM_")) continue; // const define (pass 1)

    // Split mnemonic + argument list.
    const sp = line.search(/\s/);
    const mnemonic = sp < 0 ? line : line.slice(0, sp);
    const argStr = sp < 0 ? "" : line.slice(sp + 1);

    if (inRpn) {
      const args = splitArgs(argStr);
      const done = parseRpnLine(mnemonic, args, ev, rpnBytes, rpnRelocs);
      if (done) {
        items.push(
          rpnRelocs.length > 0
            ? { kind: "rpn", bytes: rpnBytes, relocs: rpnRelocs }
            : { kind: "rpn", bytes: rpnBytes },
        );
        inRpn = false;
        rpnBytes = [];
        rpnRelocs = [];
      }
      continue;
    }

    if (pendingSwitch) {
      // Consume the `.dw value, label` case-table lines emitted after VM_SWITCH.
      const dw = mnemonic === ".dw" ? splitArgs(argStr) : null;
      if (!dw || dw.length < 2) {
        throw new Error(
          `VM_SWITCH expected a ".dw value, label" case but got "${line}"`,
        );
      }
      pendingSwitch.cases.push({
        value: ev(dw[0]),
        target: { label: dw[1].replace(/:+$/, "") },
      });
      if (pendingSwitch.cases.length === pendingSwitch.size) {
        items.push({
          kind: "switch",
          operands: pendingSwitch.operands,
          cases: pendingSwitch.cases,
        });
        pendingSwitch = null;
      }
      continue;
    }

    // Label definition (jump/call target).
    const labelDef = mnemonic.match(/^([A-Za-z_][\w]*::?|\d+\$:)$/);
    if (labelDef && argStr === "") {
      const name = labelDef[1].replace(/:+$/, "");
      items.push({ kind: "label", name });
      continue;
    }

    if (mnemonic === "VM_RPN") { inRpn = true; rpnBytes = []; rpnRelocs = []; continue; }
    if (mnemonic === "VM_STOP") { items.push({ kind: "stop" }); continue; }
    if (mnemonic === "VM_SWITCH") {
      // VM_SWITCH IDX, SIZE, N  followed by SIZE `.dw value, label` case lines.
      const a = splitArgs(argStr);
      const size = ev(a[1]);
      pendingSwitch = { operands: [ev(a[0]), size, ev(a[2])], size, cases: [] };
      if (size === 0) {
        items.push({ kind: "switch", operands: pendingSwitch.operands, cases: [] });
        pendingSwitch = null;
      }
      continue;
    }

    if (mnemonic === "VM_RAISE") {
      const a = splitArgs(argStr);
      const code = ev(a[0]);
      if (code === 2 /* EXCEPTION_CHANGE_SCENE */) {
        // Emit the raise with a 2-byte scene-index payload (replacing GB's 3-byte
        // scene far-ptr, which the following IMPORT_FAR_PTR_DATA becomes).
        items.push({ kind: "op", op: 0x27, operands: [code, 2] });
        pendingSceneChange = true;
      } else {
        // reset/save/load/terminate aren't bridged yet; drop the raise (its inline
        // data, if any, is dropped by the IMPORT_FAR_PTR_DATA handler below).
        skipped.push(`VM_RAISE ${argStr.trim()}`.trim());
      }
      continue;
    }
    if (mnemonic === "IMPORT_FAR_PTR_DATA") {
      const sym = (splitArgs(argStr)[0] ?? "").replace(/:+$/, "");
      if (pendingSceneChange) {
        const idx = sceneIndex?.(sym);
        if (idx === undefined) {
          throw new Error(
            `GBA: scene change targets unknown scene "${sym}" (no gba_scenes entry)`,
          );
        }
        items.push({ kind: "raw", bytes: [idx & 0xff, (idx >> 8) & 0xff] });
        pendingSceneChange = false;
      } else {
        skipped.push(`IMPORT_FAR_PTR_DATA ${sym}`); // unbridged far data
      }
      continue;
    }

    if (SKIP_MACROS.has(mnemonic)) {
      skipped.push(`${mnemonic} ${argStr.trim()}`.trim());
      continue;
    }

    const expand = EXPAND_MACROS[mnemonic];
    if (expand) {
      const produced = expand(splitArgs(argStr), ev);
      if (produced) items.push(...produced);
      else skipped.push(`${mnemonic} ${argStr.trim()}`.trim());
      continue;
    }

    const op = MACRO_TO_OP[mnemonic];
    if (op === undefined) {
      throw new Error(`Unsupported GBVM macro "${mnemonic}" (line: "${line}")`);
    }
    const kinds: GbaOperandType[] = GBA_OPCODE_SPECS[op] ?? [];
    const args = splitArgs(argStr);
    const operands = kinds.map((kind, i) => {
      if (args[i] === undefined) throw new Error(`${mnemonic}: missing operand ${i}`);
      if (kind === "ptr") return { label: args[i].replace(/:+$/, "") };
      return ev(args[i]);
    });
    items.push({ kind: "op", op, operands });
  }

  if (inRpn) throw new Error("Unterminated VM_RPN block (no .R_STOP)");
  if (pendingSwitch) throw new Error("Incomplete VM_SWITCH case table");
  return { items, skipped };
}
