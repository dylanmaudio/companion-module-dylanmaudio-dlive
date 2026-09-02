/**
 * The HTML served at the module's own HTTP endpoint.
 *
 * Styled to match the dLive MIDI Bridge app it belongs to: the blue header
 * band with the product mark, the status card that goes green when all is
 * well, full-width buttons, small letterspaced section headings, and a
 * monospace activity panel whose newest line is the bright one.
 *
 * Self-contained — no external CSS, fonts or scripts. Companion serves this
 * from its own web server and a show-file page has no business reaching the
 * internet.
 *
 * The client slices the file on 3-byte boundaries before base64-encoding it,
 * so every chunk is valid base64 on its own and the server can concatenate
 * them before a single decode. RAW_CHUNK is CHUNK_CHARS/4*3 for that reason —
 * change one and the other follows. Note there are no JS template literals in
 * the inline script: this whole page is one, and `${}` inside it would be
 * evaluated here rather than in the browser.
 */

import { CHUNK_CHARS, escapeHtml, MAX_UPLOAD_BYTES } from './upload.js'

const RAW_CHUNK = (CHUNK_CHARS / 4) * 3

export interface UploadPageModel {
	/** Connection label, shown so a multi-desk rig knows which one it is editing */
	label: string
	/** describeImport() of what is currently loaded, or '' */
	imported: string
	/** Path currently set in the "advanced" show file field, or '' */
	path: string
}

/**
 * The dylanmaudio mark, traced as vectors: a ringed disc holding an M built
 * from the same rounded bars as a level meter. Drawn rather than embedded so
 * it stays sharp at any size and the page keeps needing no external files.
 * Each stroke is painted twice — a wide white pass, then a narrower dark one —
 * which is what gives every bar its outline.
 */
const LOGO = `<svg viewBox="0 0 1024 1024" aria-hidden="true">
	<circle cx="512" cy="512" r="455" fill="none" stroke="#0b0b0b" stroke-width="26"/>
	<circle cx="512" cy="512" r="429" fill="#414141" stroke="#fff" stroke-width="13"/>
	<g fill="none" stroke-linecap="round" stroke-linejoin="round">
		<g stroke="#fff" stroke-width="74">
			<path d="M256 400V616M768 400V616M126 512h14M884 512h14"/>
			<path d="M512 228V796"/>
		</g>
		<g stroke="#0b0b0b" stroke-width="52">
			<path d="M256 400V616M768 400V616M126 512h14M884 512h14"/>
			<path d="M512 228V796"/>
		</g>
		<path d="M382 690V338l130 130 130-130v352" stroke="#fff" stroke-width="82"/>
		<path d="M382 690V338l130 130 130-130v352" stroke="#0b0b0b" stroke-width="60"/>
	</g>
</svg>`

/** Two faders — the bridge's icon, redrawn as inline SVG. */
const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
	<path d="M9 3v18M15 3v18"/><rect x="6" y="7" width="6" height="3.4" rx="1.2" fill="currentColor" stroke="none"/>
	<rect x="12" y="13" width="6" height="3.4" rx="1.2" fill="currentColor" stroke="none"/></svg>`

export function uploadPageHtml(m: UploadPageModel): string {
	const status = m.imported
		? `<section class="status ok" id="status">
				<p class="head"><span class="dot"></span>Show loaded</p>
				<p class="sub" id="current">${escapeHtml(m.imported)}</p>
			</section>
			<button type="button" class="wide" id="remove">Remove this show</button>`
		: `<section class="status idle" id="status">
				<p class="head"><span class="dot"></span>No show loaded</p>
				<p class="sub" id="current">Scene names live only in the show file — the console cannot be asked for them over MIDI.</p>
			</section>`
	const advanced = m.path
		? `<h2 class="sec">Advanced</h2>
			<section class="card muted">
				<p>This connection also has a show file path set:</p>
				<p><code>${escapeHtml(m.path)}</code></p>
				<p>An uploaded show takes precedence over it.</p>
			</section>`
		: ''
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Show file — ${escapeHtml(m.label)}</title>
<style>
	:root {
		color-scheme: dark;
		--bg:#0d0f12; --card:#191c21; --inset:#141binvalid; --line:#282c33;
		--text:#e6e8ec; --dim:#8a9099; --faint:#6b7178;
		--blue:#4a7fe0; --blue-hi:#5b8ee8; --green:#4ade80; --red:#e5645b;
		--btn:#2b2f36; --btn-hi:#343941; --btn-line:#383d45;
	}
	* { box-sizing:border-box }
	html, body { background:var(--bg) }
	body { margin:0; color:var(--text); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif }
	.panel { max-width:30rem; margin:0 auto; min-height:100vh; background:var(--bg);
	         border-left:1px solid var(--line); border-right:1px solid var(--line) }

	header { display:flex; align-items:center; gap:1rem; padding:1.35rem 1.5rem;
	         background:linear-gradient(105deg,#4a86e8,#4066cf); color:#fff }
	header .tile { flex:none; width:3rem; height:3rem; border-radius:.8rem; background:#ffffff28;
	               display:grid; place-items:center; color:#fff }
	header .tile svg { width:1.7rem; height:1.7rem }
	header .who { flex:1; min-width:0 }
	header h1 { margin:0; font-size:1.3rem; font-weight:700; letter-spacing:-.01em }
	header p { margin:.15rem 0 0; font-size:.9rem; color:#ffffffc4; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
	header .brand { flex:none; text-align:center; color:#fff }
	header .brand .mark { width:2.7rem; height:2.7rem; margin:0 auto }
	header .brand .mark svg { width:100%; height:100%; display:block }
	header .brand span { display:block; margin-top:.4rem; font-size:.55rem; letter-spacing:.16em; color:#ffffffd0 }

	main { padding:1.25rem }
	.sec { margin:1.6rem 0 .6rem; font-size:.7rem; font-weight:600; letter-spacing:.13em;
	       text-transform:uppercase; color:var(--faint) }
	.sec:first-child { margin-top:0 }
	.card, .status { background:var(--card); border:1px solid var(--line); border-radius:.65rem; padding:1rem 1.15rem }
	.status { margin-bottom:.9rem }
	.status .head { margin:0; font-size:1.15rem; font-weight:700; display:flex; align-items:center; gap:.6rem }
	.status .sub { margin:.35rem 0 0; font-size:.85rem; color:var(--dim) }
	.status .dot { width:.6rem; height:.6rem; border-radius:50%; background:currentColor; flex:none }
	.status.ok { background:#18301fcc; border-color:#4ade8038 } .status.ok .head { color:var(--green) }
	.status.idle .head { color:var(--dim) }

	.wide { display:block; width:100%; margin-bottom:.75rem; padding:.85rem 1rem; border-radius:.65rem;
	        background:var(--btn); border:1px solid var(--btn-line); color:var(--text);
	        font:inherit; font-size:1rem; font-weight:500; cursor:pointer; text-align:center }
	.wide:hover:not([disabled]) { background:var(--btn-hi) }
	.wide[disabled] { opacity:.45; cursor:default }
	.wide.primary { background:var(--blue); border-color:var(--blue) }
	.wide.primary:hover:not([disabled]) { background:var(--blue-hi) }
	.chosen { margin:.1rem 0 .75rem; font-size:.85rem; color:var(--dim); text-align:center;
	          overflow:hidden; text-overflow:ellipsis; white-space:nowrap }

	.log { background:#12151a; border:1px solid var(--line); border-radius:.65rem; padding:.85rem 1rem;
	       font:12.5px/1.75 ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--dim);
	       max-height:13rem; overflow:auto }
	.log div:last-child { color:var(--text); font-weight:600 }
	.log .warn { color:#e0b25c } .log .err { color:var(--red) }
	progress { width:100%; height:.4rem; margin:.25rem 0 .75rem; accent-color:var(--blue) }

	.card.muted, .card.muted p { color:var(--dim); font-size:.85rem }
	.card p { margin:.4rem 0 } .card p:first-child { margin-top:0 } .card p:last-child { margin-bottom:0 }
	code { background:#0006; padding:.12em .4em; border-radius:3px; font-size:.92em; word-break:break-all }
	footer { margin-top:1.75rem; padding-top:1.1rem; border-top:1px solid var(--line);
	         font-size:.72rem; line-height:1.6; color:var(--faint); text-align:center }
	[hidden] { display:none !important }
</style>
</head>
<body>
<div class="panel">
	<header>
		<div class="tile">${ICON}</div>
		<div class="who">
			<h1>Show file</h1>
			<p>${escapeHtml(m.label)}</p>
		</div>
		<div class="brand">
			<div class="mark">${LOGO}</div>
			<span>DYLANMAUDIO</span>
		</div>
	</header>

	<main>
		${status}

		<h2 class="sec">Load a show</h2>
		<input type="file" id="file" accept=".tar.gz,.tgz,.gz,.dlive" hidden>
		<button type="button" class="wide" id="pick">Choose show file…</button>
		<p class="chosen" id="chosen" hidden></p>
		<button type="button" class="wide primary" id="send" hidden>Load show</button>
		<progress id="bar" max="100" value="0" hidden></progress>

		<h2 class="sec" id="activityHead" hidden>Activity</h2>
		<div class="log" id="log" hidden></div>

		${advanced}

		<h2 class="sec">What is kept</h2>
		<section class="card muted">
			<p>The show is read here and only its <strong>scene names</strong> and <strong>Actions table</strong>
			are kept, in this connection's settings. The file itself is not stored and never leaves this computer.</p>
			<p>Scene names and Actions typed into the connection settings still win over a loaded show.</p>
		</section>

		<footer>
			Independent product — not affiliated with or endorsed by Allen &amp; Heath Ltd.
			dLive is a trademark of Allen &amp; Heath Ltd.
		</footer>
	</main>
</div>
<script>
const BASE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/'
const RAW_CHUNK = ${RAW_CHUNK}
const MAX = ${MAX_UPLOAD_BYTES}
const $ = (id) => document.getElementById(id)
let asJson = false

$('pick').addEventListener('click', () => $('file').click())
$('file').addEventListener('change', () => {
	const f = $('file').files[0]
	$('chosen').hidden = !f
	$('chosen').textContent = f ? f.name + ' — ' + size(f.size) : ''
	$('send').hidden = !f
})
$('send').addEventListener('click', () => { void send() })
if ($('remove')) $('remove').addEventListener('click', () => { void remove() })

function log(text, cls) {
	$('log').hidden = false
	$('activityHead').hidden = false
	const line = document.createElement('div')
	if (cls) line.className = cls
	line.textContent = new Date().toTimeString().slice(0, 8) + '  ' + text
	$('log').append(line)
	$('log').scrollTop = $('log').scrollHeight
}

function setStatus(kind, head, sub) {
	const s = $('status')
	s.className = 'status ' + kind
	s.querySelector('.head').innerHTML = '<span class="dot"></span>'
	s.querySelector('.head').append(head)
	$('current').textContent = sub
}

function size(n) {
	return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(2) + ' MB'
}

function b64(bytes) {
	let s = ''
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
	return btoa(s)
}

async function post(url, chunk) {
	const opts = asJson
		? { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ data: chunk }) }
		: { method:'POST', headers:{'Content-Type':'text/plain'}, body: chunk }
	const res = await fetch(url, opts)
	let body = {}
	try { body = await res.json() } catch (e) { body = { error: 'Unreadable reply from the module' } }
	return { res, body }
}

async function send() {
	const file = $('file').files[0]
	if (!file) return
	if (file.size > MAX) return log('That file is ' + size(file.size) + '; the limit is ' + (MAX / 1048576) + ' MB', 'err')
	$('send').disabled = true
	$('pick').disabled = true
	$('bar').hidden = false
	$('bar').value = 0
	log('Reading ' + file.name)
	try {
		const bytes = new Uint8Array(await file.arrayBuffer())
		const total = Math.max(1, Math.ceil(bytes.length / RAW_CHUNK))
		const id = Math.random().toString(36).slice(2, 12) + Date.now().toString(36)
		log('Sending ' + total + ' part' + (total === 1 ? '' : 's'))
		for (let part = 0; part < total; part++) {
			const chunk = b64(bytes.subarray(part * RAW_CHUNK, (part + 1) * RAW_CHUNK))
			const url = BASE + 'upload?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(file.name) +
			            '&part=' + part + '&total=' + total
			let r = await post(url, chunk)
			// Some hosts' body parsers only accept JSON; switch once and retry this part.
			if (!r.res.ok && !asJson && /body/i.test(r.body.error || '')) { asJson = true; r = await post(url, chunk) }
			if (!r.res.ok) throw new Error(r.body.error || ('Upload failed (HTTP ' + r.res.status + ')'))
			$('bar').value = ((part + 1) / total) * 100
			if (r.body.done) return done(r.body)
		}
		throw new Error('The module never reported the show as complete')
	} catch (e) {
		// The status card says what IS loaded, so a failed load must not overwrite
		// it — otherwise the failure hides the show that is still in use. The bold
		// red last line of the activity log carries the failure instead.
		log(e.message, 'err')
	} finally {
		$('bar').hidden = true
		$('send').disabled = false
		$('pick').disabled = false
	}
}

function done(b) {
	for (const w of b.warnings || []) log(w, 'warn')
	log(b.scenes + ' scene name' + (b.scenes === 1 ? '' : 's') + ', ' +
	    b.actions + ' Action' + (b.actions === 1 ? '' : 's') +
	    (b.baseChannel ? ', base MIDI channel ' + b.baseChannel : ''))
	setStatus('ok', 'Show loaded', b.summary)
	// Clear the picker: the file has been read, and leaving it staged invites a
	// second pointless upload of the same show.
	$('file').value = ''
	$('chosen').hidden = true
	$('send').hidden = true
	if (!$('remove')) location.reload() // the Remove button only exists once something is loaded
}

async function remove() {
	const { res, body } = await post(BASE + 'remove', '')
	if (!res.ok) return log(body.error || 'Could not remove the show', 'err')
	location.reload()
}
</script>
</body>
</html>`
}
