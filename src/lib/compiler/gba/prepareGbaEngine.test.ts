import os from "os";
import Path from "path";
import {
  ensureDir,
  mkdtemp,
  pathExists,
  readFile,
  readdir,
  remove,
  stat,
  utimes,
  writeFile,
} from "fs-extra";
import prepareGbaEngineTree, { isIgnoredEnginePath } from "./prepareGbaEngine";

// A minimal stand-in for a gbavm checkout: the Makefile the prepare step gates
// on, some engine sources, a committed baseline asset, and the junk a real
// checkout accumulates (a build dir, previous ROMs, .git).
const writeFakeEngine = async (root: string) => {
  await ensureDir(Path.join(root, "src"));
  await ensureDir(Path.join(root, "include"));
  await ensureDir(Path.join(root, "graphics"));
  await ensureDir(Path.join(root, "build"));
  await ensureDir(Path.join(root, ".git"));
  await ensureDir(Path.join(root, "builds"));
  await writeFile(Path.join(root, "Makefile"), "TARGET := $(notdir $(CURDIR))");
  await writeFile(Path.join(root, "src", "hw.cpp"), "// engine");
  await writeFile(Path.join(root, "include", "hw.h"), "// engine header");
  await writeFile(Path.join(root, "graphics", "scene0_bg.bmp"), "baseline art");
  await writeFile(Path.join(root, "build", "hw.o"), "stale object");
  await writeFile(Path.join(root, "gbavm.gba"), "a previous rom");
  await writeFile(Path.join(root, "gbavm.elf"), "a previous elf");
  await writeFile(Path.join(root, ".git", "HEAD"), "ref: refs/heads/master");
  await writeFile(Path.join(root, "builds", "old.gba"), "an archived rom");
};

describe("prepareGbaEngineTree", () => {
  let tmp: string;
  let engineRoot: string;
  let buildRoot: string;

  beforeEach(async () => {
    tmp = await mkdtemp(Path.join(os.tmpdir(), "gba-prepare-"));
    engineRoot = Path.join(tmp, "engine");
    buildRoot = Path.join(tmp, "build-tree");
    await writeFakeEngine(engineRoot);
  });

  afterEach(async () => {
    await remove(tmp);
  });

  test("copies the engine sources into an empty build tree", async () => {
    await prepareGbaEngineTree({ engineRoot, buildRoot });

    expect(await readFile(Path.join(buildRoot, "src", "hw.cpp"), "utf8")).toBe(
      "// engine",
    );
    expect(
      await readFile(Path.join(buildRoot, "include", "hw.h"), "utf8"),
    ).toBe("// engine header");
    expect(await pathExists(Path.join(buildRoot, "Makefile"))).toBe(true);
  });

  test("skips version control, build output and previous ROMs", async () => {
    await prepareGbaEngineTree({ engineRoot, buildRoot });

    expect(await pathExists(Path.join(buildRoot, ".git"))).toBe(false);
    expect(await pathExists(Path.join(buildRoot, "builds"))).toBe(false);
    expect(await pathExists(Path.join(buildRoot, "gbavm.gba"))).toBe(false);
    expect(await pathExists(Path.join(buildRoot, "gbavm.elf"))).toBe(false);
    // The engine's own build dir is not copied in...
    expect(await pathExists(Path.join(buildRoot, "build", "hw.o"))).toBe(false);
  });

  // The property the milestone exists for: a build must never see a file left
  // behind by the previously built project.
  test("clears files left by a previous project's build", async () => {
    await prepareGbaEngineTree({ engineRoot, buildRoot });

    // Simulate the eject: project A adds assets and generated sources.
    await writeFile(
      Path.join(buildRoot, "graphics", "scene5_sprite_0.bmp"),
      "project A art",
    );
    await writeFile(
      Path.join(buildRoot, "src", "gba_program.c"),
      "// project A bytecode",
    );

    // Project B builds next.
    await prepareGbaEngineTree({ engineRoot, buildRoot });

    expect(
      await pathExists(Path.join(buildRoot, "graphics", "scene5_sprite_0.bmp")),
    ).toBe(false);
    expect(await pathExists(Path.join(buildRoot, "src", "gba_program.c"))).toBe(
      false,
    );
    // ...and the engine's own baseline is back, unmodified.
    expect(
      await readFile(Path.join(buildRoot, "graphics", "scene0_bg.bmp"), "utf8"),
    ).toBe("baseline art");
  });

  // Warm builds: the object dir is the one thing that survives, or every build
  // becomes a full Butano rebuild.
  test("keeps the object dir across builds", async () => {
    await prepareGbaEngineTree({ engineRoot, buildRoot });
    await ensureDir(Path.join(buildRoot, "build"));
    await writeFile(Path.join(buildRoot, "build", "hw.o"), "compiled");

    const cleared = await prepareGbaEngineTree({ engineRoot, buildRoot });

    expect(await readFile(Path.join(buildRoot, "build", "hw.o"), "utf8")).toBe(
      "compiled",
    );
    expect(cleared).toBeGreaterThan(0);
  });

  // make must still be able to tell what changed, so code keeps its source mtime.
  test("preserves source timestamps so make stays incremental", async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(Path.join(engineRoot, "src", "hw.cpp"), old, old);

    await prepareGbaEngineTree({ engineRoot, buildRoot });

    const srcMtime = (await stat(Path.join(engineRoot, "src", "hw.cpp")))
      .mtimeMs;
    const destMtime = (await stat(Path.join(buildRoot, "src", "hw.cpp")))
      .mtimeMs;
    expect(Math.abs(srcMtime - destMtime)).toBeLessThan(2000);
  });

  // ...but assets are stamped, because Butano's asset cache compares mtimes
  // against sentinels in build/ that may describe another project's art.
  test("stamps assets so Butano cannot reuse another project's generated art", async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(Path.join(engineRoot, "graphics", "scene0_bg.bmp"), old, old);

    await prepareGbaEngineTree({ engineRoot, buildRoot });

    const destMtime = (
      await stat(Path.join(buildRoot, "graphics", "scene0_bg.bmp"))
    ).mtimeMs;
    expect(Date.now() - destMtime).toBeLessThan(60 * 1000);
  });

  test("fails clearly when the engine root is not an engine", async () => {
    await expect(
      prepareGbaEngineTree({
        engineRoot: Path.join(tmp, "nope"),
        buildRoot,
      }),
    ).rejects.toThrow(/gbavm engine not found/);
  });

  test("leaves the engine checkout untouched", async () => {
    const before = await readdir(engineRoot);

    await prepareGbaEngineTree({ engineRoot, buildRoot });
    await writeFile(
      Path.join(buildRoot, "src", "gba_program.c"),
      "// generated",
    );

    expect(await readdir(engineRoot)).toEqual(before);
    expect(
      await pathExists(Path.join(engineRoot, "src", "gba_program.c")),
    ).toBe(false);
    expect(
      await readFile(
        Path.join(engineRoot, "graphics", "scene0_bg.bmp"),
        "utf8",
      ),
    ).toBe("baseline art");
  });
});

describe("isIgnoredEnginePath", () => {
  const root = Path.join("C:", "engine");

  test.each([
    ["build", true],
    ["builds", true],
    [".git", true],
    [".github", true],
    ["examples", true],
    ["src", false],
    ["include", false],
    ["graphics", false],
  ])("top-level %s -> ignored: %s", (entry, expected) => {
    expect(isIgnoredEnginePath(root, Path.join(root, entry))).toBe(expected);
  });

  test("ignores build products by extension, anywhere", () => {
    expect(isIgnoredEnginePath(root, Path.join(root, "gbavm.gba"))).toBe(true);
    expect(isIgnoredEnginePath(root, Path.join(root, "gbavm.elf"))).toBe(true);
    expect(isIgnoredEnginePath(root, Path.join(root, "gbavm.sav"))).toBe(true);
  });

  test("keeps engine sources with similar names", () => {
    expect(isIgnoredEnginePath(root, Path.join(root, "src", "hw.cpp"))).toBe(
      false,
    );
    expect(
      isIgnoredEnginePath(root, Path.join(root, "graphics", "scene0_bg.bmp")),
    ).toBe(false);
  });

  test("does not ignore the engine root itself", () => {
    expect(isIgnoredEnginePath(root, root)).toBe(false);
  });
});
