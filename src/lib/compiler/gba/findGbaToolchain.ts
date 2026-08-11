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
  if (preference !== "wonderful") {
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
