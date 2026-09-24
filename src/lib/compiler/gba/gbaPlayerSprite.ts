/**
 * Which sprite sheet a scene's player uses - GB Studio's rule, from compileData.ts.
 *
 * A scene can override the player's sprite (`playerSpriteSheetId`). When it doesn't, the
 * project's default for that scene type applies (`settings.defaultPlayerSprites`), and an
 * override pointing at a sprite that no longer exists falls back to that default too.
 *
 * The GBA eject used to read only the override, so a scene relying on the default got no
 * player at all - which is every scene of the stock gbs2 sample.
 */
export const playerSpriteSheetIdFor = (
  scene: { type?: string; playerSpriteSheetId?: string },
  defaultPlayerSprites: Record<string, string> | undefined,
  spriteIds: ReadonlySet<string>,
): string | undefined => {
  const type = scene.type ?? "TOPDOWN";
  const fallback = defaultPlayerSprites?.[type];
  if (scene.playerSpriteSheetId && spriteIds.has(scene.playerSpriteSheetId)) {
    return scene.playerSpriteSheetId;
  }
  if (fallback && spriteIds.has(fallback)) {
    return fallback;
  }
  return undefined;
};

/**
 * A sprite's bounding box in subpixels relative to the actor's position - GB Studio's
 * compileBounds (generateGBVMData.ts): `left = x`, `right = x + w - 1`, `top = y`,
 * `bottom = y + h - 1`, at 32 subpixels per pixel, defaulting to a 16x16 box. Returned as
 * gbavm's GbaActorInit.bounds order: [left, right, top, bottom].
 */
export const spriteBoundsSubpx = (sprite?: {
  boundsX?: number;
  boundsY?: number;
  boundsWidth?: number;
  boundsHeight?: number;
}): [number, number, number, number] => {
  const bX = sprite?.boundsX || 0;
  const bY = sprite?.boundsY || 0;
  const bW = sprite?.boundsWidth || 16;
  const bH = sprite?.boundsHeight || 16;
  return [bX * 32, (bX + bW) * 32 - 1, bY * 32, (bY + bH) * 32 - 1];
};
