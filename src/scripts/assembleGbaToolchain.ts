/**
 * Assemble a self-contained, relocatable GBA toolchain bundle (M9d).
 *
 * GBA Studio cannot ship today because a GBA build needs an ARM toolchain the
 * user installs by hand. This script produces the bundle that fixes that:
 *
 *   buildTools/<platform>-<arch>/gba-toolchain/
 *     bin/                     wf-gbatool (ROM header fixer)
 *     toolchain/               arm-none-eabi GCC + binutils
 *     target/gba/              specs, crt0, headers, link scripts
 *     thirdparty/blocksds/...  grit (graphics) + mmutil (audio)
 *     licenses/                every licence text for the above
 *
 * RELOCATABILITY is the property that makes this possible, and it is not an
 * accident: Wonderful Toolchain's gcc.specs resolves its include and library
 * paths through `%:getenv(WONDERFUL_TOOLCHAIN /target/gba/...)`, i.e. from the
 * environment at compile time rather than from a baked-in prefix. Point
 * WONDERFUL_TOOLCHAIN at the bundle and the same compiler works from any path.
 *
 * SIZE. A full Wonderful install is ~700MB, most of which no GBA build touches:
 * a package cache, docs, tools for other consoles, and multilib variants for
 * ARM cores the GBA does not have (it is an ARM7TDMI). The prune list below is
 * what survives; see `--keep-all` to skip pruning when diagnosing a failure.
 *
 * LICENSING. Everything here is redistributable on its own terms, but the GPL
 * components (GCC, binutils, grit) oblige whoever distributes the binaries to
 * make corresponding source available. This script therefore refuses to produce
 * a bundle without collecting licence texts, and writes a MANIFEST recording
 * what went in - see docs/M9_PACKAGING_DESIGN.md, section M9a.
 *
 * Usage:
 *   ts-node src/scripts/assembleGbaToolchain.ts --source=<toolchain root> [--out=<dir>] [--keep-all]
 *
 * This script only assembles a bundle locally. Publishing one - which is what
 * creates the source-availability obligation - is a separate, deliberate step.
 */

import Path from "path";
import {
  copy,
  ensureDir,
  pathExists,
  readFile,
  readdir,
  remove,
  stat,
  writeFile,
} from "fs-extra";

const arg = (name: string): string | undefined =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const platformArch = `${process.platform}-${process.arch}`;
const repoRoot = Path.normalize(`${__dirname}/../../`);

/**
 * A relocatable bundle must contain no links back into the machine that built
 * it. Unix toolchain trees are full of symlinks (Windows ones are not, which is
 * why this only bites once the script runs on Linux or macOS), and copying them
 * as links would leave the bundle silently depending on the source install -
 * working on the build machine and breaking everywhere else.
 */
const copyOptions = { dereference: true } as const;

/** Paths copied out of the source toolchain, relative to its root. */
const bundleContents = [
  "target/gba",
  "toolchain/gcc-arm-none-eabi",
  "thirdparty/blocksds/core/tools/grit",
  "thirdparty/blocksds/core/tools/mmutil",
  "thirdparty/blocksds/core/licenses",
  // wf-lua's module path: the wf-* tools `require` Penlight and friends from
  // here. Small (~2MB), and the build dies deep inside a Lua traceback without
  // it - a failure that only appears once the tools run outside their install.
  "lib/lua",
  "share",
];

/**
 * Tools taken from `bin/`. The whole of bin/ is ~17MB of tooling for other
 * consoles; a GBA build calls just two - `wf-gbatool` fixes the ROM header and
 * `wf-bin2s` turns binary assets into assembly. Derived by grepping Butano's
 * makefiles for `wf-` references, and confirmed by a build failing on the one
 * that was missing.
 *
 * `wf-lua` is here because those two are not programs at all: they are Lua
 * scripts, and they need their interpreter. See rewriteShebangs below.
 */
const binaryPrefixes = ["wf-gbatool", "wf-bin2s", "wf-lua"];

/** Windows binaries need the runtime DLLs sitting beside them in bin/. */
const dllSuffix = ".dll";

/**
 * The Windows shell half of the bundle (`--msys2=<root>`), emitted under `sh/`.
 *
 * Butano builds through `make`, and make runs its recipes through a POSIX
 * shell. macOS and Linux have both; Windows does not, and a shipped app cannot
 * assume the user installed MSYS2. These are the only programs a GBA build
 * actually reaches for - the list is short because it was derived by running
 * builds until they stopped failing, not by reading makefiles:
 *
 *   make, sh, bash        the build driver and its shell
 *   mkdir, rm, echo, true the only coreutils Butano's recipes invoke
 *   env                   resolves `#!/usr/bin/env wf-lua` (see rewriteShebangs)
 *   cygpath               NOT referenced by any makefile - wf-lua shells out to
 *                         it on Windows to resolve WONDERFUL_TOOLCHAIN, and the
 *                         build dies at the final ROM-fix step without it
 *
 * msys-2.0.dll decides the POSIX root from its own location, so `sh/` becomes
 * "/" and `sh/usr/bin` is both /usr/bin and /bin - hence the mirror.
 */
const shellTools = [
  "make.exe",
  "sh.exe",
  "bash.exe",
  "mkdir.exe",
  "rm.exe",
  "echo.exe",
  "true.exe",
  "env.exe",
  "cygpath.exe",
  "msys-2.0.dll",
  "msys-intl-8.dll",
  "msys-iconv-2.dll",
];

/**
 * Multilib variants to keep. The GBA's CPU is an ARM7TDMI; every other core's
 * libraries are dead weight. Kept as a prefix list because the layout differs
 * between `lib/` and `lib/gcc/arm-none-eabi/<ver>/`.
 */
const keepMultilibs = ["arm7tdmi", "thumb"];

/** Pruned regardless: never consulted by a build. */
const prunePaths = [
  "share/doc",
  "share/man",
  "share/info",
  "share/locale",
  "share/gcc-arm-none-eabi",
];

const dirSize = async (dir: string): Promise<number> => {
  let total = 0;
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = Path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        total += (await stat(full)).size;
      }
    }
  };
  await walk(dir);
  return total;
};

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/**
 * Remove multilib directories for cores the GBA does not have. Returns the
 * directories removed, so the caller can report what pruning bought.
 */
const pruneMultilibs = async (root: string): Promise<string[]> => {
  const removed: string[] = [];
  const candidates = [
    Path.join(root, "toolchain/gcc-arm-none-eabi/arm-none-eabi/lib"),
    Path.join(root, "toolchain/gcc-arm-none-eabi/lib/gcc/arm-none-eabi"),
  ];
  for (const base of candidates) {
    if (!(await pathExists(base))) continue;
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = Path.join(base, entry.name);
      // Version dirs (e.g. "16.1.1") hold the multilibs one level down.
      if (/^\d+\.\d+/.test(entry.name)) {
        for (const sub of await readdir(full, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          if (
            !keepMultilibs.includes(sub.name) &&
            looksLikeMultilib(sub.name)
          ) {
            await remove(Path.join(full, sub.name));
            removed.push(Path.join(entry.name, sub.name));
          }
        }
        continue;
      }
      if (
        !keepMultilibs.includes(entry.name) &&
        looksLikeMultilib(entry.name)
      ) {
        await remove(full);
        removed.push(entry.name);
      }
    }
  }
  return removed;
};

/**
 * A multilib dir is named after a CPU or ABI variant. Anything else at that
 * level (ldscripts, plain .a files, include dirs) must be left alone - deleting
 * by exclusion is how you silently break a toolchain.
 */
const looksLikeMultilib = (name: string): boolean =>
  /^(arm|thumb|cortex|mpcore|iwmmxt|marm|fpu|nofp|v\d)/i.test(name);

/**
 * Repoint the Lua tools' interpreter at the bundle.
 *
 * `wf-gbatool` and `wf-bin2s` are Lua scripts whose shebang hardcodes an
 * absolute install path - `#!/opt/wonderful/bin/wf-lua`. That is invisible until
 * you move the toolchain: the build appears to work while silently running the
 * *system* interpreter, and fails outright on a machine that has no system
 * install. Rewriting to `#!/usr/bin/env wf-lua` makes them resolve `wf-lua` from
 * PATH instead, so the bundle works wherever it is unpacked.
 *
 * These tools are MIT licensed, so modifying them is permitted; the change is
 * recorded in the bundle's MANIFEST.
 */
const rewriteShebangs = async (bundleRoot: string): Promise<string[]> => {
  const binDir = Path.join(bundleRoot, "bin");
  if (!(await pathExists(binDir))) return [];
  const rewritten: string[] = [];
  for (const entry of await readdir(binDir)) {
    const full = Path.join(binDir, entry);
    if (/\.(exe|dll)$/i.test(entry)) continue;
    if (!(await stat(full)).isFile()) continue;
    const body = await readFile(full, "utf8").catch(() => "");
    const match = body.match(/^#!(\S*\/)?wf-lua\b/);
    if (!match || body.startsWith("#!/usr/bin/env ")) continue;
    await writeFile(full, body.replace(/^#![^\n]*/, "#!/usr/bin/env wf-lua"));
    rewritten.push(entry);
  }
  return rewritten;
};

const collectLicenses = async (
  sourceRoot: string,
  bundleRoot: string,
): Promise<number> => {
  const licenseDir = Path.join(bundleRoot, "licenses");
  await ensureDir(licenseDir);
  let count = 0;

  // BlocksDS ships its licence texts as a directory; keep it whole.
  const blocksds = Path.join(bundleRoot, "thirdparty/blocksds/core/licenses");
  if (await pathExists(blocksds)) {
    await copy(blocksds, Path.join(licenseDir, "blocksds"));
    count += (await readdir(Path.join(licenseDir, "blocksds"))).length;
  }

  // grit carries its own COPYING (GPLv2).
  const gritCopying = Path.join(
    bundleRoot,
    "thirdparty/blocksds/core/tools/grit/COPYING",
  );
  if (await pathExists(gritCopying)) {
    await copy(gritCopying, Path.join(licenseDir, "grit-COPYING.txt"));
    count += 1;
  }

  // GCC's own licence files, wherever the distribution put them.
  for (const name of [
    "COPYING",
    "COPYING3",
    "COPYING.RUNTIME",
    "COPYING.LIB",
  ]) {
    const from = Path.join(sourceRoot, "toolchain/gcc-arm-none-eabi", name);
    if (await pathExists(from)) {
      await copy(from, Path.join(licenseDir, `gcc-${name}.txt`));
      count += 1;
    }
  }

  return count;
};

const main = async () => {
  const source = arg("source");
  if (!source) {
    throw new Error(
      "--source=<toolchain root> is required (a Wonderful Toolchain install, e.g. C:/msys64/opt/wonderful)",
    );
  }
  if (!(await pathExists(Path.join(source, "target/gba")))) {
    throw new Error(
      `No GBA target found under ${source} - is that a Wonderful Toolchain root?`,
    );
  }

  const out =
    arg("out") ??
    Path.join(repoRoot, "buildTools", platformArch, "gba-toolchain");

  console.log(`Assembling GBA toolchain bundle`);
  console.log(`  source: ${source}`);
  console.log(`  out:    ${out}`);

  await remove(out);
  await ensureDir(out);

  for (const rel of bundleContents) {
    const from = Path.join(source, rel);
    if (!(await pathExists(from))) {
      console.log(`  - skip ${rel} (not present)`);
      continue;
    }
    console.log(`  + ${rel}`);
    await copy(from, Path.join(out, rel), copyOptions);
  }

  // The one bin/ tool a GBA build calls, plus the DLLs it needs on Windows.
  const srcBin = Path.join(source, "bin");
  if (await pathExists(srcBin)) {
    await ensureDir(Path.join(out, "bin"));
    for (const entry of await readdir(srcBin)) {
      const keep =
        binaryPrefixes.some((p) => entry.startsWith(p)) ||
        entry.toLowerCase().endsWith(dllSuffix);
      if (keep) {
        await copy(
          Path.join(srcBin, entry),
          Path.join(out, "bin", entry),
          copyOptions,
        );
      }
    }
    console.log(`  + bin/ (${binaryPrefixes.join(", ")} + runtime DLLs)`);
  }

  const beforePrune = await dirSize(out);

  if (!hasFlag("keep-all")) {
    for (const rel of prunePaths) {
      await remove(Path.join(out, "toolchain/gcc-arm-none-eabi", rel));
    }
    const removed = await pruneMultilibs(out);
    console.log(
      `  - pruned ${removed.length} multilib variant(s) for non-GBA cores` +
        (removed.length
          ? `: ${removed.slice(0, 6).join(", ")}${removed.length > 6 ? ", ..." : ""}`
          : ""),
    );
  }

  const msys2 = arg("msys2");
  if (msys2) {
    const from = Path.join(msys2, "usr/bin");
    if (!(await pathExists(from))) {
      throw new Error(`No usr/bin under ${msys2} - is that an MSYS2 root?`);
    }
    const shBin = Path.join(out, "sh/usr/bin");
    await ensureDir(shBin);
    await ensureDir(Path.join(out, "sh/tmp"));
    for (const tool of shellTools) {
      const src = Path.join(from, tool);
      if (!(await pathExists(src))) {
        throw new Error(`Shell bundle: ${tool} not found in ${from}`);
      }
      await copy(src, Path.join(shBin, tool));
    }
    // msys-2.0.dll treats sh/ as "/", where /bin and /usr/bin are the same dir.
    await copy(shBin, Path.join(out, "sh/bin"));
    console.log(`  + sh/ (${shellTools.length} files: make, shell, coreutils)`);
  } else if (process.platform === "win32") {
    console.log(
      `  ! no --msys2=<root> given: the bundle will need make/sh from elsewhere on Windows`,
    );
  }

  const rewritten = await rewriteShebangs(out);
  if (rewritten.length) {
    console.log(
      `  ~ repointed ${rewritten.length} Lua tool shebang(s) at the bundle: ${rewritten.join(", ")}`,
    );
  }

  const licenseCount = await collectLicenses(source, out);
  if (licenseCount === 0) {
    throw new Error(
      "Refusing to produce a bundle with no licence texts - the GPL components " +
        "(GCC, binutils, grit) require them. Check the source toolchain layout.",
    );
  }
  console.log(`  + licenses/ (${licenseCount} file(s))`);

  const afterPrune = await dirSize(out);
  await writeFile(
    Path.join(out, "MANIFEST.txt"),
    [
      `GBA Studio toolchain bundle`,
      `platform: ${platformArch}`,
      `assembled: ${new Date().toISOString()}`,
      `source: ${source}`,
      ``,
      `Contents:`,
      ...bundleContents.map((c) => `  ${c}`),
      `  bin/${binaryPrefixes.join(", ")}`,
      `  licenses/`,
      ``,
      `Relocatable: set WONDERFUL_TOOLCHAIN to this directory.`,
      ``,
      `This bundle contains GPL-licensed programs (arm-none-eabi GCC and`,
      `binutils, grit). Anyone redistributing these binaries must also make the`,
      `corresponding source available - see docs/M9_PACKAGING_DESIGN.md (M9a).`,
      ``,
    ].join("\n"),
  );

  console.log(
    `\nBundle assembled: ${mb(afterPrune)}` +
      (hasFlag("keep-all")
        ? ""
        : ` (pruned from ${mb(beforePrune)}, saved ${mb(beforePrune - afterPrune)})`),
  );
  console.log(`Verify with:  WONDERFUL_TOOLCHAIN=${out} <build a project>`);
};

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
