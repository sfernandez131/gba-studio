# Golden ROM (GB non-regression byte-parity)

`gbs2-upstream-a18666b45.gb` is the stock `appData/templates/gbs2` project built to a
GB ROM by **pure upstream GB Studio** (chrismaltby/gb-studio) at the fork's merge-base
commit `a18666b4593ca89814e14aecf30e00b7a8d90010` (an ancestor of `develop`), built on
**Linux** by the `Golden ROM` workflow (`.github/workflows/golden-rom.yml`, run
29333435848; sha256 `2dc99d5a072514cb5fecc28f111705c1cdf8af236fee22c14efe893aceb1e307`).

**The golden MUST be Linux-built**: GBDK's SDCC binaries emit different code per host
OS (a Windows-built ROM of the same commit differs in ~29k bytes), and the per-PR
check runs on Linux. Local Windows fork-vs-upstream comparison passes the same way
(6 differing bytes) when both sides are built on Windows — parity holds per-OS.

The `gb-non-regression` CI job builds the same project with the fork's compiler on
every PR and asserts byte-identity against this file via `scripts/gb-rom-parity.py`.
This is the mechanized form of the superset promise: the fork's GB output IS
upstream's output.

Two spots are allowed to differ because they are nondeterministic even between two
runs of the same compiler (verified 2026-07-13):

- `0x14E-0x14F` — the cartridge header's global checksum;
- one 4-byte run — `save_signature`, a hash of `JSON.stringify(projectData)` that
  varies run-to-run (upstream behaves identically).

Everything else must match exactly. A parity failure means a fork change altered GB
output — either an unintended GB regression (fix it) or, if genuinely intended, a
reason to regenerate this golden and explain why in the PR.

## Regenerating

Needed only when the fork is rebased onto a newer upstream (new merge-base):

1. `git merge-base develop upstream/develop` → the new merge-base SHA.
2. Run the `Golden ROM` workflow (Actions → Golden ROM → Run workflow) with that SHA.
3. Download the artifact, commit it here as `gbs2-upstream-<short-sha>.gb`, delete the
   old one, update this README and the path in `gba-ci.yml`.
