// Index för minsta och största värdet i en kostnadsserie, för att markera dem i diagrammet.
// values: tal eller null per stapel. Sista stapeln är den pågående perioden (idag, denna månad, i år) och är
// ofullständig, så den räknas inte med. Ger null om det finns färre än tre staplar med värde eller om alla är lika.
export function markExtremes(values) {
  const candidates = [];
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] !== null && values[i] !== undefined) candidates.push(i);
  }
  if (candidates.length < 3) return null;
  let minIdx = candidates[0];
  let maxIdx = candidates[0];
  for (const i of candidates) {
    if (values[i] < values[minIdx]) minIdx = i;
    if (values[i] > values[maxIdx]) maxIdx = i;
  }
  return minIdx === maxIdx ? null : { minIdx, maxIdx };
}
