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
#   8. runs a Print (GB Printer) event, which must take its printer-missing path, and an
#      "If Device GBA" check, which must take its true path (matrix slice F),
#   9. opens a two-option Choice (options=3: LAST_0|CANCEL_B, count=2),
#  10. opens a six-item Menu (count=6),
#  11. arms a timer that, 160 frames later, enters the PLATFORM scene, whose init attaches
#      platformer state scripts and sets the KNOCKBACK state (gbs2 G3). It is a timer, not
#      a Wait, because a scene init runs under VM_LOCK: waiting there would stall every
#      other thread through the checks above.
#  12. still in the PLATFORM init, after the KNOCKBACK request: arms a 16-frame timer that
#      counts its runs, stores the player's position, opens a Choice that the test holds
#      for 41 frames, and stores the position again. The init holds the VM lock
#      throughout, so the player must not move (no knockback, no gravity) and the timer
#      must not count down until the init ends.
#  13. Last in that init, arms timer 2, which 160 frames later puts the player on the
#      Hazard, an actor in collision group 1, and leaves it there (gbs2 G3b).
# Throughout, the main scene plays a .uge track on the hUGE player (M14d), whose "call
# routine" effects run scripts attached with the Music Routine event (M14e); and it plays
# an FX Hammer sound effect on the Game Boy channels, borrowing one from the song (M14f).
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

# A run that misses a breakpoint would wait on it forever; the timeout turns that into a
# log with markers missing, which the asserts below then report.
timeout 300 gdb-multiarch -batch \
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
  -ex "echo \n@HUGE1\n" -ex "print huge_ticks" \
  -ex "ignore 9 60" \
  -ex "continue" \
  -ex "echo \n@NPC2\n" -ex "print script_memory[4]" \
  -ex "echo \n@WATCH2\n" -ex "print script_memory[5]" \
  -ex "echo \n@HUGE2\n" -ex "print huge_ticks" \
  -ex "echo \n@ROUTINE1\n" -ex "print script_memory[8]" \
  -ex "echo \n@ROUTINE3\n" -ex "print script_memory[9]" \
  -ex "echo \n@ROUTINE2\n" -ex "print script_memory[12]" \
  -ex "echo \n@ROUTINE2PC\n" -ex "print/d vm_music_events[2].pc != 0" \
  -ex "echo \n@SFXDONE\n" -ex "print/d psg_sfx_done" \
  -ex "echo \n@SFXTICKS\n" -ex "print/d psg_sfx_ticks" \
  -ex "echo \n@PRINTPATH\n" -ex "print script_memory[6]" \
  -ex "echo \n@ISGBA\n" -ex "print script_memory[7]" \
  -ex "echo \n@CAMLOCKX\n" -ex "print/d gba_camera_lock_x" \
  -ex "echo \n@CAMLOCKY\n" -ex "print/d gba_camera_lock_y" \
  -ex "delete" \
  -ex "break hw_choice_step" \
  -ex "continue" \
  -ex "echo \n@LOCKCHOICE\n" -ex "info registers r1" \
  -ex "ignore 10 40" \
  -ex "continue" \
  -ex "return (int)1" \
  -ex "delete" \
  -ex "break *plat_callback_execute if \$r0 == 12" \
  -ex "continue" \
  -ex "echo \n@KBENTER\n" \
  -ex "print/d plat_state" \
  -ex "print/d plat_vel_x" \
  -ex "print/d plat_vel_y" \
  -ex "print/d plat_knockback_timer" \
  -ex "echo \n@LOCKPROBE\n" \
  -ex "print script_memory[18]" \
  -ex "print script_memory[19]" \
  -ex "print script_memory[20]" \
  -ex "print script_memory[21]" \
  -ex "print script_memory[22]" \
  -ex "print script_memory[23]" \
  -ex "delete" \
  -ex "break hw_render" \
  -ex "continue" \
  -ex "echo \n@PLATSTEP\n" \
  -ex "print/d gba_plat_step_x" \
  -ex "print/d gba_plat_step_y" \
  -ex "ignore 12 119" \
  -ex "continue" \
  -ex "echo \n@TIMERAFTER\n" -ex "print script_memory[23]" \
  -ex "echo \n@PLATSEQ\n" \
  -ex "print script_memory[13]" \
  -ex "print script_memory[14]" \
  -ex "print script_memory[15]" \
  -ex "print script_memory[16]" \
  -ex "print script_memory[17]" \
  -ex "echo \n@PLATEND\n" \
  -ex "print/d plat_state" \
  -ex "print/d plat_knockback_timer" \
  -ex "print/d vm_plat_events[12].pc != 0" \
  -ex "delete" \
  -ex "break hw_render if player_iframes == 20" \
  -ex "continue" \
  -ex "echo \n@HIT1\n" \
  -ex "print script_memory[24]" \
  -ex "print script_memory[25]" \
  -ex "print/d player_iframes" \
  -ex "delete" \
  -ex "break hw_render" \
  -ex "ignore 14 18" \
  -ex "continue" \
  -ex "echo \n@HIT2\n" \
  -ex "print script_memory[24]" \
  -ex "print script_memory[25]" \
  -ex "print/d player_iframes" \
  -ex "ignore 14 1" \
  -ex "continue" \
  -ex "echo \n@HIT3\n" \
  -ex "print script_memory[24]" \
  -ex "print script_memory[25]" \
  -ex "print/d player_iframes" \
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
# link with GB's default (32 subpx/frame = 1px/frame).
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

# GB Printer + device check (matrix slice F). Neither is really about an opcode: both were
# failing on an ENGINE-SYMBOL READ, because VM_GET_*INT8 only accepted _joypads and threw
# for anything else. The Print codegen reads _is_CGB before it does anything, and "If
# Device GBA" reads _is_GBA, so both died on the read rather than on the feature.
#
# The GBA has no Game Boy Printer, and GB Studio's own codegen already handles that case:
# it detects, tests the status against the error mask, and branches. VM_PRINTER_DETECT now
# reports what a missing printer reports (0xF0), so the event must take its FALSE path -
# variable 6 lands on 42. A 99 would mean the game had been told a print succeeded.
val_after "@PRINTPATH" '^\$' | grep -q "= 42$" || fail "Print event did not take the printer-missing path"

# ...and _is_GBA must read 1, or every "If Device GBA" branch silently inverts.
val_after "@ISGBA" '^\$' | grep -q "= 1$" || fail "If Device GBA took the false path (_is_GBA != 1)"

# .uge music (M14d). The scene starts a .uge track, which the eject compiles into the
# engine and VM_MUSIC_PLAY routes to the hUGE player. Between @HUGE1 and @HUGE2 is exactly
# 61 frames (both stops are on hw_render, and `ignore 9 60` skips 60 then stops on the
# 61st). At GB Studio's 64 Hz that is 61 * 64 / 59.7275 = 65.4 driver ticks - 65 or 66 by
# accumulator phase - where ticking once per frame would give 61. So this proves the track
# is playing AND at the right speed.
HUGE1=$(val_after "@HUGE1" '^\$' | sed 's/.*= //')
HUGE2=$(val_after "@HUGE2" '^\$' | sed 's/.*= //')
[ -n "$HUGE1" ] && [ -n "$HUGE2" ] || fail "could not read huge_ticks (is the .uge track playing?)"
[ "$HUGE1" -gt 0 ] || fail ".uge track not playing (huge_ticks = $HUGE1)"
HUGE_DELTA=$(( HUGE2 - HUGE1 ))
[ "$HUGE_DELTA" -eq 65 ] || [ "$HUGE_DELTA" -eq 66 ] || fail ".uge track ticked $HUGE_DELTA times in 61 frames, expected 65-66 (64 Hz)"

# Music routines (M14e). The fixture song (scripts/huge/make-routines-fixture.ts) raises
# routine effects 0x21 twice and 0x13 twice in its first 15 rows, plus two on slot 0, which
# has no script. The scene attaches counting scripts to routines 1, 3 and 2. gbvm runs slot
# `param & 3`, so 0x21 must count on slot 1 and 0x13 on slot 3 - once or twice each, since
# events raised while a choice/menu locks the VM wait in a 4-entry queue. Slot 2 has a script
# attached but is never raised; a count there would mean the slot came from the high nibble.
ROUTINE1=$(val_after "@ROUTINE1" '^\$' | sed 's/.*= //')
ROUTINE3=$(val_after "@ROUTINE3" '^\$' | sed 's/.*= //')
[ "${ROUTINE1:-0}" -ge 1 ] && [ "${ROUTINE1:-0}" -le 2 ] || fail "music routine 1 ran ${ROUTINE1:-?} times, expected 1-2"
[ "${ROUTINE3:-0}" -ge 1 ] && [ "${ROUTINE3:-0}" -le 2 ] || fail "music routine 3 ran ${ROUTINE3:-?} times, expected 1-2"
val_after "@ROUTINE2PC" '^\$' | grep -q "= 1$" || fail "music routine 2 has no script attached (VM_MUSIC_ROUTINE not bridged?)"
val_after "@ROUTINE2" '^\$' | grep -q "= 0$" || fail "music routine 2 ran, but nothing raises it (slot taken from the wrong nibble?)"

# PSG sound effects (M14f). Right after the music starts, the scene plays FX Hammer effect 3
# of the gbs2 sample's Tronimal_Sound_Effects.sav, on gbavm's port of gbvm's sfx_player. An
# effect's length is fixed by its data - effect 3 is 57 ticks of gbvm's 256 Hz sound clock
# - so the effect must have played to its end, exactly once, in exactly 57 ticks. Ticking
# per frame, or at the music's 64 Hz, or misreading the stream, all change that number.
val_after "@SFXDONE" '^\$' | grep -q "= 1$" || fail "the FX Hammer effect did not play to its end exactly once"
val_after "@SFXTICKS" '^\$' | grep -q "= 57$" || fail "the FX Hammer effect ran $(val_after "@SFXTICKS" '^\$' | sed 's/.*= //') ticks, expected 57 (256 Hz)"

# VM lock. gbvm skips the scene type's state update - the player's control and physics -
# and the timer tick while a script holds the VM lock. The PLATFORM init holds it while
# the test keeps its Choice open for 41 frames, right after the init asked for KNOCKBACK,
# so the knockback must wait for the init to end: @LOCKPROBE is read on the first frame
# after it, as the knockback starts. The build packs the used variables in id order, so
# vars 25-30 sit at script_memory[18..23]. The player's position before the Choice
# ([18], [19]) must still be the spawn tile (30, 29) in pixels after it ([21], [22]) -
# the stores also bracket the Choice box sliding in and out - and the forced selection
# lands in [20].
#
# The timer armed just before the Choice counts its runs in [23]. No thread but the init
# runs under the lock, so a countdown that kept going would show as runs queued behind
# the init, which then all run on that first frame; a paused one has not fired yet. It
# must be firing 121 frames later, though, or that zero would only mean it is broken.
LOCK=$(awk '/@LOCKPROBE/{f=1;next} f && /^\$/{sub(/.*= /,""); printf "%s ", $0; if(++n==6) exit}' "$LOG")
[ -n "$LOCK" ] || fail "lock probe not reached (did the knockback start while the Choice held the VM lock?)"
read -r X0 Y0 CHOSEN X1 Y1 TIMER_RUNS <<< "$LOCK"
[ "$CHOSEN" = "1" ] || fail "lock probe Choice result = $CHOSEN, expected the forced 1"
[ "$X0 $Y0" = "240 232" ] || fail "player not at its spawn (240, 232 px) before the Choice: ($X0, $Y0)"
[ "$X1 $Y1" = "$X0 $Y0" ] || fail "the player moved from ($X0, $Y0) to ($X1, $Y1) px while a Choice held the VM lock"
[ "$TIMER_RUNS" = "0" ] || fail "the timer ran $TIMER_RUNS times as the lock was released: its countdown kept going under the lock"
TIMER_AFTER=$(val_after "@TIMERAFTER" '^\$' | sed 's/.*= //')
[ "${TIMER_AFTER:-0}" -ge 1 ] || fail "the 16-frame timer never fired after the lock was released (count ${TIMER_AFTER:-?})"

# Platformer states and their scripts (gbs2 G3). After the menu, the main scene enters the
# PLATFORM scene facing left, whose init attaches scripts to four state slots and sets the
# state to KNOCKBACK. Each script counts itself into variable 20 (script_memory[13]) and
# keeps its place in the order: knockback start [14], end [15], blank start [16], end [17].
# They chain as gbs2's do: knockback's end sets BLANK, and blank's start waits 10 frames and
# sets GROUND. Entering knockback (slot 12 = PLATFORM_KNOCKBACK_INIT) launches the player
# away from its facing with GB's engine.json defaults, before the slot's script is started.
val_after "@KBENTER" '^\$' | grep -q "= 6$" || fail "plat_state != 6 (KNOCKBACK) on entering knockback"
KB_VX=$(awk '/@KBENTER/{f=1;next} f && /^\$/{n++; if(n==2){print; exit}}' "$LOG" | sed 's/.*= //')
KB_VY=$(awk '/@KBENTER/{f=1;next} f && /^\$/{n++; if(n==3){print; exit}}' "$LOG" | sed 's/.*= //')
KB_T=$(awk '/@KBENTER/{f=1;next} f && /^\$/{n++; if(n==4){print; exit}}' "$LOG" | sed 's/.*= //')
[ "$KB_VX" = "8192" ] || fail "knockback plat_vel_x = $KB_VX, expected 8192 (facing left -> pushed right)"
[ "$KB_VY" = "-16384" ] || fail "knockback plat_vel_y = $KB_VY, expected -16384"
[ "$KB_T" = "30" ] || fail "plat_knockback_timer = $KB_T, expected 30"
# Platformer speed: that frame's step is gbvm's VEL_TO_SUBPX of the velocity after air
# deceleration and gravity, (v >> 8) << 1 in 32/px subpixels - x 7984 -> 62, y -14592 ->
# -114. A step of twice that is the old 2x-speed bug.
KB_DX=$(awk '/@PLATSTEP/{f=1;next} f && /^\$/{n++; if(n==1){print; exit}}' "$LOG" | sed 's/.*= //')
KB_DY=$(awk '/@PLATSTEP/{f=1;next} f && /^\$/{n++; if(n==2){print; exit}}' "$LOG" | sed 's/.*= //')
[ "$KB_DX" = "62" ] || fail "first knockback step x = $KB_DX subpx, expected 62"
[ "$KB_DY" = "-114" ] || fail "first knockback step y = $KB_DY subpx, expected -114"
PLAT_SEQ=$(awk '/@PLATSEQ/{f=1;next} /@PLATEND/{f=0} f && /^\$/{sub(/.*= /,""); printf "%s ", $0}' "$LOG")
[ "$PLAT_SEQ" = "4 1 2 3 4 " ] || fail "state scripts ran as [count kb-start kb-end blank-start blank-end] = [$PLAT_SEQ], expected [4 1 2 3 4]"
PLAT_END=$(awk '/@PLATEND/{f=1;next} /@HIT1/{f=0} f && /^\$/{sub(/.*= /,""); printf "%s ", $0}' "$LOG")
[ "$PLAT_END" = "1 0 1 " ] || fail "after the chain [plat_state timer slot-12-attached] = [$PLAT_END], expected [1 0 1] (GROUND)"

# Player-vs-actor collision (gbs2 G3b). After the chain, a timer puts the standing player on
# the Hazard (collision group 1) and leaves it there. The hit runs two scripts: the Hazard's
# On Hit: Player tab, which counts variable 31 (script_memory[24]), and the scene's On Hit
# group 1 tab, which counts variable 32 ([25]). Each tab is a branch on the thread argument,
# so a count also proves the argument: 0 for the actor's own script, the group bit 2 for the
# scene's. The hit makes the player invincible for 20 frames, which count down while the two
# still touch. So the counts are [1 1] on the frame after the hit (invincibility 20) and on
# the last invincible frame, 19 frames later (1), and the next hit lands right after it: two
# frames on, the counts are [2 2] and invincibility is back at 20.
hit_vals() { awk -v m="$1" '$0 ~ m {f=1; next} /@HIT/ {f=0} f && /^\$/ {sub(/.*= /,""); printf "%s ", $0}' "$LOG"; }
HIT1=$(hit_vals "@HIT1")
HIT2=$(hit_vals "@HIT2")
HIT3=$(hit_vals "@HIT3")
[ "$HIT1" = "1 1 20 " ] || fail "on the frame after the hit [actor-script scene-script iframes] = [$HIT1], expected [1 1 20]"
[ "$HIT2" = "1 1 1 " ] || fail "on the last invincible frame [actor-script scene-script iframes] = [$HIT2], expected [1 1 1]"
[ "$HIT3" = "2 2 20 " ] || fail "after the invincibility ran out [actor-script scene-script iframes] = [$HIT3], expected [2 2 20]"

echo "RUNTIME TESTS PASSED (overlay cover, palettes, projectiles, choice, menu, result vars, platform + shmup tunables, input attach, actor animation control, camera control, printer + device checks, .uge music at 64 Hz, music routines, PSG sound effects, player + timers held under the VM lock, platformer states + state scripts + speed, player-vs-actor collision)"
