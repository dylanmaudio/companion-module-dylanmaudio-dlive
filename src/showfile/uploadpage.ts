/**
 * The HTML served at the module's own HTTP endpoint. Self-contained: no
 * external CSS, fonts or scripts, since Companion serves this from its own
 * web server and a show-file page has no business reaching the internet.
 *
 * The client slices the file on 3-byte boundaries before base64-encoding it,
 * so every chunk is valid base64 on its own and the server can concatenate
 * them before a single decode. RAW_CHUNK is CHUNK_CHARS/4*3 for that reason —
 * change one and the other follows.
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

export function uploadPageHtml(m: UploadPageModel): string {
	const current = m.imported
		? `<p class="ok" id="current">Loaded: <strong>${escapeHtml(m.imported)}</strong></p>
		   <p><button type="button" class="link" id="remove">Remove this show</button></p>`
		: `<p class="muted" id="current">No show loaded. Scene names come only from a show file — the console cannot be asked for them over MIDI.</p>`
	const pathNote = m.path
		? `<p class="muted">The connection also has a show file path set (<code>${escapeHtml(m.path)}</code>). An uploaded show takes precedence over it.</p>`
		: ''
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Show file — ${escapeHtml(m.label)}</title>
<style>
	:root { color-scheme: dark light; --bg:#1a1c1e; --card:#232629; --line:#33383d; --text:#e6e8ea; --dim:#9aa1a8; --ok:#4ec26f; --err:#e5645b; --accent:#4a8ede; }
	* { box-sizing: border-box }
	body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--text);
	       font:15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif }
	main { max-width:38rem; margin:0 auto }
	h1 { font-size:1.35rem; margin:0 0 .25rem }
	h1 + p { margin:0 0 1.5rem; color:var(--dim) }
	section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:1.25rem; margin-bottom:1rem }
	p { margin:.5rem 0 }
	.muted { color:var(--dim) }
	.ok { color:var(--ok) }
	.err { color:var(--err) }
	code { background:#0006; padding:.1em .35em; border-radius:3px; font-size:.9em }
	input[type=file] { width:100%; padding:.75rem; background:#0004; border:1px dashed var(--line);
	                   border-radius:6px; color:var(--text) }
	button { font:inherit; padding:.5rem 1rem; border-radius:6px; border:1px solid var(--accent);
	         background:var(--accent); color:#fff; cursor:pointer }
	button[disabled] { opacity:.5; cursor:default }
	button.link { background:none; border:none; color:var(--accent); padding:0; text-decoration:underline }
	progress { width:100%; height:.5rem; margin-top:1rem }
	dl { display:grid; grid-template-columns:auto 1fr; gap:.3rem 1rem; margin:.5rem 0 0 }
	dt { color:var(--dim) } dd { margin:0 }
	ul { margin:.5rem 0 0; padding-left:1.2rem; color:var(--dim) }
	[hidden] { display:none !important }
</style>
</head>
<body>
<main>
	<h1>Show file</h1>
	<p>${escapeHtml(m.label)}</p>

	<section>
		${current}
		${pathNote}
	</section>

	<section>
		<p>Choose a dLive show — the <code>.tar.gz</code> the console writes to USB, or one exported from Director.</p>
		<input type="file" id="file" accept=".tar.gz,.tgz,.gz,.dlive">
		<p><button type="button" id="send" disabled>Load show</button></p>
		<progress id="bar" max="100" value="0" hidden></progress>
		<p id="msg" hidden></p>
		<dl id="detail" hidden></dl>
		<ul id="warn" hidden></ul>
	</section>

	<section class="muted">
		<p>The file is read here and only its <strong>scene names</strong> and <strong>Actions table</strong> are
		kept, in this connection's settings. The show itself is not stored and never leaves this computer.</p>
	</section>
</main>
<script>
const BASE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/'
const RAW_CHUNK = ${RAW_CHUNK}
const MAX = ${MAX_UPLOAD_BYTES}
const $ = (id) => document.getElementById(id)
let asJson = false

$('file').addEventListener('change', () => { $('send').disabled = !$('file').files.length; hide() })
$('send').addEventListener('click', () => { void send() })
if ($('remove')) $('remove').addEventListener('click', () => { void remove() })

function hide() { for (const id of ['msg','detail','warn']) $(id).hidden = true }
function fail(text) { $('msg').hidden = false; $('msg').className = 'err'; $('msg').textContent = text }

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
	try { body = await res.json() } catch { body = { error: 'Unreadable reply from the module' } }
	return { res, body }
}

async function send() {
	const file = $('file').files[0]
	if (!file) return
	hide()
	if (file.size > MAX) return fail('That file is ' + (file.size / 1048576).toFixed(1) + ' MB; the limit is ' + (MAX / 1048576) + ' MB.')
	$('send').disabled = true
	$('bar').hidden = false
	$('bar').value = 0
	try {
		const bytes = new Uint8Array(await file.arrayBuffer())
		const total = Math.max(1, Math.ceil(bytes.length / RAW_CHUNK))
		const id = Math.random().toString(36).slice(2, 12) + Date.now().toString(36)
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
		fail(e.message)
	} finally {
		$('bar').hidden = true
		$('send').disabled = false
	}
}

function done(b) {
	$('msg').hidden = false
	$('msg').className = 'ok'
	$('msg').textContent = 'Loaded ' + b.name
	const d = $('detail')
	d.hidden = false
	d.innerHTML = ''
	const rows = [['Scene names', b.scenes], ['Actions', b.actions]]
	if (b.baseChannel) rows.push(['Base MIDI channel', b.baseChannel])
	for (const [k, v] of rows) {
		const dt = document.createElement('dt'); dt.textContent = k
		const dd = document.createElement('dd'); dd.textContent = String(v)
		d.append(dt, dd)
	}
	const w = $('warn')
	w.innerHTML = ''
	w.hidden = !(b.warnings && b.warnings.length)
	for (const line of b.warnings || []) { const li = document.createElement('li'); li.textContent = line; w.append(li) }
	$('current').className = 'ok'
	$('current').innerHTML = ''
	$('current').append('Loaded: ', Object.assign(document.createElement('strong'), { textContent: b.summary }))
}

async function remove() {
	const { res, body } = await post(BASE + 'remove', '')
	if (!res.ok) return fail(body.error || 'Could not remove the show')
	location.reload()
}
</script>
</body>
</html>`
}
