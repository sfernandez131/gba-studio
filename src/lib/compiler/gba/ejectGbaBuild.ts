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

import { writeFile, ensureDir, pathExists } from "fs-extra";
import Path from "path";
import { gbaEngineRoot } from "consts";
import { ProjectResources } from "shared/lib/resources/types";
import { assetFilename } from "shared/lib/helpers/assets";
import { tileDataIndexFn } from "shared/lib/tiles/tileData";
import { readFileToIndexedImage } from "lib/tiles/readFileToTiles";
import { parseGbvmAsm } from "./parseGbvmAsm";
import { emitGbaBytecode, formatGbaProgramC } from "./emitGbaBytecode";
import { indexedImageToBmp, hexToRgb } from "./writeIndexedBmp";
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
  // compileData keys per-scene init scripts as `${scene.symbol}_init.s`.
  const scriptKey = `${startScene.symbol}_init.s`;
  const asm = compiledData.files[scriptKey];
  if (asm === undefined) {
    throw new Error(
      `GBA build: start scene init script "${scriptKey}" not found in compiled output`,
    );
  }

  await ensureDir(Path.join(gbaEngineRoot, "src"));

  // Bridge one compiled GBVM .s into gbavm bytecode and write it as a named C blob.
  const writeBlob = async (asmText: string, blobName: string, fileName: string) => {
    const { items, skipped } = parseGbvmAsm(asmText);
    for (const note of skipped) {
      warnings(`GBA: deferred unsupported instruction "${note}"`);
    }
    const program = emitGbaBytecode(items);
    await writeFile(
      Path.join(gbaEngineRoot, "src", fileName),
      formatGbaProgramC(blobName, program) + "\n",
    );
    return program;
  };

  // Blob 1 - the start scene's init script -> game_script (runs once at boot).
  progress(`Generating GBA bytecode from ${scriptKey}...`);
  const initProg = await writeBlob(asm, "game_script", "game_script.c");

  // Blob 2 - the first actor's update script -> actor_update_script, a persistent
  // per-frame thread that self-loops via VM_IDLE/VM_JUMP. gbavm always links this
  // symbol, so emit a do-nothing STOP program when no actor has an update script.
  const updActor = startScene.actors.find(
    (actor) => compiledData.files[`${actor.symbol}_update.s`] !== undefined,
  );
  let updProg;
  if (updActor) {
    const updKey = `${updActor.symbol}_update.s`;
    progress(`Generating GBA bytecode from ${updKey}...`);
    updProg = await writeBlob(
      compiledData.files[updKey],
      "actor_update_script",
      "actor_update_script.c",
    );
  } else {
    updProg = emitGbaBytecode([{ kind: "stop" }]);
    await writeFile(
      Path.join(gbaEngineRoot, "src", "actor_update_script.c"),
      formatGbaProgramC("actor_update_script", updProg) + "\n",
    );
  }

  // --- Background -> graphics/scene_bg.bmp (Butano regular_bg via grit) --------
  // gbavm always links bn::regular_bg_items::scene_bg, so always emit it; a
  // project with no start-scene background gets a solid backdrop. Mono palette
  // matches tileDataIndexFn (index 0 = lightest .. 3 = darkest).
  await ensureDir(Path.join(gbaEngineRoot, "graphics"));
  // GBA background colour 0 is transparent, so the image pixels use indices 1..4
  // (the 4 GB shades, tileDataIndexFn order: 1 = lightest .. 4 = darkest) and the
  // bg renders fully opaque. Index 0 stays the (unused) backdrop entry; only the
  // canvas padding around the GB-sized image falls back to the backdrop.
  const palette = [
    hexToRgb(settings.customColorsBlack || "202850"), // 0: backdrop (transparent in bg)
    hexToRgb(settings.customColorsWhite || "E8F8E0"), // 1: lightest
    hexToRgb(settings.customColorsLight || "B0F088"), // 2
    hexToRgb(settings.customColorsDark || "509878"), // 3
    hexToRgb(settings.customColorsBlack || "202850"), // 4: darkest
  ];
  const background = projectData.backgrounds.find(
    (bg) => bg.id === startScene.backgroundId,
  );
  let bmp: Buffer;
  if (background) {
    progress(`Converting background ${background.filename}...`);
    const img = await readFileToIndexedImage(
      assetFilename(projectRoot, "backgrounds", background),
      tileDataIndexFn,
    );
    const data = new Uint8Array(img.data.length);
    for (let i = 0; i < data.length; i++) data[i] = (img.data[i] & 0x03) + 1;
    bmp = indexedImageToBmp(
      { width: img.width, height: img.height, data },
      palette,
      { align: 256 },
    );
  } else {
    bmp = indexedImageToBmp(
      { width: 8, height: 8, data: new Uint8Array(64) },
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
    let img;
    try {
      img = await readFileToIndexedImage(
        assetFilename(projectRoot, "sprites", sprite),
        tileDataIndexFn,
      );
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
      indexedImageToBmp(sheet.sheet, spritePalette, { align: 8 }),
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

  progress(
    `GBA bytecode: init ${initProg.bytes.length}b/${initProg.relocations.length} relocs, ` +
      `update ${updProg.bytes.length}b/${updProg.relocations.length} relocs; ` +
      `background ${background ? background.filename : "(none)"}`,
  );
};

export default ejectGbaBuild;
