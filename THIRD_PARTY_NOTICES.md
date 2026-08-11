# Third-party notices

GBA Studio is distributed with, or builds against, the software listed below. Each item
remains under its own licence; the notices here are reproduced to satisfy those licences'
attribution requirements. GBA Studio itself is MIT licensed — see [LICENSE](LICENSE).

This file is an engineering inventory, kept in step with what the project actually ships.
It is not legal advice. See `docs/M9_PACKAGING_DESIGN.md` for how each item reaches a
build, and the obligations that attach when it is redistributed.

## Trademarks

"Nintendo", "Game Boy", "Game Boy Advance" and "GBA" are trademarks of Nintendo. This
project is not affiliated with, authorised, sponsored or endorsed by Nintendo. Those names
appear only to describe the hardware this software targets. **No Nintendo code, BIOS, ROM
or other asset is included or distributed.**

"GB Studio" is the work of Chris Maltby and contributors. GBA Studio is an independent
fork and is not affiliated with or endorsed by the GB Studio project.

Other product and company names are the trademarks of their respective owners and are used
descriptively.

## Shipped today

| Component | Author | Licence | Where |
| --- | --- | --- | --- |
| GB Studio | Chris Maltby and contributors | MIT | this repository (fork base) |
| GBVM | Toxa | MIT | `appData/engine/gbvm` |
| gbavm (GBA engine) | Scott Fernandez; derived from GBVM | MIT | `appData/engine/gba` |
| mGBA (WebAssembly core) | Jeffrey Pfau and contributors | MPL 2.0 | `appData/wasm/mgba` — see `LICENSE.mgba.txt` |
| binjgb (WebAssembly core) | Ben Smith ("binji"), with changes from Daid's fork and others | MIT | `appData/wasm/binjgb` — notice in `README.md` |

## Fetched at setup, shipped in installers

| Component | Author | Licence | Notes |
| --- | --- | --- | --- |
| GBDK-2020 | GBDK-2020 contributors | mixed; includes GPLv2 components | fetched by `yarn fetch-deps`; ships its own `licenses/` directory, which is preserved |

## Linked into GBA ROMs

Everything in this section is compiled into the games users build, so its licensing
determines what licence a user may put on their own game. **All of it is permissive**, with
the GNU runtime carrying the GCC Runtime Library Exception — which is what allows a game
built with GBA Studio to be released under any licence, including a commercial one.

| Component | Author | Licence |
| --- | --- | --- |
| Butano | Gustavo Valiente | zlib |
| libtonc | J. Vijn | MIT |
| libugba | Antonio Niño Díaz | MIT |
| Maxmod | Mukunda Johnson; Antonio Niño Díaz; Lorenzooone | ISC |
| GBT Player | Antonio Niño Díaz | MIT |
| Apex Audio System (AAS) | James Daniels; Ties Stuij | MIT |
| agbabi | contributors | zlib |
| stdgba | contributors | zlib |
| posprintf | Mark Schmelzenbach | public domain dedication |
| gba-modern | João Baptista de Paula e Silva | MIT |
| cult-of-gba-bios | DenSinH; fleroviux | MIT |
| gba-link-connection | Rodrigo Alfonso | MIT |
| ETL (Embedded Template Library) | John Wellbelove | MIT |
| CTTI | Manuel Sánchez | MIT |
| line-clipping | Michael Hirsch | MIT |
| Wonderful Toolchain crt0 | Luna Mittelbach; Adrian Siekierka | zlib |
| devkitARM crt0 (devkitARM builds only) | devkitPro | MPL 2.0 |
| `libgcc`, `libstdc++` | Free Software Foundation | GPLv3 **with GCC Runtime Library Exception 3.1** |

Butano's own copies of these notices live in `appData/engine/butano/licenses/`.

## Build tools — invoked, never linked

These are run as separate programs during a build. They are not linked into GBA Studio or
into any game, so their licences do not extend to either (mere aggregation). Redistributing
their binaries does carry an obligation to make the corresponding source available; see the
M9a section of `docs/M9_PACKAGING_DESIGN.md`.

| Tool | Licence |
| --- | --- |
| arm-none-eabi GCC, binutils | GPLv3 |
| GNU make | GPLv3 |
| grit | GPLv2 |
| Python | PSF |

**Not bundled:** devkitPro / devkitARM is supported as a toolchain if a user installs it
themselves, but is never redistributed with GBA Studio, in line with its terms.
