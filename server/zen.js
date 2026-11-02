// NexBlue Zen (lastbalanserare) — husets förbrukning via NexBlue-portalens API (my.nexblue.com), skrivskyddat.
// Det officiella third_party-API:t (nexblue.js) ser bara laddboxen, så Zen läses via portalens egna endpoints.
// Odokumenterat och inofficiellt: kan ändras utan förvarning. Se hubben:
// projects/home-dashboard/agentops/investigations/2026-11-02-nexblue-portal-api-zen.md
//
// Sparar husets medeleffekt per minut som CONSUMPTION_SENSOR (standard hus_effekt, kW) i `readings`, vilket
// förbrukningsklockan (consumption.js) räknar kvartsmedel av. Mätaren `energy` stegar bara en gång per timme och sparas
// därför bara när den ändras (hus_energi_total, kWh); kvartsenergi ska alltid räknas från effekten.
//
// Portalkontot är inte nödvändigtvis samma som NEXBLUE_USERNAME/NEXBLUE_PASSWORD (third_party), därför egna variabler.
// Anropar aldrig skrivande endpoints (PUT /detector, clear_detector_energy m.fl.).
const crypto = require('crypto');
const db = require('./db');

const BASE_URL = (process.env.NEXBLUE_PORTAL_BASE_URL || 'https://api.nexblue.com').replace(/\/$/, '');
const USERNAME = process.env.NEXBLUE_PORTAL_USERNAME;
const PASSWORD = process.env.NEXBLUE_PORTAL_PASSWORD;
const DETECTOR_SN = process.env.NEXBLUE_DETECTOR_SN;
// Varje anrop hämtar alla minutpunkter sedan sist, så längre intervall ger inga luckor, bara ett äldre "nu"-värde.
const POLL_MS = Math.max(Number(process.env.NEXBLUE_PORTAL_POLL_SECONDS) || 300, 30) * 1000;
// Hur långt bakåt historik hämtas vid start eller efter avbrott (timmar, 0–72).
const BACKFILL_HOURS = Math.min(Math.max(Number(process.env.NEXBLUE_PORTAL_BACKFILL_HOURS ?? 24) || 0, 0), 72);
const ENABLED = Boolean(USERNAME && PASSWORD && DETECTOR_SN);

const POWER_SENSOR = process.env.CONSUMPTION_SENSOR || 'hus_effekt';
const ENERGY_SENSOR = 'hus_energi_total';
const TOPIC = 'nexblue/zen';

const DAY_S = 86400;
const MAX_AUTH_FAILURES = 3; // därefter väntar vi längre mellan inloggningsförsök så kontot inte spärras
const AUTH_RETRY_MS = 30 * 60 * 1000;

let token = { id: null, expiresAt: 0 };
let authFailures = 0;
let lastAuthAttempt = 0;
let lastTsMs = null; // senaste lagrade minutpunkt för POWER_SENSOR
let lastEnergy = null;
let busy = false;

class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

// Portalens lösenordsformat: md5(base64(lösenord)) som hex.
const portalPassword = (pw) => crypto.createHash('md5').update(Buffer.from(pw.trim()).toString('base64')).digest('hex');

async function post(path, body, authorization) {
  const headers = { 'Content-Type': 'application/json;charset=UTF-8' };
  if (authorization) headers.Authorization = authorization; // råa IdToken, utan "Bearer"
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    let code;
    try { code = (await res.json()).code; } catch { /* inte JSON */ }
    // Svarskropp, token och detektor-ID loggas aldrig.
    const where = path.startsWith('/detector/') ? '/detector/<sn>/…' : path;
    throw new ApiError(`NexBlue portal HTTP ${res.status} på ${where}${code !== undefined ? ` (felkod ${code})` : ''}`, res.status, code);
  }
  return res.json();
}

async function login() {
  lastAuthAttempt = Date.now();
  try {
    const out = await post('/accounts/get_token', {
      username: USERNAME.trim(), password: portalPassword(PASSWORD), confirm_password: '', code: '',
    });
    if (!out || !out.IdToken) throw new ApiError('NexBlue portal: inloggningen gav ingen IdToken', 0);
    token = { id: out.IdToken, expiresAt: Date.now() + Math.max(Number(out.ExpiresIn || 0) - 300, 60) * 1000 };
    authFailures = 0;
  } catch (err) {
    // Bara avslag från servern räknas (fel lösenord m.m.), inte nätverksfel.
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) authFailures += 1;
    throw err;
  }
}

async function ensureToken() {
  if (token.id && Date.now() < token.expiresAt) return;
  if (authFailures >= MAX_AUTH_FAILURES && Date.now() - lastAuthAttempt < AUTH_RETRY_MS) {
    throw new Error(`NexBlue portal: ${authFailures} misslyckade inloggningar i rad, väntar innan nästa försök (kontrollera NEXBLUE_PORTAL_USERNAME/PASSWORD)`);
  }
  await login();
}

async function fetchMinuteData(startS, endS) {
  const call = async () => {
    await ensureToken();
    return post(`/detector/${encodeURIComponent(DETECTOR_SN)}/get_detector_data_log`,
      { start_timestamp: String(startS), end_timestamp: String(endS) }, token.id);
  };
  let out;
  try {
    out = await call();
  } catch (err) {
    if (!(err instanceof ApiError) || (err.status !== 401 && err.status !== 403)) throw err;
    token = { id: null, expiresAt: 0 }; // token avvisad: logga in på nytt en gång
    out = await call();
  }
  return Array.isArray(out && out.result) ? out.result : [];
}

// Gör om portalens punkter till readings-rader. Bara punkter nyare än `after` (epoch-ms) tas med.
function toReadings(points, after) {
  const byTs = new Map();
  for (const p of points) {
    const ts = Number(p.timestamp) * 1000;
    if (Number.isFinite(ts) && ts > (after ?? 0)) byTs.set(ts, p);
  }
  const rows = [];
  let energy = lastEnergy;
  for (const ts of [...byTs.keys()].sort((a, b) => a - b)) {
    const p = byTs.get(ts);
    const power = Number(p.power);
    if (p.power !== undefined && p.power !== null && Number.isFinite(power)) {
      rows.push({ sensor: POWER_SENSOR, topic: TOPIC, value: power, unit: 'kW', ts });
    }
    const e = Number(p.energy);
    if (p.energy !== undefined && p.energy !== null && Number.isFinite(e) && e !== energy) {
      rows.push({ sensor: ENERGY_SENSOR, topic: TOPIC, value: e, unit: 'kWh', ts });
      energy = e;
    }
  }
  return { rows, energy };
}

async function pollOnce(io) {
  const nowS = Math.floor(Date.now() / 1000);
  const oldestS = nowS - Math.max(BACKFILL_HOURS * 3600, 600);
  // Normalt några minuter bakåt (5 min överlapp); efter ett avbrott eller vid första start upp till BACKFILL_HOURS.
  const fromS = lastTsMs === null ? oldestS : Math.max(Math.floor(lastTsMs / 1000) - 300, oldestS);

  const points = [];
  for (let s = fromS; s < nowS; s += DAY_S) {
    points.push(...(await fetchMinuteData(s, Math.min(s + DAY_S, nowS + 60))));
  }

  const { rows, energy } = toReadings(points, lastTsMs);
  if (!rows.length) return;
  await db.insertReadings(rows);
  lastEnergy = energy;
  const power = rows.filter((r) => r.sensor === POWER_SENSOR);
  if (power.length) lastTsMs = power[power.length - 1].ts;

  // Live-uppdatering: bara senaste värdet per sensor (historiken hämtas ur databasen).
  for (const sensor of [POWER_SENSOR, ENERGY_SENSOR]) {
    const last = [...rows].reverse().find((r) => r.sensor === sensor);
    if (last) io.emit('update', { sensor, value: last.value, unit: last.unit, ts: last.ts });
  }
}

function startZen(io) {
  if (!ENABLED) {
    console.log('[zen] avstängd (sätt NEXBLUE_PORTAL_USERNAME, NEXBLUE_PORTAL_PASSWORD och NEXBLUE_DETECTOR_SN)');
    return;
  }
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (lastTsMs === null) lastTsMs = await db.getLastReadingTs(POWER_SENSOR);
      await pollOnce(io);
    } catch (err) {
      console.error('[zen] poll failed:', err.message);
    } finally {
      busy = false;
    }
  };
  console.log(`[zen] aktiv (var ${POLL_MS / 1000}:e s, backfill ${BACKFILL_HOURS} h, sensor ${POWER_SENSOR})`);
  tick();
  setInterval(tick, POLL_MS);
}

module.exports = { startZen, toReadings, portalPassword };
