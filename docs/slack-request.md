# Bitfocus repo request — process + message

> **SUPERSEDED, 27–29 Aug 2026.** Kept for the record; the reasoning
> below is no longer the plan. What actually happened, and what replaced
> it, is in "Outcome" at the foot of this file. Read that first.

## Process

1. **Join the Bitfocus Slack**: invite link at <https://bitfocus.io/api/slackinvite>
   (if it's dead, email `connections@bitfocus.io`).
2. **Post the message below in `#module-development`.** This is the whole
   "application" — Bitfocus never reviews a concept, only a namespace. The
   reply is effectively the go/no-go on the name.
3. They create `github.com/bitfocus/companion-module-dylanmaudio-dlive`
   and grant your GitHub account (**dylanmaudio**) write access.
4. We push our history there, tag `v1.0.0` when ready, then submit the tag
   at <https://developer.bitfocus.io> (log in with GitHub → My Connections →
   Submit Version).
5. Volunteer review — days to weeks, feedback lands in the portal. On
   approval it's installable by anyone on Companion 5.0+.

Before step 2 it's worth pushing the code to your own GitHub
(`github.com/dylanmaudio/companion-module-dylanmaudio-dlive`) so the
message can link to real code — reviewers respond much better to a repo
than a promise. Say the word and I'll create and push it.

## The message

> Hi! I'd like to request a repo for a new connection module:
> **companion-module-dylanmaudio-dlive** — GitHub username **dylanmaudio**.
>
> Being upfront: two dLive modules already exist (`allenheath-dlive` and
> `allenheath-dlive-ilive`). This isn't a fork of either — it's built
> around the thing neither has: **state feedback**. The dLive pushes mutes
> and scene recalls over MIDI/TCP and announces fader moves, and this
> module mirrors that into Companion: boolean/value feedbacks, ~2000
> variables (names, colours, mutes, levels in dB), presets that label and
> colour themselves from the show, timed dB-linear fades on every level
> action, a named mapping table for the console's Actions system, and
> scene names imported from the console's show file (the protocol has no
> Get for them). Connection status is probe-gated — it only goes green
> once the desk actually answers a Get, which addresses the long-standing
> "shows connected but isn't" reports on the existing modules (e.g.
> allenheath-dlive-ilive #16).
>
> Tech: TypeScript on `@companion-module/base` 2.1 (Companion 5.0+), the
> wire protocol pinned by a golden byte-fixture suite, unit + end-to-end
> tests against a console simulator, plus verification on my own dLive
> system (I mix on dLive professionally; a hardware capture session for
> the remaining protocol unknowns is booked for early September). Code:
> <REPO LINK>.
>
> On the name: I went with `dylanmaudio-dlive` (the manifest's
> manufacturer field is "Allen & Heath", so it still lists under A&H in
> the connections browser) rather than an `allenheath-*` id, to avoid
> reading as a replacement for Tim Steer's module. Happy to switch to
> something like `allenheath-dlive-statefeedback` if you'd rather keep
> the manufacturer prefix. I expect to add sibling modules for my other
> dLive tools under the same prefix later, but I'm only requesting this
> one repo for now.
>
> Thanks!

## Why the message is shaped this way

- **Names the incumbents before a reviewer does** — the brief's research
  found reviewers respond far better to that than to discovering overlap
  themselves, and Bitfocus has already accepted a second dLive module once
  (the `allenheath-dlive` id was re-granted to a new maintainer after the
  original was renamed `-ilive`).
- **Differentiator in one sentence** (state feedback), then evidence, so
  a skimming maintainer gets the point in ten seconds.
- **Concedes the naming question up front** with a workable fallback —
  the id is a branding choice, not a discoverability one, since listing
  groups by the manufacturer field (`devcore-mixingstation` precedent).
- **Mentions the family, requests one repo** — an empty-repo land-grab in
  someone else's org would undercut the credibility the framing buys.
- **No feature promises that depend on September** — sends calibration,
  preamp gain range etc. are internal concerns; the module ships useful
  without them.

---

## Outcome (29 Aug 2026)

The request was made and met with immediate resistance — two reviewers
asked, reasonably, "why not add state feedback to the existing modules
instead?" Then a concrete acceptance spec was offered:

> Remove the ability to connect to the console directly from the module
> and change the manifest so that it's clearly targeted toward your
> middleware instead and doesn't include a manufacturer that you're not.
> But we'd much rather see you contribute toward a companion module that
> can do all of this natively.

**Tim Steer (`shedworth`), the incumbent maintainer, replied warmly** —
he built `allenheath-dlive` over a winter on a borrowed console, has no
desk at home to test against, would welcome feedback support, and would
prefer it as an enhancement rather than a separate module. He pointed at
**PR #8** (`BrentonStarkie`, +3942/−55), open since February.

The decisive discovery: **that PR is blocked on hardware, not code.** Its
tester deferred in July; Tim has no console. Running its real
`FeedbackHandler` against the Virtual dLive found a genuine defect — the
desk's lone `Bn 63 <ch>` fader ping stalls its fixed-length framer and
swallows the following message — plus an open question (which NRPN
framing the console replies with) that only a desk can settle.

### The plan that replaced this document

1. **Help land PR #8 as a contributor.** Hardware and a simulator are
   what the ecosystem is short of, and they cost no roadmap control. The
   findings and offer are drafted; posting waits until the September
   captures can back them with real bytes.
2. **Ship a module for the bridge, not for the console.** Manufacturer
   `dylanmaudio`, product "dLive MIDI Bridge", no direct console path —
   done in `a7e0b6e`. The bridge is console-agnostic by design, so the
   same module covers other desks as drivers are added, rather than
   becoming another per-console module.

The intended id is **`dylanmaudio-midi-bridge`**; the manifest still
says `dylanmaudio-dlive` pending a fresh request under the new name
(which also means renaming this repo and the dev-module symlink).

### What was actually right in the original reasoning

- Discoverability follows the `manufacturer` field, not the id — which
  is why retargeting the manifest mattered more than the id ever did.
- The registry repo lives in the Bitfocus org, so a rename goes through
  them; worth getting the name right before asking.
- Self-distribution via `.tgz` remains a working fallback.
