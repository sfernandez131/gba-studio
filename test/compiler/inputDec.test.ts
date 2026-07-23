import { inputDec } from "../../src/lib/compiler/helpers";

describe("inputDec (input button masks)", () => {
  test("maps the eight Game Boy buttons to their KEY_BITS", () => {
    expect(inputDec("right")).toBe(0x01);
    expect(inputDec("left")).toBe(0x02);
    expect(inputDec("a")).toBe(0x10);
    expect(inputDec("start")).toBe(0x80);
  });

  test("unions a list of buttons", () => {
    expect(inputDec(["a", "b"])).toBe(0x30);
  });

  test("empty input falls back to any-input (255)", () => {
    expect(inputDec([])).toBe(255);
  });

  test("M8a: GBA L/R live in the high byte and stay > 0xff", () => {
    // > 0xff is the signal scriptBuilder.ifInput uses to widen the mask to
    // int16 so the shoulder bits survive - GB masks never reach here.
    expect(inputDec("l")).toBe(0x100);
    expect(inputDec("r")).toBe(0x200);
    expect(inputDec(["l", "r"])).toBe(0x300);
    expect(inputDec(["a", "l"])).toBe(0x110);
    expect(inputDec("start")).toBeLessThanOrEqual(0xff); // GB masks stay byte-wide
  });
});
