// Engångsskript: hittar Tuya-enheter på LAN (UDP-broadcast 6666/6667), slår upp MAC i ARP-tabellen och hämtar local_key
// från molnlistan. Skriver en tabell (id, namn, IP, MAC, protokollversion) och en nyckelfil (chmod 600). Nycklar skrivs aldrig ut.
//
// Körs på Pi:n med host-nätverk så att broadcast tas emot (TUYA_* från .env):
//   docker run --rm --network host --env-file ~/dashboard-docker/.env -v "$PWD":/app -v ~/dashboard-docker/data:/out \
//     -w /app node:20-bookworm-slim node scripts/tuya-local-discover.js /out/tuya-local.json [sekunder]
// Skriptet måste köras från projektroten (server/tuya.js läser TUYA_* ur miljön).
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const { fetchRawDeviceList } = require('../server/tuya');

const OUT = process.argv[2] || './tuya-local.json';
const SECONDS = Number(process.argv[3]) || 90;
// Tuyas publika UDP-nyckel för upptäckt på port 6667 (AES-128-ECB).
const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

function parsePacket(buf) {
  if (buf.length < 28 || buf.readUInt32BE(0) !== 0x000055aa) return null; // 3.5-paket (0x6699, port 7000) hanteras inte här
  const len = buf.readUInt32BE(12);
  const payload = buf.subarray(20, 16 + len - 8); // efter retcode, före crc och suffix
  const tryJson = (b) => { try { return JSON.parse(b.toString('utf8')); } catch { return null; } };
  const plain = tryJson(payload);
  if (plain) return plain;
  try {
    const d = crypto.createDecipheriv('aes-128-ecb', UDP_KEY, null);
    return tryJson(Buffer.concat([d.update(payload), d.final()]));
  } catch { return null; }
}

function macFor(ip) {
  try {
    const row = fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1).map((l) => l.split(/\s+/)).find((c) => c[0] === ip);
    return row && row[3] !== '00:00:00:00:00:00' ? row[3] : null;
  } catch { return null; }
}

function listen(port, found) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg) => {
    const j = parsePacket(msg);
    if (j?.gwId && j?.ip) found.set(j.gwId, { ip: j.ip, version: j.version || null });
  });
  sock.on('error', (e) => console.error(`UDP ${port}: ${e.message}`));
  sock.bind(port);
  return sock;
}

(async () => {
  const found = new Map();
  const socks = [listen(6666, found), listen(6667, found)];
  console.log(`Lyssnar ${SECONDS} s efter Tuya-enheter på LAN...`);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  socks.forEach((s) => s.close());

  const cloud = await fetchRawDeviceList();
  const keys = {};
  const rows = [];
  for (const d of cloud) {
    const lan = found.get(d.id);
    const mac = lan ? macFor(lan.ip) : null;
    rows.push({ id: d.id, namn: d.name, kategori: d.category, online: d.online, ip: lan?.ip ?? '-', mac: mac ?? '-', version: lan?.version ?? '-' });
    if (lan) keys[d.id] = { name: d.name, ip: lan.ip, mac, version: lan.version, local_key: d.local_key };
  }
  console.table(rows);
  const missing = rows.filter((r) => r.ip === '-');
  console.log(`${Object.keys(keys).length} av ${rows.length} enheter hittades lokalt. Ej hittade (batteri, offline eller protokoll 3.5): ${missing.map((r) => r.namn).join(', ') || 'inga'}`);
  fs.writeFileSync(OUT, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.log(`Nycklar och adresser sparade i ${OUT} (chmod 600).`);
})().catch((e) => { console.error('Misslyckades:', e.message); process.exit(1); });
