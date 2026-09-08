// corridor.mjs
// Findet die Punkte, die nahe genug an einer Route liegen.
//
// Das Register hat rund 200.000 Einträge, eine Route mehrere tausend
// Stützpunkte. Jeden gegen jeden zu prüfen wären Hunderte Millionen
// Entfernungsrechnungen. Stattdessen kommen die Routenpunkte in ein grobes
// Gitter, und für einen Kandidaten werden nur seine eigene Zelle und die acht
// Nachbarzellen betrachtet.

import { distance } from './geo.mjs';

const METERS_PER_DEGREE_LAT = 111132;
const METERS_PER_DEGREE_LON_EQUATOR = 111320;

/**
 * Baut den Gitterindex über die Routenpunkte.
 *
 * Jede Zelle muss in Metern mindestens so breit sein wie der Korridorradius,
 * sonst deckt das betrachtete 3x3-Fenster den Radius nicht ab und es fehlen
 * Treffer. Ein Längengrad ist kürzer als ein Breitengrad, und zwar umso mehr,
 * je weiter nördlich man ist: Auf 52 Grad sind es rund 68 statt 111 km. Mit
 * einer gemeinsamen Kantenlänge in Grad wären die Zellen in Ost-West-Richtung
 * also zu schmal. Deshalb zwei Kantenlängen, und für die Ost-West-Richtung
 * gerechnet mit dem nördlichsten Punkt der Route, wo die Zellen am breitesten
 * ausfallen müssen.
 */
export function buildRouteIndex(routePoints, corridorMeters) {
  const cellSizeLat = corridorMeters / METERS_PER_DEGREE_LAT;

  let maxAbsLat = 0;
  for (const point of routePoints) {
    const absolute = Math.abs(point.lat);
    if (absolute > maxAbsLat) maxAbsLat = absolute;
  }
  // In Polnähe geht der Kosinus gegen null. Abgefangen, damit die Zellenbreite
  // nicht ins Unendliche läuft.
  const cosine = Math.max(Math.cos((maxAbsLat * Math.PI) / 180), 0.01);
  const cellSizeLon = corridorMeters / (METERS_PER_DEGREE_LON_EQUATOR * cosine);

  const cells = new Map();
  for (const point of routePoints) {
    const key = cellKey(point.lat, point.lon, cellSizeLat, cellSizeLon);
    const bucket = cells.get(key);
    if (bucket) bucket.push(point);
    else cells.set(key, [point]);
  }

  return { cells, cellSizeLat, cellSizeLon, corridorMeters, pointCount: routePoints.length };
}

function cellKey(lat, lon, cellSizeLat, cellSizeLon) {
  return `${Math.floor(lat / cellSizeLat)}:${Math.floor(lon / cellSizeLon)}`;
}

/** Kürzester Abstand eines Punktes zur Route, in Metern. null, wenn zu weit. */
export function distanceToRoute(point, index) {
  const latCell = Math.floor(point.lat / index.cellSizeLat);
  const lonCell = Math.floor(point.lon / index.cellSizeLon);

  let best = Infinity;
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      const bucket = index.cells.get(`${latCell + dLat}:${lonCell + dLon}`);
      if (!bucket) continue;
      for (const routePoint of bucket) {
        const d = distance(point, routePoint);
        if (d < best) best = d;
      }
    }
  }

  return best <= index.corridorMeters ? best : null;
}

/**
 * Filtert eine Liste auf die Einträge im Korridor.
 *
 * Vorgeschaltet ist ein Rechteck um die Route. Das erledigt den weitaus
 * groessten Teil der Kandidaten mit vier Vergleichen statt mit Wurzelrechnung.
 */
export function withinCorridor(candidates, routePoints, corridorMeters) {
  if (routePoints.length === 0) return [];

  const index = buildRouteIndex(routePoints, corridorMeters);
  const padding = corridorMeters / METERS_PER_DEGREE_LAT;
  const box = boundingBox(routePoints, padding);

  const inside = [];
  for (const candidate of candidates) {
    if (
      candidate.lat < box.minLat ||
      candidate.lat > box.maxLat ||
      candidate.lon < box.minLon ||
      candidate.lon > box.maxLon
    ) {
      continue;
    }
    const d = distanceToRoute(candidate, index);
    if (d !== null) inside.push({ ...candidate, distanceToRouteMeters: d });
  }

  return inside;
}

export function boundingBox(points, paddingDeg = 0) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const point of points) {
    if (point.lat < minLat) minLat = point.lat;
    if (point.lat > maxLat) maxLat = point.lat;
    if (point.lon < minLon) minLon = point.lon;
    if (point.lon > maxLon) maxLon = point.lon;
  }
  return {
    minLat: minLat - paddingDeg,
    maxLat: maxLat + paddingDeg,
    minLon: minLon - paddingDeg,
    maxLon: maxLon + paddingDeg,
  };
}

/**
 * Ordnet Registereinträge und gefundene Stationen einander zu.
 *
 * Rein über die Entfernung, mit einer grosszuegigeren Schwelle als beim
 * Redaktionsabgleich: Hier geht es nur um die Frage, ob dieselbe Anlage in
 * beiden Quellen vorkommt, nicht darum, welcher Datensatz gilt.
 */
export function matchSources(registerEntries, stations, thresholdMeters = 250) {
  const index = buildRouteIndex(
    stations.map((s) => ({ lat: s.lat, lon: s.lon, station: s })),
    thresholdMeters
  );

  const matched = [];
  const missing = [];

  for (const entry of registerEntries) {
    const d = distanceToRoute(entry, index);
    if (d !== null) matched.push(entry);
    else missing.push(entry);
  }

  return { matched, missing };
}

/**
 * Projiziert Punkte auf die Route.
 *
 * Liefert für jeden Punkt, wie weit entlang der Strecke er liegt und wie weit
 * er seitlich davon entfernt ist. Beides braucht die App, und beides kostet
 * keine einzige zusätzliche Anfrage.
 *
 * Die Umkreissuche liefert im Gegensatz zur Along-Route-Suche keinen Umweg
 * mit. Ohne diese Projektion stünden ihre Treffer ohne jede Ortsangabe in der
 * Liste, und eine Sortierung entlang der Fahrtrichtung wäre unmöglich.
 */
export function createRouteProjector(routePoints, searchRadiusMeters = 10000) {
  // Wegstrecke bis zu jedem Stützpunkt, einmal vorab.
  const cumulative = new Array(routePoints.length);
  cumulative[0] = 0;
  for (let i = 1; i < routePoints.length; i++) {
    cumulative[i] = cumulative[i - 1] + distance(routePoints[i - 1], routePoints[i]);
  }

  const index = buildRouteIndex(
    routePoints.map((point, i) => ({ lat: point.lat, lon: point.lon, i })),
    searchRadiusMeters
  );

  const totalMeters = cumulative[cumulative.length - 1] ?? 0;

  return {
    totalMeters,
    /** Gibt {progressMeters, distanceMeters} oder null, wenn zu weit weg. */
    project(point) {
      const latCell = Math.floor(point.lat / index.cellSizeLat);
      const lonCell = Math.floor(point.lon / index.cellSizeLon);

      let best = Infinity;
      let bestIndex = -1;

      for (let dLat = -1; dLat <= 1; dLat++) {
        for (let dLon = -1; dLon <= 1; dLon++) {
          const bucket = index.cells.get(`${latCell + dLat}:${lonCell + dLon}`);
          if (!bucket) continue;
          for (const candidate of bucket) {
            const d = distance(point, candidate);
            if (d < best) {
              best = d;
              bestIndex = candidate.i;
            }
          }
        }
      }

      if (bestIndex < 0) return null;
      return { progressMeters: cumulative[bestIndex], distanceMeters: best };
    },
  };
}

/**
 * Reichert Stationen um Lage entlang der Route an und sortiert sie danach.
 *
 * `maxDistanceMeters` wirft weg, was zu weit abseits liegt. Ohne diese Grenze
 * schleppt die Umkreissuche Innenstadt-Ladepunkte mit, für die niemand von der
 * Autobahn abfährt.
 */
export function orderAlongRoute(stations, routePoints, maxDistanceMeters = Infinity) {
  const projector = createRouteProjector(routePoints);

  const ordered = [];
  for (const station of stations) {
    const projection = projector.project(station);
    if (!projection) continue;
    if (projection.distanceMeters > maxDistanceMeters) continue;
    ordered.push({
      ...station,
      progressMeters: projection.progressMeters,
      distanceFromRouteMeters: projection.distanceMeters,
    });
  }

  // Entlang der Fahrtrichtung, bei Gleichstand das Nähere zuerst.
  ordered.sort(
    (a, b) =>
      a.progressMeters - b.progressMeters ||
      a.distanceFromRouteMeters - b.distanceFromRouteMeters
  );
  return ordered;
}
