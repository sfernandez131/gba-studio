# M12 — Color on GBA: design (2026-07-14)

Design-first per the roadmap: this doc fixes the model and the slice plan before any
code. Sources verified against the fork (== upstream for these paths) and Butano
21.7.0 on 2026-07-14.

## Decision

**GBC-parity palettes first** (roadmap option (a)): reproduce GB Studio's 8 background
palettes × 4 colors + 8 sprite palettes × 3 colors + per-tile attribution, rendered
through GBA palette banks. Existing GBC projects then look identical on GBA with zero
authoring changes, and the editor's palette UI already exists. A GBA-native richer
mode (16×16-color banks, true-color art) extends this later — the bank layout below
deliberately leaves room for it.

## The GB Studio model (facts, from sources)

- **Data model**: scenes carry `paletteIds[8]` (+ `spritePaletteIds[8]`); backgrounds
  carry either `autoPalettes` (palettes auto-extracted from a colored PNG,
  `compileImages.ts` `readFileToPalettes`) or manual palettes + **`tileColors:
number[]`** — one palette index per 8×8 tile (background resource schema). Project
  settings hold `defaultBackgroundPaletteIds` / `defaultSpritePaletteIds` and
  `colorMode: "mono" | "mixed" | "color"`.
- **Runtime op**: `VM_LOAD_PALETTE mask, flags` (GBVM 0x7C), flags =
  `.PALETTE_COMMIT(1) | .PALETTE_BKG(2) | .PALETTE_SPRITE(4)`, followed by inline
  trailing data per masked slot: `.CGB_PAL` (4× packed RGB555) or `.DMG_PAL`
  (4 shade indices) — the VM_SWITCH/.MENUITEM trailing-table pattern
  (`scriptBuilderBase.ts` `_paletteLoad`/`_paletteColor`/`_paletteDMG`).
  Emitted by the Set Background/Sprite/UI Palette events; "keep" slots are excluded
  from the mask, "restore" re-sends the scene's authored palette
  (`scriptBuilder.ts` `paletteSetBackground`).
- **Colors**: GB Studio converts hex → 5-bit channels at compile time
  (`Math.floor(hex * 32/256)`), i.e. RGB555 — exactly the GBA's native format.
  No conversion loss between the two targets.

## The GBA side (facts)

- The fork's GBA pipeline already emits indexed BMPs for Butano
  (`writeIndexedBmp.ts`): ≤16-color BMPs pass through as one 4bpp palette; a
  256-entry BMP palette makes Butano's graphics tool quantize per-tile into up to
  **16 4bpp palette banks** — per-tile bank indices live in the map cells. GBC's
  8 banks fit in half of that.
- Runtime recolor is proven: M11d recolors the dialogue panel via
  `bn::bg_palette_ptr::set_color` (a shared handle; PALRAM banks are allocated
  top-down). Sprite palettes have the same API (`bn::sprite_palette_ptr`).
  **Gotcha**: Butano dedupes identical palettes — mutating a shared handle changes
  every user. Runtime-changeable palettes must be unique per bank (pad an unused
  color with the bank index to defeat dedupe).
- `colorMode` already gates the GBA pipeline: mono uses the DMG 4-shade palette,
  color/mixed reads true PNG colors (`ejectGbaBuild.ts` `readTrueColor`). What's
  missing is the _palette model_: authored palettes recoloring 4-shade art,
  per-tile attribution, and the runtime op.

## Mapping (the design)

**BG PALRAM layout**: bank _i_ (0–7) = GBC background palette _i_; colors 1–4 of the
bank hold the palette's 4 colors (index 0 stays transparent/backdrop per bank, GBA
convention). Banks 8–15 stay free for UI (dialogue panel already allocates its own
bank) and the future GBA-native mode.

**Build time (M12a/b)**: the eject step composes the background BMP so that each
tile's pixels use indices `bank*16 + 1..4` per its `tileColors` entry (or
`autoPalettes` map), with a 256-entry BMP palette laying the 8 GBC palettes into
their banks. Butano's per-tile quantizer then preserves exactly that attribution.
Sprites: each actor's assigned sprite palette recolors its sheet at eject
(3 colors + transparent). **Editor-only slices — no engine shape change.**

**Runtime (M12c)**: bridge `VM_LOAD_PALETTE` + trailing `.CGB_PAL`/`.DMG_PAL` rows
(inline-data pattern, like VM_CHOICE). Engine op takes (mask, flags) + 8-byte
packed RGB555 rows and `set_color`s the masked banks of the scene bg palette /
the sprite palette banks. `.PALETTE_COMMIT` while faded: **verified 2026-07-15** —
the fixture's palette events run during the scene-init fade-in and every GDB
PALRAM dump shows the final colours correct post-fade (Butano's fade layer blends
from the palette's current colours, so commits under fade survive by design).

**Status (2026-07-15)**: M12a–d merged (incl. sprite runtime swaps with the
creation latch, Set UI Palette → panel, colorModeOverride). Learned along the way:
GB's sprite colour trio is palette colors [0], [1], [3] (colors[2] unused for
sprites); palette events in scene init run before actors' sprites exist (lazy
creation), hence the engine-side slot latches. Remaining: DMG_PAL semantics,
mixed-mode fallback rules (read compileData's branches first), emote palettes,
GBC sample project end-to-end.

## Slices

| Slice | Scope                                                                                                                                                     | Repos           |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| M12a  | Scene BG palettes + tileColors/autoPalettes baked into the emitted BMP (color/mixed projects). Success: a GBC scene renders its authored palettes on GBA. | editor only     |
| M12b  | Sprite palettes: actor/player sheets recolored from `spritePaletteIds` at eject; emotes/projectiles included.                                             | editor only     |
| M12c  | `VM_LOAD_PALETTE` bridged (op + trailing rows); engine applies to bg/sprite banks at runtime; Set Background/Sprite Palette events work.                  | engine + editor |
| M12d  | UI palette event, per-scene `colorModeOverride`, "restore" semantics, DMG_PAL rows on color hardware.                                                     | engine + editor |
| M12e  | Fade interplay (`PALETTE_COMMIT` under fade), mixed-mode fallbacks, GBC sample project end-to-end + runtime tests.                                        | both            |

Verification per the established workflow: bridge unit tests, `npm run gba:matrix`
(0x7C moves to supported), fixture palette events + GDB PALRAM probes (the M11d
recipe: dump `0x05000000` ×256, banks are hardware-visible), eyes-on color check.

## Risks

1. **Butano quantizer behavior** with a hand-laid 256-entry palette must be pinned
   by a spike (first task of M12a): confirm tile→bank attribution survives exactly,
   including duplicate colors across banks (dedupe risk).
2. **Sprite palette dedupe** (above) — unique-bank padding trick, verify in PALRAM.
3. **8bpp map sizes**: staying 4bpp keeps VRAM budgets as today; do not switch the
   scene bg to 8bpp for this.
4. Mixed-mode projects (DMG art + color UI) have upstream-defined precedence rules —
   read `compileData.ts` color-mode branches during M12d, don't guess.
