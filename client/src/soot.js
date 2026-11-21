// Visning av sotindikatorn (köksvyns temperaturpanel). Rena funktioner, inget React.
// Värdet är hur många °C varmare röken är än när pannan var ren (en temperaturskillnad, kelvin).
export const SOOT_SEGS = 14; // ett segment per °C

const TONES = { ok: "ok", warn: "warn", sweep: "bad" };

// Zon för segment i (0-baserat): under varningsgränsen "ok", mellan varnings- och sotningsgränsen "warn", därefter "bad".
export function segmentZone(i, warnAt, sweepAt) {
  return i < warnAt ? "ok" : i < sweepAt ? "warn" : "bad";
}

// soot: svaret från /api/soot (eller null). Returnerar { tone, lit, value, label, zones } där zones är zon per segment.
export function sootView(soot) {
  const warnAt = soot?.warnAt ?? 7;
  const sweepAt = soot?.sweepAt ?? 10;
  const zones = Array.from({ length: SOOT_SEGS }, (_, i) => segmentZone(i, warnAt, sweepAt));
  if (!soot || soot.status === "unknown" || soot.rise === null || !Number.isFinite(soot.rise)) {
    return { tone: "off", lit: 0, value: null, label: "–", zones };
  }
  const lit = Math.max(0, Math.min(SOOT_SEGS, Math.round(soot.rise)));
  const rounded = Math.round(soot.rise);
  const value = `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded)}`;
  const words = { ok: "OK", warn: "Snart dags", sweep: "Sota nu" };
  let label = words[soot.status] ?? "–";
  if (soot.status !== "sweep" && soot.daysLeft !== null && soot.daysLeft !== undefined && soot.daysLeft <= 90) {
    label += ` · ~${Math.max(1, Math.round(soot.daysLeft))} dygn`;
  }
  return { tone: TONES[soot.status] ?? "off", lit, value, label, zones };
}
