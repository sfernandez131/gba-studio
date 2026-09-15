# Dump the hUGE player's verification trace from a probed build (see README.md, step 4).
#
# Start mGBA with its GDB stub on the probed ROM (`mGBA.exe -g <rom>`), then from the
# directory the trace should land in:
#   arm-none-eabi-gdb -batch -x dump-trace.gdb <rom>.elf
# It walks 560 frames (about 600 ticks at 64 Hz; the stub costs ~56 ms a frame, so ~35 s)
# and writes trace.bin - huge_trace_n 12-byte records, as reference.py reads them. The
# buffer holds 4096 writes; a busy song fills it before 560 frames, which is fine - the
# reference compares whatever was captured.
set pagination off
set confirm off
target remote localhost:2345
break hw_render
ignore 1 560
continue
echo \n@N\n
print huge_trace_n
dump binary memory trace.bin &huge_trace[0] &huge_trace[huge_trace_n]
echo \n@READBACK\n
x/16xb &huge_wave_readback
quit
