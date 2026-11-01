// Elpris per kvart (rent spotpris, öre/kWh) från elprisetjustnu.se.
// Utan ELECTRICITY_AREA körs ingenting; ELECTRICITY_MOCK=1 ger testpriser som aldrig sparas.
// getCurrentPrice() är avsedd att användas av framtida prisstyrning: null betyder "okänt pris".
const db = require('./db');

const AREA = (process.env.ELECTRICITY_AREA || '').toUpperCase();
const MOCK = process.env.ELECTRICITY_MOCK === '1';
const ENABLED = MOCK || /^SE[1-4]$/.test(AREA);
const POLL_MS = Math.max(Number(process.env.ELECTRICITY_POLL_SECONDS) || 1800, 300) * 1000;
const FAST_POLL_MS = 5 * 60 * 1000; // efter kl. 13 tills morgondagens priser har publicerats
const BASE_URL = 'https://www.elprisetjustnu.se/api/v1/prices';
const QUARTER_MS = 15 * 60 * 1000;
const KEEP_DAYS = 400;
const TZ = 'Europe/Stockholm';

let prices = new Map(); // ts_start (ms) -> öre/kWh
let lastElectricity = null;

const area = () => (MOCK && !AREA ? 'SE2' : AREA);

// Datum (ÅÅÅÅ-MM-DD) och timme i svensk tid.
function stockholmDate(ts) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(ts));
}
function stockholmHour(ts) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ts)));
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const round2 = (v) => Math.round(v * 100) / 100;

// null om dagen inte är publicerad än (404). Kastar vid andra fel.
async function fetchDay(dateStr) {
  const [y, md] = [dateStr.slice(0, 4), dateStr.slice(5)];
  const res = await fetch(`${BASE_URL}/${y}/${md}_${area()}.json`, { signal: AbortSignal.timeout(15000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`elpris HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('elpris: oväntat svar');
  return rows
    .map((r) => ({ ts: Date.parse(r.time_start), ore: round2(Number(r.SEK_per_kWh) * 100) }))
    .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.ore));
}

// Påhittade priser för två dygn så UI:t går att utveckla utan nätverk.
function mockDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d) - 3600 * 1000; // ungefär svensk midnatt, i kvartsrutnätet
  return Array.from({ length: 96 }, (_, i) => {
    const hour = i / 4;
    const ore = 20 + 12 * Math.sin(((hour - 6) / 24) * 2 * Math.PI) + ((i * 7) % 5);
    return { ts: start + i * QUARTER_MS, ore: round2(ore) };
  });
}

function quarterStart(now) {
  return Math.floor(now / QUARTER_MS) * QUARTER_MS;
}

function getCurrentPrice(now = Date.now()) {
  const ore = prices.get(quarterStart(now));
  return ore === undefined ? null : ore;
}

function getPrices(fromTs, toTs) {
  return [...prices.entries()]
    .filter(([ts]) => ts >= fromTs && ts < toTs)
    .sort((a, b) => a[0] - b[0])
    .map(([ts, ore]) => ({ ts, ore }));
}

function buildPayload(now) {
  const list = getPrices(now - 24 * 3600 * 1000, now + 3 * 24 * 3600 * 1000);
  return { area: area(), ts: now, current: getCurrentPrice(now), prices: list };
}

async function pollOnce(io) {
  const now = Date.now();
  const today = stockholmDate(now);
  const tomorrow = addDays(today, 1);
  const days = [];
  if (MOCK) {
    days.push(mockDay(today), mockDay(tomorrow));
  } else {
    const todayRows = await fetchDay(today);
    if (!todayRows) throw new Error('dagens priser saknas');
    days.push(todayRows);
    let tomorrowRows = null;
    try {
      tomorrowRows = await fetchDay(tomorrow);
    } catch (err) {
      console.warn('[elpris] morgondagens priser kunde inte hämtas:', err.message);
    }
    if (tomorrowRows) days.push(tomorrowRows);
  }
  const rows = days.flat();
  for (const { ts, ore } of rows) prices.set(ts, ore);
  if (!MOCK) await db.upsertPrices(area(), rows);

  lastElectricity = buildPayload(now);
  io.emit('electricity', lastElectricity);
  return days.length === 2; // har vi morgondagen?
}

async function init() {
  if (MOCK) return;
  const now = Date.now();
  await db.prunePrices(now - KEEP_DAYS * 24 * 3600 * 1000);
  const rows = await db.getPrices(area(), now - 24 * 3600 * 1000, now + 3 * 24 * 3600 * 1000);
  for (const { ts, ore } of rows) prices.set(ts, ore); // så getCurrentPrice fungerar även om API:t ligger nere vid start
}

function startElectricity(io) {
  if (!ENABLED) {
    console.log('[elpris] avstängd (sätt ELECTRICITY_AREA=SE1..SE4, eller ELECTRICITY_MOCK=1 för testdata)');
    return;
  }
  if (MOCK) console.warn('[elpris] MOCK-data aktiv — sparas inte i databasen');
  const tick = async () => {
    let delay = POLL_MS;
    try {
      const haveTomorrow = await pollOnce(io);
      if (!haveTomorrow && stockholmHour(Date.now()) >= 13) delay = Math.min(delay, FAST_POLL_MS);
    } catch (err) {
      console.error('[elpris] poll failed:', err.message);
      delay = Math.min(delay, FAST_POLL_MS);
    }
    setTimeout(tick, delay);
  };
  init().catch((err) => console.error('[elpris] init failed:', err.message)).finally(tick);
}

function getLastElectricity() {
  return lastElectricity;
}

module.exports = { startElectricity, getLastElectricity, getCurrentPrice, getPrices };
