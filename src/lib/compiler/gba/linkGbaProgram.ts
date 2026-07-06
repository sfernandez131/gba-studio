// GBA Studio - GBA project linker (Milestone M1a).
//
// emitGbaBytecode encodes ONE proc to bytes + in-proc (local) relocations,
// recording every cross-proc / native / far-data reference as a symbolic
// relocation (GbaSymReloc) instead of resolving it. This module links a whole set
// of procs together: it resolves each symbolic relocation whose target is another
// proc in the set (script -> script: VM_CALL / VM_CALL_FAR / VM_BEGINTHREAD / ...)
// and emits the combined C source the gbavm engine loads through a generated
// manifest (gba_procs[]). The engine patches both relocation kinds at load:
//   local : *(code + at) = code + target            (offset within the same proc)
//   symbolic: *(code + at) = &targetProc            (another proc's C array)
//
// References to symbols outside the set - native engine functions, engine RAM
// vars, far data - are returned in `unresolved` for the caller to handle (those
// land in M1b/M1c). Their 4-byte fields keep the zero placeholder for now.

import {
  GbaItem,
  GbaProgram,
  emitGbaBytecode,
  formatGbaProgramC,
} from "./emitGbaBytecode";

// A project script proc to link. `symbol` is the GBVM proc symbol exactly as it
// appears in the compiled .s (e.g. "_scene_main_init"); `items` is its parsed
// opcode stream (from parseGbvmAsm).
export interface GbaProc {
  symbol: string;
  items: GbaItem[];
}

// An external symbol a proc references that is NOT another proc in the link set -
// a native engine function, an engine RAM variable, or far data. Surfaced so the
// caller can warn/defer (M1b/M1c) rather than silently shipping a null pointer.
export interface UnresolvedSymbol {
  fromProc: string; // the proc that references it
  symbol: string; // the unresolved external symbol
  at: number; // byte offset of the 4-byte field within fromProc's code
}

export interface LinkedProc {
  symbol: string; // GBVM symbol, e.g. "_scene_main_init"
  cName: string; // C identifier for its byte array, e.g. "scene_main_init"
  program: GbaProgram;
  // resolved symbolic relocations: patch the field at byte offset `at` with the C
  // expression `expr` (another proc's array, or `&engineVar`).
  symRelocs: { at: number; expr: string }[];
}

export interface LinkResult {
  procs: LinkedProc[];
  unresolved: UnresolvedSymbol[];
  engineVars: string[]; // engine RAM variable cNames the linker allocates ("ram" relocs)
  source: string; // combined C for the gbavm build (all procs + vars + manifest)
}

// GBVM proc symbols are written "_name"; the matching C array drops the single
// leading underscore ("_scene_main_init" -> "scene_main_init"). Bank symbols
// ("___bank_name") are never ptr targets, so they never reach the linker.
export const cNameOf = (symbol: string): string => symbol.replace(/^_/, "");

// Native VM functions the gbavm engine provides (src/gba_natives.*). A script's
// VM_INVOKE / VM_CALL_NATIVE reference to one of these resolves to the function's
// address; keep in sync with the engine's include/gba_natives.h.
export const GBA_NATIVE_SYMBOLS = new Set<string>([
  "_wait_frames",
  "_camera_shake_frames",
]);

/**
 * Link a set of script procs into one combined C translation unit.
 * Cross-proc symbolic relocations are resolved against the set; everything else
 * is reported via `unresolved`.
 */
export function linkGbaProgram(procs: GbaProc[]): LinkResult {
  const seen = new Set<string>();
  for (const p of procs) {
    if (seen.has(p.symbol)) {
      throw new Error(`Duplicate proc symbol "${p.symbol}" in link set`);
    }
    seen.add(p.symbol);
  }
  const cNameBySymbol = new Map<string, string>();
  for (const p of procs) cNameBySymbol.set(p.symbol, cNameOf(p.symbol));

  const linked: LinkedProc[] = [];
  const unresolved: UnresolvedSymbol[] = [];
  const engineVars = new Set<string>();
  let usesNatives = false;

  for (const p of procs) {
    const program = emitGbaBytecode(p.items);
    const symRelocs: { at: number; expr: string }[] = [];
    for (const sr of program.symRelocs) {
      if (sr.kind === "ram") {
        // An engine RAM variable (RPN raw-memory write). Allocate it and resolve to
        // its address. The C linker provides &var; the engine patches it in at load.
        const cName = cNameOf(sr.symbol);
        engineVars.add(cName);
        symRelocs.push({ at: sr.at, expr: `(const unsigned char *)&${cName}` });
        continue;
      }
      // kind "code": another script proc, an engine native fn, else unresolved.
      const targetCName = cNameBySymbol.get(sr.symbol);
      if (targetCName !== undefined) {
        symRelocs.push({ at: sr.at, expr: targetCName });
      } else if (GBA_NATIVE_SYMBOLS.has(sr.symbol)) {
        usesNatives = true;
        symRelocs.push({
          at: sr.at,
          expr: `(const unsigned char *)&${cNameOf(sr.symbol)}`,
        });
      } else {
        // A far-data symbol (VM_GET_FAR) or an unimplemented native; left for a
        // later milestone. The 4-byte field keeps its zero placeholder.
        unresolved.push({ fromProc: p.symbol, symbol: sr.symbol, at: sr.at });
      }
    }
    linked.push({
      symbol: p.symbol,
      cName: cNameOf(p.symbol),
      program,
      symRelocs,
    });
  }

  const engineVarList = [...engineVars].sort();
  return {
    procs: linked,
    unresolved,
    engineVars: engineVarList,
    source: formatLinkedC(linked, engineVarList, usesNatives),
  };
}

/** Emit the combined C: engine vars, every proc's bytecode/relocs + symbolic relocs, and the manifest. */
export function formatLinkedC(
  linked: LinkedProc[],
  engineVars: string[],
  usesNatives = false,
): string {
  const out: string[] = [
    "// Generated by GBA Studio (M1 linker) - engine vars + all project script procs + manifest.",
    "// At load the engine patches each proc's local relocations (offsets within the",
    "// proc) and symbolic relocations (&target: another proc's array, &engineVar, or",
    "// &nativeFn); see gba_link.h.",
    '#include "gba_link.h"',
  ];
  if (usesNatives) out.push('#include "gba_natives.h"'); // &wait_frames etc.
  out.push("");

  // Engine RAM variables scripts write via VM_SET_CONST_INT8/16. Allocated here as
  // 16-bit storage (covers both 8- and 16-bit writes); engine systems that consume
  // them extern these symbols.
  if (engineVars.length > 0) {
    out.push(
      "// Engine RAM variables (written by scripts; consumed by engine systems).",
    );
    for (const v of engineVars) out.push(`short ${v} = 0;`);
    out.push("");
  }

  // Forward-declare every proc's byte array so cross-proc &targets resolve at link.
  for (const p of linked) out.push(`extern unsigned char ${p.cName}[];`);
  out.push("");

  for (const p of linked) {
    // Reuse the per-proc encoder for bytes + length + local relocs.
    out.push(formatGbaProgramC(p.cName, p.program));
    // Symbolic relocations: {field_offset, &target}. Non-empty even when zero
    // (C forbids zero-size arrays); the engine iterates by *_symrelocs_count.
    const rows =
      p.symRelocs.length > 0
        ? p.symRelocs.map((s) => `    { ${s.at}, ${s.expr} },`).join("\n")
        : "    { 0, 0 }, /* none (count is 0) */";
    out.push(`const GbaSymReloc ${p.cName}_symrelocs[] = {`);
    out.push(rows);
    out.push("};");
    out.push(
      `const unsigned int ${p.cName}_symrelocs_count = ${p.symRelocs.length};`,
    );
    out.push("");
  }

  // The manifest: the loader walks this, applying both relocation tables to each
  // proc's code before any script runs.
  out.push("const GbaProc gba_procs[] = {");
  for (const p of linked) {
    out.push(
      `    { ${p.cName}, ${p.cName}_len, ` +
        `${p.cName}_relocs, ${p.cName}_relocs_count, ` +
        `${p.cName}_symrelocs, ${p.cName}_symrelocs_count },`,
    );
  }
  out.push("};");
  out.push(`const unsigned int gba_procs_count = ${linked.length};`);
  return out.join("\n") + "\n";
}

/**
 * Emit the entry-point table (src/gba_entries.c) the engine executes: the start
 * scene init (run once) and each actor update script (a persistent per-frame
 * thread, paired with the actor's runtime index so the engine can activate it).
 * `cName`s must match the proc array names emitted by formatLinkedC.
 */
// One scene for the engine's scene table: its init script + the actor update
// scripts (each with the runtime actor index it drives). cNames must match proc
// array names emitted by formatLinkedC.
export interface GbaSceneEntry {
  initCName: string;
  actorUpdates: { cName: string; index: number }[];
  widthPx: number; // scene logical size (for the engine's camera clamp)
  heightPx: number;
  // Placed actors' initial state (engine places them on load before scripts run).
  // interact (M6c): the actor's On-Interact script C name, or "0" when it has none.
  actorsInit: {
    index: number;
    dir: number;
    x: number;
    y: number;
    interact: string;
    moveSpeed: number; // M10a: subpixels/frame (32 = 1px); 0 = engine default
    collisionGroup: number; // M10f: GB group bit (player 0x01, "1" 0x02, "2" 0x04, "3" 0x08)
  }[];
  playerMove: number; // 1 = built-in top-down d-pad control of the player (actor 0)
  collisions: number[]; // one byte per tile (row-major); empty = no collision grid
  // Trigger zones (M6b): a tile rect { x, y, w, h } + the enter-script's C name.
  triggers: {
    x: number;
    y: number;
    w: number;
    h: number;
    scriptCName: string;
  }[];
  // Projectile defs (M10f), preloaded into the engine's runtime slots on scene
  // load; the row order is the slot index Launch Projectile scripts pass.
  projectiles: GbaProjectileDefEntry[];
}

// One GbaProjectileDef row (engine struct field order; see gbavm gba_link.h).
export interface GbaProjectileDefEntry {
  sprite: number; // index into the generated gba_projectile_sprite() table
  animState: number; // animation-state row (statesOrder index)
  moveSpeed: number; // subpixels/frame (32 = 1px)
  lifeTime: number; // frames
  collisionGroup: number;
  collisionMask: number;
  strong: number; // 1 = survives hits (!destroyOnHit)
  animTick: number; // frame-advance mask
  animNoLoop: number;
  initialOffset: number; // subpixels
}

const formatProjectileDef = (p: GbaProjectileDefEntry): string =>
  `{ ${p.sprite}, ${p.animState}, ${p.moveSpeed}, ${p.lifeTime}, ` +
  `${p.collisionGroup}, ${p.collisionMask}, ${p.strong}, ${p.animTick}, ` +
  `${p.animNoLoop}, ${p.initialOffset} }`;

/**
 * Emit the scene table (src/gba_scene.c): every scene's init + actor updates, and
 * which scene to load at boot. The engine's gba_load_scene indexes this table.
 */
export function formatGbaScenesC(
  scenes: GbaSceneEntry[],
  startScene: number,
  // Global projectile-def tables (M10f), flattened in emit order; the bridge
  // resolves each _global_projectiles_<n> symbol to its table's base index.
  globalProjectiles: GbaProjectileDefEntry[] = [],
): string {
  const externs = new Set<string>();
  for (const s of scenes) {
    externs.add(s.initCName);
    for (const u of s.actorUpdates) externs.add(u.cName);
    for (const a of s.actorsInit)
      if (a.interact !== "0") externs.add(a.interact);
    for (const t of s.triggers) externs.add(t.scriptCName);
  }
  const out: string[] = [
    "// Generated by GBA Studio (M2) - the project's scene table + start scene.",
    '#include "gba_link.h"',
    ...[...externs].map((n) => `extern unsigned char ${n}[];`),
    "",
  ];
  // Per-scene update + actor-index arrays (a single 0 slot when empty, since C
  // forbids zero-size arrays; the engine iterates by the count).
  scenes.forEach((s, i) => {
    const updates = s.actorUpdates.length
      ? s.actorUpdates.map((u) => u.cName).join(", ")
      : "0";
    const indices = s.actorUpdates.length
      ? s.actorUpdates.map((u) => u.index).join(", ")
      : "0";
    out.push(
      `static unsigned char * const scene${i}_updates[] = { ${updates} };`,
    );
    out.push(
      `static const unsigned char scene${i}_update_actors[] = { ${indices} };`,
    );
    // Placed actors' initial state: { index, dir, x, y, interact }. A single zero row
    // when empty (C forbids zero-size arrays; the engine iterates by the count).
    const inits = s.actorsInit.length
      ? s.actorsInit
          .map(
            (a) =>
              `{ ${a.index}, ${a.dir}, ${a.x}, ${a.y}, ${a.interact}, ${a.moveSpeed}, ${a.collisionGroup} }`,
          )
          .join(", ")
      : "{ 0, 0, 0, 0, 0, 0, 0 }";
    out.push(
      `static const GbaActorInit scene${i}_actors_init[] = { ${inits} };`,
    );
    // Projectile defs (M10f): emitted only when the scene launches projectiles.
    if (s.projectiles.length) {
      const rows = s.projectiles.map(formatProjectileDef).join(", ");
      out.push(
        `static const GbaProjectileDef scene${i}_projectiles[] = { ${rows} };`,
      );
    }
    // Collision grid (one byte/tile). Emit the array only when some tile is solid;
    // otherwise the scene gets a null grid and only its bounds block movement.
    if (s.collisions.some((v) => v & 0x0f)) {
      out.push(
        `static const unsigned char scene${i}_collisions[] = { ${s.collisions
          .map((v) => v & 0xff)
          .join(", ")} };`,
      );
    }
    // Trigger zones (M6b): { x, y, w, h, enter-script }. Emitted only when present.
    if (s.triggers.length) {
      const rows = s.triggers
        .map((t) => `{ ${t.x}, ${t.y}, ${t.w}, ${t.h}, ${t.scriptCName} }`)
        .join(", ");
      out.push(`static const GbaTrigger scene${i}_triggers[] = { ${rows} };`);
    }
  });
  out.push("");
  out.push("const GbaScene gba_scenes[] = {");
  scenes.forEach((s, i) => {
    const collPtr = s.collisions.some((v) => v & 0x0f)
      ? `scene${i}_collisions`
      : "0";
    const trigPtr = s.triggers.length ? `scene${i}_triggers` : "0";
    const projPtr = s.projectiles.length ? `scene${i}_projectiles` : "0";
    out.push(
      `    { ${s.initCName}, scene${i}_updates, scene${i}_update_actors, ` +
        `${s.actorUpdates.length}, ${s.widthPx}, ${s.heightPx}, ` +
        `scene${i}_actors_init, ${s.actorsInit.length}, ${s.playerMove}, ${collPtr}, ` +
        `${trigPtr}, ${s.triggers.length}, ${projPtr}, ${s.projectiles.length} },`,
    );
  });
  out.push("};");
  out.push(`const unsigned int gba_scenes_count = ${scenes.length};`);
  out.push(`const unsigned int gba_start_scene = ${startScene};`);
  // Global projectile-def tables (M10f), flattened; a single zero row when empty
  // (C forbids zero-size arrays; the engine bounds-checks by the count).
  const globalRows = globalProjectiles.length
    ? globalProjectiles.map(formatProjectileDef).join(", ")
    : "{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }";
  out.push(
    `const GbaProjectileDef gba_global_projectile_defs[] = { ${globalRows} };`,
  );
  out.push(
    `const unsigned int gba_global_projectile_defs_count = ${globalProjectiles.length};`,
  );
  return out.join("\n") + "\n";
}
