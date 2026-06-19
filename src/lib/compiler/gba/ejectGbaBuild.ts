// GBA Studio - GBA build "eject" step.
//
// Counterpart to ejectBuild.ts for the GBA target. Instead of writing a GBDK
// project tree, it turns the start scene's compiled GBVM assembly into gbavm
// bytecode (parseGbvmAsm -> emitGbaBytecode -> formatGbaProgramC) and writes it
// as the engine's src/game_script.c. makeGbaBuild then compiles the gbavm engine.
//
// Scope: the start scene's init + first-actor update scripts (two self-contained
// bytecode blobs, no cross-script linking / engine-symbol model yet), plus the
// start scene's background converted to a Butano regular_bg (Phase 1). The build
// happens in the gbavm engine tree (gbaEngineRoot); an isolated/vendored build
// dir is a later packaging concern.

import { writeFile, readFile, ensureDir, pathExists } from "fs-extra";
import Path from "path";
import { PNG } from "pngjs";
import { gbaEngineRoot } from "consts";
import { ProjectResources } from "shared/lib/resources/types";
import { assetFilename } from "shared/lib/helpers/assets";
import { tileDataIndexFn } from "shared/lib/tiles/tileData";
import { readFileToIndexedImage } from "lib/tiles/readFileToTiles";
import { parseGbvmAsm } from "./parseGbvmAsm";
import {
  linkGbaProgram,
  formatGbaEntriesC,
  cNameOf,
  GbaProc,
} from "./linkGbaProgram";
import { indexedImageToBmp, hexToRgb } from "./writeIndexedBmp";
import type { Rgb } from "./writeIndexedBmp";
import { buildSpriteSheet, SpriteSheetInput } from "./writeSpriteSheet";

type EjectGbaOptions = {
  projectData: ProjectResources;
  projectRoot: string;
  outputRoot: string;
  compiledData: {
    files: Record<string, string>;
  };
  progress: (msg: string) => void;
  warnings: (msg: string) => void;
};

const ejectGbaBuild = async ({
  projectData,
  projectRoot,
  outputRoot,
  compiledData,
  progress,
  warnings,
}: EjectGbaOptions) => {
  if (!(await pathExists(Path.join(gbaEngineRoot, "Makefile")))) {
    throw new Error(
      `GBA build: gbavm engine not found at ${gbaEngineRoot} (set the GBAVM_ROOT environment variable).`,
    );
  }

  // Resolve the start scene exactly as compileData does (settings.startSceneId,
  // falling back to the first scene), then locate its compiled init script.
  const { settings, scenes } = projectData;
  const startScene =
    scenes.find((scene) => scene.id === settings.startSceneId) ?? scenes[0];
  if (!startScene) {
    throw new Error("GBA build: project has no scenes to build");
  }
  await ensureDir(Path.join(gbaEngineRoot, "src"));

  // --- Link the start scene's script graph -> gba_program.c + gba_entries.c ----
  // A GBVM proc symbol "_foo" is compiled to the file keyed "foo.s"; a symbol with
  // no such file is not a project script (it's a native engine fn, an engine RAM
  // var, or far data) and is left for the linker to report as `unresolved`.
  const scriptForSymbol = (symbol: string): string | undefined =>
    compiledData.files[`${cNameOf(symbol)}.s`];

  // Entry points the engine runs: the start scene init (once) and each actor
  // update script (a persistent per-frame thread + the actor's runtime index;
  // the player is 0, placed actors are 1..).
  const sceneInitSymbol = `_${startScene.symbol}_init`;
  if (scriptForSymbol(sceneInitSymbol) === undefined) {
    throw new Error(
      `GBA build: start scene init script "${cNameOf(sceneInitSymbol)}.s" not found in compiled output`,
    );
  }
  const actorUpdates: { symbol: string; cName: string; index: number }[] = [];
  startScene.actors.forEach((actor, i) => {
    const symbol = `_${actor.symbol}_update`;
    if (scriptForSymbol(symbol) !== undefined) {
      actorUpdates.push({ symbol, cName: cNameOf(symbol), index: i + 1 });
    }
  });

  // Collect every reachable proc: the entry scripts + the transitive closure of
  // their script -> script references (Call Script / threads). parseGbvmAsm drops
  // deferred ops (warned); the linker resolves cross-proc refs and reports the
  // rest (native/engine/far data) as unresolved.
  const procs: GbaProc[] = [];
  const collected = new Set<string>();
  const queue: string[] = [sceneInitSymbol, ...actorUpdates.map((u) => u.symbol)];
  while (queue.length > 0) {
    const symbol = queue.shift() as string;
    if (collected.has(symbol)) continue;
    const asmText = scriptForSymbol(symbol);
    if (asmText === undefined) continue;
    const { items, skipped } = parseGbvmAsm(asmText);
    for (const note of skipped) {
      warnings(`GBA: deferred unsupported instruction "${note}"`);
    }
    collected.add(symbol);
    procs.push({ symbol, items });
    for (const item of items) {
      if (item.kind !== "op") continue;
      for (const operand of item.operands) {
        if (
          typeof operand === "object" &&
          "label" in operand &&
          operand.label.startsWith("_") &&
          scriptForSymbol(operand.label) !== undefined
        ) {
          queue.push(operand.label);
        }
      }
    }
  }

  progress(
    `Linking ${procs.length} script proc(s) for scene "${startScene.name}"...`,
  );
  const linked = linkGbaProgram(procs);
  for (const u of linked.unresolved) {
    warnings(
      `GBA: deferred external symbol "${u.symbol}" (referenced by ${cNameOf(u.fromProc)}) — ` +
        `native/engine/far-data linking lands in a later milestone`,
    );
  }
  await writeFile(Path.join(gbaEngineRoot, "src", "gba_program.c"), linked.source);
  await writeFile(
    Path.join(gbaEngineRoot, "src", "gba_entries.c"),
    formatGbaEntriesC(
      cNameOf(sceneInitSymbol),
      actorUpdates.map((u) => ({ cName: u.cName, index: u.index })),
    ),
  );

  // --- Colour handling -------------------------------------------------------
  // Mono projects remap to the 4 GB shades (tileDataIndexFn + the customColors
  // palette). Colour/mixed projects read each image's true colours; Butano then
  // quantizes >16-colour images into per-tile 4bpp palettes. Index 0 is reserved
  // for the transparent backdrop (bg) / sprite transparency.
  const isColor = (settings.colorMode ?? "mono") !== "mono";
  const readTrueColor = async (
    file: string,
    transparentFromAlpha: boolean,
  ): Promise<{
    img: { width: number; height: number; data: Uint8Array };
    palette: Rgb[];
  }> => {
    const png = PNG.sync.read(await readFile(file));
    const data = new Uint8Array(png.width * png.height);
    const palette: Rgb[] = [[0, 0, 0]]; // 0 reserved (transparent / backdrop)
    const map = new Map<number, number>();
    let clamped = false;
    // Sprites key transparency on alpha and - for opaque/colour-keyed PNGs - on
    // the top-left pixel's colour, since GB Studio sprite art uses a transparent
    // background colour rather than an alpha channel.
    const keyColor =
      transparentFromAlpha && png.data[3] >= 128
        ? (png.data[0] << 16) | (png.data[1] << 8) | png.data[2]
        : -2;
    for (let i = 0; i < data.length; i++) {
      const r = png.data[i * 4];
      const g = png.data[i * 4 + 1];
      const b = png.data[i * 4 + 2];
      const rgb = (r << 16) | (g << 8) | b;
      if (
        transparentFromAlpha &&
        (png.data[i * 4 + 3] < 128 || rgb === keyColor)
      ) {
        data[i] = 0;
        continue;
      }
      let idx = map.get(rgb);
      if (idx === undefined) {
        if (palette.length >= 256) {
          idx = 255;
          clamped = true;
        } else {
          idx = palette.length;
          palette.push([r, g, b] as Rgb);
          map.set(rgb, idx);
        }
      }
      data[i] = idx;
    }
    if (clamped) {
      warnings(`GBA: "${Path.basename(file)}" has >255 colours; extras clamped`);
    }
    return { img: { width: png.width, height: png.height, data }, palette };
  };

  // --- Background -> graphics/scene_bg.bmp (Butano regular_bg via grit) --------
  // gbavm always links bn::regular_bg_items::scene_bg, so always emit it; a
  // project with no start-scene background gets a solid backdrop.
  await ensureDir(Path.join(gbaEngineRoot, "graphics"));
  const background = projectData.backgrounds.find(
    (bg) => bg.id === startScene.backgroundId,
  );
  let bmp: Buffer;
  if (!background) {
    bmp = indexedImageToBmp(
      { width: 8, height: 8, data: new Uint8Array(64) },
      [hexToRgb(settings.customColorsBlack || "202850")],
      { align: 256 },
    );
  } else if (isColor) {
    progress(`Converting background ${background.filename} (colour)...`);
    const { img, palette } = await readTrueColor(
      assetFilename(projectRoot, "backgrounds", background),
      false,
    );
    bmp = indexedImageToBmp(img, palette, { align: 256 });
  } else {
    progress(`Converting background ${background.filename}...`);
    // GBA bg colour 0 is transparent, so map the 4 GB shades to indices 1..4.
    const palette = [
      hexToRgb(settings.customColorsBlack || "202850"),
      hexToRgb(settings.customColorsWhite || "E8F8E0"),
      hexToRgb(settings.customColorsLight || "B0F088"),
      hexToRgb(settings.customColorsDark || "509878"),
      hexToRgb(settings.customColorsBlack || "202850"),
    ];
    const src = await readFileToIndexedImage(
      assetFilename(projectRoot, "backgrounds", background),
      tileDataIndexFn,
    );
    const data = new Uint8Array(src.data.length);
    for (let i = 0; i < data.length; i++) data[i] = (src.data[i] & 0x03) + 1;
    bmp = indexedImageToBmp(
      { width: src.width, height: src.height, data },
      palette,
      { align: 256 },
    );
  }
  await writeFile(Path.join(gbaEngineRoot, "graphics", "scene_bg.bmp"), bmp);
  await writeFile(
    Path.join(gbaEngineRoot, "graphics", "scene_bg.json"),
    JSON.stringify({ type: "regular_bg" }) + "\n",
  );

  // --- Actor sprites -> graphics/scene_sprite_<idx>.bmp + src/scene_sprites.h --
  // Each scene actor (runtime index = i + 1; the player is 0) becomes a Butano
  // sprite_item; the generated header maps actor index -> sprite + the 8
  // per-direction frame ranges so the engine can pick a frame by facing.
  // Sprite palette keeps index 0 transparent (GBA sprite requirement).
  const spritePalette = [
    hexToRgb(settings.customColorsWhite || "E8F8E0"), // 0: transparent
    hexToRgb(settings.customColorsLight || "B0F088"), // 1
    hexToRgb(settings.customColorsDark || "509878"), // 2
    hexToRgb(settings.customColorsBlack || "202850"), // 3
  ];
  const spriteMode = settings.spriteMode || "8x16";
  const spriteIncludes: string[] = [];
  const rowByIndex = new Map<number, string>();
  for (let i = 0; i < startScene.actors.length; i++) {
    const actor = startScene.actors[i];
    const sprite = projectData.sprites.find((s) => s.id === actor.spriteSheetId);
    if (!sprite || !sprite.states || sprite.states.length === 0) continue;
    let img: { width: number; height: number; data: Uint8Array };
    let palette = spritePalette;
    try {
      if (isColor) {
        ({ img, palette } = await readTrueColor(
          assetFilename(projectRoot, "sprites", sprite),
          true,
        ));
      } else {
        img = await readFileToIndexedImage(
          assetFilename(projectRoot, "sprites", sprite),
          tileDataIndexFn,
        );
      }
    } catch (e) {
      warnings(`GBA: could not read sprite "${sprite.filename}"`);
      continue;
    }
    const sheet = buildSpriteSheet(
      sprite as unknown as SpriteSheetInput,
      img,
      spriteMode,
    );
    const idx = i + 1;
    const name = `scene_sprite_${idx}`;
    await writeFile(
      Path.join(gbaEngineRoot, "graphics", `${name}.bmp`),
      indexedImageToBmp(sheet.sheet, palette, { align: 8 }),
    );
    await writeFile(
      Path.join(gbaEngineRoot, "graphics", `${name}.json`),
      JSON.stringify({ type: "sprite", height: sheet.frameHeight }) + "\n",
    );
    spriteIncludes.push(`#include "bn_sprite_items_${name}.h"`);
    const starts = sheet.animRanges.map((r) => r.start).join(", ");
    const lens = sheet.animRanges.map((r) => r.len).join(", ");
    rowByIndex.set(
      idx,
      `    { &bn::sprite_items::${name}, { ${starts} }, { ${lens} } },`,
    );
    progress(
      `Converting sprite ${sprite.filename} -> ${name} (${sheet.frameCount} frames)`,
    );
  }
  // Build the actor->sprite table (index 0 = player; entries without a sprite
  // get a null row so every actor index is addressable).
  const maxIndex = Math.max(0, ...rowByIndex.keys());
  const rows: string[] = [];
  for (let idx = 0; idx <= maxIndex; idx++) {
    rows.push(
      rowByIndex.get(idx) ??
        `    { nullptr, {0,0,0,0,0,0,0,0}, {0,0,0,0,0,0,0,0} },`,
    );
  }
  const sceneSpritesHeader = [
    "// Generated by GBA Studio - actor index -> Butano sprite + per-direction",
    "// frame ranges (engine order: Down, Right, Up, Left, then the moving set).",
    "#ifndef GBA_SCENE_SPRITES_H",
    "#define GBA_SCENE_SPRITES_H",
    '#include "bn_sprite_item.h"',
    ...spriteIncludes,
    "struct GbaActorSprite {",
    "    const bn::sprite_item* item;",
    "    unsigned char anim_start[8];",
    "    unsigned char anim_len[8];",
    "};",
    "inline const GbaActorSprite* gba_actor_sprite(int index) {",
    "    static const GbaActorSprite table[] = {",
    ...rows,
    "    };",
    `    const int count = ${maxIndex + 1};`,
    "    return (index >= 0 && index < count) ? &table[index] : nullptr;",
    "}",
    "#endif",
  ].join("\n");
  await writeFile(
    Path.join(gbaEngineRoot, "src", "scene_sprites.h"),
    sceneSpritesHeader + "\n",
  );

  // The built .gba is collected here by makeGbaBuild (mirrors build/rom for GBDK).
  await ensureDir(Path.join(outputRoot, "build", "gba"));

  const totalBytes = linked.procs.reduce((n, p) => n + p.program.bytes.length, 0);
  progress(
    `GBA link: ${linked.procs.length} proc(s)/${totalBytes}b, ` +
      `${linked.unresolved.length} deferred external(s); ` +
      `scene init "${cNameOf(sceneInitSymbol)}", ${actorUpdates.length} actor update(s); ` +
      `background ${background ? background.filename : "(none)"}`,
  );
};

export default ejectGbaBuild;
