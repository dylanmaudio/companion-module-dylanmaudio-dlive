# companion-module-dylanmaudio-dlive

Bitfocus Companion module for the Allen & Heath dLive — the one with
**state feedback**: mutes, fader levels, names, colours and the current
scene come back off the desk and drive feedbacks, variables and
self-labelling presets. MIT.

Companion 5.0+ (`@companion-module/base` 2.1). See
[companion/HELP.md](companion/HELP.md) for the user-facing guide.

## Layout

```
docs/protocol.md        the protocol as implemented, every byte, with a verification tier
fixtures/tx.json        golden byte fixtures — the AUTHORITY for the codec (module → console)
fixtures/rx.json                                                        (console → module)
fixtures/author.py      regenerates the two JSON files from the byte templates
fixtures/showfiles/     a firmware-template show file for the show-file parser test
src/protocol/           channels (addressing), intents, encode, decode, levels (measured dB table)
src/state/              ConsoleState (the mirror), SubscriptionRegistry, QueryScheduler
src/transport/          ConsoleTransport interface; TcpTransport (direct mode); FakeTransport (tests)
src/link.ts             ConsoleLink — decoder + state + scheduler + probe + fades, no Companion API
src/fades.ts            dB-linear emit-on-change ramps
src/showfile/           dLive show-file reader (scene names, quick names, base channel)
src/{config,actions,feedbacks,variables,presets,main}.ts   the Companion layer
src/e2e.test.ts         real module + fake Companion host + real TCP to the Virtual dLive
```

The same fixtures are vendored into the dLive Utility Apps monorepo,
where the Python side (MIDI Bridge / Virtual dLive) must pass them too.
When a hardware capture contradicts a fixture, fix the fixture (with the
capture attached) and both implementations follow.

## Develop

```bash
corepack yarn install
corepack yarn test          # unit + fixtures (+ e2e when the Virtual dLive is present)
corepack yarn build
corepack yarn lint
corepack yarn package       # → pkg/ .tgz for Companion's "Import module package"
```

Hardware-free end-to-end: `src/e2e.test.ts` spawns
`python3 -m sim.virtual_console` from `~/Documents/GitHub/dLive Utility Apps`
(override with `DLIVE_SIM_ROOT`) and drives the real module against it.

## Status

v0.1 — direct mode (two TCP sockets), full action set, hybrid state
engine (push / query-on-ping / bounded background poll), honest liveness
probe, fades, show-file scene names, template presets. Byte layouts
marked `two-impl` / `single` / `inferred` in `docs/protocol.md` await the
September 2026 hardware captures. Bridge mode (MIDI Bridge as the single
console socket) is the transport interface's second implementation —
not in v0.1.

## Credits and prior art

The dLive wire protocol is published by Allen & Heath (*MIDI Over TCP/IP
Protocol V2.0*), and two MIT-licensed Companion modules got there first.
This module is an independent implementation — different architecture,
built around a state mirror the others do not have — but several
byte-level value maps were derived from their work and are gratefully
credited:

- **`companion-module-allenheath-dlive`** (Tim Steer, MIT) — the EQ width
  ↔ value table, the EQ and HPF frequency curves, the PEQ per-band
  parameter numbers, the preamp socket offsets and gain mapping, and the
  DCA / mute-group assign value encoding.
- **`companion-module-allenheath-dlive-ilive`** (Andrew Broughton, Shaun
  Davids and contributors, MIT) — corroboration of the send-level and
  mix-assign SysEx shapes, and the alternative preamp gain range that the
  "Preamp gain range" setting exists to reconcile.

Both are MIT; their notices travel with the derived values, and
`docs/protocol.md` records which claims rest on one implementation, two,
or verified hardware.
