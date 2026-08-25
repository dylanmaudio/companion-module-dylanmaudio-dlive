# Allen & Heath dLive (dylanmaudio)

Control a dLive **and see what it is doing**: mutes, fader levels, names,
colours and the current scene come back from the desk and drive
feedbacks, variables and self-labelling presets.

## Console setup

On the Surface: **Utility → Control → MIDI**

- MIDI mode: **On** (not Off, not Secure — TLS is not supported yet)
- **Global MIDI Send** and **Global MIDI Receive**: enabled
- Note the **base MIDI channel** shown there (1–12). It must match the
  connection setting. Every channel type is an offset from it, so a wrong
  value moves the wrong strip.

Network: the module talks to the **MixRack** on port 51325. Only one
control connection per port is allowed from a host — if Companion sits at
"Connecting" with the desk reachable, something else (A&H MIDI Control,
a DAW bridge, another module) may already hold the socket.

## Connection settings

**Connect via** chooses the transport:

- **Direct console (TCP)** — the module opens its own sockets to the desk.
- **MIDI Bridge app (Client API v1)** — the module attaches to the dLive
  MIDI Bridge (v1.1+) as a named lane. The bridge owns the console
  connection, base channel, state mirror, query-on-ping and timed fades;
  Companion's traffic shows up attributed in the bridge's MIDI Monitor.
  Console IP and base channel are then configured in the bridge, not here.
  In bridge mode v1.1, live feedback covers mutes, faders, names, colours
  and the current scene; the param family (assigns, HPF, preamp, sends)
  updates optimistically from this module's own actions only.

| Setting | Notes |
|---|---|
| MixRack IP / port | Direct mode. Usually 192.168.1.70 : 51325 |
| MIDI Bridge address / port / token | Bridge mode. 127.0.0.1:8765 when Companion runs beside the bridge; the token is only needed once the bridge exposes its API on the LAN |
| Surface IP / port | Optional. Cue-list recall and Scene Go / Next / Previous belong to the Surface (51328). Leave blank to send them down the MixRack socket |
| Base MIDI channel | From Utility → Control → MIDI |
| Console firmware | Not detectable over MIDI; shown in `$(dlive:firmware)` |
| Sync on connect | What to read from the desk when the link comes up. "Names, colours, mutes & faders" takes a few seconds on a full desk |
| Inputs in use / extended types | Bounds the variable grid, presets and the sync |
| Scene Go / Next / Previous | The CC number + value you assigned on the console. 0/0 = not assigned |
| Console Actions map | `cc,value,Name` per line. Optional when a firmware 2.1x show file is loaded (Actions import automatically); manual lines override show-file entries on the same CC/value |
| Show file | Path to a dLive show (`.tar.gz` from the console's USB export, or an unpacked Show folder). Loads **scene names** (the MIDI protocol cannot ask for them) and, from firmware ~2.1x shows, the **named Actions MIDI table** — every Action with a MIDI Recall trigger appears in the "Recall Action" dropdown and the preset library by its console name. Verified against real console exports (firmware 1.9x–2.1x). Note: Companion sandboxes modules, so the file must currently live inside the module's own folder — an in-browser upload is planned |
| Scene names (manual) | `scene,Name` per line; overrides the show file |
| Show send levels in dB | Off by default: the send-level ↔ dB mapping is not yet calibrated |
| Preamp gain range | Sources disagree; pick what matches your screen |

### Status colours

Green means **the desk answered**, not merely that TCP connected. The
module sends *Get Name* for Input 1 and waits for that reply; it repeats
the probe every 15 s. If the console stops answering you get:

> Connected, but the console is not responding. Check Utility → Control →
> MIDI on the console: mode must be On (not Off or Secure) and Global
> MIDI Receive must be enabled.

## How feedback works

- **Mutes and scene recalls** are pushed by the desk the moment they
  change — no polling, sub-50 ms.
- **Faders**: the desk only announces *which* fader moved. The module
  asks for the level once the movement settles (one query per gesture).
- **Names and colours** are read on connect and whenever a strip is
  renamed on the surface.
- **Sends, assigns, preamps, HPF**: not announced by the desk. These are
  polled in the background — only the ones a feedback on a button is
  actually watching, one request at a time.
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

- **Stays "Connecting"**: IP/port, or another controller holds the socket.
- **Connected but "not responding"**: MIDI mode Off/Secure, Global MIDI
  Receive off, or this is the Surface address with a MixRack port.
- **Wrong strip moves**: base MIDI channel mismatch.
- Tick *Log every decoded event* in the settings and watch the Companion
  log to see exactly what the desk is sending.
