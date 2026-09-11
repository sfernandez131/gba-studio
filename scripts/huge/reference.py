"""Independent reference for the hUGE player's verification trace.

Parses the exporter's C for a song, applies hUGEDriver's rules (read from hUGEDriver.asm,
NOT from gbavm's huge_player.cpp), runs GB Studio's 64 Hz tick schedule through the GBA
frame clock, and predicts every traced PSG write: frame, tick, order, row, channel, what,
value. Then diffs the prediction against the trace captured on the GBA.

Covers tick 0 on all four channels (M14b pulse, M14c1 wave + noise): instrument register
writes, wave loads, and note triggers. Effects (M14c2) and subpattern tables (M14c3) add
writes on other ticks; the rules for those get added here when the player gains them.

What this independently checks: DN() decoding, instruments and highmasks, the note table,
the noise polynomial, wave switching, row/order advance, and the tick accumulator. What it
cannot check: whether I read the driver's rules right - both implementations share that
reading. That is what an ears-on listen is for.

usage: reference.py <song.gba.c> <trace.txt> <first-write frame>
"""
import re
import sys

song_c, trace_txt, takeover_frame = sys.argv[1], sys.argv[2], int(sys.argv[3])

W_SWEEP, W_LEN_ENV, W_NOTE, W_WAVE = 1, 2, 3, 4
LAST_NOTE = 72
NO_WAVE = 100

NOTES = {"___": 90}
for octave in range(3, 9):
    for i, n in enumerate(["C_", "Cs", "D_", "Ds", "E_", "F_", "Fs", "G_", "Gs", "A_", "As", "B_"]):
        NOTES[f"{n}{octave}"] = (octave - 3) * 12 + i

# hUGE_note_table.inc
NOTE_TABLE = [44, 156, 262, 363, 457, 547, 631, 710, 786, 854, 923, 986, 1046, 1102, 1155,
              1205, 1253, 1297, 1339, 1379, 1417, 1452, 1486, 1517, 1546, 1575, 1602, 1627,
              1650, 1673, 1694, 1714, 1732, 1750, 1767, 1783, 1798, 1812, 1825, 1837, 1849,
              1860, 1871, 1881, 1890, 1899, 1907, 1915, 1923, 1930, 1936, 1943, 1949, 1954,
              1959, 1964, 1969, 1974, 1978, 1982, 1985, 1988, 1992, 1995, 1998, 2001, 2004,
              2006, 2009, 2011, 2013, 2015]


def swap(v):
    """The Z80 SWAP: exchange nibbles (only equal to *16 for values below 16)."""
    return ((v << 4) | (v >> 4)) & 0xFF


def note_poly(note):
    """get_note_poly, step by step in 8-bit arithmetic."""
    a = (note + 192) & 0xFF          # add 192
    a = (~a) & 0xFF                  # cpl
    if a < 7:                        # cp 7 / ret c
        return a
    h = a
    l = ((a >> 2) - 1) & 0xFF        # srl / srl / dec
    a = ((h & 3) + 4) & 0xFF         # and 3 / add 4
    return (a | swap(l)) & 0xFF      # swap l / or l


# ---- parse the song -------------------------------------------------------------------
text = open(song_c, encoding="utf-8").read()
H = r"(0x[0-9A-F]+)"

patterns = {}
for m in re.finditer(r"static const unsigned char (song_pattern_\d+)\[\] = \{(.*?)\};", text, re.S):
    cells = []
    for dn in re.finditer(r"DN\((\w+), (\d+), 0x([0-9A-F]+)\)", m.group(2)):
        note, instr, eff = NOTES[dn.group(1)], int(dn.group(2)), int(dn.group(3), 16)
        cells.append((note | ((instr & 0x10) << 3),              # the DN macro, byte by byte
                      ((instr << 4) & 0xFF) | (eff >> 8),
                      eff & 0xFF))
    patterns[m.group(1)] = cells

orders = {int(m.group(1)): [x.strip() for x in m.group(2).split(",")]
          for m in re.finditer(r"order(\d)\[\] = \{(.*?)\};", text)}


def block(name):
    return re.search(name + r"\[\] = \{(.*?)\};", text, re.S).group(1)


duty = [dict(sweep=int(a, 16), len_duty=int(b, 16), env=int(c, 16), highmask=int(e, 16))
        for a, b, c, _d, e in re.findall(rf"\{{ {H}, {H}, {H}, (\w+), {H} \}}", block("duty_instruments"))]
wave = [dict(length=int(a, 16), volume=int(b, 16), waveform=int(c, 16), highmask=int(e, 16))
        for a, b, c, _d, e in re.findall(rf"\{{ {H}, {H}, {H}, (\w+), {H} \}}", block("wave_instruments"))]
noise = [dict(env=int(a, 16), highmask=int(c, 16))
         for a, _b, c in re.findall(rf"\{{ {H}, (\w+), {H}, 0, 0 \}}", block("noise_instruments"))]

ticks_per_row = int(re.search(r"_Data = \{\s*(\d+),", text).group(1))
order_count = int(re.search(r"order_cnt = (\d+);", text).group(1)) // 2

# ---- the driver's rules, per hUGEDriver.asm -------------------------------------------
period = [0, 0, 0, 0]
highmask = [0, 0, 0, 0]
current_wave = NO_WAVE
order, row, tick = 0, 0, 0
out = []   # (ch, what, value), for the current tick


def cell(c):
    return patterns[orders[c + 1][order]][row]


def duty_channel(c):
    """hUGE_dosound's ch1 block / process_ch2, tick 0."""
    b0, b1, _ = cell(c)
    if b0 >= LAST_NOTE:                       # jr nc, .do_setvolN: a rest writes nothing here
        return
    if (b1 & 0x0F) != 3:                      # toneporta keeps the old period
        period[c] = NOTE_TABLE[b0]
    iid = b1 >> 4
    if iid == 0:
        highmask[c] &= 0x7F
    else:
        ins = duty[iid - 1]
        if c == 0:
            out.append((0, W_SWEEP, ins["sweep"]))
        out.append((c, W_LEN_ENV, ins["len_duty"] | (ins["env"] << 8)))
        highmask[c] = ins["highmask"]
    out.append((c, W_NOTE, (period[c] & 0xFF) | ((highmask[c] | (period[c] >> 8)) << 8)))


def wave_channel():
    """process_ch3, tick 0."""
    global current_wave
    b0, b1, _ = cell(2)
    if b0 >= LAST_NOTE:
        return
    if (b1 & 0x0F) != 3:
        period[2] = NOTE_TABLE[b0]
    iid = b1 >> 4
    if iid == 0:
        highmask[2] &= 0x7F
    else:
        ins = wave[iid - 1]
        out.append((2, W_LEN_ENV, ins["length"] | (ins["volume"] << 8)))   # NR31, NR32
        if ins["waveform"] != current_wave:                                # cp [hl]
            current_wave = ins["waveform"]
            out.append((2, W_WAVE, ins["waveform"]))
        highmask[2] = ins["highmask"]
    out.append((2, W_NOTE, (period[2] & 0xFF) | ((highmask[2] | (period[2] >> 8)) << 8)))


def noise_channel():
    """process_ch4, tick 0."""
    b0, b1, _ = cell(3)
    if b0 >= LAST_NOTE:
        return
    period[3] = note_poly(b0)
    iid = b1 >> 4
    if iid == 0:
        highmask[3] &= 0x7F                   # and the period keeps NO step width
    else:
        ins = noise[iid - 1]
        out.append((3, W_LEN_ENV, (ins["highmask"] & 0x3F) | (ins["env"] << 8)))  # NR41, NR42
        period[3] |= swap(ins["highmask"] & 0x80)                                  # step_width4
        highmask[3] = (ins["highmask"] & 0x40) | 0x80
    out.append((3, W_NOTE, (period[3] & 0xFF) | (highmask[3] << 8)))              # NR43, NR44


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


# ---- run GB's 64 Hz ticks through the GBA frame clock, and diff ------------------------
trace = [tuple(int(x) for x in line.split()[1:])
         for line in open(trace_txt) if line.startswith("T ")]
predicted = []
acc, frame, total_ticks = 0, takeover_frame, 0
while len(predicted) < len(trace):
    acc += 280896 * 64
    while acc >= 16777216 and len(predicted) < len(trace):
        acc -= 16777216
        if tick == 0:
            out.clear()
            r, o = row, order
            duty_channel(0)
            duty_channel(1)
            wave_channel()
            noise_channel()
            predicted += [(frame, total_ticks, o, r, c, w, v) for c, w, v in out]
        tick_time()
        total_ticks += 1
    frame += 1

predicted = predicted[:len(trace)]
mismatches = [(i, p, t) for i, (p, t) in enumerate(zip(predicted, trace)) if p != t]
kinds = {}
for _f, _t, _o, _r, c, w, _v in trace:
    kinds[(c, w)] = kinds.get((c, w), 0) + 1
print(f"song: ticks_per_row={ticks_per_row} orders={order_count}")
print(f"compared {len(trace)} writes (frame, tick, order, row, channel, what, value)")
print("  by channel/what: " + ", ".join(f"ch{c + 1}:{w}={n}" for (c, w), n in sorted(kinds.items())))
if mismatches:
    print(f"MISMATCHES: {len(mismatches)}")
    for i, p, t in mismatches[:10]:
        print(f"  #{i}: predicted {p}  got {t}")
    sys.exit(1)
print("ALL MATCH")
