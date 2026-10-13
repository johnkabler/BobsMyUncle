// Single-file live viewer. Renders Mermaid diagrams from /api/diagram and live-updates over SSE.
export const UI_HTML = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>bmu — live UML</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --bg:#0f1115; --panel:#171a21; --text:#e6e6e6; --muted:#8a90a0; --red:#ff6b6b; --amber:#f5b041; --green:#5bd175; --accent:#6ea8fe; }
  * { box-sizing: border-box } body { margin:0; font:13px/1.45 ui-sans-serif,system-ui,-apple-system; background:var(--bg); color:var(--text); display:grid; grid-template-columns: 1fr 380px; grid-template-rows: auto 1fr; height:100vh }
  header { grid-column: 1 / 3; padding:8px 14px; background:var(--panel); border-bottom:1px solid #262a33; display:flex; gap:14px; align-items:center }
  header b { color:var(--accent) } #summary { color:var(--muted) } #crumbs a { color:var(--accent); cursor:pointer; text-decoration:none } #crumbs span{color:var(--muted)}
  main { overflow:auto; padding:12px; background:#fff; } main svg { max-width:none !important }
  aside { overflow:auto; background:var(--panel); border-left:1px solid #262a33; padding:10px }
  .f { padding:6px 8px; border-radius:6px; margin-bottom:6px; background:#1d212a; cursor:pointer; border-left:3px solid var(--muted) }
  .f.high { border-color:var(--red) } .f.medium { border-color:var(--amber) } .f.low { border-color:#666 }
  .f .id { color:var(--muted); font-family:ui-monospace,monospace; font-size:11px } .new { color:var(--red); font-weight:600; font-size:11px; margin-left:4px }
  pre { white-space:pre-wrap; font:12px/1.4 ui-monospace,monospace; background:#11141a; padding:8px; border-radius:6px }
  button, select { background:#222733; color:var(--text); border:1px solid #333a48; border-radius:5px; padding:3px 8px }
  #log div { color:var(--muted); font-family:ui-monospace,monospace; font-size:11px }
  h3 { margin:10px 0 6px; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em }
</style></head>
<body>
<header><b>bmu</b><span id="crumbs"></span>
  <select id="view"><option value="auto">auto</option><option value="components">components</option><option value="classes">classes</option></select>
  <select id="proposal"><option value="">real code</option></select>
  <span id="summary">loading…</span></header>
<main id="canvas"></main>
<aside>
  <h3>Findings</h3><label><input type="checkbox" id="onlyNew"> only new since baseline</label>
  <div id="findings"></div>
  <h3>Details</h3><pre id="details">Click a node or finding.</pre>
  <h3>Live</h3><div id="log"></div>
</aside>
<script src="/mermaid.min.js"></script>
<script type="module">
const mermaid = window.mermaid
window.addEventListener('error', (e) => { document.getElementById('details').textContent = 'UI error: ' + e.message })
window.addEventListener('unhandledrejection', (e) => { document.getElementById('details').textContent = 'UI error: ' + (e.reason && e.reason.message || e.reason) })
mermaid.initialize({ startOnLoad:false, securityLevel:'loose', maxTextSize: 500000, flowchart:{ htmlLabels:true, useMaxWidth:false }, class:{ useMaxWidth:false }, theme:'default' })
let level = new URLSearchParams(location.search).get('level') || ''
const $ = (id) => document.getElementById(id)
async function api(p){ const r = await fetch(p); return r.json() }
function crumbs(){
  const parts = level ? level.split('/') : []
  let html = '<a data-l="">root</a>'
  parts.forEach((p,i)=>{ const l = parts.slice(0,i+1).join('/'); html += ' <span>/</span> <a data-l="'+l+'">'+p+'</a>' })
  $('crumbs').innerHTML = html
  $('crumbs').querySelectorAll('a').forEach(a => a.onclick = () => go(a.dataset.l))
}
function go(l){ level = l; history.replaceState(null,'','?level='+encodeURIComponent(l)); render() }
let seq = 0
async function render(){
  crumbs()
  const view = $('view').value
  const prop = $('proposal').value
  const { mermaid: src, report } = await api('/api/diagram?level='+encodeURIComponent(level)+'&view='+view+(prop ? '&proposal='+encodeURIComponent(prop) : ''))
  if (report) $('details').textContent = report
  if (!src) { $('canvas').textContent = 'waiting for first scan…'; return }
  $('canvas').textContent = 'rendering…'
  const withClicks = src
  try {
    const { svg, bindFunctions } = await mermaid.render('d' + (++seq), withClicks)
    $('canvas').innerHTML = svg; bindFunctions?.($('canvas'))
  } catch (e) { $('canvas').innerHTML = '<pre>'+String(e)+'\\n\\n'+src.replace(/</g,'&lt;')+'</pre>' }
}
window.bmuOpen = async (path) => {
  const { text } = await api('/api/explain?target='+encodeURIComponent(path))
  $('details').textContent = text
  if (path.includes('#')) return            // element: details only
  if (/\\.[a-z]+$/.test(path)) { $('view').value = 'classes'; go(path); return } // file: its classes
  go(path)                                  // directory: drill down
}
async function refreshState(){
  const s = await api('/api/state')
  if (!s.ready) return
  $('summary').textContent = s.summary
  const only = $('onlyNew').checked
  $('findings').innerHTML = s.findings.filter(f => !only || f.isNew).slice(0,200).map(f =>
    '<div class="f '+f.severity+'" data-id="'+f.id+'"><span class="id">'+f.id+'</span>'+(f.isNew?'<span class="new">NEW</span>':'')+(f.status==='acked'?' <span class="id">(acked)</span>':'')+'<br>'+f.message.replace(/</g,'&lt;')+'</div>').join('')
  $('findings').querySelectorAll('.f').forEach(el => el.onclick = async () => { const { text } = await api('/api/explain?target='+el.dataset.id); $('details').textContent = text })
}
$('view').onchange = render; $('onlyNew').onchange = refreshState; $('proposal').onchange = render
api('/api/proposals').then(ps => { for (const p of ps) { const o = document.createElement('option'); o.value = p; o.textContent = 'proposal: ' + p; $('proposal').append(o) } })
const es = new URLSearchParams(location.search).has('nolive') ? null : new EventSource('/events')
es?.addEventListener('update', (e) => { const d = JSON.parse(e.data); for (const l of d.lines) { const div = document.createElement('div'); div.textContent = new Date().toLocaleTimeString()+' '+l; $('log').prepend(div) } refreshState(); render() })
refreshState(); render()
</script></body></html>`
