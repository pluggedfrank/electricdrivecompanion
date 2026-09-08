// evsearch.mjs
// Spiegelt LadeRoute/TomTom/TomTomAPIClient.swift: Anfrage bauen, Antwort in
// das Domänenmodell übersetzen.

import { downsample, splitIntoSegments } from './geo.mjs';

export const BASE_URL = 'https://api.tomtom.com';
export const EV_STATION_CATEGORY = '7309';

export const DEFAULT_OPTIONS = {
  // Der Suchbegriff steht im Pfad und ist Pflicht. Er wirkt als Freitextsuche
  // ueber POI-Namen und Kategorien. "charging station" trifft deshalb nur
  // Betreiber, die das Wort im Namen fuehren, und laesst Ionity, EnBW oder
  // Aral pulse liegen. Der offizielle Kategoriename zu 7309 trifft dagegen die
  // Kategorie selbst.
  query: 'electric vehicle station',
  // Zusaetzlich hart auf die EV-Kategorie filtern.
  useCategoryFilter: true,
  maxDetourSeconds: 600,
  limitPerRequest: 20,
  minPowerKW: null,
  connectorTypes: [],
  segmentLengthMeters: 100000,
  maxRoutePointsPerRequest: 200,
  spreadResults: true,
};

/**
 * Baut die URL einer Along-Route-Anfrage.
 * Grenzwerte werden hier gekappt, nicht erst vom Server abgelehnt.
 */
export function buildAlongRouteURL(apiKey, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const query = encodeURIComponent(opts.query);
  const url = new URL(`${BASE_URL}/search/2/searchAlongRoute/${query}.json`);

  url.searchParams.set('key', apiKey);
  url.searchParams.set('maxDetourTime', String(Math.min(opts.maxDetourSeconds, 3600)));
  url.searchParams.set('limit', String(Math.min(opts.limitPerRequest, 20)));
  if (opts.useCategoryFilter) url.searchParams.set('categorySet', EV_STATION_CATEGORY);
  url.searchParams.set('sortBy', 'detourTime');

  if (opts.spreadResults) url.searchParams.set('spreadingMode', 'auto');
  if (opts.minPowerKW != null) url.searchParams.set('minPowerKW', String(opts.minPowerKW));
  if (opts.connectorTypes.length > 0) {
    url.searchParams.set('connectorSet', opts.connectorTypes.join(','));
  }

  return url.toString();
}

/** Request-Body der Along-Route-Suche. */
export function buildRouteBody(points) {
  return { route: { points: points.map((p) => ({ lat: p.lat, lon: p.lon })) } };
}

export function buildAvailabilityURL(apiKey, availabilityID) {
  const url = new URL(`${BASE_URL}/search/2/chargingAvailability.json`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('chargingAvailability', availabilityID);
  return url.toString();
}

/** Ein Treffer der Search-API in das Modell der App. */
export function toChargingStation(result) {
  const address =
    result.address?.freeformAddress ??
    [result.address?.streetName, result.address?.municipality].filter(Boolean).join(', ');

  const operatorName = result.poi?.brands?.map((b) => b.name).filter(Boolean)[0] ?? null;

  return {
    id: result.id,
    name: result.poi?.name ?? operatorName ?? 'Ladestation',
    address,
    lat: result.position.lat,
    lon: result.position.lon,
    connectors: (result.chargingPark?.connectors ?? []).map((c) => ({
      type: c.connectorType ?? null,
      ratedPowerKW: c.ratedPowerKW ?? null,
      currentType: c.currentType ?? null,
    })),
    availabilityID: result.dataSources?.chargingAvailability?.id ?? null,
    detourSeconds: result.detourTime ?? null,
    detourMeters: result.detourDistance ?? null,
    distanceFromRouteMeters: result.dist ?? null,
    operatorName,
  };
}

export function parseAlongRouteResponse(json) {
  return (json.results ?? []).map(toChargingStation);
}

/**
 * Fasst die Belegungsantwort zusammen.
 * Akzeptiert `availability.current.available` und `availability.available`,
 * weil beide Formen in der Praxis vorkommen.
 */
export function parseAvailability(json) {
  let available = 0, occupied = 0, outOfService = 0, unknown = 0, total = 0;

  for (const connector of json.connectors ?? []) {
    const counts = connector.availability?.current ?? connector.availability ?? {};
    available += counts.available ?? 0;
    occupied += counts.occupied ?? 0;
    outOfService += counts.outOfService ?? 0;
    unknown += (counts.unknown ?? 0) + (counts.reserved ?? 0);
    total += connector.total ?? 0;
  }

  return {
    available,
    occupied,
    outOfService,
    unknown,
    total: total > 0 ? total : available + occupied + outOfService + unknown,
  };
}

export function maxPowerKW(station) {
  const powers = station.connectors.map((c) => c.ratedPowerKW).filter((p) => p != null);
  return powers.length > 0 ? Math.max(...powers) : null;
}

/**
 * Der komplette Suchlauf über eine Route. `fetchImpl` wird injiziert, damit die
 * Tests ohne Netz laufen.
 */
export async function searchAlongRoute(apiKey, routeGeometry, options = {}, fetchImpl = fetch) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (routeGeometry.length < 2) throw new Error('Route braucht mindestens zwei Punkte.');

  const segments = splitIntoSegments(routeGeometry, opts.segmentLengthMeters);
  const merged = new Map();
  const requests = [];

  for (const segment of segments) {
    const points = downsample(segment, opts.maxRoutePointsPerRequest);
    const url = buildAlongRouteURL(apiKey, opts);
    const body = buildRouteBody(points);
    requests.push({ url, pointCount: points.length });

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`TomTom antwortet mit ${response.status}: ${text.slice(0, 200)}`);
    }

    for (const station of parseAlongRouteResponse(await response.json())) {
      if (!merged.has(station.id)) merged.set(station.id, station);
    }
  }

  return { stations: [...merged.values()], requests, segmentCount: segments.length };
}
