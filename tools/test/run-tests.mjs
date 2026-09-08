// run-tests.mjs
// Prüft die Logik, die in Swift und JavaScript doppelt vorliegt.
//
//   node --test ios/tools/test/run-tests.mjs
//
// Was hier grün ist, muss in Swift genauso rauskommen. Wer eine der beiden
// Fassungen ändert, ändert die andere mit.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as geo from '../lib/geo.mjs';
import * as ev from '../lib/evsearch.mjs';
import * as editorial from '../lib/editorial.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const entries = JSON.parse(
  readFileSync(join(here, '..', '..', 'LadeRoute', 'Resources', 'editorial-stations.json'), 'utf8')
);

const MEERBUSCH = { lat: 51.2560, lon: 6.6890 };
const NORDDEICH = { lat: 53.6148, lon: 7.1621 };

/** Tests sollen nicht wirklich warten. */
const noSleep = async () => {};

/** Synthetische Route mit gleichmäßigen Zwischenpunkten. */
function syntheticRoute(from, to, points) {
  return Array.from({ length: points }, (_, i) => {
    const t = i / (points - 1);
    return { lat: from.lat + (to.lat - from.lat) * t, lon: from.lon + (to.lon - from.lon) * t };
  });
}

// ---------------------------------------------------------------- Geometrie

test('Entfernung Meerbusch nach Norddeich liegt im plausiblen Bereich', () => {
  const km = geo.distance(MEERBUSCH, NORDDEICH) / 1000;
  assert.ok(km > 260 && km < 270, `erwartet 260-270 km, war ${km.toFixed(1)}`);
});

test('Entfernung ist symmetrisch und null zu sich selbst', () => {
  assert.equal(geo.distance(MEERBUSCH, MEERBUSCH), 0);
  assert.ok(
    Math.abs(geo.distance(MEERBUSCH, NORDDEICH) - geo.distance(NORDDEICH, MEERBUSCH)) < 1e-6
  );
});

test('ein Grad Breite entspricht rund 111 km', () => {
  const d = geo.distance({ lat: 51, lon: 7 }, { lat: 52, lon: 7 }) / 1000;
  assert.ok(d > 111 && d < 112, `war ${d.toFixed(2)} km`);
});

test('senkrechter Abstand: Punkt auf der Linie ergibt null', () => {
  const d = geo.perpendicularDistance(
    { lat: 51.5, lon: 7.0 },
    { lat: 51.0, lon: 7.0 },
    { lat: 52.0, lon: 7.0 }
  );
  assert.ok(d < 1, `war ${d.toFixed(3)} m`);
});

test('senkrechter Abstand wird jenseits der Endpunkte gekappt', () => {
  // Punkt liegt hinter dem Ende der Strecke: gemessen wird zum Endpunkt.
  const d = geo.perpendicularDistance(
    { lat: 53.0, lon: 7.0 },
    { lat: 51.0, lon: 7.0 },
    { lat: 52.0, lon: 7.0 }
  );
  const toEnd = geo.distance({ lat: 53.0, lon: 7.0 }, { lat: 52.0, lon: 7.0 });
  assert.ok(Math.abs(d - toEnd) / toEnd < 0.01, `${d.toFixed(0)} m vs ${toEnd.toFixed(0)} m`);
});

test('Vereinfachung behält Anfang und Ende', () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 500);
  const simplified = geo.simplify(route, 50);
  assert.deepEqual(simplified[0], route[0]);
  assert.deepEqual(simplified.at(-1), route.at(-1));
});

test('eine gerade Linie schrumpft auf zwei Punkte', () => {
  const straight = syntheticRoute(MEERBUSCH, NORDDEICH, 200);
  assert.equal(geo.simplify(straight, 50).length, 2);
});

test('Ausdünnen hält die Obergrenze ein', () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 4000).map((p, i) => ({
    // Zickzack, damit Douglas-Peucker nicht alles wegwirft.
    lat: p.lat + (i % 2 === 0 ? 0.004 : -0.004),
    lon: p.lon,
  }));
  for (const max of [10, 50, 200]) {
    const result = geo.downsample(route, max);
    assert.ok(result.length <= max, `maxPoints=${max}, war ${result.length}`);
    assert.ok(result.length >= 2);
  }
});

test('Ausdünnen lässt kurze Routen unangetastet', () => {
  const short = syntheticRoute(MEERBUSCH, NORDDEICH, 5);
  assert.equal(geo.downsample(short, 200).length, 5);
});

test('Routenaufteilung deckt die ganze Strecke ab', () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 1000);
  const segments = geo.splitIntoSegments(route, 100000);

  assert.ok(segments.length >= 2, `erwartet mehrere Abschnitte, war ${segments.length}`);
  assert.deepEqual(segments[0][0], route[0]);
  assert.deepEqual(segments.at(-1).at(-1), route.at(-1));
  for (const segment of segments) assert.ok(segment.length >= 2);
});

test('Abschnitte überlappen sich exakt um einen Punkt', () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 1000);
  const segments = geo.splitIntoSegments(route, 100000);
  for (let i = 1; i < segments.length; i++) {
    assert.deepEqual(segments[i][0], segments[i - 1].at(-1), `Naht zwischen ${i - 1} und ${i}`);
  }
});

test('Summe der Abschnittslängen entspricht der Routenlänge', () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 1000);
  const segments = geo.splitIntoSegments(route, 100000);
  const total = geo.pathLength(route);
  const sum = segments.reduce((acc, s) => acc + geo.pathLength(s), 0);
  assert.ok(Math.abs(sum - total) / total < 0.001, `${sum.toFixed(0)} vs ${total.toFixed(0)}`);
});

// ------------------------------------------------------------ Anfragebau

test('maxDetourTime wird bei 3600 Sekunden gekappt', () => {
  const url = new URL(ev.buildAlongRouteURL('KEY', { maxDetourSeconds: 99999 }));
  assert.equal(url.searchParams.get('maxDetourTime'), '3600');
});

test('limit wird bei 20 gekappt, dem Maximum der Along-Route-Suche', () => {
  const url = new URL(ev.buildAlongRouteURL('KEY', { limitPerRequest: 100 }));
  assert.equal(url.searchParams.get('limit'), '20');
});

test('Schlüssel und Sortierung stehen immer in der Anfrage', () => {
  const url = new URL(ev.buildAlongRouteURL('KEY'));
  assert.equal(url.searchParams.get('sortBy'), 'detourTime');
  assert.equal(url.searchParams.get('key'), 'KEY');
});

test('der Suchbegriff steht encodiert im Pfad, nicht in der Query', () => {
  const url = new URL(ev.buildAlongRouteURL('KEY'));
  assert.ok(
    url.pathname.endsWith('/searchAlongRoute/electric%20vehicle%20station.json'),
    `Pfad war ${url.pathname}`
  );
  assert.equal(url.searchParams.get('query'), null);
});

test('der Suchbegriff laesst sich ueberschreiben', () => {
  const url = new URL(ev.buildAlongRouteURL('KEY', { query: 'Ladestation' }));
  assert.ok(url.pathname.endsWith('/searchAlongRoute/Ladestation.json'), url.pathname);
});

test('der Kategoriefilter laesst sich abschalten', () => {
  const url = new URL(ev.buildAlongRouteURL('KEY', { useCategoryFilter: false }));
  assert.equal(url.searchParams.get('categorySet'), null);
});

test('Filter landen nur dann in der Anfrage, wenn sie gesetzt sind', () => {
  const ohne = new URL(ev.buildAlongRouteURL('KEY'));
  assert.equal(ohne.searchParams.get('minPowerKW'), null);
  assert.equal(ohne.searchParams.get('connectorSet'), null);

  const mit = new URL(
    ev.buildAlongRouteURL('KEY', {
      minPowerKW: 100,
      connectorTypes: ['IEC62196Type2CCS', 'Chademo'],
    })
  );
  assert.equal(mit.searchParams.get('minPowerKW'), '100');
  assert.equal(mit.searchParams.get('connectorSet'), 'IEC62196Type2CCS,Chademo');
});

test('Request-Body hat die von TomTom erwartete Form', () => {
  const body = ev.buildRouteBody([{ lat: 51, lon: 7 }, { lat: 52, lon: 8 }]);
  assert.deepEqual(body, { route: { points: [{ lat: 51, lon: 7 }, { lat: 52, lon: 8 }] } });
});

// --------------------------------------------------------- Antwortauswertung

test('Suchtreffer werden vollständig übersetzt', () => {
  const stations = ev.parseAlongRouteResponse(fixture('alongroute-response.json'));
  assert.equal(stations.length, 5, 'die Tankstelle muss herausgefallen sein');

  const first = stations[0];
  assert.equal(first.id, 'poi-1');
  assert.equal(first.name, 'EnBW Ladepark Kamp-Lintfort');
  assert.equal(first.operatorName, 'EnBW');
  assert.equal(first.availabilityID, 'avail-kamp-lintfort');
  assert.equal(first.detourSeconds, 95);
  assert.equal(first.connectors.length, 2);
  assert.equal(ev.maxPowerKW(first), 300);
});

test('fehlende Felder führen nicht zum Absturz', () => {
  const stations = ev.parseAlongRouteResponse(fixture('alongroute-response.json'));
  const ohneAdresse = stations.find((s) => s.id === 'poi-5');
  assert.equal(ohneAdresse.address, '');
  assert.equal(ohneAdresse.availabilityID, null);
  assert.equal(ev.maxPowerKW(ohneAdresse), null);
});

test('Belegung mit current-Wrapper wird summiert', () => {
  const a = ev.parseAvailability(fixture('availability-nested.json'));
  assert.deepEqual(
    { available: a.available, occupied: a.occupied, outOfService: a.outOfService, total: a.total },
    { available: 6, occupied: 1, outOfService: 1, total: 8 }
  );
});

test('Belegung ohne current-Wrapper wird genauso gelesen', () => {
  const a = ev.parseAvailability(fixture('availability-flat.json'));
  assert.equal(a.available, 1);
  assert.equal(a.occupied, 3);
  assert.equal(a.total, 4);
});

test('fehlt total, wird es aus den Zählern rekonstruiert', () => {
  const a = ev.parseAvailability({
    connectors: [{ availability: { current: { available: 2, occupied: 1 } } }],
  });
  assert.equal(a.total, 3);
});

// ------------------------------------------------- Ladestation oder nicht

test('ohne Kategoriefilter kommt Fremdes mit und wird aussortiert', () => {
  const roh = ev.parseAlongRouteResponse(fixture('alongroute-response.json'), {
    onlyEVStations: false,
  });
  const gefiltert = ev.parseAlongRouteResponse(fixture('alongroute-response.json'));

  assert.equal(roh.length, 6);
  assert.equal(gefiltert.length, 5);
  assert.ok(
    roh.some((s) => s.id === 'poi-6'),
    'die Tankstelle steckt in der Rohantwort'
  );
  assert.ok(
    !gefiltert.some((s) => s.id === 'poi-6'),
    'die Tankstelle darf nach dem Filter nicht mehr drin sein'
  );
});

test('vorhandene Anschlüsse belegen eine Ladestation', () => {
  assert.equal(
    ev.isChargingStation({ connectors: [{ ratedPowerKW: 300 }], categories: [] }),
    true
  );
});

test('ohne Anschlüsse entscheidet die Kategorieangabe', () => {
  assert.equal(
    ev.isChargingStation({ connectors: [], categories: ['electric vehicle station'] }),
    true
  );
  assert.equal(
    ev.isChargingStation({ connectors: [], categories: ['petrol station'] }),
    false
  );
  assert.equal(ev.isChargingStation({ connectors: [], categories: [] }), false);
});

test('der Kategoriefilter der API ist per Vorgabe aus', () => {
  // Empirisch belegt: categorySet=7309 liefert null Treffer, ohne den
  // Parameter kommen dieselben Anfragen mit 20 Treffern zurueck.
  const url = new URL(ev.buildAlongRouteURL('KEY'));
  assert.equal(url.searchParams.get('categorySet'), null);
});

test('die Kategorie-ID lässt sich zum Ausprobieren setzen', () => {
  const url = new URL(
    ev.buildAlongRouteURL('KEY', { useCategoryFilter: true, categoryId: '7313' })
  );
  assert.equal(url.searchParams.get('categorySet'), '7313');
});

// -------------------------------------------------------------- Zuordnung

test('Station trifft den Redaktionseintrag über Nähe und Betreiber', () => {
  const stations = ev.parseAlongRouteResponse(fixture('alongroute-response.json'));
  const treffer = editorial.match(stations.find((s) => s.id === 'poi-1'), entries);
  assert.ok(treffer, 'poi-1 hätte ed-001 treffen müssen');
  assert.equal(treffer.id, 'ed-001');
});

test('zweiter Treffer über abweichenden Namen bei gleichem Betreiber', () => {
  const stations = ev.parseAlongRouteResponse(fixture('alongroute-response.json'));
  const treffer = editorial.match(stations.find((s) => s.id === 'poi-2'), entries);
  assert.equal(treffer?.id, 'ed-003');
});

test('weit entfernte Station bleibt ohne Zuordnung', () => {
  const stations = ev.parseAlongRouteResponse(fixture('alongroute-response.json'));
  assert.equal(editorial.match(stations.find((s) => s.id === 'poi-3'), entries), null);
});

test('knapp jenseits des Radius wird nicht mehr zugeordnet', () => {
  const stations = ev.parseAlongRouteResponse(fixture('alongroute-response.json'));
  const poi4 = stations.find((s) => s.id === 'poi-4');
  const ed002 = entries.find((e) => e.id === 'ed-002');
  const d = geo.distance(
    { lat: ed002.latitude, lon: ed002.longitude },
    { lat: poi4.lat, lon: poi4.lon }
  );
  assert.ok(d > editorial.MAX_MATCH_DISTANCE_M, `Abstand war nur ${d.toFixed(0)} m`);
  assert.equal(editorial.match(poi4, entries), null);
});

test('Nähe allein reicht nicht: fremder Name und Betreiber verhindern die Zuordnung', () => {
  const stations = ev.parseAlongRouteResponse(fixture('alongroute-response.json'));
  const poi5 = stations.find((s) => s.id === 'poi-5');
  const ed005 = entries.find((e) => e.id === 'ed-005');
  const d = geo.distance(
    { lat: ed005.latitude, lon: ed005.longitude },
    { lat: poi5.lat, lon: poi5.lon }
  );
  assert.ok(d < editorial.MAX_MATCH_DISTANCE_M, `Abstand war ${d.toFixed(0)} m, sollte im Radius sein`);
  assert.equal(
    editorial.match(poi5, entries),
    null,
    'Wallbox eines Autohauses darf nicht als getesteter Ladepark durchgehen'
  );
});

test('eine hinterlegte POI-ID schlägt jede Heuristik', () => {
  const eintrag = { ...entries[0], tomtomPoiID: 'poi-3', latitude: 0, longitude: 0 };
  const stations = ev.parseAlongRouteResponse(fixture('alongroute-response.json'));
  const treffer = editorial.match(stations.find((s) => s.id === 'poi-3'), [eintrag]);
  assert.equal(treffer?.tomtomPoiID, 'poi-3');
});

test('Anreicherung liefert für jede Station einen Datensatz', () => {
  const stations = ev.parseAlongRouteResponse(fixture('alongroute-response.json'));
  const annotated = editorial.annotate(stations, entries);
  assert.equal(annotated.length, stations.length);
  assert.equal(annotated.filter((a) => a.editorial).length, 2);
});

// ------------------------------------------------------------- Suchlauf

test('lange Route wird in mehrere Anfragen zerlegt und dedupliziert', async () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 2000);
  let calls = 0;

  // Jede Anfrage liefert dieselben Treffer. Nach dem Zusammenführen dürfen
  // trotzdem nur fünf Stationen übrig bleiben.
  const mockFetch = async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.ok(body.route.points.length >= 2);
    assert.ok(body.route.points.length <= ev.DEFAULT_OPTIONS.maxRoutePointsPerRequest);
    return { ok: true, json: async () => fixture('alongroute-response.json') };
  };

  const result = await ev.searchAlongRoute('KEY', route, { sleepImpl: noSleep }, mockFetch);
  assert.equal(calls, result.segmentCount);
  assert.ok(result.segmentCount >= 2, `nur ${result.segmentCount} Abschnitt(e)`);
  assert.equal(result.stations.length, 5, 'Dubletten wurden nicht zusammengeführt');
});

test('Fehlerantwort wird als Fehler durchgereicht', async () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 10);
  const mockFetch = async () => ({ ok: false, status: 500, text: async () => 'Server Error' });
  await assert.rejects(
    () => ev.searchAlongRoute('KEY', route, { sleepImpl: noSleep }, mockFetch),
    /500/
  );
});

// ------------------------------------------------------------ Tempolimit

test('ein gedrosselter 401 wird einmal wiederholt und geht dann durch', async () => {
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    return calls === 1
      ? { ok: false, status: 401, text: async () => 'Unauthorized' }
      : { ok: true, json: async () => fixture('alongroute-response.json') };
  };

  const response = await ev.requestWithRetry(mockFetch, 'https://example.test', {}, {
    sleepImpl: noSleep,
  });
  assert.equal(calls, 2);
  assert.equal(response.ok, true);
  assert.notEqual(response.wasThrottledTwice, true);
});

test('bleibt der Fehler auch beim zweiten Versuch, wird er als echt markiert', async () => {
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    return { ok: false, status: 401, text: async () => 'Unauthorized' };
  };

  const response = await ev.requestWithRetry(mockFetch, 'https://example.test', {}, {
    sleepImpl: noSleep,
  });
  assert.equal(calls, 2, 'genau ein Nachfassversuch, keine Schleife');
  assert.equal(response.wasThrottledTwice, true);
});

test('ein Fehler ausserhalb der Drosselungscodes wird nicht wiederholt', async () => {
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    return { ok: false, status: 500, text: async () => 'Server Error' };
  };

  await ev.requestWithRetry(mockFetch, 'https://example.test', {}, { sleepImpl: noSleep });
  assert.equal(calls, 1);
});

test('zwischen den Abschnitten wird gewartet', async () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 2000);
  const pauses = [];
  const mockFetch = async () => ({ ok: true, json: async () => fixture('alongroute-response.json') });

  const result = await ev.searchAlongRoute(
    'KEY',
    route,
    { sleepImpl: async (ms) => pauses.push(ms) },
    mockFetch
  );

  // Eine Pause weniger als Abschnitte: vor dem ersten wird nicht gewartet.
  assert.equal(pauses.length, result.segmentCount - 1);
  assert.ok(pauses.every((ms) => ms >= ev.MIN_REQUEST_INTERVAL_MS), `Pausen: ${pauses}`);
});
