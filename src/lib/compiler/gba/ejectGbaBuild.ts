// GBA Studio - GBA build "eject" step.
//
// Counterpart to ejectBuild.ts for the GBA target. It (1) links EVERY compiled
// GBVM proc into one bytecode image (P1: parseGbvmAsm -> linkGbaImage ->
// src/game_image.c), then (2) emits EVERY scene's assets (background + actor
// sprites) and a scene_table.h/.c registry mapping each scene to its bg, actors,
// triggers, and the init/update/interact script ENTRY OFFSETS already inside
// game_image (P2 scene runtime). makeGbaBuild then compiles the gbavm engine.
//
// The build happens in the gbavm engine tree (gbaEngineRoot); an isolated/
// vendored build dir is a later packaging concern.

import { writeFile, readFile, ensureDir, pathExists, remove } from "fs-extra";
import Path from "path";
import { PNG } from "pngjs";
import { gbaEngineRoot } from "consts";
import { ProjectResources } from "shared/lib/resources/types";
import { assetFilename } from "shared/lib/helpers/assets";
import { tileDataIndexFn } from "shared/lib/tiles/tileData";
import { readFileToIndexedImage } from "lib/tiles/readFileToTiles";
import { parseGbvmAsm } from "./parseGbvmAsm";
import { linkGbaImage, formatGbaProgramC, GbaProc } from "./emitGbaBytecode";
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

// One actor row in the generated scene table (runtime actor index order;
// index 0 = player). `item` is a Butano sprite_item pointer expression or "nullptr".
type ActorRow = {
  item: string;
  animStart: number[]; // 8 per-direction frame starts
  animLen: number[];
  updateOff: number; // byte offset into game_image, 0 = no script
  interactOff: number;
};

type TriggerRow = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  interactOff: number;
  leaveOff: number;
};

type SceneRow = {
  index: number;
  bgItem: string; // &bn::regular_bg_items::scene<s>_bg
  width: number; // tiles
  height: number;
  initOff: number;
  actors: ActorRow[];
  triggers: TriggerRow[];
  scroll: [number, number, number, number]; // x_min, x_max, y_min, y_max
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

  const { settings, scenes } = projectData;
  if (scenes.length === 0) {
    throw new Error("GBA build: project has no scenes to build");
  }
  const startSceneIndex = Math.max(
    0,
    scenes.findIndex((scene) => scene.id === settings.startSceneId),
  );

  await ensureDir(Path.join(gbaEngineRoot, "src"));
  await ensureDir(Path.join(gbaEngineRoot, "graphics"));

  // A Switch Scene event references its target by SYMBOL (IMPORT_FAR_PTR_DATA
  // _<sceneSymbol>); on flat GBA we resolve that to the scene INDEX so the bridge
  // can emit an inline index instead of a (nonexistent) far pointer.
  const sceneSymbolToIndex: Record<string, number> = {};
  scenes.forEach((scene, i) => {
    sceneSymbolToIndex[`_${scene.symbol}`] = i;
  });

  // --- Whole-project link (P1) ----------------------------------------------
  // Link every compiled proc into one image; entryOffsets maps each proc's
  // `_<symbol>` entry label to its byte offset, which the scene table reuses.
  const procs: GbaProc[] = [];
  const linked = new Set<string>();
  for (const key of Object.keys(compiledData.files)) {
    if (!key.endsWith(".s")) continue;
    let parsed;
    try {
      parsed = parseGbvmAsm(compiledData.files[key], undefined, sceneSymbolToIndex);
    } catch (e) {
      warnings(`GBA: skipped "${key}" (${(e as Error).message})`);
      continue;
    }
    if (!parsed.entrySymbol) continue;
    if (!parsed.items.some((i) => i.kind !== "label")) continue;
    if (linked.has(parsed.entrySymbol)) continue;
    for (const note of parsed.skipped) {
      warnings(`GBA: deferred unsupported instruction "${note}" in ${key}`);
    }
    linked.add(parsed.entrySymbol);
    procs.push({ symbol: parsed.entrySymbol, items: parsed.items });
  }

  progress(`Linking ${procs.length} script procs into one GBA image...`);
  const { program, entryOffsets } = linkGbaImage(procs);
  await writeFile(
    Path.join(gbaEngineRoot, "src", "game_image.c"),
    formatGbaProgramC("game_image", program) + "\n",
  );
  // 0 is a valid byte offset (the first-linked proc sits there), so "no script"
  // needs a sentinel the engine can test against (GBA_NO_OFFSET in scene_table.h).
  const NO_OFFSET = 0xffffffff;
  const offsetOf = (symbol: string): number =>
    entryOffsets.has(symbol) ? (entryOffsets.get(symbol) as number) : NO_OFFSET;
  // Obsolete two-blob + entries-header artifacts of P1; the scene table replaces them.
  await remove(Path.join(gbaEngineRoot, "src", "game_script.c"));
  await remove(Path.join(gbaEngineRoot, "src", "actor_update_script.c"));
  await remove(Path.join(gbaEngineRoot, "src", "game_entries.h"));
  await remove(Path.join(gbaEngineRoot, "src", "scene_sprites.h"));

  // --- Colour handling -------------------------------------------------------
  // Mono projects remap to the 4 GB shades; colour/mixed projects read each
  // image's true colours (Butano quantizes >16-colour images into per-tile 4bpp
  // palettes). Index 0 is reserved for the transparent backdrop / sprite key.
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

  // Mono sprite palette (index 0 transparent). Colour sprites read their own.
  const monoSpritePalette = [
    hexToRgb(settings.customColorsWhite || "E8F8E0"), // 0: transparent
    hexToRgb(settings.customColorsLight || "B0F088"), // 1
    hexToRgb(settings.customColorsDark || "509878"), // 2
    hexToRgb(settings.customColorsBlack || "202850"), // 3
  ];
  const spriteMode = settings.spriteMode || "8x16";
  const sceneSpriteIncludes: string[] = []; // per-scene grit sprite headers for the .c

  // --- Per-scene background -> graphics/scene<s>_bg.bmp ----------------------
  const emitSceneBg = async (
    scene: ProjectResources["scenes"][number],
    s: number,
  ): Promise<string> => {
    const name = `scene${s}_bg`;
    const background = projectData.backgrounds.find(
      (bg) => bg.id === scene.backgroundId,
    );
    // A scene wider/taller than one screen needs a 512x512 regular_bg.
    const align = (scene.width || 0) * 8 > 256 || (scene.height || 0) * 8 > 256 ? 512 : 256;
    let bmp: Buffer;
    if (!background) {
      bmp = indexedImageToBmp(
        { width: 8, height: 8, data: new Uint8Array(64) },
        [hexToRgb(settings.customColorsBlack || "202850")],
        { align },
      );
    } else if (isColor) {
      progress(`Converting background ${background.filename} (colour)...`);
      const { img, palette } = await readTrueColor(
        assetFilename(projectRoot, "backgrounds", background),
        false,
      );
      bmp = indexedImageToBmp(img, palette, { align });
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
      bmp = indexedImageToBmp({ width: src.width, height: src.height, data }, palette, {
        align,
      });
    }
    await writeFile(Path.join(gbaEngineRoot, "graphics", `${name}.bmp`), bmp);
    await writeFile(
      Path.join(gbaEngineRoot, "graphics", `${name}.json`),
      JSON.stringify({ type: "regular_bg" }) + "\n",
    );
    return name;
  };

  // --- Per-scene actor sprites -> graphics/scene<s>_sprite_<idx>.bmp ---------
  // Returns one ActorRow per runtime actor index (0 = player). Sprite binding +
  // anim ranges go in the table; activation + position come from the init script.
  const emitSceneActors = async (
    scene: ProjectResources["scenes"][number],
    s: number,
  ): Promise<ActorRow[]> => {
    const rowByIndex = new Map<number, ActorRow>();
    const includes: string[] = [];
    for (let i = 0; i < scene.actors.length; i++) {
      const actor = scene.actors[i];
      const runtimeIndex = i + 1; // 0 reserved for the player
      const updateOff = offsetOf(`_${actor.symbol}_update`);
      const interactOff = offsetOf(`_${actor.symbol}_interact`);
      const sprite = projectData.sprites.find((sp) => sp.id === actor.spriteSheetId);
      if (!sprite || !sprite.states || sprite.states.length === 0) {
        // Scriptable but spriteless actor: keep its script offsets, no sprite.
        if (updateOff !== NO_OFFSET || interactOff !== NO_OFFSET) {
          rowByIndex.set(runtimeIndex, {
            item: "nullptr",
            animStart: [0, 0, 0, 0, 0, 0, 0, 0],
            animLen: [0, 0, 0, 0, 0, 0, 0, 0],
            updateOff,
            interactOff,
          });
        }
        continue;
      }
      let img: { width: number; height: number; data: Uint8Array };
      let palette = monoSpritePalette;
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
      const name = `scene${s}_sprite_${runtimeIndex}`;
      await writeFile(
        Path.join(gbaEngineRoot, "graphics", `${name}.bmp`),
        indexedImageToBmp(sheet.sheet, palette, { align: 8 }),
      );
      await writeFile(
        Path.join(gbaEngineRoot, "graphics", `${name}.json`),
        JSON.stringify({ type: "sprite", height: sheet.frameHeight }) + "\n",
      );
      includes.push(`#include "bn_sprite_items_${name}.h"`);
      rowByIndex.set(runtimeIndex, {
        item: `&bn::sprite_items::${name}`,
        animStart: sheet.animRanges.map((r) => r.start),
        animLen: sheet.animRanges.map((r) => r.len),
        updateOff,
        interactOff,
      });
      progress(
        `Converting sprite ${sprite.filename} -> ${name} (${sheet.frameCount} frames)`,
      );
    }
    // Sprite-item includes are accumulated per scene; collect them for the .c.
    sceneSpriteIncludes.push(...includes);
    // Fill a dense 0..maxIndex array (index 0 = player; gaps get null rows so
    // every runtime actor index the bytecode uses is addressable).
    const maxIndex = Math.max(0, ...rowByIndex.keys());
    const rows: ActorRow[] = [];
    for (let idx = 0; idx <= maxIndex; idx++) {
      rows.push(
        rowByIndex.get(idx) ?? {
          item: "nullptr",
          animStart: [0, 0, 0, 0, 0, 0, 0, 0],
          animLen: [0, 0, 0, 0, 0, 0, 0, 0],
          updateOff: NO_OFFSET,
          interactOff: NO_OFFSET,
        },
      );
    }
    return rows;
  };

  const sceneRows: SceneRow[] = [];
  for (let s = 0; s < scenes.length; s++) {
    const scene = scenes[s];
    const bgName = await emitSceneBg(scene, s);
    const actors = await emitSceneActors(scene, s);
    const triggers: TriggerRow[] = (scene.triggers ?? []).map((t) => ({
      left: t.x,
      top: t.y,
      right: t.x + Math.max(1, t.width) - 1,
      bottom: t.y + Math.max(1, t.height) - 1,
      interactOff: offsetOf(`_${t.symbol}_interact`),
      leaveOff: NO_OFFSET,
    }));
    // Camera origin clamp range (px) for backgrounds larger than the screen.
    const sxMax = Math.max(0, (scene.width || 0) * 8 - 240);
    const syMax = Math.max(0, (scene.height || 0) * 8 - 160);
    sceneRows.push({
      index: s,
      bgItem: `&bn::regular_bg_items::${bgName}`,
      width: scene.width || 0,
      height: scene.height || 0,
      initOff: offsetOf(`_${scene.symbol}_init`),
      actors,
      triggers,
      scroll: [0, sxMax, 0, syMax],
    });
  }

  await writeSceneTable(gbaEngineRoot, sceneRows, sceneSpriteIncludes, startSceneIndex);

  // The built .gba is collected here by makeGbaBuild (mirrors build/rom for GBDK).
  await ensureDir(Path.join(outputRoot, "build", "gba"));

  progress(
    `GBA image: ${program.bytes.length}b / ${program.relocations.length} relocs / ` +
      `${procs.length} procs; ${sceneRows.length} scene(s), start scene ${startSceneIndex}`,
  );
};

// --- scene_table.h / scene_table.c codegen ----------------------------------
const writeSceneTable = async (
  root: string,
  scenes: SceneRow[],
  spriteIncludes: string[],
  startScene: number,
) => {
  const header = [
    "// Generated by GBA Studio - scene registry (P2 scene runtime).",
    "#ifndef GBA_SCENE_TABLE_H",
    "#define GBA_SCENE_TABLE_H",
    '#include "bn_sprite_item.h"',
    '#include "bn_regular_bg_item.h"',
    "#define GBA_NO_OFFSET 0xFFFFFFFFu  // a script-offset field with no script",
    "struct GbaSceneActor {",
    "    const bn::sprite_item* item;",
    "    unsigned char anim_start[8];",
    "    unsigned char anim_len[8];",
    "    unsigned int update_off;   // byte offset into game_image, 0 = none",
    "    unsigned int interact_off;",
    "};",
    "struct GbaSceneTrigger {",
    "    unsigned short left, top, right, bottom;",
    "    unsigned int interact_off;",
    "    unsigned int leave_off;",
    "};",
    "struct GbaScene {",
    "    const bn::regular_bg_item* bg;",
    "    unsigned short width, height;   // tiles",
    "    unsigned int init_off;",
    "    unsigned char n_actors;",
    "    const GbaSceneActor* actors;",
    "    unsigned char n_triggers;",
    "    const GbaSceneTrigger* triggers;",
    "    short scroll_x_min, scroll_x_max, scroll_y_min, scroll_y_max;",
    "};",
    "extern const GbaScene gba_scenes[];",
    "extern const unsigned int gba_scene_count;",
    "extern const unsigned int gba_start_scene;",
    "#endif",
    "",
  ].join("\n");
  await writeFile(Path.join(root, "src", "scene_table.h"), header);

  const arr = (xs: number[]) => `{ ${xs.join(", ")} }`;
  const lines: string[] = [
    "// Generated by GBA Studio - scene registry data.",
    '#include "scene_table.h"',
    ...scenes.map((sc) => `#include "bn_regular_bg_items_scene${sc.index}_bg.h"`),
    ...spriteIncludes,
    "",
  ];
  // Per-scene actor + trigger arrays.
  for (const sc of scenes) {
    lines.push(`static const GbaSceneActor scene${sc.index}_actors[] = {`);
    for (const a of sc.actors) {
      lines.push(
        `    { ${a.item}, ${arr(a.animStart)}, ${arr(a.animLen)}, ${a.updateOff}, ${a.interactOff} },`,
      );
    }
    lines.push("};");
    if (sc.triggers.length > 0) {
      lines.push(`static const GbaSceneTrigger scene${sc.index}_triggers[] = {`);
      for (const t of sc.triggers) {
        lines.push(
          `    { ${t.left}, ${t.top}, ${t.right}, ${t.bottom}, ${t.interactOff}, ${t.leaveOff} },`,
        );
      }
      lines.push("};");
    }
  }
  lines.push("const GbaScene gba_scenes[] = {");
  for (const sc of scenes) {
    const trg = sc.triggers.length > 0 ? `scene${sc.index}_triggers` : "nullptr";
    lines.push(
      `    { ${sc.bgItem}, ${sc.width}, ${sc.height}, ${sc.initOff}, ` +
        `${sc.actors.length}, scene${sc.index}_actors, ${sc.triggers.length}, ${trg}, ` +
        `${sc.scroll[0]}, ${sc.scroll[1]}, ${sc.scroll[2]}, ${sc.scroll[3]} },`,
    );
  }
  lines.push("};");
  lines.push(`const unsigned int gba_scene_count = ${scenes.length};`);
  lines.push(`const unsigned int gba_start_scene = ${startScene};`);
  lines.push("");
  // .cpp (not .c): the data references bn:: sprite/bg item symbols (C++).
  await writeFile(Path.join(root, "src", "scene_table.cpp"), lines.join("\n"));
};

export default ejectGbaBuild;
