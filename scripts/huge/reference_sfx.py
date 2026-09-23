"""Independent reference for gbavm's PSG sound-effect player (M14f).

Reads one effect's stream from the C the editor compiled (any `sounds/*.c`: .vgm, FX
Hammer, or a legacy tone), applies gbvm's sfx_play_isr rules (read from
appData/engine/gbvm/src/core/sfx_player.c, NOT from gbavm's psg_sfx.cpp), runs gbvm's
256 Hz tick through the GBA frame clock, and predicts every Game Boy register write the
effect makes: frame and register and value. Then diffs that against a trace captured on
the GBA (the hUGE player's HUGE_TRACE hook logs every PSG write, whoever makes it).

Use a project with no hUGE song playing, so the trace is the effect's alone.

The GBA side decides two things here, and both implementations share them: only NR10..NR51
are written (the stream's master-register group also reaches NR52, which on the GBA would
gate DirectSound too, and the unmapped 0xFF27/28), and the 256 Hz clock runs off one
accumulator stepped once per frame from boot, so the frame a tick lands in is
floor((f + 1) * 280896 * 256 / 2^24) counting.

usage: reference_sfx.py <sound.c> <symbol> <trace.bin> <play frame>
"""
import re
import struct
import sys

sound_c, symbol, trace_bin, play_frame = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])

NR10, NR51, NR30 = 0x10, 0x25, 0x1A
UNMAPPED = {0x15, 0x1F}                 # no register there on either machine


def byte(tok):
    tok = tok.strip()
    if tok.lower().startswith("0b"):
        return int(tok[2:], 2)
    if tok.lower().startswith("0x"):
        return int(tok[2:], 16)
    return int(tok)


text = open(sound_c, encoding="utf-8").read()
m = re.search(r"const\s+(?:UINT8|uint8_t)\s+" + symbol + r"\s*\[\]\s*=\s*\{(.*?)\};", text, re.S)
body = re.sub(r"//.*", "", m.group(1))
data = [byte(t) for t in body.split(",") if t.strip()]

out = []                                # (reg, value) for the current tick
shadow = {NR51: 0xFF}


def write(reg, value):
    if reg < NR10 or reg > NR51 or reg in UNMAPPED:
        return                          # NR52 / 0xFF27-28: not written on the GBA
    shadow[reg] = value
    out.append((reg, value))


# ---- sfx_play_isr ---------------------------------------------------------------------
pos, frame_skip = 0, 0


def isr():
    """One 256 Hz tick. Returns False when the effect ends."""
    global pos, frame_skip
    if pos is None:
        return False
    if frame_skip:
        frame_skip -= 1
        return True
    header = data[pos]
    pos += 1
    frame_skip = header >> 4
    d = header & 0x0F
    while d:
        b = data[pos]
        pos += 1
        ch = b & 7
        if ch < 5:                                      # 3$: copy_reg x5
            c = NR10 + ch * 5
            for _ in range(5):
                if b & 0x80:                            # sla b / jr nc
                    write(c, data[pos])
                    pos += 1
                b = (b << 1) & 0xFF
                c += 1
        elif ch == 7:                                   # 5$: terminator
            pos = None
            return False
        else:                                           # a wave (5 load, 6 load + play)
            routing = shadow.get(NR51, 0xFF)
            write(NR51, routing & 0b10111011)
            write(NR30, 0)
            pos += 16                                   # the 16 wave bytes: not a register
            if ch == 6:
                for reg, v in ((0x1A, 0x80), (0x1B, 0xFE), (0x1C, 0x20), (0x1D, 0x00), (0x1E, 0xC7)):
                    write(reg, v)
            write(NR51, routing)
        d -= 1
    return True


# ---- the schedule -----------------------------------------------------------------------
C, S, R = 280896, 16777216, 256


def ticks_through(frame):
    """256 Hz ticks run by the end of `frame`'s update, counting from boot."""
    return (frame + 1) * C * R // S


predicted = [(play_frame, NR51, 0xFF)]                 # music_play_sfx: cut_mask(none) -> NR51
frame, ticks = play_frame, 0
done = False
while not done:
    for _ in range(ticks_through(frame) - ticks_through(frame - 1)):
        out.clear()
        alive = isr()
        predicted += [(frame, r, v) for r, v in out]
        ticks += 1
        if not alive:
            done = True
            break
    frame += 1

raw = open(trace_bin, "rb").read()
trace = [(f, reg, v) for f, _t, _o, _r, reg, _p, v, _p2 in struct.iter_unpack("<HHBBBBHH", raw)]
print(f"effect {symbol}: {len(data)} bytes, {ticks} ticks at 256 Hz, "
      f"{len(predicted)} writes predicted, {len(trace)} traced")
mismatches = [(i, p, t) for i, (p, t) in enumerate(zip(predicted, trace)) if p != t]
if len(predicted) != len(trace):
    mismatches.append((min(len(predicted), len(trace)), "count", (len(predicted), len(trace))))
if mismatches:
    print(f"MISMATCHES: {len(mismatches)}")
    for i, p, t in mismatches[:12]:
        print(f"  #{i}: predicted {p}  got {t}")
    sys.exit(1)
print(f"ALL MATCH (ticks {ticks})")
