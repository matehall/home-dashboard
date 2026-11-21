// Läsare för openHAB:s rrd4j-filer (eget binärformat, "RRD4J, version 0.2"). Ingen rrdtool på Pi:n, så formatet läses direkt.
// Layout (big endian): header = signatur (20 tecken UTF-16), step (long, s), antal datakällor (int), antal arkiv (int), lastUpdate (long, s);
// per datakälla: namn, typ (20 tecken UTF-16 var), heartbeat (long), min, max (double), samt tillstånd (last, accum: double, nanSeconds: long);
// per arkiv: konsolideringsfunktion (20 tecken), xff (double), steps (int), rows (int), och per datakälla: ptr (int), accum (double), nanSteps (long)
// följt av rows värden (double). Ringbufferten har nästa skrivposition i ptr.

function parseRrd(buf) {
  let o = 0;
  const str = () => {
    let s = '';
    for (let i = 0; i < 20; i += 1) s += String.fromCharCode(buf.readUInt16BE(o + i * 2));
    o += 40;
    return s.trim();
  };
  const i32 = () => { const v = buf.readInt32BE(o); o += 4; return v; };
  const i64 = () => { const v = Number(buf.readBigInt64BE(o)); o += 8; return v; };
  const f64 = () => { const v = buf.readDoubleBE(o); o += 8; return v; };

  const signature = str();
  if (!signature.startsWith('RRD4J')) throw new Error(`Inte en rrd4j-fil (signatur "${signature}")`);
  const step = i64();
  const dsCount = i32();
  const arcCount = i32();
  const lastUpdate = i64();
  const datasources = [];
  for (let i = 0; i < dsCount; i += 1) {
    const name = str(); const type = str(); const heartbeat = i64(); f64(); f64(); f64(); f64(); i64();
    datasources.push({ name, type, heartbeat });
  }
  const archives = [];
  for (let a = 0; a < arcCount; a += 1) {
    const fn = str(); const xff = f64(); const steps = i32(); const rows = i32();
    const ptrs = []; const data = [];
    for (let i = 0; i < dsCount; i += 1) {
      ptrs.push(i32()); f64(); i64();
      const v = new Float64Array(rows);
      for (let r = 0; r < rows; r += 1) v[r] = f64();
      data.push(v);
    }
    archives.push({ fn, xff, steps, rows, ptr: ptrs[0], data: data[0] });
  }
  return { signature, step, lastUpdate, datasources, archives };
}

// Värdena i ett arkiv i tidsordning som [{ ts (ms, radens slut), value }], utan tomma (NaN) rader.
function archiveSeries(rrd, archive) {
  const arcStep = rrd.step * archive.steps;
  const lastRowEnd = Math.floor(rrd.lastUpdate / arcStep) * arcStep;
  const out = [];
  for (let k = 0; k < archive.rows; k += 1) {
    const value = archive.data[(archive.ptr + k) % archive.rows];
    if (Number.isNaN(value)) continue;
    out.push({ ts: (lastRowEnd - (archive.rows - 1 - k) * arcStep) * 1000, value });
  }
  return out;
}

// Arkiv med en viss radlängd i sekunder (till exempel 900 för 15 minuter, 3600 för timmar), eller null.
function archiveByResolution(rrd, seconds, fn = 'AVERAGE') {
  return rrd.archives.find((a) => a.fn === fn && a.steps * rrd.step === seconds) ?? null;
}

module.exports = { parseRrd, archiveSeries, archiveByResolution };
