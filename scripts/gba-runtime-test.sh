#!/bin/bash
# GBA runtime tests (quality program part 2b).
#
# Boots the built gba_actor_test ROM headlessly under mGBA's GDB stub and asserts
# engine behavior with gdb-multiarch - the automated form of the manual GDB-stub
# verification recipe (see the project's toolchain notes). Everything asserted here
# is symbol-stable: function-entry registers (AAPCS r0-r3) and the exported
# script_memory global; anonymous-namespace statics are avoided (LTO can strip
# their symbols).
#
# The fixture script under test (examples/gba_actor_test, main scene init):
#   1. shows a full-screen BLACK overlay cover, then hides it (M11d box colors),
#   2. launches a projectile RIGHT (angle 64) then DOWN (angle 128),
#   3. swaps the player spritesheet,
#   4. opens a two-option Choice (options=3: LAST_0|CANCEL_B, count=2),
#   5. opens a six-item Menu (count=6).
# Selections are forced with GDB `return` (no key injection over the stub); the
# results must land in script_memory[0] and [1].
#
# Usage: gba-runtime-test.sh <rom.gba> <gbavm.elf>
set -euo pipefail

ROM="$1"
ELF="$2"
LOG=runtime-test.log

# mGBA headless: SDL dummy drivers need no display/audio device on the runner.
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy mgba -g "$ROM" &
MGBA_PID=$!
trap 'kill $MGBA_PID 2>/dev/null || true' EXIT
sleep 3

gdb-multiarch -batch \
  -ex "set pagination off" \
  -ex "set confirm off" \
  -ex "target remote localhost:2345" \
  -ex "break hw_overlay_show" \
  -ex "continue" \
  -ex "echo \n@OVERLAY\n" -ex "info registers r0 r1 r2 r3" \
  -ex "delete" \
  -ex "break hw_projectile_launch" \
  -ex "continue" \
  -ex "echo \n@LAUNCH1\n" -ex "info registers r3" \
  -ex "continue" \
  -ex "echo \n@LAUNCH2\n" -ex "info registers r3" \
  -ex "delete" \
  -ex "break hw_choice_step" \
  -ex "continue" \
  -ex "echo \n@CHOICE\n" -ex "info registers r0 r1" \
  -ex "continue" \
  -ex "return (int)1" \
  -ex "continue" \
  -ex "continue" \
  -ex "echo \n@MENU\n" -ex "info registers r0 r1" \
  -ex "return (int)2" \
  -ex "delete" \
  -ex "break hw_render" \
  -ex "ignore 4 8" \
  -ex "continue" \
  -ex "echo \n@VARS\n" \
  -ex "print script_memory[0]" \
  -ex "print script_memory[1]" \
  -ex "quit" \
  "$ELF" > "$LOG" 2>&1 || true

kill $MGBA_PID 2>/dev/null || true
trap - EXIT

echo "--- gdb session log ---"
cat "$LOG"
echo "-----------------------"

# One assert per behavior; awk pulls the first register/value line after each marker.
val_after() { awk "/$1/{found=1;next} found && /$2/{print; exit}" "$LOG"; }

fail() { echo "RUNTIME TEST FAILED: $1"; exit 1; }

# Overlay cover (M11d): x (r0) = 0, y (r1) = 0, color (r2) = 0 (.UI_COLOR_BLACK),
# options (r3) = 0 (no frame).
val_after "@OVERLAY" "^r2" | grep -q " 0$" || fail "overlay show color != 0 (black)"
val_after "@OVERLAY" "^r3" | grep -q " 0$" || fail "overlay show options != 0 (no frame)"

# Projectile launches: angle (r3) 64 = right, then 128 = down.
val_after "@LAUNCH1" "^r3" | grep -q " 64$"  || fail "launch 1 angle != 64 (right)"
val_after "@LAUNCH2" "^r3" | grep -q " 128$" || fail "launch 2 angle != 128 (down)"

# Choice: options (r0) = 3 (.UI_MENU_LAST_0 | .UI_MENU_CANCEL_B), count (r1) = 2.
val_after "@CHOICE" "^r0" | grep -q " 3$" || fail "choice options != 3"
val_after "@CHOICE" "^r1" | grep -q " 2$" || fail "choice count != 2"

# Menu: count (r1) = 6.
val_after "@MENU" "^r1" | grep -q " 6$" || fail "menu count != 6"

# Forced selections landed in the result variables.
val_after "@VARS" '^\$1' | grep -q "= 1$" || fail "choice result var != 1"
val_after "@VARS" '^\$2' | grep -q "= 2$" || fail "menu result var != 2"

echo "RUNTIME TESTS PASSED (overlay cover, projectiles, choice, menu, result vars)"
