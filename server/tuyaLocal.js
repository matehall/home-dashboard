// Lokal Tuya-styrning (protokoll 3.3 över LAN, port 6668) för nätdrivna pluggar. Kostar inga molnanrop och ger push-uppdateringar.
// Nycklar och IP-adresser kommer ur filen som scripts/tuya-local-discover.js skriver (TUYA_LOCAL_FILE, standard data/tuya-local.json).
// Saknas filen eller anslutningen går allt via Tuya Cloud som förut. Nycklar skrivs aldrig i loggen.
const TuyAPI = require('tuyapi');
const fs = require('fs');
const path = require('path');

const FILE = process.env.TUYA_LOCAL_FILE || path.join(__dirname, 'data', 'tuya-local.json');
const DISABLED = process.env.TUYA_LOCAL === '0';
const FRESH_MS = 3 * 60 * 1000; // äldre värden räknas inte som lokala
const REFRESH_MS = 60 * 1000; // fråga aktivt så att effekten uppdateras även utan push, och döda anslutningar upptäcks
const MAX_BACKOFF_MS = 60 * 1000;

const conns = new Map(); // id -> { cfg, dev, dps, ts, connected, backoff, timer }
let keys = null;
let onChange = () => {};
let refreshTimer = null;

function loadKeys() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.log(`[tuya-lokal] ingen nyckelfil (${err.code || err.message}); allt går via molnet`);
    return {};
  }
}

function teardown(c) {
  if (!c.dev) return;
  c.dev.removeAllListeners();
  c.dev.on('error', () => {}); // svälj sena fel från den gamla anslutningen
  try { c.dev.disconnect(); } catch { /* redan nere */ }
  c.dev = null;
}

function retry(id) {
  const c = conns.get(id);
  if (!c || c.timer) return;
  c.connected = false;
  teardown(c);
  c.timer = setTimeout(() => { c.timer = null; connect(id); }, c.backoff);
  c.backoff = Math.min(c.backoff * 2, MAX_BACKOFF_MS);
}

function connect(id) {
  const c = conns.get(id);
  const dev = new TuyAPI({ id, key: c.cfg.local_key, ip: c.cfg.ip, version: String(c.cfg.version || '3.3'), issueRefreshOnConnect: true });
  c.dev = dev;
  const update = (d) => {
    if (!d || !d.dps) return;
    Object.assign(c.dps, d.dps);
    c.ts = Date.now();
    c.connected = true;
    onChange('1' in d.dps || 1 in d.dps);
  };
  dev.on('data', update);
  dev.on('dp-refresh', update);
  dev.on('connected', () => { c.connected = true; c.backoff = 5000; console.log(`[tuya-lokal] ansluten: ${c.cfg.name}`); });
  dev.on('disconnected', () => { console.log(`[tuya-lokal] frånkopplad: ${c.cfg.name}`); retry(id); });
  dev.on('error', (err) => { console.error(`[tuya-lokal] ${c.cfg.name}: ${err.message}`); });
  dev.connect().catch((err) => { console.error(`[tuya-lokal] kunde inte ansluta till ${c.cfg.name}: ${err.message}`); retry(id); });
}

// Anslut till de enheter (id) som finns i nyckelfilen. Kan anropas flera gånger; redan kända enheter hoppas över.
function startLocal(ids, change) {
  if (DISABLED) return;
  onChange = change;
  if (!keys) keys = loadKeys();
  for (const id of ids) {
    const cfg = keys[id];
    if (!cfg || !cfg.ip || !cfg.local_key || conns.has(id)) continue;
    conns.set(id, { cfg, dev: null, dps: {}, ts: 0, connected: false, backoff: 5000, timer: null });
    connect(id);
  }
  if (!refreshTimer && conns.size) {
    refreshTimer = setInterval(() => {
      for (const [id, c] of conns) {
        if (!c.connected || !c.dev) continue;
        c.dev.get({ schema: true }).then((d) => {
          if (d && d.dps) { Object.assign(c.dps, d.dps); c.ts = Date.now(); }
        }).catch((err) => { console.error(`[tuya-lokal] ${c.cfg.name} svarar inte: ${err.message}`); retry(id); });
      }
    }, REFRESH_MS);
  }
}

// Färska lokala datapunkter för en enhet, eller null om anslutningen saknas eller är gammal.
function getLocal(id) {
  const c = conns.get(id);
  if (!c || !c.connected || Date.now() - c.ts > FRESH_MS) return null;
  return { dps: { ...c.dps }, ts: c.ts };
}

async function setSwitchLocal(id, on) {
  const c = conns.get(id);
  if (!c || !c.connected || !c.dev) throw new Error('ingen lokal anslutning');
  await c.dev.set({ dps: 1, set: Boolean(on) });
}

module.exports = { startLocal, getLocal, setSwitchLocal };
