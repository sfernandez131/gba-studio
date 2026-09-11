"""Turn on the hUGE player's verification trace in a gbavm checkout - a THROWAWAY, never
to be committed.

The player routes every PSG write that carries musical state through one helper, and
logs it when HUGE_TRACE is defined (gbavm/src/huge_player.cpp). So this only has to:
  1. define HUGE_TRACE at the top of huge_player.cpp,
  2. compile one song into the engine (as src/probe_song.c), and
  3. start it at a given frame from main.cpp.
It deliberately does not reach into the player's internals, so it keeps working as the
player grows.

Revert with `add_probe.py <gbavm root> --revert`. That removes exactly the lines tagged
`// PROBE` and the song file, and nothing else. Do NOT revert with `git checkout -- src`:
that also throws away any uncommitted work on the player - which is how M14c1's first draft
was lost (it was rebuilt from the session transcript).

usage: add_probe.py <gbavm root> <song.gba.c> <song symbol> <play frame>
       add_probe.py <gbavm root> --revert
  e.g. add_probe.py ../gbavm work/BattleTheme.gba.c song_Rulz_BattleTheme_Data 30

See scripts/huge/README.md.
"""
import io
import os
import shutil
import sys

root = sys.argv[1].rstrip("/\\") + "/"

if len(sys.argv) == 3 and sys.argv[2] == "--revert":
    for name in ("src/huge_player.cpp", "src/main.cpp"):
        p = root + name
        s = io.open(p, encoding="utf-8").read()
        kept = [line for line in s.split("\n") if "// PROBE" not in line]
        io.open(p, "w", encoding="utf-8", newline="").write("\n".join(kept))
    if os.path.exists(root + "src/probe_song.c"):
        os.remove(root + "src/probe_song.c")
    print("probe removed")
    sys.exit(0)

song_c, symbol, frame = sys.argv[2], sys.argv[3], int(sys.argv[4])

shutil.copy(song_c, root + "src/probe_song.c")

p = root + "src/huge_player.cpp"
s = io.open(p, encoding="utf-8").read()
if "#define HUGE_TRACE" not in s:
    s = "#define HUGE_TRACE 1 // PROBE\n" + s
io.open(p, "w", encoding="utf-8", newline="").write(s)

# Work in whole lines, and only ever ADD lines. Inserting mid-line would push part of an
# existing line onto a `// PROBE` line, and --revert would then delete it (an early version
# of this script ate main.cpp's include comment that way).
p = root + "src/main.cpp"
lines = io.open(p, encoding="utf-8").read().split("\n")
inc = next((i for i, l in enumerate(lines) if l.startswith('#include "huge_player.h"')), None)
upd = next((i for i, l in enumerate(lines) if l.strip() == "huge_update();"
            or l.strip().startswith("huge_update();")), None)
if inc is None or upd is None:
    sys.exit("main.cpp no longer includes huge_player.h / calls huge_update() - update this probe")
indent = lines[upd][: len(lines[upd]) - len(lines[upd].lstrip())]
lines.insert(upd, f"{indent}if(sys_time == {frame}) huge_play(&{symbol}); // PROBE")
lines.insert(inc + 1, f'extern "C" const hUGESong_t {symbol}; // PROBE')
io.open(p, "w", encoding="utf-8", newline="").write("\n".join(lines))
print(f"probe added - revert with: add_probe.py {root} --revert")
