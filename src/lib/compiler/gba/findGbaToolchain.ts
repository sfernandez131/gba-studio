// GBA Studio - locating a GBA toolchain (M9d).
//
// Three ways a machine can have one, in descending order of preference:
//
//  1. BUNDLED - buildTools/<platform>-<arch>/gba-toolchain, assembled by
//     src/scripts/assembleGbaToolchain.ts and shipped in the installer. Self
//     contained: on Windows it carries its own make and shell under sh/, so a
//     build needs nothing installed. This is what makes GBA Studio shippable.
//  2. WONDERFUL - a system Wonderful Toolchain install, which is how this was
//     developed and how CI still runs. Kept as the developer path.
//  3. devkitARM - the historical fallback, handled by the caller. It is never
//     bundled: devkitPro's terms forbid redistribution, which is why the
//     Wonderful Toolchain became the default in the first place.
//
// `GBA_TOOLCHAIN=bundled|wonderful|devkitarm` forces a choice, which is how the
// bundled path gets exercised on a machine that also has a system install.

export type GbaToolchain =
  /** A shipped bundle. `root` holds bin/, target/, toolchain/ and (on Windows) sh/. */
  | { kind: "bundled"; root: string }
  /** System Wonderful inside an MSYS2 tree on Windows: <msys2Root>/opt/wonderful. */
  | { kind: "wonderful-msys2"; msys2Root: string }
  /** System Wonderful on Unix. */
  | { kind: "wonderful"; root: string };

export type GbaToolchainPreference = "bundled" | "wonderful" | "devkitarm";

export type FindGbaToolchainOptions = {
  buildToolsRoot: string;
  platform: NodeJS.Platform;
  arch: string;
  env: Record<string, string | undefined>;
  exists: (path: string) => Promise<boolean>;
};

export const gbaToolchainPreference = (
  env: Record<string, string | undefined>,
): GbaToolchainPreference | undefined => {
  const raw = env.GBA_TOOLCHAIN?.toLowerCase();
  return raw === "bundled" || raw === "wonderful" || raw === "devkitarm"
    ? raw
    : undefined;
};

/**
 * The path a bundled toolchain would live at. Exported so callers can report it
 * in an error message rather than leaving the user guessing.
 */
export const bundledToolchainRoot = (
  buildToolsRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): string => `${buildToolsRoot}/${platform}-${arch}/gba-toolchain`;

/**
 * Pick a toolchain, or null when only devkitARM (or nothing) is available.
 *
 * `exists` and `env` are injected so the preference order can be tested without
 * a real install of anything.
 */
export const findGbaToolchain = async ({
  buildToolsRoot,
  platform,
  arch,
  env,
  exists,
}: FindGbaToolchainOptions): Promise<GbaToolchain | null> => {
  const preference = gbaToolchainPreference(env);
  if (preference === "devkitarm") {
    return null;
  }

  // 1. The bundle. `target/gba` is the marker: an empty or half-fetched
  //    directory should fall through rather than fail mid-build.
  //
  //    WINDOWS ONLY, unless asked for explicitly. Wonderful's Unix binaries are
  //    musl-linked with an ABSOLUTE ELF interpreter baked in
  //    (/opt/wonderful/lib/ld-musl-x86_64.so.1), and an interpreter path cannot
  //    be relative - so a bundle assembled from them runs only while the
  //    original install is still there, failing with a bare "not found"
  //    otherwise. Windows PE binaries carry no such path, which is why bundling
  //    works there and only there for now. Auto-selecting a bundle on Unix would
  //    mean preferring something that cannot work over a system install that
  //    can. `GBA_TOOLCHAIN=bundled` still forces it, so a future patchelf'd or
  //    differently-sourced bundle stays testable. See docs/M9_PACKAGING_DESIGN.md.
  if (preference !== "wonderful" && (platform === "win32" || preference)) {
    const root = bundledToolchainRoot(buildToolsRoot, platform, arch);
    if (await exists(`${root}/target/gba`)) {
      return { kind: "bundled", root };
    }
    if (preference === "bundled") {
      throw new Error(
        `GBA build: GBA_TOOLCHAIN=bundled but no bundled toolchain found at ${root}. ` +
          `Assemble one with: ts-node src/scripts/assembleGbaToolchain.ts --source=<toolchain root>`,
      );
    }
  }

  // 2. A system Wonderful install.
  if (platform === "win32") {
    const msys2Root = env.WONDERFUL_MSYS2?.replace(/\\/g, "/") ?? "C:/msys64";
    if (await exists(`${msys2Root}/opt/wonderful/bin`)) {
      return { kind: "wonderful-msys2", msys2Root };
    }
  } else {
    const root = env.WONDERFUL_TOOLCHAIN ?? "/opt/wonderful";
    if (await exists(`${root}/bin`)) {
      return { kind: "wonderful", root };
    }
  }

  if (preference === "wonderful") {
    throw new Error(
      "GBA build: GBA_TOOLCHAIN=wonderful but no Wonderful Toolchain install found " +
        "(expected <msys2>/opt/wonderful on Windows, $WONDERFUL_TOOLCHAIN or /opt/wonderful elsewhere).",
    );
  }

  return null;
};

/**
 * What to tell someone who has no GBA toolchain.
 *
 * Until a bundle ships on every platform this is a real user-facing state, and
 * "make: command not found" three layers down is not an answer. On Windows a
 * bundle is expected, so its absence is a broken install; elsewhere the user is
 * expected to have a toolchain, so point at how to get one.
 */
export const gbaToolchainHelp = (platform: NodeJS.Platform): string =>
  platform === "win32"
    ? "GBA build: no GBA toolchain found. A bundled toolchain should have shipped with " +
      "GBA Studio - try reinstalling, or install the Wonderful Toolchain " +
      "(https://wonderful.asie.pl/) and rebuild."
    : "GBA build: no GBA toolchain found. Install the Wonderful Toolchain " +
      "(https://wonderful.asie.pl/ - it provides ARM GCC, grit and mmutil), then " +
      "ensure WONDERFUL_TOOLCHAIN points at it (default /opt/wonderful). devkitARM " +
      "also works if you already have it. A bundled toolchain currently ships on " +
      "Windows only - see docs/M9_PACKAGING_DESIGN.md.";
