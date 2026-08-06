# M8e — C++/Butano escape-hatch event: design (2026-08-06)

Design-first per the roadmap ("M8e: design-heavy; scope first"). M8e adds a
**GBA-only "Run Custom Code (C++)" event**: an author writes a snippet of C++ that
is emitted verbatim into the generated engine and run, on demand, from a bridged
VM op. It's the ultimate escape hatch — direct access to Butano (`bn::*`) and the
engine's hardware bridge (`hw_*`) for effects the event library doesn't cover
(custom HDMA, sound, sprite tricks, math).

This is powerful and **inherently non-portable + trusted-author** — the snippet is
compiled straight into the ROM, so it can break the build or misbehave. The design
below constrains it to a documented surface and marks projects that use it clearly.

## Goals / non-goals

- **Goal**: let advanced authors do GBA-specific things the event library can't,
  without forking the engine. Read/write script variables, call Butano + the
  `hw_*` bridge, run per-frame via an actor On-Update script.
- **Non-goal**: a sandbox or a safe plugin system. The author is trusted (it's
  their ROM). No isolation; a bad snippet fails the build or crashes the ROM.
- **Non-goal (v1)**: cross-snippet state, includes management, or a curated API
  wrapper. v1 exposes the raw engine surface with documented helpers.

## The GBA side today (facts this builds on)

- The eject already writes generated engine sources (`gba_scene_assets.h`,
  `gba_program.c`, …) into `GBAVM_ROOT/src` and `make:gba` compiles them.
- The eject builds a `dataSymbols: Record<string, number>` map that the bridge
  (`parseGbvmAsm`) uses to resolve `_<symbol>` operands to indices — the same
  path emotes / projectiles / spritesheets use (`ejectGbaBuild.ts` sets
  `dataSymbols['_<sym>'] = idx`; `linkGbaProgram` feeds it to `parseGbvmAsm`).
- The C/C++ boundary is already crossed by `hw_*` handlers: VM (`vm.c`, C) calls
  `extern "C"` functions defined in `hw.cpp` (C++), which may use Butano freely.
- Platform gating: `settings.platform === "gba"` gates GBA-only editor UI, and a
  scriptBuilder helper that early-returns on non-GBA keeps GB output byte-identical
  (the M8d affine-event pattern).

## Architecture

```
Editor event  ──compile──▶  VM_USER_CODE _gba_user_<eventId>   (scriptBuilder)
                                     │
Eject (walkScenesScripts) collects   │  bridge: VM_USER_CODE -> op 0x9B [i16 idx],
{eventId -> code}, assigns idx,       │  resolving _gba_user_<eventId> via dataSymbols
sets dataSymbols[_gba_user_<id>]=idx  ▼
       └─ generates src/gba_user_code.h:
            void gba_user_0() { <verbatim code> }   ...
            inline void gba_user_run(int i){ switch(i){ case 0: gba_user_0(); ... } }

Engine:  vm.c  case 0x9B: hw_user_code(A_I16(0));
         hw.cpp  extern "C" void hw_user_code(int i){ gba_user_run(i); }   // includes gba_user_code.h
```

- **Op**: `0x9B VM_USER_CODE [i16 idx]`. The operand is the user-function index
  (an immediate; the eject assigns it). `hw_user_code(idx)` (extern "C", in
  `hw.cpp`) dispatches into the generated `gba_user_run`.
- **Generated file `src/gba_user_code.h`**: one `void gba_user_<n>()` per Custom
  Code event (body = the verbatim snippet) + a `gba_user_run(int)` switch.
  **Committed baseline** = no snippets → `gba_user_run` is an empty switch (the
  loader/dispatch compiles to a no-op; matches the M8d affine-creator baseline
  approach so `make` stays green with the stock baseline).
- **Symbol resolution**: the scriptBuilder emits `VM_USER_CODE _gba_user_<eventId>`
  (event UUID sanitized to a C identifier). The eject sets
  `dataSymbols['_gba_user_<eventId>'] = idx`; the bridge resolves it. Order is
  safe: the eject computes `dataSymbols` before `parseGbvmAsm` runs (same as
  emotes).

## API surface (what a snippet may touch)

v1 exposes the raw engine surface with documented helpers emitted at the top of
`gba_user_code.h`:

- **Script variables** (the primary, verified surface): a snippet reads/writes
  variables by a helper. `script_memory` is `extern "C"` from `vm.c`; the header
  provides `#define GBA_VAR(idx) (script_memory[idx])` (16-bit). v1 uses the raw
  runtime index; **M8e-b** will let the editor substitute `$VariableName$` tokens
  in the snippet with the resolved index for readability.
- **Butano**: full `bn::*` is in scope (the header is compiled inside `hw.cpp`).
- **Engine bridge**: the `hw_*` functions (declared in `hw.h`) are callable.
- **No** access to VM internals (the thread scheduler, PC) — snippets are leaf
  calls, not re-entrant into the VM.

## Safety / non-portability

- **GBA-only**: the event is `platform: "gba"`-gated (hidden in GB projects via
  the AddScriptEventMenu filter), and the scriptBuilder helper early-returns on
  non-GBA so a stray event never emits into a GB build (byte-identical GB output).
- **Build failure is the safety net**: an invalid snippet is a C++ compile error
  in `gba_user_code.h`, surfaced by `make:gba`. Documented; not silent.
- **Trusted-author, non-portable**: no sandbox. The editor shows a warning on the
  event ("Custom C++ runs with full engine access; GBA-only; may break the build")
  and, ideally, a project-level "uses custom code → not upstream-portable" note.
- **Upstream-merge (M16)**: custom-code projects are inherently fork-specific;
  the feature itself stays a clean additive backend (new op + new generated file),
  not a modification of shared GB codegen.

## Slice plan

| Slice | Scope | Verify |
| ----- | ----- | ------ |
| **M8e-a** | Plumbing: op `0x9B` + `hw_user_code` + baseline `gba_user_code.h`; editor "Run Custom Code" event (code textarea, GBA-gated) + bridge + eject collection/generation; raw `GBA_VAR(idx)` access. | Fixture snippet `GBA_VAR(2) = 123;`; GDB asserts `script_memory[2] == 123` after the event runs. Engine PR first (new generated-code shape). |
| **M8e-b** | Variable-name tokens: editor substitutes `$VarName$` in the snippet with the resolved runtime index; a variable-reference field on the event so referenced vars are allocated. | GDB: a snippet writing `$Score$` updates the right slot. |
| **M8e-c** | Curated helpers + docs: a small documented API header (`gba_user_api.h`) wrapping common ops (actor pos, input, sfx) so snippets don't reach raw internals; the editor warning + project non-portable marker. | Fixture exercises a helper; docs page. |

## Verification

Per the roadmap row: build a fixture using the event; GDB assert the hook ran (a
variable write). M8e-a's fixture writes a distinctive value to a variable from the
snippet; the GDB stub reads `script_memory[idx]` and confirms it — proving the
verbatim C++ compiled, linked, dispatched via op `0x9B`, and executed.

## Risks

1. **Arbitrary C++ breaks the build.** Mitigated: it's the author's ROM, the error
   is a normal compiler diagnostic, and the event carries a warning. A CI project
   that uses the event will fail the build if the snippet is bad — so the fixture
   snippet must stay valid (and minimal).
2. **Op-index vs snippet mismatch.** The eject keys both the generated function and
   `dataSymbols` on the event UUID, so they can't drift (same pattern as emotes).
3. **Baseline drift.** The committed `gba_user_code.h` must be an empty-dispatch
   stub so the stock engine builds standalone (hand-restore before committing, like
   the other generated baselines).
4. **Scope creep into a plugin system.** Explicitly out of scope; v1 is a trusted
   escape hatch, not a safe extension API.
