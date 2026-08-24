// GBA Studio - GBA make step (Butano on Wonderful Toolchain or devkitARM).
//
// Counterpart to makeBuild.ts for the GBA target. Builds the gbavm engine tree
// (with the game_script.c written by ejectGbaBuild) into a .gba and copies it to
// <buildRoot>/build/gba/<romFilename> for the CLI/UI copy-out to collect.
//
// M9c: builds OUT OF TREE, in the build's own copy of the engine
// (<tmp>/_gbsbuild/gba, prepared by prepareGbaEngine.ts) rather than in the
// engine checkout. Two consequences handled here: the copied tree's relative
// `LIBBUTANO := ../butano/butano` no longer resolves, so the absolute path is
// passed to make as LIBBUTANOABS; and the ROM/map are named after the build
// dir, since gbavm's Makefile takes TARGET from $(notdir $(CURDIR)).
//
// Toolchain: Butano's butano.mak picks devkitARM when DEVKITARM is set, else
// Wonderful Toolchain when WONDERFUL_TOOLCHAIN is set. Wonderful is PREFERRED
// when installed - its packages are redistributable, unlike devkitPro's, so
// it's what shipped builds will use (the M9 packaging path, see
// GBA_STUDIO_ROADMAP.md) - with devkitARM as the fallback. Force a choice with
// GBA_TOOLCHAIN=wonderful|devkitarm. (A suspected WT DMG-music bug turned out
// to be a pre-existing engine bug hit on both toolchains - gbavm#43; WT output
// is verified equivalent.) IMPORTANT: the two toolchains' objects are
// incompatible - run a clean build in the engine tree when switching.

import os from "os";
import Path from "path";
import {
  copyFile,
  ensureDir,
  pathExists,
  readdir,
  readFile,
  stat,
} from "fs-extra";
import type { SpawnOptions } from "child_process";
import spawn, { ChildProcess } from "lib/helpers/cli/spawn";
import { envWith } from "lib/helpers/cli/env";
import { buildToolsRoot } from "consts";
import { findGbaToolchain, gbaToolchainHelp } from "./findGbaToolchain";

type MakeGbaOptions = {
  /** Where the ROM is copied out to: <outputRoot>/build/gba/<romFilename>. */
  buildRoot: string;
  /** The build's own engine tree (M9c) - make runs here. */
  engineRoot: string;
  /** Butano's library root, passed to make since the copied tree's relative path can't resolve. */
  butanoRoot: string;
  romFilename: string;
  progress: (msg: string) => void;
  warnings: (msg: string) => void;
};

const cpuCount = os.cpus().length;
/** Lines of make output kept to explain a failed build. */
const MAKE_TAIL_LINES = 40;
const childSet = new Set<ChildProcess>();
let cancelling = false;

// C:\foo\bar -> /c/foo/bar  (msys2 path form)
const toUnixPath = (p: string): string =>
  p
    .replace(/\\/g, "/")
    .replace(
      /^([A-Za-z]):\//,
      (_m, drive: string) => `/${drive.toLowerCase()}/`,
    );

// GBA ROM stats (M7 follow-up): the GB path prints GBDK romusage; give the GBA
// path an equivalent one-line summary. ROM = the .gba file size; IWRAM (32KB)
// and EWRAM (256KB) usage summed from the link map's top-level output sections
// (lines at column 0; input sections are indented and skipped).
const reportRomStats = async (
  engineRoot: string,
  romPath: string,
  progress: (msg: string) => void,
) => {
  const size = (await stat(romPath)).size;
  let iwram = 0;
  let ewram = 0;
  try {
    const mapPath = Path.join(
      engineRoot,
      "build",
      `${Path.basename(engineRoot)}.map`,
    );
    const map = await readFile(mapPath, "utf8");
    for (const m of map.matchAll(
      /^(\.\S+)\s+0x([0-9a-f]{8,})\s+0x([0-9a-f]+)/gim,
    )) {
      const addr = parseInt(m[2], 16);
      const len = parseInt(m[3], 16);
      if (addr >= 0x03000000 && addr < 0x03008000) iwram += len;
      else if (addr >= 0x02000000 && addr < 0x02040000) ewram += len;
    }
  } catch (e) {
    // No/unreadable map: report the ROM size alone.
  }
  const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;
  const pct = (n: number, total: number) => `${Math.round((n / total) * 100)}%`;
  progress(
    `GBA ROM stats: ${kb(size)} ROM` +
      (iwram || ewram
        ? `, IWRAM ${kb(iwram)}/32KB (${pct(iwram, 32768)})` +
          `, EWRAM ${kb(ewram)}/256KB (${pct(ewram, 262144)})`
        : ""),
  );
};

const makeGbaBuild = async ({
  buildRoot,
  engineRoot,
  butanoRoot,
  romFilename,
  progress = (_msg) => {},
  warnings = (_msg) => {},
}: MakeGbaOptions) => {
  cancelling = false;
  if (!(await pathExists(Path.join(butanoRoot, "butano.mak")))) {
    throw new Error(
      `GBA build: Butano not found at ${butanoRoot} (set the BUTANO_ROOT environment variable).`,
    );
  }
  const envDkp = process.env.DEVKITPRO?.replace(/\\/g, "/");
  const toolchain = await findGbaToolchain({
    buildToolsRoot,
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    exists: pathExists,
  });
  const wonderful =
    toolchain?.kind === "wonderful-msys2"
      ? { msys2Root: toolchain.msys2Root }
      : toolchain?.kind === "wonderful"
        ? { root: toolchain.root }
        : null;

  let command: string;
  let args: string[];
  let options: SpawnOptions;
  let toolchainName: string;

  // Butano's makefiles consume LIBBUTANOABS only (butano.mak and
  // tools/sources_setup.mak); gbavm's Makefile derives it from LIBBUTANO behind
  // an `ifndef`, so setting it on the command line wins and skips the $(realpath)
  // of a path that no longer exists relative to the copied tree. Quoted because
  // a user's project/tmp path can contain spaces. MSYS2 make needs the /c/... form.
  const butanoVarUnix = `LIBBUTANOABS='${toUnixPath(butanoRoot)}'`;
  const butanoVarNative = `LIBBUTANOABS="${butanoRoot}"`;

  if (toolchain?.kind === "bundled") {
    // The shipped bundle (M9d): everything the build needs lives under one
    // root, and the toolchain relocates because WT's gcc.specs resolves its
    // paths from $WONDERFUL_TOOLCHAIN at compile time.
    toolchainName = "bundled toolchain";
    const root = toolchain.root.replace(/\\/g, "/");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WONDERFUL_TOOLCHAIN: root,
    };
    delete env.DEVKITARM;
    delete env.DEVKITPRO;

    if (process.platform === "win32") {
      // The bundle carries its own make + POSIX shell under sh/, so no MSYS2
      // install is needed. Paths must use FORWARD SLASHES: the shell strips
      // backslashes, which silently mangles them into nonsense mid-build.
      command = `${root}/sh/usr/bin/make.exe`;
      args = [
        `LIBBUTANOABS=${butanoRoot.replace(/\\/g, "/")}`,
        `-j${cpuCount}`,
      ];
      env.PATH = envWith([
        `${root}/sh/usr/bin`,
        `${root}/bin`,
        // Butano's asset step needs python. A bundled one wins when present;
        // otherwise the system's is used (macOS/Linux always have one).
        `${root}/python`,
      ]);
    } else {
      command = "make";
      args = [butanoVarNative, `-j${cpuCount}`];
      env.PATH = envWith([`${root}/bin`]);
    }
    options = {
      cwd: engineRoot,
      shell: process.platform !== "win32",
      env,
    };
  } else if (wonderful && "msys2Root" in wonderful) {
    // Wonderful Toolchain on Windows: run make through the standard MSYS2 bash
    // with the env the Wonderful shell would set. DEVKITARM/DEVKITPRO must be
    // unset or butano.mak picks devkitARM instead.
    toolchainName = "Wonderful Toolchain";
    command = `${wonderful.msys2Root}/usr/bin/bash.exe`;
    args = [
      "-lc",
      `cd '${toUnixPath(engineRoot)}' && unset DEVKITARM DEVKITPRO && ` +
        `export WONDERFUL_TOOLCHAIN=/opt/wonderful PATH=/opt/wonderful/bin:$PATH && ` +
        `make ${butanoVarUnix} -j${cpuCount}`,
    ];
    options = {
      env: { ...process.env, MSYSTEM: "UCRT64" },
      shell: false,
    };
  } else if (wonderful && "root" in wonderful) {
    toolchainName = "Wonderful Toolchain";
    const env = { ...process.env };
    delete env.DEVKITARM;
    delete env.DEVKITPRO;
    command = "make";
    args = [butanoVarNative, `-j${cpuCount}`];
    options = {
      cwd: engineRoot,
      shell: true,
      env: {
        ...env,
        WONDERFUL_TOOLCHAIN: wonderful.root,
        PATH: envWith([`${wonderful.root}/bin`]),
      },
    };
  } else if (process.platform === "win32") {
    // devkitARM fallback. On Windows, DEVKITPRO is the msys2 *mount* path (e.g.
    // /opt/devkitpro), not a usable Win32 path - use the env value only if it's
    // a drive-letter path, else the standard install location. The msys2 login
    // shell (-l) then sources the profile that exports DEVKITPRO/DEVKITARM and
    // puts make + toolchain on PATH.
    toolchainName = "devkitARM";
    const dkpWin =
      envDkp && /^[A-Za-z]:/.test(envDkp) ? envDkp : "C:/devkitPro";
    const bash = `${dkpWin}/msys2/usr/bin/bash.exe`;
    if (!(await pathExists(bash))) {
      throw new Error(gbaToolchainHelp(process.platform));
    }
    command = bash;
    args = [
      "-lc",
      `cd '${toUnixPath(engineRoot)}' && make ${butanoVarUnix} -j${cpuCount}`,
    ];
    options = { env: process.env, shell: false };
  } else {
    // devkitARM on Unix. Check it is actually there: without this the build
    // reaches make and dies on a missing compiler, which tells the user nothing
    // about what to install.
    toolchainName = "devkitARM";
    const devkitPro = envDkp ?? "/opt/devkitpro";
    const devkitArm = `${devkitPro}/devkitARM`;
    if (!(await pathExists(`${devkitArm}/bin`))) {
      throw new Error(gbaToolchainHelp(process.platform));
    }
    command = "make";
    args = [butanoVarNative, `-j${cpuCount}`];
    options = {
      cwd: engineRoot,
      shell: true,
      env: {
        ...process.env,
        DEVKITPRO: devkitPro,
        DEVKITARM: devkitArm,
        PATH: envWith([`${devkitArm}/bin`, `${devkitPro}/tools/bin`]),
      },
    };
  }

  progress(`Building GBA ROM (${toolchainName}/Butano)...`);

  // Keep the tail of make's output so a failure can say WHY. Without this the
  // error is just "make failed (exit 2)": the compiler's actual complaint goes
  // to progress/warnings, which the CLI drops unless --verbose and the editor
  // shows in a log pane the user may never open. A build that cannot explain
  // itself is the worst thing to hand someone whose toolchain is subtly wrong.
  const tail: string[] = [];
  const recordTail = (msg: string) => {
    for (const line of msg.split("\n")) {
      if (line.trim().length === 0) continue;
      tail.push(line);
      if (tail.length > MAKE_TAIL_LINES) tail.shift();
    }
  };

  const { child, completed } = spawn(command, args, options, {
    onLog: (msg) => {
      recordTail(msg);
      progress(msg);
    },
    onError: (msg) => {
      recordTail(msg);
      warnings(msg);
    },
  });
  childSet.add(child);
  try {
    await completed;
  } catch (code) {
    throw new Error(
      `GBA build: ${toolchainName} make failed (exit ${code})` +
        (tail.length ? `\n${tail.join("\n")}` : ""),
    );
  } finally {
    childSet.delete(child);
  }

  if (cancelling) {
    throw new Error("BUILD_CANCELLED");
  }

  // Butano emits $(TARGET).gba in the project root (CURDIR), where
  // TARGET = $(notdir $(CURDIR)); build/ holds only intermediates. Out of tree
  // that makes the ROM <engine build dir>.gba rather than gbavm.gba.
  const target = Path.basename(engineRoot);
  let romPath = Path.join(engineRoot, `${target}.gba`);
  if (!(await pathExists(romPath))) {
    const gbas = (await readdir(engineRoot).catch(() => [])).filter((f) =>
      f.endsWith(".gba"),
    );
    if (gbas.length === 0) {
      throw new Error(`GBA build: no .gba produced in ${engineRoot}`);
    }
    romPath = Path.join(engineRoot, gbas[0]);
  }

  const outDir = Path.join(buildRoot, "build", "gba");
  await ensureDir(outDir);
  await copyFile(romPath, Path.join(outDir, romFilename));

  // Ship the debug artifacts beside the ROM. Before M9c they could be found in
  // the engine checkout; now the build tree is a temp dir nothing outside knows
  // about, and the .elf is what the mGBA GDB-stub recipe (and the CI runtime
  // test) needs, while the .map is how the audio-backend-linked assert works.
  const romBase = romFilename.replace(/\.gba$/i, "");
  for (const [from, to] of [
    [Path.join(engineRoot, `${target}.elf`), `${romBase}.elf`],
    [Path.join(engineRoot, "build", `${target}.map`), `${romBase}.map`],
  ]) {
    if (await pathExists(from)) {
      await copyFile(from, Path.join(outDir, to));
    }
  }

  await reportRomStats(engineRoot, romPath, progress);
  progress(`GBA ROM built: ${romFilename}`);
};

export const cancelGbaBuildCommandsInProgress = async () => {
  cancelling = true;
  for (const child of childSet) {
    try {
      child.kill();
    } catch (e) {}
  }
};

export default makeGbaBuild;
