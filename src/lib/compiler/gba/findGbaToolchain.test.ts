import {
  bundledToolchainRoot,
  findGbaToolchain,
  gbaToolchainPreference,
} from "./findGbaToolchain";

const buildToolsRoot = "/app/buildTools";

/** An `exists` that answers true only for the given paths. */
const existsFor =
  (...paths: string[]) =>
  async (path: string) =>
    paths.includes(path);

const bundle = bundledToolchainRoot(buildToolsRoot, "win32", "x64");

const find = (
  opts: Partial<Parameters<typeof findGbaToolchain>[0]> = {},
): ReturnType<typeof findGbaToolchain> =>
  findGbaToolchain({
    buildToolsRoot,
    platform: "win32",
    arch: "x64",
    env: {},
    exists: async () => false,
    ...opts,
  });

describe("findGbaToolchain", () => {
  test("prefers a bundled toolchain over a system install", async () => {
    const toolchain = await find({
      exists: existsFor(
        `${bundle}/target/gba`,
        "C:/msys64/opt/wonderful/bin", // also present, and should lose
      ),
    });
    expect(toolchain).toEqual({ kind: "bundled", root: bundle });
  });

  test("falls back to a system Wonderful install on Windows", async () => {
    const toolchain = await find({
      exists: existsFor("C:/msys64/opt/wonderful/bin"),
    });
    expect(toolchain).toEqual({
      kind: "wonderful-msys2",
      msys2Root: "C:/msys64",
    });
  });

  test("honours WONDERFUL_MSYS2 when locating a system install", async () => {
    const toolchain = await find({
      env: { WONDERFUL_MSYS2: "D:\\msys2" },
      exists: existsFor("D:/msys2/opt/wonderful/bin"),
    });
    expect(toolchain).toEqual({
      kind: "wonderful-msys2",
      msys2Root: "D:/msys2",
    });
  });

  test("finds a system install on Unix", async () => {
    const toolchain = await find({
      platform: "linux",
      arch: "x64",
      exists: existsFor("/opt/wonderful/bin"),
    });
    expect(toolchain).toEqual({ kind: "wonderful", root: "/opt/wonderful" });
  });

  test("returns null when nothing is available, leaving devkitARM to the caller", async () => {
    expect(await find()).toBeNull();
  });

  // A half-fetched bundle must not win: failing during discovery beats failing
  // deep inside a build with a confusing compiler error.
  test("ignores a bundle directory that has no GBA target in it", async () => {
    const toolchain = await find({
      exists: existsFor(bundle, "C:/msys64/opt/wonderful/bin"),
    });
    expect(toolchain).toEqual({
      kind: "wonderful-msys2",
      msys2Root: "C:/msys64",
    });
  });

  describe("GBA_TOOLCHAIN override", () => {
    test("wonderful skips a present bundle", async () => {
      const toolchain = await find({
        env: { GBA_TOOLCHAIN: "wonderful" },
        exists: existsFor(
          `${bundle}/target/gba`,
          "C:/msys64/opt/wonderful/bin",
        ),
      });
      expect(toolchain).toEqual({
        kind: "wonderful-msys2",
        msys2Root: "C:/msys64",
      });
    });

    test("devkitarm selects neither", async () => {
      const toolchain = await find({
        env: { GBA_TOOLCHAIN: "devkitarm" },
        exists: existsFor(`${bundle}/target/gba`),
      });
      expect(toolchain).toBeNull();
    });

    test("bundled fails loudly when no bundle is present", async () => {
      await expect(
        find({
          env: { GBA_TOOLCHAIN: "bundled" },
          exists: existsFor("C:/msys64/opt/wonderful/bin"),
        }),
      ).rejects.toThrow(/no bundled toolchain found/);
    });

    test("wonderful fails loudly when no system install is present", async () => {
      await expect(
        find({
          env: { GBA_TOOLCHAIN: "wonderful" },
          exists: existsFor(`${bundle}/target/gba`),
        }),
      ).rejects.toThrow(/no Wonderful Toolchain install found/);
    });

    test("an unrecognised value is ignored rather than throwing", async () => {
      const toolchain = await find({
        env: { GBA_TOOLCHAIN: "nonsense" },
        exists: existsFor(`${bundle}/target/gba`),
      });
      expect(toolchain).toEqual({ kind: "bundled", root: bundle });
    });
  });
});

describe("gbaToolchainPreference", () => {
  test.each([
    ["bundled", "bundled"],
    ["WONDERFUL", "wonderful"],
    ["devkitARM", "devkitarm"],
  ])("%s -> %s", (raw, expected) => {
    expect(gbaToolchainPreference({ GBA_TOOLCHAIN: raw })).toBe(expected);
  });

  test.each([[undefined], [""], ["gcc"]])("%s -> undefined", (raw) => {
    expect(gbaToolchainPreference({ GBA_TOOLCHAIN: raw })).toBeUndefined();
  });
});
