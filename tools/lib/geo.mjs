// geo.mjs
// Spiegelt LadeRoute/TomTom/GeoUtils.swift. Beide Fassungen müssen dieselben
// Ergebnisse liefern, deshalb liegen die Tests hier und nicht nur in Xcode.

export const EARTH_RADIUS_M = 6371008.8;

/** Entfernung zweier Koordinaten in Metern (Haversine). */
export function distance(a, b) {
  const phi1 = (a.lat * Math.PI) / 180;
  const phi2 = (b.lat * Math.PI) / 180;
  const dPhi = ((b.lat - a.lat) * Math.PI) / 180;
  const dLambda = ((b.lon - a.lon) * Math.PI) / 180;

  const h =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Senkrechter Abstand von `point` zur Strecke start–end, in Metern. */
export function perpendicularDistance(point, start, end) {
  const latRef = (((start.lat + end.lat) / 2) * Math.PI) / 180;
  const mPerDegLat = 111132.0;
  const mPerDegLon = 111320.0 * Math.cos(latRef);

  const px = (point.lon - start.lon) * mPerDegLon;
  const py = (point.lat - start.lat) * mPerDegLat;
  const ex = (end.lon - start.lon) * mPerDegLon;
  const ey = (end.lat - start.lat) * mPerDegLat;

  const segmentLengthSquared = ex * ex + ey * ey;
  if (segmentLengthSquared === 0) return Math.sqrt(px * px + py * py);

  const t = Math.max(0, Math.min(1, (px * ex + py * ey) / segmentLengthSquared));
  const dx = px - t * ex;
  const dy = py - t * ey;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Douglas-Peucker, iterativ. */
export function simplify(coordinates, toleranceMeters) {
  if (coordinates.length <= 2) return [...coordinates];

  const keep = new Array(coordinates.length).fill(false);
  keep[0] = true;
  keep[coordinates.length - 1] = true;

  const stack = [[0, coordinates.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;

    let maxDistance = 0;
    let maxIndex = first;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(coordinates[i], coordinates[first], coordinates[last]);
      if (d > maxDistance) {
        maxDistance = d;
        maxIndex = i;
      }
    }

    if (maxDistance > toleranceMeters) {
      keep[maxIndex] = true;
      stack.push([first, maxIndex]);
      stack.push([maxIndex, last]);
    }
  }

  return coordinates.filter((_, i) => keep[i]);
}

/** Gleichmäßiges Ausdünnen, Anfang und Ende bleiben erhalten. */
export function strideTo(coordinates, maxPoints) {
  if (coordinates.length <= maxPoints || maxPoints < 2) return [...coordinates];

  const result = [];
  const step = (coordinates.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    result.push(coordinates[Math.round(i * step)]);
  }
  return result;
}

/** Reduziert eine Route auf höchstens maxPoints Stützpunkte. */
export function downsample(coordinates, maxPoints) {
  if (maxPoints < 2) return [...coordinates];
  if (coordinates.length <= maxPoints) return [...coordinates];

  let tolerance = 10;
  let simplified = coordinates;
  for (let i = 0; i < 20; i++) {
    simplified = simplify(coordinates, tolerance);
    if (simplified.length <= maxPoints) return simplified;
    tolerance *= 2;
  }
  return strideTo(simplified, maxPoints);
}

/**
 * Zerlegt eine Route in Abschnitte von etwa segmentLengthMeters Länge.
 * Aufeinanderfolgende Abschnitte überlappen sich um einen Punkt.
 */
export function splitIntoSegments(coordinates, segmentLengthMeters) {
  if (coordinates.length < 2 || segmentLengthMeters <= 0) {
    return coordinates.length === 0 ? [] : [[...coordinates]];
  }

  const segments = [];
  let current = [coordinates[0]];
  let accumulated = 0;

  for (let i = 1; i < coordinates.length; i++) {
    accumulated += distance(coordinates[i - 1], coordinates[i]);
    current.push(coordinates[i]);

    if (accumulated >= segmentLengthMeters && i < coordinates.length - 1) {
      segments.push(current);
      current = [coordinates[i]];
      accumulated = 0;
    }
  }

  if (current.length >= 2) {
    segments.push(current);
  } else if (segments.length > 0) {
    segments[segments.length - 1].push(...current);
  }

  return segments;
}

/** Gesamtlänge eines Linienzugs in Metern. */
export function pathLength(coordinates) {
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    total += distance(coordinates[i - 1], coordinates[i]);
  }
  return total;
}
