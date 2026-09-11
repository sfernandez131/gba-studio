"""Independent reference for the M14b trace.

Parses the exporter's C for a song, applies hUGEDriver's tick-0 rules for the two pulse
channels (read from hUGEDriver.asm, not from huge_player.cpp), runs GB Studio's 64 Hz tick
schedule through the GBA frame clock, and predicts every note write: frame, tick, order,
row, channel, value. Then diffs the prediction against the trace captured on the GBA.

What this independently checks: DN() decoding, instrument/highmask handling, the note
table, row and order advance, and the tick accumulator. What it cannot check: whether I
read the driver's rules right - both implementations share that understanding. That is
what an ears-on listen (and, later, a GB-side trace) is for.
"""
import re, sys

song_c, trace_txt, takeover_frame = sys.argv[1], sys.argv[2], int(sys.argv[3])

NOTES = {}
names = ["C_", "Cs", "D_", "Ds", "E_", "F_", "Fs", "G_", "Gs", "A_", "As", "B_"]
for octave in range(3, 9):
    for i, n in enumerate(names):
        NOTES[f"{n}{octave}"] = (octave - 3) * 12 + i
NOTES["___"] = 90
LAST_NOTE = 72
NOTE_TABLE = [44, 156, 262, 363, 457, 547, 631, 710, 786, 854, 923, 986, 1046, 1102, 1155,
              1205, 1253, 1297, 1339, 1379, 1417, 1452, 1486, 1517, 1546, 1575, 1602, 1627,
              1650, 1673, 1694, 1714, 1732, 1750, 1767, 1783, 1798, 1812, 1825, 1837, 1849,
              1860, 1871, 1881, 1890, 1899, 1907, 1915, 1923, 1930, 1936, 1943, 1949, 1954,
              1959, 1964, 1969, 1974, 1978, 1982, 1985, 1988, 1992, 1995, 1998, 2001, 2004,
              2006, 2009, 2011, 2013, 2015]

text = open(song_c, encoding="utf-8").read()

patterns = {}
for m in re.finditer(r"static const unsigned char (song_pattern_\d+)\[\] = \{(.*?)\};", text, re.S):
    cells = []
    for dn in re.finditer(r"DN\((\w+), (\d+), 0x([0-9A-F]+)\)", m.group(2)):
        note = NOTES[dn.group(1)]
        instr = int(dn.group(2))
        eff = int(dn.group(3), 16)
        b0 = note | ((instr & 0x10) << 3)             # the DN macro, byte by byte
        b1 = ((instr << 4) & 0xFF) | (eff >> 8)
        b2 = eff & 0xFF
        cells.append((b0, b1, b2))
    patterns[m.group(1)] = cells

orders = {}
for m in re.finditer(r"order(\d)\[\] = \{(.*?)\};", text):
    orders[int(m.group(1))] = [x.strip() for x in m.group(2).split(",")]

duty = []
block = re.search(r"duty_instruments\[\] = \{(.*?)\};", text, re.S).group(1)
for m in re.finditer(r"\{ (0x[0-9A-F]+), (0x[0-9A-F]+), (0x[0-9A-F]+), (\w+), (0x[0-9A-F]+) \}", block):
    duty.append({"highmask": int(m.group(5), 16)})

ticks_per_row = int(re.search(r"_Data = \{\s*(\d+),", text).group(1))
order_count = int(re.search(r"order_cnt = (\d+);", text).group(1)) // 2

# --- the driver's rules, per hUGEDriver.asm ---------------------------------------------
highmask = [0, 0]
period = [0, 0]
expected = []
order, row, tick, total_ticks = 0, 0, 0, 0

def tick0():
    for c in (0, 1):
        b0, b1, _b2 = patterns[orders[c + 1][order]][row]
        if b0 >= LAST_NOTE:            # `cp LAST_NOTE / ret nc` -> rest: nothing but effects
            continue
        if (b1 & 0x0F) != 3:          # toneporta keeps the old period
            period[c] = NOTE_TABLE[b0]
        iid = b1 >> 4
        if iid == 0:
            highmask[c] &= 0x7F
        else:
            highmask[c] = duty[iid - 1]["highmask"]
        value = (period[c] & 0xFF) | ((highmask[c] | (period[c] >> 8)) << 8)
        expected.append((c, value))

def tick_time():
    global order, row, tick
    tick += 1
    if tick != ticks_per_row:
        return
    tick = 0
    row += 1
    if row == 64:
        row = 0
        order = (order + 1) % order_count

# --- schedule: GB's 64 Hz ticks through the GBA frame clock -----------------------------
trace = [tuple(int(x) for x in l.split()[1:]) for l in open(trace_txt) if l.startswith("T ")]
predicted = []
acc, frame = 0, takeover_frame
while len(predicted) < len(trace):
    acc += 280896 * 64
    while acc >= 16777216 and len(predicted) < len(trace):
        acc -= 16777216
        if tick == 0:
            before = len(expected)
            r, o = row, order
            tick0()
            for c, v in expected[before:]:
                predicted.append((frame, total_ticks, o, r, c, v))
        tick_time()
        total_ticks += 1
    frame += 1

mismatches = [(i, p, t) for i, (p, t) in enumerate(zip(predicted, trace)) if p != t]
print(f"song: ticks_per_row={ticks_per_row} orders={order_count}")
print(f"compared {len(trace)} writes (frame, tick, order, row, channel, value)")
if mismatches:
    print(f"MISMATCHES: {len(mismatches)}")
    for i, p, t in mismatches[:10]:
        print(f"  #{i}: predicted {p}  got {t}")
    sys.exit(1)
print("ALL MATCH")
