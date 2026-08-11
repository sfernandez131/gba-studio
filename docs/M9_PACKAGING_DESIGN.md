# M9 — ship / packaging (design, 2026-08-10)

Per the roadmap: _"Vendor gbavm into `appData/engine/gba`; out-of-tree builds (stop
writing into the engine checkout; fixes the stale-incremental-build class of bug);
bundle the ARM toolchain; cross-platform CI builds; installers."_

M15 finished the _product_ argument — the Lost Gem demo shows every shipped GBA
capability. M9 is the _distribution_ argument: today the GBA target only builds on a
machine hand-set-up like the original dev's. **No user who installs GB Studio can build
a GBA ROM.** M9 closes that, and in doing so removes the build-hygiene ritual every
engine slice has paid since M2.

M9 is deliberately unglamorous and touches no gameplay code. It is also the last
structural work before M16 (upstream merge-back) is even discussable: upstream will not
take a target that depends on two sibling checkouts and a hand-installed toolchain.

## Where the two targets stand today

| Aspect             | GB target (works, shipped)                                                                                                                                          | GBA target (dev machine only)                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Engine location    | `appData/engine/gbvm`, a git submodule of upstream's gbvm                                                                                                           | a **sibling checkout**: `gbaEngineRoot` = `$GBAVM_ROOT`, else the hardcoded `D:/source/gbavm` (`src/consts.ts`) |
| Butano             | n/a                                                                                                                                                                 | a **second sibling checkout** — gbavm's `Makefile` hardcodes `LIBBUTANO := ../butano/butano`                    |
| Where a build runs | a temp dir, `<tmp>/_gbsbuild`; `ejectBuild` copies the engine in per build                                                                                          | **in place, inside the engine checkout** (`makeGbaBuild`, by design since M2)                                   |
| Toolchain          | GBDK-2020, fetched per platform by `src/scripts/fetchDependencies.ts`, SHA-256 pinned in `buildTools/dependencies.lock`, shipped in `buildTools/<platform>-<arch>/` | **nothing bundled** — the developer installs Wonderful Toolchain or devkitPro by hand                           |
| Other host deps    | none beyond GBDK                                                                                                                                                    | `make`, `python`, and `grit` (the latter ships inside BlocksDS)                                                 |
| Installer          | `after-copy` hook copies `/appData/` + `/buildTools/<platform>-<arch>` into the bundle                                                                              | GBA engine and toolchain are simply absent                                                                      |
| CI                 | uses the bundled GBDK                                                                                                                                               | clones gbavm (**unpinned**) + Butano (pinned to `21.7.0`) and bootstraps WT over the network every run          |

## The five problems, with evidence

**1. The engine path is a dev-machine assumption.** `src/consts.ts` falls back to
`D:/source/gbavm` — the original developer's drive. Every GBA build on this machine works
only because a `GBAVM_ROOT` user env var papers over it. Nothing about the GBA engine ships
in the installer.

**2. Builds write into the engine checkout.** `ejectGbaBuild` has ~20 write sites, all
rooted at `gbaEngineRoot`: `src/gba_program.c`, `src/gba_scenes.c`, the generated
`gba_*_assets.h` headers, `src/gba_user_code.h`, plus `graphics/*.bmp|json` and
`audio/*.mod|wav` per project. Four consequences, all real:

- **The baseline ritual.** Every engine commit needs a hand-restore of the generated files
  plus a standalone `make` to prove the committed baseline still compiles — a step in the
  workflow notes since M2, and a step that has actually bitten (M10c changed
  `gba_scene_assets.h`'s struct shape, so `git checkout --` restored a baseline that no
  longer compiled against the new `hw.cpp`).
- **Stale assets across projects.** Build project A then project B and A's
  `graphics/scene5_sprite_*.bmp` are still sitting there, still picked up by Butano's asset
  step. This is exactly the "stale-incremental-build class of bug" the roadmap names, and
  it is the same class as the M5/M6 silently-dropped-audio-backend bug the CI size assert
  now guards against.
- **No concurrency.** Two projects cannot build at once; the second corrupts the first.
- **A shipped engine can't work at all.** An installed `appData/engine/gba` is read-only on
  principle and may be genuinely read-only on disk.

**3. Butano isn't vendored, and its path is baked into the engine.** `LIBBUTANO :=
../butano/butano` in gbavm's Makefile assumes a sibling checkout. Butano is **zlib**
licensed — freely redistributable — and the library proper (`butano/butano`) is 7.6 MB
against 145 MB for the whole upstream repo, so vendoring a subset is both legal and cheap.

**4. No toolchain ships, and the ARM compiler is not the whole story.** Butano's asset step
shells out to `python` (`common_setup.mak:92` runs `butano_assets_tool.py`), and the build
driver is `make`. Wonderful Toolchain provides neither — on this machine both came from
MSYS2's own pacman. It does provide `grit`, at
`thirdparty/blocksds/core/tools/grit/grit.exe`. So a shipped GBA Studio needs **ARM GCC +
grit + make + python**, where the GB path needs only what GBDK already bundles. This is the
hardest part of M9 and the part most likely to change shape once spiked.

**5. CI pins Butano but not the engine.** `gba-ci.yml` clones gbavm at `master` HEAD. A push
to the engine repo can therefore change gba-studio's CI result with no gba-studio commit —
the current green is not reproducible from a gba-studio SHA alone.

## Design

### Layout

Mirror the GB side exactly, because it is the shape upstream already accepts:

```
appData/engine/gbvm/      (existing submodule -> chrismaltby/gbvm)
appData/engine/gba/       (new submodule    -> sfernandez131/gbavm)
appData/engine/butano/    (new submodule    -> GValiente/butano, pinned to its release tag)
buildTools/<plat>-<arch>/gbdk/          (existing, fetched)
buildTools/<plat>-<arch>/gba-toolchain/ (new, fetched)
```

Submodules for both engines: they pin by commit (fixing problem 5), keep the repo small,
match the `gbvm` precedent, and let `after-copy`'s existing `/appData/` copy ship them with
no packaging change beyond an entry in its `disallowedDirs` filter to drop Butano's
`examples/`, `games/`, `docs/` and gbavm's `build/`.

### Out-of-tree builds

Mirror `ejectBuild`: copy the engine into the per-build temp root, then build _there_.

- Thread an `engineRoot` (and `butanoRoot`) parameter through `ejectGbaBuild` and
  `makeGbaBuild` instead of importing the `gbaEngineRoot` const. This is mechanical — the
  const is imported in exactly two files.
- Copy `appData/engine/gba` → `<tmp>/_gbsbuild/gba` per build, with an ignore list in the
  shape of `ejectBuild`'s (`.git`, `build`, `examples`, `builds`, `*.gba`, `*.elf`).
- Point the build at the vendored Butano **without touching the engine Makefile**, by
  overriding the variable on the command line: `make LIBBUTANO=<abs path to vendored
butano>`. The Makefile already resolves `LIBBUTANOABS` from it via `$(realpath)`.
- Keep builds warm with an object cache keyed on the engine + toolchain version, the way
  `objCache.ts` already does for GB. A cold Butano build is slow enough that dropping the
  in-place warm cache without a replacement would be a visible regression — this is the one
  thing the M2 in-place decision bought, and the slice has to pay it back.

The payoff is immediate and permanent: the engine checkout stops being a build scratch dir,
so **the hand-restore-baseline step disappears from every future slice**, stale assets
can't cross projects, and concurrent builds become possible.

### Toolchain acquisition

Extend the mechanism that already works for GBDK rather than inventing one:
`fetchDependencies.ts` gains a `gbatoolchain` entry per platform, hashes go in
`dependencies.lock`, `ensureBuildTools` copies it to tmp unchanged, and the release
workflow's existing `yarn fetch-deps --arch=<platform>` step picks it up for free.

What that entry _points at_ is the open question, and the honest answer today is
"unresolved". Three candidates, to be settled by the M9 spike before any code is written:

1. **Prebuilt Wonderful Toolchain trees, published by us.** Smallest delta from what is
   verified working today (WT has been the default since M9's prep in July). Blocked on
   confirming redistribution terms with WT's maintainer — its packages are community-built,
   and the wiki's CC-BY-NC-SA notice covers documentation, not the toolchain. BlocksDS
   core, which supplies grit, ships only CC0/MIT/zlib license texts, which is encouraging
   but not by itself an answer.
2. **ARM's official GNU toolchain + grit + glue.** The roadmap's stated fallback.
   Unambiguously redistributable; more integration work, and it needs Butano's `wt_setup.mak`
   path exercised differently.
3. **Ship no compiler; detect a user-installed one** and degrade to a clear "install a
   toolchain to build for GBA" message. Not a shipping answer, but a legitimate _first_
   slice — it makes the vendored-engine work testable end to end without waiting on the
   licensing question, and it is strictly better than today.

`make` and `python` need their own answer. Options, cheapest first: bundle a static `make`
and a minimal Python (what devkitPro and MSYS2 effectively do); or **replace Butano's asset
step with a Node implementation** — the editor already generates the `.bmp` + `.json` pairs
the tool consumes, so what remains is invoking grit and emitting the `bn_*_items` headers.
The second is more work but deletes the Python dependency from the app _and_ from CI, and
gives us control over the asset step we already half-own. Worth a spike; not worth
committing to in this document.

### CI and installers

- Pin the engine: once gbavm is a submodule, `gba-ci.yml` drops its `git clone` steps and
  uses `submodules: true`, which it already passes.
- Add a **packaging smoke job**: on each platform in the release matrix, package the app and
  assert the bundle contains a working GBA engine + toolchain, then build the Lost Gem demo
  _from the packaged layout_ rather than from the repo. This is the check that would have
  caught "works on the dev box" at any point in the last nine milestones.
- Installers need no new machinery — `after-copy` already copies `/appData/` and
  `/buildTools/<platform>-<arch>`.

## Slice plan

| Slice   | Scope                                                                                                                                                                                        | Verify                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M9a** | This design doc, plus the toolchain spike: settle candidate 1 vs 2, and the `make`/`python` question, with a written answer.                                                                 | A spike note in this doc; no code.                                                                                                                                         |
| **M9b** | Vendor the engines: `appData/engine/gba` + `appData/engine/butano` submodules; `consts.ts` gains `gbaEngineRoot`/`butanoRoot` pointing at them, with `GBAVM_ROOT` demoted to a dev override. | The demo builds with `GBAVM_ROOT` unset; CI drops its clone steps and stays green.                                                                                         |
| **M9c** | Out-of-tree builds: thread `engineRoot` through eject + make, copy-per-build, `LIBBUTANO` override, object cache.                                                                            | Build two different projects back to back and diff the vendored engine tree — it must be byte-identical afterwards. A ROM built out-of-tree must match one built in place. |
| **M9d** | Toolchain bundling per the M9a answer: `fetchDependencies.ts` + lock + `buildTools/<plat>-<arch>/gba-toolchain`.                                                                             | `yarn fetch-deps --arch=<each>` succeeds; a GBA build works with no hand-installed toolchain on a clean machine/container.                                                 |
| **M9e** | Packaging + cross-platform CI: `after-copy` filter, the packaging smoke job, release-matrix wiring.                                                                                          | The packaged app builds the Lost Gem demo on each platform in CI.                                                                                                          |
| **M9f** | Docs + cleanup: contributor setup instructions, remove the `D:/source/gbavm` fallback, retire the baseline-restore step from the workflow notes.                                             | A fresh clone + documented setup builds a GBA ROM.                                                                                                                         |

### M9c outcome (shipped ahead of M9b)

M9c landed first, since it is independent of both the vendoring and the toolchain question.
The build now runs in `<tmp>/_gbsbuild/gba`, prepared by `prepareGbaEngine.ts`, and the
engine checkout is a read-only source. Measured on the dev machine:

|                                  | Result                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Engine checkout after two builds | **byte-identical** (was 110 files dirtied by a single build)                                                               |
| Out-of-tree ROM vs in-place ROM  | **byte-identical**, and stable across rebuilds                                                                             |
| Cross-project leakage            | none — the previous project's `graphics/` are gone; the demo rebuilds byte-identically after the fixture builds in between |
| Cold build                       | 29.2 s                                                                                                                     |
| Warm rebuild                     | 12.7 s (in-place was 11.9 s, so out-of-tree costs ~0.9 s, ~7%)                                                             |

One finding changed the design. Butano's asset step decides an asset is up to date by
**comparing mtimes** against a `build/_bn_<name>_graphics_file_info.txt` sentinel
(`butano_graphics_tool.py`), so preserving the engine's timestamps on assets would let a
sentinel left by a _different_ project's build mask a restored baseline asset. Today's eject
happens to overwrite every such file, but that is a property of the current eject, not a
guarantee — so `prepareGbaEngineTree` stamps the asset dirs to now, making the property
unconditional. Code keeps its source mtimes, so the expensive half of the build stays
incremental; only asset regeneration pays, which is the ~0.9 s above.

The object dir surviving across projects is safe for linking: `common_setup.mak` derives
`OFILES_GRAPHICS` from the `.bmp` files actually present, so intermediates whose source is
gone are never referenced. Stale intermediates do accumulate in `build/` (35 after a project
switch); pruning them is deferred, as content-hashing the assets would be a better fix than
mtime bookkeeping if this is ever revisited.

**Not delivered by M9c:** concurrent builds. `<tmp>/_gbsbuild` is a single shared directory
on the GB side too, so two projects still cannot build at once — out-of-tree makes that
fixable (a per-project build dir) rather than fixing it.

### M9d progress — the bundle assembles and builds (nothing published)

`src/scripts/assembleGbaToolchain.ts` produces a self-contained bundle from a toolchain
root. Run locally against the dev machine's Wonderful install; **nothing has been published,
so no source-availability obligation has been taken on yet.**

The question this had to answer was whether a _relocated_ toolchain builds at all — a
compiler with a baked-in prefix cannot be bundled. It does, and by design rather than luck:
WT's `gcc.specs` resolves its include and library paths through
`%:getenv(WONDERFUL_TOOLCHAIN /target/gba/...)`, and `wt_setup.mak` derives every tool path
from `$(WONDERFUL_TOOLCHAIN)`. Point that variable anywhere and the toolchain follows.

| Result                |                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Bundle size           | **435 MB**, pruned from 521 MB (the source install is ~700 MB)                                                           |
| Pruned                | package cache, docs, tools for other consoles, and multilib variants for cores the GBA does not have — it is an ARM7TDMI |
| Build from the bundle | succeeds, with `WONDERFUL_TOOLCHAIN` pointed at it                                                                       |
| ROM                   | **byte-identical** to the system-toolchain build                                                                         |
| Licences              | collected into `licenses/`; the script refuses to emit a bundle without them                                             |

One finding came from a failed build rather than from reading: the bundle needs **`wf-bin2s`**
as well as `wf-gbatool`. Grepping Butano's makefiles for `wf-` confirms those two and only
those two.

**What is still missing, and it is Windows-specific.** The build above still borrowed `make`,
`python` and a POSIX shell from MSYS2. On macOS and Linux all three are present system-wide,
so those platforms are close to done; on Windows a shipped app cannot assume MSYS2, and
`makeGbaBuild` currently shells to `C:/msys64/usr/bin/bash.exe`. Butano's recipes need a
real shell, so the options are bundling a minimal MSYS2-like environment or driving the
compilation ourselves instead of through `make`. That is the remaining M9d work, and it is
a bigger question than the compiler was.

Deliberately not done: `fetchDependencies.ts` + `dependencies.lock` wiring, which is
mechanical but pointless until there is a published bundle to fetch.

## Verification

M9 has no runtime behaviour to GDB-assert, so its verification is structural, and the two
asserts that matter are:

1. **The engine tree is untouched by a build.** Hash `appData/engine/gba` before and after
   building two different projects; any difference is a bug. This is the direct test of
   problem 2 and the thing the whole milestone is for.
2. **The packaged app builds a ROM.** Not the repo — the _packaged_ app, on each platform,
   in CI. Everything else in M9 is a means to this.

Plus: the existing `gba-integration` job keeps building the Lost Gem demo every PR, and
`gb-non-regression` keeps proving the GB side is untouched (M9 should not change a byte of
GB output — it touches no compiler logic).

## Risks

1. **Toolchain redistribution is unresolved** and is the milestone's only true unknown. It
   is deliberately isolated into M9a as a spike, and M9b/M9c deliver real value regardless
   of how it lands — vendoring and out-of-tree builds are worth doing even if users still
   install their own compiler.
2. **`make` and `python` may not be bundleable cheaply**, which could push the Node
   asset-step rewrite into M9's critical path. Mitigation: M9a spikes it; if it grows, it
   becomes its own milestone and M9d ships with a detected system toolchain.
3. **Losing the warm build cache** would turn every build into a full Butano rebuild. The
   object cache in M9c is not optional garnish — it is the price of leaving the engine tree.
4. **Butano as a submodule pins a large-ish tree** (7.6 MB for the library, far more if the
   whole repo is taken). Mitigation: submodule the repo but exclude `examples/`, `games/`,
   `docs/` at package time via the `after-copy` filter, as is already done for gbvm's
   `test/` and `examples/`.
5. **Cross-platform is genuinely untested.** Every GBA build to date has run on this one
   Windows box. macOS and Linux paths in `makeGbaBuild` exist but have never been exercised;
   M9e is the first time they will be. Expect surprises there, not in the design.

## Deferred

- Signing/notarisation for the GBA-specific payload (the existing macOS notarize hook should
  cover the bundle as a whole; verify in M9e).
- A "GBA target" onboarding flow in the editor UI (detect a missing toolchain, offer to
  fetch it). M9d's error message is the floor; the flow is polish.
- Shrinking the vendored engine further (Butano subset rather than full submodule) — do it
  only if bundle size proves to be a problem.
