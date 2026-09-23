"""Prove the reference diff has teeth: break reference.py in small, plausible ways, one at a
time, and check that each break makes the diff FAIL against a real trace.

A clean "ALL MATCH" only means something if a wrong rule would not also match. Each
mutation below is a mistake a port could plausibly make - an off-by-one tick, a missed read
mask, a nibble swapped - and each should produce mismatches. A mutation that still matches
means the song never exercised that rule, and the song needs a case for it.

Run it against the synthetic effects song (make-effects-song.ts), which is built to exercise
every one of these:

usage: mutations.py <song.gba.c> <trace.bin> <first-write frame>

Two mutations that LOOK meaningful but cannot fail are deliberately left out:
  - NR14's read mask 0xBF -> 0x3F: vol slide ORs 0x80 into the read anyway.
  - toneporta clamping at `target + 1`: only differs if a slide overshoots by exactly 1.
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
song_c, trace_bin, frame = sys.argv[1], sys.argv[2], sys.argv[3]

MUTATIONS = [
    ("arpeggio phase ignores the -1", "a = (counter - 1) & 0xFF", "a = counter & 0xFF"),
    ("arpeggio reads the wrong nibble", "a = ((swap(c) & 0x0F) + d) & 0xFF", "a = ((c & 0x0F) + d) & 0xFF"),
    ("vibrato bends on the wrong phase", "if counter & (c >> 4) == 0:", "if counter & (c >> 4) != 0:"),
    ("porta down off by one", "(channel_period[b] - c) & 0xFFFF)", "(channel_period[b] - c - 1) & 0xFFFF)"),
    ("toneporta overshoots going up", "if hl < de:\n                de = hl", "if False:\n                de = hl"),
    ("toneporta overshoots going down", "if de & 0x8000 or de < hl:", "if de & 0x8000:"),
    ("toneporta never retriggers", "highmask[b] &= 0x7F\n        update_channel_freq(b, de, h)",
     "highmask[b] &= 0x7F\n        update_channel_freq(b, de, 0)"),
    ("NR32 read without its 0x9F mask", "0x1C: 0x9F", "0x1C: 0x00"),
    ("NR14 read with no mask at all", "0x14: 0xBF,", "0x14: 0x00,"),
    ("CH4 pitch effects use the period as a poly", "ldh(rAUD4POLY, get_note_poly(de & 0xFF) | step_width4)",
     "ldh(rAUD4POLY, (de & 0xFF) | step_width4)"),
    ("note delay a tick late", "if a == c:\n            play_chN_note(b)", "if a == c + 1:\n            play_chN_note(b)"),
    ("note cut retriggers CH3", "if b != 2:", "if True:"),
    ("CH3 set volume: 50% threshold", "elif c >= 5 << 4:", "elif c >= 6 << 4:"),
    ("CH3 set volume: 100% threshold", "if c >= 10 << 4:", "if c >= 11 << 4:"),
    ("pattern break row not one-based", "b = row_break - 1", "b = row_break"),
    ("position jump order not one-based", "a = ((next_order - 1) * 2) & 0xFF", "a = (next_order * 2) & 0xFF"),
    ("later ticks run param-0 effects", "if c == 0:                                      # ld a, c",
     "if False:                                      # ld a, c"),
    ("routine call loses the channel", "(TRACE_ROUTINE, (b << 8) | c)", "(TRACE_ROUTINE, c)"),
    ("master volume drops the Vin bits", "ldh(rAUDVOL, c)", "ldh(rAUDVOL, c & 0x77)"),
    ("set speed off by one", "ticks_per_row = c", "ticks_per_row = c + 1"),
    ("CH4 set duty never clears bit 3", "(ldh_read(rAUD4POLY) & ~0x08 & 0xFF) | c)", "ldh_read(rAUD4POLY) | c)"),
    ("vol slide clamps at 14", "a = 0x0F", "a = 0x0E"),
    ("past the note table holds the wrong note", "NOTE_TABLE[min(a, LAST_NOTE - 1)]", "NOTE_TABLE[min(a, LAST_NOTE - 2)]"),
]

source = open(os.path.join(HERE, "reference.py"), encoding="utf-8").read()
baseline = subprocess.run([sys.executable, os.path.join(HERE, "reference.py"), song_c, trace_bin, frame],
                          capture_output=True, text=True)
if "ALL MATCH" not in baseline.stdout:
    sys.exit("the unmutated reference does not match this trace - fix that first\n" + baseline.stdout)

survivors = 0
with tempfile.TemporaryDirectory() as work:
    for name, old, new in MUTATIONS:
        assert source.count(old) == 1, f"mutation no longer applies cleanly: {name}"
        path = os.path.join(work, "mutant.py")
        open(path, "w", encoding="utf-8").write(source.replace(old, new))
        result = subprocess.run([sys.executable, path, song_c, trace_bin, frame], capture_output=True, text=True)
        caught = next((l for l in result.stdout.splitlines() if l.startswith("MISMATCHES")), None)
        if not caught:
            survivors += 1
        print(f"  {'caught' if caught else 'SURVIVED':8} {name}" + (f"  ({caught.split(': ')[1]} mismatches)" if caught else ""))

print(f"{len(MUTATIONS) - survivors}/{len(MUTATIONS)} mutations caught")
sys.exit(1 if survivors else 0)
