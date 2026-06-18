# GBA Studio

> ⚠️ **Experimental — work in progress.** GBA Studio is an independent fork of
> [GB Studio](https://github.com/chrismaltby/gb-studio). It is **not affiliated with or
> endorsed by** the GB Studio project.

**GBA Studio takes GB Studio's drag-and-drop game editor and retargets it from the original
Game Boy to the Game Boy Advance** — so you can build GBA games the same no-code way, then
reach for hardware the Game Boy never had.

![The GB Studio editor that GBA Studio is built on](gbstudio.gif)

## Goal

- **Keep the GB Studio experience.** Same visual editor, scenes, sprites, dialogue, and
  event scripting. 100% no-code by default.
- **Target the GBA natively.** Replace the Game Boy / GBDK backend with a
  [Butano](https://github.com/GValiente/butano) + devkitARM engine that produces real
  `.gba` ROMs.
- **Unlock GBA-only features.** 240×160 screen, thousands of on-screen colors, 128 hardware
  sprites, rotation/scaling (affine) backgrounds and sprites, sampled audio, link-cable play.
- **Optional code, always.** No code required — but an opt-in escape hatch for power users
  (custom script events → custom C++/Butano), layered so the visual builder stays the default.

## How it's built

GBA Studio is split into two repos, mirroring GB Studio's own editor + engine layout:

| Part | What | Repo |
| --- | --- | --- |
| **Editor** | GB Studio's Electron/React app (this repo), being retargeted for GBA | `sfernandez131/gba-studio` |
| **Engine** | GB Studio's **GBVM** bytecode VM, ported from Z80/GBDK to C/C++ on **Butano** | [`sfernandez131/gbavm`](https://github.com/sfernandez131/gbavm) |

**Toolchain:** devkitARM + Butano + Maxmod (replacing GBDK/SDCC + hUGEDriver), with **mGBA** for preview.

## Roadmap

**Foundation**
- [x] Baseline GB Studio editor running from source
- [x] GBA toolchain verified (devkitARM 16.1.0 + Butano → `.gba`)
- [x] `gbavm` engine skeleton boots on GBA
- [x] **Port the GBVM core** — interpreter & opcode dispatch, full RPN evaluator, control
  flow, and the 16-thread scheduler *(verified on emulated GBA hardware)*

**Engine & pipeline — the editor now builds to `.gba` end-to-end**
- [x] **Hardware command handlers (core slice)** — actors, sprites & input drive Butano on
  real GBA hardware *(backgrounds & camera still to come)*
- [x] **GBA bytecode emit layer** — the editor's opcode stream → little-endian `gbavm`
  bytecode + a relocation table
- [x] **Codegen → engine bridge** — GB Studio's compiled GBVM assembly is parsed straight
  into `gbavm` bytecode, so real editor-authored scenes run
- [x] **Build pipeline → `.gba`** — `gb-studio-cli make:gba project.gbsproj out.gba` runs the
  editor's codegen → bridge → devkitARM/Butano → a runnable ROM *(GUI **Build** button next)*
- [ ] Asset converters for GBA formats (4bpp tiles, 16-color palettes, hardware metasprites)
- [ ] Multi-scene builds — cross-script linking, scene runtime, fades & camera
- [ ] Swap the in-app preview emulator (binjgb → mGBA)
- [ ] Update editor limits & palette model for GBA (240×160, 128 sprites, larger palettes)

**Milestone**
- [ ] **Proof of concept:** a player-controllable walking sprite on GBA, built end-to-end
  from the editor — *in progress: an editor-authored scene already builds to a `.gba` and
  renders its actor on GBA; player movement & input are next*

### Beyond the PoC — the road to a finished product

The unchecked items above are the first concrete steps of a longer arc: reaching
parity with GB Studio on the GBA, then the GBA-only features that justify the fork.
The broad phases, from the proof of concept to a shippable tool:

1. **Real scenes** — full asset pipeline (4bpp tiles, 16-color palette banks, hardware
   metasprites, fonts) so scenes render with their actual art instead of placeholders.
2. **Gameplay** — player + input-driven movement, camera, tile/actor collision, per-frame
   actor update scripts, and the gameplay opcode set.
3. **Dialogue, UI & scene flow** — text/dialogue, overlay menus, variables, and multi-scene
   transitions (the scene stack + cross-script linking).
4. **Audio** — music + sound effects on GBA (Maxmod), wired to the editor's sound workflow.
5. **Save & systems → GB Studio parity** — SRAM saves and the remaining engine systems; the
   bundled **gbs2** sample game builds and plays end-to-end on GBA.
6. **GBA-native editor** — GUI **Build** button, GBA limits & palette model, in-app **mGBA**
   preview.
7. **GBA superpowers** — affine / Mode-7 rotation-scaling, thousands of colors, sampled
   audio, link-cable multiplayer, and the optional-code (C++/Butano) escape hatch.
8. **Ship** — vendored engine, bundled toolchain, cross-platform builds, docs & releases.

Phases 1–5 are the bulk of the work (GB Studio itself is years of development); 7–8 are what
make GBA Studio worth using and shippable.

## Status

Two milestones down. **GB Studio's bytecode VM runs natively on the GBA**, and the editor now
**builds a project to a real `.gba` end-to-end**: it runs GB Studio's own codegen, bridges the
compiled bytecode to the `gbavm` engine, assembles it with devkitARM + Butano, and an
editor-authored scene's actor renders on GBA hardware — via `gb-studio-cli make:gba`. Current
focus: broadening the hardware handlers (backgrounds, camera, movement) and the GBA asset
pipeline so full scenes render, then the GUI **Build** button and player input for the
walking-sprite proof of concept.

## Building from source

The editor is GB Studio and builds the same way — install [Node.js](https://nodejs.org/)
(version in [.nvmrc](.nvmrc)), then:

```bash
corepack enable
yarn
yarn fetch-deps   # initializes the GBVM submodule and fetches build tools
yarn start
```

The editor can now build a project to a `.gba` through the `gbavm` engine from the CLI:

```bash
gb-studio-cli make:gba project.gbsproj out.gba   # requires devkitARM + Butano
```

Wiring the GUI **Build** button is next. The GBA engine
([`gbavm`](https://github.com/sfernandez131/gbavm)) also builds standalone with devkitARM +
Butano. For the GB Studio editor's CLI and full documentation, see the upstream
[GB Studio docs](https://www.gbstudio.dev/docs).

## Credits & license

GBA Studio is a fork of **[GB Studio](https://github.com/chrismaltby/gb-studio)** by Chris
Maltby and contributors — an extraordinary project that makes this possible. GB Studio is
Copyright (c) 2019–2026 Chris Maltby, released under the
[MIT license](https://opensource.org/licenses/MIT); **this fork retains that license** (see
[LICENSE](LICENSE)). Please support the original project:
[Patreon](https://www.patreon.com/gbstudiodev) · [gbstudio.dev](https://www.gbstudio.dev).

The GBA engine builds on [Butano](https://github.com/GValiente/butano) by Gustavo Valiente
and the [devkitPro](https://devkitpro.org/) toolchain.
