#!/usr/bin/env python3
"""
author.py — builds fixtures/tx.json and fixtures/rx.json from the byte
templates in docs/protocol.md.

The JSON files are the authority, not this script: it exists so a
correction (e.g. a September hardware capture that contradicts a
`two-impl` case) can be applied in one place and re-emitted. It is
deliberately NOT an implementation of the codec — no shared code with
src/ or with MIDI Bridge — so that neither implementation is secretly
testing itself.

    python3 fixtures/author.py        # rewrites tx.json / rx.json
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
HDR = [0xF0, 0x00, 0x00, 0x1A, 0x50, 0x10, 0x01, 0x00]
EOX = 0xF7

# (type, midi offset, address start, count) — protocol.md §2
TYPES = {
    "input":          (0, 0x00, 128),
    "mono_group":     (1, 0x00, 62),
    "stereo_group":   (1, 0x40, 31),
    "mono_aux":       (2, 0x00, 62),
    "stereo_aux":     (2, 0x40, 31),
    "mono_matrix":    (3, 0x00, 62),
    "stereo_matrix":  (3, 0x40, 31),
    "mono_fx_send":   (4, 0x00, 16),
    "stereo_fx_send": (4, 0x10, 16),
    "fx_return":      (4, 0x20, 16),
    "main":           (4, 0x30, 6),
    "dca":            (4, 0x36, 24),
    "mute_group":     (4, 0x4E, 8),
    "ufx_send":       (4, 0x56, 8),
    "ufx_return":     (4, 0x5E, 8),
}
SOCKET_BANKS = {"mixrack": 0x00, "dx12": 0x40, "dx34": 0x60}


def addr(t: str, index: int) -> tuple[int, int]:
    off, start, count = TYPES[t]
    assert 1 <= index <= count, (t, index)
    return off, start + index - 1


def hexs(b: list[int]) -> str:
    return " ".join(f"{x:02x}" for x in b)


tx: list[dict] = []
rx: list[dict] = []


def T(id_, tier, intent, data, *, base=1, socket="mixrack", note=None):
    case = {"id": id_, "tier": tier, "dir": "tx", "socket": socket,
            "base_channel": base, "intent": intent, "hex": hexs(data)}
    if note:
        case["note"] = note
    tx.append(case)


def R(id_, tier, data, events, *, base=1, socket="mixrack", chunks=None, note=None):
    case = {"id": id_, "tier": tier, "dir": "rx", "socket": socket,
            "base_channel": base, "hex": hexs(data), "events": events}
    if chunks:
        case["chunks"] = [hexs(c) for c in chunks]
    if note:
        case["note"] = note
    rx.append(case)


# ---------------------------------------------------------------- encoders
def mute(n, t, i, on, base=1):
    off, ch = addr(t, i)
    return [0x90 | (n + off), ch, 0x7F if on else 0x3F]


def nrpn(n, t, i, param, value):
    off, ch = addr(t, i)
    s = 0xB0 | (n + off)
    return [s, 0x63, ch, s, 0x62, param, s, 0x06, value]


def scene(n, s):
    idx = s - 1
    return [0xB0 | n, 0x00, idx // 128, 0xB0 | n, 0x20, 0x00, 0xC0 | n, idx % 128]


def cue(n, id_):
    return [0xB0 | n, 0x00, min(15, id_ // 128), 0xC0 | n, id_ % 128]


def sysex(n_off, body):
    return HDR + [n_off] + body + [EOX]


def send_level(n, t, i, dt, di, lv):
    off, ch = addr(t, i)
    doff, dch = addr(dt, di)
    return sysex(n + off, [0x0D, ch, n + doff, dch, lv])


def mix_assign(n, i, dt, di, on):
    off, ch = addr("input", i)
    doff, dch = addr(dt, di)
    return sysex(n + off, [0x0E, ch, n + doff, dch, 0x40 if on else 0x00])


def sock(bank, index):
    assert 1 <= index <= (64 if bank == "mixrack" else 32)
    return SOCKET_BANKS[bank] + index - 1


# ---------------------------------------------------------------- TX cases
for base in (1, 12):
    n = base - 1
    b = f"b{base}"
    # §3.1 mute
    T(f"mute.input1.on.{b}", "hardware", {"op": "mute", "type": "input", "index": 1, "on": True}, mute(n, "input", 1, True), base=base)
    T(f"mute.input1.off.{b}", "hardware", {"op": "mute", "type": "input", "index": 1, "on": False}, mute(n, "input", 1, False), base=base)
    T(f"mute.dca3.on.{b}", "hardware", {"op": "mute", "type": "dca", "index": 3, "on": True}, mute(n, "dca", 3, True), base=base)
    T(f"mute.mutegroup1.on.{b}", "hardware", {"op": "mute", "type": "mute_group", "index": 1, "on": True}, mute(n, "mute_group", 1, True), base=base)
    T(f"mute.stereoaux2.off.{b}", "hardware", {"op": "mute", "type": "stereo_aux", "index": 2, "on": False}, mute(n, "stereo_aux", 2, False), base=base)
    T(f"mute.input128.on.{b}", "hardware", {"op": "mute", "type": "input", "index": 128, "on": True}, mute(n, "input", 128, True), base=base)
    # §3.2 fader
    T(f"fader.input1.unity.{b}", "hardware", {"op": "fader", "type": "input", "index": 1, "level": 107}, nrpn(n, "input", 1, 0x17, 107), base=base)
    T(f"fader.input12.minusinf.{b}", "hardware", {"op": "fader", "type": "input", "index": 12, "level": 0}, nrpn(n, "input", 12, 0x17, 0), base=base)
    T(f"fader.main1.max.{b}", "hardware", {"op": "fader", "type": "main", "index": 1, "level": 127}, nrpn(n, "main", 1, 0x17, 127), base=base)
    T(f"fader.monoaux62.{b}", "hardware", {"op": "fader", "type": "mono_aux", "index": 62, "level": 64}, nrpn(n, "mono_aux", 62, 0x17, 64), base=base)
    T(f"fader.ufxreturn8.{b}", "hardware", {"op": "fader", "type": "ufx_return", "index": 8, "level": 100}, nrpn(n, "ufx_return", 8, 0x17, 100), base=base)
    # §3.4 scene
    T(f"scene.1.{b}", "hardware", {"op": "scene", "scene": 1}, scene(n, 1), base=base)
    T(f"scene.128.{b}", "hardware", {"op": "scene", "scene": 128}, scene(n, 128), base=base)
    T(f"scene.129.{b}", "hardware", {"op": "scene", "scene": 129}, scene(n, 129), base=base, note="bank in CC0 (MSB); CC32 = 0 — byte-identical to the proven Reaper stream")
    T(f"scene.500.{b}", "hardware", {"op": "scene", "scene": 500}, scene(n, 500), base=base)
    # §3.7 actions / §3.6 surface CC
    T(f"action.cc20.v1.{b}", "hardware", {"op": "action", "cc": 20, "value": 1}, [0xB0 | n, 20, 1], base=base)
    T(f"surface_cc.go.{b}", "hardware", {"op": "surface_cc", "cc": 64, "value": 127}, [0xB0 | n, 64, 127], base=base, socket="surface")
    # §3.11 name & colour
    T(f"get_name.input1.{b}", "hardware", {"op": "get_name", "type": "input", "index": 1}, sysex(n, [0x01, 0x00]), base=base)
    T(f"get_name.dca5.{b}", "hardware", {"op": "get_name", "type": "dca", "index": 5}, sysex(n + 4, [0x01, 0x3A]), base=base)
    T(f"set_name.input1.kick.{b}", "hardware", {"op": "set_name", "type": "input", "index": 1, "name": "Kick"}, sysex(n, [0x03, 0x00] + list(b"Kick")), base=base)
    T(f"set_name.input2.nonascii.{b}", "hardware", {"op": "set_name", "type": "input", "index": 2, "name": "Gtré"}, sysex(n, [0x03, 0x01] + list(b"Gtr?")), base=base, note="non-ASCII becomes '?' to stay 7-bit")
    T(f"get_colour.input1.{b}", "hardware", {"op": "get_colour", "type": "input", "index": 1}, sysex(n, [0x04, 0x00]), base=base)
    T(f"set_colour.input1.red.{b}", "hardware", {"op": "set_colour", "type": "input", "index": 1, "colour": "red"}, sysex(n, [0x06, 0x00, 0x01]), base=base)
    T(f"set_colour.stereogroup3.white.{b}", "hardware", {"op": "set_colour", "type": "stereo_group", "index": 3, "colour": "white"}, sysex(n + 1, [0x06, 0x42, 0x07]), base=base)

n = 0  # remaining cases on base channel 1 only — the offset math is proven above
# §3.3 NRPN parameters
T("main_assign.input1.on", "two-impl", {"op": "main_assign", "type": "input", "index": 1, "on": True}, nrpn(n, "input", 1, 0x18, 0x7F))
T("main_assign.input1.off", "two-impl", {"op": "main_assign", "type": "input", "index": 1, "on": False}, nrpn(n, "input", 1, 0x18, 0x3F))
T("dca_assign.input1.dca1.on", "two-impl", {"op": "dca_assign", "type": "input", "index": 1, "dca": 1, "on": True}, nrpn(n, "input", 1, 0x40, 0x40))
T("dca_assign.input1.dca24.on", "two-impl", {"op": "dca_assign", "type": "input", "index": 1, "dca": 24, "on": True}, nrpn(n, "input", 1, 0x40, 0x57))
T("dca_assign.input1.dca1.off", "two-impl", {"op": "dca_assign", "type": "input", "index": 1, "dca": 1, "on": False}, nrpn(n, "input", 1, 0x40, 0x00))
T("mutegroup_assign.input1.mg1.on", "two-impl", {"op": "mute_group_assign", "type": "input", "index": 1, "group": 1, "on": True}, nrpn(n, "input", 1, 0x40, 0x58))
T("mutegroup_assign.input1.mg8.off", "two-impl", {"op": "mute_group_assign", "type": "input", "index": 1, "group": 8, "on": False}, nrpn(n, "input", 1, 0x40, 0x1F))
T("peq.input1.band1.type.bell", "two-impl", {"op": "peq", "type": "input", "index": 1, "band": 1, "param": "type", "value": 0}, nrpn(n, "input", 1, 0x1A, 0))
T("peq.input1.band1.freq", "two-impl", {"op": "peq", "type": "input", "index": 1, "band": 1, "param": "freq", "value": 72}, nrpn(n, "input", 1, 0x1B, 72))
T("peq.input1.band2.width", "two-impl", {"op": "peq", "type": "input", "index": 1, "band": 2, "param": "width", "value": 5}, nrpn(n, "input", 1, 0x20, 5))
T("peq.input1.band4.gain", "two-impl", {"op": "peq", "type": "input", "index": 1, "band": 4, "param": "gain", "value": 64}, nrpn(n, "input", 1, 0x29, 64))
T("hpf_freq.input1", "two-impl", {"op": "hpf_freq", "index": 1, "value": 40}, nrpn(n, "input", 1, 0x30, 40))
T("hpf_on.input1.on", "two-impl", {"op": "hpf_on", "index": 1, "on": True}, nrpn(n, "input", 1, 0x31, 0x40))
T("hpf_on.input1.off", "two-impl", {"op": "hpf_on", "index": 1, "on": False}, nrpn(n, "input", 1, 0x31, 0x00))
# §3.5 cue list (surface)
T("cue_list.0", "single", {"op": "cue_list", "id": 0}, cue(n, 0), socket="surface")
T("cue_list.129", "single", {"op": "cue_list", "id": 129}, cue(n, 129), socket="surface")
T("cue_list.1999", "single", {"op": "cue_list", "id": 1999}, cue(n, 1999), socket="surface")
# §3.8 send level
T("send_level.input1.monoaux1", "two-impl", {"op": "send_level", "type": "input", "index": 1, "dest_type": "mono_aux", "dest_index": 1, "level": 107}, send_level(n, "input", 1, "mono_aux", 1, 107), note="LV↔dB uncalibrated for sends")
T("send_level.input3.stereofx2", "two-impl", {"op": "send_level", "type": "input", "index": 3, "dest_type": "stereo_fx_send", "dest_index": 2, "level": 0}, send_level(n, "input", 3, "stereo_fx_send", 2, 0))
T("send_level.monogroup2.stereomatrix1", "two-impl", {"op": "send_level", "type": "mono_group", "index": 2, "dest_type": "stereo_matrix", "dest_index": 1, "level": 64}, send_level(n, "mono_group", 2, "stereo_matrix", 1, 64))
T("send_level.fxreturn1.ufxsend1", "two-impl", {"op": "send_level", "type": "fx_return", "index": 1, "dest_type": "ufx_send", "dest_index": 1, "level": 90}, send_level(n, "fx_return", 1, "ufx_send", 1, 90))
# §3.9 mix assign
T("mix_assign.input1.monogroup1.on", "two-impl", {"op": "mix_assign", "index": 1, "dest_type": "mono_group", "dest_index": 1, "on": True}, mix_assign(n, 1, "mono_group", 1, True))
T("mix_assign.input5.stereoaux3.off", "two-impl", {"op": "mix_assign", "index": 5, "dest_type": "stereo_aux", "dest_index": 3, "on": False}, mix_assign(n, 5, "stereo_aux", 3, False))
# §3.10 preamp
T("preamp_gain.mixrack1", "two-impl", {"op": "preamp_gain", "bank": "mixrack", "socket": 1, "value": 64}, [0xE0 | n, sock("mixrack", 1), 64], note="gain dB range disputed — raw value here")
T("preamp_gain.dx12.socket5", "two-impl", {"op": "preamp_gain", "bank": "dx12", "socket": 5, "value": 0}, [0xE0 | n, sock("dx12", 5), 0])
T("preamp_gain.dx34.socket32", "two-impl", {"op": "preamp_gain", "bank": "dx34", "socket": 32, "value": 127}, [0xE0 | n, sock("dx34", 32), 127])
T("preamp_pad.mixrack1.on", "two-impl", {"op": "preamp_pad", "bank": "mixrack", "socket": 1, "on": True}, sysex(n, [0x09, 0x00, 0x40]))
T("preamp_48v.mixrack64.off", "two-impl", {"op": "preamp_48v", "bank": "mixrack", "socket": 64, "on": False}, sysex(n, [0x0C, 0x3F, 0x00]))
# §3.12 UFX
T("ufx_key.a", "two-impl", {"op": "ufx_key", "key": 9}, [0xB0 | n, 0x0C, 9])
T("ufx_scale.minor", "two-impl", {"op": "ufx_scale", "scale": 1}, [0xB0 | n, 0x0D, 1])
# §3.13 gets
T("get_mute.input1", "single", {"op": "get_mute", "type": "input", "index": 1}, sysex(n, [0x05, 0x09, 0x00]))
T("get_mute.dca2", "single", {"op": "get_mute", "type": "dca", "index": 2}, sysex(n + 4, [0x05, 0x09, 0x37]))
T("get_fader.input1", "single", {"op": "get_fader", "type": "input", "index": 1}, sysex(n, [0x05, 0x0B, 0x17, 0x00]))
T("get_fader.stereoaux1", "single", {"op": "get_fader", "type": "stereo_aux", "index": 1}, sysex(n + 2, [0x05, 0x0B, 0x17, 0x40]))
T("get_param.main_assign.input1", "inferred", {"op": "get_param", "type": "input", "index": 1, "param": 0x18}, sysex(n, [0x05, 0x0B, 0x18, 0x00]))
T("get_param.hpf_on.input1", "inferred", {"op": "get_param", "type": "input", "index": 1, "param": 0x31}, sysex(n, [0x05, 0x0B, 0x31, 0x00]))
T("get_send_level.input1.monoaux1", "single", {"op": "get_send_level", "type": "input", "index": 1, "dest_type": "mono_aux", "dest_index": 1}, sysex(n, [0x05, 0x0F, 0x0D, 0x00, n + 2, 0x00]))
T("get_mix_assign.input1.monogroup1", "inferred", {"op": "get_mix_assign", "index": 1, "dest_type": "mono_group", "dest_index": 1}, sysex(n, [0x05, 0x0F, 0x0E, 0x00, n + 1, 0x00]))
T("get_preamp_gain.mixrack1", "inferred", {"op": "get_preamp_gain", "bank": "mixrack", "socket": 1}, sysex(n, [0x05, 0x0E, 0x00]))
T("get_preamp_pad.mixrack1", "inferred", {"op": "get_preamp_pad", "bank": "mixrack", "socket": 1}, sysex(n, [0x05, 0x0F, 0x09, 0x00]))
T("get_preamp_48v.dx12.socket1", "inferred", {"op": "get_preamp_48v", "bank": "dx12", "socket": 1}, sysex(n, [0x05, 0x0F, 0x0C, 0x40]))

# ---------------------------------------------------------------- RX cases
for base in (1, 12):
    n = base - 1
    b = f"b{base}"
    R(f"rx.mute.input1.on.echo.{b}", "hardware", [0x90 | n, 0x00, 0x7F], [{"kind": "mute", "type": "input", "index": 1, "on": True}], base=base)
    R(f"rx.mute.input1.off.echo.{b}", "hardware", [0x90 | n, 0x00, 0x3F], [{"kind": "mute", "type": "input", "index": 1, "on": False}], base=base)
    R(f"rx.mute.input1.on.spec.{b}", "hardware", [0x90 | n, 0x00, 0x40], [{"kind": "mute", "type": "input", "index": 1, "on": True}], base=base, note="PDF convention 0x40/0x00 — threshold decode")
    R(f"rx.mute.input1.off.spec.{b}", "hardware", [0x90 | n, 0x00, 0x00], [{"kind": "mute", "type": "input", "index": 1, "on": False}], base=base)
    R(f"rx.mute.dca3.{b}", "hardware", [0x90 | (n + 4), 0x38, 0x7F], [{"kind": "mute", "type": "dca", "index": 3, "on": True}], base=base)
    R(f"rx.ping.input1.{b}", "hardware", [0xB0 | n, 0x63, 0x00], [{"kind": "fader_ping", "type": "input", "index": 1}], base=base, note="lone NRPN MSB — fader moved, no level")
    R(f"rx.ping.stereogroup2.{b}", "hardware", [0xB0 | (n + 1), 0x63, 0x41], [{"kind": "fader_ping", "type": "stereo_group", "index": 2}], base=base)
    R(f"rx.fader.input1.unity.{b}", "single", [0xB0 | n, 0x63, 0x00, 0xB0 | n, 0x62, 0x17, 0xB0 | n, 0x06, 0x6B], [{"kind": "fader", "type": "input", "index": 1, "level": 107}], base=base, note="Get Fader reply shape (assumed = set shape). No ping is emitted when the triple completes.")
    R(f"rx.scene.129.{b}", "hardware", [0xB0 | n, 0x00, 0x01, 0xC0 | n, 0x01], [{"kind": "scene", "scene": 130}], base=base, note="bank 1, pc 1 → scene 130")
    R(f"rx.scene.1.nobank.{b}", "hardware", [0xC0 | n, 0x00], [{"kind": "scene", "scene": 1}], base=base, note="lone PC with no bank seen this session → bank 0")
    R(f"rx.name.input1.kick.{b}", "hardware", sysex(n, [0x02, 0x00] + list(b"Kick")), [{"kind": "name", "type": "input", "index": 1, "name": "Kick"}], base=base)
    R(f"rx.colour.input1.red.{b}", "hardware", sysex(n, [0x05, 0x00, 0x01]), [{"kind": "colour", "type": "input", "index": 1, "colour": "red"}], base=base)

n = 0
# stream mechanics — protocol.md §5
R("rx.running_status.mutes", "hardware", [0x90, 0x00, 0x7F, 0x01, 0x3F, 0x02, 0x7F],
  [{"kind": "mute", "type": "input", "index": 1, "on": True},
   {"kind": "mute", "type": "input", "index": 2, "on": False},
   {"kind": "mute", "type": "input", "index": 3, "on": True}])
R("rx.realtime.mid_message", "hardware", [0x90, 0x00, 0xF8, 0x7F],
  [{"kind": "mute", "type": "input", "index": 1, "on": True}], note="F8 inside a message is dropped, message completes")
R("rx.realtime.mid_sysex", "hardware", HDR + [0x00, 0x02, 0x00, ord("K"), 0xF8, ord("i"), ord("c"), ord("k"), EOX],
  [{"kind": "name", "type": "input", "index": 1, "name": "Kick"}])
R("rx.split.sysex_across_chunks", "hardware", sysex(n, [0x02, 0x00] + list(b"Snare")),
  [{"kind": "name", "type": "input", "index": 1, "name": "Snare"}],
  chunks=[HDR[:5], HDR[5:] + [0x00, 0x02, 0x00, ord("S"), ord("n")], list(b"are") + [EOX]])
R("rx.split.nrpn_across_chunks", "single", [0xB0, 0x63, 0x05, 0xB0, 0x62, 0x17, 0xB0, 0x06, 0x50],
  [{"kind": "fader", "type": "input", "index": 6, "level": 80}],
  chunks=[[0xB0, 0x63], [0x05, 0xB0, 0x62, 0x17, 0xB0], [0x06, 0x50]])
R("rx.split.status_then_data", "hardware", [0x90, 0x00, 0x7F],
  [{"kind": "mute", "type": "input", "index": 1, "on": True}], chunks=[[0x90], [0x00], [0x7F]])
R("rx.nrpn.latch_persists", "hardware", [0xB0, 0x63, 0x07, 0xB0, 0x62, 0x17, 0xB0, 0x06, 0x10, 0xB0, 0x06, 0x20, 0xB0, 0x06, 0x30],
  [{"kind": "fader", "type": "input", "index": 8, "level": 16},
   {"kind": "fader", "type": "input", "index": 8, "level": 32},
   {"kind": "fader", "type": "input", "index": 8, "level": 48}], note="address latched: repeated Data Entry keeps applying to input 8")
R("rx.nrpn.ping_then_ping", "hardware", [0xB0, 0x63, 0x00, 0xB0, 0x63, 0x01],
  [{"kind": "fader_ping", "type": "input", "index": 1}, {"kind": "fader_ping", "type": "input", "index": 2}],
  note="two pings: the first 63 is emitted as a ping when the next 63 arrives (or on flush)")
R("rx.nrpn.ping_then_mute", "hardware", [0xB0, 0x63, 0x00, 0x90, 0x03, 0x7F],
  [{"kind": "fader_ping", "type": "input", "index": 1}, {"kind": "mute", "type": "input", "index": 4, "on": True}],
  note="a non-NRPN message after a lone 63 flushes the ping first")
R("rx.nrpn.param.main_assign", "two-impl", [0xB0, 0x63, 0x00, 0xB0, 0x62, 0x18, 0xB0, 0x06, 0x7F],
  [{"kind": "param", "type": "input", "index": 1, "param": 0x18, "value": 0x7F}])
R("rx.sysex.unterminated_aborted_by_status", "hardware", HDR + [0x00, 0x02, 0x00, ord("K"), 0x90, 0x01, 0x7F],
  [{"kind": "mute", "type": "input", "index": 2, "on": True}], note="status byte aborts the SysEx; nothing emitted for it")
R("rx.sysex.foreign_ignored", "hardware", [0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7, 0x90, 0x00, 0x7F],
  [{"kind": "mute", "type": "input", "index": 1, "on": True}], note="non-A&H SysEx is dropped silently")
R("rx.channel_mode.ignored", "hardware", [0xB0, 0x7B, 0x00, 0xB0, 0x79, 0x00, 0x90, 0x00, 0x3F],
  [{"kind": "mute", "type": "input", "index": 1, "on": False}], note="CC 120–127 never touch NRPN state")
R("rx.nrpn.triple_survives_ignored_between", "hardware",
  [0xB0, 0x63, 0x00, 0x80, 0x05, 0x00, 0xB0, 0x7B, 0x00, 0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7, 0xF8, 0xB0, 0x62, 0x17, 0xB0, 0x06, 0x6B],
  [{"kind": "fader", "type": "input", "index": 1, "level": 107}],
  note="ignored messages (note off, CC 120-127, foreign SysEx, real-time) between 63 and 62 neither flush the ping nor break the triple — ONE fader event, no ping")
R("rx.send_level.reply", "two-impl", send_level(0, "input", 1, "mono_aux", 1, 107),
  [{"kind": "send_level", "type": "input", "index": 1, "dest_type": "mono_aux", "dest_index": 1, "level": 107}])
R("rx.mix_assign.reply", "inferred", mix_assign(0, 1, "mono_group", 1, True),
  [{"kind": "mix_assign", "index": 1, "dest_type": "mono_group", "dest_index": 1, "on": True}])
R("rx.preamp_gain.reply", "inferred", [0xE0, 0x00, 0x40],
  [{"kind": "preamp_gain", "bank": "mixrack", "socket": 1, "value": 64}])
R("rx.preamp_pad.reply", "inferred", sysex(0, [0x09, 0x41, 0x40]),
  [{"kind": "preamp_pad", "bank": "dx12", "socket": 2, "on": True}])
R("rx.preamp_48v.reply", "inferred", sysex(0, [0x0C, 0x60, 0x00]),
  [{"kind": "preamp_48v", "bank": "dx34", "socket": 1, "on": False}])
R("rx.unknown_channel.passthrough", "hardware", [0x90 | 9, 0x00, 0x7F, 0x90, 0x00, 0x7F],
  [{"kind": "unknown", "status": 0x99, "data": [0, 127]}, {"kind": "mute", "type": "input", "index": 1, "on": True}],
  note="MIDI channel 10 is outside N..N+4 for base 1 → reported as unknown, stream continues")
R("rx.note_off.ignored", "hardware", [0x80, 0x00, 0x00, 0x90, 0x00, 0x7F],
  [{"kind": "mute", "type": "input", "index": 1, "on": True}])
R("rx.burst.running_status_with_clock", "hardware", [0x90] + sum(([0x24 + (i % 24), 0x40 if i % 2 == 0 else 0x00] + ([0xF8] if i == 3 else []) for i in range(8)), []),
  [{"kind": "mute", "type": "input", "index": 0x24 + (i % 24) + 1, "on": i % 2 == 0} for i in range(8)],
  note="the Virtual dLive's running_status_burst shape (8 notes, clock spliced after the 4th)")

out = {"schema": "dlive-fixtures/1", "source": "docs/protocol.md",
       "note": "Authority for both codecs. Tiers: hardware > two-impl > single > inferred (see docs/protocol.md)."}
(HERE / "tx.json").write_text(json.dumps({**out, "cases": tx}, indent=1) + "\n")
(HERE / "rx.json").write_text(json.dumps({**out, "cases": rx}, indent=1) + "\n")
print(f"tx: {len(tx)} cases, rx: {len(rx)} cases")
