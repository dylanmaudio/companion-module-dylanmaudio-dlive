# dLive MIDI Bridge (dylanmaudio)

Control an Allen & Heath dLive **and see what it is doing**: mutes,
fader levels, names, colours and the current scene come back from the
desk and drive feedbacks, variables and self-labelling presets.

## What this module is

This module controls an Allen & Heath dLive **through the dLive MIDI
Bridge application**. The bridge owns the connection to the console;
this module attaches to it as a named lane, alongside anything else you
have connected — a DAW, Console Control, other apps — all sharing one
console connection and one MIDI monitor that attributes every message
to the app that sent it.

**It does not connect to a console directly.** You need the MIDI Bridge
app (v1.1 or later) running and connected to your desk. Console address,
base MIDI channel and reconnect behaviour are configured **in the
bridge**, and this module inherits them.

## Setup

1. In the MIDI Bridge app, connect to your console and confirm it is
   online.
2. On the console: **Utility → Control → MIDI**, mode **On** (not
   Secure), Global MIDI Send and Receive enabled.
3. In this connection, set the bridge address — `127.0.0.1` when
   Companion runs on the same machine as the bridge. The token is only
   needed if the bridge is exposing its API over the LAN.

## Connection settings

| Setting | Notes |
|---|---|
| MIDI Bridge address / port / token | Where the bridge is. 127.0.0.1 : 8765 when it runs beside Companion |
| Console firmware | Not detectable over MIDI; shown in `$(dlive:firmware)` |
| Inputs in use / extended types | Bounds the variable grid and the preset library |
| Scene Go / Next / Previous | The CC number + value you assigned on the console. 0/0 = not assigned |
| Console Actions map | `cc,value,Name` per line. Optional when a firmware 2.1x show file is loaded — Actions import automatically; manual lines win on the same CC/value |
| Show file | Loaded on the connection's own **show file page**, not here — see below |
| Show file path (advanced) | Only useful when the file sits somewhere this sandboxed module can read. An uploaded show wins over it |
| Scene names (manual) | `scene,Name` per line; overrides the show file |
| Show send levels in dB | Off by default: the send-level ↔ dB mapping is not yet calibrated |
| Preamp gain range | Sources disagree; pick what matches your screen |

### Status colours

Green means **the bridge is reachable *and* reports its console link is
up** — not merely that the bridge answered. If the bridge is running but
the desk is not connected you get:

> MIDI Bridge is running but its console link is down — check the bridge app

and if the bridge itself is not reachable, the status stays amber with
the address it is waiting on. Fix console-side problems (MIDI mode Off
or Secure, Global MIDI Receive disabled, wrong address) in the bridge,
not here.

## Loading a show file

Scene names exist only in the show file — there is no way to ask the console
for them over MIDI — and firmware ~2.1x shows also carry the named Actions
table. Both are loaded from the connection's own page:

> `http://<your-companion>:8000/instance/<connection label>/`

The link is on the connection settings page, next to **Show file**. Choose a
dLive show — the `.tar.gz` the console writes to USB, or a Director export —
and the page reports how many scene names and Actions came out of it.

The file is read in the browser and only the **scene names** and the
**Actions table** are kept, in this connection's settings. The show itself is
not stored, and nothing leaves the computer. It survives restarts, so the
show file does not have to stay on the Companion machine — which matters,
since Companion runs modules sandboxed to their own folder and usually
*cannot* read a path you type in.

Anything typed into **Scene names (manual)** or **Console Actions map** still
wins over the loaded show, so a wrong or out-of-date entry can be corrected
without re-exporting anything.

## How feedback works

- **Mutes and scene recalls** are pushed by the desk the moment they
  change — no polling, sub-50 ms.
- **Faders**: the desk only announces *which* fader moved. The module
  asks for the level once the movement settles (one query per gesture).
- **Names and colours** are read on connect and whenever a strip is
  renamed on the surface.
- **Sends, assigns, preamps, HPF**: not announced by the desk, and the
  bridge's state mirror does not yet carry them. Feedbacks for these
  reflect changes *this module* makes, and will not follow changes made
  on the surface or by another controller. They are listed in
  `$(dlive:unsupported_gets)` so the limitation is visible.
- Anything the module sets itself is mirrored immediately, so buttons
  update even if the desk does not echo.

## Actions

Mute · Fader (dB, ±dB, raw, all with optional timed fade) · Send level ·
Main / DCA / mute-group / mix assign · Preamp gain / pad / 48 V · PEQ
band · HPF · Set name / colour · Scene recall · Scene Go / Next /
Previous · Cue-list recall · Console Action (named, from the map) ·
Surface CC · UFX key / scale · Refresh strip · Resync · Reload show file.

Channel numbers accept expressions, so `$(custom:channel)` in the Number
field works for "selected channel" layouts.

Fades are dB-linear and only send when the value changes (a 3 s fade is
~60 messages, not 600).

## Feedbacks

Mute · Fader level (value, text, above-threshold) · Channel colour
(button takes the desk colour) · Channel name · Main / DCA / mute-group /
mix assigned · Send level · HPF on · Preamp pad / 48 V / gain · Current
scene is… · Console is answering.

## Variables

Per strip: `name_ch12`, `colour_ch12`, `mute_ch12`, `fader_ch12` (dB
text), `fader_lv_ch12` (0–127). Type prefixes: `ch` inputs, `grp`/`stgrp`
groups, `aux`/`staux`, `mtx`/`stmtx`, `fxsnd`/`stfxsnd`/`fxrtn`, `main`,
`dca`, `mgrp`, `ufxsnd`/`ufxrtn`.

Global: `scene_current`, `scene_current_name`, `scene_name_<n>`,
`connected`, `firmware`, `base_channel`, plus diagnostics
`gets_in_flight`, `gets_missed`, `unsupported_gets`.

## Presets

Template groups per channel type — mute buttons that take the strip's
name and colour and go red when muted; level buttons showing the dB
value with ±1 dB nudges; scene recall buttons that light when current;
GO / Next / Previous; named Console Actions; a status button.

## Limitations (protocol, not the module)

- **No metering.** Meters live on A&H's proprietary network protocol, not
  MIDI.
- **No scene names over MIDI** — hence the show-file import.
- **SoftKeys cannot be triggered by MIDI**; use a console Action instead.
- **Preamps are addressed by socket**, not channel; the patch is not
  readable.
- **Send levels** are raw 0–127 until the dB mapping is calibrated on
  hardware.
- Some "Get" queries (preamp, mix assign) are extrapolated from the
  documented pattern. If the desk ignores one, the module notices (no
  reply), pauses that query type for a minute and lists it in
  `$(dlive:unsupported_gets)` — it never marks the connection failed for it.

## Troubleshooting

- **Stays "Connecting"**: the bridge is not running, or the address/port
  is wrong. Check the bridge app is open and note its API port.
- **"console link is down"**: the bridge is fine, the desk is not — fix
  it in the bridge (address, MIDI mode Off/Secure, Global MIDI Receive).
- **Wrong strip moves**: base MIDI channel mismatch — set it in the
  bridge; this module reads it from there.
- Tick *Log every decoded event* in the settings and watch the Companion
  log to see exactly what the desk is sending.
