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

import {
  writeFile,
  readFile,
  ensureDir,
  pathExists,
  readdir,
  remove,
} from "fs-extra";
import Path from "path";
import { PNG } from "pngjs";
import { gbaEngineRoot } from "consts";
import { ProjectResources } from "shared/lib/resources/types";
import { assetFilename } from "shared/lib/helpers/assets";
import { tileDataIndexFn } from "shared/lib/tiles/tileData";
import { readFileToIndexedImage } from "lib/tiles/readFileToTiles";
import { readFileToPalettes } from "lib/tiles/readFileToPalettes";
import { getPalette } from "lib/compiler/scriptBuilder/helpers";
import { walkScenesScripts } from "shared/lib/scripts/walk";
import { parseGbvmAsm, parseGameGlobals } from "./parseGbvmAsm";
import {
  linkGbaProgram,
  formatGbaScenesC,
  cNameOf,
  GbaProc,
  GbaSceneEntry,
  GbaProjectileDefEntry,
} from "./linkGbaProgram";
import type { ProjectileData } from "../generateGBVMData";
import {
  indexedImageToBmp,
  hexToRgb,
  composeBankedImage,
} from "./writeIndexedBmp";
import type { Rgb } from "./writeIndexedBmp";
import { buildSpriteSheet, SpriteSheetInput } from "./writeSpriteSheet";

type EjectGbaOptions = {
  projectData: ProjectResources;
  projectRoot: string;
  outputRoot: string;
  compiledData: {
    files: Record<string, string>;
    // Compiled font order (indices that dialogue \002 font-switch codes refer to).
    usedFonts?: { id: string }[];
    // Global animation-state order (indices that STATE_* / VM_ACTOR_SET_ANIM_SET
    // refer to); [""] = just the default state (M10c).
    statesOrder?: string[];
    // Per-scene projectile defs in slot order (M10f), keyed by scene id.
    sceneProjectiles?: Record<string, ProjectileData[]>;
    // Global projectile tables (VM_PROJECTILE_LOAD_TYPE sources), in emit order.
    globalProjectiles?: { symbol: string; projectiles: ProjectileData[] }[];
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

  // Global animation-state order (M10c): each sprite's anim table gets one row
  // of 8 engine animations per entry, so the STATE_* index scripts pass to
  // VM_ACTOR_SET_ANIM_SET selects the right row at runtime.
  const statesOrder =
    compiledData.statesOrder && compiledData.statesOrder.length
      ? compiledData.statesOrder
      : [""];

  // Music: each project track plays on one of two GBA audio paths, chosen per-track by
  // settings.gbaAudioBackend: "dmg" (default) = the 4 Game Boy PSG channels via gbt-player
  // (chiptune, faithful to GB Studio; file -> dmg_audio/, bn::dmg_music_item), or "maxmod" =
  // the GBA's native DirectSound tracker mixer (file -> audio/, bn::music_item). One track-
  // index space spans both backends; gba_music_backend(idx) tells the engine which to use so
  // VM_MUSIC_PLAY resolves. Only .mod tracks for now (.uge needs a .vgm/.mod export - skipped).
  const dataSymbols: Record<string, number> = {};
  const dmgIncludes: string[] = [];
  const backendCases: string[] = [];
  const dmgCases: string[] = [];
  const maxmodCases: string[] = [];
  let haveMaxmod = false;
  await ensureDir(Path.join(gbaEngineRoot, "dmg_audio"));
  await ensureDir(Path.join(gbaEngineRoot, "audio"));
  // Clear stale generated .mod tracks first: a track that switched backend would otherwise
  // leave its file behind in the other dir (bloating the ROM / duplicate symbol). SFX .wav
  // in audio/ are written by the sound-effects step below, so they are left untouched here.
  for (const dir of ["dmg_audio", "audio"]) {
    const dirPath = Path.join(gbaEngineRoot, dir);
    for (const f of await readdir(dirPath)) {
      if (/\.mod$/i.test(f)) await remove(Path.join(dirPath, f));
    }
  }
  let musicIdx = 0;
  for (const track of projectData.music ?? []) {
    if (!/\.mod$/i.test(track.filename)) {
      warnings(
        `GBA: skipping music "${track.filename}" (only .mod tracks supported so far)`,
      );
      continue;
    }
    const maxmod = track.settings?.gbaAudioBackend === "maxmod";
    const destDir = maxmod ? "audio" : "dmg_audio";
    try {
      const data = await readFile(assetFilename(projectRoot, "music", track));
      await writeFile(
        Path.join(gbaEngineRoot, destDir, `${track.symbol}.mod`),
        data,
      );
    } catch (e) {
      warnings(`GBA: could not read music "${track.filename}"`);
      continue;
    }
    dataSymbols[`_${track.symbol}_Data`] = musicIdx;
    if (maxmod) {
      haveMaxmod = true;
      backendCases.push(`        case ${musicIdx}: return 1;`);
      maxmodCases.push(
        `        case ${musicIdx}: return &bn::music_items::${track.symbol};`,
      );
    } else {
      dmgIncludes.push(`#include "bn_dmg_music_items_${track.symbol}.h"`);
      dmgCases.push(
        `        case ${musicIdx}: return &bn::dmg_music_items::${track.symbol};`,
      );
    }
    progress(
      `Converting music ${track.filename} -> ${destDir}/${track.symbol}.mod (${
        maxmod ? "Maxmod" : "DMG"
      })`,
    );
    musicIdx++;
  }
  const musicHeader = [
    "// Generated by GBA Studio - music track lookup (DMG gbt-player + Maxmod DirectSound).",
    "#ifndef GBA_MUSIC_ASSETS_H",
    "#define GBA_MUSIC_ASSETS_H",
    '#include "bn_dmg_music_item.h"',
    '#include "bn_music_item.h"',
    ...dmgIncludes,
    // bn_music_items.h is only generated by Butano when audio/ has >=1 tracker module.
    ...(haveMaxmod ? ['#include "bn_music_items.h"'] : []),
    "// backend per track index: 0 = DMG (gbt-player PSG), 1 = Maxmod (DirectSound).",
    "inline int gba_music_backend(int idx) {",
    "    switch(idx) {",
    ...backendCases,
    "    default: break;",
    "    }",
    "    return 0;",
    "}",
    "inline const bn::dmg_music_item* gba_dmg_music_track(int idx) {",
    "    switch(idx) {",
    ...dmgCases,
    "    default: break;",
    "    }",
    "    return nullptr;",
    "}",
    "inline const bn::music_item* gba_maxmod_music_track(int idx) {",
    "    switch(idx) {",
    ...maxmodCases,
    "    default: break;",
    "    }",
    "    return nullptr;",
    "}",
    "#endif",
  ].join("\n");
  await writeFile(
    Path.join(gbaEngineRoot, "src", "gba_music_assets.h"),
    musicHeader + "\n",
  );

  // Sound effects (M5b): emit each .wav sound to gbavm's audio/ folder (Butano's Maxmod
  // backend compiles it to a bn::sound_item on DirectSound - separate from the DMG music
  // channels) + a gba_sfx(idx) lookup, and map each sound symbol `_<sym>` to its index
  // for VM_SFX_PLAY. Only .wav for now (vgm/fxhammer are GB register dumps - skipped).
  const sfxIncludes: string[] = [];
  const sfxCases: string[] = [];
  await ensureDir(Path.join(gbaEngineRoot, "audio"));
  let sfxIdx = 0;
  for (const sound of projectData.sounds ?? []) {
    if (sound.type !== "wav" || !/\.wav$/i.test(sound.filename)) {
      warnings(
        `GBA: skipping sound "${sound.filename}" (only .wav sound effects supported so far)`,
      );
      continue;
    }
    try {
      const data = await readFile(assetFilename(projectRoot, "sounds", sound));
      await writeFile(
        Path.join(gbaEngineRoot, "audio", `${sound.symbol}.wav`),
        data,
      );
    } catch (e) {
      warnings(`GBA: could not read sound "${sound.filename}"`);
      continue;
    }
    dataSymbols[`_${sound.symbol}`] = sfxIdx;
    sfxCases.push(
      `        case ${sfxIdx}: return &bn::sound_items::${sound.symbol};`,
    );
    progress(`Converting sound ${sound.filename} -> audio/${sound.symbol}.wav`);
    sfxIdx++;
  }
  // Butano emits ALL Maxmod sounds into one bn_sound_items.h (not per-sound headers
  // like sprites/music), so include it only when at least one sound was emitted.
  if (sfxCases.length > 0) sfxIncludes.push('#include "bn_sound_items.h"');
  const sfxHeader = [
    "// Generated by GBA Studio (M5b) - sound effect lookup.",
    "#ifndef GBA_SFX_ASSETS_H",
    "#define GBA_SFX_ASSETS_H",
    '#include "bn_sound_item.h"',
    ...sfxIncludes,
    "inline const bn::sound_item* gba_sfx(int idx) {",
    "    switch(idx) {",
    ...sfxCases,
    "    default: break;",
    "    }",
    "    return nullptr;",
    "}",
    "#endif",
  ].join("\n");
  await writeFile(
    Path.join(gbaEngineRoot, "src", "gba_sfx_assets.h"),
    sfxHeader + "\n",
  );

  // Emotes (M10d): scripts reference an emote by its "_<symbol>" data pointer
  // (VM_ACTOR_EMOTE bank+ptr pair, like SFX). Register the indices BEFORE the
  // scripts parse; the sprite images are emitted with the avatars below.
  for (let e = 0; e < (projectData.emotes ?? []).length; e++) {
    dataSymbols[`_${projectData.emotes[e].symbol}`] = e;
  }

  // Projectiles (M10f): each scene's defs (in slot order, preloaded by the engine
  // on scene load) + the global tables VM_PROJECTILE_LOAD_TYPE draws from. A def's
  // sprite is an index into the projectile sprite table emitted with the scene
  // sprites below; unique sheet ids are collected here so the def rows can be
  // built before the graphics section runs.
  const sceneProjectiles = compiledData.sceneProjectiles ?? {};
  const globalProjectileTables = compiledData.globalProjectiles ?? [];
  const globalSpriteIds: string[] = [];
  const globalSpriteIndex = (spriteSheetId: string): number => {
    let idx = globalSpriteIds.indexOf(spriteSheetId);
    if (idx < 0) {
      idx = globalSpriteIds.length;
      globalSpriteIds.push(spriteSheetId);
    }
    return idx;
  };
  // Runtime spritesheet swaps (M10h): every sheet a Set Sprite event can switch
  // to joins the global sprite table, and its `_<symbol>` data symbol resolves
  // to that index so VM_ACTOR_SET_SPRITESHEET bridges like emotes/music.
  walkScenesScripts(
    scenes,
    {
      customEvents: {
        lookup: Object.fromEntries(
          (projectData.scripts ?? []).map((sc) => [sc.id, sc]),
        ),
        maxDepth: 5,
      },
    },
    (event) => {
      if (
        (event.command === "EVENT_ACTOR_SET_SPRITE" ||
          event.command === "EVENT_PLAYER_SET_SPRITE") &&
        event.args &&
        typeof event.args.spriteSheetId === "string"
      ) {
        const sprite = projectData.sprites.find(
          (sp) => sp.id === event.args?.spriteSheetId,
        );
        if (sprite) {
          dataSymbols[`_${sprite.symbol}`] = globalSpriteIndex(sprite.id);
        }
      }
    },
  );
  // GB collision group encoding (gbs_types.h): player 0x01, "1" 0x02, "2" 0x04, "3" 0x08.
  const collisionGroupBit = (group: string): number =>
    (
      ({ player: 0x01, "1": 0x02, "2": 0x04, "3": 0x08 }) as Record<
        string,
        number
      >
    )[group] ?? 0;
  const toProjectileDefEntry = (p: ProjectileData): GbaProjectileDefEntry => {
    const stateIndex = statesOrder.indexOf(p.spriteStateId);
    return {
      sprite: globalSpriteIndex(p.spriteSheetId),
      animState: stateIndex > 0 ? stateIndex : 0,
      // Authored speed -> subpixels/frame (GB Studio speed 1 = 1px = 32).
      moveSpeed: Math.max(1, Math.round(p.speed * 32)),
      lifeTime: Math.max(1, Math.round(p.lifeTime * 60)),
      collisionGroup: collisionGroupBit(p.collisionGroup),
      collisionMask: (p.collisionMask ?? []).reduce(
        (mask, g) => mask | collisionGroupBit(g),
        0,
      ),
      strong: p.destroyOnHit ? 0 : 1,
      animTick: p.animSpeed ?? 15,
      animNoLoop: p.loopAnim ? 0 : 1,
      initialOffset: Math.round((p.initialOffset || 0) * 32),
    };
  };
  // Flatten the global tables and register each `_global_projectiles_<n>` symbol
  // as its table's base index BEFORE the scripts parse (VM_PROJECTILE_LOAD_TYPE
  // resolves it like SFX/emote data symbols).
  const globalProjectileDefs: GbaProjectileDefEntry[] = [];
  for (const table of globalProjectileTables) {
    dataSymbols[`_${table.symbol}`] = globalProjectileDefs.length;
    for (const p of table.projectiles) {
      globalProjectileDefs.push(toProjectileDefEntry(p));
    }
  }

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
    // M6c: each placed actor may carry an interact script (`_<symbol>_interact`, its
    // "On Interact" script); the engine runs it when the player faces the actor + hits
    // A. "0" when the actor has none.
    const actorsInit = scene.actors.map((actor, i) => {
      const unit = actor.coordinateType === "pixels" ? 32 : 256;
      const interactSym = `_${actor.symbol}_interact`;
      let interact = "0";
      if (scriptForSymbol(interactSym) !== undefined) {
        interact = cNameOf(interactSym);
        queue.push(interactSym);
      }
      return {
        index: i + 1,
        dir: dirCode[actor.direction] ?? 0,
        x: Math.round(actor.x * unit),
        y: Math.round(actor.y * unit),
        interact,
        // M10a: authored speed -> subpixels/frame (GB Studio speed 1 = 1px = 32).
        moveSpeed: Math.max(1, Math.round((actor.moveSpeed ?? 1) * 32)),
        // M10f: authored collision group -> the GB group bit (projectile hits).
        collisionGroup: collisionGroupBit(actor.collisionGroup ?? ""),
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
        interact: "0",
        moveSpeed: Math.max(1, Math.round((settings.startMoveSpeed ?? 1) * 32)),
        collisionGroup: 0x01, // the player group (M10f)
      });
    }
    // Built-in top-down d-pad control for TOPDOWN scenes (other movement types and
    // platformer physics are later milestones).
    const playerMove = scene.type === "TOPDOWN" ? 1 : 0;
    // Collision grid sized to the engine's tile dims (widthPx/8 x heightPx/8),
    // copied from the scene's per-tile collision bytes. Empty when nothing is solid.
    const sceneColl: number[] = scene.collisions ?? [];
    const collisions: number[] = [];
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
    // Trigger zones (M6b): a tile rect + an enter script (`_<symbol>_interact`); the
    // engine runs the script when the player walks into the rect. Skip empty triggers.
    const triggers: {
      x: number;
      y: number;
      w: number;
      h: number;
      scriptCName: string;
    }[] = [];
    (scene.triggers ?? []).forEach((trigger) => {
      const symbol = `_${trigger.symbol}_interact`;
      if (scriptForSymbol(symbol) !== undefined) {
        triggers.push({
          x: trigger.x,
          y: trigger.y,
          w: trigger.width,
          h: trigger.height,
          scriptCName: cNameOf(symbol),
        });
        queue.push(symbol);
      }
    });
    // The scene's combined player-hit script (M10g): `_<symbol>_p_hit1` exists
    // when any player On Hit tab is authored; run when a projectile hits actor 0.
    const playerHitSymbol = `_${scene.symbol}_p_hit1`;
    let playerHit = "0";
    if (scriptForSymbol(playerHitSymbol) !== undefined) {
      playerHit = cNameOf(playerHitSymbol);
      queue.push(playerHitSymbol);
    }
    sceneEntries.push({
      initCName: cNameOf(initSymbol),
      actorUpdates,
      widthPx,
      heightPx,
      actorsInit,
      playerMove,
      collisions,
      triggers,
      // Projectile defs in slot order (M10f), preloaded on scene load.
      projectiles: (sceneProjectiles[scene.id] ?? []).map(toProjectileDefEntry),
      playerHit,
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
    const { items, skipped } = parseGbvmAsm(asmText, {
      sceneIndex,
      globals,
      dataSymbols,
    });
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
  await writeFile(
    Path.join(gbaEngineRoot, "src", "gba_program.c"),
    linked.source,
  );
  await writeFile(
    Path.join(gbaEngineRoot, "src", "gba_scenes.c"),
    formatGbaScenesC(sceneEntries, startSceneIndex, globalProjectileDefs),
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
      warnings(
        `GBA: "${Path.basename(file)}" has >255 colours; extras clamped`,
      );
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
  // the scene has none). Colour scenes return multiBank=true: the BMP palette is
  // laid out as 16-colour banks (GBC palette i -> bank i, colours 1..4) and the
  // item json must say bpp_4_manual so Butano keeps per-tile bank attribution
  // (M12a; layout + quantizer behaviour verified by spike 2026-07-14).
  const convertBackground = async (
    scene: (typeof scenes)[number],
  ): Promise<{ bmp: Buffer; multiBank: boolean }> => {
    const bg = projectData.backgrounds.find((b) => b.id === scene.backgroundId);
    if (!bg) {
      return {
        bmp: indexedImageToBmp(
          { width: 8, height: 8, data: new Uint8Array(64) },
          [hexToRgb(settings.customColorsBlack || "202850")],
          { align: 256 },
        ),
        multiBank: false,
      };
    }
    if (isColor) {
      // GBC palette model (M12a): per-pixel GB shade (0..3) + per-tile palette
      // (0..7), composed as bank*16 + 1 + shade. Auto-colour backgrounds get
      // both from upstream's extractor; manual ones pair the 4-shade art with
      // scene.paletteIds + the background's painted tileColors.
      progress(`Converting background ${bg.filename} (colour)...`);
      const file = assetFilename(projectRoot, "backgrounds", bg);
      let shades: { width: number; height: number; data: Uint8Array };
      let tileBanks: number[];
      let bankPalettes: string[][];
      if (bg.autoColor) {
        // uiPalette is only relevant to UI-tagged tiles - M12d territory.
        const auto = await readFileToPalettes(
          file,
          settings.colorCorrection,
          undefined,
        );
        shades = auto.indexedImage;
        tileBanks = auto.map;
        bankPalettes = auto.palettes;
      } else {
        shades = await readFileToIndexedImage(file, tileDataIndexFn);
        tileBanks = bg.tileColors ?? [];
        bankPalettes = [];
        for (let i = 0; i < 8; i++) {
          bankPalettes.push(
            getPalette(
              projectData.palettes,
              scene.paletteIds?.[i] ?? "",
              settings.defaultBackgroundPaletteIds?.[i] ?? "",
            ).colors,
          );
        }
      }
      const { img, palette } = composeBankedImage(
        shades,
        tileBanks,
        bankPalettes,
      );
      return {
        bmp: indexedImageToBmp(img, palette, { align: 256 }),
        multiBank: true,
      };
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
    return {
      bmp: indexedImageToBmp(
        { width: src.width, height: src.height, data },
        palette,
        { align: 256 },
      ),
      multiBank: false,
    };
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
    const converted = await convertBackground(scene);
    await writeFile(
      Path.join(gbaEngineRoot, "graphics", `${bgName}.bmp`),
      converted.bmp,
    );
    await writeFile(
      Path.join(gbaEngineRoot, "graphics", `${bgName}.json`),
      JSON.stringify(
        converted.multiBank
          ? { type: "regular_bg", ["bpp_mode"]: "bpp_4_manual" }
          : { type: "regular_bg" },
      ) + "\n",
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
        statesOrder,
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
      // M10c: [statesOrder.length][8] row-major animation tables per sprite.
      const starts = sheet.animRanges.map((r) => r.start).join(", ");
      const lens = sheet.animRanges.map((r) => r.len).join(", ");
      spriteTables.push(
        `static const unsigned char ${name}_anim_start[] = { ${starts} };`,
        `static const unsigned char ${name}_anim_len[] = { ${lens} };`,
      );
      rowByIndex.set(
        idx,
        `    { &bn::sprite_items::${name}, ${name}_anim_start, ${name}_anim_len },`,
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
      rows.push(rowByIndex.get(idx) ?? `    { nullptr, nullptr, nullptr },`);
    }
    spriteTables.push(`static const GbaActorSprite scene${s}_sprites[] = {`);
    spriteTables.push(...rows);
    spriteTables.push("};");
    spriteTables.push(
      `static const int scene${s}_sprites_count = ${maxIndex + 1};`,
    );
    spriteCases.push(
      `        case ${s}: return (actorIdx >= 0 && actorIdx < scene${s}_sprites_count) ? ` +
        `&scene${s}_sprites[actorIdx] : nullptr;`,
    );
  }

  // Global sprites (M10f/M10h): each unique sheet referenced by a projectile
  // def or a Set Sprite event, emitted ONCE through the same pipeline as actor
  // sprites; GbaProjectileDef.sprite and VM_ACTOR_SET_SPRITESHEET both index
  // this table. Butano manages sprite VRAM dynamically, so no per-scene
  // allocation is needed.
  const projCases: string[] = [];
  for (let pi = 0; pi < globalSpriteIds.length; pi++) {
    const sprite = projectData.sprites.find(
      (sp) => sp.id === globalSpriteIds[pi],
    );
    if (!sprite || !sprite.states || sprite.states.length === 0) {
      warnings(`GBA: global sprite ${globalSpriteIds[pi]} not found - skipped`);
      continue;
    }
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
      warnings(`GBA: could not read projectile sprite "${sprite.filename}"`);
      continue;
    }
    const sheet = buildSpriteSheet(
      sprite as unknown as SpriteSheetInput,
      img,
      spriteMode,
      statesOrder,
    );
    const name = `global_sprite_${pi}`;
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
    spriteTables.push(
      `static const unsigned char ${name}_anim_start[] = { ${starts} };`,
      `static const unsigned char ${name}_anim_len[] = { ${lens} };`,
      `static const GbaActorSprite ${name}_def = ` +
        `{ &bn::sprite_items::${name}, ${name}_anim_start, ${name}_anim_len };`,
    );
    projCases.push(`        case ${pi}: return &${name}_def;`);
    progress(
      `Converting global sprite ${sprite.filename} -> ${name} (${sheet.frameCount} frames)`,
    );
  }

  // Generate src/gba_scene_assets.h: per-scene bg + actor->sprite lookups (engine
  // frame order: Down, Right, Up, Left, then the moving set).
  const assetsHeader = [
    "// Generated by GBA Studio (M2) - per-scene background + actor sprite tables.",
    "// M10c: anim_start/anim_len point to [GBA_ANIM_STATES][8] row-major tables",
    "// (one row of 8 engine animations per animation state; state 0 = default).",
    "#ifndef GBA_SCENE_ASSETS_H",
    "#define GBA_SCENE_ASSETS_H",
    '#include "bn_regular_bg_ptr.h"',
    '#include "bn_sprite_item.h"',
    ...bgIncludes,
    ...spriteIncludes,
    `static const int GBA_ANIM_STATES = ${statesOrder.length};`,
    "struct GbaActorSprite {",
    "    const bn::sprite_item* item;",
    "    const unsigned char* anim_start; // [GBA_ANIM_STATES][8]",
    "    const unsigned char* anim_len;",
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
    "// M10f/M10h: global sprite lookup - projectile defs and runtime",
    "// spritesheet swaps both index this table.",
    "inline const GbaActorSprite* gba_global_sprite(int idx) {",
    "    switch(idx) {",
    ...projCases,
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

  // Emotes (M10d): each project emote becomes a Butano sprite the engine shows
  // above an actor's head for ~1s (VM_ACTOR_EMOTE). Index = position in
  // projectData.emotes, matching the dataSymbols registration above.
  const emoteIncludes: string[] = [];
  const emoteCases: string[] = [];
  for (let e = 0; e < (projectData.emotes ?? []).length; e++) {
    const emote = projectData.emotes[e];
    let img: { width: number; height: number; data: Uint8Array };
    let palette = spritePalette;
    try {
      if (isColor) {
        ({ img, palette } = await readTrueColor(
          assetFilename(projectRoot, "emotes", emote),
          true,
        ));
      } else {
        img = await readFileToIndexedImage(
          assetFilename(projectRoot, "emotes", emote),
          tileDataIndexFn,
        );
      }
    } catch (err) {
      warnings(`GBA: could not read emote "${emote.filename}"`);
      continue;
    }
    const name = `emote_${e}`;
    await writeFile(
      Path.join(gbaEngineRoot, "graphics", `${name}.bmp`),
      indexedImageToBmp(img, palette, { align: 8 }),
    );
    await writeFile(
      Path.join(gbaEngineRoot, "graphics", `${name}.json`),
      JSON.stringify({ type: "sprite", height: img.height }) + "\n",
    );
    emoteIncludes.push(`#include "bn_sprite_items_${name}.h"`);
    emoteCases.push(`        case ${e}: return &bn::sprite_items::${name};`);
    progress(`Converting emote ${emote.filename} -> ${name}`);
  }
  const emoteHeader = [
    "// Generated by GBA Studio (M10d) - actor emote sprite lookup.",
    "#ifndef GBA_EMOTE_ASSETS_H",
    "#define GBA_EMOTE_ASSETS_H",
    '#include "bn_sprite_item.h"',
    ...emoteIncludes,
    "inline const bn::sprite_item* gba_emote_sprite(int emoteIdx) {",
    "    switch(emoteIdx) {",
    ...emoteCases,
    "    default: break;",
    "    }",
    "    return nullptr;",
    "}",
    "#endif",
  ].join("\n");
  await writeFile(
    Path.join(gbaEngineRoot, "src", "gba_emote_assets.h"),
    emoteHeader + "\n",
  );

  // --- Dialogue fonts: graphics/dialogue_font_<i>.bmp + src/gba_font_assets.h
  // (M4n/M4o/M4p). Emit each USED font (in the compiled order that dialogue \002
  // font-switch codes index) as a Butano VARIABLE-WIDTH sprite font, so dialogue
  // renders in the project fonts AND can switch font mid-text. Like GB Studio's VWF,
  // each glyph is left-aligned with its advance width derived from its drawn extent;
  // the empty (space) glyph gets a default advance.
  const FONT_GLYPHS = 94; // ASCII 33..126 (space=32 has no glyph; Butano spaces it)
  const FONT_GH = 8; // GB Studio font glyph height (8x8)
  const FONT_SPACE_W = 4; // advance width for empty glyphs (space)
  const fontPalette: Rgb[] = [
    [0, 0, 0], // 0: transparent
    hexToRgb(settings.customColorsWhite || "E8F8E0"), // 1: light text on the dark box
  ];
  // Convert one GB Studio font image to a left-aligned glyph strip + advance widths.
  const buildFont = async (
    font: (typeof projectData.fonts)[number],
  ): Promise<{ strip: Uint8Array; widths: number[] } | null> => {
    try {
      // Light "white" (~g=248) + the magenta transparent marker are background; the
      // darker drawn pixels are the glyph (1).
      const fontImg = await readFileToIndexedImage(
        assetFilename(projectRoot, "fonts", font),
        (r, g, b) => (g >= 200 || (r > 200 && b > 200) ? 0 : 1),
      );
      const cols = Math.max(1, Math.floor(fontImg.width / 8));
      const strip = new Uint8Array(8 * FONT_GLYPHS * FONT_GH);
      const widths: number[] = [];
      for (let c = 32; c <= 126; c++) {
        const gi = c - 32; // image glyph index (0 = space, 1 = '!', ...)
        const col = gi % cols;
        const row = Math.floor(gi / cols);
        // Drawn extent within the 8x8 cell (for left-align + advance width).
        let minX = 8;
        let maxX = -1;
        for (let y = 0; y < FONT_GH; y++) {
          for (let x = 0; x < 8; x++) {
            if (
              fontImg.data[(row * FONT_GH + y) * fontImg.width + (col * 8 + x)]
            ) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
            }
          }
        }
        if (maxX < minX) {
          widths.push(FONT_SPACE_W); // empty glyph (space)
        } else {
          widths.push(maxX - minX + 1 + 1); // drawn width + 1px gap
          if (c >= 33) {
            // Copy the glyph left-aligned into its strip frame (frame = char - 33).
            const fi = c - 33;
            for (let y = 0; y < FONT_GH; y++) {
              for (let x = minX; x <= maxX; x++) {
                strip[(fi * FONT_GH + y) * 8 + (x - minX)] =
                  fontImg.data[
                    (row * FONT_GH + y) * fontImg.width + (col * 8 + x)
                  ] ?? 0;
              }
            }
          }
        }
      }
      return { strip, widths };
    } catch (e) {
      return null;
    }
  };
  // Fonts to emit, in compiled order (so \002 indices match); fall back to just the
  // default font when the compiled font order isn't available.
  const fontList = (
    compiledData.usedFonts && compiledData.usedFonts.length
      ? compiledData.usedFonts.map((uf) =>
          projectData.fonts.find((f) => f.id === uf.id),
        )
      : [
          projectData.fonts.find((f) => f.id === settings.defaultFontId) ??
            projectData.fonts[0],
        ]
  ).filter((f): f is NonNullable<typeof f> => Boolean(f));
  const fontIncludes: string[] = [];
  const fontDefs: string[] = [];
  const fontCases: string[] = [];
  let firstFontIdx = -1;
  for (let i = 0; i < fontList.length; i++) {
    const built = await buildFont(fontList[i]);
    if (!built) {
      warnings(`GBA: could not read font "${fontList[i].filename}"`);
      continue;
    }
    const name = `dialogue_font_${i}`;
    await writeFile(
      Path.join(gbaEngineRoot, "graphics", `${name}.bmp`),
      indexedImageToBmp(
        { width: 8, height: FONT_GLYPHS * FONT_GH, data: built.strip },
        fontPalette,
        { align: 8 },
      ),
    );
    await writeFile(
      Path.join(gbaEngineRoot, "graphics", `${name}.json`),
      JSON.stringify({ type: "sprite", height: FONT_GH }) + "\n",
    );
    const widthsRows: string[] = [];
    for (let w = 0; w < built.widths.length; w += 16) {
      widthsRows.push("    " + built.widths.slice(w, w + 16).join(", ") + ",");
    }
    fontIncludes.push(`#include "bn_sprite_items_${name}.h"`);
    fontDefs.push(
      `constexpr int8_t gba_font_${i}_widths[] = { // advance width per ASCII char 32..126`,
      ...widthsRows,
      "};",
      `constexpr bn::sprite_font gba_font_${i}(bn::sprite_items::${name},`,
      `    bn::utf8_characters_map_ref(), gba_font_${i}_widths);`,
    );
    fontCases.push(`        case ${i}: return gba_font_${i};`);
    if (firstFontIdx < 0) firstFontIdx = i;
    progress(`Converting font ${fontList[i].filename} -> ${name}`);
  }
  // Emit the descriptor: a gba_dialogue_font(idx) lookup over the emitted fonts, so
  // the engine can pick the font for each \002 segment. Falls back to Butano's
  // built-in font if no project font could be read (engine still compiles).
  const fontHeaderLines = [
    "// Generated by GBA Studio (M4p) - dialogue fonts (project fonts, variable-width).",
    "#ifndef GBA_FONT_ASSETS_H",
    "#define GBA_FONT_ASSETS_H",
    '#include "bn_sprite_font.h"',
    '#include "bn_utf8_characters_map.h"',
  ];
  if (fontCases.length > 0) {
    fontHeaderLines.push(
      ...fontIncludes,
      ...fontDefs,
      `constexpr int gba_dialogue_font_count = ${fontCases.length};`,
      "inline const bn::sprite_font& gba_dialogue_font(int idx) {",
      "    switch(idx) {",
      ...fontCases,
      `    default: return gba_font_${firstFontIdx < 0 ? 0 : firstFontIdx};`,
      "    }",
      "}",
    );
  } else {
    fontHeaderLines.push(
      '#include "common_variable_8x16_sprite_font.h"',
      "constexpr int gba_dialogue_font_count = 1;",
      "inline const bn::sprite_font& gba_dialogue_font(int) {",
      "    return common::variable_8x16_sprite_font;",
      "}",
    );
  }
  fontHeaderLines.push("#endif");
  await writeFile(
    Path.join(gbaEngineRoot, "src", "gba_font_assets.h"),
    fontHeaderLines.join("\n") + "\n",
  );

  // The built .gba is collected here by makeGbaBuild (mirrors build/rom for GBDK).
  await ensureDir(Path.join(outputRoot, "build", "gba"));

  const totalBytes = linked.procs.reduce(
    (n, p) => n + p.program.bytes.length,
    0,
  );
  progress(
    `GBA link: ${linked.procs.length} proc(s)/${totalBytes}b across ` +
      `${sceneEntries.length} scene(s) (start index ${startSceneIndex}), ` +
      `${linked.unresolved.length} deferred external(s)`,
  );
};

export default ejectGbaBuild;
