"""Add the M14 note-write probe to a gbavm checkout - a THROWAWAY, never to be committed.

Compiles one song into the engine, starts it at a given frame, and records every
pulse-channel note write (frame, tick, order, row, channel, value) into an exported
buffer that the GDB stub can dump. `git checkout -- src && rm src/probe_song.c` in the
gbavm checkout reverts it.

usage: add_probe.py <gbavm root> <song.gba.c> <song symbol> <play frame>
  e.g. add_probe.py ../gbavm work/BattleTheme.gba.c song_Rulz_BattleTheme_Data 30

See scripts/huge/README.md.
"""
import io
import shutil
import sys

root, song_c, symbol, frame = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
root = root.rstrip("/\\") + "/"

shutil.copy(song_c, root + "src/probe_song.c")

p = root + "src/huge_player.cpp"
s = io.open(p, encoding="utf-8").read()
s = s.replace(
    "namespace\n{\n    // ---- GBA PSG registers",
    """// ---- M14 PROBE (throwaway) ----
extern "C" {
struct huge_trace_t { uint16_t frame; uint16_t tick; uint8_t order; uint8_t row; uint8_t ch; uint8_t pad; uint16_t value; };
huge_trace_t huge_trace[256];
uint16_t huge_trace_n = 0;
uint16_t huge_ticks = 0;
}
// ---- end probe ----

namespace
{
    // ---- GBA PSG registers""", 1)
s = s.replace(
    "        reg(c == 0 ? SOUND1CNT_X : SOUND2CNT_H) = x;\n",
    "        reg(c == 0 ? SOUND1CNT_X : SOUND2CNT_H) = x;\n"
    "        if(huge_trace_n < 256) { huge_trace[huge_trace_n++] = "
    "{ sys_time, huge_ticks, s.current_order, s.row, uint8_t(c), 0, x }; } // PROBE\n", 1)
s = s.replace("        dosound();\n", "        dosound();\n        ++huge_ticks; // PROBE\n", 1)
if s.count("PROBE") < 3:
    sys.exit("huge_player.cpp did not match the probe anchors - has the player changed?")
io.open(p, "w", encoding="utf-8", newline="").write(s)

p = root + "src/main.cpp"
s = io.open(p, encoding="utf-8").read()
s = s.replace(
    '#include "huge_player.h" // M14: .uge music on the Game Boy PSG\n',
    '#include "huge_player.h" // M14: .uge music on the Game Boy PSG\n'
    f'extern "C" const hUGESong_t {symbol}; // PROBE\n', 1)
s = s.replace(
    "        huge_update();",
    f"        if(sys_time == {frame}) huge_play(&{symbol}); // PROBE\n        huge_update();", 1)
if s.count("PROBE") != 2:
    sys.exit("main.cpp did not match the probe anchors")
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("probe added - revert with: git checkout -- src && rm src/probe_song.c")
