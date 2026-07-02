// GBA Studio embedded play window - drives the mGBA WebAssembly core
// (appData/wasm/mgba/js/mgba.js, MPL 2.0 - see LICENSE.mgba.txt).
// Mirrors the binjgb player (appData/wasm/binjgb) used for GB projects.
const ROM_FILENAME = "rom/game.gba";

(async () => {
  const canvas = document.getElementById("screen");
  const errorEl = document.getElementById("error");

  const fail = (msg) => {
    errorEl.style.display = "block";
    errorEl.textContent = "Failed to start emulator:\n" + msg;
  };

  try {
    const Module = await mGBA({ canvas });
    await Module.FSInit();

    const response = await fetch(ROM_FILENAME);
    if (!response.ok) {
      throw new Error(`ROM fetch failed: ${response.status} ${ROM_FILENAME}`);
    }
    const romData = new Uint8Array(await response.arrayBuffer());
    const romName = ROM_FILENAME.split("/").pop();
    const romPath = `${Module.filePaths().gamePath}/${romName}`;
    Module.FS.writeFile(romPath, romData);

    if (!Module.loadGame(romPath)) {
      throw new Error("mGBA could not load the ROM");
    }

    // Match GB Studio's default web-player keys where possible.
    // mGBA SDL defaults already map arrows + X(A)/Z(B)/Return(Start)/Backspace(Select);
    // add GB Studio's Shift -> Select alias.
    Module.bindKey("Right Shift", "Select");
    Module.setVolume(100);

    canvas.focus();
    window.addEventListener("click", () => canvas.focus());
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
})();
