// editorial.mjs
// Spiegelt LadeRoute/Editorial/EditorialStore.swift.

import { distance } from './geo.mjs';

export const MAX_MATCH_DISTANCE_M = 150;
export const MIN_MATCH_SCORE = 0.45;

const STOP_WORDS = new Set([
  'ladestation', 'ladesaeule', 'ladepark', 'ladepunkt', 'charging',
  'station', 'charge', 'point', 'ev', 'gmbh', 'ag', 'co', 'kg',
  'der', 'die', 'das', 'und', 'am', 'an', 'im', 'in', 'zur', 'zum',
]);

/** Kleinschreibung, Diakritika weg, Füllwörter raus. */
export function tokenize(text) {
  const folded = (text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase();

  const tokens = folded
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));

  return new Set(tokens);
}

/** Jaccard-Ähnlichkeit über die Wortmengen. */
export function similarity(a, b) {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection++;
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Nähe zu 60 %, Text zu 40 %. */
export function matchScore(distanceMeters, stationName, stationOperator, entry) {
  const proximity = Math.max(0, 1 - distanceMeters / MAX_MATCH_DISTANCE_M);
  const nameSimilarity = similarity(stationName, entry.name);
  const operatorSimilarity =
    stationOperator && entry.operatorName ? similarity(stationOperator, entry.operatorName) : 0;
  const textual = Math.max(nameSimilarity, operatorSimilarity);
  return proximity * 0.6 + textual * 0.4;
}

/** Sucht den passenden Redaktionsdatensatz zu einer TomTom-Station. */
export function match(station, entries) {
  const byID = entries.find((e) => e.tomtomPoiID && e.tomtomPoiID === station.id);
  if (byID) return byID;

  let best = null;
  let bestScore = 0;

  for (const entry of entries) {
    const d = distance({ lat: entry.latitude, lon: entry.longitude }, { lat: station.lat, lon: station.lon });
    if (d > MAX_MATCH_DISTANCE_M) continue;

    const score = matchScore(d, station.name, station.operatorName, entry);
    if (score >= MIN_MATCH_SCORE && score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  return best;
}

export function annotate(stations, entries) {
  return stations.map((station) => ({ station, editorial: match(station, entries) }));
}
