"""Turn exportToC's GB-targeted C into something GCC compiles for the GBA.

Prototype of the post-process M14d will fold into the eject. Two GB-isms to strip:
  - `#pragma bank 255`            SDCC banking; meaningless on the flat GBA
  - `const void __at(255) __bank_X_Data;`   SDCC-only syntax, a hard GCC error
Everything else is plain C and compiles as-is against gbavm's hUGEDriver.h.

And one thing to add: instrument tables padded to hUGE's 15 slots. Pattern data can name
an instrument the song never defined - `dizzy.uge` (GBVM's develop example) plays wave
instrument 3 on 307 cells but defines two - and the exporter emits only the instruments
that exist, while hUGESong_t carries no counts for the player to check against. On the GB
the driver reads on past the table (by the GB layout, into the first noise instrument:
volume 0, no trigger, and a garbage subpattern pointer). On the GBA that same read is past
the end of a C array, and with subpattern tables (M14c3) a wild pointer. So the missing
slots become silent all-zero instruments: the channel stays quiet, as it does on the GB,
and nothing reads out of bounds.
"""
import re, sys

INSTRUMENT_SLOTS = 15
EMPTY = {
    "duty_instruments": "{ 0x00, 0x00, 0x00, 0, 0x00 }",
    "wave_instruments": "{ 0x00, 0x00, 0x00, 0, 0x00 }",
    "noise_instruments": "{ 0x00, 0, 0x00, 0, 0 }",
}

src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
text = re.sub(r"^#pragma bank \d+\s*\n", "", text, flags=re.M)
text = re.sub(r"^const void __at\(\d+\) __bank_\w+;\s*\n", "", text, flags=re.M)
assert "__at(" not in text and "#pragma bank" not in text

padded = []
for name, empty in EMPTY.items():
    m = re.search(rf"(static const \w+ {name}\[\] = \{{\n)(.*?)(\}};)", text, re.S)
    count = len(re.findall(r"^\s*\{", m.group(2), re.M))
    if count < INSTRUMENT_SLOTS:
        fill = "".join(f"    {empty},\n" for _ in range(INSTRUMENT_SLOTS - count))
        text = text[: m.end(2)] + fill + text[m.end(2):]
        padded.append(f"{name} {count}->{INSTRUMENT_SLOTS}")

open(dst, "w", encoding="utf-8", newline="\n").write(text)
print("ok:", dst, ("(padded " + ", ".join(padded) + ")") if padded else "")
