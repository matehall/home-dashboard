// Roborock S5 (robotdammsugare) — skrivskyddad poller över Xiaomis lokala miio-protokoll (UDP 54321).
// Protokollet: https://github.com/OpenMiHome/mihome-binary-protocol. Ingen molninloggning, bara IP + token.
// Utan ROBOROCK_IP/ROBOROCK_TOKEN körs ingenting; ROBOROCK_MOCK=1 ger testdata som aldrig sparas.
const crypto = require('crypto');
const dgram = require('dgram');

const IP = process.env.ROBOROCK_IP;
const TOKEN_HEX = process.env.ROBOROCK_TOKEN;
const PORT = 54321;
const POLL_MS = Math.max(Number(process.env.ROBOROCK_POLL_SECONDS) || 30, 10) * 1000;
const MOCK = process.env.ROBOROCK_MOCK === '1';
const ENABLED = MOCK || Boolean(IP && TOKEN_HEX);

const TOPIC = 'roborock/status';
// Wi-Fi i strömsparläge gör att första paketet ofta försvinner (första pingen tar ~400 ms), därför omförsök.
const ATTEMPTS = 3;
const TIMEOUT_MS = 3000;
// Spara bara vid ändring eller efter denna tid, för att inte slita på Pi:ns SD-kort.
const STORE_EVERY_MS = 10 * 60 * 1000;

// Numeriska värden som sparas i `readings` (och därmed får historik/diagram).
const VACUUM_SENSORS = [
  { sensor: 'vacuum_batteri', unit: '%',  pick: (s) => s.battery },
  { sensor: 'vacuum_status',  unit: '',   pick: (s) => s.state },
  { sensor: 'vacuum_yta',     unit: 'm²', pick: (s) => s.clean_area_m2 },
];

let lastVacuum = null;
const lastStored = {};

const md5 = (...bufs) => crypto.createHash('md5').update(Buffer.concat(bufs)).digest();

function createCodec(tokenHex) {
  const token = Buffer.from(tokenHex, 'hex');
  if (token.length !== 16) throw new Error('ROBOROCK_TOKEN måste vara 32 hextecken');
  const key = md5(token);
  const iv = md5(key, token);
  return {
    encrypt(buf) {
      const c = crypto.createCipheriv('aes-128-cbc', key, iv);
      return Buffer.concat([c.update(buf), c.final()]);
    },
    decrypt(buf) {
      const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
      return Buffer.concat([d.update(buf), d.final()]);
    },
    packet(deviceId, stamp, body) {
      const header = Buffer.alloc(32);
      header.writeUInt16BE(0x2131, 0);
      header.writeUInt16BE(32 + body.length, 2);
      deviceId.copy(header, 8);
      header.writeUInt32BE(stamp, 12);
      md5(header.subarray(0, 16), token, body).copy(header, 16);
      return Buffer.concat([header, body]);
    },
  };
}

// Ett UDP-utbyte: skickar `payload` och väntar på första svaret.
function exchange(payload) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); reject(new Error('timeout')); }, TIMEOUT_MS);
    sock.once('message', (msg) => { clearTimeout(timer); sock.close(); resolve(msg); });
    sock.once('error', (err) => { clearTimeout(timer); sock.close(); reject(err); });
    sock.send(payload, PORT, IP);
  });
}

const HELLO = Buffer.concat([Buffer.from('21310020', 'hex'), Buffer.alloc(28, 0xff)]);
let rpcId = 0;

async function rpcOnce(codec, method, params) {
  // Handskakning varje gång: ger enhets-ID och enhetens klocka, så vi slipper hålla tillstånd mellan polls.
  const hello = await exchange(HELLO);
  const deviceId = hello.subarray(8, 12);
  const stamp = hello.readUInt32BE(12) + 1;
  rpcId = (rpcId % 9999) + 1;
  const body = codec.encrypt(Buffer.from(JSON.stringify({ id: rpcId, method, params }) + '\0'));
  const reply = await exchange(codec.packet(deviceId, stamp, body));
  if (reply.length <= 32) throw new Error('tomt svar');
  const text = codec.decrypt(reply.subarray(32)).toString('utf8').replace(/\0+$/, '');
  const json = JSON.parse(text);
  if (json.error) throw new Error(`enheten svarade med fel ${json.error.code}`);
  return json.result;
}

async function rpc(method, params = []) {
  const codec = createCodec(TOKEN_HEX);
  let lastErr;
  for (let i = 0; i < ATTEMPTS; i++) {
    try { return await rpcOnce(codec, method, params); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// Koderna är från python-miio (roborockvacuum.py) och gäller S5.
function normalize(s) {
  return {
    state: Number(s.state),
    battery: Number(s.battery),
    error_code: Number(s.error_code || 0),
    clean_time_s: Number(s.clean_time || 0),
    clean_area_m2: Number(s.clean_area || 0) / 1e6,
    fan_power: s.fan_power ?? null,
    in_cleaning: Number(s.in_cleaning || 0),
    dnd_enabled: Boolean(s.dnd_enabled),
  };
}

async function fetchStatus() {
  const result = await rpc('get_status');
  return normalize(Array.isArray(result) ? result[0] : result);
}

// Påhittad data: en städrunda på 20 min var 60:e minut.
function fetchMockStatus() {
  const minute = Math.floor(Date.now() / 60000) % 60;
  const cleaning = minute < 20;
  return {
    state: cleaning ? 5 : minute < 30 ? 6 : 8,
    battery: cleaning ? 100 - minute * 2 : Math.min(100, 60 + (minute - 20) * 2),
    error_code: 0,
    clean_time_s: cleaning ? minute * 60 : 0,
    clean_area_m2: cleaning ? minute * 1.5 : 0,
    fan_power: 102,
    in_cleaning: cleaning ? 1 : 0,
    dnd_enabled: false,
  };
}

async function pollOnce(io) {
  const status = MOCK ? fetchMockStatus() : await fetchStatus();
  const ts = Date.now();
  lastVacuum = { ...status, ts };

  for (const def of VACUUM_SENSORS) {
    const value = def.pick(status);
    if (!Number.isFinite(value)) continue;
    const prev = lastStored[def.sensor];
    if (!MOCK && (!prev || prev.value !== value || ts - prev.ts >= STORE_EVERY_MS)) {
      await require('./db').insertReading(def.sensor, TOPIC, value, def.unit, ts); // mock sparas aldrig
      lastStored[def.sensor] = { value, ts };
    }
    io.emit('update', { sensor: def.sensor, value, unit: def.unit, ts });
  }
  io.emit('vacuum', lastVacuum);
}

function startRoborock(io) {
  if (!ENABLED) {
    console.log('[roborock] avstängd (sätt ROBOROCK_IP och ROBOROCK_TOKEN, eller ROBOROCK_MOCK=1 för testdata)');
    return;
  }
  if (MOCK) console.warn('[roborock] MOCK-data aktiv — sparas inte i databasen');
  else createCodec(TOKEN_HEX); // misslyckas direkt vid start om token har fel format
  const tick = async () => {
    try {
      await pollOnce(io);
    } catch (err) {
      // Loggar bara felet, aldrig token. Nästa tick försöker igen; kortet visar hur gammal datan är.
      console.error('[roborock] poll failed:', err.message);
    }
  };
  tick();
  setInterval(tick, POLL_MS);
}

module.exports = { startRoborock, getLastVacuum: () => lastVacuum, VACUUM_SENSORS, rpc };
