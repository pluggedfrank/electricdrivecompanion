// evsearch.mjs
// Spiegelt LadeRoute/TomTom/TomTomAPIClient.swift: Anfrage bauen, Antwort in
// das Domänenmodell übersetzen.

import { coveredCorridorWidth, downsample, samplePointsAlongRoute, splitIntoSegments } from './geo.mjs';

export const BASE_URL = 'https://api.tomtom.com';
export const EV_STATION_CATEGORY = '7309';

/**
 * Ladeleistungsstufen. Spiegelt PowerTier in TomTomAPIClient.swift.
 *
 * Auf der Langstrecke ist alles unter 50 kW ohne Belang: Wer 300 km vor sich
 * hat, laedt nicht an einer 22-kW-AC-Saeule. Da eine Antwort nur 20 Treffer
 * fasst, verdraengen langsame Saeulen sonst die brauchbaren.
 *
 * Die Vorgabe liegt bei 150 und nicht bei 50: Eine 50-kW-Saeule faehrt heute
 * niemand mehr gezielt an, das ist eine Notloesung, wenn sonst nichts in
 * Reichweite steht. Waehlbar bleibt sie.
 */
export const POWER_TIERS = {
  alle: 0,
  notloesung: 50,
  schnell: 150,
  hpc: 300,
};

/** Was gilt, wenn nichts gewaehlt wurde. */
export const DEFAULT_POWER_TIER = POWER_TIERS.schnell;

// TomTom deckelt die Anfragen pro Sekunde. Wird zu schnell gefeuert, kommt
// HTTP 401 mit "missing valid authentication credentials" zurueck, obwohl der
// Key gueltig ist und dieselbe Anfrage eine Sekunde spaeter durchgeht. Deshalb
// wird clientseitig gebremst statt sich auf den Fehlertext zu verlassen.
export const MIN_REQUEST_INTERVAL_MS = 300;
export const THROTTLE_BACKOFF_MS = 2000;

/** Statuscodes, hinter denen eine Drosselung stecken kann. */
const THROTTLE_STATUS = new Set([401, 403, 429]);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Eine Anfrage mit Bremse und einem Nachfassversuch.
 *
 * Der Unterschied ist diagnostisch wertvoll: klappt der zweite Versuch nach
 * zwei Sekunden, war es das Tempolimit. Bleibt es beim Fehler, stimmt etwas
 * mit dem Key oder der Produktfreigabe nicht.
 */
export async function requestWithRetry(fetchImpl, url, init, options = {}) {
  const { backoffMs = THROTTLE_BACKOFF_MS, sleepImpl = sleep } = options;

  let response = await fetchImpl(url, init);
  if (response.ok || !THROTTLE_STATUS.has(response.status)) return response;

  await sleepImpl(backoffMs);
  response = await fetchImpl(url, init);
  if (!response.ok && THROTTLE_STATUS.has(response.status)) {
    response.wasThrottledTwice = true;
  }
  return response;
}

export const DEFAULT_OPTIONS = {
  // Der Suchbegriff steht im Pfad und ist Pflicht. Er wirkt als Freitextsuche
  // ueber POI-Namen und Kategorien. "charging station" trifft deshalb nur
  // Betreiber, die das Wort im Namen fuehren, und laesst Ionity, EnBW oder
  // Aral pulse liegen. "electric vehicle station" ist im Test der einzige
  // Begriff, der die Kategorie selbst trifft.
  query: 'electric vehicle station',
  // Kategoriefilter aus. Empirisch am 08.09. gegen die echte API geprueft:
  // categorySet=7309 liefert auf einem 100-km-Abschnitt der A31 null Treffer,
  // dieselbe Anfrage ohne den Parameter liefert 20. Das gilt fuer jeden
  // getesteten Suchbegriff. Der Parameter filtert nicht, er loescht das
  // Ergebnis. Statt ihm wird unten an den Daten selbst geprueft.
  useCategoryFilter: false,
  // Kategorie-ID, falls der Filter doch benutzt wird. Ueber --category
  // ueberschreibbar, um andere IDs durchzuprobieren.
  categoryId: EV_STATION_CATEGORY,
  // Treffer ohne Ladeinfrastruktur verwerfen. Ersetzt den Kategoriefilter.
  onlyEVStations: true,
  maxDetourSeconds: 600,
  limitPerRequest: 20,
  // Mindest-Ladeleistung in kW. Vorgabe ist die Langstreckenschwelle: Wer 300 km
  // vor sich hat, laedt nicht an einer 22-kW-AC-Saeule, und da eine Antwort nur
  // 20 Treffer fasst, verdraengen langsame Saeulen sonst die brauchbaren.
  // 0 oder null schaltet den Filter ab.
  minPowerKW: DEFAULT_POWER_TIER,
  // Die Leistung zusaetzlich an den Daten pruefen, statt dem Server zu trauen.
  // Nach der Erfahrung mit categorySet ist das keine Paranoia.
  enforceMinPowerLocally: true,
  connectorTypes: [],
  // 50 statt 100 km: ein 100-km-Abschnitt lief im Test ins 20-Treffer-Limit,
  // es blieben also Stationen unsichtbar.
  segmentLengthMeters: 50000,
  maxRoutePointsPerRequest: 200,
  spreadResults: true,
  // Pause zwischen zwei Anfragen, damit das Tempolimit nicht greift.
  requestIntervalMs: MIN_REQUEST_INTERVAL_MS,

  // --- Umkreissuche ---
  // Gemessen am 08.09.2026 gegen das amtliche Register: Die Along-Route-Suche
  // deckt bis 500 m neben der Route 95 bis 97 Prozent ab, jenseits von 1000 m
  // exakt null. Auch 30 Minuten erlaubter Umweg aendern daran nichts, TomTom
  // legt offenbar einen festen geometrischen Korridor um die Route. Wer die
  // Ladeparks etwas abseits sehen will, braucht deshalb zusaetzlich
  // Umkreissuchen entlang der Strecke.
  nearbyRadiusMeters: 5000,
  // Radius und Abstand haengen zusammen: Der abgedeckte Korridor betraegt
  // sqrt(R^2 - (Abstand/2)^2). Bei 5000 m Radius und 8000 m Abstand sind das
  // 3000 m, also mehr als die 2 km, um die es geht. Zu grosse Abstaende
  // reissen Luecken zwischen die Kreise.
  nearbySpacingMeters: 8000,
  // poiSearch liefert bis zu 100 Treffer, deutlich mehr als die 20 der
  // Along-Route-Suche.
  nearbyLimit: 100,
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
  if (opts.useCategoryFilter) url.searchParams.set('categorySet', opts.categoryId ?? EV_STATION_CATEGORY);
  url.searchParams.set('sortBy', 'detourTime');

  if (opts.spreadResults) url.searchParams.set('spreadingMode', 'auto');
  // 0 und null heissen beide: kein Filter, also den Parameter weglassen.
  if (opts.minPowerKW) url.searchParams.set('minPowerKW', String(opts.minPowerKW));
  if (opts.connectorTypes.length > 0) {
    url.searchParams.set('connectorSet', opts.connectorTypes.join(','));
  }

  return url.toString();
}

/** Request-Body der Along-Route-Suche. */
export function buildRouteBody(points) {
  return { route: { points: points.map((p) => ({ lat: p.lat, lon: p.lon })) } };
}

/**
 * Baut die URL einer Umkreissuche.
 *
 * poiSearch statt searchAlongRoute: Hier zaehlt nicht der Umweg, sondern die
 * Luftlinie, und genau das brauchen wir fuer die Ladeparks, die die
 * Along-Route-Suche nicht mehr erfasst.
 */
export function buildNearbySearchURL(apiKey, point, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const query = encodeURIComponent(opts.query);
  const url = new URL(`${BASE_URL}/search/2/poiSearch/${query}.json`);

  url.searchParams.set('key', apiKey);
  url.searchParams.set('lat', String(point.lat));
  url.searchParams.set('lon', String(point.lon));
  url.searchParams.set('radius', String(Math.round(opts.nearbyRadiusMeters)));
  url.searchParams.set('limit', String(Math.min(opts.nearbyLimit, 100)));
  if (opts.useCategoryFilter) url.searchParams.set('categorySet', opts.categoryId ?? EV_STATION_CATEGORY);
  if (opts.minPowerKW) url.searchParams.set('minPowerKW', String(opts.minPowerKW));
  if (opts.connectorTypes.length > 0) {
    url.searchParams.set('connectorSet', opts.connectorTypes.join(','));
  }

  return url.toString();
}

/**
 * Sucht im Umkreis von Punkten entlang der Route.
 *
 * Ergaenzung zur Along-Route-Suche, kein Ersatz: Die kennt den Umweg und
 * sortiert danach, was fuer die Reihenfolge wertvoll ist. Die Umkreissuche
 * holt dafuer, was etwas weiter abseits liegt.
 */
export async function searchAroundRoute(apiKey, routeGeometry, options = {}, fetchImpl = fetch) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sleepImpl = opts.sleepImpl ?? sleep;

  const points = samplePointsAlongRoute(routeGeometry, opts.nearbySpacingMeters);
  const merged = new Map();
  const truncated = [];

  for (const [index, point] of points.entries()) {
    if (index > 0 && opts.requestIntervalMs > 0) await sleepImpl(opts.requestIntervalMs);

    const url = buildNearbySearchURL(apiKey, point, opts);
    const response = await requestWithRetry(fetchImpl, url, {}, { sleepImpl });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`TomTom antwortet mit ${response.status}: ${text.slice(0, 200)}`);
    }

    const json = await response.json();
    // Rohzahl vor jeder Filterung: Nur daran laesst sich erkennen, ob TomTom
    // abgeschnitten hat. In einem Ballungsraum kann ein 5-km-Umkreis mehr
    // Ladeparks enthalten, als eine Antwort fasst, und dann fehlt etwas, ohne
    // dass es sich meldet.
    const rohe = (json.results ?? []).length;
    if (rohe >= Math.min(opts.nearbyLimit, 100)) {
      truncated.push({ point, count: rohe });
    }

    for (const station of parseAlongRouteResponse(json, opts)) {
      if (!merged.has(station.id)) merged.set(station.id, station);
    }
  }

  return {
    stations: [...merged.values()],
    requestCount: points.length,
    coveredCorridorMeters: coveredCorridorWidth(opts.nearbyRadiusMeters, opts.nearbySpacingMeters),
    // Umkreise, in denen die Antwort ans Limit stiess. Dort fehlt vermutlich
    // etwas; Abhilfe schafft ein kleinerer Radius bei kleinerem Abstand.
    truncated,
  };
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
    categories: result.poi?.categories ?? [],
    availabilityID: result.dataSources?.chargingAvailability?.id ?? null,
    detourSeconds: result.detourTime ?? null,
    detourMeters: result.detourDistance ?? null,
    distanceFromRouteMeters: result.dist ?? null,
    operatorName,
  };
}

/**
 * Ist dieser Treffer wirklich eine Ladestation?
 *
 * Der Kategoriefilter der API ist unbrauchbar (siehe useCategoryFilter), also
 * wird am Datensatz selbst entschieden. Ein Ladepark bringt seine Anschluesse
 * mit; das ist ein harter Beleg und kein Namensraten. Fehlen die Anschluesse,
 * entscheidet ersatzweise die Kategorieangabe des POI.
 */
export function isChargingStation(station) {
  if (station.connectors.length > 0) return true;

  return (station.categories ?? []).some((category) =>
    /electric vehicle|charging|ladestation|ladesäule|ladesaeule/i.test(category)
  );
}

export function parseAlongRouteResponse(json, options = {}) {
  let stations = (json.results ?? []).map(toChargingStation);

  const onlyEV = options.onlyEVStations ?? DEFAULT_OPTIONS.onlyEVStations;
  if (onlyEV) stations = stations.filter(isChargingStation);

  const enforceLocally = options.enforceMinPowerLocally ?? DEFAULT_OPTIONS.enforceMinPowerLocally;
  const minPower = options.minPowerKW ?? DEFAULT_OPTIONS.minPowerKW;
  if (enforceLocally && minPower) {
    stations = stations.filter((station) => meetsMinPower(station, minPower));
  }

  return stations;
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
 * Erreicht die Station die geforderte Leistung?
 *
 * Stationen ohne Leistungsangabe bleiben drin. Fehlende Daten sind kein Beleg
 * fuer eine langsame Saeule, und einen echten Ladepark wegen einer Luecke im
 * Datensatz zu verwerfen waere der schlimmere Fehler. Sie sind ueber
 * hasKnownPower erkennbar und koennen in der Oberflaeche markiert werden.
 */
export function meetsMinPower(station, minPowerKW) {
  if (!minPowerKW) return true;
  const power = maxPowerKW(station);
  if (power == null) return true;
  return power >= minPowerKW;
}

export function hasKnownPower(station) {
  return maxPowerKW(station) != null;
}

/**
 * Der komplette Suchlauf über eine Route. `fetchImpl` wird injiziert, damit die
 * Tests ohne Netz laufen.
 */
export async function searchAlongRoute(apiKey, routeGeometry, options = {}, fetchImpl = fetch) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sleepImpl = opts.sleepImpl ?? sleep;
  if (routeGeometry.length < 2) throw new Error('Route braucht mindestens zwei Punkte.');

  const segments = splitIntoSegments(routeGeometry, opts.segmentLengthMeters);
  const merged = new Map();
  const requests = [];

  for (const [index, segment] of segments.entries()) {
    // Zwischen zwei Abschnitten kurz warten, sonst greift das Tempolimit.
    if (index > 0 && opts.requestIntervalMs > 0) await sleepImpl(opts.requestIntervalMs);

    const points = downsample(segment, opts.maxRoutePointsPerRequest);
    const url = buildAlongRouteURL(apiKey, opts);
    const body = buildRouteBody(points);
    requests.push({ url, pointCount: points.length });

    const response = await requestWithRetry(
      fetchImpl,
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      { sleepImpl }
    );

    if (!response.ok) {
      const text = await response.text();
      const hint = response.wasThrottledTwice
        ? ' Auch der zweite Versuch scheiterte, es liegt also nicht am Tempolimit.'
        : '';
      throw new Error(`TomTom antwortet mit ${response.status}: ${text.slice(0, 200)}.${hint}`);
    }

    for (const station of parseAlongRouteResponse(await response.json(), opts)) {
      if (!merged.has(station.id)) merged.set(station.id, station);
    }
  }

  return { stations: [...merged.values()], requests, segmentCount: segments.length };
}
