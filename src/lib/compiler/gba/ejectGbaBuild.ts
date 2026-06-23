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
import { parseGbvmAsm, parseGameGlobals } from "./parseGbvmAsm";
import {
  linkGbaProgram,
  formatGbaScenesC,
  cNameOf,
  GbaProc,
  GbaSceneEntry,
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

  // --- Link every scene's script graph -> gba_program.c + the scene table ------
  // A GBVM proc symbol "_foo" is compiled to the file keyed "foo.s"; a symbol with
  // no such file is not a project script (it's a native engine fn, an engine RAM
  // var, or far data) and is left for the linker to report as `unresolved`.
  const scriptForSymbol = (symbol: string): string | undefined =>
    compiledData.files[`${cNameOf(symbol)}.s`];

  // GB Studio global variables are VAR_ symbols defined (as script_memory indices)
  // in game_globals.i, which the scripts only `.include`. Parse that file once so
  // parseGbvmAsm can resolve VAR_ operands (Set/If Variable, RPN var refs).
  const globals = parseGameGlobals(compiledData.files["game_globals.i"] ?? "");

  // A scene change targets a scene by its far-ptr symbol ("_<scene.symbol>"); map
  // those to gba_scenes[] indices (the table below is built in this same order).
  const sceneIndex = (sym: string): number | undefined => {
    const i = scenes.findIndex((sc) => `_${sc.symbol}` === sym);
    return i >= 0 ? i : undefined;
  };

  // One scene-table entry per scene: its init script (run on load) + each actor's
  // update script (a persistent per-frame thread + the runtime actor index it
  // drives; the player is 0, placed actors are 1..). Seed the proc-collection
  // queue with every scene's entry scripts.
  const sceneEntries: GbaSceneEntry[] = [];
  const procs: GbaProc[] = [];
  const collected = new Set<string>();
  const queue: string[] = [];
  for (const scene of scenes) {
    const initSymbol = `_${scene.symbol}_init`;
    if (scriptForSymbol(initSymbol) === undefined) {
      throw new Error(
        `GBA build: scene init script "${cNameOf(initSymbol)}.s" not found in compiled output`,
      );
    }
    const actorUpdates: { cName: string; index: number }[] = [];
    scene.actors.forEach((actor, i) => {
      const symbol = `_${actor.symbol}_update`;
      if (scriptForSymbol(symbol) !== undefined) {
        actorUpdates.push({ cName: cNameOf(symbol), index: i + 1 });
        queue.push(symbol);
      }
    });
    // Scene logical size (px) = its background's dimensions, for the camera clamp.
    // Capped at 512 (the largest Butano regular_bg map); default to one screen.
    const sceneBg = projectData.backgrounds.find(
      (b) => b.id === scene.backgroundId,
    );
    const widthPx = Math.min(512, (sceneBg ? sceneBg.width : 30) * 8);
    const heightPx = Math.min(512, (sceneBg ? sceneBg.height : 20) * 8);
    // Placed actors' initial state (runtime index i+1; player = 0). Position in
    // subpixels (256 per 8px tile, 32 per pixel); direction -> engine dir code.
    const dirCode = { down: 0, right: 1, up: 2, left: 3 } as const;
    const actorsInit = scene.actors.map((actor, i) => {
      const unit = actor.coordinateType === "pixels" ? 32 : 256;
      return {
        index: i + 1,
        dir: dirCode[actor.direction] ?? 0,
        x: Math.round(actor.x * unit),
        y: Math.round(actor.y * unit),
      };
    });
    // Player (actor 0): if the scene has a player sprite, place it at the project
    // start position (player position persistence across scenes is a follow-up).
    if (scene.playerSpriteSheetId) {
      actorsInit.unshift({
        index: 0,
        dir: dirCode[settings.startDirection] ?? 0,
        x: Math.round(settings.startX * 256),
        y: Math.round(settings.startY * 256),
      });
    }
    // Built-in top-down d-pad control for TOPDOWN scenes (other movement types and
    // platformer physics are later milestones).
    const playerMove = scene.type === "TOPDOWN" ? 1 : 0;
    // Collision grid sized to the engine's tile dims (widthPx/8 x heightPx/8),
    // copied from the scene's per-tile collision bytes. Empty when nothing is solid.
    const sceneColl: number[] = scene.collisions ?? [];
    let collisions: number[] = [];
    if (sceneColl.some((v) => v & 0x0f)) {
      const collTw = Math.floor(widthPx / 8);
      const collTh = Math.floor(heightPx / 8);
      const srcW = scene.width || collTw;
      for (let y = 0; y < collTh; y++) {
        for (let x = 0; x < collTw; x++) {
          collisions.push((sceneColl[y * srcW + x] ?? 0) & 0xff);
        }
      }
    }
    sceneEntries.push({
      initCName: cNameOf(initSymbol),
      actorUpdates,
      widthPx,
      heightPx,
      actorsInit,
      playerMove,
      collisions,
    });
    queue.push(initSymbol);
  }

  // Collect every reachable proc across all scenes: the entry scripts + the
  // transitive closure of their script -> script references (Call Script /
  // threads). parseGbvmAsm drops deferred ops (warned); the linker resolves
  // cross-proc refs and reports the rest (native/engine/far data) as unresolved.
  while (queue.length > 0) {
    const symbol = queue.shift() as string;
    if (collected.has(symbol)) continue;
    const asmText = scriptForSymbol(symbol);
    if (asmText === undefined) continue;
    const { items, skipped } = parseGbvmAsm(asmText, { sceneIndex, globals });
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

  // Start scene index into the scene table (matches the `startScene` fallback).
  const startSceneIndex = Math.max(
    0,
    scenes.findIndex((s) => s.id === settings.startSceneId),
  );

  progress(
    `Linking ${procs.length} script proc(s) across ${scenes.length} scene(s)...`,
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
    Path.join(gbaEngineRoot, "src", "gba_scenes.c"),
    formatGbaScenesC(sceneEntries, startSceneIndex),
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

  // --- Per-scene assets: graphics/scene<N>_bg.bmp + scene<N>_sprite_<i>.bmp -----
  // Each scene's background and actor sprites become distinct Butano items, so the
  // engine can load any scene's art. gba_scene_assets.h maps a scene index -> its
  // bg + actor->sprite table; Butano items are compile-time symbols, hence the
  // generated switches. Sprite palette index 0 is transparent (GBA requirement).
  await ensureDir(Path.join(gbaEngineRoot, "graphics"));
  const spritePalette = [
    hexToRgb(settings.customColorsWhite || "E8F8E0"), // 0: transparent
    hexToRgb(settings.customColorsLight || "B0F088"), // 1
    hexToRgb(settings.customColorsDark || "509878"), // 2
    hexToRgb(settings.customColorsBlack || "202850"), // 3
  ];
  const spriteMode = settings.spriteMode || "8x16";

  // Convert a scene's background to a 256-aligned indexed BMP (solid backdrop if
  // the scene has none).
  const convertBackground = async (
    scene: (typeof scenes)[number],
  ): Promise<Buffer> => {
    const bg = projectData.backgrounds.find((b) => b.id === scene.backgroundId);
    if (!bg) {
      return indexedImageToBmp(
        { width: 8, height: 8, data: new Uint8Array(64) },
        [hexToRgb(settings.customColorsBlack || "202850")],
        { align: 256 },
      );
    }
    if (isColor) {
      progress(`Converting background ${bg.filename} (colour)...`);
      const { img, palette } = await readTrueColor(
        assetFilename(projectRoot, "backgrounds", bg),
        false,
      );
      return indexedImageToBmp(img, palette, { align: 256 });
    }
    progress(`Converting background ${bg.filename}...`);
    // GBA bg colour 0 is transparent, so map the 4 GB shades to indices 1..4.
    const palette = [
      hexToRgb(settings.customColorsBlack || "202850"),
      hexToRgb(settings.customColorsWhite || "E8F8E0"),
      hexToRgb(settings.customColorsLight || "B0F088"),
      hexToRgb(settings.customColorsDark || "509878"),
      hexToRgb(settings.customColorsBlack || "202850"),
    ];
    const src = await readFileToIndexedImage(
      assetFilename(projectRoot, "backgrounds", bg),
      tileDataIndexFn,
    );
    const data = new Uint8Array(src.data.length);
    for (let i = 0; i < data.length; i++) data[i] = (src.data[i] & 0x03) + 1;
    return indexedImageToBmp(
      { width: src.width, height: src.height, data },
      palette,
      { align: 256 },
    );
  };

  const bgIncludes: string[] = [];
  const bgCases: string[] = [];
  const spriteIncludes: string[] = [];
  const spriteTables: string[] = [];
  const spriteCases: string[] = [];

  for (let s = 0; s < scenes.length; s++) {
    const scene = scenes[s];
    // Background -> graphics/scene<s>_bg.bmp (Butano regular_bg).
    const bgName = `scene${s}_bg`;
    await writeFile(
      Path.join(gbaEngineRoot, "graphics", `${bgName}.bmp`),
      await convertBackground(scene),
    );
    await writeFile(
      Path.join(gbaEngineRoot, "graphics", `${bgName}.json`),
      JSON.stringify({ type: "regular_bg" }) + "\n",
    );
    bgIncludes.push(`#include "bn_regular_bg_items_${bgName}.h"`);
    bgCases.push(
      `        case ${s}: return bn::regular_bg_items::${bgName}.create_bg(0, 0);`,
    );

    // Sprites -> graphics/scene<s>_sprite_<idx>.bmp. Index 0 is the player (the
    // scene's playerSpriteSheetId); placed actors are their runtime index i + 1.
    const rowByIndex = new Map<number, string>();
    const emitSprite = async (spriteSheetId: string, idx: number) => {
      const sprite = projectData.sprites.find((sp) => sp.id === spriteSheetId);
      if (!sprite || !sprite.states || sprite.states.length === 0) return;
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
        return;
      }
      const sheet = buildSpriteSheet(
        sprite as unknown as SpriteSheetInput,
        img,
        spriteMode,
      );
      const name = `scene${s}_sprite_${idx}`;
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
    };
    if (scene.playerSpriteSheetId) {
      await emitSprite(scene.playerSpriteSheetId, 0);
    }
    for (let i = 0; i < scene.actors.length; i++) {
      await emitSprite(scene.actors[i].spriteSheetId, i + 1);
    }
    // Per-scene actor->sprite table (index 0 = player; missing sprites get a null
    // row so every actor index is addressable).
    const maxIndex = Math.max(0, ...rowByIndex.keys());
    const rows: string[] = [];
    for (let idx = 0; idx <= maxIndex; idx++) {
      rows.push(
        rowByIndex.get(idx) ??
          `    { nullptr, {0,0,0,0,0,0,0,0}, {0,0,0,0,0,0,0,0} },`,
      );
    }
    spriteTables.push(`static const GbaActorSprite scene${s}_sprites[] = {`);
    spriteTables.push(...rows);
    spriteTables.push("};");
    spriteTables.push(`static const int scene${s}_sprites_count = ${maxIndex + 1};`);
    spriteCases.push(
      `        case ${s}: return (actorIdx >= 0 && actorIdx < scene${s}_sprites_count) ? ` +
        `&scene${s}_sprites[actorIdx] : nullptr;`,
    );
  }

  // Generate src/gba_scene_assets.h: per-scene bg + actor->sprite lookups (engine
  // frame order: Down, Right, Up, Left, then the moving set).
  const assetsHeader = [
    "// Generated by GBA Studio (M2) - per-scene background + actor sprite tables.",
    "#ifndef GBA_SCENE_ASSETS_H",
    "#define GBA_SCENE_ASSETS_H",
    '#include "bn_regular_bg_ptr.h"',
    '#include "bn_sprite_item.h"',
    ...bgIncludes,
    ...spriteIncludes,
    "struct GbaActorSprite {",
    "    const bn::sprite_item* item;",
    "    unsigned char anim_start[8];",
    "    unsigned char anim_len[8];",
    "};",
    ...spriteTables,
    "inline bn::regular_bg_ptr gba_create_scene_bg(int sceneIdx) {",
    "    switch(sceneIdx) {",
    ...bgCases,
    "    default: break;",
    "    }",
    "    return bn::regular_bg_items::scene0_bg.create_bg(0, 0);",
    "}",
    "inline const GbaActorSprite* gba_actor_sprite(int sceneIdx, int actorIdx) {",
    "    switch(sceneIdx) {",
    ...spriteCases,
    "    default: break;",
    "    }",
    "    return nullptr;",
    "}",
    "#endif",
  ].join("\n");
  await writeFile(
    Path.join(gbaEngineRoot, "src", "gba_scene_assets.h"),
    assetsHeader + "\n",
  );

  // --- Avatars: graphics/avatar_<i>.bmp + src/gba_avatar_assets.h (M4m) ---------
  // Each project avatar becomes a Butano sprite; a dialogue carries an avatar index
  // (recovered from its stripped font-glyph code, M4l) that the engine looks up here
  // to draw a portrait beside the text. Index = position in projectData.avatars (the
  // compiled used-avatars order matches for the common case; gaps are a follow-up).
  const avatarIncludes: string[] = [];
  const avatarCases: string[] = [];
  for (let a = 0; a < projectData.avatars.length; a++) {
    const avatar = projectData.avatars[a];
    let img: { width: number; height: number; data: Uint8Array };
    let palette = spritePalette;
    try {
      if (isColor) {
        ({ img, palette } = await readTrueColor(
          assetFilename(projectRoot, "avatars", avatar),
          true,
        ));
      } else {
        img = await readFileToIndexedImage(
          assetFilename(projectRoot, "avatars", avatar),
          tileDataIndexFn,
        );
      }
    } catch (e) {
      warnings(`GBA: could not read avatar "${avatar.filename}"`);
      continue;
    }
    const name = `avatar_${a}`;
    await writeFile(
      Path.join(gbaEngineRoot, "graphics", `${name}.bmp`),
      indexedImageToBmp(img, palette, { align: 8 }),
    );
    await writeFile(
      Path.join(gbaEngineRoot, "graphics", `${name}.json`),
      JSON.stringify({ type: "sprite", height: img.height }) + "\n",
    );
    avatarIncludes.push(`#include "bn_sprite_items_${name}.h"`);
    avatarCases.push(`        case ${a}: return &bn::sprite_items::${name};`);
    progress(`Converting avatar ${avatar.filename} -> ${name}`);
  }
  const avatarHeader = [
    "// Generated by GBA Studio (M4m) - dialogue avatar sprite lookup.",
    "#ifndef GBA_AVATAR_ASSETS_H",
    "#define GBA_AVATAR_ASSETS_H",
    '#include "bn_sprite_item.h"',
    ...avatarIncludes,
    "inline const bn::sprite_item* gba_avatar_sprite(int avatarIdx) {",
    "    switch(avatarIdx) {",
    ...avatarCases,
    "    default: break;",
    "    }",
    "    return nullptr;",
    "}",
    "#endif",
  ].join("\n");
  await writeFile(
    Path.join(gbaEngineRoot, "src", "gba_avatar_assets.h"),
    avatarHeader + "\n",
  );

  // The built .gba is collected here by makeGbaBuild (mirrors build/rom for GBDK).
  await ensureDir(Path.join(outputRoot, "build", "gba"));

  const totalBytes = linked.procs.reduce((n, p) => n + p.program.bytes.length, 0);
  progress(
    `GBA link: ${linked.procs.length} proc(s)/${totalBytes}b across ` +
      `${sceneEntries.length} scene(s) (start index ${startSceneIndex}), ` +
      `${linked.unresolved.length} deferred external(s)`,
  );
};

export default ejectGbaBuild;
