# dLive MIDI-over-TCP — protocol spec as implemented

This is the single human-readable statement of every byte this module
sends or expects. The machine-readable authority is `fixtures/*.json`;
both the TypeScript codec in this repo and the Python codec in MIDI
Bridge must pass the same fixtures. When the two disagree, the fixture
wins; when a fixture disagrees with hardware, hardware wins and the
fixture is corrected (with the capture attached).

Sources, in order of trust:

| Tier | Meaning |
|---|---|
| `hardware` | Observed on a real dLive (11 Aug 2026 desk, base channel 1) or proven over years of shows by the Reaper Automation Pack |
| `two-impl` | Two independent implementations agree (TSteer `allenheath-dlive` v1.0.1 and Broughton `allenheath-dlive-ilive`), both derived from the A&H *MIDI Over TCP/IP Protocol V2.0* PDF |
| `single` | One implementation / the PDF only |
| `inferred` | Extrapolated from a pattern — must be captured on 4–5 Sept 2026 before it is trusted |

Firmware is undetectable over this protocol (the SysEx header carries
`01 00` on every version); the user tells us.

## 1. Transport

| Endpoint | Plain | TLS | Owns |
|---|---|---|---|
| MixRack | 51325 | 51327 | Scene recall, all parameter control, Actions, Gets |
| Surface | 51328 | 51329 | Cue-list recall, Scene Go / Next / Previous |

TLS port numbers are `single` (the PDF); one earlier note in the dLive
Utility Apps repo says 51326 — capture on the day (checklist item 11).

Both sockets are plain MIDI byte streams: no framing, no length prefix.
TCP splits packets arbitrarily — the decoder is a byte-at-a-time state
machine. A single host may hold one control connection per port
(`hardware`, observed against A&H MIDI Control on the same Mac; whether a
*second host* may also connect is open — checklist item 1).

TLS requires sending `UserProfile, UserPassword` then waiting for the six
bytes `AuthOK` before any MIDI (`single`; the exact encoding/terminator
of the credential pair is not specified and must be captured).

## 2. Addressing

`N` = base MIDI channel (0-indexed; console Utility → Control → MIDI,
shown there 1-indexed). Every channel type is `N + offset`, with a
7-bit address `CH`. Table verbatim from the V2.0 PDF p.8 (`two-impl`):

| Type | MIDI ch | CH range | Count |
|---|---|---|---|
| input | N+0 | 00–7F | 128 |
| mono_group | N+1 | 00–3D | 62 |
| stereo_group | N+1 | 40–5E | 31 |
| mono_aux | N+2 | 00–3D | 62 |
| stereo_aux | N+2 | 40–5E | 31 |
| mono_matrix | N+3 | 00–3D | 62 |
| stereo_matrix | N+3 | 40–5E | 31 |
| mono_fx_send | N+4 | 00–0F | 16 |
| stereo_fx_send | N+4 | 10–1F | 16 |
| fx_return | N+4 | 20–2F | 16 |
| main | N+4 | 30–35 | 6 |
| dca | N+4 | 36–4D | 24 |
| mute_group | N+4 | 4E–55 | 8 |
| ufx_send | N+4 | 56–5D | 8 |
| ufx_return | N+4 | 5E–65 | 8 |

`N+4` must stay ≤ 15; the console offers base channels 1–12 for that
reason. Preamps are addressed by **physical socket**, not channel, on
`N+0`: MixRack sockets 1–64 → `00–3F`, DX 1/2 → `40–5F`, DX 3/4 →
`60–7F` (`two-impl`). There is no way to read the socket→channel patch.

## 3. Messages to the console (MixRack socket unless stated)

All multi-byte CC sequences below are emitted with an explicit status
byte on every message (never running status) — proven safe, and it
keeps the NRPN triple atomic across any interleaving.

### 3.1 Mute — `hardware`
```
9n CH 7F      mute on
9n CH 3F      mute off
```
Single Note On, no Note Off (an intermediate layer once mangled a
paired Note Off into `00 00 00 00`). The PDF's values are `40`/`00`;
the console accepts anything ≥ 0x40 as on. Decode by threshold.

### 3.2 Fader level — `hardware`
```
Bn 63 CH   Bn 62 17   Bn 06 LV
```
NRPN MSB = channel address, LSB = parameter `0x17`, Data Entry MSB =
level. No Data Entry LSB (CC 38). **The console latches the NRPN
address**: the triple must never be interleaved with another lane's
NRPN bytes on the same socket. Level ↔ dB is a measured table
(`levels.ts`, firmware 1.94, `0x6B` = 0 dB, ~0.5 dB/step); never a
formula.

### 3.3 NRPN parameters on a channel — `two-impl`
Same triple shape, different parameter LSB:

| Param | LSB | Data |
|---|---|---|
| main assign | 18 | 7F on / 3F off |
| DCA assign | 40 | on: `40 + dca` (dca 0–23), off: `dca` |
| mute-group assign | 40 | on: `58 + mg` (mg 0–7), off: `18 + mg` |
| PEQ band b type | 1A + 4b | 0 bell, 1 lf_shelf, 2 hf_shelf, 3 low_pass, 4 high_pass |
| PEQ band b freq | 1B + 4b | 0–127, f = 20·1000^(v/127) Hz |
| PEQ band b width | 1C + 4b | table 0x00 (1.5) … 0x18 (0.11) |
| PEQ band b gain | 1D + 4b | 0–127 linear over −15…+15 dB |
| HPF frequency | 30 | 0–127, f = 20·100^(v/127) Hz |
| HPF on/off | 31 | 40 on / 00 off |

PEQ bands b = 0..3. Band 0 may be bell/lf_shelf/high_pass; band 3
bell/hf_shelf/low_pass; bands 1–2 bell only.

### 3.4 Scene recall — `hardware`
```
Bn 00 bank   Bn 20 00   Cn pc        bank = (scene−1) div 128, pc = (scene−1) mod 128
```
Scenes 1–500 across banks 0–3. Bank in CC0 (MSB); CC32 is sent as 0 to
match the proven Reaper stream byte-for-byte. (Console Control brief
§6.8.3 had the bank in CC32 — wrong.)

### 3.5 Cue-list recall — `single` (Surface socket)
```
Bn 00 bank   Cn pc        id 0–1999, bank = min(15, id div 128), pc = id mod 128
```

### 3.6 Go / Next / Previous — `hardware` (Surface socket)
A single CC on the base channel; number and value are whatever the
operator assigned in Utility → Control → MIDI.
```
Bn cc val
```

### 3.7 Console Actions — `hardware` (MixRack socket)
Same shape as 3.6 — user-assigned CC on the base channel; the pack
fires them at 51325 in shows. There is no enumeration: the module's
Actions table is user-entered.
```
Bn cc val
```

### 3.8 Send level — `two-impl`, **dB mapping uncalibrated**
```
F0 00 00 1A 50 10 01 00  0N 0D CH  0M DST LV  F7
```
`0N`/`CH` source (N includes the type offset), `0M`/`DST` destination
(aux / fx send / matrix / ufx send, with *its* type offset). `LV` is
0–127. Whether `LV` follows the fader table is unknown until the
September session; until then the module shows raw values for sends.

### 3.9 Input → mix assign (group / aux / matrix) — `two-impl`
```
F0 <hdr> 0N 0E CH  0M DST  40|00  F7
```

### 3.10 Preamp (by socket) — `two-impl`
```
En SOCK GAIN                          gain; range disputed (+5…+60 per PDF formula, −10…+50 per legacy module) — checklist item 9
F0 <hdr> 0N 09 SOCK 40|00 F7          pad
F0 <hdr> 0N 0C SOCK 40|00 F7          48 V
```
All on the base channel `N` (no type offset). Gain rides a *pitch bend*
status byte: the socket is the first data byte (MIDI's LSB position)
and the gain the second (MSB). A generic MIDI library that combines
pitch bend into one 14-bit value will scramble it — handle the two
bytes raw.

### 3.11 Name & colour — `hardware`
```
F0 <hdr> 0N 01 CH F7                  get name
F0 <hdr> 0N 03 CH <ascii…> F7         set name (7-bit ASCII; console truncates)
F0 <hdr> 0N 04 CH F7                  get colour
F0 <hdr> 0N 06 CH COL F7              set colour  0 off 1 red 2 green 3 yellow 4 blue 5 purple 6 lt_blue 7 white
```
Replies: `0N 02 CH <ascii…>` and `0N 05 CH COL`.

### 3.12 UFX global — `two-impl`
```
Bn 0C key      0 = C … 11 = B
Bn 0D scale    0 major, 1 minor
```

### 3.13 Gets — `single` (format) / `inferred` (reply shape)
The generic Get wraps the *message type* the reply will come back as:
```
F0 <hdr> 0N 05 09 CH F7                mute        (09 = Note On)      reply: 9n CH 7F|3F
F0 <hdr> 0N 05 0B 17 CH F7             fader       (0B = CC/NRPN)      reply: Bn 63 CH Bn 62 17 Bn 06 LV
F0 <hdr> 0N 05 0B <param> CH F7        any NRPN parameter of §3.3     reply: NRPN triple
F0 <hdr> 0N 05 0F 0D CH 0M DST F7      send level  (0F = SysEx)        reply: §3.8 message
F0 <hdr> 0N 05 0F 0E CH 0M DST F7      mix assign                      reply: §3.9 message
F0 <hdr> 0N 05 0E SOCK F7              preamp gain (0E = pitch bend)   reply: En SOCK GAIN
F0 <hdr> 0N 05 0F 09 SOCK F7           pad                             reply: §3.10 message
F0 <hdr> 0N 05 0F 0C SOCK F7           48 V                            reply: §3.10 message
```
Mute and fader Gets are `single` (PDF + legacy module); the rest follow
the same pattern and are `inferred`. Reply shapes are assumed to be the
matching *set* messages — the legacy module parses fader and send-level
replies that way, which is why `rx.fader.input1.unity` and
`rx.send_level.reply` carry `single`/`two-impl` while the remaining
reply fixtures are `inferred` — but no capture exists yet. **The scheduler must treat a Get with no reply
within 500 ms as "unsupported", not as an error**, so an `inferred`
Get that the console ignores degrades to "no feedback" rather than
a connection fault.

## 4. Messages from the console (unsolicited) — `hardware`

| Event on the surface | Arrives | Carries state |
|---|---|---|
| Mute toggled | `9n CH 7F` / `9n CH 3F` | yes |
| Fader moved | **lone** `Bn 63 CH` — no LSB, no Data Entry | **no** — announces *which* strip only |
| Scene recalled | `Bn 00 bank` + `Cn pc` | yes |
| Name / colour reply | SysEx 02 / 05 | yes (solicited) |

Global MIDI Send must be on at the console for any of this. The fader
ping drives *query-on-ping*: coalesce pings per strip on a ~40 ms
trailing edge, issue one fader Get per burst plus one settle Get, cap
in-flight Gets. Whether sends / assigns / preamp changes also ping is
open (checklist item 3). Whether our own sets are echoed back is open
(item 8) — the state layer must be idempotent either way.

## 5. Decoder rules

1. System real-time bytes (`F8`–`FF`) may appear anywhere, including
   mid-message and mid-SysEx; they never disturb running status.
2. Running status applies to voice messages; SysEx and system-common
   clear it.
3. A status byte aborts an unterminated SysEx; the SysEx accumulator is
   bounded (256 bytes) — an overrun drops the SysEx, never the stream.
4. NRPN state **latches**, per socket *and* per MIDI channel (standard
   MIDI; the console is believed to do the same — checklist item 6
   measures it): after `Bn 63 CH` that channel's address stays selected
   until the next `63` on it; `62` likewise. A `06` with both latched is
   a complete parameter event. A `63` followed by anything other than
   `62` is emitted as a **ping** for that channel.
5. `Bn 78`–`7F` (channel mode) are never emitted by the module; inbound
   they are ignored (the bridge filters transport-reset bursts for the
   same reason — they corrupt the latch).
6. Note On velocity ≥ 0x40 = mute on, else off. Note Off = ignore.
7. Channel → type is resolved with the configured base channel; a
   voice message on a MIDI channel outside `N..N+4`, or on an address
   in a gap of the §2 table, is passed through as `unknown`. CC on the
   base channel that is not NRPN/Bank Select (Actions, UFX, Go/Next/Prev
   echoes) and Program Change / pitch bend off the base channel are
   `unknown` too.
8. **Ignored messages are transparent**: real-time bytes, Note Off,
   channel-mode CCs and non-A&H SysEx neither flush a pending ping nor
   break an NRPN triple in progress (`rx.nrpn.triple_survives_ignored_between`).
9. The decoder is one-directional. SysEx op `05` means *Reply Colour*
   coming from the console and *Get* going to it, so a tap that sees
   both directions through one parser cannot tell `00 05 09 00` (colour
   reply, input 10, off) from `00 05 09 00` (Get mute, input 1). Parse
   each direction with its own instance.
10. On the Surface socket a cue-list recall (§3.5) is byte-identical to
    a scene recall and decodes as `scene` — a listener on 51328 must
    label accordingly. Whether the Surface pushes anything at all is
    checklist item 7.

## 6. Liveness

TCP connect succeeding means nothing — a console with MIDI set to
Off or Secure, or the wrong device entirely, accepts the socket and
drops every byte. After connect the module sends **Get Name for Input
1** and reports `Ok` only when the reply for *that target* arrives
(matched by target, never by timing). The same probe repeats every
15 s; two consecutive misses → `ConnectionFailure` with the message
"Connected, but the console is not responding. Check Utility →
Control → MIDI: mode must be On (not Off or Secure) and Global MIDI
Receive must be enabled."
