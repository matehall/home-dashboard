// Husets elförbrukning per kvart (medeleffekt i kW) för dagens dygn, som underlag för förbrukningsklockan.
// Källa: sensorn CONSUMPTION_SENSOR (standard hus_effekt, kW) i readings. Den fylls av en framtida mätare
// (HAN/P1-läsare via MQTT, se SENSOR_MAP i mqttClient.js). Saknas värden visas en tydligt märkt demoprofil
// (demo: true) tills mätaren finns; CONSUMPTION_DEMO=0 stänger av den.
const db = require('./db');

const SENSOR = process.env.CONSUMPTION_SENSOR || 'hus_effekt';
const DEMO = process.env.CONSUMPTION_DEMO !== '0';
const TZ = 'Europe/Stockholm';
const QUARTER_MS = 15 * 60 * 1000;

const stockholmDate = (ts) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(ts));

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Svensk midnatt för ett datum som epoch-ms. Vid UTC-midnatt gäller fortfarande dygnets första offset (växlingen sker 01:00 UTC).
function stockholmMidnight(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const part = new Intl.DateTimeFormat('en', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(new Date(guess)).find((p) => p.type === 'timeZoneName').value; // "GMT+01:00"
  const match = part.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  const offsetMin = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] || 0)) : 0;
  return guess - offsetMin * 60 * 1000;
}

// Påhittad men rimlig villaprofil: grundlast, morgon- och kvällstopp, lite brus. Bara för att visa hur klockan ser ut.
function demoKw(ts, dayStart) {
  const h = (ts - dayStart) / 3600000;
  const bump = (center, width, height) => height * Math.exp(-(((h - center) / width) ** 2));
  const noise = 0.12 * Math.sin(h * 9.1) + 0.08 * Math.sin(h * 23.7 + 1);
  return Math.max(0.15, 0.45 + bump(7.3, 1.2, 1.6) + bump(18.2, 1.8, 2.4) + bump(12.5, 1.0, 0.7) + noise);
}

async function getConsumption(now = Date.now()) {
  const today = stockholmDate(now);
  const dayStart = stockholmMidnight(today);
  const dayEnd = stockholmMidnight(addDays(today, 1));
  const rows = await db.getQuarterAverages(SENSOR, dayStart, dayEnd);
  const real = new Map(rows.map((r) => [r.ts, r.value]));
  const demo = real.size === 0;
  if (demo && !DEMO) return { sensor: SENSOR, demo: false, ts: now, quarters: [], available: false };

  const quarters = [];
  for (let ts = dayStart; ts < dayEnd; ts += QUARTER_MS) {
    const started = ts <= now; // kvarten har börjat; framtida kvartar saknar värde
    const kw = !started ? null : demo ? demoKw(ts + QUARTER_MS / 2, dayStart) : real.get(ts) ?? null;
    quarters.push({ ts, kw: kw === null ? null : Math.round(kw * 1000) / 1000 });
  }
  return { sensor: SENSOR, demo, ts: now, quarters, available: true };
}

module.exports = { getConsumption };
