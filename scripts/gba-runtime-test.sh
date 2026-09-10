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
#   2. sets background palette 0, sprite palette 0, and the UI palette (M12c/d;
#      these run while the scene is still fading in, so they double as the
#      commit-under-fade check),
#   3. launches a projectile RIGHT (angle 64) then DOWN (angle 128),
#   4. swaps the player spritesheet,
#   5. attaches a script to B + SELECT with "override default button action", then
#      removes it from SELECT alone (matrix slice C),
#   6. sets the Npc's animation tick + frame, reads the frame back over a marker, and
#      stops the Npc's update script while stopping AND restarting the Watcher's
#      (matrix slice D; both actors' update scripts increment a counter variable),
#   7. jumps the camera to tile (10, 6), walks it to (12, 6) at 1px/frame, then Camera
#      Locks it back onto the player (matrix slice E),
#   8. opens a two-option Choice (options=3: LAST_0|CANCEL_B, count=2),
#   9. opens a six-item Menu (count=6).
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
  -ex "break hw_load_palette" \
  -ex "continue" \
  -ex "echo \n@PAL_BG\n" -ex "info registers r0 r1" \
  -ex "continue" \
  -ex "echo \n@PAL_SPRITE\n" -ex "info registers r0 r1" \
  -ex "continue" \
  -ex "echo \n@PAL_UI\n" -ex "info registers r0 r1" \
  -ex "delete" \
  -ex "break hw_projectile_launch" \
  -ex "continue" \
  -ex "echo \n@LAUNCH1\n" -ex "info registers r3" \
  -ex "continue" \
  -ex "echo \n@LAUNCH2\n" -ex "info registers r3" \
  -ex "delete" \
  -ex "break hw_actor_set_anim_tick" \
  -ex "continue" \
  -ex "echo \n@ANIMTICK\n" -ex "info registers r0 r1" \
  -ex "delete" \
  -ex "break hw_actor_set_anim_frame" \
  -ex "continue" \
  -ex "echo \n@ANIMFRAME\n" -ex "x/2hu \$r0" \
  -ex "delete" \
  -ex "break hw_camera_set_pos" \
  -ex "continue" \
  -ex "echo \n@CAMSET\n" -ex "x/2hu \$r0" \
  -ex "delete" \
  -ex "break hw_camera_move_step" \
  -ex "continue" \
  -ex "echo \n@CAMMOVE\n" -ex "info registers r1 r2" \
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
  -ex "ignore 9 8" \
  -ex "continue" \
  -ex "echo \n@VARS\n" \
  -ex "print script_memory[0]" \
  -ex "print script_memory[1]" \
  -ex "echo \n@PLATFORM\n" \
  -ex "print/d plat_grav" \
  -ex "print/d plat_jump_vel" \
  -ex "print/d plat_max_fall_vel" \
  -ex "print/d plat_climb_vel" \
  -ex "print/d plat_coyote_frames" \
  -ex "print/d plat_extra_jumps" \
  -ex "echo \n@SHMUP\n" \
  -ex "print/d shooter_scroll_speed" \
  -ex "echo \n@INPUT\n" \
  -ex "print/x vm_input_slots[5]" \
  -ex "print/x vm_input_slots[6]" \
  -ex "print/d vm_input_events[3].pc != 0" \
  -ex "echo \n@GETFRAME\n" -ex "print script_memory[3]" \
  -ex "echo \n@NPC1\n" -ex "print script_memory[4]" \
  -ex "echo \n@WATCH1\n" -ex "print script_memory[5]" \
  -ex "ignore 9 60" \
  -ex "continue" \
  -ex "echo \n@NPC2\n" -ex "print script_memory[4]" \
  -ex "echo \n@WATCH2\n" -ex "print script_memory[5]" \
  -ex "echo \n@CAMLOCKX\n" -ex "print/d gba_camera_lock_x" \
  -ex "echo \n@CAMLOCKY\n" -ex "print/d gba_camera_lock_y" \
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

# Palette loads (M12c/d): mask (r0) + options (r1) per fixture event, in order -
# Set Background Palette slot 0 (mask 1, COMMIT|BKG = 3), Set Sprite Palette
# slot 0 (mask 1, COMMIT|SPRITE = 5), Set UI Palette (mask 128, COMMIT|BKG = 3).
val_after "@PAL_BG" "^r0" | grep -q " 1$" || fail "bg palette mask != 1"
val_after "@PAL_BG" "^r1" | grep -q " 3$" || fail "bg palette options != 3"
val_after "@PAL_SPRITE" "^r0" | grep -q " 1$" || fail "sprite palette mask != 1"
val_after "@PAL_SPRITE" "^r1" | grep -q " 5$" || fail "sprite palette options != 5"
val_after "@PAL_UI" "^r0" | grep -q " 128$" || fail "ui palette mask != 128"
val_after "@PAL_UI" "^r1" | grep -q " 3$" || fail "ui palette options != 3"

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

# Platform physics tunables (M13b-d): the plat_* engine-field globals must link
# with GB's engine.json defaults - a rename/drop/mis-default silently breaks
# every PLATFORM project. Values are the exported globals (dispatch reads them).
# gdb prints these as "$N = <value>"; match on the trailing value.
val_after "@PLATFORM" '= 1792$'  | grep -q "= 1792$"  || fail "plat_grav != 1792"
val_after "@PLATFORM" '= 16384$' | grep -q "= 16384$" || fail "plat_jump_vel != 16384"
val_after "@PLATFORM" '= 20000$' | grep -q "= 20000$" || fail "plat_max_fall_vel != 20000"
val_after "@PLATFORM" '= 4000$'  | grep -q "= 4000$"  || fail "plat_climb_vel != 4000"
val_after "@PLATFORM" '= 2$'     | grep -q "= 2$"     || fail "plat_coyote_frames != 2"

# SHMUP auto-scroll speed (M13f): the shooter_scroll_speed engine field must
# link with GB's default (32 GB-subpx/frame = 2px/frame).
val_after "@SHMUP" '= 32$' | grep -q "= 32$" || fail "shooter_scroll_speed != 32"

# Input attach (matrix slice C). The fixture attaches a script to B + SELECT with
# "override default button action", then removes it from SELECT alone:
#   - B is KEY_BITS 0x20 (bit 5) and SELECT 0x40 (bit 6); the slot is derived from
#     the mask's highest set bit over a 10-bit pad (the GBA has L/R at bits 8/9),
#     so 0x60 -> slot 4, stored with .OVERRIDE_DEFAULT as 0x84.
#   - the detach must clear SELECT's bit and leave B's alone.
#   - slot 4's script pointer (vm_input_events[3]) must be linked, not null.
# Keys cannot be injected over the GDB stub, so the press itself is verified by hand
# (temporarily forcing hw_input_held); what CI guards is that the attach wiring
# survives - a broken slot derivation or a dropped ptr relocation shows up here.
val_after "@INPUT" '= 0x84$' | grep -q "= 0x84$" || fail "B input slot != 0x84 (slot 4 | OVERRIDE_DEFAULT)"
val_after "@INPUT" '= 0x0$'  | grep -q "= 0x0$"  || fail "SELECT input slot not cleared by the detach"
val_after "@INPUT" '= 1$'    | grep -q "= 1$"    || fail "attached script pointer is null"

# Actor animation control (matrix slice D). The fixture's Npc (runtime actor 1) gets its
# animation tick set, then frame 1 written and read straight back; both placed actors carry
# a per-frame update script that increments a counter.
#
# Set Animation Speed passes GB's anim_tick MASK through unchanged (15 = advance every 16
# frames), and the frame op carries GB's {ID, FRAME} pseudo-struct - r0 points at it, so the
# two halfwords are the actor index and the requested frame.
val_after "@ANIMTICK" "^r0" | grep -q " 1$"  || fail "set_anim_tick actor != 1"
val_after "@ANIMTICK" "^r1" | grep -q " 15$" || fail "set_anim_tick mask != 15"
val_after "@ANIMFRAME" "^0x" | grep -qE "1[[:space:]]+1$" || fail "set_anim_frame block != {1, 1}"

# The read-back must be 0, not 1: the Npc's idle animation is a single frame, so GB's
# `FRAME % (frame_end - frame_start)` folds it back. The slot held 99 immediately before,
# so reading 0 proves the get actually wrote rather than the op being skipped.
val_after "@GETFRAME" '^\$' | grep -q "= 0$" || fail "get_anim_frame did not overwrite the marker with 0"

# Update-script control. The Npc was stopped and left stopped, so its counter must be
# frozen at 0 across a 60-frame walk; the Watcher was stopped and RESTARTED, so its counter
# must be climbing. Running both is what separates BEGIN_UPDATE actually restarting a dead
# thread from the thread simply never having been stopped.
npc1=$(val_after "@NPC1" '^\$' | sed 's/.*= //')
npc2=$(val_after "@NPC2" '^\$' | sed 's/.*= //')
watch1=$(val_after "@WATCH1" '^\$' | sed 's/.*= //')
watch2=$(val_after "@WATCH2" '^\$' | sed 's/.*= //')
[ "$npc1" = "0" ] && [ "$npc2" = "0" ] || fail "terminated update script still ran (npc $npc1 -> $npc2)"
[ -n "$watch1" ] && [ -n "$watch2" ] && [ "$watch2" -gt "$watch1" ] \
  || fail "restarted update script is not advancing (watcher $watch1 -> $watch2)"

# Camera control (matrix slice E). The coordinate contract between the editor and the
# engine is the part most likely to break silently, so it is asserted at the boundary:
# Camera Move To (tiles 10, 6) with speed 0 compiles to VM_CAMERA_SET_POS, and the {X, Y}
# block r0 points at must read 5120, 3840 - the editor's 32-per-pixel subpixels with GB's
# +80px / +72px half-screen offset already folded in (10*256 + 80*32, 6*256 + 72*32).
val_after "@CAMSET" "^0x" | grep -qE "5120[[:space:]]+3840$" || fail "camera set_pos block != {5120, 3840} subpx"

# The following Camera Move To runs at speed 1 px/frame = 32 subpx (r1), and the event
# always passes .CAMERA_UNLOCK (r2 = 0); locking back is the Camera Lock event's job.
val_after "@CAMMOVE" "^r1" | grep -q " 32$" || fail "camera move speed != 32 subpx/frame"
val_after "@CAMMOVE" "^r2" | grep -q " 0$"  || fail "camera move after_lock != .CAMERA_UNLOCK"

# ...and Camera Lock is what exercises the after_lock != 0 branch: once its move lands,
# both axes must be following the player again. Without this the restore path is dead code.
val_after "@CAMLOCKX" '^\$' | grep -q "= 1$" || fail "camera X axis did not re-lock to the player"
val_after "@CAMLOCKY" '^\$' | grep -q "= 1$" || fail "camera Y axis did not re-lock to the player"

echo "RUNTIME TESTS PASSED (overlay cover, palettes, projectiles, choice, menu, result vars, platform + shmup tunables, input attach, actor animation control, camera control)"
