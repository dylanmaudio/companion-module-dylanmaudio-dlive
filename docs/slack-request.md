# Bitfocus repo request — process + message

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
