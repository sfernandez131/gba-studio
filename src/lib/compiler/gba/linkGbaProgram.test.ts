import {
  linkGbaProgram,
  cNameOf,
  formatGbaScenesC,
  GbaProc,
} from "./linkGbaProgram";

describe("linkGbaProgram", () => {
  test("resolves a cross-proc reference (script -> script) to a symbolic relocation", () => {
    const procs: GbaProc[] = [
      {
        symbol: "_scene_main_init",
        items: [
          // VM_CALL_FAR bank=0, addr->_helper  (op 0x0a, spec [u8, ptr]).
          { kind: "op", op: 0x0a, operands: [0, { label: "_helper" }] },
          { kind: "stop" },
        ],
      },
      {
        symbol: "_helper",
        items: [
          { kind: "op", op: 0x18, operands: [] }, // IDLE
          { kind: "op", op: 0x0b, operands: [0] }, // RET_FAR 0
        ],
      },
    ];
    const { procs: linked, unresolved } = linkGbaProgram(procs);
    expect(unresolved).toEqual([]);
    const init = linked.find((p) => p.symbol === "_scene_main_init")!;
    // CALL_FAR: op + bank(u8) => ptr field at offset 2; resolves to proc "helper".
    expect(init.symRelocs).toEqual([{ at: 2, expr: "helper" }]);
    expect(init.program.relocations).toEqual([]); // no in-proc labels here
  });

  test("reports a non-proc external (native / engine / far data) as unresolved", () => {
    const { unresolved, procs } = linkGbaProgram([
      {
        symbol: "_s",
        items: [
          // VM_CALL_NATIVE bank=0, ptr->_native_fn  (op 0x2d, spec [u8, ptr]).
          { kind: "op", op: 0x2d, operands: [0, { label: "_native_fn" }] },
          { kind: "stop" },
        ],
      },
    ]);
    expect(unresolved).toEqual([{ fromProc: "_s", symbol: "_native_fn", at: 2 }]);
    expect(procs[0].symRelocs).toEqual([]);
  });

  test("resolves an engine native function reference (VM_INVOKE _wait_frames)", () => {
    const { procs, unresolved, source } = linkGbaProgram([
      {
        symbol: "_s",
        items: [
          // VM_INVOKE bank=0, fn->_wait_frames, nparams=0, idx=.ARG0(-1).
          { kind: "op", op: 0x0d, operands: [0, { label: "_wait_frames" }, 0, -1] },
          { kind: "stop" },
        ],
      },
    ]);
    expect(unresolved).toEqual([]); // _wait_frames is a known engine native
    // VM_INVOKE: op + bank(u8) => fn ptr field at offset 2.
    expect(procs[0].symRelocs).toEqual([
      { at: 2, expr: "(const unsigned char *)&wait_frames" },
    ]);
    expect(source).toContain('#include "gba_natives.h"');
  });

  test("allocates an engine RAM variable for a ram relocation (VM_SET_CONST_INT8)", () => {
    // RPN stream: R_INT8 1, R_REF_MEM_SET MEM_I8, &_fade_frames_per_step(4b), R_STOP.
    const { procs, engineVars, unresolved, source } = linkGbaProgram([
      {
        symbol: "_scene_init",
        items: [
          {
            kind: "rpn",
            bytes: [0xff, 1, 0xf8, 0x69, 0, 0, 0, 0, 0x00],
            relocs: [{ at: 4, symbol: "_fade_frames_per_step" }],
          },
          { kind: "stop" },
        ],
      },
    ]);
    expect(unresolved).toEqual([]);
    expect(engineVars).toEqual(["fade_frames_per_step"]);
    // emit prepends the 0x15 RPN opcode, so the address field lands at 1 + 4 = 5.
    expect(procs[0].symRelocs).toEqual([
      { at: 5, expr: "(const unsigned char *)&fade_frames_per_step" },
    ]);
    expect(source).toContain("short fade_frames_per_step = 0;");
    expect(source).toContain(
      "{ 5, (const unsigned char *)&fade_frames_per_step },",
    );
  });

  test("keeps in-proc labels as local relocations, not symbolic ones", () => {
    const { procs, unresolved } = linkGbaProgram([
      {
        symbol: "_loop",
        items: [
          { kind: "label", name: "top" }, // offset 0
          { kind: "op", op: 0x18, operands: [] }, // IDLE (1 byte)
          { kind: "op", op: 0x09, operands: [{ label: "top" }] }, // JUMP top
        ],
      },
    ]);
    expect(unresolved).toEqual([]);
    expect(procs[0].symRelocs).toEqual([]);
    expect(procs[0].program.relocations).toEqual([{ at: 2, target: 0 }]);
  });

  test("emits combined C: extern decls, per-proc symrelocs, and the manifest", () => {
    const { source } = linkGbaProgram([
      {
        symbol: "_a",
        items: [
          { kind: "op", op: 0x0a, operands: [0, { label: "_b" }] },
          { kind: "stop" },
        ],
      },
      { symbol: "_b", items: [{ kind: "stop" }] },
    ]);
    expect(source).toContain("extern unsigned char a[];");
    expect(source).toContain("extern unsigned char b[];");
    expect(source).toContain("const GbaSymReloc a_symrelocs[] = {");
    expect(source).toContain("{ 2, b },"); // a's CALL_FAR ptr field -> &b
    expect(source).toContain("const GbaProc gba_procs[] = {");
    expect(source).toContain("const unsigned int gba_procs_count = 2;");
  });

  test("cNameOf drops the single leading underscore", () => {
    expect(cNameOf("_scene_main_init")).toBe("scene_main_init");
  });

  test("formatGbaScenesC emits a scene table with init + actor updates + indices", () => {
    const c = formatGbaScenesC(
      [
        {
          initCName: "scene_main_init",
          actorUpdates: [{ cName: "actor_player_update", index: 1 }],
          widthPx: 240,
          heightPx: 160,
          actorsInit: [{ index: 1, dir: 2, x: 2304, y: 2048 }],
          playerMove: 1,
          collisions: [0, 15, 0, 0],
        },
      ],
      0,
    );
    expect(c).toContain("extern unsigned char scene_main_init[];");
    expect(c).toContain("extern unsigned char actor_player_update[];");
    expect(c).toContain(
      "static unsigned char * const scene0_updates[] = { actor_player_update };",
    );
    expect(c).toContain(
      "static const unsigned char scene0_update_actors[] = { 1 };",
    );
    expect(c).toContain(
      "static const GbaActorInit scene0_actors_init[] = { { 1, 2, 2304, 2048 } };",
    );
    expect(c).toContain(
      "static const unsigned char scene0_collisions[] = { 0, 15, 0, 0 };",
    );
    expect(c).toContain(
      "{ scene_main_init, scene0_updates, scene0_update_actors, 1, 240, 160, scene0_actors_init, 1, 1, scene0_collisions },",
    );
    expect(c).toContain("const unsigned int gba_scenes_count = 1;");
    expect(c).toContain("const unsigned int gba_start_scene = 0;");
  });

  test("formatGbaScenesC guards the zero-actor-update case (no zero-size array)", () => {
    const c = formatGbaScenesC(
      [
        {
          initCName: "scene_main_init",
          actorUpdates: [],
          widthPx: 240,
          heightPx: 160,
          actorsInit: [],
          playerMove: 0,
          collisions: [],
        },
      ],
      0,
    );
    expect(c).toContain("static unsigned char * const scene0_updates[] = { 0 };");
    expect(c).toContain(
      "static const unsigned char scene0_update_actors[] = { 0 };",
    );
    expect(c).toContain(
      "static const GbaActorInit scene0_actors_init[] = { { 0, 0, 0, 0 } };",
    );
    expect(c).toContain(
      "{ scene_main_init, scene0_updates, scene0_update_actors, 0, 240, 160, scene0_actors_init, 0, 0, 0 },",
    );
  });

  test("rejects a duplicate proc symbol in the link set", () => {
    expect(() =>
      linkGbaProgram([
        { symbol: "_x", items: [{ kind: "stop" }] },
        { symbol: "_x", items: [{ kind: "stop" }] },
      ]),
    ).toThrow(/Duplicate proc symbol "_x"/);
  });
});
