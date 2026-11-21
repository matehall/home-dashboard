// Härleder varför laddeffekten är som den är, ur laddboxens gränser och uppmätt ström.
// NexBlue-API:t har inget känt orsaksfält (ska undersökas mot live-data), så texten är härledd, inte hämtad från appen.
const LIMITS = [
  ["current_limit_a", "Inställd gräns"],
  ["circuit_fuse_a", "Säkring"],
  ["cable_current_limit_a", "Kabelns max"],
];

export function evLimitReason(ev) {
  if (!ev) return null;
  if (ev.charging_state === 5) return { text: "Lastbalansering: huset drar mycket", derived: true };
  if (ev.charging_state === 6) return { text: "Väntar på fördröjd start", derived: true };
  if (ev.charging_state === 7) return { text: "Väntar på bilen", derived: true };
  if (ev.charging_state !== 2) return null;

  const set = LIMITS.filter(([k]) => ev[k] != null && ev[k] > 0).map(([k, name]) => ({ a: ev[k], name }));
  const lowest = set.length ? set.reduce((m, x) => (x.a < m.a ? x : m)) : null;
  const drawn = ev.current_a?.length ? Math.max(...ev.current_a) : null;
  if (!lowest || drawn == null) return null;
  if (drawn >= lowest.a - 1.5) return { text: `Begränsad av ${lowest.name.toLowerCase()} ${lowest.a} A`, derived: true };
  return { text: `Bilen tar ${drawn.toFixed(0)} A (gräns ${lowest.a} A)`, derived: true };
}
