// GBA Studio - GBA make step (Butano on Wonderful Toolchain or devkitARM).
//
// Counterpart to makeBuild.ts for the GBA target. Builds the gbavm engine tree
// (with the game_script.c written by ejectGbaBuild) into a .gba and copies it to
// <buildRoot>/build/gba/<romFilename> for the CLI/UI copy-out to collect.
//
// M2: builds in-place in the gbavm engine tree (gbaEngineRoot) so Butano's
// relative LIBBUTANO path and warm build cache are reused. Isolated/vendored
// build dirs are a later packaging concern.
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
import { gbaEngineRoot } from "consts";

type MakeGbaOptions = {
  buildRoot: string;
  romFilename: string;
  progress: (msg: string) => void;
  warnings: (msg: string) => void;
};

const cpuCount = os.cpus().length;
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

// Locate a Wonderful Toolchain install. On Windows it lives inside an MSYS2
// tree at <msys2>/opt/wonderful (WONDERFUL_MSYS2 or C:/msys64); on Unix at
// $WONDERFUL_TOOLCHAIN or /opt/wonderful.
const findWonderful = async (): Promise<
  { msys2Root: string } | { root: string } | null
> => {
  if (process.platform === "win32") {
    const msys2Root =
      process.env.WONDERFUL_MSYS2?.replace(/\\/g, "/") ?? "C:/msys64";
    if (await pathExists(`${msys2Root}/opt/wonderful/bin`)) {
      return { msys2Root };
    }
    return null;
  }
  const root = process.env.WONDERFUL_TOOLCHAIN ?? "/opt/wonderful";
  if (await pathExists(`${root}/bin`)) {
    return { root };
  }
  return null;
};

// GBA ROM stats (M7 follow-up): the GB path prints GBDK romusage; give the GBA
// path an equivalent one-line summary. ROM = the .gba file size; IWRAM (32KB)
// and EWRAM (256KB) usage summed from the link map's top-level output sections
// (lines at column 0; input sections are indented and skipped).
const reportRomStats = async (
  romPath: string,
  progress: (msg: string) => void,
) => {
  const size = (await stat(romPath)).size;
  let iwram = 0;
  let ewram = 0;
  try {
    const mapPath = Path.join(
      gbaEngineRoot,
      "build",
      `${Path.basename(gbaEngineRoot)}.map`,
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
  romFilename,
  progress = (_msg) => {},
  warnings = (_msg) => {},
}: MakeGbaOptions) => {
  cancelling = false;
  const envDkp = process.env.DEVKITPRO?.replace(/\\/g, "/");
  const toolchainPref = process.env.GBA_TOOLCHAIN?.toLowerCase();
  const wonderful =
    toolchainPref === "devkitarm" ? null : await findWonderful();
  if (toolchainPref === "wonderful" && !wonderful) {
    throw new Error(
      "GBA build: GBA_TOOLCHAIN=wonderful but no Wonderful Toolchain install found " +
        "(expected <msys2>/opt/wonderful on Windows, $WONDERFUL_TOOLCHAIN or /opt/wonderful elsewhere).",
    );
  }

  let command: string;
  let args: string[];
  let options: SpawnOptions;
  let toolchainName: string;

  if (wonderful && "msys2Root" in wonderful) {
    // Wonderful Toolchain on Windows: run make through the standard MSYS2 bash
    // with the env the Wonderful shell would set. DEVKITARM/DEVKITPRO must be
    // unset or butano.mak picks devkitARM instead.
    toolchainName = "Wonderful Toolchain";
    command = `${wonderful.msys2Root}/usr/bin/bash.exe`;
    args = [
      "-lc",
      `cd '${toUnixPath(gbaEngineRoot)}' && unset DEVKITARM DEVKITPRO && ` +
        `export WONDERFUL_TOOLCHAIN=/opt/wonderful PATH=/opt/wonderful/bin:$PATH && ` +
        `make -j${cpuCount}`,
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
    args = [`-j${cpuCount}`];
    options = {
      cwd: gbaEngineRoot,
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
      throw new Error(
        `GBA build: no GBA toolchain found. Install Wonderful Toolchain (MSYS2 + ` +
          `/opt/wonderful) or devkitPro (msys2 bash not found at ${bash}).`,
      );
    }
    command = bash;
    args = ["-lc", `cd '${toUnixPath(gbaEngineRoot)}' && make -j${cpuCount}`];
    options = { env: process.env, shell: false };
  } else {
    toolchainName = "devkitARM";
    const devkitPro = envDkp ?? "/opt/devkitpro";
    const devkitArm = `${devkitPro}/devkitARM`;
    command = "make";
    args = [`-j${cpuCount}`];
    options = {
      cwd: gbaEngineRoot,
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
  const { child, completed } = spawn(command, args, options, {
    onLog: (msg) => progress(msg),
    onError: (msg) => warnings(msg),
  });
  childSet.add(child);
  try {
    await completed;
  } catch (code) {
    throw new Error(`GBA build: ${toolchainName} make failed (exit ${code})`);
  } finally {
    childSet.delete(child);
  }

  if (cancelling) {
    throw new Error("BUILD_CANCELLED");
  }

  // Butano emits $(TARGET).gba in the project root (CURDIR), where
  // TARGET = $(notdir $(CURDIR)); build/ holds only intermediates.
  const target = Path.basename(gbaEngineRoot);
  let romPath = Path.join(gbaEngineRoot, `${target}.gba`);
  if (!(await pathExists(romPath))) {
    const gbas = (await readdir(gbaEngineRoot).catch(() => [])).filter((f) =>
      f.endsWith(".gba"),
    );
    if (gbas.length === 0) {
      throw new Error(`GBA build: no .gba produced in ${gbaEngineRoot}`);
    }
    romPath = Path.join(gbaEngineRoot, gbas[0]);
  }

  const outDir = Path.join(buildRoot, "build", "gba");
  await ensureDir(outDir);
  await copyFile(romPath, Path.join(outDir, romFilename));
  await reportRomStats(romPath, progress);
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
