/* settings.js — the phone-facing control panel. Most inputs carry a data-path
   (e.g. "adhan.volume"); one generic handler turns a change into a nested PATCH
   to /api/config, which the server persists and pushes to the display via SSE. */

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let cfg = null;

boot();
async function boot() {
  cfg = await getJSON('/api/config');
  await Promise.all([populateMethods(), populateMuezzins()]);
  bindFields();
  renderLocation();
  renderMembers();
  renderEvents();
  wireLocationSearch();
  wireCalendar();
  wireAdhanTests();
  wireBackup();
}

// ---------- generic data-path fields ----------
function bindFields() {
  for (const el of $$('[data-path]')) {
    const path = el.dataset.path, type = el.dataset.type;
    const val = getPath(cfg, path);
    if (el.type === 'checkbox') el.checked = !!val;
    else if (val != null) el.value = val;
    const evt = (el.type === 'range') ? 'input' : 'change';
    el.addEventListener(evt, debounce(async () => {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (type === 'number') v = parseFloat(v) || 0;
      await patch(buildNested(path, v));
      if (path === 'clockStyle') { cfg.clockStyle = v; toggleClockFontRows(); }
    }, el.type === 'range' ? 250 : 0));
  }
  toggleClockFontRows();
}

// Each font picker only means anything for its own clock style — hide it
// otherwise instead of leaving a dead control on screen.
function toggleClockFontRows() {
  const neonRow = $('#row-clock-font'), standardRow = $('#row-standard-font');
  if (neonRow) neonRow.style.display = cfg.clockStyle === 'neon' ? '' : 'none';
  if (standardRow) standardRow.style.display = cfg.clockStyle === 'standard' ? '' : 'none';
}

async function populateMethods() {
  const info = await getJSON('/api/net-info');
  const sel = $('#method-sel');
  const nice = {
    MuslimWorldLeague: 'Muslim World League', Egyptian: 'Egyptian', Karachi: 'Karachi (Univ.)',
    UmmAlQura: 'Umm al-Qura (Makkah)', Dubai: 'Dubai', MoonsightingCommittee: 'Moonsighting Committee',
    NorthAmerica: 'ISNA (N. America)', Kuwait: 'Kuwait', Qatar: 'Qatar', Singapore: 'Singapore',
    Tehran: 'Tehran', Turkey: 'Turkey'
  };
  sel.innerHTML = (info?.methods || []).map((m) => `<option value="${m}">${nice[m] || m}</option>`).join('');
}

async function populateMuezzins() {
  const { files } = await getJSON('/api/audio-list') || { files: [] };
  const sel = $('#muezzin-sel');
  // muezzin = filename without the "-fajr" variant and .mp3
  const names = [...new Set(files.map((f) => f.replace(/\.mp3$/i, '')).filter((n) => !/-fajr$/i.test(n) && n !== 'iqamah'))];
  if (names.length === 0) {
    sel.innerHTML = '<option value="mishary">mishary (add files)</option>';
    $('#audio-note').textContent = 'No adhan files found. Drop MP3s into public/audio/ (e.g. mishary.mp3, mishary-fajr.mp3). See public/audio/README.';
  } else {
    sel.innerHTML = names.map((n) => `<option value="${n}">${n}</option>`).join('');
    $('#audio-note').textContent = `Found: ${files.join(', ')}`;
  }
}

// ---------- location ----------
function renderLocation() {
  $('#loc-current').textContent = 'Current: ' + (cfg.location?.name || '—');
  const auto = $('#loc-auto');
  if (auto) auto.checked = cfg.location?.auto !== false;
}
function wireLocationSearch() {
  const q = $('#loc-q'), box = $('#loc-results'), auto = $('#loc-auto');
  q.addEventListener('input', debounce(async () => {
    const term = q.value.trim();
    if (term.length < 2) { box.innerHTML = ''; return; }
    const j = await getJSON('/api/geocode?q=' + encodeURIComponent(term));
    box.innerHTML = (j?.results || []).map((r, i) =>
      `<button class="btn ghost full" data-i="${i}" style="text-align:left">${[r.name, r.admin1, r.country].filter(Boolean).join(', ')}</button>`).join('');
    box.querySelectorAll('button').forEach((b) => b.onclick = async () => {
      const r = j.results[+b.dataset.i];
      // Picking a place here means "use this" — turn off the display's own GPS
      // so it doesn't silently overwrite this choice on its next reload.
      const location = { name: [r.name, r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude, auto: false };
      await patch({ location });
      cfg.location = location;
      renderLocation(); box.innerHTML = ''; q.value = '';
    });
  }, 350));
  auto?.addEventListener('change', async () => {
    await patch({ location: { ...cfg.location, auto: auto.checked } });
    cfg.location = { ...cfg.location, auto: auto.checked };
  });
}

// ---------- members ----------
function renderMembers() {
  const list = $('#m-list');
  list.innerHTML = (cfg.members || []).map((m, i) =>
    `<span class="tag"><span class="swatch" style="background:${m.color}"></span>${esc(m.name)}${m.name !== 'Everyone' ? ` <span data-i="${i}" class="rm" style="cursor:pointer;color:var(--dim)">✕</span>` : ''}</span>`).join('');
  list.querySelectorAll('.rm').forEach((el) => el.onclick = async () => {
    cfg.members.splice(+el.dataset.i, 1); await patch({ members: cfg.members }); renderMembers(); populateEventMembers();
  });
  populateEventMembers();
}
function wireCalendar() {
  $('#m-add').onclick = async () => {
    const name = $('#m-name').value.trim(); if (!name) return;
    cfg.members = [...(cfg.members || []), { name, color: $('#m-color').value }];
    await patch({ members: cfg.members }); $('#m-name').value = ''; renderMembers();
  };
  $('#e-add').onclick = async () => {
    const title = $('#e-title').value.trim(), date = $('#e-date').value;
    if (!title || !date) { toast('Add a title and date'); return; }
    await postJSON('/api/events', { title, date, time: $('#e-time').value || null, memberName: $('#e-member').value, repeatYearly: $('#e-yearly').checked });
    cfg = await getJSON('/api/config');
    $('#e-title').value = ''; $('#e-date').value = ''; $('#e-time').value = ''; $('#e-yearly').checked = false;
    renderEvents(); toast('Event added');
  };
}
function populateEventMembers() {
  $('#e-member').innerHTML = '<option value="">Everyone</option>' +
    (cfg.members || []).filter((m) => m.name !== 'Everyone').map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
}
function renderEvents() {
  const list = $('#e-list');
  const evs = [...(cfg.events || [])].sort((a, b) => a.date.localeCompare(b.date));
  list.innerHTML = evs.length ? evs.map((ev) =>
    `<div class="list-row"><span>${esc(ev.title)} — ${ev.date}${ev.time ? ' ' + ev.time : ''}${ev.repeatYearly ? ' (yearly)' : ''}</span>
     <button class="btn danger" data-id="${ev.id}">Remove</button></div>`).join('')
    : '<div class="muted">No events yet.</div>';
  list.querySelectorAll('button[data-id]').forEach((b) => b.onclick = async () => {
    await fetch('/api/events?id=' + b.dataset.id, { method: 'DELETE' });
    cfg = await getJSON('/api/config'); renderEvents(); toast('Removed');
  });
}

// ---------- adhan tests ----------
function wireAdhanTests() {
  $('#test-adhan').onclick = () => { postJSON('/api/test-adhan', { which: 'regular' }); toast('Playing on display…'); };
  $('#test-fajr').onclick = () => { postJSON('/api/test-adhan', { which: 'fajr' }); toast('Playing Fajr on display…'); };
}

// ---------- backup ----------
function wireBackup() {
  $('#export').onclick = async () => {
    const data = await getJSON('/api/backup');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'clock-dock-backup.json'; a.click();
  };
  $('#import-btn').onclick = () => $('#import-file').click();
  $('#import-file').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      await fetch('/api/backup', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
      toast('Imported — reloading'); setTimeout(() => location.reload(), 800);
    } catch { toast('Invalid backup file'); }
  };
}

// ---------- api + utils ----------
async function patch(obj) { await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }); toast(); }
async function getJSON(u) { try { return await (await fetch(u)).json(); } catch { return null; } }
async function postJSON(u, b) { return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); }
function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function buildNested(p, v) { const o = {}; let cur = o; const ks = p.split('.'); ks.forEach((k, i) => { if (i === ks.length - 1) cur[k] = v; else cur = cur[k] = {}; }); return o; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
let toastT;
function toast(msg = 'Saved') { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1400); }
