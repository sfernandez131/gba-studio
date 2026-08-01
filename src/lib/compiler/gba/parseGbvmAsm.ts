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
  // actor movement (M3b). gbavm-internal opcode numbers (the bridge translates GBVM
  // macro names, so these need not match GBVM's byte values).
  VM_ACTOR_MOVE_TO_INIT: 0x32,
  VM_ACTOR_SET_DIR: 0x34,
  VM_ACTOR_MOVE_TO_X: 0x36,
  VM_ACTOR_MOVE_TO_Y: 0x37,
  VM_ACTOR_MOVE_TO_XY: 0x38,
  VM_ACTOR_MOVE_TO_SET_DIR_X: 0x39,
  VM_ACTOR_MOVE_TO_SET_DIR_Y: 0x3b,
  VM_ACTOR_SET_ANIM_MOVING: 0x3c,
  // actor properties (M10a)
  VM_ACTOR_SET_MOVE_SPEED: 0x3e,
  VM_ACTOR_SET_HIDDEN: 0x3f,
  VM_ACTOR_GET_DIR: 0x40,
  // animation states (M10c): the state operand is the global STATE_* index
  // from game_globals.i, already merged into the operand evaluator (M4h).
  VM_ACTOR_SET_ANIM_SET: 0x41,
  // M10e: actor flags / collision toggle / single-op blocking Move To
  VM_ACTOR_SET_FLAGS: 0x44,
  VM_ACTOR_SET_COLL_ENABLED: 0x45,
  VM_ACTOR_MOVE_TO: 0x46,
  VM_ACTOR_MOVE_CANCEL: 0x3d,
  VM_SET_SPRITE_VISIBLE: 0x51,
  VM_INPUT_GET: 0x54,
  VM_FADE: 0x57, // gbavm no-op
  VM_SET_SPRITE_MODE: 0x5d, // gbavm no-op
  VM_ACTOR_GET_ANGLE: 0x86,
  VM_SIN_SCALE: 0x89,
  VM_COS_SCALE: 0x8a,
  // Projectiles (M10f): TYPE is the runtime def slot, IDX resolves to the
  // {x, y, angle} block Launch Projectile pushes on the VM stack.
  VM_PROJECTILE_LAUNCH: 0x80,
  VM_MEMSET: 0x76,
  VM_MEMCPY: 0x77,
  // Choice / menu (M11a): IDX receives the result; followed by COUNT .MENUITEM
  // rows (captured in the parse loop as a raw 6-byte-per-item table).
  VM_CHOICE: 0x48,
  // M12c: mask + options, then one inline 8-byte row (4 RGB555 words) per mask bit.
  VM_LOAD_PALETTE: 0x7c,
  // M8d: rotate/scale the affine (Mode-7) scene background. angle (whole degrees)
  // + scale (x256) are immediate i16 constants -> hw_bg_transform. GBA-only op;
  // the event that emits it is gated on platform === "gba".
  VM_SET_BG_TRANSFORM: 0x97,
  // M8d: affine bg auto-spin velocity (deg/frame x256) -> hw_bg_spin. GBA-only.
  VM_SET_BG_SPIN: 0x98,
  // scene stack (no operands): push current scene, pop back to it, pop to the base.
  VM_SCENE_PUSH: 0x68,
  VM_SCENE_POP: 0x69,
  VM_SCENE_POP_ALL: 0x6a,
  // VM_LOAD_TEXT / VM_DISPLAY_TEXT are handled specially in the parse loop (the text
  // string is captured from the inline .asciz and emitted after op 0x90).
  // dialogue overlay window box (M4d): the panel the engine draws behind the text.
  // gbavm-internal opcode numbers (the bridge translates GBVM macro names).
  VM_OVERLAY_MOVE_TO: 0x91,
  VM_OVERLAY_SHOW: 0x92,
  VM_OVERLAY_HIDE: 0x93,
  // M4q wait codes: VM_OVERLAY_WAIT blocks until its UI conditions (window slid /
  // text revealed / button); the dialogue A-wait now lives here (the display op only
  // reveals). VM_DISPLAY_TEXT_EX (0x95) is handled specially in the parse loop.
  VM_OVERLAY_WAIT: 0x94,
  // M11c: the box width (GB window tiles); x comes from MOVE_TO, height from the
  // text sizing. Color/frame options accepted + ignored by the engine for now.
  VM_OVERLAY_CLEAR: 0x96,
  // Audio master volume (M5c): VM_SOUND_MASTERVOL <vol> -> op 0x63 [vol].
  VM_SOUND_MASTERVOL: 0x63,
  // SRAM save (M6a): SAVE_PEEK (check/read a save) + SAVE_CLEAR. Save/load themselves
  // are VM_RAISE EXCEPTION_SAVE/LOAD (already bridged via op 0x27).
  VM_SAVE_PEEK: 0x2e,
  VM_SAVE_CLEAR: 0x2f,
  // Timers (M6f): PREPARE arms a slot with a script (addr is a ptr -> collected proc), SET
  // starts it firing every N ticks, STOP/RESET disable / restart it.
  VM_TIMER_PREPARE: 0x70,
  VM_TIMER_SET: 0x71,
  VM_TIMER_STOP: 0x72,
  VM_TIMER_RESET: 0x73,
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
  // Music (M5a): VM_MUSIC_PLAY <bank>, <_<sym>_Data>, <loop> -> op 0x60 [track, loop];
  // the track symbol resolves to the emitted DMG track index via dataSymbols (the bank
  // operand is dropped - GBA is flat). Drop the op if the track isn't emitted (e.g. an
  // unsupported .uge track) so the project still builds. VM_MUSIC_STOP -> op 0x61.
  VM_MUSIC_PLAY: (a, ev) => {
    let track: number;
    try {
      track = ev(a[1]) & 0xff;
    } catch {
      return null;
    }
    return [
      {
        kind: "op",
        op: 0x60,
        operands: [track, a.length > 2 ? ev(a[2]) & 0xff : 0],
      },
    ];
  },
  VM_MUSIC_STOP: () => [{ kind: "op", op: 0x61, operands: [] }],
  // Sound effects (M5b): VM_SFX_PLAY <bank>, _<sym>, <mute_mask>, <prio> -> op 0x66
  // [sfx]; the sound symbol resolves to the emitted bn::sound index via dataSymbols
  // (bank/mute_mask/priority dropped - Butano mixes DirectSound itself). Drop the op
  // if the sound isn't emitted (e.g. an unsupported vgm/fxhammer effect).
  VM_SFX_PLAY: (a, ev) => {
    let sfx: number;
    try {
      sfx = ev(a[1]) & 0xff;
    } catch {
      return null;
    }
    return [{ kind: "op", op: 0x66, operands: [sfx] }];
  },
  // Projectiles (M10f): VM_PROJECTILE_LOAD_TYPE <dest>, <src>, <bank>,
  // _global_projectiles_<n> -> op 0x81 [dest, src, base]; the table symbol
  // resolves to its base index in the engine's flattened
  // gba_global_projectile_defs[] via dataSymbols (bank dropped - GBA is flat).
  // Drop the op if the table wasn't emitted so the project still builds.
  VM_PROJECTILE_LOAD_TYPE: (a, ev) => {
    let dest: number;
    let src: number;
    let base: number;
    try {
      dest = ev(a[0]) & 0xff;
      src = ev(a[1]) & 0xff;
      base = ev(a[3]) & 0xff;
    } catch {
      return null;
    }
    return [{ kind: "op", op: 0x81, operands: [dest, src, base] }];
  },
  // Spritesheet swap (M10h): VM_ACTOR_SET_SPRITESHEET <actor-ref>, <bank>,
  // _<sprite.symbol> -> op 0x47 [ref, sheet]; the sprite symbol resolves to its
  // global-sprite index via dataSymbols (bank dropped - GBA is flat). Drop the
  // op if the sheet wasn't emitted so the project still builds.
  VM_ACTOR_SET_SPRITESHEET: (a, ev) => {
    let refVal: number;
    let sheet: number;
    try {
      refVal = ev(a[0]);
      sheet = ev(a[2]) & 0xff;
    } catch {
      return null;
    }
    return [{ kind: "op", op: 0x47, operands: [refVal, sheet] }];
  },
  // Emotes (M10d): VM_ACTOR_EMOTE <actor-ref>, <bank>, _<emote.symbol> -> op 0x42
  // [ref, emote]; the emote symbol resolves to the emitted sprite index via
  // dataSymbols (bank dropped - GBA is flat). Drop the op if the emote wasn't
  // emitted so the project still builds.
  VM_ACTOR_EMOTE: (a, ev) => {
    let refVal: number;
    let emote: number;
    try {
      refVal = ev(a[0]);
      emote = ev(a[2]) & 0xff;
    } catch {
      return null;
    }
    return [{ kind: "op", op: 0x42, operands: [refVal, emote] }];
  },
  // VM_RET[_FAR][_N] -> opcode with explicit arg count (0 when omitted).
  VM_RET: (a, ev) => [
    { kind: "op", op: 0x05, operands: [a.length ? ev(a[0]) : 0] },
  ],
  VM_RET_N: (a, ev) => [{ kind: "op", op: 0x05, operands: [ev(a[0])] }],
  VM_RET_FAR: (a, ev) => [
    { kind: "op", op: 0x0b, operands: [a.length ? ev(a[0]) : 0] },
  ],
  VM_RET_FAR_N: (a, ev) => [{ kind: "op", op: 0x0b, operands: [ev(a[0])] }],
  // Engine-symbol writes -> an RPN raw-memory write to the symbol's address (mirrors
  // vm.i). ADDR is arg 0, the value/source is arg 1. The 32-bit address is a "ram"
  // symbolic relocation the linker resolves to the engine var it allocates.
  // VM_SET_CONST_*: write a constant.  VM_SET_*: write VM variable IDXA's value.
  VM_SET_CONST_INT8: (a, ev) => [
    memSetItem(MEM_I8, [RPN_INT8, ev(a[1]) & 0xff], a[0], ev),
  ],
  VM_SET_CONST_UINT8: (a, ev) => [
    memSetItem(MEM_U8, [RPN_INT8, ev(a[1]) & 0xff], a[0], ev),
  ],
  VM_SET_CONST_INT16: (a, ev) => {
    const v = ev(a[1]);
    return [
      memSetItem(MEM_I16, [RPN_INT16, v & 0xff, (v >> 8) & 0xff], a[0], ev),
    ];
  },
  VM_SET_CONST_UINT16: (a, ev) => {
    const v = ev(a[1]);
    return [
      memSetItem(MEM_I16, [RPN_INT16, v & 0xff, (v >> 8) & 0xff], a[0], ev),
    ];
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
    return [
      memSetItem(MEM_I16, [RPN_REF, i & 0xff, (i >> 8) & 0xff], a[0], ev),
    ];
  },
  VM_SET_UINT16: (a, ev) => {
    const i = ev(a[1]);
    return [
      memSetItem(MEM_I16, [RPN_REF, i & 0xff, (i >> 8) & 0xff], a[0], ev),
    ];
  },
};

// Macros we intentionally drop during bring-up (need machinery not yet ported).
// Dropping is safe for these specific ops on gbavm's stubbed scaffold; each drop
// is reported so nothing disappears silently.
const SKIP_MACROS = new Set<string>([
  // VM_RANDOMIZE expands to an RPN read of GB-only _DIV_REG/_game_time; gbavm seeds
  // its RNG once at boot from a hardware timer instead (P0).
  "VM_RANDOMIZE",
  // M4: VM_LOAD_TEXT + VM_DISPLAY_TEXT/_EX are handled specially (the text is captured
  // from the inline .asciz and rendered via op 0x90/0x95); VM_OVERLAY_SHOW/MOVE_TO/HIDE
  // /WAIT are bridged (M4d box + M4q wait). The remaining overlay/window ops are
  // dropped so projects build/run (clear/scroll/submap/printer come later).
  "VM_OVERLAY_SCROLL",
  "VM_OVERLAY_SET_SCROLL",
  "VM_OVERLAY_SET_SUBMAP_EX",
  "VM_OVERLAY_SET_MAP_TILES",
  "VM_SET_TEXT_SOUND",
  "VM_SET_FONT",
  "VM_SWITCH_TEXT_LAYER",
  "VM_PRINTER_DETECT",
  // M5c: VM_MUSIC_MUTE mutes individual DMG channels (a GB channel-sharing concern so
  // SFX can borrow a music channel). On GBA our SFX run on a separate DirectSound mixer,
  // so per-channel music muting is not needed - dropped.
  "VM_MUSIC_MUTE",
]);

// GBVM constants referenced by name in operands/RPN. Local `.X = n` defines found
// in the .s are layered on top of these.
const BASE_CONSTS: Record<string, number> = {
  // sprite mode
  ".MODE_8X8": 0,
  ".MODE_8X16": 1,
  // VM_GET_FAR object size
  ".GET_BYTE": 0,
  ".GET_WORD": 1,
  // directions
  ".DIR_DOWN": 0,
  ".DIR_RIGHT": 1,
  ".DIR_UP": 2,
  ".DIR_LEFT": 3,
  // actor move-to attribute flags (gbavm ignores collision/axis bits - it uses the
  // emitted op sequence - but the operand must still evaluate to a byte).
  ".ACTOR_ATTR_CHECK_COLL": 0x01,
  ".ACTOR_ATTR_H_FIRST": 0x02,
  ".ACTOR_ATTR_DIAGONAL": 0x04,
  ".ACTOR_ATTR_CHECK_COLL_WALLS": 0x08,
  ".ACTOR_ATTR_CHECK_COLL_ACTORS": 0x10,
  ".ACTOR_ATTR_RELATIVE_SNAP_PX": 0x20,
  ".ACTOR_ATTR_RELATIVE_SNAP_TILE": 0x40,
  // fade
  ".FADE_OUT": 0x00,
  ".FADE_IN": 0x02,
  ".FADE_MODAL": 0x01,
  ".FADE_NONMODAL": 0x00,
  // dialogue overlay window box (M4d). MOVE_TO/SHOW speeds are negative sentinels;
  // the engine reads them as int8 (-1 slide in, -2 slide out, -3 instant).
  ".OVERLAY_IN_SPEED": -1,
  ".OVERLAY_TEXT_IN_SPEED": -1,
  ".OVERLAY_OUT_SPEED": -2,
  ".OVERLAY_TEXT_OUT_SPEED": -2,
  ".OVERLAY_SPEED_INSTANT": -3,
  ".MENU_CLOSED_Y": 0x12,
  // Actor flags (vm.i, M10e): HIDDEN/ANIM_NOLOOP/COLLISION are honored; the
  // others land in the mask and are ignored by the engine.
  ".ACTOR_FLAG_PINNED": 0x01,
  ".ACTOR_FLAG_HIDDEN": 0x02,
  ".ACTOR_FLAG_ANIM_NOLOOP": 0x04,
  ".ACTOR_FLAG_COLLISION": 0x08,
  ".ACTOR_FLAG_PERSISTENT": 0x10,
  // VM_LOAD_PALETTE flags (M12c).
  ".PALETTE_COMMIT": 1,
  ".PALETTE_BKG": 2,
  ".PALETTE_SPRITE": 4,
  // VM_CHOICE menu options (M11a).
  ".UI_MENU_STANDARD": 0,
  ".UI_MENU_LAST_0": 1,
  ".UI_MENU_CANCEL_B": 2,
  ".UI_MENU_SET_START": 4,
  ".UI_COLOR_BLACK": 0,
  ".UI_COLOR_WHITE": 1,
  ".UI_DRAW_FRAME": 1,
  ".UI_AUTO_SCROLL": 2,
  // VM_OVERLAY_WAIT (M4q): modal flag + the wait-condition bitfield (vm.i).
  ".UI_NONMODAL": 0,
  ".UI_MODAL": 1,
  ".UI_WAIT_NONE": 0,
  ".UI_WAIT_WINDOW": 1,
  ".UI_WAIT_TEXT": 2,
  ".UI_WAIT_BTN_A": 4,
  ".UI_WAIT_BTN_B": 8,
  ".UI_WAIT_BTN_ANY": 16,
  // VM_DISPLAY_TEXT_EX (M4q): display flags + tile.
  ".DISPLAY_DEFAULT": 0,
  ".DISPLAY_PRESERVE_POS": 1,
  ".TEXT_TILE_CONTINUE": 0xff,
  // VM_MUSIC_PLAY loop flag (M5a).
  ".MUSIC_NO_LOOP": 0,
  ".MUSIC_LOOP": 1,
  // Camera shake axis flags (M6h). The Camera Shake event writes these to the shake-
  // settings global; gbavm's shake is a fixed horizontal jitter, so the value only needs
  // to resolve (it lands in an allocated engine var the engine ignores).
  ".CAMERA_SHAKE_X": 1,
  ".CAMERA_SHAKE_Y": 2,
  // VM_RAISE exception codes (vm_exceptions.h)
  EXCEPTION_RESET: 1,
  EXCEPTION_CHANGE_SCENE: 2,
  EXCEPTION_SAVE: 3,
  EXCEPTION_LOAD: 4,
  EXCEPTION_TERMINATE: 5,
  // camera lock flags (written to _camera_settings)
  ".CAMERA_LOCK": 0x03,
  ".CAMERA_LOCK_X": 0x01,
  ".CAMERA_LOCK_Y": 0x02,
  ".CAMERA_UNLOCK": 0x00,
  ".CAMERA_LOCK_X_MIN": 0x04,
  ".CAMERA_LOCK_X_MAX": 0x08,
  ".CAMERA_LOCK_Y_MIN": 0x10,
  ".CAMERA_LOCK_Y_MAX": 0x20,
  // if / rpn conditions
  ".EQ": 1,
  ".LT": 2,
  ".LTE": 3,
  ".GT": 4,
  ".GTE": 5,
  ".NE": 6,
  // rpn operators
  ".AND": 7,
  ".OR": 8,
  ".NOT": 9,
  ".ADD": 10,
  ".SUB": 11,
  ".MUL": 12,
  ".DIV": 13,
  ".MOD": 14,
  ".B_AND": 15,
  ".B_OR": 16,
  ".B_XOR": 17,
  ".SHL": 18,
  ".SHR": 19,
  ".MIN": 20,
  ".MAX": 21,
  ".ATAN2": 22,
  ".ABS": 23,
  ".B_NOT": 24,
  ".NEG": 25,
  ".ISQRT": 26,
  ".RND": 27,
  // rpn memory-access type tags (char codes) - only needed if REF_MEM is supported
  ".MEM_I8": 0x69,
  ".MEM_U8": 0x75,
  ".MEM_I16": 0x49,
  // stack-arg aliases (vm.i: .ARG0 = -1 .. .ARG16 = -17)
  ".ARG0": -1,
  ".ARG1": -2,
  ".ARG2": -3,
  ".ARG3": -4,
  ".ARG4": -5,
  ".ARG5": -6,
  ".ARG6": -7,
  ".ARG7": -8,
  ".ARG8": -9,
  ".ARG9": -10,
  ".ARG10": -11,
  ".ARG11": -12,
  ".ARG12": -13,
  ".ARG13": -14,
  ".ARG14": -15,
  ".ARG15": -16,
  ".ARG16": -17,
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
  s.trim() === ""
    ? []
    : s
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a !== "");

// GB Studio text control codes (low bytes embedded in the string) and how many
// parameter bytes each one carries (see scriptBuilder/helpers.ts textCode*): set
// speed \001<n>, set font \002<n>, goto \003<x><y>, goto-rel \004<x><y>, input
// \006<mask>. We must skip a code AND its params together so a param byte that
// happens to fall in the printable range doesn't leak out as a glyph.
const TEXT_CODE_PARAMS: Record<number, number> = {
  0x01: 1,
  0x02: 1,
  0x03: 2,
  0x04: 2,
  0x06: 1,
};

// GB Studio bakes a dialogue avatar into the text as a fixed 16-byte font-glyph code
// at the start (_getAvatarCode): setSpeed0 (\001\001) + setFont<avatarFont> (\002 F) +
// 4 avatar chars in a 2x2 (c0 c1 \n c2 c3) + setSpeed2 (\001\003) + gotoRel 1,-1
// (\004\001\377) + setFont0 (\002\001). We match the (highly distinctive) structure and
// recover the avatar index from the char base c0 = ((avatarIndex*4)%64)+64, so
// avatarIndex%16 = (c0-64)/4 (exact for the first 16 avatars; higher banks would also
// need the avatar-font index, deferred). Returns the index, or -1 if not an avatar.
const AVATAR_CODE_LEN = 16;
const detectAvatar = (bytes: number[]): number => {
  if (
    bytes.length >= AVATAR_CODE_LEN &&
    bytes[0] === 0x01 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x02 &&
    bytes[4] >= 0x40 &&
    bytes[6] === 0x0a &&
    bytes[9] === 0x01 &&
    bytes[10] === 0x03 &&
    bytes[11] === 0x04 &&
    bytes[12] === 0x01 &&
    bytes[13] === 0xff &&
    bytes[14] === 0x02 &&
    bytes[15] === 0x01
  ) {
    return Math.floor((bytes[4] - 64) / 4);
  }
  return -1;
};

// Parse a `.asciz "..."` line (VM_LOAD_TEXT's inline string) into the byte values
// the engine renders: unescape C escapes, then keep printable ASCII, newline (0x0A,
// multi-line) and the set-speed code (\001<n>, kept inline so the engine can vary
// the typewriter rate). GB Studio's other text control codes are dropped together
// with their parameter bytes (font/goto/etc. are interpreted in later milestones;
// for now they're skipped cleanly so nothing renders as junk). A leading avatar code
// (detectAvatar) is stripped so its glyph chars don't leak as garbage; `avatarOut`,
// when given, receives the avatar index ({ index }).
const parseAsciz = (line: string, avatarOut?: { index: number }): number[] => {
  const m = line.match(/"((?:[^"\\]|\\.)*)"/);
  if (!m) return [];
  const raw = m[1];
  // Phase 1: unescape the C-string (incl. \NNN octal) into a raw byte stream.
  const bytes: number[] = [];
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, "\\": 92, '"': 34 };
  for (let i = 0; i < raw.length; i++) {
    let code = raw.charCodeAt(i);
    if (raw[i] === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next >= "0" && next <= "7") {
        let oct = "";
        let j = i + 1;
        while (
          j < raw.length &&
          raw[j] >= "0" &&
          raw[j] <= "7" &&
          oct.length < 3
        ) {
          oct += raw[j];
          j++;
        }
        code = parseInt(oct, 8);
        i = j - 1;
      } else {
        code = esc[next] ?? next.charCodeAt(0);
        i++;
      }
    }
    bytes.push(code & 0xff);
  }
  // A leading avatar code: record its index and skip its 16 bytes in phase 2.
  const avatarIndex = detectAvatar(bytes);
  if (avatarOut) avatarOut.index = avatarIndex;
  const startAt = avatarIndex >= 0 ? AVATAR_CODE_LEN : 0;
  // Phase 2: apply the text-code grammar.
  const out: number[] = [];
  for (let i = startAt; i < bytes.length; i++) {
    const code = bytes[i];
    if (code === 0x0a)
      out.push(0x0a); // newline (multi-line dialogue)
    else if (code >= 0x20 && code <= 0x7e)
      out.push(code); // printable
    else if (code === 0x01) {
      // set-speed: keep inline (code + 1 param byte) so the engine can vary the
      // typewriter rate; the engine skips these bytes when rendering glyphs.
      out.push(0x01);
      if (i + 1 < bytes.length) out.push(bytes[++i]);
    } else if (code === 0x02) {
      // set-font: keep inline (code + 1 param byte = fontIndex+1) so the engine can
      // switch font mid-text (M4p); the engine treats it as a segment boundary. A
      // leading avatar code (with its own \002) is already stripped above.
      out.push(0x02);
      if (i + 1 < bytes.length) out.push(bytes[++i]);
    } else if (code === 0x03) {
      // goto x,y: keep inline (code + 2 param bytes) so the engine can indent
      // choice/menu lines to the authored column (M11a); the y param rides on
      // the \n line breaks.
      out.push(0x03);
      if (i + 1 < bytes.length) out.push(bytes[++i]);
      if (i + 1 < bytes.length) out.push(bytes[++i]);
    } else if (code in TEXT_CODE_PARAMS) i += TEXT_CODE_PARAMS[code]; // skip code + params
    // other unknown control bytes (e.g. 0x0D scroll) are dropped for now
  }
  return out;
};

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
    if (!Number.isFinite(v))
      throw new Error(`Expression "${raw}" did not evaluate to a number`);
    return v | 0;
  };
}

const encodeRpnRef = (op: number, idx: number): number[] => [
  op,
  idx & 0xff,
  (idx >> 8) & 0xff,
];

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
    case ".R_INT8":
      out.push(RPN_INT8, ev(args[0]) & 0xff);
      return false;
    case ".R_INT16": {
      const v = ev(args[0]);
      out.push(RPN_INT16, v & 0xff, (v >> 8) & 0xff);
      return false;
    }
    case ".R_REF":
      out.push(...encodeRpnRef(RPN_REF, ev(args[0])));
      return false;
    case ".R_REF_IND":
      out.push(...encodeRpnRef(RPN_REF_IND, ev(args[0])));
      return false;
    case ".R_REF_SET":
      out.push(...encodeRpnRef(RPN_REF_SET, ev(args[0])));
      return false;
    case ".R_REF_SET_IND":
      out.push(...encodeRpnRef(RPN_REF_SET_IND, ev(args[0])));
      return false;
    case ".R_OPERATOR":
      out.push(ev(args[0]) & 0xff);
      return false;
    case ".R_STOP":
      out.push(RPN_STOP);
      return true; // block complete
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
 * Parse a `game_globals.i` include into a name -> value map (e.g. VAR_SCORE = 3).
 * GB Studio emits one plain `NAME = <int>` per line (variable indices into the VM's
 * shared script_memory, plus state-machine constants); pass the result to
 * parseGbvmAsm's `globals` option so VAR_ operands resolve.
 */
export function parseGameGlobals(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    const m = line.match(/^([A-Za-z_]\w*)\s*=\s*(-?\d+)$/);
    if (m) out[m[1]] = parseInt(m[2], 10);
  }
  return out;
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
    // Global-variable defines from game_globals.i (VAR_X = <script_memory index>).
    // The script .s only `.include`s that file, so the bridge must be told the
    // values to resolve VAR_ operands (Set/If Variable, RPN var refs, M4h).
    globals?: Record<string, number>;
    // Data-asset symbols the bridge resolves to emitted indices, e.g. music track data
    // (`_<sym>_Data` -> DMG track index) for VM_MUSIC_PLAY (M5a).
    dataSymbols?: Record<string, number>;
  } = {},
): ParseResult {
  const { entrySymbol, sceneIndex } = opts;
  const consts: Record<string, number> = {
    ...BASE_CONSTS,
    ...(opts.globals ?? {}),
    ...(opts.dataSymbols ?? {}),
  };

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
  let pendingSwitch: {
    operands: [number, number, number];
    size: number;
    cases: { value: number; target: { label: string } }[];
  } | null = null;
  // VM_RAISE EXCEPTION_CHANGE_SCENE is followed by an IMPORT_FAR_PTR_DATA scene
  // pointer; this flag bridges that pair into a 2-byte scene index.
  let pendingSceneChange = false;
  // VM_CHOICE is followed by COUNT `.MENUITEM x, y, iL, iR, iU, iD` rows; each
  // becomes 6 raw bytes the engine reads as the menu-item table (M11a).
  let pendingMenuItems = 0;
  // VM_LOAD_PALETTE is followed by one .CGB_PAL/.DMG_PAL row per set mask bit;
  // each becomes 8 raw bytes (4 little-endian RGB555 words) the engine applies
  // to the bg palette banks (M12c).
  let pendingPalRows = 0;
  let active = entrySymbol === undefined; // when scoping to an entry, wait for it
  // M4 dialogue: VM_LOAD_TEXT sets captureText so the next .asciz line is captured as
  // the string to render with the following VM_DISPLAY_TEXT (op 0x90 + inline text).
  let captureText = false;
  let textBytes: number[] = [];
  // M4i interpolation: VM_LOAD_TEXT N (N>0) is followed by a `.dw <var>, ...` line of
  // N variable indices, then the `.asciz` with %d placeholders. captureTextVars arms
  // capturing that .dw; textVarIndices feeds the op-0x90 payload so the engine can
  // read each variable's value (script_memory[idx]) and substitute its decimal.
  let captureTextVars = false;
  let textVarIndices: number[] = [];
  // M4m avatars: parseAsciz strips a leading avatar code and reports its index here;
  // VM_DISPLAY_TEXT carries it as the op-0x90 avatar byte (0xff = no avatar).
  let textAvatar = -1;

  const DIRECTIVES =
    /^\.(module|include|globl|area|org|optsdcc|ds|incbin|bndry|asciz|ascii)\b/;

  for (const rawLine of asm.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line === "") continue;

    // Entry scoping: start at `_entry::`, stop at the next top-level routine label.
    if (entrySymbol !== undefined) {
      const lbl = line.match(/^([A-Za-z_][\w]*)::?$/);
      if (lbl) {
        if (lbl[1] === entrySymbol) {
          active = true;
          continue;
        }
        if (active) break; // reached the following routine
      }
      if (!active) continue;
    }

    // Capture the `.dw <var>, ...` line of variable indices that follows
    // VM_LOAD_TEXT N (N>0) for interpolation, before the generic .dw/macro handling.
    if (captureTextVars && /^\.dw\b/.test(line)) {
      textVarIndices = splitArgs(line.replace(/^\.dw\b/, "")).map((s) => ev(s));
      captureTextVars = false;
      continue;
    }
    // Capture VM_LOAD_TEXT's inline string (the .asciz right after it) for the next
    // VM_DISPLAY_TEXT, before the generic directive skip drops it.
    if (captureText && /^\.ascii?z?\b/.test(line)) {
      const avatarOut = { index: -1 };
      textBytes = parseAsciz(line, avatarOut);
      textAvatar = avatarOut.index;
      captureText = false;
      continue;
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

    if (mnemonic === "VM_RPN") {
      inRpn = true;
      rpnBytes = [];
      rpnRelocs = [];
      continue;
    }
    if (mnemonic === "VM_STOP") {
      items.push({ kind: "stop" });
      continue;
    }
    if (mnemonic === "VM_SWITCH") {
      // VM_SWITCH IDX, SIZE, N  followed by SIZE `.dw value, label` case lines.
      const a = splitArgs(argStr);
      const size = ev(a[1]);
      pendingSwitch = { operands: [ev(a[0]), size, ev(a[2])], size, cases: [] };
      if (size === 0) {
        items.push({
          kind: "switch",
          operands: pendingSwitch.operands,
          cases: [],
        });
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
      } else if (code === 3 || code === 4 /* EXCEPTION_SAVE / LOAD (M6a) */) {
        // Save/load: keep the raise with its 1-byte slot payload (the following
        // .SAVE_SLOT byte); the main loop persists/restores SRAM on the exception.
        items.push({
          kind: "op",
          op: 0x27,
          operands: [code, a.length > 1 ? ev(a[1]) : 1],
        });
      } else {
        // reset/terminate aren't bridged yet; drop the raise (its inline data, if
        // any, is dropped by the IMPORT_FAR_PTR_DATA handler below).
        skipped.push(`VM_RAISE ${argStr.trim()}`.trim());
      }
      continue;
    }
    if (mnemonic === ".SAVE_SLOT") {
      // The 1-byte slot payload for a preceding VM_RAISE EXCEPTION_SAVE/LOAD (M6a).
      items.push({
        kind: "raw",
        bytes: [ev(splitArgs(argStr)[0] ?? "0") & 0xff],
      });
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

    // M4 dialogue text: VM_LOAD_TEXT arms the .asciz capture (and the .dw var capture
    // when its N operand is > 0); VM_DISPLAY_TEXT emits op 0x90 + a var count + the N
    // 16-bit variable indices + the inline null-terminated text the engine renders.
    if (mnemonic === "VM_LOAD_TEXT") {
      captureText = true;
      const a = splitArgs(argStr);
      captureTextVars = a.length > 0 && ev(a[0]) > 0;
      continue;
    }
    if (mnemonic === "VM_DISPLAY_TEXT") {
      const varBytes: number[] = [];
      for (const idx of textVarIndices)
        varBytes.push(idx & 0xff, (idx >> 8) & 0xff);
      const avatarByte = textAvatar >= 0 ? textAvatar & 0xff : 0xff; // 0xff = no avatar
      items.push({
        kind: "raw",
        bytes: [
          0x90,
          avatarByte,
          textVarIndices.length & 0xff,
          ...varBytes,
          ...textBytes,
          0,
        ],
      });
      textBytes = [];
      textVarIndices = [];
      textAvatar = -1;
      continue;
    }
    if (mnemonic === "VM_DISPLAY_TEXT_EX") {
      // Like VM_DISPLAY_TEXT but carries the display flag (bit 0 = .DISPLAY_PRESERVE_POS
      // = append) so the engine continues an existing box across !W: wait chunks (M4q).
      const exArgs = splitArgs(argStr);
      const flag = exArgs.length > 0 ? ev(exArgs[0]) & 0xff : 0;
      const varBytes: number[] = [];
      for (const idx of textVarIndices)
        varBytes.push(idx & 0xff, (idx >> 8) & 0xff);
      const avatarByte = textAvatar >= 0 ? textAvatar & 0xff : 0xff;
      items.push({
        kind: "raw",
        bytes: [
          0x95,
          flag,
          avatarByte,
          textVarIndices.length & 0xff,
          ...varBytes,
          ...textBytes,
          0,
        ],
      });
      textBytes = [];
      textVarIndices = [];
      textAvatar = -1;
      continue;
    }

    // The COUNT `.MENUITEM x, y, iL, iR, iU, iD` rows after VM_CHOICE become the
    // raw menu-item table the engine's choice handler reads (M11a).
    if (pendingMenuItems > 0 && mnemonic === ".MENUITEM") {
      const vals = splitArgs(argStr).map((v) => ev(v) & 0xff);
      if (vals.length !== 6) {
        throw new Error(
          `.MENUITEM expected 6 values but got "${argStr.trim()}"`,
        );
      }
      items.push({ kind: "raw", bytes: vals });
      pendingMenuItems--;
      continue;
    }

    // Palette rows after VM_LOAD_PALETTE (M12c): .CGB_PAL carries 12 5-bit
    // channels (4 colours); .DMG_PAL carries 4 shade indices packed into one
    // word + 3 zero words (GB's shape) - kept verbatim for stream sync, the
    // engine only meaningfully applies CGB rows (DMG semantics are M12d).
    if (pendingPalRows > 0 && mnemonic === ".CGB_PAL") {
      // Channels are comma-separated triples with SPACES between colours
      // (".CGB_PAL r,g,b r,g,b r,g,b r,g,b") - split on both.
      const v = argStr
        .trim()
        .split(/[\s,]+/)
        .map((x) => ev(x) & 0x1f);
      if (v.length !== 12) {
        throw new Error(
          `.CGB_PAL expected 12 values but got "${argStr.trim()}"`,
        );
      }
      const bytes: number[] = [];
      for (let c = 0; c < 4; c++) {
        const word = v[c * 3] | (v[c * 3 + 1] << 5) | (v[c * 3 + 2] << 10);
        bytes.push(word & 0xff, (word >> 8) & 0xff);
      }
      items.push({ kind: "raw", bytes });
      pendingPalRows--;
      continue;
    }
    if (pendingPalRows > 0 && mnemonic === ".DMG_PAL") {
      const v = argStr
        .trim()
        .split(/[\s,]+/)
        .map((x) => ev(x) & 0x03);
      const word = (v[0] | (v[1] << 2) | (v[2] << 4) | (v[3] << 6)) & 0xffff;
      items.push({
        kind: "raw",
        bytes: [word & 0xff, word >> 8, 0, 0, 0, 0, 0, 0],
      });
      pendingPalRows--;
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
      if (args[i] === undefined)
        throw new Error(`${mnemonic}: missing operand ${i}`);
      if (kind === "ptr") return { label: args[i].replace(/:+$/, "") };
      return ev(args[i]);
    });
    items.push({ kind: "op", op, operands });
    // VM_CHOICE: arm capture of the trailing .MENUITEM table (COUNT = operand 2).
    if (op === 0x48 && typeof operands[2] === "number") {
      pendingMenuItems = operands[2];
    }
    // VM_LOAD_PALETTE: arm capture of one palette row per set mask bit (M12c).
    if (op === 0x7c && typeof operands[0] === "number") {
      let n = 0;
      for (let b = 0; b < 8; b++) if (operands[0] & (1 << b)) n++;
      pendingPalRows = n;
    }
  }

  if (inRpn) throw new Error("Unterminated VM_RPN block (no .R_STOP)");
  if (pendingSwitch) throw new Error("Incomplete VM_SWITCH case table");
  return { items, skipped };
}
