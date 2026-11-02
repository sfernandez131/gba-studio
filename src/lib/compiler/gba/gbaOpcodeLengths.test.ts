// Every op the editor emits needs a matching entry in the engine's vm_args_len table:
// without one the VM steps over too few bytes and runs the operands as opcodes, and the
// script dies without a word (found the hard way in M14). This reads the table from the
// vendored engine and checks each of the editor's operand specs against it, so the
// editor and its engine pin cannot drift apart.
import { readFileSync } from "fs";
import Path from "path";
import { GBA_OPCODE_SPECS, GbaOperandType } from "./emitGbaBytecode";

const vmSource = readFileSync(
  Path.join(__dirname, "../../../../appData/engine/gba/src/vm.c"),
  "utf8",
);
const tableStart = vmSource.indexOf("vm_args_len[256]");
// The table closes with `};` at the start of a line (comments inside it use braces).
const tableEnd = vmSource.slice(tableStart).search(/^\};/m) + tableStart;
const table = vmSource.slice(tableStart, tableEnd);
const argsLen = new Map(
  [...table.matchAll(/\[0x([0-9A-Fa-f]{2})\]\s*=\s*(\d+)/g)].map((m) => [
    parseInt(m[1], 16),
    Number(m[2]),
  ]),
);

const size = (t: GbaOperandType) =>
  t === "u8" || t === "i8" ? 1 : t === "ptr" ? 4 : 2;

describe("the editor's opcode specs fit the engine's vm_args_len", () => {
  test("the table is found", () => {
    expect(tableStart).toBeGreaterThan(0);
    expect(argsLen.size).toBeGreaterThan(50);
  });

  test.each(
    Object.entries(GBA_OPCODE_SPECS).map(([op, kinds]) => [
      `0x${Number(op).toString(16).padStart(2, "0")}`,
      Number(op),
      kinds,
    ]),
  )("op %s", (_name, op, kinds) => {
    const bytes = (kinds as GbaOperandType[]).reduce((n, t) => n + size(t), 0);
    // An op with no operands may leave its entry out (the table defaults to 0).
    expect(argsLen.get(op as number) ?? 0).toBe(bytes);
  });
});
