"""Independent reference for the hUGE player's verification trace.

Parses the exporter's C for a song, applies hUGEDriver's rules (read from hUGEDriver.asm,
NOT from gbavm's huge_player.cpp), runs GB Studio's 64 Hz tick schedule through the GBA
frame clock, and predicts every Game Boy register write the driver makes: frame, tick,
order, row, register, value. Then diffs the prediction against the trace captured on the
GBA.

The model is a Game Boy's sound registers: the driver writes bytes to NR10..NR51, and where
it reads one back (vol slide, set volume, the CH3 routing mute) it gets the last byte
written with the write-only bits reading as 1. Two pseudo-registers stand for events that
are not one byte: 0x30 a wave loaded into wave RAM (value = wave index), and 0x40 a "call
routine" (value = channel << 8 | param).

Covers: tick 0 on all four channels (M14b, M14c1) and all 16 effects on every tick (M14c2).
Not yet: subpattern tables (M14c3) - the reference and the player both skip do_table, so a
song with tables still diffs cleanly, it just is not the whole song.

What this independently checks: DN() decoding, instruments, the note table, the noise
polynomial, wave switching, each effect's arithmetic and timing, row/order advance, breaks
and jumps, and the tick accumulator. What it cannot check: whether I read the driver's rules
right - both implementations share that reading. That is what an ears-on listen is for.

Two things are GBA-side decisions, not driver rules, and both implementations make them the
same way: a note past the end of the note table plays the top note (the GB would read
whatever ROM follows the table), and an out-of-range break row, jump order, or wave index
is held in range (the GB would read past the pattern, order table, or waves).

usage: reference.py <song.gba.c> <trace.bin> <first-write frame>
"""
import re
import struct
import sys

song_c, trace_bin, takeover_frame = sys.argv[1], sys.argv[2], int(sys.argv[3])

LAST_NOTE = 72
NO_WAVE = 100
PATTERN_LENGTH = 64
TRACE_WAVE, TRACE_ROUTINE = 0x30, 0x40

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

# hardware.inc names, as addresses' low bytes.
rAUD1SWEEP, rAUD1LEN, rAUD1ENV, rAUD1LOW, rAUD1HIGH = 0x10, 0x11, 0x12, 0x13, 0x14
rAUD2LEN, rAUD2ENV, rAUD2LOW, rAUD2HIGH = 0x16, 0x17, 0x18, 0x19
rAUD3ENA, rAUD3LEN, rAUD3LEVEL, rAUD3LOW, rAUD3HIGH = 0x1A, 0x1B, 0x1C, 0x1D, 0x1E
rAUD4LEN, rAUD4ENV, rAUD4POLY, rAUD4GO = 0x20, 0x21, 0x22, 0x23
rAUDVOL, rAUDTERM = 0x24, 0x25

# What a DMG returns for the bits of each register it cannot read (read = written | mask).
READ_MASK = {0x10: 0x80, 0x11: 0x3F, 0x12: 0x00, 0x13: 0xFF, 0x14: 0xBF,
             0x16: 0x3F, 0x17: 0x00, 0x18: 0xFF, 0x19: 0xBF,
             0x1A: 0x7F, 0x1B: 0xFF, 0x1C: 0x9F, 0x1D: 0xFF, 0x1E: 0xBF,
             0x20: 0xFF, 0x21: 0x00, 0x22: 0x00, 0x23: 0xBF,
             0x24: 0x00, 0x25: 0x00}


def swap(v):
    """The Z80 SWAP: exchange nibbles (only equal to *16 for values below 16)."""
    return ((v << 4) | (v >> 4)) & 0xFF


def get_note_poly(a):
    """get_note_poly, step by step in 8-bit arithmetic."""
    a = (a + 192) & 0xFF             # add 192
    a = (~a) & 0xFF                  # cpl
    if a < 7:                        # cp 7 / ret c
        return a
    h = a
    l = ((a >> 2) - 1) & 0xFF        # srl / srl / dec
    a = ((h & 3) + 4) & 0xFF         # and 3 / add 4
    return (a | swap(l)) & 0xFF      # swap l / or l


def get_note_period(a):
    return NOTE_TABLE[min(a, LAST_NOTE - 1)]   # past the table: GBA-side decision (see top)


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

tempo = int(re.search(r"_Data = \{\s*(\d+),", text).group(1))
order_cnt = int(re.search(r"order_cnt = (\d+);", text).group(1))   # in words, as the GB keeps it

# ---- driver state (hUGEDriver.asm's WRAM block) ----------------------------------------
nr = {r: 0 for r in READ_MASK}
nr[rAUDVOL], nr[rAUDTERM] = 0x77, 0xFF       # as GB Studio's sound init leaves them
ticks_per_row = tempo
current_wave = NO_WAVE
mute_channels = 0
counter = tick = row_break = next_order = row = current_order = 0   # current_order in words
step_width4 = 0
channel_period = [0, 0, 0, 0]
toneporta_target = [0, 0, 0, 0]
channel_note = [0, 0, 0, 0]
highmask = [0, 0, 0, 0]
out = []   # (reg, value) writes for the current tick
fx_rows = {}   # effect code -> rows it ran on, for the coverage line


def ldh(reg, value):
    nr[reg] = value & 0xFF
    out.append((reg, value & 0xFF))


def ldh_read(reg):
    return nr[reg] | READ_MASK[reg]


def get_current_row(c):
    return patterns[orders[c + 1][current_order // 2]][row]


def retMute(c):
    return (mute_channels >> c) & 1


def update_ch3_waveform(a):
    global current_wave
    current_wave = a
    offset = min(swap(a), 240)                  # past the 16 waves: GBA-side decision
    saved = ldh_read(rAUDTERM)
    ldh(rAUDTERM, saved & 0b10111011)
    ldh(rAUD3ENA, 0)
    out.append((TRACE_WAVE, a))                 # FOR OFS, 16 / ldh [_AUD3WAVERAM + OFS]
    ldh(rAUD3ENA, 0b10000000)
    ldh(rAUDTERM, saved)


def play_chN_note(b):
    if retMute(b):
        return
    if b == 0 or b == 1:
        ldh(rAUD1LOW if b == 0 else rAUD2LOW, channel_period[b] & 0xFF)
        ldh(rAUD1HIGH if b == 0 else rAUD2HIGH, highmask[b] | (channel_period[b] >> 8))
    elif b == 2:
        saved = ldh_read(rAUDTERM)
        ldh(rAUDTERM, saved & 0b10111011)
        ldh(rAUD3ENA, 0)
        ldh(rAUD3ENA, 0xFF)                     # xor a / cpl
        ldh(rAUD3LOW, channel_period[2] & 0xFF)
        ldh(rAUD3HIGH, highmask[2] | (channel_period[2] >> 8))
        ldh(rAUDTERM, saved)
    else:
        ldh(rAUD4POLY, channel_period[3] & 0xFF)
        ldh(rAUD4GO, highmask[3])


def update_channel_freq(b, de, h=0):
    """update_channel_freq (.nonzero_highmask when h is given). CH4 treats E as a note."""
    if retMute(b):
        return
    if b < 3:
        channel_period[b] = de & 0xFFFF
        ldh(rAUD1LOW + 5 * b, de & 0xFF)
        ldh(rAUD1HIGH + 5 * b, ((de >> 8) | h) & 0xFF)
    else:
        ldh(rAUD4POLY, get_note_poly(de & 0xFF) | step_width4)
        ldh(rAUD4GO, h)


def mute_bit_clear(b):
    """The `add -2 / adc 3 / add a / daa / rra` channel-to-bit trick, then `cpl / and d`."""
    return not ((mute_channels >> b) & 1)


# ---- the effects, each as the asm does it ----------------------------------------------
def do_effect(b_fx, c, e, zf):
    """Returns False for ret_dont_play_note."""
    global ticks_per_row, row_break, next_order
    if (b_fx & 0x0F) | c == 0:
        return True
    code = b_fx & 0x0F
    a = tick
    b = e
    if zf:
        fx_rows[code] = fx_rows.get(code, 0) + 1

    if code == 0x0:                                     # fx_arpeggio: nop
        d = channel_note[b]
        a = (counter - 1) & 0xFF
        while a >= 3:
            a -= 3
        if a == 0:
            a = ((c & 0x0F) + d) & 0xFF                 # .set_arp1
        elif a == 1:
            a = ((swap(c) & 0x0F) + d) & 0xFF           # .set_arp2
        else:
            a = d                                       # .reset_arp
        update_channel_freq(b, get_note_period(a))
    elif code == 0x1:                                   # fx_porta_up: ret z
        if not zf:
            update_channel_freq(b, (channel_period[b] + c) & 0xFFFF)
    elif code == 0x2:                                   # fx_porta_down: ret z
        if not zf:
            update_channel_freq(b, (channel_period[b] - c) & 0xFFFF)
    elif code == 0x3:                                   # fx_toneporta
        if zf:                                          # .setup
            toneporta_target[b] = get_note_period(channel_note[b])
            return False                                # ret_dont_play_note
        de, hl = channel_period[b], toneporta_target[b]
        if (hl >> 8) < (de >> 8) or ((hl >> 8) == (de >> 8) and (hl & 0xFF) < (de & 0xFF)):
            de = (de - c) & 0xFFFF                      # .subtract
            if de & 0x8000 or de < hl:
                de = hl
        elif hl != de:
            de = (de + c) & 0xFFFF                      # .add
            if hl < de:
                de = hl
        channel_period[b] = de
        h = highmask[b]
        highmask[b] &= 0x7F
        update_channel_freq(b, de, h)
    elif code == 0x4:                                   # fx_vibrato: ret z
        if not zf:
            hl = get_note_period(channel_note[b])
            if counter & (c >> 4) == 0:
                hl = (hl + (c & 0x0F)) & 0xFFFF         # .go_up
            update_channel_freq(b, hl)
    elif code == 0x5:                                   # fx_set_master_volume: ret nz
        if zf:
            ldh(rAUDVOL, c)
    elif code == 0x6:                                   # fx_call_routine: nop
        out.append((TRACE_ROUTINE, (b << 8) | c))
    elif code == 0x7:                                   # fx_note_delay
        if zf:
            return False
        if a == c:
            play_chN_note(b)
    elif code == 0x8:                                   # fx_set_pan: ret nz
        if zf:
            ldh(rAUDTERM, c)
    elif code == 0x9:                                   # fx_set_duty: ret nz
        if zf and not retMute(b):
            if b == 0:
                ldh(rAUD1LEN, c)
            elif b == 1:
                ldh(rAUD2LEN, c)
            elif b == 3:
                ldh(rAUD4POLY, (ldh_read(rAUD4POLY) & ~0x08 & 0xFF) | c)
            else:
                update_ch3_waveform(c)
                play_chN_note(2)
    elif code == 0xA:                                   # fx_vol_slide: ret nz
        if zf and mute_bit_clear(b):
            d, e_up = c & 0x0F, swap(c & 0xF0)
            reg = rAUD1ENV + 5 * b
            a = swap(ldh_read(reg) & 0xF0)
            a = 0 if a < d else a - d
            a += e_up
            if a >= 0x10:
                a = 0x0F
            ldh(reg, swap(a))
            ldh(reg + 2, ldh_read(reg + 2) | 0x80)
            play_chN_note(b)
    elif code == 0xB:                                   # fx_pos_jump: ret nz
        if zf:
            if row_break == 0:
                row_break = 1
            next_order = c
    elif code == 0xC:                                   # fx_set_volume: ret nz
        if zf and not retMute(b):
            c = swap(c)
            if b < 2:
                reg = rAUD1ENV + 5 * b
                ldh(reg, (ldh_read(reg) & 0x0F) | c)
                play_chN_note(b)
            elif b == 2:
                if c >= 10 << 4:
                    a = 0b00100000
                elif c >= 5 << 4:
                    a = 0b01000000
                elif c == 0:
                    a = 0
                else:
                    a = 0b01100000
                ldh(rAUD3LEVEL, a)
            else:
                ldh(rAUD4ENV, c)
                play_chN_note(3)
    elif code == 0xD:                                   # fx_pattern_break: ret nz
        if zf:
            row_break = c
    elif code == 0xE:                                   # fx_note_cut: cp c / ret nz
        if a == c and mute_bit_clear(b):
            ldh(rAUD1ENV + 5 * b, 0)
            if b != 2:
                ldh(rAUD1HIGH + 5 * b, 0xFF)
    else:                                               # fx_set_speed: ret nz
        if zf:
            ticks_per_row = c
    return True


# ---- hUGE_dosound -----------------------------------------------------------------------
def tick_zero_channel(ch):
    global current_wave, step_width4
    a, b_fx, c = get_current_row(ch)
    carry = a < LAST_NOTE                               # cp LAST_NOTE / push af
    if carry:
        channel_note[ch] = a
        if ch == 3:
            channel_period[3] = (channel_period[3] & 0xFF00) | get_note_poly(a)
        elif (b_fx & 0x0F) != 3:                        # cp 3: toneporta keeps the old period
            channel_period[ch] = NOTE_TABLE[a]
        iid = b_fx >> 4                                 # setup_instrument_pointer
        if iid == 0:
            highmask[ch] &= 0x7F                        # jr z, .write_maskN
        elif not retMute(ch):                           # checkMute N, .do_setvolN
            if ch < 2:
                ins = duty[iid - 1]
                if ch == 0:
                    ldh(rAUD1SWEEP, ins["sweep"])
                else:
                    pass                                # `inc hl`: CH2 skips the sweep byte
                ldh(rAUD1LEN + 5 * ch, ins["len_duty"])
                ldh(rAUD1ENV + 5 * ch, ins["env"])
                highmask[ch] = ins["highmask"]
            elif ch == 2:
                ins = wave[iid - 1]
                ldh(rAUD3LEN, ins["length"])
                ldh(rAUD3LEVEL, ins["volume"])
                if ins["waveform"] != current_wave:     # cp [hl]
                    update_ch3_waveform(ins["waveform"])
                highmask[2] = ins["highmask"]
            else:
                ins = noise[iid - 1]
                ldh(rAUD4ENV, ins["env"])
                ldh(rAUD4LEN, ins["highmask"] & 0b00111111)
                step_width4 = swap(ins["highmask"] & 0b10000000)
                channel_period[3] = (channel_period[3] & 0xFF00) | ((channel_period[3] & 0xFF) | step_width4)
                highmask[3] = (ins["highmask"] & 0b01000000) | 0b10000000
    if not do_effect(b_fx, c, ch, True):                # .do_setvolN
        carry = False
    if carry:
        play_chN_note(ch)                               # call c, play_chN_note


def process_effects():
    for ch in range(4):
        if retMute(ch):                                 # checkMute N, .after_effectN
            continue
        _a, b_fx, c = get_current_row(ch)
        if c == 0:                                      # ld a, c / or a / jr z
            continue
        do_effect(b_fx, c, ch, False)


def tick_time():
    global counter, tick, row_break, next_order, row, current_order
    counter = (counter + 1) & 0xFF
    tick = (tick + 1) & 0xFF
    if (ticks_per_row - tick) & 0xFF:
        return
    tick = 0
    if row_break:
        b = row_break - 1
        if b >= PATTERN_LENGTH:
            b = 0                                       # GBA-side decision (see top)
        row_break = 0
        if next_order:
            a = ((next_order - 1) * 2) & 0xFF
            if a >= order_cnt:
                a = 0                                   # GBA-side decision (see top)
            next_order = 0
        else:
            a = current_order + 2                       # .neworder
            if a == order_cnt:
                a = 0
    else:
        a = row + 1
        if a != PATTERN_LENGTH:
            row = a
            return
        b = 0
        a = current_order + 2
        if a == order_cnt:
            a = 0
    current_order = a
    row = b


def dosound():
    out.clear()
    if tick == 0:
        for ch in range(4):
            tick_zero_channel(ch)
    else:
        process_effects()
    return list(out)


# ---- run GB's 64 Hz ticks through the GBA frame clock, and diff ------------------------
raw = open(trace_bin, "rb").read()
trace = [(f, t, o, r, reg, v) for f, t, o, r, reg, _p, v, _p2 in struct.iter_unpack("<HHBBBBHH", raw)]

predicted = []
acc, frame, total_ticks = 0, takeover_frame, 0
while len(predicted) < len(trace):
    acc += 280896 * 64
    while acc >= 16777216 and len(predicted) < len(trace):
        acc -= 16777216
        o, r = current_order // 2, row
        predicted += [(frame, total_ticks, o, r, reg, v) for reg, v in dosound()]
        tick_time()
        total_ticks += 1
    frame += 1

predicted = predicted[:len(trace)]
mismatches = [(i, p, t) for i, (p, t) in enumerate(zip(predicted, trace)) if p != t]

last = trace[-1] if trace else (0, 0, 0, 0, 0, 0)
orders_seen = sorted({t[2] for t in trace})
kinds = {}
for f, t, o, r, reg, v in trace:
    kinds[reg] = kinds.get(reg, 0) + 1
print(f"song: tempo={tempo} orders={order_cnt // 2}")
print(f"compared {len(trace)} writes (frame, tick, order, row, register, value) over "
      f"{last[1] + 1} ticks; orders reached: {orders_seen}")
print("  effects, by rows run: " + (", ".join(f"{c:X}={n}" for c, n in sorted(fx_rows.items())) or "none"))
print("  by register: " + ", ".join(f"{reg:02X}={n}" for reg, n in sorted(kinds.items())))
if mismatches:
    print(f"MISMATCHES: {len(mismatches)}")
    for i, p, t in mismatches[:12]:
        print(f"  #{i}: predicted {p}  got {t}")
    sys.exit(1)
print("ALL MATCH")
