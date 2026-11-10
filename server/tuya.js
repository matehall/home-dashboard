// Tuya-brytare (Smart Life/Tuya) — skrivskyddad poller mot Tuya Cloud OpenAPI.
// Utan TUYA_ACCESS_ID/TUYA_ACCESS_SECRET/TUYA_UID körs ingenting; TUYA_MOCK=1 ger testdata som aldrig sparas.
const crypto = require('crypto');
const { startLocal, getLocal, setSwitchLocal } = require('./tuyaLocal');

const ACCESS_ID = process.env.TUYA_ACCESS_ID;
const ACCESS_SECRET = process.env.TUYA_ACCESS_SECRET;
const UID = process.env.TUYA_UID;
const ENDPOINT = (process.env.TUYA_ENDPOINT || 'https://openapi.tuyaeu.com').replace(/\/+$/, '');
// Trial-prenumerationen på Tuya IoT Core ger 26 000 API-anrop per månad: 300 s ger ca 8 600 anrop, 60 s ger ca 43 000 (över kvoten).
const POLL_MS = Math.max(Number(process.env.TUYA_POLL_SECONDS) || 300, 300) * 1000;
const MOCK = process.env.TUYA_MOCK === '1';
const ENABLED = MOCK || Boolean(ACCESS_ID && ACCESS_SECRET && UID);

const TOPIC = 'tuya/status';
// Spara bara vid ändring eller efter denna tid, för att inte slita på Pi:ns SD-kort.
const STORE_EVERY_MS = 10 * 60 * 1000;
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

let lastTuya = null;
let cloudList = null; // senaste molnlistan; slås ihop med lokala värden vid varje publicering
let rawById = {}; // rådata per enhet för detaljrutan; skickas aldrig via socket
// Enhetens lokala nyckel, position, publika IP och konto-id:n ska aldrig lämna servern (dashboarden saknar inloggning).
const SECRET_FIELDS = ['local_key', 'lat', 'lon', 'ip', 'uid', 'owner_id', 'uuid'];
const lastStored = {};
let token = null; // { value, expiresAt }

const hmac = (str) => crypto.createHmac('sha256', ACCESS_SECRET).update(str).digest('hex').toUpperCase();

async function request(pathAndQuery, withToken = true, { method = 'GET', body } = {}) {
  const t = String(Date.now());
  const nonce = crypto.randomUUID();
  const payload = body === undefined ? '' : JSON.stringify(body);
  const bodyHash = payload ? crypto.createHash('sha256').update(payload).digest('hex') : EMPTY_SHA256;
  const stringToSign = [method, bodyHash, '', pathAndQuery].join('\n');
  const sign = hmac(ACCESS_ID + (withToken ? token.value : '') + t + nonce + stringToSign);
  const headers = { client_id: ACCESS_ID, t, nonce, sign, sign_method: 'HMAC-SHA256' };
  if (withToken) headers.access_token = token.value;
  if (payload) headers['Content-Type'] = 'application/json';
  const res = await fetch(ENDPOINT + pathAndQuery, { method, headers, body: payload || undefined, signal: AbortSignal.timeout(15000) });
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
// Enhetstyp avgörs av Tuyas `category` (finns även för offline-enheter som saknar status), med statuskoder som reserv.
// Nya temp/fuktgivare hamnar då rätt direkt, utan ändring i klienten.
const CLIMATE_CATEGORY = /^wsd/; // wsdcg m.fl. (temperatur/fuktgivare)
const CLIMATE_CODES = ['va_temperature', 'va_humidity', 'temp_current', 'humidity_value'];
// Vissa givare är registrerade med fel category (t.ex. "T & H Sensor" som tdq = brytare) och saknar status i listan.
const CLIMATE_PRODUCT = /\bt\s*&\s*h\b|humidity|temperature/i;
function kindOf(d, dp) {
  if (CLIMATE_CATEGORY.test(d.category || '')) return 'climate';
  if (CLIMATE_PRODUCT.test(d.product_name || '')) return 'climate';
  return CLIMATE_CODES.some((c) => c in dp) ? 'climate' : 'switch';
}

// Lokala datapunkter för nätdrivna pluggar (kategori cz) översätts till Tuyas statuskoder och ersätter molnets värden.
const LOCAL_DPS = { switch_1: '1', add_ele: '17', cur_current: '18', cur_power: '19', cur_voltage: '20' };
function withLocal(d) {
  if (d.category !== 'cz') return d;
  const l = getLocal(d.id);
  if (!l) return d;
  // Bara koder som pluggen faktiskt skickar lokalt ersätts; övriga (t.ex. energi på Outdoor Plug) behålls från molnet.
  const local = Object.entries(LOCAL_DPS).filter(([, dp]) => dp in l.dps);
  const replaced = new Set(local.map(([code]) => code));
  const status = (d.status || []).filter((s) => !replaced.has(s.code));
  for (const [code, dp] of local) status.push({ code, value: l.dps[dp] });
  return { ...d, status, online: true };
}

function normalize(d) {
  const dp = Object.fromEntries((d.status || []).map((s) => [s.code, s.value]));
  const sw = dp.switch_1 ?? dp.switch ?? dp.switch_led;
  const num = (v, div) => (Number.isFinite(Number(v)) && v != null ? Number(v) / div : null);
  return {
    id: d.id,
    name: d.name,
    kind: kindOf(d, dp),
    online: Boolean(d.online),
    on: typeof sw === 'boolean' ? sw : null,
    power_w: num(dp.cur_power, 10),
    voltage_v: num(dp.cur_voltage, 10),
    current_a: num(dp.cur_current, 1000),
    energy_kwh: num(dp.add_ele, 1000),
    // Temperatur/fuktgivare (kategori wsdcg): temperatur i tiondels grader.
    temperature_c: num(dp.va_temperature ?? dp.temp_current, 10), // wsdcg: va_temperature, tdq-registrerade givare: temp_current
    humidity: num(dp.va_humidity ?? dp.humidity_value, 1),
    battery: num(dp.battery_percentage, 1),
    battery_state: typeof dp.battery_state === 'string' ? dp.battery_state : null, // low/middle/high när procent saknas
  };
}

async function fetchDevices() {
  await ensureToken();
  const list = (await request(`/v1.0/users/${encodeURIComponent(UID)}/devices`)) || [];
  // Felregistrerade enheter (t.ex. T&H-givare som tdq) har tom status i listan men värden i shadow/properties.
  await Promise.all(
    list
      .filter((d) => d.online && !(d.status || []).length)
      .map(async (d) => {
        try {
          const r = await request(`/v2.0/cloud/thing/${encodeURIComponent(d.id)}/shadow/properties`);
          d.status = (r.properties || []).map((p) => ({ code: p.code, value: p.value }));
        } catch (err) {
          // behåll tom status; enheten visas utan värden
        }
      }),
  );
  rawById = Object.fromEntries(list.map((d) => [d.id, Object.fromEntries(Object.entries(d).filter(([k]) => !SECRET_FIELDS.includes(k)))]));
  return list; // alla definierade enheter, även offline
}

function fetchMockDevices() {
  const minute = Math.floor(Date.now() / 60000);
  const lampOn = minute % 10 < 6;
  return [
    { id: 'mock1', name: 'Fönsterlampa', kind: 'switch', online: true, on: lampOn, power_w: null, voltage_v: null, current_a: null, energy_kwh: null, temperature_c: null, humidity: null, battery: null },
    { id: 'mock2', name: 'Kaffebryggare', kind: 'switch', online: true, on: minute % 7 < 2, power_w: minute % 7 < 2 ? 850 : 0, voltage_v: 231.4, current_a: 3.7, energy_kwh: 12.345, temperature_c: null, humidity: null, battery: null },
    { id: 'mock6', name: 'SiGN Outdoor Plug växthuset inne', kind: 'switch', online: true, on: true, power_w: 36.4, voltage_v: 231.4, current_a: 0.16, energy_kwh: 4.2, temperature_c: null, humidity: null, battery: null },
    { id: 'mock4', name: 'Sovrum', kind: 'climate', online: true, on: null, power_w: null, voltage_v: null, current_a: null, energy_kwh: null, temperature_c: 20.3, humidity: 63, battery: 32 },
    { id: 'mock3', name: 'Garage', kind: 'switch', online: false, on: null, power_w: null, voltage_v: null, current_a: null, energy_kwh: null, temperature_c: null, humidity: null, battery: null },
    { id: 'mock5', name: 'Verkstad', kind: 'climate', online: false, on: null, power_w: null, voltage_v: null, current_a: null, energy_kwh: null, temperature_c: null, humidity: null, battery: null },
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

// Bygger enhetslistan av molndata + lokala värden, sparar ändringar och skickar till klienterna.
// Anropas efter varje molnpoll och (strypt) när en lokal plugg skickar en uppdatering.
let publishing = false;
async function publish(io) {
  if (publishing) return;
  publishing = true;
  try {
    const devices = MOCK ? fetchMockDevices() : cloudList.map((d) => normalize(withLocal(d)));
    const ts = Date.now();
    lastTuya = { devices, ts };

    for (const dev of devices) {
      if (!dev.online) continue;
      for (const { sensor, unit, value } of sensorsFor(dev)) {
        const prev = lastStored[sensor];
        // På/av sparas direkt vid ändring; mätvärden högst en gång per minut (lokala uppdateringar kommer ofta).
        const minGap = sensor.endsWith('_pa') ? 0 : 60 * 1000;
        if (!MOCK && (!prev || (prev.value !== value && ts - prev.ts >= minGap) || ts - prev.ts >= STORE_EVERY_MS)) {
          await require('./db').insertReading(sensor, TOPIC, value, unit, ts); // mock sparas aldrig
          lastStored[sensor] = { value, ts };
        }
        io.emit('update', { sensor, value, unit, ts });
      }
    }
    io.emit('tuya', lastTuya);
  } finally {
    publishing = false;
  }
}

// Lokala uppdateringar publiceras strypt: på/av inom en sekund, mätvärden som mest var 15:e sekund.
let publishTimer = null;
function schedulePublish(io, urgent) {
  if (publishTimer && !urgent) return;
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishTimer = null;
    publish(io).catch((err) => console.error('[tuya] publicering misslyckades:', err.message));
  }, urgent ? 1000 : 15000);
}

async function pollOnce(io) {
  if (!MOCK) {
    cloudList = await fetchDevices();
    startLocal(cloudList.filter((d) => d.category === 'cz').map((d) => d.id), (urgent) => schedulePublish(io, urgent));
  }
  await publish(io);
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

// Slå på/av en känd enhet. Används bara av serverns egen prisstyrning (priceControl.js); det finns ingen HTTP-väg hit,
// eftersom dashboarden saknar inloggning. Kommandokoden hämtas ur enhetens egen statuslista, aldrig från anroparen.
const SWITCH_CODES = ['switch_1', 'switch', 'switch_led'];
async function setSwitch(id, on) {
  const device = lastTuya?.devices.find((d) => d.id === id);
  if (!device) throw new Error('okänd enhet');
  if (MOCK) { console.log(`[tuya] MOCK: skulle sätta ${device.name} ${on ? 'på' : 'av'}`); return 'mock'; }
  try {
    await setSwitchLocal(id, on); // lokalt först: omedelbart och utan molnanrop
    return 'lokal';
  } catch (err) {
    console.error(`[tuya] lokalt kommando misslyckades (${err.message}), försöker via molnet`);
  }
  const code = SWITCH_CODES.find((c) => (rawById[id]?.status || []).some((s) => s.code === c));
  if (!code) throw new Error('enheten har ingen strömbrytarkod');
  await ensureToken();
  await request(`/v1.0/devices/${encodeURIComponent(id)}/commands`, true, { method: 'POST', body: { commands: [{ code, value: Boolean(on) }] } });
  return code;
}

// Allt som finns om en enhet: normaliserade värden, Tuyas rådata (utan hemligheter) och specifikation (best effort).
async function getDeviceDetails(id) {
  const device = lastTuya?.devices.find((d) => d.id === id); // bara kända id:n, inget fritt id i Tuya-anropet
  if (!device) return null;
  if (MOCK) return { device, raw: { mock: true, id, name: device.name }, specifications: null, ts: lastTuya.ts };
  let specifications;
  try {
    await ensureToken();
    specifications = await request(`/v1.0/devices/${encodeURIComponent(id)}/specifications`);
  } catch (err) {
    specifications = { error: err.message };
  }
  // Shadow-egenskaper visar alla datapunkter (även icke-standard). Best effort.
  let shadow;
  try {
    shadow = await request(`/v2.0/cloud/thing/${encodeURIComponent(id)}/shadow/properties`);
  } catch (err) {
    shadow = { error: err.message };
  }
  const probes = { shadow_properties: shadow };
  return { device, raw: rawById[id] ?? null, specifications, probes, ts: lastTuya.ts };
}

// Rå enhetslista inklusive local_key/ip, bara för engångsskriptet scripts/tuya-local-discover.js. Skickas aldrig via HTTP/socket.
async function fetchRawDeviceList() {
  await ensureToken();
  return (await request(`/v1.0/users/${encodeURIComponent(UID)}/devices`)) || [];
}

module.exports = {
  setSwitch, startTuya, getLastTuya: () => lastTuya, getDeviceDetails, fetchRawDeviceList };
