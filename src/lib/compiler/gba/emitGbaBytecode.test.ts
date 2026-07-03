import { emitGbaBytecode, formatGbaProgramC, GbaItem } from "./emitGbaBytecode";

describe("emitGbaBytecode", () => {
  test("encodes SET_CONST operands little-endian (matches gbavm VM_STEP)", () => {
    const { bytes, relocations } = emitGbaBytecode([
      { kind: "op", op: 0x14, operands: [1, 0] }, // SET_CONST g1 = 0
      { kind: "op", op: 0x14, operands: [2, 0x0780] }, // SET_CONST g2 = 0x0780
      { kind: "stop" },
    ]);
    expect(bytes).toEqual([
      0x14, 0x01, 0x00, 0x00, 0x00, // idx=1 (LE), val=0x0000 (LE)
      0x14, 0x02, 0x00, 0x80, 0x07, // idx=2 (LE), val=0x0780 (LE)
      0x00, // STOP
    ]);
    expect(relocations).toEqual([]);
  });

  test("encodes negative (stack-relative) i16 operands as two's-complement LE", () => {
    const { bytes } = emitGbaBytecode([
      { kind: "op", op: 0x13, operands: [-1, 0] }, // SET .ARG0(-1), g0
    ]);
    expect(bytes).toEqual([0x13, 0xff, 0xff, 0x00, 0x00]); // -1 => 0xFFFF LE
  });

  test("resolves a jump/if label to a 32-bit relocation at the right offset", () => {
    const items: GbaItem[] = [
      { kind: "label", name: "loop" }, // byte offset 0
      { kind: "op", op: 0x35, operands: [1] }, // ACTOR_SET_POS g1  -> bytes 0..2
      // IF_CONST cond=LT(2), idxA=g0(0), B=10, -> loop, n=0   (op at offset 3)
      { kind: "op", op: 0x1a, operands: [2, 0, 10, { label: "loop" }, 0] },
      { kind: "stop" },
    ];
    const { bytes, relocations } = emitGbaBytecode(items);

    // ACTOR_SET_POS g1
    expect(bytes.slice(0, 3)).toEqual([0x35, 0x01, 0x00]);
    // IF_CONST: op, cond, idxA(2), B(2), ptr(4 placeholder), n
    expect(bytes[3]).toBe(0x1a);
    expect(bytes[4]).toBe(0x02); // condition
    expect(bytes.slice(5, 7)).toEqual([0x00, 0x00]); // idxA = 0
    expect(bytes.slice(7, 9)).toEqual([0x0a, 0x00]); // B = 10 (LE)
    expect(bytes.slice(9, 13)).toEqual([0x00, 0x00, 0x00, 0x00]); // ptr placeholder
    expect(bytes[13]).toBe(0x00); // n
    expect(bytes[14]).toBe(0x00); // STOP
    // The 4-byte ptr field at offset 9 must be relocated to "loop" (offset 0).
    expect(relocations).toEqual([{ at: 9, target: 0 }]);
  });

  test("throws clearly on an unsupported opcode", () => {
    expect(() =>
      emitGbaBytecode([{ kind: "op", op: 0xff, operands: [0] }]), // unassigned opcode
    ).toThrow(/No GBA encoding for opcode 0xff/);
  });

  test("encodes a VM_SWITCH header + relocatable 6-byte case entries", () => {
    const items: GbaItem[] = [
      {
        kind: "switch",
        operands: [-1, 2, 0], // idx .ARG0, size 2, n 0
        cases: [
          { value: 1, target: { label: "a" } },
          { value: 2, target: { label: "b" } },
        ],
      },
      { kind: "label", name: "a" }, // offset 17 (right after the 5+6+6 = 17-byte switch)
      { kind: "op", op: 0x18, operands: [] }, // IDLE (1 byte) at offset 17
      { kind: "label", name: "b" }, // offset 18
      { kind: "stop" },
    ];
    const { bytes, relocations } = emitGbaBytecode(items);
    // header: op + idx(-1 => 0xFFFF LE) + size + n
    expect(bytes.slice(0, 5)).toEqual([0x08, 0xff, 0xff, 0x02, 0x00]);
    // case 0: value 1 (LE) at 5..6, ptr placeholder at 7..10
    expect(bytes.slice(5, 7)).toEqual([0x01, 0x00]);
    expect(bytes.slice(7, 11)).toEqual([0x00, 0x00, 0x00, 0x00]);
    // case 1: value 2 (LE) at 11..12, ptr placeholder at 13..16
    expect(bytes.slice(11, 13)).toEqual([0x02, 0x00]);
    // the two 4-byte ptr fields relocate to labels "a" (17) and "b" (18)
    expect(relocations).toEqual([
      { at: 7, target: 17 },
      { at: 13, target: 18 },
    ]);
    expect(bytes[17]).toBe(0x18); // IDLE
    expect(bytes[18]).toBe(0x00); // STOP
  });

  test("encodes the new trig/angle opcodes (0x86/0x89) little-endian", () => {
    const { bytes } = emitGbaBytecode([
      { kind: "op", op: 0x86, operands: [-2, -1] }, // ACTOR_GET_ANGLE idx=-2, dest=-1
      { kind: "op", op: 0x89, operands: [-1, -2, 5] }, // SIN_SCALE idx=-1, angle=-2, scale=5
    ]);
    expect(bytes.slice(0, 5)).toEqual([0x86, 0xfe, 0xff, 0xff, 0xff]);
    expect(bytes.slice(5, 11)).toEqual([0x89, 0xff, 0xff, 0xfe, 0xff, 0x05]);
  });

  test("encodes VM_BEGINTHREAD (0x0e) byte-for-byte: bank, proc ptr, handle, nargs", () => {
    // Thread proc resolvable as an in-blob label (the cross-blob case is P1).
    const items: GbaItem[] = [
      { kind: "label", name: "proc" }, // offset 0
      { kind: "op", op: 0x18, operands: [] }, // IDLE (1 byte) — proc body
      // BEGINTHREAD bank=0, proc->"proc", handle=.ARG0(-1), nargs=0  (op at offset 1)
      { kind: "op", op: 0x0e, operands: [0, { label: "proc" }, -1, 0] },
      { kind: "stop" },
    ];
    const { bytes, relocations } = emitGbaBytecode(items);
    expect(bytes[0]).toBe(0x18); // proc body (IDLE) at offset 0
    // op + bank(u8) + proc(ptr placeholder) + handle(i16 LE) + nargs(u8)
    expect(bytes[1]).toBe(0x0e);
    expect(bytes[2]).toBe(0x00); // bank
    expect(bytes.slice(3, 7)).toEqual([0x00, 0x00, 0x00, 0x00]); // proc ptr placeholder
    expect(bytes.slice(7, 9)).toEqual([0xff, 0xff]); // handle = -1 (.ARG0) LE
    expect(bytes[9]).toBe(0x00); // nargs
    expect(bytes[10]).toBe(0x00); // STOP
    // the proc ptr at offset 3 relocates to label "proc" (offset 0)
    expect(relocations).toEqual([{ at: 3, target: 0 }]);
  });

  test("captures an external (cross-proc/native) ptr as a symbolic relocation", () => {
    // VM_BEGINTHREAD bank=0, proc->_other_script, handle=.ARG0(-1), nargs=0.
    // _other_script isn't a label in this blob; the project linker (M1) resolves
    // it, so the emitter records a symReloc at the 4-byte ptr field (op + bank u8
    // => offset 2) and leaves a placeholder, exactly like a local relocation.
    const { bytes, relocations, symRelocs } = emitGbaBytecode([
      { kind: "op", op: 0x0e, operands: [0, { label: "_other_script" }, -1, 0] },
    ]);
    expect(relocations).toEqual([]);
    expect(symRelocs).toEqual([{ at: 2, symbol: "_other_script", kind: "code" }]);
    expect(bytes.slice(2, 6)).toEqual([0, 0, 0, 0]); // placeholder, patched at load
  });

  test("still throws on a non-external unknown label (a real codegen bug)", () => {
    expect(() =>
      emitGbaBytecode([{ kind: "op", op: 0x09, operands: [{ label: "missing" }] }]),
    ).toThrow(/Unknown label "missing"/);
  });
});

describe("formatGbaProgramC", () => {
  test("emits a non-empty reloc array with zero relocations (C forbids zero-size arrays)", () => {
    const prog = emitGbaBytecode([
      { kind: "op", op: 0x18, operands: [] }, // IDLE
      { kind: "stop" },
    ]);
    expect(prog.relocations.length).toBe(0);
    const c = formatGbaProgramC("test_prog", prog);
    expect(c).toContain("unsigned char test_prog[] = {");
    expect(c).toContain("const unsigned int test_prog_relocs_count = 0;");
    // Must not produce `..._relocs[] = {};` (a zero-size array, which fails to compile).
    expect(c).not.toMatch(/test_prog_relocs\[\]\s*=\s*\{\s*\};/);
  });
});
