// GBA Studio - out-of-tree engine tree preparation (M9c).
//
// Until M9c the GBA build ran *inside* the gbavm engine checkout: ejectGbaBuild
// wrote generated sources and per-project assets straight into it and make ran
// there. That made the engine checkout a build scratch dir, which is why every
// engine commit needed a hand-restore of the generated baseline, why assets from
// a previously built project lingered and were still picked up by Butano's asset
// step, and why a read-only (installed / vendored) engine could not work at all.
//
// This module gives the build its own tree: the engine sources are copied into
// the build root and everything - eject and make alike - happens there. The
// engine checkout becomes a read-only source, exactly like appData/engine/gbvm on
// the GB side (see ejectBuild.ts, which copies the GB engine the same way).
//
// Two properties this has to keep, and the tests assert both:
//
//  * NO STALE FILES. Everything except the object dir is removed before the copy,
//    so a build always sees "pristine engine + this project", never leftovers
//    from the last project. This is the bug class the milestone is named for.
//  * WARM BUILDS. The copy PRESERVES TIMESTAMPS, so make still sees unchanged
//    sources as older than the objects in build/ and skips recompiling them. A
//    naive copy gives every file a fresh mtime and silently turns every build
//    into a full Butano rebuild - correct, but minutes slower each time.
//
// The object dir surviving across projects is safe for LINKING: Butano derives
// its object list from the source files present (common_setup.mak builds
// OFILES_GRAPHICS from the .bmp files in graphics/), so an intermediate whose
// source is gone is simply never referenced. It is NOT automatically safe for
// ASSET REGENERATION: butano_graphics_tool.py decides an asset is up to date by
// comparing mtimes against a build/_bn_<name>_graphics_file_info.txt sentinel, so
// an engine-baseline asset restored with its original (old) mtime could sit
// behind a newer sentinel describing a *different* project's art and silently be
// reused. Today's eject happens to overwrite every such file, but relying on that
// is exactly the kind of latent trap that produced the M5/M6 dropped-audio bug -
// so the asset dirs are stamped to now after the copy, making the property
// unconditional. Only the cheap half of the build (asset regeneration) pays for
// it; the expensive half (Butano's ~150 C++ objects, which depend on src/ and
// include/) stays incremental.

import Path from "path";
import {
  copy,
  ensureDir,
  pathExists,
  readdir,
  remove,
  stat,
  utimes,
} from "fs-extra";

// The object dir. Kept across builds so make stays incremental; it holds only
// build products, never anything the eject or a project contributes.
export const GBA_BUILD_DIR = "build";

// Engine paths never worth copying into a build tree: version control, build
// products, the engine's own fixtures/demos, and previously built ROMs.
export const gbaEngineIgnore = [
  ".git",
  ".github",
  "build",
  "builds",
  "examples",
  "test",
  "docs",
];

const ignoredExtensions = [".gba", ".elf", ".sav", ".map"];

// Directories whose contents Butano regenerates from mtime comparisons, and which
// the eject also writes into. Stamped to "now" after the copy - see the note above.
export const gbaAssetDirs = ["graphics", "audio", "dmg_audio"];

/**
 * True when `srcPath` (an absolute path inside `engineRoot`) should not be
 * copied into the build tree. Exported for the tests.
 */
export const isIgnoredEnginePath = (
  engineRoot: string,
  srcPath: string,
): boolean => {
  const rel = Path.relative(engineRoot, srcPath).replace(/\\/g, "/");
  if (rel === "") {
    return false; // the root itself
  }
  const [top] = rel.split("/");
  if (gbaEngineIgnore.includes(top)) {
    return true;
  }
  return ignoredExtensions.includes(Path.extname(rel).toLowerCase());
};

type PrepareGbaEngineOptions = {
  /** The engine source tree (read-only): a gbavm checkout, later appData/engine/gba. */
  engineRoot: string;
  /** Where the build runs: <tmp>/_gbsbuild/gba. */
  buildRoot: string;
  progress?: (msg: string) => void;
};

/**
 * Make `buildRoot` a clean copy of `engineRoot`, keeping the object dir so
 * incremental builds survive. Returns the number of stale entries cleared,
 * which the caller may log.
 */
export const prepareGbaEngineTree = async ({
  engineRoot,
  buildRoot,
  progress = () => {},
}: PrepareGbaEngineOptions): Promise<number> => {
  if (!(await pathExists(Path.join(engineRoot, "Makefile")))) {
    throw new Error(
      `GBA build: gbavm engine not found at ${engineRoot} (set the GBAVM_ROOT environment variable).`,
    );
  }

  await ensureDir(buildRoot);

  // Clear the previous build's tree, keeping only the object dir. Anything else
  // still here belongs to whatever project was built last.
  const existing = await readdir(buildRoot);
  let cleared = 0;
  for (const entry of existing) {
    if (entry === GBA_BUILD_DIR) {
      continue;
    }
    await remove(Path.join(buildRoot, entry));
    cleared += 1;
  }

  progress(`Preparing GBA engine build tree in ${buildRoot}`);
  await copy(engineRoot, buildRoot, {
    overwrite: true,
    // Keep source mtimes so make can still tell what actually changed.
    preserveTimestamps: true,
    filter: (src: string) => !isIgnoredEnginePath(engineRoot, src),
  });

  await stampAssetDirs(buildRoot);

  return cleared;
};

/**
 * Give every copied asset a current mtime, so Butano's mtime-based asset cache
 * can never match a sentinel left by a different project's build.
 */
const stampAssetDirs = async (buildRoot: string) => {
  const now = new Date();
  for (const dir of gbaAssetDirs) {
    const dirPath = Path.join(buildRoot, dir);
    if (!(await pathExists(dirPath))) {
      continue;
    }
    for (const entry of await readdir(dirPath)) {
      const entryPath = Path.join(dirPath, entry);
      if ((await stat(entryPath)).isFile()) {
        await utimes(entryPath, now, now);
      }
    }
  }
};

export default prepareGbaEngineTree;
