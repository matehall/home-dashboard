// Tuya-brytare (Smart Life/Tuya) — skrivskyddad poller mot Tuya Cloud OpenAPI.
// Utan TUYA_ACCESS_ID/TUYA_ACCESS_SECRET/TUYA_UID körs ingenting; TUYA_MOCK=1 ger testdata som aldrig sparas.
const crypto = require('crypto');

const ACCESS_ID = process.env.TUYA_ACCESS_ID;
const ACCESS_SECRET = process.env.TUYA_ACCESS_SECRET;
const UID = process.env.TUYA_UID;
const ENDPOINT = (process.env.TUYA_ENDPOINT || 'https://openapi.tuyaeu.com').replace(/\/+$/, '');
const POLL_MS = Math.max(Number(process.env.TUYA_POLL_SECONDS) || 60, 30) * 1000;
const MOCK = process.env.TUYA_MOCK === '1';
const ENABLED = MOCK || Boolean(ACCESS_ID && ACCESS_SECRET && UID);

const TOPIC = 'tuya/status';
// Spara bara vid ändring eller efter denna tid, för att inte slita på Pi:ns SD-kort.
const STORE_EVERY_MS = 10 * 60 * 1000;
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

let lastTuya = null;
const lastStored = {};
let token = null; // { value, expiresAt }

const hmac = (str) => crypto.createHmac('sha256', ACCESS_SECRET).update(str).digest('hex').toUpperCase();

async function request(pathAndQuery, withToken = true) {
  const t = String(Date.now());
  const nonce = crypto.randomUUID();
  const stringToSign = ['GET', EMPTY_SHA256, '', pathAndQuery].join('\n');
  const sign = hmac(ACCESS_ID + (withToken ? token.value : '') + t + nonce + stringToSign);
  const headers = { client_id: ACCESS_ID, t, nonce, sign, sign_method: 'HMAC-SHA256' };
  if (withToken) headers.access_token = token.value;
  const res = await fetch(ENDPOINT + pathAndQuery, { headers, signal: AbortSignal.timeout(15000) });
  const json = await res.json();
  if (!json.success) throw new Error(`Tuya API ${json.code ?? res.status}: ${json.msg ?? 'okänt fel'}`);
  return json.result;
}

async function ensureToken() {
  if (token && Date.now() < token.expiresAt - 60000) return;
  const r = await request('/v1.0/token?grant_type=1', false);
  token = { value: r.access_token, expiresAt: Date.now() + r.expire_time * 1000 };
}

// Skala enligt Tuyas standardkoder; kan skilja mellan enheter, verifiera mot Smart Life-appen.
function normalize(d) {
  const dp = Object.fromEntries((d.status || []).map((s) => [s.code, s.value]));
  const sw = dp.switch_1 ?? dp.switch ?? dp.switch_led;
  const num = (v, div) => (Number.isFinite(Number(v)) && v != null ? Number(v) / div : null);
  return {
    id: d.id,
    name: d.name,
    online: Boolean(d.online),
    on: typeof sw === 'boolean' ? sw : null,
    power_w: num(dp.cur_power, 10),
    voltage_v: num(dp.cur_voltage, 10),
    current_a: num(dp.cur_current, 1000),
    energy_kwh: num(dp.add_ele, 1000),
    // Temperatur/fuktgivare (kategori wsdcg): temperatur i tiondels grader.
    temperature_c: num(dp.va_temperature, 10),
    humidity: num(dp.va_humidity, 1),
    battery: num(dp.battery_percentage, 1),
  };
}

async function fetchDevices() {
  await ensureToken();
  const list = await request(`/v1.0/users/${encodeURIComponent(UID)}/devices`);
  return (list || []).filter((d) => (d.status || []).some((s) => /^switch|^va_temperature$/.test(s.code))).map(normalize);
}

function fetchMockDevices() {
  const minute = Math.floor(Date.now() / 60000);
  const lampOn = minute % 10 < 6;
  return [
    { id: 'mock1', name: 'Fönsterlampa', online: true, on: lampOn, power_w: null, voltage_v: null, current_a: null, energy_kwh: null, temperature_c: null, humidity: null, battery: null },
    { id: 'mock2', name: 'Kaffebryggare', online: true, on: minute % 7 < 2, power_w: minute % 7 < 2 ? 850 : 0, voltage_v: 231.4, current_a: 3.7, energy_kwh: 12.345, temperature_c: null, humidity: null, battery: null },
    { id: 'mock4', name: 'Sovrum', online: true, on: null, power_w: null, voltage_v: null, current_a: null, energy_kwh: null, temperature_c: 20.3, humidity: 63, battery: 32 },
    { id: 'mock3', name: 'Garage', online: false, on: null, power_w: null, voltage_v: null, current_a: null, energy_kwh: null, temperature_c: null, humidity: null, battery: null },
  ];
}

// Sensorer som sparas i `readings` (och får historik). Namnet bygger på enhets-ID så att omdöpning inte bryter historiken.
function sensorsFor(dev) {
  const out = [];
  if (dev.on !== null) out.push({ sensor: `tuya_${dev.id}_pa`, unit: '', value: dev.on ? 1 : 0 });
  if (dev.power_w !== null) out.push({ sensor: `tuya_${dev.id}_effekt`, unit: 'W', value: dev.power_w });
  if (dev.energy_kwh !== null) out.push({ sensor: `tuya_${dev.id}_energi`, unit: 'kWh', value: dev.energy_kwh });
  if (dev.temperature_c !== null) out.push({ sensor: `tuya_${dev.id}_temp`, unit: '°C', value: dev.temperature_c });
  if (dev.humidity !== null) out.push({ sensor: `tuya_${dev.id}_fukt`, unit: '%', value: dev.humidity });
  if (dev.battery !== null) out.push({ sensor: `tuya_${dev.id}_batteri`, unit: '%', value: dev.battery });
  return out;
}

async function pollOnce(io) {
  const devices = MOCK ? fetchMockDevices() : await fetchDevices();
  const ts = Date.now();
  lastTuya = { devices, ts };

  for (const dev of devices) {
    if (!dev.online) continue;
    for (const { sensor, unit, value } of sensorsFor(dev)) {
      const prev = lastStored[sensor];
      if (!MOCK && (!prev || prev.value !== value || ts - prev.ts >= STORE_EVERY_MS)) {
        await require('./db').insertReading(sensor, TOPIC, value, unit, ts); // mock sparas aldrig
        lastStored[sensor] = { value, ts };
      }
      io.emit('update', { sensor, value, unit, ts });
    }
  }
  io.emit('tuya', lastTuya);
}

function startTuya(io) {
  if (!ENABLED) {
    console.log('[tuya] avstängd (sätt TUYA_ACCESS_ID, TUYA_ACCESS_SECRET och TUYA_UID, eller TUYA_MOCK=1 för testdata)');
    return;
  }
  if (MOCK) console.warn('[tuya] MOCK-data aktiv — sparas inte i databasen');
  const tick = async () => {
    try {
      await pollOnce(io);
    } catch (err) {
      token = null; // tvinga ny token nästa varv
      console.error('[tuya] poll failed:', err.message); // aldrig nycklar i loggen
    }
  };
  tick();
  setInterval(tick, POLL_MS);
}

module.exports = { startTuya, getLastTuya: () => lastTuya };
