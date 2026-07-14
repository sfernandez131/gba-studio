#!/usr/bin/env python3
"""Golden-ROM byte-parity check (quality program, GB non-regression ledger).

Compares a fork-built GB ROM against the committed golden ROM built by pure
upstream GB Studio at the fork's merge-base. The ROMs must be byte-identical
EXCEPT for the two spots that are nondeterministic even between two runs of
the same compiler:

  - 0x014E-0x014F: the cartridge header's global checksum (a consequence of
    the signature below).
  - one 4-byte run: `save_signature`, a hash of JSON.stringify(projectData)
    that varies run-to-run upstream too. Its address is not hardcoded - if
    code layout shifted, other bytes would differ and the check fails anyway.

Usage: gb-rom-parity.py <built.gb> <golden.gb>
"""
import sys

HEADER_CHECKSUM = {0x014E, 0x014F}
SIGNATURE_BYTES = 4

built_path, golden_path = sys.argv[1], sys.argv[2]
built = open(built_path, "rb").read()
golden = open(golden_path, "rb").read()

if len(built) != len(golden):
    sys.exit(
        f"PARITY FAILED: size mismatch: built {len(built)} vs golden {len(golden)}"
    )

diffs = [i for i, (a, b) in enumerate(zip(built, golden)) if a != b]
sig = [d for d in diffs if d not in HEADER_CHECKSUM]

if len(sig) > SIGNATURE_BYTES or (sig and sig[-1] - sig[0] >= SIGNATURE_BYTES):
    preview = ", ".join(f"0x{d:05X}" for d in diffs[:16])
    sys.exit(
        f"PARITY FAILED: {len(diffs)} differing bytes (first: {preview})\n"
        f"Only the header checksum (0x14E-0x14F) and one {SIGNATURE_BYTES}-byte "
        f"save_signature run may differ."
    )

allowed = ", ".join(f"0x{d:05X}" for d in diffs)
print(
    f"PARITY OK: {len(built)} bytes, {len(diffs)} allowed diffs"
    + (f" at {allowed}" if diffs else " (bit-identical)")
)
