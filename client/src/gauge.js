// Ren geometri och skalning för köksvyns mätare och staplar (ingen React, så den går att testa).

// Andel 0..1 av en skala. null om värdet saknas.
export function fraction(value, min, max) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Math.min(1, Math.max(0, (Number(value) - min) / (max - min)));
}

// Antal tända segment av n. Ett värde över noll tänder minst ett segment.
export function litCount(frac, n) {
  if (frac === null || frac <= 0) return 0;
  return Math.min(n, Math.max(1, Math.round(frac * n)));
}

// Streck längs en cirkelbåge. Vinklar i grader, 0 = rakt upp, medurs. Ger n streck från start till slut.
export function arcTicks(n, startDeg, endDeg, r0, r1, cx = 0, cy = 0) {
  const pt = (r, deg) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  return Array.from({ length: n }, (_, i) => {
    const deg = n === 1 ? startDeg : startDeg + ((endDeg - startDeg) * i) / (n - 1);
    const [x1, y1] = pt(r0, deg);
    const [x2, y2] = pt(r1, deg);
    return { x1, y1, x2, y2 };
  });
}

// Högsta möjliga laddeffekt i kW: faser x 230 V x lägsta gräns (inställd gräns, säkring, kabel). 11 kW om gränser saknas.
export function gaugeMaxKw(ev) {
  const limits = [ev?.current_limit_a, ev?.circuit_fuse_a, ev?.cable_current_limit_a].filter((a) => a > 0);
  if (!limits.length) return 11;
  const phases = ev.phase_charging === 1 ? 1 : 3;
  return (phases * 230 * Math.min(...limits)) / 1000;
}

// Skala och varningsgränser per temperaturgivare. warn/bad = null betyder att färgen alltid är accent.
export const TEMP_SCALES = {
  panntemp: { min: 0, max: 90, warn: 75, bad: 85 },
  rok_temp: { min: 0, max: 300, warn: 220, bad: 270 },
  utetemperatur: { min: -25, max: 35, warn: null, bad: null },
};

// "ok" | "warn" | "bad" för en temperatur.
export function tempTone(sensor, value) {
  const s = TEMP_SCALES[sensor];
  if (!s || value === null || value === undefined) return "ok";
  if (s.bad !== null && value >= s.bad) return "bad";
  if (s.warn !== null && value >= s.warn) return "warn";
  return "ok";
}

// SVG-path med n staplars segment (stack av små liggande rektanglar) för en stapel med höjdandel frac.
// Segmenten räknas nerifrån och upp. x, w = stapelns läge och bredd; h = totalhöjd; rows = antal segment; gap = glapp.
export function stackPath(x, w, h, rows, frac, gap = 1.5) {
  const lit = litCount(frac, rows);
  const seg = h / rows;
  let d = "";
  for (let r = 0; r < lit; r++) {
    const y = h - (r + 1) * seg + gap / 2;
    d += `M${x.toFixed(2)},${y.toFixed(2)}h${w.toFixed(2)}v${(seg - gap).toFixed(2)}h${(-w).toFixed(2)}z`;
  }
  return d;
}
