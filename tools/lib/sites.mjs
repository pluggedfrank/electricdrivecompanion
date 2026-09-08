// sites.mjs
// Fasst Registereinträge zu Standorten zusammen.
//
// Warum das nötig ist: Das Register führt jede einzelne Ladeeinrichtung als
// eigene Zeile. Ein Ladepark mit acht Säulen sind acht Zeilen. TomTom führt
// denselben Ladepark als einen POI. Wer beides direkt gegeneinander zählt,
// vergleicht Geräte mit Standorten und bekommt eine Zahl, die nichts aussagt.
//
// Zusammengefasst wird über Nachbarschaft: Was innerhalb weniger Dutzend Meter
// beieinandersteht, ist derselbe Ladepark. Die Verkettung ist bewusst
// transitiv, damit eine Reihe von Säulen entlang eines Parkplatzes nicht in
// mehrere Standorte zerfällt.

import { distance } from './geo.mjs';
import { buildRouteIndex } from './corridor.mjs';

export const DEFAULT_SITE_RADIUS_M = 75;

/**
 * Gruppiert Einträge zu Standorten.
 *
 * Union-Find über die Nachbarschaft, die Nachbarn kommen aus dem Gitterindex.
 * Ohne den wären es bei 100.000 Einträgen zehn Milliarden Vergleiche.
 */
export function clusterSites(entries, radiusMeters = DEFAULT_SITE_RADIUS_M) {
  if (entries.length === 0) return [];

  const parent = entries.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]; // Pfad verkürzen
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  // Der Index trägt hier die Einträge selbst, nicht Routenpunkte.
  const index = buildRouteIndex(
    entries.map((entry, i) => ({ lat: entry.lat, lon: entry.lon, i })),
    radiusMeters
  );

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const latCell = Math.floor(entry.lat / index.cellSizeLat);
    const lonCell = Math.floor(entry.lon / index.cellSizeLon);

    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const bucket = index.cells.get(`${latCell + dLat}:${lonCell + dLon}`);
        if (!bucket) continue;
        for (const other of bucket) {
          if (other.i <= i) continue;
          if (distance(entry, entries[other.i]) <= radiusMeters) union(i, other.i);
        }
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < entries.length; i++) {
    const root = find(i);
    const bucket = groups.get(root);
    if (bucket) bucket.push(entries[i]);
    else groups.set(root, [entries[i]]);
  }

  return [...groups.values()].map(toSite);
}

/** Macht aus einer Gruppe von Einträgen einen Standort. */
function toSite(members) {
  const lat = members.reduce((sum, e) => sum + e.lat, 0) / members.length;
  const lon = members.reduce((sum, e) => sum + e.lon, 0) / members.length;

  // Der häufigste Betreiber gilt für den Standort. Bei Gleichstand der erste,
  // das ist willkürlich, aber stabil.
  const counts = new Map();
  for (const member of members) {
    if (!member.operator) continue;
    counts.set(member.operator, (counts.get(member.operator) ?? 0) + 1);
  }
  const operator = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  const powers = members.map((m) => m.powerKW).filter((p) => p != null);
  const distances = members
    .map((m) => m.distanceToRouteMeters)
    .filter((d) => d != null);

  return {
    lat,
    lon,
    operator,
    // Die stärkste Säule bestimmt, wozu der Standort taugt.
    maxPowerKW: powers.length > 0 ? Math.max(...powers) : null,
    hasFastCharger: members.some((m) => m.isFastCharger),
    deviceCount: members.length,
    pointCount: members.reduce((sum, m) => sum + (m.pointCount ?? 0), 0),
    postalCode: members[0].postalCode,
    city: members[0].city,
    distanceToRouteMeters: distances.length > 0 ? Math.min(...distances) : null,
    members,
  };
}
