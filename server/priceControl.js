// Prisstyrning av en Tuya-plugg: på när spotpriset (öre/kWh, samma som prisklockan) är under gränsen, annars av.
// Av som standard: PRICE_CONTROL=1 slår på den. Okänt pris eller offline-enhet => ingenting görs (pluggen behåller sitt läge).
// Styrningen finns bara här på servern; det finns ingen HTTP-väg för att växla enheter.
const { getCurrentPrice } = require('./electricity');
const { getLastTuya, setSwitch } = require('./tuya');

const ENABLED = process.env.PRICE_CONTROL === '1';
const DEVICE_ID = (process.env.PRICE_CONTROL_DEVICE || '').trim();
const MAX_ORE = Number(process.env.PRICE_CONTROL_MAX_ORE ?? 25);
const TICK_MS = 30 * 1000;
const RETRY_MS = 2 * 60 * 1000; // vänta på att Tuya-pollen bekräftar innan samma kommando skickas igen

let status = null;
let lastCommand = null; // { on, ts }

function getControlStatus() {
  return status;
}

function decide(now = Date.now()) {
  const price = getCurrentPrice(now);
  const device = getLastTuya()?.devices.find((d) => d.id === DEVICE_ID) ?? null;
  const base = { enabled: true, deviceId: DEVICE_ID, maxOre: MAX_ORE, price, ts: now };
  if (price === null) return { ...base, state: 'okänt pris', desired: null, act: false };
  const desired = price < MAX_ORE; // under gränsen = på, lika med eller över = av
  if (!device) return { ...base, state: 'enhet saknas', desired, act: false };
  if (!device.online) return { ...base, state: 'enhet offline', desired, act: false };
  if (device.on === desired) return { ...base, state: desired ? 'på' : 'av', desired, act: false };
  const recent = lastCommand && lastCommand.on === desired && now - lastCommand.ts < RETRY_MS;
  return { ...base, state: 'växlar', desired, act: !recent };
}

async function tick(io) {
  const d = decide();
  status = { enabled: d.enabled, deviceId: d.deviceId, maxOre: d.maxOre, price: d.price, state: d.state, desired: d.desired, ts: d.ts };
  if (d.act) {
    try {
      lastCommand = { on: d.desired, ts: Date.now() };
      await setSwitch(DEVICE_ID, d.desired);
      console.log(`[prisstyrning] ${d.desired ? 'på' : 'av'} (pris ${d.price} öre, gräns ${MAX_ORE})`);
    } catch (err) {
      console.error('[prisstyrning] kommandot misslyckades:', err.message); // aldrig nycklar i loggen
    }
  }
  io.emit('control', status);
}

function startPriceControl(io) {
  if (!ENABLED) {
    console.log('[prisstyrning] avstängd (sätt PRICE_CONTROL=1 och PRICE_CONTROL_DEVICE=<tuya-id>)');
    return;
  }
  if (!DEVICE_ID || !Number.isFinite(MAX_ORE)) {
    console.error('[prisstyrning] PRICE_CONTROL_DEVICE saknas eller PRICE_CONTROL_MAX_ORE är ogiltig, styrningen är avstängd');
    return;
  }
  console.log(`[prisstyrning] aktiv: enhet ${DEVICE_ID}, på under ${MAX_ORE} öre/kWh`);
  setTimeout(() => {
    const run = () => tick(io).catch((err) => console.error('[prisstyrning] fel:', err.message));
    run();
    setInterval(run, TICK_MS);
  }, 20 * 1000); // låt första Tuya-pollen och priserna hinna laddas
}

module.exports = { startPriceControl, getControlStatus };
