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

**Engine & pipeline**
- [ ] Port the GBVM hardware command handlers onto Butano (actors/sprites, backgrounds, camera, input)
- [ ] Rewrite the asset converters for GBA formats (4bpp tiles, 16-color palettes, hardware metasprites)
- [ ] Rewrite the build pipeline to invoke devkitARM/Butano (Build → `.gba`)
- [ ] Swap the in-app preview emulator (binjgb → mGBA)
- [ ] Update editor limits & palette model for GBA (240×160, 128 sprites, larger palettes)

**Milestone**
- [ ] **Proof of concept:** a player-controllable walking sprite on GBA, built end-to-end from the editor

**Beyond the PoC:** affine / Mode-7 effects, a sampled-audio music workflow, link-cable
multiplayer, and the optional-code escape hatch.

## Status

The hardest part is already done: **GB Studio's bytecode VM now runs natively on the GBA's
ARM CPU.** Current focus is the hardware bridge — making VM opcodes drive Butano so the
editor's scenes, sprites, and input render on real GBA hardware.

## Building from source

The editor is GB Studio and builds the same way — install [Node.js](https://nodejs.org/)
(version in [.nvmrc](.nvmrc)), then:

```bash
corepack enable
yarn
yarn fetch-deps   # initializes the GBVM submodule and fetches build tools
yarn start
```

The GBA engine ([`gbavm`](https://github.com/sfernandez131/gbavm)) currently builds
separately with devkitARM + Butano; wiring the editor's **Build** button to emit `.gba`
is on the roadmap above. For the GB Studio editor's CLI and full documentation, see the
upstream [GB Studio docs](https://www.gbstudio.dev/docs).

## Credits & license

GBA Studio is a fork of **[GB Studio](https://github.com/chrismaltby/gb-studio)** by Chris
Maltby and contributors — an extraordinary project that makes this possible. GB Studio is
Copyright (c) 2019–2026 Chris Maltby, released under the
[MIT license](https://opensource.org/licenses/MIT); **this fork retains that license** (see
[LICENSE](LICENSE)). Please support the original project:
[Patreon](https://www.patreon.com/gbstudiodev) · [gbstudio.dev](https://www.gbstudio.dev).

The GBA engine builds on [Butano](https://github.com/GValiente/butano) by Gustavo Valiente
and the [devkitPro](https://devkitpro.org/) toolchain.
