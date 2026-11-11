// Vinkel -> kvartsindex för 24 h-klockan: midnatt överst och medsols (samma konvention som polar() i App.jsx).
// dx, dy = pekpunktens förskjutning från klockans mitt i pixlar (y växer nedåt), n = antal kvartar i datan.
export function angleToIndex(dx, dy, n) {
  const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  return Math.min(n - 1, Math.floor(deg / (360 / n)));
}
