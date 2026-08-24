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

| Slice   | Scope                                                                                                                                                                                                                           | Verify                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M9a** | This design doc, plus the toolchain spike: settle candidate 1 vs 2, and the `make`/`python` question, with a written answer.                                                                                                    | A spike note in this doc; no code.                                                                                                                                                        |
| **M9b** | Vendor the engines: `appData/engine/gba` + `appData/engine/butano` submodules; `consts.ts` gains `gbaEngineRoot`/`butanoRoot` pointing at them, with `GBAVM_ROOT` demoted to a dev override.                                    | The demo builds with `GBAVM_ROOT` unset; CI drops its clone steps and stays green.                                                                                                        |
| **M9c** | Out-of-tree builds: thread `engineRoot` through eject + make, copy-per-build, `LIBBUTANO` override, object cache.                                                                                                               | Build two different projects back to back and diff the vendored engine tree — it must be byte-identical afterwards. A ROM built out-of-tree must match one built in place.                |
| **M9d** | Toolchain bundling per the M9a answer: an assembly script producing `gba-toolchain-<plat>-<version>` + a matching source tarball and `licenses/` dir; `fetchDependencies.ts` + lock + `buildTools/<plat>-<arch>/gba-toolchain`. | `yarn fetch-deps --arch=<each>` succeeds; a GBA build works with no hand-installed toolchain on a clean machine/container; every GPL binary in the bundle has source published beside it. |
| **M9e** | Packaging + cross-platform CI: `after-copy` filter, the packaging smoke job, release-matrix wiring.                                                                                                                             | The packaged app builds the Lost Gem demo on each platform in CI.                                                                                                                         |
| **M9f** | Docs + cleanup: contributor setup instructions, remove the `D:/source/gbavm` fallback, retire the baseline-restore step from the workflow notes.                                                                                | A fresh clone + documented setup builds a GBA ROM.                                                                                                                                        |

### M9a spike outcome — the licensing answer

**This section is an engineering inventory, not legal advice.** It records what each component
that would ship is licensed under and what obligation that creates. A lawyer should confirm the
GPL §6 mechanics before the first release that bundles a toolchain.

#### What ends up inside a user's ROM

This is the question that matters most for a game-making tool, and it is settled. The link map
of the Lost Gem demo shows a ROM links exactly four things:

| Linked into every ROM               | License                                       |
| ----------------------------------- | --------------------------------------------- |
| `crt0.o` (Wonderful Toolchain)      | zlib                                          |
| `libgcc.a`                          | GPLv3 **+ GCC Runtime Library Exception 3.1** |
| `libstdc++.a`                       | GPLv3 **+ GCC Runtime Library Exception 3.1** |
| Butano and its 17 bundled libraries | zlib / MIT / ISC / CC0 / public domain        |

The Runtime Library Exception is granted in the shipped headers (verified, not assumed) and
exists precisely to allow GCC's runtime to be linked into a program under any license, provided
compilation used an Eligible Compilation Process — plain GCC, which is what we do. Every one of
Butano's bundled libraries was checked individually: maxmod is ISC; libtonc, gbt-player, ugba,
etl, ctti, gba-modern, cult-of-gba-bios, aas, gba-link-connection and lineclipping are MIT;
agbabi, stdgba and the WT crt0 are zlib; posprintf is a public-domain dedication. The only
copyleft in the set is MPL-2.0 on `devkitarm-crt0`, which is file-level and only reaches a build
that uses the devkitARM path.

**No copyleft reaches the ROM. Users can license and sell their games however they like.** This
is a property to protect in every later slice, not just a fact to record.

#### What we would ship in the installer

| Component                       | License                | Obligation                    |
| ------------------------------- | ---------------------- | ----------------------------- |
| GB Studio fork, gbavm           | MIT                    | notice                        |
| Butano + third parties          | zlib / MIT / ISC / CC0 | notices                       |
| arm-none-eabi GCC, binutils     | GPLv3                  | **corresponding source**      |
| `libgcc` / `libstdc++` binaries | GPLv3 + RLE            | **corresponding source**      |
| GNU make                        | GPLv3                  | **corresponding source**      |
| **grit**                        | **GPLv2**              | **corresponding source**      |
| Python                          | PSF                    | notice                        |
| mGBA wasm (already shipped)     | MPL 2.0                | source availability           |
| GBDK-2020 (already shipped)     | mixed, GPLv2 parts     | ships its own `licenses/` dir |

These tools are _invoked as subprocesses, never linked_, so bundling them alongside an MIT
application is mere aggregation — GB Studio's own licensing is unaffected. The recurring
obligation is source availability for the GPL binaries we redistribute.

#### The decision

**Assemble our own toolchain bundle from upstream sources and publish it ourselves.**

The blocker this milestone carried — "may we redistribute Wonderful Toolchain's packages?" —
turns out to be the wrong question. Every component is redistributable on its own terms; WT is
just a convenient channel. Building our own bundle removes the dependency on someone else's
goodwill entirely, and it fixes a real gap: **WT's tree ships no `COPYING3` or `COPYING.RUNTIME`,
so redistributing it as-is would inherit a compliance defect.** Owning the bundle means owning
the licence files too.

Concretely, for M9d:

1. Build `gba-toolchain-<platform>-<version>` per platform from ARM's official GNU toolchain
   release (or FSF sources), plus grit, plus make.
2. Publish it in **our own** GitHub releases with a matching `-src.tar.gz` beside it. Same place,
   equivalent access — the cleanest way to discharge GPL §6, and the same shape GBDK's authors
   use (they ship a `licenses/` directory, which GB Studio copies wholesale today).
3. SHA-256 pin it in `dependencies.lock` and fetch it through the existing
   `fetchDependencies.ts`, which is why M9d was scoped around that mechanism.
4. Ship a `licenses/` directory inside the bundle, mirroring GBDK's layout.

**devkitPro stays excluded** regardless — its trademark and repackaging terms are the original
reason for this whole question. The devkitARM code path remains detect-only, never bundled.

**Revised position on Python.** The design originally floated reimplementing Butano's asset step
to delete the Python dependency. On inspection that means reimplementing `butano_assets_tool.py`
plus the graphics, audio and DMG-audio tools it drives — and permanently diverging from Butano's
own pipeline, so every Butano update becomes a merge. Python is PSF licensed (a notice, no source
obligation), macOS and Linux ship it, and python.org publishes an embeddable Windows package
intended for exactly this. **Bundle Python; do not fork Butano's tooling.** Reconsider only if
the bundle size turns out to matter.

The ongoing commitment this creates is hosting source tarballs alongside each release, for as
long as the corresponding binaries are distributed.

### M9b outcome

Both engines are now submodules under `appData/engine`, pinned by commit:
`appData/engine/gba` → sfernandez131/gbavm, `appData/engine/butano` →
GValiente/butano at the `21.7.0` tag the engine is verified against. `consts.ts` resolves
both from there; `GBAVM_ROOT` and `BUTANO_ROOT` survive only as developer overrides for
pointing a build at a working checkout. **A build with both unset produces a
byte-identical ROM**, and `gba-ci.yml` drops its `git clone` steps — so a green CI run is
finally reproducible from a gba-studio SHA alone (problem 5, closed).

Fetching Butano the way GBDK is fetched was considered, because its **145 MB working tree
is now checked out by all eight CI jobs** while only one needs it (history is just 17 MB,
so the cost is disk and checkout time rather than network). It was rejected on
reproducibility grounds: Butano publishes **no release assets**, only GitHub's
auto-generated source archives, and those are not guaranteed byte-stable, so they cannot
be SHA-256 pinned the way `dependencies.lock` pins GBDK. A submodule pins by commit, which
is the stronger guarantee. If CI time becomes a problem, the fix is a partial or sparse
submodule checkout, not a tarball.

Packaging excludes Butano's `examples/`, `games/`, `tests/`, `docs/`, `docs_tools/` and
`issues/` — roughly 120 MB of the 145 MB — plus the engine's `build/` and `builds/`, via
the existing `after-copy` filter. Only `appData/engine/butano/butano` is needed to build.

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

**Correction to the above.** That first "builds from the bundle" result was only partly true.
`wf-gbatool` and `wf-bin2s` are not programs — they are Lua scripts whose shebang hardcodes
`#!/opt/wonderful/bin/wf-lua`. The build appeared to succeed from the bundle while silently
running the **system** interpreter, and would have failed outright on a machine with no
Wonderful install. This is the failure mode a bundle is most likely to hide, because
everything looks green on the machine that built it. See the shell answer below for the fix.

### The Windows shell answer

macOS and Linux have `make`, a POSIX shell and `python` system-wide, so they need nothing
extra. Windows has none of them, and a shipped app cannot assume MSYS2.

Two options were on the table: bundle a shell environment, or drop `make` and drive
compilation from TypeScript the way `makeBuild.ts` already drives GBDK (GB Studio ships **no**
`make` — it spawns `lcc` per file and links). **Bundling wins**, on two grounds: it is ~19 MB
against a 435 MB toolchain, a rounding error; and driving compilation ourselves would mean
reimplementing `butano.mak`'s flags, source discovery and asset step, then re-syncing it
every time Butano changes — the same divergence argument that rejected rewriting the Python
asset tool.

The bundle now carries a `sh/` directory, and **the whole of what Windows needs is twelve
files**. That list was arrived at by running builds until they stopped failing, which is why
it is short and why two entries would never have been found by reading:

| Need                          | Why                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make`, `sh`, `bash`          | the build driver and the shell its recipes run in                                                                                                               |
| `mkdir`, `rm`, `echo`, `true` | the only coreutils Butano's recipes invoke                                                                                                                      |
| `env`                         | resolves the rewritten `#!/usr/bin/env wf-lua` shebang                                                                                                          |
| **`cygpath`**                 | **not referenced by any makefile** — `wf-lua` shells out to it on Windows to resolve `WONDERFUL_TOOLCHAIN`; without it the build dies at the final ROM-fix step |
| `msys-2.0.dll` + 2            | the runtime those binaries link against                                                                                                                         |

The assembly script also **rewrites the Lua tools' shebangs** to `#!/usr/bin/env wf-lua`, so
they resolve their interpreter from the bundle rather than from an absolute install path.
Those tools are MIT licensed, so modifying them is permitted; the MANIFEST records it.

**Verified end to end**: with `WONDERFUL_TOOLCHAIN` pointed at the bundle and `PATH`
containing only the bundle plus a native Windows Python — **no system MSYS2 or Wonderful
install reachable** — a build produces a **byte-identical ROM**. Bundle 456 MB, of which the
shell half is 19 MB.

Python is the one piece still borrowed: the test used a system CPython. It does not need to
be an MSYS2 one — every path the makefiles hand to Python is Windows-style, so **python.org's
embeddable package (~15 MB, PSF licensed, no source obligation) is the intended answer**, and
that is a fetch rather than a copy. Worth noting the path form matters: Windows paths must be
passed with forward slashes, since the shell eats backslashes.

### The build prefers the bundle

`makeGbaBuild` no longer hunts for MSYS2 at a fixed path. Toolchain discovery moved into
`findGbaToolchain.ts`, which picks, in order:

1. **bundled** — `buildTools/<platform>-<arch>/gba-toolchain`, using its own `sh/` on Windows
   so nothing need be installed;
2. **a system Wonderful install** — the developer path, and what CI still uses;
3. **devkitARM**, left to the caller as before, and never bundled.

`GBA_TOOLCHAIN=bundled|wonderful|devkitarm` forces a choice, so the bundled path can be
exercised on a machine that also has a system install — and, usefully, CI pins
`GBA_TOOLCHAIN=wonderful`, so it regression-tests the fallback on every PR. A bundle
directory without `target/gba` in it is ignored rather than trusted, so a half-fetched
bundle fails during discovery instead of deep inside a compile. 17 unit tests cover the
order, the overrides and the loud-failure cases.

**Verified end to end through the CLI**: with a bundle in `buildTools/win32-x64/`, a plain
`make:gba` auto-selects it and produces a **byte-identical ROM**.

**One more finding, and it settles how Python must ship.** The first CLI attempt failed with
a nonsense path — `/cygdrive/c/...<cwd>.../C:/Users/...`. An **MSYS2/Cygwin Python** had been
picked up from the inherited `PATH` (devkitPro ships one), and such a Python treats a
`C:/...` argument as a _relative_ path. A native Windows Python handles it correctly. So the
bundle cannot merely _hope_ a usable Python is present: it has to **ship one and put it first
on PATH**, which is what `<bundle>/python` is for. This is a stronger argument for bundling
Python than size or licensing ever was — the alternative is breaking on any machine with a
Cygwin-flavoured Python installed.

Deliberately not done: `fetchDependencies.ts` + `dependencies.lock` wiring, which is
mechanical but pointless until there is a published bundle to fetch.

### M9e progress — CI builds from the bundle, on Linux

Every job before this built with a _system_ Wonderful install: how this was developed, but not
how a user's machine looks. The new **`gba-bundled-toolchain`** job builds what we intend to
ship — a self-contained bundle, used with no toolchain installed:

1. install Wonderful (the bundle's source material);
2. `assembleGbaToolchain.ts --source=/opt/wonderful`, asserting the bundle has a GBA target,
   a MANIFEST, and a non-empty `licenses/` — the GPL components make those mandatory;
3. **`sudo mv /opt/wonderful /opt/wonderful.hidden`**;
4. build the demo with `GBA_TOOLCHAIN=bundled` and assert the ROM plus a linked audio backend.

Step 3 is the point. Anything still reaching for a system install fails in CI rather than on a
user's machine — which is exactly how the wf-tools' hardcoded `#!/opt/wonderful/bin/wf-lua`
shebang was caught on Windows, where a bundle build had looked green while silently using the
system interpreter.

It is also the first time `assembleGbaToolchain.ts`, `findGbaToolchain`'s bundled branch and
`makeGbaBuild`'s bundled+unix branch run anywhere other than the author's Windows box. Risk 5
said to expect surprises there rather than in the design; this job is where they surface.

#### What the job found: WT's Linux binaries are not relocatable

The job went red four times, and each failure was a real defect invisible from Windows. The
last one changes the milestone's plan, so it is worth stating precisely.

| #   | Failure                                            | Fix                                                                                                                                                                                       |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `make failed (exit 2)` and nothing else            | `makeGbaBuild` now keeps make's last 40 lines and puts them in the error — the CLI drops progress output unless `--verbose`, so failures were undiagnosable from a CI log or a bug report |
| 2   | symlinks copied as links into the build machine    | assemble with `dereference: true`                                                                                                                                                         |
| 3   | `mmutil: not found`, though present and executable | not a file problem — see below                                                                                                                                                            |
| 4   | —                                                  | the actual cause                                                                                                                                                                          |

`readelf` on every Wonderful binary — `mmutil`, `grit`, `wf-lua`, and `arm-none-eabi-gcc`
itself — shows the same thing:

```
interpreter /opt/wonderful/lib/ld-musl-x86_64.so.1
libc.musl-x86_64.so.1 => not found
```

They are musl-linked with an **absolute ELF interpreter path**. An interpreter path cannot be
relative, so these binaries run only when `/opt/wonderful` exists at exactly that location.
Move the install and they fail with a bare "not found", indistinguishable from a missing file.

**Wonderful Toolchain is relocatable on Windows and not on Linux.** Windows PE binaries carry
no interpreter path, and WT's `gcc.specs` resolves everything else from `$WONDERFUL_TOOLCHAIN`
— which is why every Windows test passed, and why this could only surface here.

That falsifies part of the M9a spike. **Candidate 1 (repackage WT) works on Windows but cannot
produce a self-contained Linux bundle** without `patchelf`-ing every ELF to point at the
install location — which, since the final path is only known on the user's machine, would mean
running patchelf at fetch time and bundling patchelf itself. **Candidate 2 (ARM's official GNU
toolchain) uses the system interpreter and relocates for free**, which is exactly why it is the
conventional thing to bundle. This is the first hard evidence between the two, and it points at
a split: WT on Windows, ARM's toolchain on Linux and macOS — or ARM's everywhere, with `grit`
and `mmutil` sourced separately.

Pending that decision the job assembles and inspects rather than hiding the install and
building from the bundle: that step would fail for a reason no change in this repo can fix. It
still builds _using_ the bundle, which exercises `findGbaToolchain`'s bundled branch and
`makeGbaBuild`'s bundled+unix branch — everything except the relocation. A guard asserts the
interpreter is still the `/opt/wonderful` one, so if a future toolchain source relocates
cleanly, CI says so and the stricter steps come back.

Still to come in M9e: a packaging smoke job that runs the _packaged_ app rather than the repo,
and release-matrix wiring — both of which need a published bundle to fetch, so they follow M9d's
remaining piece rather than preceding it.

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

1. ~~**Toolchain redistribution is unresolved.**~~ **Resolved by the M9a spike**: every
   component is redistributable on its own terms, so we assemble and publish our own bundle
   rather than asking permission to redistribute someone else's. What remains is an
   _obligation_, not an unknown — GPL corresponding source must be published beside every
   release that carries the toolchain, and kept available for as long as those binaries are.
   A lawyer should confirm the §6 mechanics before the first such release.
2. ~~**`make` and `python` may not be bundleable cheaply.**~~ Both are bundleable: Python is
   PSF (notice only) with an official embeddable Windows package, make is GPLv3 and rides the
   same source-publication path as the compiler. The asset-step rewrite is explicitly **not**
   taken — it would fork Butano's tooling permanently for no licensing gain.
3. **Losing the warm build cache** would turn every build into a full Butano rebuild. The
   object cache in M9c is not optional garnish — it is the price of leaving the engine tree.
4. **Butano as a submodule pins a large-ish tree** (7.6 MB for the library, far more if the
   whole repo is taken). Mitigation: submodule the repo but exclude `examples/`, `games/`,
   `docs/` at package time via the `after-copy` filter, as is already done for gbvm's
   `test/` and `examples/`.
5. **Cross-platform is genuinely untested.** Every GBA build to date has run on this one
   Windows box. macOS and Linux paths in `makeGbaBuild` exist but have never been exercised;
   M9e is the first time they will be. Expect surprises there, not in the design.

## Scope decision: bundle on Windows, detect and guide elsewhere

The interpreter finding leaves four ways to get a toolchain onto a user's machine, and none of
them is free:

| Option                                        | Why not, or not yet                                                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| devkitARM                                     | cannot be redistributed — the constraint that started all of this                                                                                                                                                               |
| Wonderful                                     | relocatable on Windows; **not** on Linux/macOS (absolute ELF interpreter)                                                                                                                                                       |
| ARM's official GNU toolchain                  | relocatable, but **Butano supports exactly two toolchains** — `butano.mak` picks devkitARM or Wonderful by env var and hard-`$(error)`s otherwise, so adopting it means owning and maintaining a third integration indefinitely |
| patchelf the Wonderful bundle at install time | keeps Butano's supported path, but needs ELF surgery on the user's machine and patchelf itself bundled                                                                                                                          |

**The decision: ship a bundle on Windows; on Linux and macOS, detect a system toolchain and
tell the user how to install one.** The reasoning is that Windows is where bundling both
matters most and already works — no package manager, no system toolchain, and the Wonderful
binaries relocate cleanly, verified end to end with a byte-identical ROM. Linux and macOS users
have package managers and Wonderful has a one-line installer, so a clear message is a
defensible v1 there. This unblocks M9 now for the cost of a `platform === "win32"` check, and
leaves patchelf available later if Unix bundling turns out to matter.

What that means in code:

- `findGbaToolchain` only **auto-selects** a bundle on Windows. `GBA_TOOLCHAIN=bundled` still
  forces it anywhere, so CI keeps exercising the bundled branch on Linux and a future
  relocatable bundle needs no code change to try.
- A missing toolchain now produces `gbaToolchainHelp()` — naming the Wonderful Toolchain, its
  URL and `WONDERFUL_TOOLCHAIN` on Unix, and treating absence on Windows as a broken install.
  The Unix devkitARM path also checks the compiler exists first, instead of reaching `make`
  and dying on a missing binary.
- `assembleGbaToolchain` prints a prominent warning when run on a non-Windows host, with the
  `readelf` command to confirm it: a bundle that is not self-contained must say so, or someone
  will ship a broken installer on the strength of its name.

## Deferred

- Signing/notarisation for the GBA-specific payload (the existing macOS notarize hook should
  cover the bundle as a whole; verify in M9e).
- A "GBA target" onboarding flow in the editor UI (detect a missing toolchain, offer to
  fetch it). M9d's error message is the floor; the flow is polish.
- Shrinking the vendored engine further (Butano subset rather than full submodule) — do it
  only if bundle size proves to be a problem.
