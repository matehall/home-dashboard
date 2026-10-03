// NexBlue Edge 2 (elbilsladdare) — skrivskyddad poller.
// Endpoints enligt https://github.com/NexBlue-AB/nexblue-api (Python-klienten); här en liten Node-port.
// Utan NEXBLUE_API_BASE_URL körs en mock så UI:t går att utveckla utan API-åtkomst.
const db = require('./db');

// Standard-URL hämtad från Home Assistants NexBlue-integration (const.py: DEFAULT_API_URL).
const DEFAULT_BASE_URL = 'https://api.nexblue.com/third_party';
const BASE_URL = (process.env.NEXBLUE_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
const USERNAME = process.env.NEXBLUE_USERNAME;
const PASSWORD = process.env.NEXBLUE_PASSWORD;
const POLL_MS = Math.max(Number(process.env.NEXBLUE_POLL_SECONDS) || 60, 15) * 1000;
const MOCK = process.env.NEXBLUE_MOCK === '1';
const ENABLED = MOCK || Boolean(USERNAME && PASSWORD);

const EV_TOPIC = 'nexblue/status';

// Numeriska värden som sparas i `readings` (och därmed får historik/diagram gratis).
const EV_SENSORS = [
  { sensor: 'ev_effekt',        unit: 'kW',  pick: (s) => s.power_kw },
  { sensor: 'ev_energi_session', unit: 'kWh', pick: (s) => s.energy_kwh },
  { sensor: 'ev_energi_total',  unit: 'kWh', pick: (s) => s.lifetime_energy_kwh },
  { sensor: 'ev_status',        unit: '',    pick: (s) => s.charging_state },
];

let tokens = { access: null, refresh: null, expiresAt: 0 };
let lastEv = null;

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function request(method, path, { body, auth = true } = {}) {
  // Content-Type bara med kropp: NexBlue svarar annars 400 "Error Parsing JSON" på GET.
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  if (auth) headers.Authorization = `Bearer ${tokens.access}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new ApiError(`NexBlue API HTTP ${res.status}`, res.status);
  return res.json();
}

function storeTokens(payload, fallbackRefresh) {
  const expiresIn = Math.max(Number(payload.expires_in || 0) - 60, 0);
  tokens = {
    access: payload.access_token,
    refresh: payload.refresh_token || fallbackRefresh || null,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

async function ensureAccessToken() {
  if (tokens.access && Date.now() < tokens.expiresAt) return;
  if (tokens.refresh) {
    try {
      storeTokens(await request('POST', '/openapi/account/refresh_token', {
        body: { refresh_token: tokens.refresh, account_type: 0 }, auth: false,
      }), tokens.refresh);
      return;
    } catch (err) {
      console.warn('[nexblue] refresh failed, logging in again:', err.message);
    }
  }
  if (!USERNAME || !PASSWORD) throw new Error('NEXBLUE_USERNAME/NEXBLUE_PASSWORD saknas');
  storeTokens(await request('POST', '/openapi/account/login', {
    body: { username: USERNAME, password: PASSWORD, account_type: 0 }, auth: false,
  }), null);
}

function normalizeStatus(serial, p) {
  const bool = (v) => (typeof v === 'boolean' ? v : null);
  const int = (v) => (v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    serial,
    charging_state: Number(p.charging_state),
    power_kw: Number(p.power || 0),
    energy_kwh: Number(p.energy || 0),
    lifetime_energy_kwh: Number(p.lifetime_energy || 0),
    is_lock: bool(p.is_lock),
    is_disable: bool(p.is_disable),
    network_status: int(p.network_status),
    current_limit_a: int(p.current_limit),
    circuit_fuse_a: int(p.circuit_fuse),
    cable_current_limit_a: int(p.cable_current_limit),
    phase_charging: int(p.phase_charging),
    current_a: (p.current_list || []).map(Number),
    voltage_v: (p.voltage_list || []).map(Number),
  };
}

async function fetchStatus() {
  await ensureAccessToken();
  const list = await request('GET', '/openapi/chargers');
  const charger = (list.data || [])[0];
  if (!charger) throw new Error('Inga laddboxar hittades på kontot');
  const payload = await request('GET', `/openapi/chargers/${charger.serial_number}/cmd/status`);
  return normalizeStatus(String(charger.serial_number), payload);
}

// Påhittad data: en laddsession som startar och slutar så UI:t har något att visa.
let mockEnergy = 0;
let mockLifetime = 1234.5;
function fetchMockStatus() {
  const minute = Math.floor(Date.now() / 60000);
  const charging = minute % 30 < 20;
  const power = charging ? 7.2 + Math.sin(minute / 3) * 0.2 : 0;
  if (charging) { mockEnergy += power / 60; mockLifetime += power / 60; } else { mockEnergy = 0; }
  return {
    serial: 'MOCK0001',
    charging_state: charging ? 2 : 1,
    power_kw: power,
    energy_kwh: mockEnergy,
    lifetime_energy_kwh: mockLifetime,
    is_lock: charging,
    is_disable: false,
    network_status: 1,
    current_limit_a: 16,
    circuit_fuse_a: 20,
    cable_current_limit_a: 32,
    phase_charging: 0,
    current_a: charging ? [10.4, 10.3, 10.5] : [0, 0, 0],
    voltage_v: [231, 230, 232],
  };
}

async function pollOnce(io) {
  const status = MOCK ? fetchMockStatus() : await fetchStatus();
  const ts = Date.now();
  lastEv = { ...status, ts };

  for (const def of EV_SENSORS) {
    const value = def.pick(status);
    if (!Number.isFinite(value)) continue;
    if (!MOCK) await db.insertReading(def.sensor, EV_TOPIC, value, def.unit, ts); // mock sparas aldrig
    io.emit('update', { sensor: def.sensor, value, unit: def.unit, ts });
  }
  io.emit('ev', lastEv);
}

function startNexBlue(io) {
  if (!ENABLED) {
    console.log('[nexblue] avstängd (sätt NEXBLUE_USERNAME och NEXBLUE_PASSWORD, eller NEXBLUE_MOCK=1 för testdata)');
    return;
  }
  if (MOCK) console.warn('[nexblue] MOCK-data aktiv — sparas inte i databasen');
  const tick = async () => {
    try {
      await pollOnce(io);
    } catch (err) {
      // 429/401 m.m. loggas utan svarskropp eller token; nästa tick försöker igen.
      console.error('[nexblue] poll failed:', err.message);
      if (err.status === 401 || err.status === 403) tokens = { access: null, refresh: null, expiresAt: 0 };
    }
  };
  tick();
  setInterval(tick, POLL_MS);
}

module.exports = { startNexBlue, getLastEv: () => lastEv, EV_SENSORS };
