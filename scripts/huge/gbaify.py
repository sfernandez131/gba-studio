"""Turn exportToC's GB-targeted C into something GCC compiles for the GBA.

Prototype of the post-process M14d will fold into the eject. Three GB-isms:
  - `#pragma bank 255`            SDCC banking; meaningless on the flat GBA
  - `const void __at(255) __bank_X_Data;`   SDCC-only syntax, a hard GCC error
  - everything else is plain C and compiles as-is against gbavm's hUGEDriver.h
"""
import re, sys

src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
text = re.sub(r"^#pragma bank \d+\s*\n", "", text, flags=re.M)
text = re.sub(r"^const void __at\(\d+\) __bank_\w+;\s*\n", "", text, flags=re.M)
assert "__at(" not in text and "#pragma bank" not in text
open(dst, "w", encoding="utf-8", newline="\n").write(text)
print("ok:", dst)
