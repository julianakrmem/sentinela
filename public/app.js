// Painel de enfermagem — JavaScript puro, sem build.
const RANK = { NONE: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const PRIORITY_PT = { NONE: 'ESTÁVEL', MEDIUM: 'MÉDIO', HIGH: 'ALTO', CRITICAL: 'CRÍTICO' };
const ALERT_PT = { CRITICAL: 'Crítico', HIGH: 'Alto', MEDIUM: 'Médio', INFO: 'Info' };
const TREND_PT = {
  deteriorating: '↗ piora', improving: '↘ melhora', stable: '→ estável', insufficient: '· coletando',
};
const VITALS = [
  ['FC', 'pulse', (v) => `${v.hr}`],
  ['SpO2', 'spo2', (v) => `${v.spo2}%${v.onOxygen ? ' O₂' : ''}`],
  ['PA', 'systolic', (v) => `${v.sbp}/${v.dbp ?? '–'}`],
  ['FR', 'respiration', (v) => `${v.rr}`],
  ['Temp', 'temperature', (v) => `${v.temp.toFixed(1)}°`],
  ['Consc.', 'consciousness', (v) => v.consciousness],
];
const MAX_ALERTS = 200;
const HISTORY = 60;

const $ = (id) => document.getElementById(id);
const bedsEl = $('beds');
const alertsEl = $('alerts');
const tpl = $('bed-tpl');
const beds = new Map(); // bedId -> { data, el, history: number[] }
const alertEls = new Map(); // alertId -> li
let ws;

const nurseInput = $('nurse');
nurseInput.value = localStorageSafe('get', 'sentinela.nurse') ?? '';
nurseInput.addEventListener('change', () => localStorageSafe('set', 'sentinela.nurse', nurseInput.value));
$('only-alert').addEventListener('change', applyFilter);

function localStorageSafe(op, key, value) {
  try { return op === 'get' ? localStorage.getItem(key) : localStorage.setItem(key, value); } catch { return null; }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/dashboard`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 2000); };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function setConn(on) {
  const el = $('conn');
  el.className = `conn ${on ? 'on' : 'off'}`;
  el.textContent = on ? 'ao vivo' : 'reconectando…';
}

function handle(msg) {
  switch (msg.type) {
    case 'snapshot':
      beds.forEach((b) => b.el.remove());
      beds.clear();
      alertsEl.innerHTML = '';
      alertEls.clear();
      msg.beds.forEach(upsertBed);
      [...msg.alerts].reverse().forEach((a) => addAlert(a, false));
      break;
    case 'beds':
      msg.beds.forEach(upsertBed);
      break;
    case 'alert':
      addAlert(msg.alert, true);
      break;
    case 'ack':
      markAcked(msg.alertId, msg.by, msg.at);
      break;
    case 'discharge': {
      const b = beds.get(msg.bedId);
      if (b) { b.el.remove(); beds.delete(msg.bedId); }
      break;
    }
  }
  refreshKpis();
}

function upsertBed(s) {
  let b = beds.get(s.bedId);
  if (!b) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.querySelector('.ack').addEventListener('click', () => ack(s.bedId));
    bedsEl.appendChild(el);
    b = { el, history: [] };
    beds.set(s.bedId, b);
  }
  if (!b.data || b.data.updatedAt !== s.updatedAt) {
    b.history.push(s.news2);
    if (b.history.length > HISTORY) b.history.shift();
  }
  b.data = s;
  render(b);
}

function render({ el, data: s, history }) {
  el.className = `bed p-${s.priority} r-${s.risk}`
    + (s.acknowledged ? ' acked' : '')
    + (s.priority !== 'NONE' && !s.acknowledged ? ' needs-ack' : '')
    + (s.signalLost ? ' lost' : '');
  el.style.order = String(-(RANK[s.priority] * 1000 + s.news2 * 10 + (s.signalLost ? 5 : 0)));
  el.querySelector('.label').textContent = s.label;
  el.querySelector('.patient').textContent = s.patient ?? '';
  el.querySelector('.badge').textContent = PRIORITY_PT[s.priority];
  el.querySelector('.score .n').textContent = s.news2;
  const tr = el.querySelector('.trend');
  tr.className = `trend ${s.trend}`;
  tr.textContent = TREND_PT[s.trend];
  el.querySelector('.vitals').innerHTML = VITALS.map(([label, param, f]) => {
    const sub = s.subscores[param] ?? 0;
    return `<div class="s${sub}"><dt>${label}</dt><dd>${f(s.vitals)}</dd></div>`;
  }).join('');
  el.querySelector('.updated').textContent = new Date(s.updatedAt).toLocaleTimeString('pt-BR');
  const max = 20;
  const pts = history.map((v, i) => {
    const x = history.length === 1 ? 100 : (i / (history.length - 1)) * 100;
    return `${x.toFixed(1)},${(30 - (Math.min(v, max) / max) * 28 - 1).toFixed(1)}`;
  }).join(' ');
  el.querySelector('.spark polyline').setAttribute('points', pts);
  el.hidden = $('only-alert').checked && s.priority === 'NONE' && !s.signalLost;
}

function applyFilter() { beds.forEach(render); }

function addAlert(a, live) {
  if (alertEls.has(a.id) && a.kind === 'REMINDER') alertEls.get(a.id).remove();
  const li = document.createElement('li');
  li.className = `alert ${a.priority}` + (a.ack ? ' acked' : '');
  const label = beds.get(a.bedId)?.data?.label ?? a.bedId;
  li.innerHTML = `
    <div class="row"><strong><span class="pill ${a.priority}">${ALERT_PT[a.priority]}</span> ${esc(label)}</strong>
      <time>${new Date(a.createdAt).toLocaleTimeString('pt-BR')}</time></div>
    <div class="title">${esc(a.title)}</div>
    <ul>${a.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    ${a.recommendation && a.priority !== 'INFO' ? `<div class="rec">${esc(a.recommendation)}</div>` : ''}
    <div class="ackinfo">${a.ack ? `Reconhecido por ${esc(a.ack.by)}` : ''}</div>`;
  alertsEl.prepend(li);
  alertEls.set(a.id, li);
  while (alertsEl.children.length > MAX_ALERTS) alertsEl.lastElementChild.remove();
  if (live && a.priority === 'CRITICAL' && $('sound').checked) beep();
}

function markAcked(alertId, by) {
  const li = alertEls.get(alertId);
  if (!li) return;
  li.classList.add('acked');
  li.querySelector('.ackinfo').textContent = `Reconhecido por ${by}`;
}

function ack(bedId) {
  const b = beds.get(bedId);
  if (!b || ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'ack', bedId, alertId: b.data.activeAlertId, by: nurseInput.value || 'enfermagem' }));
}

function refreshKpis() {
  let crit = 0, high = 0, med = 0, lost = 0;
  beds.forEach(({ data }) => {
    if (data.signalLost) lost++;
    if (data.priority === 'CRITICAL') crit++;
    else if (data.priority === 'HIGH') high++;
    else if (data.priority === 'MEDIUM') med++;
  });
  $('k-beds').textContent = beds.size;
  $('k-crit').textContent = crit;
  $('k-high').textContent = high;
  $('k-med').textContent = med;
  $('k-lost').textContent = lost;
  $('empty').hidden = beds.size > 0;
}

async function pollStats() {
  try {
    const s = await (await fetch('/api/stats')).json();
    $('k-rps').textContent = s.readingsPerSecond;
    $('k-p95').textContent = s.processingMs.p95;
  } catch { /* servidor fora */ }
}
setInterval(pollStats, 2000);

let audio;
function beep() {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.4);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.4);
  } catch { /* sem áudio */ }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

connect();
pollStats();
