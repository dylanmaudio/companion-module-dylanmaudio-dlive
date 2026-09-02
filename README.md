# companion-module-dylanmaudio-dlive

Bitfocus Companion module for the **dLive MIDI Bridge** application —
control an Allen & Heath dLive with full **state feedback**: mutes,
fader levels, names, colours and the current scene come back off the
desk and drive feedbacks, variables and self-labelling presets. MIT.

**This module does not connect to a console directly.** It attaches to
the MIDI Bridge app (v1.1+) as a named lane over the Client API; the
bridge owns the console connection, the state mirror, query-on-ping,
timed fades and the base channel, and every app sharing that bridge —
a DAW, Console Control, this module — appears attributed in one MIDI
monitor.

Companion 5.0+ (`@companion-module/base` 2.1). See
[companion/HELP.md](companion/HELP.md) for the user-facing guide.

## Layout

```
docs/protocol.md        the protocol as implemented, every byte, with a verification tier
fixtures/tx.json        golden byte fixtures — the AUTHORITY for the codec (module → console)
fixtures/rx.json                                                        (console → module)
fixtures/author.py      regenerates the two JSON files from the byte templates
src/protocol/           channels (addressing), intents, encode, decode, levels (measured dB table)
src/state/              ConsoleState (the mirror), SubscriptionRegistry, QueryScheduler
src/link-api.ts         LinkApi — the seam the Companion layer talks to
src/bridge/             BridgeLink — the shipping path: a MIDI Bridge Client API v1 lane
fixtures/api/           Client API exchange fixtures (authored bridge-side, vendored here)
src/transport/          test harness only: ConsoleTransport, TcpTransport, FakeTransport
src/link.ts             test harness only: ConsoleLink — codec + state + scheduler + probe + fades
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

## Direct mode is a test harness, not a feature

`ConsoleLink` and `TcpTransport` implement the console protocol over TCP
directly. **They are not reachable from the connection settings and are
not a user-facing path.** They exist so the protocol layer can be
verified end to end against the Virtual dLive without a console
(`src/e2e.test.ts`), and so real hardware captures can be taken and
replayed. `transport` remains in the config *type*, defaulted to
`bridge`; only the tests set it to `direct`.

## Status

v0.1 — bridge mode, full action set, state feedback (mutes, faders,
names, colours, scene) driven by the bridge's mirror, timed fades via
the bridge's `fade` op, show-file scene names and named Actions import,
template presets.

Known limits: the bridge's API v1 mirror carries no paths for the param
family (assigns, HPF, preamp, sends), so those feedbacks track only this
module's own changes — `$(dlive:unsupported_gets)` says so at runtime.
Byte layouts marked `two-impl` / `single` / `inferred` in
`docs/protocol.md` await the September 2026 hardware captures.

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
