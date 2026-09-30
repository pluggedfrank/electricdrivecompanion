// run-tests.mjs
// Prüft die Logik, die in Swift und JavaScript doppelt vorliegt.
//
//   node --test ios/tools/test/run-tests.mjs
//
// Was hier grün ist, muss in Swift genauso rauskommen. Wer eine der beiden
// Fassungen ändert, ändert die andere mit.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as geo from '../lib/geo.mjs';
import * as ev from '../lib/evsearch.mjs';
import * as editorial from '../lib/editorial.mjs';
import * as bnetza from '../lib/bnetza.mjs';
import * as corridor from '../lib/corridor.mjs';
import * as sites from '../lib/sites.mjs';
import * as redaktion from '../lib/redaktion.mjs';
import * as ladeplanung from '../lib/ladeplanung.mjs';
import * as matrix from '../lib/matrix.mjs';
import * as registerquelle from '../lib/registerquelle.mjs';
import * as umwege from '../lib/umwege.mjs';
import * as tabelle from '../lib/umwegtabelle.mjs';
import * as fahrt from '../lib/fahrt.mjs';
import * as marken from '../lib/marken.mjs';
import * as ansage from '../lib/ansage.mjs';
import * as akku from '../lib/akku.mjs';
import * as quellen from '../lib/quellen.mjs';
import * as abweichung from '../lib/abweichung.mjs';
import * as ziele from '../lib/ziele.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
// Die Redaktionsdatensätze der Tests liegen bewusst bei den Fixtures und nicht
// in der App. Was die App ausliefert, entsteht aus einem Import echter Treffer
// und ändert sich mit jedem Testbericht; die Zuordnungslogik braucht dagegen
// einen Bestand, der sich nicht bewegt.
const entries = fixture('editorial-entries.json');

/**
 * Die Fixture-Treffer ohne Leistungsfilter.
 *
 * Die Vorgabe liegt bei 150 kW, und in der Fixture steckt bewusst eine
 * 50-kW-Station. Tests, die Uebersetzung, Kategoriefilter oder Zuordnung
 * pruefen, sollen daran nicht haengen: Sonst faellt bei jeder Verschiebung der
 * Leistungsschwelle die halbe Testreihe um, ohne dass an ihrem Gegenstand
 * etwas falsch waere.
 */
const alleTreffer = (optionen = {}) =>
  ev.parseAlongRouteResponse(fixture('alongroute-response.json'), {
    minPowerKW: 0,
    ...optionen,
  });

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
  // Steckertypen sind per Vorgabe offen, die Ladeleistung ist es nicht:
  // sie steht auf der Langstreckenschwelle.
  const ohne = new URL(ev.buildAlongRouteURL('KEY'));
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
  const stations = alleTreffer();
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
  const stations = alleTreffer();
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
  const roh = alleTreffer({ onlyEVStations: false });
  const gefiltert = alleTreffer();

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

// ---------------------------------------------------------- Ladeleistung

test('auf der Langstrecke gilt ab 150 kW als Vorgabe', () => {
  // 50 kW faehrt niemand mehr gezielt an, das ist eine Notloesung. Waehlbar
  // bleibt die Stufe, voreingestellt ist sie nicht.
  assert.equal(ev.POWER_TIERS.notloesung, 50);
  assert.equal(ev.DEFAULT_POWER_TIER, 150);
  assert.equal(ev.DEFAULT_OPTIONS.minPowerKW, 150);
  const url = new URL(ev.buildAlongRouteURL('KEY'));
  assert.equal(url.searchParams.get('minPowerKW'), '150');
});

test('die Stufen decken sich mit den Schritten von State of Charge', () => {
  // Erfassung beginnt bei 300 kW, dann 150. Waeren die Zahlen hier andere,
  // zeigte die App etwas anderes an, als das Projekt erfasst.
  assert.deepEqual(ev.POWER_TIERS, { alle: 0, notloesung: 50, schnell: 150, hpc: 300 });
});

test('0 schaltet den Leistungsfilter ab, statt 0 zu senden', () => {
  const url = new URL(ev.buildAlongRouteURL('KEY', { minPowerKW: 0 }));
  assert.equal(url.searchParams.get('minPowerKW'), null);
});

test('die Leistungsgrenze wird auch lokal geprüft', () => {
  const station = (kW) => ({ connectors: kW == null ? [] : [{ ratedPowerKW: kW }] });

  assert.equal(ev.meetsMinPower(station(22), 50), false);
  assert.equal(ev.meetsMinPower(station(50), 50), true);
  assert.equal(ev.meetsMinPower(station(150), 150), true);
  assert.equal(ev.meetsMinPower(station(100), 150), false);
});

test('ohne Leistungsangabe bleibt eine Station drin', () => {
  // Fehlende Daten sind kein Beleg fuer eine langsame Saeule. Einen echten
  // Ladepark wegen einer Luecke im Datensatz zu verwerfen waere schlimmer.
  const ohneAngabe = { connectors: [] };
  assert.equal(ev.meetsMinPower(ohneAngabe, 150), true);
  assert.equal(ev.hasKnownPower(ohneAngabe), false);
});

test('die 22-kW-Säule fällt bei der Vorgabe heraus', () => {
  const antwort = {
    results: [
      {
        id: 'ac-22',
        position: { lat: 51, lon: 7 },
        poi: { name: 'Parkhaus Innenstadt' },
        chargingPark: { connectors: [{ connectorType: 'IEC62196Type2Outlet', ratedPowerKW: 22 }] },
      },
      {
        id: 'dc-300',
        position: { lat: 51.1, lon: 7.1 },
        poi: { name: 'Ladepark Autobahn' },
        chargingPark: { connectors: [{ connectorType: 'IEC62196Type2CCS', ratedPowerKW: 300 }] },
      },
    ],
  };

  const mitVorgabe = ev.parseAlongRouteResponse(antwort);
  assert.deepEqual(mitVorgabe.map((s) => s.id), ['dc-300']);

  const ohneFilter = ev.parseAlongRouteResponse(antwort, { minPowerKW: 0 });
  assert.equal(ohneFilter.length, 2);

  const nurHPC = ev.parseAlongRouteResponse(antwort, { minPowerKW: ev.POWER_TIERS.hpc });
  assert.deepEqual(nurHPC.map((s) => s.id), ['dc-300']);
});

// -------------------------------------------------------------- Zuordnung

test('Station trifft den Redaktionseintrag über Nähe und Betreiber', () => {
  const stations = alleTreffer();
  const treffer = editorial.match(stations.find((s) => s.id === 'poi-1'), entries);
  assert.ok(treffer, 'poi-1 hätte ed-001 treffen müssen');
  assert.equal(treffer.id, 'ed-001');
});

test('zweiter Treffer über abweichenden Namen bei gleichem Betreiber', () => {
  const stations = alleTreffer();
  const treffer = editorial.match(stations.find((s) => s.id === 'poi-2'), entries);
  assert.equal(treffer?.id, 'ed-003');
});

test('weit entfernte Station bleibt ohne Zuordnung', () => {
  const stations = alleTreffer();
  assert.equal(editorial.match(stations.find((s) => s.id === 'poi-3'), entries), null);
});

test('knapp jenseits des Radius wird nicht mehr zugeordnet', () => {
  const stations = alleTreffer();
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
  const stations = alleTreffer();
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
  const stations = alleTreffer();
  const treffer = editorial.match(stations.find((s) => s.id === 'poi-3'), [eintrag]);
  assert.equal(treffer?.tomtomPoiID, 'poi-3');
});

test('Anreicherung liefert für jede Station einen Datensatz', () => {
  const stations = alleTreffer();
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

  // Ohne Leistungsfilter: Gegenstand des Tests ist das Zusammenfuehren.
  const result = await ev.searchAlongRoute(
    'KEY',
    route,
    { sleepImpl: noSleep, minPowerKW: 0 },
    mockFetch
  );
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


// =========================================================== Bundesnetzagentur

const registerPath = join(here, 'fixtures', 'bnetza-auszug.csv');

test('die Kopfzeile wird gesucht, nicht gezählt', () => {
  const result = bnetza.loadRegister(registerPath);

  // Vor der Kopfzeile steht ein Vorspann. Wie lang er ist, ändert sich
  // zwischen den Ausgaben: In der Testdatei sind es ein paar Zeilen, in der
  // echten elf. Genau deshalb wird gesucht statt gezählt, und genau deshalb
  // steht hier keine feste Zahl.
  assert.ok(result.headerIndex > 0, 'es gibt einen Vorspann');
  assert.ok(
    result.headerFields.some((f) => f.includes('breitengrad')),
    'die gefundene Zeile ist wirklich die Kopfzeile'
  );
});

test('alle gesuchten Spalten werden über Namensfragmente gefunden', () => {
  const { columns } = bnetza.loadRegister(registerPath);
  for (const key of ['operator', 'latitude', 'longitude', 'powerKW', 'kind', 'city']) {
    assert.ok(columns[key] !== undefined, `Spalte ${key} fehlt`);
  }
});

test('deutsche Dezimalkommata werden gelesen', () => {
  assert.equal(bnetza.parseGermanNumber('51,50305'), 51.50305);
  assert.equal(bnetza.parseGermanNumber('300,00'), 300);
  assert.equal(bnetza.parseGermanNumber('1.234,5'), 1234.5);
  assert.equal(bnetza.parseGermanNumber(''), null);
  assert.equal(bnetza.parseGermanNumber('keine Zahl'), null);
});

test('ein einzelner Punkt ist ein Dezimalpunkt, kein Tausendertrenner', () => {
  // Der gefährlichste denkbare Fehler in dieser Datei: Punkte blind zu
  // entfernen macht aus 51.50305 die Zahl 5150305. Formal gültig, als
  // Koordinate irgendwo im Nichts, und ohne Prüfung nicht zu bemerken.
  assert.equal(bnetza.parseGermanNumber('51.50305'), 51.50305);
  assert.equal(bnetza.parseGermanNumber('6.96030'), 6.9603);
});

test('gemischte Schreibweisen: das hintere Zeichen trennt die Dezimalen', () => {
  assert.equal(bnetza.parseGermanNumber('1.234,56'), 1234.56);
  assert.equal(bnetza.parseGermanNumber('1,234.56'), 1234.56);
});

test('Koordinaten außerhalb Deutschlands gelten als unplausibel', () => {
  assert.equal(bnetza.isPlausibleGermanCoordinate(51.5, 6.5), true);
  // Vertauscht: Länge und Breite verwechselt.
  assert.equal(bnetza.isPlausibleGermanCoordinate(9.99, 53.55), false);
  // Das Ergebnis eines falsch geratenen Trennzeichens.
  assert.equal(bnetza.isPlausibleGermanCoordinate(5150305, 6.5), false);
});

test('eine englisch geschriebene Koordinate landet am richtigen Ort', () => {
  const { entries } = bnetza.loadRegister(registerPath);
  const koeln = entries.find((e) => e.city === 'Koeln');
  assert.ok(koeln, 'die Zeile mit Dezimalpunkt fehlt');
  assert.ok(Math.abs(koeln.lat - 50.9375) < 0.001, `lat war ${koeln.lat}`);
  assert.ok(Math.abs(koeln.lon - 6.9603) < 0.001, `lon war ${koeln.lon}`);
});

test('übersprungene Zeilen werden nach Ursache aufgeschlüsselt', () => {
  const result = bnetza.loadRegister(registerPath);
  assert.equal(result.skipReasons.leereKoordinate, 2);
  assert.equal(result.skipReasons.unplausibleKoordinate, 1, 'die vertauschte Koordinate');
  assert.equal(
    result.skipped,
    Object.values(result.skipReasons).reduce((a, b) => a + b, 0),
    'die Summe muss aufgehen'
  );
  assert.ok(result.skipSamples.length > 0, 'Beispielzeilen fehlen');
});

test('ein Semikolon im Feld zerlegt die Zeile nicht', () => {
  const felder = bnetza.splitRow('a;"b; noch b";c');
  assert.deepEqual(felder, ['a', 'b; noch b', 'c']);
});

test('Zeilen ohne Koordinaten werden gezählt, nicht verschluckt', () => {
  const result = bnetza.loadRegister(registerPath);
  assert.equal(result.entries.length, 7);
  assert.equal(result.skipped, 3);
});

test('Normal- und Schnellladeeinrichtung werden unterschieden', () => {
  const { entries } = bnetza.loadRegister(registerPath);
  const schnell = entries.filter((e) => e.isFastCharger);
  assert.equal(schnell.length, 6);
  assert.ok(entries.find((e) => e.powerKW === 22 && !e.isFastCharger));
  assert.ok(entries.find((e) => e.powerKW === 350 && e.isFastCharger));
});

test('ein Feld mit Zeilenumbruch zerreißt den Datensatz nicht', () => {
  // Das Register führt einen Public Key fürs Eichrecht als mehrzeiligen
  // Hex-Block. Wer erst an Zeilenumbrüchen trennt, verliert jeden solchen
  // Datensatz. In der echten Datei betraf das ein Viertel aller Zeilen.
  const result = bnetza.loadRegister(registerPath);
  const mvv = result.entries.find((e) => e.operator.includes('MVV'));

  assert.ok(mvv, 'der Datensatz mit mehrzeiligem Feld fehlt');
  assert.ok(Math.abs(mvv.lat - 48.4983) < 0.001, `lat war ${mvv.lat}`);
  assert.equal(mvv.powerKW, 300);
  assert.equal(mvv.city, 'Langenau');
  assert.ok(result.multiLineFields >= 1, 'mehrzeilige Felder wurden nicht gezählt');
});

test('der Zeilenumbruch bleibt im Feld erhalten', () => {
  const rows = bnetza.parseRows('a;"zwei\nZeilen";c\nd;e;f\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['a', 'zwei\nZeilen', 'c']);
  assert.deepEqual(rows[1], ['d', 'e', 'f']);
});

test('nach dem Umbau stimmt die Spaltenzahl exakt, ohne Toleranz', () => {
  const result = bnetza.loadRegister(registerPath);
  assert.equal(
    result.skipReasons.spaltenzahlWeicht,
    0,
    'keine Zeile darf mehr an der Spaltenzahl scheitern'
  );
});

test('ein unpaariges Anführungszeichen frisst nicht den Rest der Datei', () => {
  // Ohne Reißleine liefe alles nach dem Anführungszeichen in ein Feld.
  const inhalt = 'a;"offen ohne Ende;c\n' + 'd;e;f\n'.repeat(50);
  const rows = bnetza.parseRows(inhalt, ';', 20);
  assert.ok(rows.length > 10, `nur ${rows.length} Datensätze, die Reißleine griff nicht`);
});

test('eine unpassende Datei wird abgelehnt statt falsch gelesen', () => {
  assert.throws(
    () => bnetza.parseRegister('irgendein;Text\nohne;Koordinaten\n'),
    /Kopfzeile/
  );
});

// ================================================================== Korridor

test('nur was nahe genug an der Route liegt, bleibt im Korridor', () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 500);
  const mitte = route[250];

  const kandidaten = [
    { id: 'auf-der-route', lat: mitte.lat, lon: mitte.lon },
    // Rund 1 km seitlich.
    { id: 'knapp-daneben', lat: mitte.lat + 0.009, lon: mitte.lon },
    // Weit weg: München.
    { id: 'weit-weg', lat: 48.137, lon: 11.575 },
  ];

  const drin = corridor.withinCorridor(kandidaten, route, 2000);
  const ids = drin.map((k) => k.id);
  assert.ok(ids.includes('auf-der-route'));
  assert.ok(ids.includes('knapp-daneben'));
  assert.ok(!ids.includes('weit-weg'));
});

test('der Korridorfilter liefert die Entfernung zur Route mit', () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 200);
  const drin = corridor.withinCorridor([{ id: 'x', ...route[100] }], route, 2000);
  assert.equal(drin.length, 1);
  assert.ok(drin[0].distanceToRouteMeters < 1);
});

test('das Gitter findet dasselbe wie die stumpfe Suche', () => {
  // Der Index ist eine Optimierung. Er darf das Ergebnis nicht verändern.
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 300);
  const kandidaten = Array.from({ length: 200 }, (_, i) => ({
    id: `k${i}`,
    lat: 51.2 + (i % 20) * 0.13,
    lon: 6.6 + Math.floor(i / 20) * 0.06,
  }));

  const ueberGitter = new Set(
    corridor.withinCorridor(kandidaten, route, 3000).map((k) => k.id)
  );
  const stumpf = new Set(
    kandidaten
      .filter((k) => Math.min(...route.map((p) => geo.distance(k, p))) <= 3000)
      .map((k) => k.id)
  );

  assert.deepEqual([...ueberGitter].sort(), [...stumpf].sort());
  assert.ok(stumpf.size > 0, 'der Test wäre sonst wertlos');
});

test('Registereinträge werden den gefundenen Stationen zugeordnet', () => {
  const register = [
    { operator: 'A', lat: 51.5030, lon: 6.5448 },
    { operator: 'B', lat: 52.0000, lon: 7.0000 },
  ];
  const stationen = [
    // 20 m neben A.
    { id: 'poi-a', lat: 51.50318, lon: 6.5448 },
  ];

  const { matched, missing } = corridor.matchSources(register, stationen, 250);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].operator, 'A');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].operator, 'B');
});


// ================================================================ Standorte

test('Säulen eines Ladeparks werden zu einem Standort', () => {
  // Vier Säulen auf einem Parkplatz, jeweils rund 20 m auseinander.
  const eintraege = [0, 1, 2, 3].map((i) => ({
    operator: 'EnBW mobility+',
    lat: 51.5 + i * 0.00018,
    lon: 6.5,
    powerKW: i === 0 ? 300 : 150,
    isFastCharger: true,
    pointCount: 2,
    postalCode: '47475',
    city: 'Kamp-Lintfort',
  }));

  const standorte = sites.clusterSites(eintraege, 75);
  assert.equal(standorte.length, 1);
  assert.equal(standorte[0].deviceCount, 4);
  assert.equal(standorte[0].pointCount, 8);
  assert.equal(standorte[0].maxPowerKW, 300, 'die stärkste Säule zählt');
  assert.equal(standorte[0].operator, 'EnBW mobility+');
});

test('zwei getrennte Ladeparks bleiben zwei Standorte', () => {
  const eintraege = [
    { operator: 'A', lat: 51.5, lon: 6.5, powerKW: 300, isFastCharger: true },
    { operator: 'A', lat: 51.50018, lon: 6.5, powerKW: 300, isFastCharger: true },
    // Rund 1 km entfernt.
    { operator: 'B', lat: 51.509, lon: 6.5, powerKW: 150, isFastCharger: true },
  ];

  const standorte = sites.clusterSites(eintraege, 75);
  assert.equal(standorte.length, 2);
  assert.deepEqual(standorte.map((s) => s.deviceCount).sort(), [1, 2]);
});

test('eine Reihe von Säulen zerfällt nicht in mehrere Standorte', () => {
  // Zehn Säulen in 40-m-Abständen: von Ende zu Ende 360 m, also weiter als der
  // Radius. Über die Nachbarschaft gehören sie trotzdem zusammen.
  const eintraege = Array.from({ length: 10 }, (_, i) => ({
    operator: 'Ionity',
    lat: 51.5 + i * 0.00036,
    lon: 6.5,
    powerKW: 350,
    isFastCharger: true,
  }));

  const standorte = sites.clusterSites(eintraege, 75);
  assert.equal(standorte.length, 1, 'die Verkettung muss transitiv sein');
  assert.equal(standorte[0].deviceCount, 10);
});

test('der Standort erbt die kürzeste Entfernung zur Route', () => {
  const eintraege = [
    { operator: 'A', lat: 51.5, lon: 6.5, powerKW: 300, distanceToRouteMeters: 800 },
    { operator: 'A', lat: 51.50018, lon: 6.5, powerKW: 300, distanceToRouteMeters: 760 },
  ];
  const [standort] = sites.clusterSites(eintraege, 75);
  assert.equal(standort.distanceToRouteMeters, 760);
});

test('ohne Einträge gibt es keine Standorte', () => {
  assert.deepEqual(sites.clusterSites([], 75), []);
});


// ============================================================= Umkreissuche

test('die Route wird gleichmäßig abgetastet, Anfang und Ende inklusive', () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 2000);
  const punkte = geo.samplePointsAlongRoute(route, 8000);

  assert.deepEqual(punkte[0], route[0]);
  assert.deepEqual(punkte.at(-1), route.at(-1));

  // Die Abstände dürfen die Vorgabe nicht deutlich überschreiten, sonst
  // klaffen zwischen den Umkreisen Lücken.
  for (let i = 1; i < punkte.length - 1; i++) {
    const d = geo.distance(punkte[i - 1], punkte[i]);
    assert.ok(d <= 8000 * 1.2, `Abstand ${d.toFixed(0)} m zwischen ${i - 1} und ${i}`);
  }

  const laenge = geo.pathLength(route);
  assert.ok(punkte.length >= Math.floor(laenge / 8000), 'zu wenige Abtastpunkte');
});

test('die Deckungsformel bestraft zu große Abstände', () => {
  // Kreise mit 5 km Radius alle 8 km decken einen 3 km breiten Korridor ab.
  assert.equal(Math.round(geo.coveredCorridorWidth(5000, 8000)), 3000);
  // Liegen sie weiter auseinander als zwei Radien, bleibt nichts übrig.
  assert.equal(geo.coveredCorridorWidth(2000, 5000), 0);
});

test('die Vorgabewerte decken den Zwei-Kilometer-Korridor ab', () => {
  const gedeckt = geo.coveredCorridorWidth(
    ev.DEFAULT_OPTIONS.nearbyRadiusMeters,
    ev.DEFAULT_OPTIONS.nearbySpacingMeters
  );
  assert.ok(gedeckt >= 2000, `nur ${gedeckt.toFixed(0)} m gedeckt`);
});

test('die Umkreissuche fragt Luftlinie ab, nicht Umweg', () => {
  const url = new URL(ev.buildNearbySearchURL('KEY', { lat: 51.5, lon: 6.5 }));
  assert.ok(url.pathname.includes('/poiSearch/'), url.pathname);
  assert.equal(url.searchParams.get('lat'), '51.5');
  assert.equal(url.searchParams.get('radius'), '5000');
  assert.equal(url.searchParams.get('maxDetourTime'), null);
});

test('die Umkreissuche holt bis zu 100 Treffer statt 20', () => {
  const url = new URL(ev.buildNearbySearchURL('KEY', { lat: 51.5, lon: 6.5 }));
  assert.equal(url.searchParams.get('limit'), '100');
});

test('Treffer aus mehreren Umkreisen werden zusammengeführt', async () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 1000);
  let calls = 0;
  const mockFetch = async (url) => {
    calls++;
    assert.ok(String(url).includes('poiSearch'));
    return { ok: true, json: async () => fixture('alongroute-response.json') };
  };

  const result = await ev.searchAroundRoute(
    'KEY',
    route,
    { sleepImpl: noSleep, minPowerKW: 0 },
    mockFetch
  );

  assert.equal(calls, result.requestCount);
  assert.ok(result.requestCount > 20, `nur ${result.requestCount} Umkreise auf 264 km`);
  assert.equal(result.stations.length, 5, 'Dubletten wurden nicht zusammengeführt');
  assert.ok(result.coveredCorridorMeters >= 2000);
});


test('eine bis ans Limit gefüllte Antwort wird als abgeschnitten gemeldet', async () => {
  // In einem Ballungsraum kann ein Umkreis mehr Ladeparks enthalten, als eine
  // Antwort fasst. TomTom schneidet dann stillschweigend ab. Genau dieser Fall
  // muss sichtbar werden, sonst fehlen Treffer, ohne dass es auffällt.
  const volleAntwort = {
    results: Array.from({ length: 100 }, (_, i) => ({
      id: `poi-${i}`,
      position: { lat: 51.5, lon: 6.5 },
      poi: { name: 'Ladepark' },
      chargingPark: { connectors: [{ ratedPowerKW: 300 }] },
    })),
  };

  const result = await ev.searchAroundRoute(
    'KEY',
    syntheticRoute(MEERBUSCH, NORDDEICH, 100),
    { sleepImpl: noSleep },
    async () => ({ ok: true, json: async () => volleAntwort })
  );

  assert.equal(result.truncated.length, result.requestCount, 'jede Antwort war voll');
  assert.ok(result.truncated[0].count >= 100);
});

test('eine halbvolle Antwort gilt nicht als abgeschnitten', async () => {
  const result = await ev.searchAroundRoute(
    'KEY',
    syntheticRoute(MEERBUSCH, NORDDEICH, 100),
    { sleepImpl: noSleep },
    async () => ({ ok: true, json: async () => fixture('alongroute-response.json') })
  );
  assert.equal(result.truncated.length, 0);
});


// ============================================== Lage entlang der Route

test('Stationen werden in Fahrtrichtung sortiert', () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 500);
  const durcheinander = [
    { id: 'spaet', ...route[450] },
    { id: 'frueh', ...route[50] },
    { id: 'mitte', ...route[250] },
  ];

  const sortiert = corridor.orderAlongRoute(durcheinander, route);
  assert.deepEqual(sortiert.map((s) => s.id), ['frueh', 'mitte', 'spaet']);
});

test('die Projektion liefert Kilometerstand und seitlichen Abstand', () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 500);
  const laenge = geo.pathLength(route);

  const [station] = corridor.orderAlongRoute([{ id: 'x', ...route[250] }], route);
  assert.ok(station.distanceFromRouteMeters < 1, 'liegt auf der Route');
  assert.ok(
    Math.abs(station.progressMeters - laenge / 2) < laenge * 0.02,
    `Kilometerstand ${station.progressMeters.toFixed(0)} statt rund ${(laenge / 2).toFixed(0)}`
  );
});

test('was zu weit abseits liegt, fällt raus', () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 300);
  const mitte = route[150];

  // Quer zur Route versetzen, nicht in der Breite: Die Strecke verläuft fast
  // nach Norden, ein Versatz in der Breite liefe parallel zu ihr statt seitlich
  // weg. Auf 52 Grad sind 0,0147 Grad Länge rund ein Kilometer.
  const kandidaten = [
    { id: 'nah', lat: mitte.lat, lon: mitte.lon + 0.0147 },
    { id: 'fern', lat: mitte.lat, lon: mitte.lon + 0.0736 },
  ];

  const [nah, fern] = kandidaten.map(
    (k) => corridor.orderAlongRoute([k], route)[0].distanceFromRouteMeters
  );
  assert.ok(nah > 800 && nah < 1200, `nah war ${nah.toFixed(0)} m`);
  assert.ok(fern > 4000, `fern war ${fern.toFixed(0)} m`);

  const imKorridor = corridor.orderAlongRoute(kandidaten, route, 2000);
  assert.deepEqual(imKorridor.map((s) => s.id), ['nah']);
});

test('die Umkreistreffer bekommen dieselbe Ortsangabe wie die Along-Route-Treffer', () => {
  // Der Along-Route-Treffer bringt detourSeconds mit, der Umkreistreffer nicht.
  // Nach der Projektion haben beide Kilometerstand und seitlichen Abstand, und
  // erst dadurch lassen sie sich überhaupt gemeinsam sortieren.
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 300);
  const gemischt = [
    { id: 'umkreis', ...route[200], detourSeconds: null },
    { id: 'alongroute', ...route[100], detourSeconds: 180 },
  ];

  const sortiert = corridor.orderAlongRoute(gemischt, route, 2000);
  assert.deepEqual(sortiert.map((s) => s.id), ['alongroute', 'umkreis']);
  for (const station of sortiert) {
    assert.ok(Number.isFinite(station.progressMeters));
    assert.ok(Number.isFinite(station.distanceFromRouteMeters));
  }
});

// -------------------------------------------------------- Redaktionsimport

/** Ein Export, wie tomtom-probe.mjs ihn schreibt: echte IDs, kein Urteil. */
function export_(...ueberschreibungen) {
  return ueberschreibungen.map((eintrag, i) => ({
    id: `ed-${String(i + 1).padStart(3, '0')}`,
    tomtomPoiID: `poi-${i + 1}`,
    name: 'Ladepark',
    operatorName: 'EnBW',
    latitude: 51.5,
    longitude: 6.5,
    rating: null,
    verdict: null,
    testedAt: null,
    pricePerKWh: null,
    tags: [],
    author: 'Electric Drive',
    ...eintrag,
  }));
}

test('Platzhalter und Leerzeichen gelten nicht als Urteil', () => {
  assert.equal(redaktion.urteil({ verdict: null }), null);
  assert.equal(redaktion.urteil({ verdict: '   ' }), null);
  assert.equal(redaktion.urteil({ verdict: 'NOCH NICHT GETESTET. Urteil hier eintragen.' }), null);
  assert.equal(redaktion.urteil({ verdict: '  Acht Punkte, alle frei.  ' }), 'Acht Punkte, alle frei.');
});

test('leerer Bestand nimmt den Export vollstaendig auf', () => {
  const { entries, statistik } = redaktion.fuehreZusammen([], export_({}, {}, {}));
  assert.equal(entries.length, 3);
  assert.equal(statistik.neu, 3);
  assert.equal(statistik.getestet, 0);
  assert.equal(statistik.erfasst, 3);
});

test('ein zweiter Import derselben Datei aendert nichts', () => {
  const eingang = export_({}, {});
  const erster = redaktion.fuehreZusammen([], eingang);
  const zweiter = redaktion.fuehreZusammen(erster.entries, eingang);
  assert.deepEqual(zweiter.entries, erster.entries);
  assert.equal(zweiter.statistik.neu, 0);
  assert.equal(zweiter.statistik.ergaenzt, 0);
});

test('ein vorhandenes Urteil ueberlebt jeden weiteren Import', () => {
  const bestand = export_({
    verdict: 'Zwoelf Punkte, 300 kW ohne Teilung.',
    rating: 1.4,
    testedAt: '2026-03-14T00:00:00Z',
    tags: ['Dach'],
  });
  const { entries, statistik } = redaktion.fuehreZusammen(bestand, export_({}));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verdict, 'Zwoelf Punkte, 300 kW ohne Teilung.');
  assert.equal(entries[0].rating, 1.4);
  assert.deepEqual(entries[0].tags, ['Dach']);
  assert.equal(statistik.getestet, 1);
});

test('die Anschrift kommt mit und macht gleichnamige Eintraege unterscheidbar', () => {
  const { entries } = redaktion.fuehreZusammen(
    [],
    export_(
      { tomtomPoiID: 'poi-a', name: 'EnBW', address: 'Moerser Str. 1, Kamp-Lintfort' },
      { tomtomPoiID: 'poi-b', name: 'EnBW', address: 'Hauptstr. 40, Gescher' }
    )
  );
  assert.deepEqual(entries.map((e) => e.address), [
    'Moerser Str. 1, Kamp-Lintfort',
    'Hauptstr. 40, Gescher',
  ]);
});

test('ein Bestand ohne Anschrift bekommt sie beim naechsten Import', () => {
  const alt = export_({ verdict: 'Getestet.' });
  delete alt[0].address;
  const { entries } = redaktion.fuehreZusammen(alt, export_({ address: 'Am Hafen 3, Emden' }));
  assert.equal(entries[0].address, 'Am Hafen 3, Emden');
  assert.equal(entries[0].verdict, 'Getestet.');
});

test('Standortdaten kommen dagegen aus dem Import', () => {
  const bestand = export_({ verdict: 'Gut.', latitude: 51.5, longitude: 6.5, name: 'Alter Name' });
  const { entries } = redaktion.fuehreZusammen(
    bestand,
    export_({ latitude: 51.6, longitude: 6.6, name: 'Ladepark Gescher', operatorName: 'Aral pulse' })
  );
  assert.equal(entries[0].latitude, 51.6);
  assert.equal(entries[0].name, 'Ladepark Gescher');
  assert.equal(entries[0].operatorName, 'Aral pulse');
  assert.equal(entries[0].verdict, 'Gut.', 'das Urteil bleibt');
});

test('zugeordnet wird ueber die POI-ID, nicht ueber den Namen', () => {
  const bestand = export_({ id: 'ed-042', tomtomPoiID: 'poi-1', verdict: 'Getestet.' });
  const { entries, statistik } = redaktion.fuehreZusammen(
    bestand,
    export_({ id: 'ed-001', tomtomPoiID: 'poi-1', name: 'Voellig anderer Name' })
  );
  assert.equal(entries.length, 1, 'derselbe POI darf nicht zweimal entstehen');
  assert.equal(entries[0].id, 'ed-042', 'die gewachsene Kennung bleibt');
  assert.equal(statistik.neu, 0);
});

test('neue Eintraege bekommen freie Kennungen', () => {
  const bestand = export_({ id: 'ed-007', tomtomPoiID: 'poi-alt' });
  const { entries } = redaktion.fuehreZusammen(bestand, export_({ tomtomPoiID: 'poi-neu' }));
  const kennungen = entries.map((e) => e.id).sort();
  assert.deepEqual(kennungen, ['ed-007', 'ed-008']);
  assert.equal(new Set(kennungen).size, 2);
});

test('der Platzhalter aus dem Export landet nicht in der App', () => {
  const { entries } = redaktion.fuehreZusammen(
    [],
    export_({ verdict: 'NOCH NICHT GETESTET. Urteil hier eintragen.' })
  );
  assert.equal(entries[0].verdict, null);
});

test('unbrauchbare Datensaetze brechen den Import ab', () => {
  const faelle = [
    [{ latitude: 0, longitude: 0 }, 'Koordinate 0/0'],
    [{ latitude: 95 }, 'latitude'],
    [{ rating: 7 }, 'rating'],
    [{ testedAt: 'irgendwann' }, 'testedAt'],
    [{ name: '' }, 'name'],
  ];
  for (const [abweichung, erwartet] of faelle) {
    assert.throws(
      () => redaktion.fuehreZusammen([], export_(abweichung)),
      (fehler) => fehler.details.some((zeile) => zeile.includes(erwartet)),
      `${erwartet} haette auffallen muessen`
    );
  }
});

test('was der Import nicht kennt, wird gezaehlt statt still mitgeschleppt', () => {
  const bestand = export_({ tomtomPoiID: 'poi-a' }, { tomtomPoiID: 'poi-b' });
  const { entries, statistik } = redaktion.fuehreZusammen(
    bestand,
    export_({ tomtomPoiID: 'poi-a' }, { tomtomPoiID: 'poi-c' })
  );
  assert.equal(statistik.unberuehrt, 1, 'poi-b stand im Bestand und kam nicht vor');
  assert.equal(statistik.neu, 1);
  assert.equal(entries.length, 3, 'verworfen wird nichts');
});

test('ein doppelter POI im Bestand faellt auf', () => {
  const bestand = [...export_({ id: 'ed-001' }), ...export_({ id: 'ed-002' })];
  bestand[1].tomtomPoiID = bestand[0].tomtomPoiID;
  assert.throws(() => redaktion.fuehreZusammen(bestand, []), /doppelt/);
});

test('nur erfasste Stationen zaehlen nicht als Test', () => {
  const erfasst = entries.find((e) => e.id === 'ed-011');
  assert.ok(erfasst, 'die Fixtures brauchen einen nicht getesteten Eintrag');
  assert.equal(redaktion.istGetestet(erfasst), false);
  assert.equal(entries.filter(redaktion.istGetestet).length, entries.length - 1);
});

// ------------------------------------------------------- Registerdatei finden

test('eine angegebene Datei wird unveraendert genommen', () => {
  const ziel = join(here, 'fixtures', 'alongroute-response.json');
  const { path, searchedDirectory } = bnetza.resolveRegisterPath(ziel);
  assert.equal(path, ziel);
  assert.equal(searchedDirectory, null, 'kein Verzeichnis, also keine Suche');
});

test('in einem Verzeichnis gewinnt die groesste passende CSV', () => {
  const verzeichnis = mkdtempSync(join(tmpdir(), 'register-'));
  writeFileSync(join(verzeichnis, 'Ladesaeulenregister.csv'), 'x'.repeat(5000));
  writeFileSync(join(verzeichnis, 'ladepunkte-klein.csv'), 'x'.repeat(10));
  writeFileSync(join(verzeichnis, 'urlaubsfotos.csv'), 'x'.repeat(999999));

  const { path, candidates } = bnetza.resolveRegisterPath(verzeichnis);
  assert.equal(path, join(verzeichnis, 'Ladesaeulenregister.csv'));
  assert.equal(candidates.length, 2, 'die Fotos passen nicht auf das Namensmuster');
});

test('ein Verzeichnis ohne Registerdatei liefert keinen Pfad', () => {
  const verzeichnis = mkdtempSync(join(tmpdir(), 'leer-'));
  const { path, searchedDirectory } = bnetza.resolveRegisterPath(verzeichnis);
  assert.equal(path, null);
  assert.equal(searchedDirectory, verzeichnis, 'der Aufrufer soll sagen koennen, wo gesucht wurde');
});

test('Standorte tragen Bundesland und Anschrift fuer den Erfassungsbogen', () => {
  const eintraege = [
    { lat: 51.5, lon: 6.5, operator: 'EnBW', powerKW: 300, pointCount: 4,
      address: 'Musterweg 1', postalCode: '47441', city: 'Moers', state: 'Nordrhein-Westfalen' },
    { lat: 51.50002, lon: 6.50002, operator: 'EnBW', powerKW: 150, pointCount: 2,
      address: 'Musterweg 1', postalCode: '47441', city: 'Moers', state: 'Nordrhein-Westfalen' },
  ];
  const [standort] = sites.clusterSites(eintraege);
  assert.equal(standort.deviceCount, 2, 'zwei Einrichtungen, ein Ort');
  assert.equal(standort.state, 'Nordrhein-Westfalen');
  assert.equal(standort.address, 'Musterweg 1');
  assert.equal(standort.maxPowerKW, 300, 'die staerkste Saeule bestimmt den Ort');
  assert.equal(standort.pointCount, 6);
});

// ------------------------------------------------------- Fahrzeugprofil

/** Spiegelt VehicleProfile.consumptionTable in Swift. */
function verbrauchstabelle(kWhPro100km) {
  const stuetzstellen = [
    [30, 0.62], [50, 0.68], [80, 0.83], [100, 1.0], [120, 1.24], [130, 1.38],
  ];
  return stuetzstellen
    .map(([tempo, faktor]) => `${tempo},${(kWhPro100km * faktor).toFixed(2)}`)
    .join(':');
}

test('die Verbrauchstabelle hat die Form, die die Routing-API erwartet', () => {
  const tabelle = verbrauchstabelle(19);
  assert.match(tabelle, /^(\d+,\d+\.\d\d:){5}\d+,\d+\.\d\d$/);

  const paare = tabelle.split(':').map((p) => p.split(',').map(Number));
  // Aufsteigend nach Geschwindigkeit, sonst weist die API sie zurueck.
  for (let i = 1; i < paare.length; i++) {
    assert.ok(paare[i][0] > paare[i - 1][0], 'Geschwindigkeit muss steigen');
    assert.ok(paare[i][1] > paare[i - 1][1], 'Verbrauch steigt mit der Geschwindigkeit');
  }
  // Der angegebene Wert gilt bei 100 km/h.
  assert.equal(paare.find((p) => p[0] === 100)[1], 19);
});

test('die Ladekurve steigt in der Zeit und in der Ladung', () => {
  const kapazitaet = 77;
  const spitze = 240;
  const punkte = [[0.0, 1.0], [0.2, 1.0], [0.4, 0.92], [0.6, 0.7], [0.8, 0.45], [1.0, 0.15]];

  let sekunden = 0;
  let letzte = 0;
  const kurve = punkte.map(([anteil, faktor], i) => {
    const ladung = kapazitaet * anteil;
    const leistung = Math.max(11, spitze * faktor);
    if (i > 0) sekunden += ((ladung - letzte) / leistung) * 3600;
    letzte = ladung;
    return { chargeInkWh: ladung, timeToChargeInSeconds: sekunden };
  });

  for (let i = 1; i < kurve.length; i++) {
    assert.ok(kurve[i].chargeInkWh > kurve[i - 1].chargeInkWh);
    assert.ok(kurve[i].timeToChargeInSeconds > kurve[i - 1].timeToChargeInSeconds);
  }
  assert.equal(kurve[0].timeToChargeInSeconds, 0);

  // Von leer auf voll darf nicht schneller gehen als mit der Spitzenleistung.
  const schnellstens = (kapazitaet / spitze) * 3600;
  const gesamt = kurve[kurve.length - 1].timeToChargeInSeconds;
  assert.ok(gesamt > schnellstens, 'die fallende Kurve muss den Stopp verlaengern');

  // Und die letzten zwanzig Prozent kosten mehr Zeit als die ersten zwanzig.
  const ersteFuenftel = kurve[1].timeToChargeInSeconds - kurve[0].timeToChargeInSeconds;
  const letzteFuenftel = kurve[5].timeToChargeInSeconds - kurve[4].timeToChargeInSeconds;
  assert.ok(
    letzteFuenftel > ersteFuenftel * 3,
    'oben laedt jede Saeule langsam, das ist der Grund fuer die 80-Prozent-Grenze'
  );
});

// ------------------------------------------------------- Ladestopp-Planung

const AUTO = {
  usableBatteryKWh: 77,
  consumptionKWhPer100km: 19,
  maxChargePowerKW: 240,
  currentChargePercent: 80,
  minArrivalPercent: 10,
  minChargeAtStopPercent: 10,
  maxChargeAtStopPercent: 80,
  // Von leer bis voll, in derselben Form wie VehicleProfile.chargingCurve.
  chargingCurve: [
    { chargeKWh: 0, powerKW: 240 },
    { chargeKWh: 15.4, powerKW: 240 },
    { chargeKWh: 30.8, powerKW: 220.8 },
    { chargeKWh: 46.2, powerKW: 168 },
    { chargeKWh: 61.6, powerKW: 108 },
    { chargeKWh: 77, powerKW: 36 },
  ],
};

/** Stationen in gleichmaessigem Abstand, alle gleich stark. */
function stationenAlle(abstandKm, bisKm, leistungKW = 300) {
  const liste = [];
  for (let km = abstandKm; km < bisKm; km += abstandKm) {
    liste.push({
      id: `s-${km}`,
      name: `Station ${km}`,
      progressMeters: km * 1000,
      distanceFromRouteMeters: 100,
      detourSeconds: 0,
      maxPowerKW: leistungKW,
    });
  }
  return liste;
}

test('kurze Strecke braucht keinen Stopp', () => {
  const ergebnis = ladeplanung.planeStopps({
    routeLengthMeters: 150_000,
    stations: stationenAlle(30, 150),
    fahrzeug: AUTO,
  });
  assert.equal(ergebnis.machbar, true);
  assert.equal(ergebnis.stopps.length, 0);
  // 150 km bei 19 kWh/100 km sind 28,5 kWh. Von 61,6 bleiben 33,1.
  assert.ok(Math.abs(ergebnis.ankunftKWh - 33.1) < 0.2, `waren ${ergebnis.ankunftKWh}`);
});

test('lange Strecke bekommt Stopps, und der Ladestand bleibt im Rahmen', () => {
  const ergebnis = ladeplanung.planeStopps({
    routeLengthMeters: 800_000,
    stations: stationenAlle(25, 800),
    fahrzeug: AUTO,
  });

  assert.equal(ergebnis.machbar, true);
  assert.ok(ergebnis.stopps.length >= 2, `nur ${ergebnis.stopps.length} Stopp(s)`);

  const untergrenze = (77 * AUTO.minChargeAtStopPercent) / 100;
  const obergrenze = (77 * AUTO.maxChargeAtStopPercent) / 100;
  for (const stopp of ergebnis.stopps) {
    assert.ok(stopp.ankunftKWh >= untergrenze - 0.01, `Ankunft mit ${stopp.ankunftKWh} kWh`);
    assert.ok(stopp.abfahrtKWh <= obergrenze + 0.01, `Abfahrt mit ${stopp.abfahrtKWh} kWh`);
    assert.ok(stopp.abfahrtKWh > stopp.ankunftKWh, 'ein Stopp ohne Laden ist keiner');
  }

  const zielreserve = (77 * AUTO.minArrivalPercent) / 100;
  assert.ok(ergebnis.ankunftKWh >= zielreserve - 0.01, `am Ziel nur ${ergebnis.ankunftKWh} kWh`);

  // Aufsteigend entlang der Route, keine Sprünge zurück.
  for (let i = 1; i < ergebnis.stopps.length; i++) {
    assert.ok(ergebnis.stopps[i].progressMeters > ergebnis.stopps[i - 1].progressMeters);
  }
});

test('die weiter entfernte Station gewinnt gegen die naeher gelegene starke', () => {
  // Der Fehler, den eine naive Auswahl macht: immer die staerkste Saeule in
  // Reichweite nehmen. Eine 300-kW-Saeule nach 60 km erzwingt einen zweiten
  // Stopp, eine 150-kW-Saeule nach 260 km nicht.
  const ergebnis = ladeplanung.planeStopps({
    routeLengthMeters: 480_000,
    stations: [
      { id: 'nah', name: 'Nah', progressMeters: 60_000, distanceFromRouteMeters: 100, detourSeconds: 0, maxPowerKW: 300 },
      { id: 'weit', name: 'Weit', progressMeters: 260_000, distanceFromRouteMeters: 100, detourSeconds: 0, maxPowerKW: 150 },
    ],
    fahrzeug: AUTO,
  });

  assert.equal(ergebnis.machbar, true);
  assert.equal(ergebnis.stopps.length, 1);
  assert.equal(ergebnis.stopps[0].station.id, 'weit');
});

test('bei gleicher Lage gewinnt die staerkere Saeule', () => {
  const ergebnis = ladeplanung.planeStopps({
    routeLengthMeters: 600_000,
    stations: [
      { id: 'langsam', name: 'Langsam', progressMeters: 250_000, distanceFromRouteMeters: 100, detourSeconds: 0, maxPowerKW: 50 },
      { id: 'schnell', name: 'Schnell', progressMeters: 250_500, distanceFromRouteMeters: 100, detourSeconds: 0, maxPowerKW: 300 },
    ],
    fahrzeug: AUTO,
  });
  assert.equal(ergebnis.stopps[0].station.id, 'schnell');
});

test('ein grosser Umweg laesst die Station verlieren', () => {
  // Beide Stationen reichen bis zum Ziel, es geht also allein um die
  // Standzeit. Die weiter vorne liegende gewinnt, weil sie weniger nachladen
  // muss; ein Umweg von 25 Minuten dreht das um.
  const plan = (sekunden) =>
    ladeplanung.planeStopps({
      routeLengthMeters: 500_000,
      stations: [
        { id: 'abseits', name: 'Abseits', progressMeters: 270_000, distanceFromRouteMeters: 4000, detourSeconds: sekunden, maxPowerKW: 300 },
        { id: 'anderRoute', name: 'An der Route', progressMeters: 250_000, distanceFromRouteMeters: 100, detourSeconds: 0, maxPowerKW: 300 },
      ],
      fahrzeug: AUTO,
    });

  const ohne = plan(0);
  assert.equal(ohne.machbar, true);
  assert.equal(ohne.stopps.length, 1);
  assert.equal(ohne.stopps[0].station.id, 'abseits', 'ohne Umweg gewinnt die weiter vorne liegende');

  const mit = plan(25 * 60);
  assert.equal(mit.stopps[0].station.id, 'anderRoute', '25 Minuten Umweg drehen das um');
});

test('eine Luecke groesser als die Reichweite wird gemeldet, nicht verschwiegen', () => {
  const ergebnis = ladeplanung.planeStopps({
    routeLengthMeters: 900_000,
    stations: [
      { id: 'eine', name: 'Einzige', progressMeters: 700_000, distanceFromRouteMeters: 100, detourSeconds: 0, maxPowerKW: 300 },
    ],
    fahrzeug: AUTO,
  });

  assert.equal(ergebnis.machbar, false);
  assert.equal(ergebnis.grund, 'luecke');
  assert.equal(ergebnis.luecke.station.id, 'eine');
  assert.ok(ergebnis.luecke.fehlendeMeter > 0);
  // Die Reichweite passt zur Rechnung: 61,6 minus 7,7 kWh Reserve, bei
  // 19 kWh je 100 km sind das rund 284 km.
  assert.ok(Math.abs(ergebnis.reichweiteMeter - 284_000) < 3_000, `${ergebnis.reichweiteMeter} m`);
});

test('zu schwache Saeulen zaehlen nicht als Stopp', () => {
  const ergebnis = ladeplanung.planeStopps({
    routeLengthMeters: 600_000,
    stations: stationenAlle(50, 600, 22),
    fahrzeug: AUTO,
    minPowerKW: 50,
  });
  assert.equal(ergebnis.machbar, false);
  assert.equal(ergebnis.grund, 'keineStationen');
});

test('Ladezeit steigt, wenn die Saeule schwaecher ist', () => {
  const schnell = ladeplanung.ladezeitSekunden(15, 60, AUTO.chargingCurve, 300);
  const langsam = ladeplanung.ladezeitSekunden(15, 60, AUTO.chargingCurve, 50);
  assert.ok(langsam > schnell * 2, `${langsam} gegen ${schnell}`);

  // Die Saeule kann das Auto nicht ueberholen: mehr als die Fahrzeugkurve
  // hergibt, bringt auch eine 400-kW-Saeule nicht.
  const sehrSchnell = ladeplanung.ladezeitSekunden(15, 60, AUTO.chargingCurve, 400);
  assert.equal(sehrSchnell, schnell);
});

test('die letzten Prozent kosten mehr Zeit als die ersten', () => {
  const unten = ladeplanung.ladezeitSekunden(7.7, 23.1, AUTO.chargingCurve, 300);
  const oben = ladeplanung.ladezeitSekunden(53.9, 69.3, AUTO.chargingCurve, 300);
  assert.ok(oben > unten * 2, `oben ${oben}, unten ${unten}`);
});

test('ein Halt ohne Nachladen ist kein Halt', () => {
  // Der Fehler, der im Simulator sichtbar wurde: 823 km, dichte Stationskette,
  // und die Planung streute neununddreissig Stopps mit je 1,3 kWh darueber.
  // Ursache war die Messung des Gewinns gegen den Standort statt gegen das
  // Durchfahren; ein Halt nach einem Kilometer sah damit fast gratis aus.
  const kette = [];
  for (let km = 1; km < 823; km += 7) {
    kette.push({
      id: `k${km}`,
      name: `Station ${km}`,
      progressMeters: km * 1000,
      distanceFromRouteMeters: 100,
      detourSeconds: 0,
      maxPowerKW: 350,
    });
  }

  const ergebnis = ladeplanung.planeStopps({
    routeLengthMeters: 823_000,
    stations: kette,
    fahrzeug: AUTO,
  });

  assert.equal(ergebnis.machbar, true);
  assert.ok(
    ergebnis.stopps.length <= 3,
    `${ergebnis.stopps.length} Stopps auf 823 km bei 284 km Reichweite`
  );

  for (const stopp of ergebnis.stopps) {
    const geladen = stopp.abfahrtKWh - stopp.ankunftKWh;
    assert.ok(geladen > 5, `Stopp bei km ${stopp.progressMeters / 1000} laedt nur ${geladen} kWh`);
  }

  // Und die Stopps liegen dort, wo der Akku sie verlangt, nicht am Anfang.
  assert.ok(
    ergebnis.stopps[0].progressMeters > 200_000,
    `erster Stopp schon bei km ${ergebnis.stopps[0].progressMeters / 1000}`
  );
});

test('der Aufwand je Stopp zaehlt mit', () => {
  // Ohne diesen Posten sieht ein Stopp mit einer Minute Ladezeit fast gratis
  // aus. Fuenf Minuten sind Abfahren, Anstecken, Bezahlen, Wiederauffahren.
  assert.equal(ladeplanung.STOPP_AUFWAND_SEKUNDEN, 300);
});

// ------------------------------------------------------------- Matrix

test('der Rumpf der Matrix-Anfrage hat die Punkte in point', () => {
  // Die API weist alles andere namentlich zurueck: "Required key [point] not
  // found". Gemessen am 10.09.2026, die Dokumentation war nicht erreichbar.
  const body = matrix.buildMatrixBody(
    [{ lat: 51.5, lon: 6.5 }],
    [{ lat: 51.6, lon: 6.6 }, { lat: 51.7, lon: 6.7 }]
  );
  assert.deepEqual(body.origins, [{ point: { latitude: 51.5, longitude: 6.5 } }]);
  assert.equal(body.destinations.length, 2);
  assert.equal(body.destinations[1].point.latitude, 51.7);
});

test('die Antwort wird zur Tabelle, Luecken bleiben null', () => {
  const json = {
    data: [
      { originIndex: 0, destinationIndex: 0, routeSummary: { travelTimeInSeconds: 249 } },
      { originIndex: 0, destinationIndex: 2, routeSummary: { travelTimeInSeconds: 600 } },
      { originIndex: 1, destinationIndex: 1, routeSummary: { travelTimeInSeconds: 120 } },
      // Ausserhalb der angefragten Groesse. Kommt nicht vor, darf aber nicht
      // in eine Zeile schreiben, die es nicht gibt.
      { originIndex: 9, destinationIndex: 9, routeSummary: { travelTimeInSeconds: 1 } },
    ],
  };
  const tabelle = matrix.parseMatrix(json, 2, 3);
  assert.deepEqual(tabelle, [[249, null, 600], [null, 120, null]]);
});

test('Stuetzpunkte liegen im gewuenschten Abstand und tragen die Zeit', () => {
  const route = syntheticRoute(MEERBUSCH, NORDDEICH, 400);
  const stuetzen = matrix.stuetzpunkte(route, 4 * 3600, 50_000);

  assert.ok(stuetzen.length >= 6, `nur ${stuetzen.length} Stuetzpunkte`);
  assert.equal(stuetzen[0].progressMeters, 0);

  for (let i = 1; i < stuetzen.length - 1; i++) {
    const abstand = stuetzen[i].progressMeters - stuetzen[i - 1].progressMeters;
    assert.ok(abstand >= 45_000 && abstand <= 60_000, `Abstand ${Math.round(abstand)} m`);
    assert.ok(stuetzen[i].timeSeconds > stuetzen[i - 1].timeSeconds);
  }
});

test('die Klammer findet den Stuetzpunkt davor und dahinter', () => {
  const stuetzen = [
    { progressMeters: 0 },
    { progressMeters: 50_000 },
    { progressMeters: 100_000 },
    { progressMeters: 130_000 },
  ];
  assert.deepEqual(matrix.klammer(stuetzen, 0), { davor: 0, dahinter: 1 });
  assert.deepEqual(matrix.klammer(stuetzen, 60_000), { davor: 1, dahinter: 2 });
  assert.deepEqual(matrix.klammer(stuetzen, 100_000), { davor: 2, dahinter: 3 });
  // Am Ende gibt es kein Dahinter mehr; dann zeigt beides auf den letzten.
  assert.deepEqual(matrix.klammer(stuetzen, 129_000), { davor: 2, dahinter: 3 });
  assert.deepEqual(matrix.klammer(stuetzen, 130_000), { davor: 3, dahinter: 3 });
});

test('die Bloecke bleiben unter der Zellengrenze', () => {
  // 150 Stationen entlang der Route, alle 3 km eine, Stuetzpunkte alle 50 km.
  const zuordnungen = Array.from({ length: 150 }, (_, i) => ({
    id: `s${i}`,
    stuetzIndex: Math.floor((i * 3000) / 50_000),
  }));

  const teile = matrix.bloecke(zuordnungen, (z) => z.stuetzIndex);

  const summe = teile.reduce((n, t) => n + t.eintraege.length, 0);
  assert.equal(summe, 150, 'keine Station darf verlorengehen');

  for (const teil of teile) {
    const zellen = teil.stuetzen.length * teil.eintraege.length;
    assert.ok(zellen <= matrix.MAX_ZELLEN, `${zellen} Zellen in einem Block`);
  }

  // Keine Zelle zu viel: TomTom rechnet je Zelle ab, und das Kreuzprodukt
  // mehrerer Stuetzpunkte in einem Block hat am 29.09.2026 das Monatskontingent
  // gekostet. Jede Station genau eine Zelle.
  const zellen = teile.reduce((n, t) => n + t.stuetzen.length * t.eintraege.length, 0);
  assert.equal(zellen, 150, 'eine Zelle je Station, nicht mehr');
  for (const teil of teile) assert.equal(teil.stuetzen.length, 1);
  // 150 Stationen auf 450 km sind 9 Stuetzpunkte, also 9 Anfragen.
  assert.equal(teile.length, 9);
});

test('ein Stuetzpunkt mit mehr Stationen als Zellen wird geteilt', () => {
  const eintraege = Array.from({ length: 450 }, (_, i) => ({ i }));
  const teile = matrix.bloecke(eintraege, () => 0);
  assert.equal(teile.length, 3);
  assert.equal(teile[0].eintraege.length, 200);
  assert.equal(teile[2].eintraege.length, 50);
});

test('die Bloecke enthalten die Originale, keine Kopien', () => {
  // Genau daran ist die erste Fassung gescheitert: Der Aufrufer legte mit einer
  // Kopie ein Feld an, die Bloecke enthielten die Kopien, und was er nach der
  // Anfrage hineinschrieb, landete im Nichts. Vier Anfragen liefen durch und
  // lieferten null Umwege.
  const eintraege = [{ id: 'a' }, { id: 'b' }];
  const teile = matrix.bloecke(eintraege, () => 0);

  const flach = teile.flatMap((t) => t.eintraege);
  assert.equal(flach.length, 2);
  assert.ok(flach[0] === eintraege[0], 'dasselbe Objekt, nicht ein gleiches');
  assert.ok(flach[1] === eintraege[1]);

  flach[0].ergebnis = 42;
  assert.equal(eintraege[0].ergebnis, 42, 'Schreiben muss beim Original ankommen');
});

test('buildMatrixBody haengt die Verkehrslage nur auf Wunsch an', () => {
  const a = [{ lat: 1, lon: 2 }];
  assert.equal(matrix.buildMatrixBody(a, a).options, undefined);
  assert.deepEqual(matrix.buildMatrixBody(a, a, { mitVerkehr: true }).options, {
    departAt: 'now',
  });
});

test('abschnitte nennt jedes Stuetzpunktpaar genau einmal', () => {
  const zuordnungen = [
    { davor: 0, dahinter: 1 },
    { davor: 0, dahinter: 1 },
    { davor: 1, dahinter: 2 },
    { davor: 4, dahinter: 5 },
  ];
  const teile = matrix.abschnitte(zuordnungen);
  assert.deepEqual(teile, [
    { davor: 0, dahinter: 1 },
    { davor: 1, dahinter: 2 },
    { davor: 4, dahinter: 5 },
  ]);
});

test('abschnitte laesst den Abschnitt der Laenge null weg', () => {
  // Eine Station hinter dem letzten Stuetzpunkt klammert auf sich selbst. Da
  // gibt es nichts zu messen, und eine Anfrage von einem Punkt zu demselben
  // Punkt waere eine verschenkte Zelle.
  assert.deepEqual(matrix.abschnitte([{ davor: 3, dahinter: 3 }]), []);
});

test('die gemessene Abschnittszeit statt der anteiligen', () => {
  // Der Grund fuer den ganzen Umbau: Auf einer Route mit 106 km/h im Mittel
  // dauern die ersten 50 km durch die Stadt nicht 28, sondern 40 Minuten. Die
  // anteilige Rechnung machte daraus zwoelf Minuten Umweg fuer jede Station in
  // diesem Abschnitt, obwohl keine einzige daneben lag.
  const anteilig = 28 * 60;
  const gemessen = 40 * 60;
  const hin = 20 * 60;
  const zurueck = 21 * 60;

  assert.equal(matrix.umwegSekunden(hin, zurueck, anteilig), 13 * 60);
  assert.equal(matrix.umwegSekunden(hin, zurueck, gemessen), 60);
});

test('der Umweg ist die Differenz zur ohnehin gefahrenen Strecke', () => {
  // Fünf Minuten hin, fünf zurück, vier hätte man ohnehin gebraucht.
  assert.equal(matrix.umwegSekunden(300, 300, 240), 360);

  // Findet die Matrix einen kürzeren Weg als die geplante Route, kommt
  // rechnerisch ein Gewinn heraus. Das ist Rauschen, kein Umweg.
  assert.equal(matrix.umwegSekunden(100, 100, 400), 0);

  // Fehlende Zellen ergeben keinen Umweg, nicht null Sekunden. Der
  // Unterschied entscheidet darüber, ob die App filtert oder durchlässt.
  assert.equal(matrix.umwegSekunden(null, 300, 240), null);
  assert.equal(matrix.umwegSekunden(300, null, 240), null);
});


// ------------------------------------------------------------- Register als Quelle

test('alsStation macht aus einem Registerstandort eine Station', () => {
  const s = registerquelle.alsStation({
    lat: 51.25601, lon: 6.68901, operator: 'Shell Deutschland GmbH', maxPowerKW: 300,
    deviceCount: 2, pointCount: 4, address: 'Kiesgräble 2', postalCode: '89129', city: 'Langenau',
  });
  assert.equal(s.id, 'bnetza:51.25601,6.68901');
  assert.equal(s.name, 'Shell Deutschland');
  assert.equal(s.operatorName, 'Shell Deutschland GmbH');
  assert.equal(s.address, 'Kiesgräble 2, 89129 Langenau');
  assert.equal(s.maxPowerKW, 300);
  assert.equal(s.detourSeconds, null);
});

test('kurzerBetreiber laesst Rechtsformen weg und sonst nichts', () => {
  assert.equal(registerquelle.kurzerBetreiber('EnBW mobility+ AG und Co.KG'), 'EnBW mobility+');
  assert.equal(registerquelle.kurzerBetreiber('Fastned Deutschland GmbH & Co. KG'), 'Fastned Deutschland');
  assert.equal(registerquelle.kurzerBetreiber('Stadtwerke Düsseldorf AG'), 'Stadtwerke Düsseldorf');
  assert.equal(registerquelle.kurzerBetreiber('Ionity GmbH'), 'Ionity');
  assert.equal(registerquelle.kurzerBetreiber('Aral pulse'), 'Aral pulse');
  assert.equal(registerquelle.kurzerBetreiber(''), 'Ladestation');
});

test('entlangDerRoute behaelt nur den Korridor und sortiert in Fahrtrichtung', () => {
  // Eine echte Route hat alle paar hundert Meter einen Punkt. Mit nur drei
  // Punkten auf 70 km faende die Projektion keinen innerhalb des Korridors.
  const route = Array.from({ length: 101 }, (_, i) => ({ lat: 51.0, lon: 6.0 + i / 100 }));
  const stationen = [
    { id: 'weit', lat: 51.2, lon: 6.5 },   // 22 km neben der Route
    { id: 'hinten', lat: 51.001, lon: 6.9 },
    { id: 'vorn', lat: 51.001, lon: 6.1 },
  ].map((s) => ({ ...s, name: s.id }));
  const ergebnis = registerquelle.entlangDerRoute(stationen, route, 2000);
  assert.deepEqual(ergebnis.map((s) => s.id), ['vorn', 'hinten']);
  assert.ok(ergebnis[0].progressMeters < ergebnis[1].progressMeters);
});

// ------------------------------------------------------------- Umwege ueber Routen

test('planeAnfragen: eine Grundstrecke je Abschnitt, eine Via-Route je Station', () => {
  const stuetzen = [
    { lat: 51, lon: 6, progressMeters: 0 },
    { lat: 51, lon: 6.7, progressMeters: 50_000 },
    { lat: 51, lon: 7.4, progressMeters: 100_000 },
  ];
  const stationen = [
    { id: 'a', lat: 51.01, lon: 6.2, progressMeters: 14_000 },
    { id: 'b', lat: 51.01, lon: 6.4, progressMeters: 28_000 },
    { id: 'c', lat: 51.01, lon: 7.0, progressMeters: 72_000 },
    { id: 'ohneLage', lat: 51, lon: 6 },
  ];
  const plan = umwege.planeAnfragen(stuetzen, stationen);
  assert.equal(plan.grundstrecken.length, 2, 'zwei Abschnitte mit Stationen');
  assert.equal(plan.viaStrecken.length, 3, 'ohne Lage keine Anfrage');
  assert.deepEqual(plan.viaStrecken[0].punkte.map((p) => p.lon), [6, 6.2, 6.7]);
  assert.equal(plan.viaStrecken[2].schluessel, plan.grundstrecken[1].schluessel);
});

test('berechneUmwege schreibt den Umweg in die Station und zaehlt Anfragen', async () => {
  const stuetzen = [
    { lat: 51, lon: 6, progressMeters: 0 },
    { lat: 51, lon: 6.7, progressMeters: 50_000 },
  ];
  const stationen = [
    { id: 'a', lat: 51.01, lon: 6.2, progressMeters: 14_000, detourSeconds: null },
    { id: 'b', lat: 51.01, lon: 6.4, progressMeters: 28_000, detourSeconds: null },
  ];
  // Die Routenfunktion ist eine Tabelle: Grundstrecke 1800 s, ueber a 2100 s,
  // ueber b 1750 s (die Route ueber b ist kuerzer als die Grundstrecke, das
  // ist Rauschen und muss null werden, nicht minus fuenfzig).
  const zeiten = { 2: 1800, '6.2': 2100, '6.4': 1750 };
  const routeSekunden = async (punkte) =>
    punkte.length === 2 ? zeiten[2] : zeiten[String(punkte[1].lon)];

  const fortschritte = [];
  const ergebnis = await umwege.berechneUmwege(routeSekunden, stuetzen, stationen, {
    onFortschritt: (n, von) => fortschritte.push([n, von]),
  });

  assert.equal(stationen[0].detourSeconds, 300);
  assert.equal(stationen[0].detourGerechnet, true);
  assert.equal(stationen[1].detourSeconds, 0);
  assert.deepEqual(ergebnis, { anfragen: 3, gerechnet: 2, fehler: 0, abschnitte: 1 });
  assert.deepEqual(fortschritte, [[1, 2], [2, 2]]);
});

test('berechneUmwege markiert, ob der Abschnitt innen liegt', async () => {
  // Vier Stuetzpunkte: 0 ist der Start, 3 das Ziel. Nur 1->2 ist innen.
  const stuetzen = [0, 50_000, 100_000, 150_000].map((m, i) => ({ lat: 51, lon: 6 + i, progressMeters: m }));
  const stationen = [
    { id: 'start', lat: 51, lon: 6.2, progressMeters: 10_000, detourSeconds: null },
    { id: 'innen', lat: 51, lon: 7.2, progressMeters: 60_000, detourSeconds: null },
    { id: 'ziel', lat: 51, lon: 8.2, progressMeters: 110_000, detourSeconds: null },
  ];
  const routeSekunden = async (p) => (p.length === 2 ? 1000 : 1100);
  await umwege.berechneUmwege(routeSekunden, stuetzen, stationen);
  assert.deepEqual(stationen.map((s) => s.umwegInnen), [false, true, false]);
  assert.deepEqual(stationen.map((s) => s.detourSeconds), [100, 100, 100], 'gerechnet wird trotzdem');
});

test('berechneUmwege: scheitert die Grundstrecke, bleiben die Stationen ohne Wert', async () => {
  const stuetzen = [
    { lat: 51, lon: 6, progressMeters: 0 },
    { lat: 51, lon: 6.7, progressMeters: 50_000 },
  ];
  const stationen = [{ id: 'a', lat: 51.01, lon: 6.2, progressMeters: 14_000, detourSeconds: null }];
  const routeSekunden = async (punkte) => {
    if (punkte.length === 2) throw new Error('403');
    return 2100;
  };
  const ergebnis = await umwege.berechneUmwege(routeSekunden, stuetzen, stationen);
  assert.equal(stationen[0].detourSeconds, null);
  assert.equal(ergebnis.gerechnet, 0);
  assert.equal(ergebnis.fehler, 1);
  assert.equal(ergebnis.anfragen, 1, 'ohne Grundstrecke keine Via-Anfrage verschwenden');
});


// ------------------------------------------------------------- Umwegtabelle

test('sektor teilt den Kreis in acht Richtungen, Nord in der Mitte des ersten', () => {
  assert.equal(tabelle.sektor(0), 0);
  assert.equal(tabelle.sektor(22), 0);
  assert.equal(tabelle.sektor(23), 1);
  assert.equal(tabelle.sektor(90), 2);
  assert.equal(tabelle.sektor(180), 4);
  assert.equal(tabelle.sektor(270), 6);
  assert.equal(tabelle.sektor(300), 7);
  assert.equal(tabelle.sektor(340), 0, 'ab 337,5 Grad ist es wieder Nord');
  assert.equal(tabelle.sektor(359), 0);
});

test('kurs: nach Norden 0, nach Osten 90', () => {
  assert.ok(Math.abs(tabelle.kurs({ lat: 51, lon: 7 }, { lat: 52, lon: 7 })) < 0.01);
  assert.ok(Math.abs(tabelle.kurs({ lat: 51, lon: 7 }, { lat: 51, lon: 8 }) - 90) < 0.5);
});

test('der Schluessel ist fuer dieselbe Strasse in derselben Richtung gleich', () => {
  const nachOsten = Array.from({ length: 101 }, (_, i) => ({ lat: 51.0, lon: 6.0 + i / 100 }));
  const nachWesten = [...nachOsten].reverse();
  const lageOst = tabelle.routenLage(nachOsten);
  const lageWest = tabelle.routenLage(nachWesten);

  // Dieselbe Station, einmal bei km 30 von Westen, einmal bei km 40 von Osten.
  const station = { id: 'bnetza:51.00100,6.30000' };
  const ost = tabelle.schluessel({ ...station, progressMeters: lageOst.kumuliert[30] }, lageOst);
  const west = tabelle.schluessel({ ...station, progressMeters: lageWest.kumuliert[70] }, lageWest);

  assert.equal(ost, 'bnetza:51.00100,6.30000|2|51.00,6.30');
  assert.equal(west, 'bnetza:51.00100,6.30000|6|51.00,6.30');
  assert.notEqual(ost, west, 'Gegenfahrbahn ist ein anderer Umweg');

  // Eine zweite Fahrt auf derselben Strasse, anderer Start: derselbe Schluessel.
  const spaeter = nachOsten.slice(10);
  const lage2 = tabelle.routenLage(spaeter);
  const ost2 = tabelle.schluessel({ ...station, progressMeters: lage2.kumuliert[20] }, lage2);
  assert.equal(ost2, ost);
});

test('eintragen und nachschlagen, und Verkehr ueberschreibt nicht', () => {
  const route = Array.from({ length: 11 }, (_, i) => ({ lat: 51.0, lon: 6.0 + i / 100 }));
  const lage = tabelle.routenLage(route);
  const station = { id: 's', progressMeters: lage.kumuliert[5] };
  const t = tabelle.leereTabelle();

  assert.equal(tabelle.nachschlagen(t, station, lage), null);
  assert.ok(tabelle.eintragen(t, station, lage, 123.4, { datum: '2026-09-29' }));
  assert.equal(tabelle.nachschlagen(t, station, lage), 123);

  assert.equal(tabelle.eintragen(t, station, lage, 500, { mitVerkehr: true }), false);
  assert.equal(tabelle.nachschlagen(t, station, lage), 123);

  // Ohne Verkehr darf einen Wert mit Verkehr ersetzen.
  const t2 = tabelle.leereTabelle();
  tabelle.eintragen(t2, station, lage, 500, { mitVerkehr: true });
  assert.ok(tabelle.eintragen(t2, station, lage, 120));
  assert.equal(t2.eintraege[tabelle.schluessel(station, lage)].verkehr, false);
});

test('gerundet rundet kaufmaennisch auf zwei Stellen', () => {
  assert.equal(tabelle.gerundet(51.005), '51.01');
  assert.equal(tabelle.gerundet(6.294999), '6.29');
  assert.equal(tabelle.gerundet(7), '7.00');
});


// ------------------------------------------------------------- Fahransicht

// Alle 100 m ein Punkt, wie bei einer echten Routengeometrie.
const geradeNachOsten = (km, schritt = 100) =>
  Array.from({ length: (km * 1000) / schritt + 1 }, (_, i) => ({
    lat: 51.0,
    lon: 6.0 + (i * schritt) / (111_320 * Math.cos((51 * Math.PI) / 180)),
  }));

test('verorte: Position neben der Route landet auf dem Lotfusspunkt', () => {
  const lage = fahrt.routenLage(geradeNachOsten(20));
  // 50 m noerdlich, bei km 7,5
  const p = { lat: 51.0 + 50 / 111_132, lon: lage.punkte[75].lon };
  const v = fahrt.verorte(lage, p, 0);
  assert.ok(Math.abs(v.fortschritt - 7500) < 30, `bei ${v.fortschritt}`);
  assert.ok(Math.abs(v.abstand - 50) < 3);
  assert.equal(v.aufDerRoute, true);
});

test('verorte: bleibt auf dem Ast, auf dem das Auto faehrt', () => {
  // Hin nach Osten und auf fast derselben Linie zurueck: eine Kehre.
  const hin = geradeNachOsten(10);
  const zurueck = [...hin].reverse().map((p) => ({ lat: p.lat + 20 / 111_132, lon: p.lon }));
  const lage = fahrt.routenLage([...hin, ...zurueck]);
  const p = { lat: 51.0 + 10 / 111_132, lon: hin[30].lon };
  // Auf dem Rueckweg, letzter Treffer kurz davor (Index 165 von 202): dort
  // muss es bleiben, obwohl der Hinweg zehn Meter daneben liegt.
  const v = fahrt.verorte(lage, p, 165);
  assert.ok(v.fortschritt > 10_000, `sprang auf den Hinweg: ${v.fortschritt}`);
  // Am Anfang der Fahrt: Hinweg.
  const w = fahrt.verorte(lage, p, 0);
  assert.ok(w.fortschritt < 10_000);
});

test('verorte: weit weg heisst nicht auf der Route', () => {
  const lage = fahrt.routenLage(geradeNachOsten(10));
  const v = fahrt.verorte(lage, { lat: 51.05, lon: 6.05 }, 0);
  assert.equal(v.aufDerRoute, false);
});

test('kacheln: drei vor dem Auto, gebuendelt, mit Akku bei Ankunft', () => {
  const stationen = [
    { id: 'hinten', progressMeters: 1_000, detourSeconds: 60 },
    { id: 'a', progressMeters: 20_000, detourSeconds: 300 },
    { id: 'a2', progressMeters: 21_000, detourSeconds: 0 },   // gleiche Ausfahrt, besser
    { id: 'b', progressMeters: 50_000, detourSeconds: 120, detourMeters: 2_000 },
    { id: 'c', progressMeters: 90_000 },
    { id: 'd', progressMeters: 150_000 },
  ];
  const k = fahrt.kacheln({ stationen, fortschritt: 10_000, akkuJetzt: 40, prozentJeKm: 0.25 });
  assert.deepEqual(k.map((x) => x.station.id), ['a2', 'b', 'c']);
  assert.equal(k[0].weitere, 1);
  assert.equal(k[0].meter, 11_000, 'Raststaette: kein Zugang');
  assert.equal(k[1].meter, 41_000, 'halbe Umwegstrecke dazu');
  assert.ok(Math.abs(k[1].akkuBeiAnkunft - (40 - 41 * 0.25)) < 1e-9);
  // Reichweite bis 10 %: 30 / 0.25 = 120 km. c bei 80 km ist drin.
  assert.deepEqual(k.map((x) => x.erreichbar), [true, true, true]);
});

test('kacheln: geplanter Stopp geht in der Gruppe vor, Linie der Reichweite', () => {
  const stationen = [
    { id: 'schnell', progressMeters: 30_000, detourSeconds: 0 },
    { id: 'plan', progressMeters: 30_800, detourSeconds: 240 },
    { id: 'weit', progressMeters: 200_000 },
  ];
  const k = fahrt.kacheln({
    stationen, fortschritt: 0, akkuJetzt: 30, prozentJeKm: 0.25, geplant: new Set(['plan']),
  });
  assert.equal(k[0].station.id, 'plan');
  assert.equal(k[0].geplant, true);
  assert.equal(k[1].erreichbar, false, '200 km bei 80 km Reichweite');
  assert.equal(fahrt.reichweitenLinie(k), 1);
});

test('zugangMeter: Meter vor Sekunden vor Luftlinie', () => {
  assert.equal(fahrt.zugangMeter({ detourMeters: 3000, detourSeconds: 999 }), 1500);
  assert.ok(Math.abs(fahrt.zugangMeter({ detourSeconds: 360 }) - 2500) < 1);
  assert.equal(fahrt.zugangMeter({ distanceFromRouteMeters: 400 }), 400);
});

test('berechneUmwege schreibt Meter, wenn die Routenfunktion sie liefert', async () => {
  const stuetzen = [0, 50_000, 100_000, 150_000].map((m, i) => ({ lat: 51, lon: 6 + i, progressMeters: m }));
  const stationen = [{ id: 'innen', lat: 51, lon: 7.2, progressMeters: 60_000, detourSeconds: null }];
  const route = async (p) => (p.length === 2 ? { sekunden: 1000, meter: 50_000 } : { sekunden: 1300, meter: 53_400 });
  await umwege.berechneUmwege(route, stuetzen, stationen);
  assert.equal(stationen[0].detourSeconds, 300);
  assert.equal(stationen[0].detourMeters, 3400);
  assert.equal(fahrt.zugangMeter(stationen[0]), 1700);
});

test('umwegtabelle: Meter werden mitgeschrieben und gelesen', () => {
  const route = Array.from({ length: 11 }, (_, i) => ({ lat: 51.0, lon: 6.0 + i / 100 }));
  const lage = tabelle.routenLage(route);
  const station = { id: 's', progressMeters: lage.kumuliert[5] };
  const t = tabelle.leereTabelle();
  tabelle.eintragen(t, station, lage, 300, { meter: 3400.4, datum: '2026-09-30' });
  assert.deepEqual(tabelle.nachschlagenEintrag(t, station, lage), {
    sekunden: 300, meter: 3400, verkehr: false, datum: '2026-09-30',
  });
});


// ------------------------------------------------------------- Marken

const markenPfad = new URL('../../daten/marken.json', import.meta.url).pathname;
const register150 = new URL('../../daten/standorte-150kw.json', import.meta.url).pathname;

test('marken: Register-Firmennamen landen bei der Marke, die man kennt', () => {
  const m = marken.ladeMarken(markenPfad);
  const id = (name) => marken.markeVon(m, name)?.id ?? null;
  assert.equal(id('BP Europa SE'), 'aral');
  assert.equal(id('Aral pulse'), 'aral');
  assert.equal(id('EnBW mobility+ AG und Co.KG'), 'enbw');
  assert.equal(id('IONITY GmbH'), 'ionity');
  assert.equal(id('Tesla Germany GmbH'), 'tesla');
  assert.equal(id('ALDI SÜD Immobilienverwaltungs-GmbH & Co. oHG'), 'aldi');
  assert.equal(id('Fastned Deutschland GmbH & Co. KG'), 'fastned');
  assert.equal(id('Stadtwerke Duisburg AG'), null);
  // STEAG enthaelt TEAG, ist aber ein anderer Betreiber.
  assert.equal(id('STEAG Technischer Service GmbH'), null);
  assert.equal(id('TEAG Mobil GmbH'), 'teag');
});

test('marken: kein Betreiber im Register passt auf zwei Marken', () => {
  const m = marken.ladeMarken(markenPfad);
  const betreiber = new Set(JSON.parse(readFileSync(register150, 'utf8')).standorte.map((s) => s.operator));
  const doppelt = [...betreiber]
    .map((b) => [b, marken.alleMarkenVon(m, b).map((x) => x.id)])
    .filter(([, ids]) => ids.length > 1);
  assert.deepEqual(doppelt, [], 'Muster ueberschneiden sich');
});

test('marken: die Tabelle deckt mindestens 70 Prozent der Standorte ab 150 kW', () => {
  const m = marken.ladeMarken(markenPfad);
  const standorte = JSON.parse(readFileSync(register150, 'utf8')).standorte;
  const mitMarke = standorte.filter((s) => marken.markeVon(m, s.operator)).length;
  const anteil = mitMarke / standorte.length;
  assert.ok(anteil >= 0.7, `nur ${(anteil * 100).toFixed(1)} Prozent`);
});


test('kachelnMitFavoriten: nur Favoriten, keine Ausweichzeile, solange es reicht', () => {
  const stationen = [
    { id: 'fremd1', progressMeters: 10_000, detourSeconds: 0 },
    { id: 'fav1', progressMeters: 30_000, detourSeconds: 0 },
    { id: 'fremd2', progressMeters: 40_000, detourSeconds: 0 },
    { id: 'fav2', progressMeters: 80_000, detourSeconds: 0 },
  ];
  const r = fahrt.kachelnMitFavoriten({
    stationen, istFavorit: (s) => s.id.startsWith('fav'), fortschritt: 0, akkuJetzt: 60, prozentJeKm: 0.25,
  });
  assert.deepEqual(r.kacheln.map((k) => k.station.id), ['fav1', 'fav2']);
  assert.equal(r.ausweich, null);
});

test('kachelnMitFavoriten: naechster Favorit zu weit, Ausweichen auf die fernste erreichbare', () => {
  // 20 % Akku, Reserve 10 %, 0,25 %/km: 40 km Reichweite.
  const stationen = [
    { id: 'fremd1', progressMeters: 10_000, detourSeconds: 0 },
    { id: 'fremd2', progressMeters: 35_000, detourSeconds: 0 },
    { id: 'fremd3', progressMeters: 45_000, detourSeconds: 0 },  // zu weit
    { id: 'fav1', progressMeters: 60_000, detourSeconds: 0 },
  ];
  const r = fahrt.kachelnMitFavoriten({
    stationen, istFavorit: (s) => s.id.startsWith('fav'), fortschritt: 0, akkuJetzt: 20, prozentJeKm: 0.25,
  });
  assert.deepEqual(r.kacheln.map((k) => k.station.id), ['fav1']);
  assert.equal(r.kacheln[0].erreichbar, false);
  assert.equal(r.ausweich.station.id, 'fremd2');
  assert.ok(Math.abs(r.ausweich.akkuBeiAnkunft - (20 - 35 * 0.25)) < 1e-9);
});

test('kachelnMitFavoriten: ohne Favoriten wie bisher', () => {
  const stationen = [{ id: 'a', progressMeters: 10_000 }, { id: 'b', progressMeters: 20_000 }];
  const r = fahrt.kachelnMitFavoriten({
    stationen, istFavorit: () => false, fortschritt: 0, akkuJetzt: 50, prozentJeKm: 0.25,
  });
  assert.deepEqual(r.kacheln.map((k) => k.station.id), ['a', 'b']);
  assert.equal(r.ausweich, null);
});

test('kachelnMitFavoriten: Favoriten gewaehlt, aber keiner auf der Strecke', () => {
  const stationen = [{ id: 'a', progressMeters: 10_000 }, { id: 'b', progressMeters: 20_000 }];
  const r = fahrt.kachelnMitFavoriten({
    stationen, istFavorit: () => false, favoritenAktiv: true, fortschritt: 0, akkuJetzt: 50, prozentJeKm: 0.25,
  });
  assert.deepEqual(r.kacheln, []);
  assert.equal(r.ausweich.station.id, 'b', 'die fernste erreichbare');
});


test('kachelnMitFavoriten: Stufe 2, Favorit mit weniger Leistung vor fremdem', () => {
  // 20 % Akku: 40 km Reichweite. Kein fremder 300er erreichbar.
  const stationen = [
    { id: 'fremd300', progressMeters: 45_000 },
    { id: 'fav300', progressMeters: 60_000 },
  ];
  const niedrigereLeistung = [
    { id: 'fremd150', progressMeters: 38_000 },
    { id: 'fav150', progressMeters: 30_000 },
  ];
  const r = fahrt.kachelnMitFavoriten({
    stationen, niedrigereLeistung, istFavorit: (s) => s.id.startsWith('fav'),
    fortschritt: 0, akkuJetzt: 20, prozentJeKm: 0.25,
  });
  assert.equal(r.ausweich.station.id, 'fav150', 'Favorit geht vor, auch wenn der fremde weiter liegt');
  assert.equal(r.ausweich.grund, 'wenigerLeistung');
});

test('kachelnMitFavoriten: Stufe 1 schlaegt Stufe 2, gewuenschte Leistung zuerst', () => {
  const stationen = [
    { id: 'fremd300', progressMeters: 25_000 },
    { id: 'fav300', progressMeters: 60_000 },
  ];
  const niedrigereLeistung = [{ id: 'fav150', progressMeters: 35_000 }];
  const r = fahrt.kachelnMitFavoriten({
    stationen, niedrigereLeistung, istFavorit: (s) => s.id.startsWith('fav'),
    fortschritt: 0, akkuJetzt: 20, prozentJeKm: 0.25,
  });
  assert.equal(r.ausweich.station.id, 'fremd300');
  assert.equal(r.ausweich.grund, 'andererAnbieter');
});

test('kachelnMitFavoriten: ohne Favoriten schlaegt die Zeile eine schwaechere Saeule vor', () => {
  const stationen = [{ id: 'hpc', progressMeters: 70_000 }];
  const niedrigereLeistung = [{ id: 'dc150', progressMeters: 30_000 }];
  const r = fahrt.kachelnMitFavoriten({
    stationen, niedrigereLeistung, istFavorit: () => false,
    fortschritt: 0, akkuJetzt: 20, prozentJeKm: 0.25,
  });
  assert.deepEqual(r.kacheln.map((k) => k.station.id), ['hpc']);
  assert.equal(r.ausweich.station.id, 'dc150');
  assert.equal(r.ausweich.grund, 'wenigerLeistung');
});

// ---------------------------------------------------------------- Ansage

// Echte Antwort der Routing-API, Meerbusch nach Norddeich, mit Routenpunkten.
// Erzeugt mit: Probelauf zielfuehrung-probe.mjs --fixture
const zielfuehrung = () => {
  const f = fixture('anweisungen-meerbusch-norddeich.json');
  const lage = fahrt.routenLage(f.punkte.map(([lat, lon]) => ({ lat, lon })));
  const anweisungen = ansage.verorteAnweisungen(ansage.anweisungenAusAntwort(f.anweisungen), lage);
  return { f, lage, anweisungen };
};

/** Faehrt die Route in gleichen Schritten ab und sammelt, was gesagt wird. */
const abfahren = (anweisungen, laenge, tempo, schritt) => {
  const zustand = ansage.neuerAnsager();
  const gesagt = [];
  // Ein Schritt ueber das Ende hinaus: Dort steht die Simulation zuletzt.
  for (let m = 0; m <= laenge + schritt; m += schritt) {
    const r = ansage.schritt(zustand, anweisungen, m, tempo);
    if (r.text) gesagt.push({ bei: m, index: r.index, stufe: r.stufe, text: r.text });
  }
  return gesagt;
};

test('entfernungGesprochen: gerundet und im Dativ', () => {
  assert.equal(ansage.entfernungGesprochen(120), '100 Metern');
  assert.equal(ansage.entfernungGesprochen(480), '500 Metern');
  assert.equal(ansage.entfernungGesprochen(1000), 'einem Kilometer');
  assert.equal(ansage.entfernungGesprochen(1480), '1,5 Kilometern');
  assert.equal(ansage.entfernungGesprochen(2000), '2 Kilometern');
  assert.equal(ansage.entfernungGesprochen(12_300), '12 Kilometern');
});

test('sprechbar: Strassennummern so, wie man sie sagt', () => {
  assert.equal(ansage.sprechbar('Folgen Sie B1 Richtung Dortmund'), 'Folgen Sie B eins Richtung Dortmund');
  assert.equal(ansage.sprechbar('Fahren Sie auf die Autobahn A57/E31'), 'Fahren Sie auf die Autobahn A 57');
  assert.equal(ansage.sprechbar('Biegen Sie rechts ab auf Moerser Straße/L137'), 'Biegen Sie rechts ab auf Moerser Straße, L 137');
  assert.equal(ansage.sprechbar('Folgen Sie A3/E35 Richtung Köln'), 'Folgen Sie A 3 Richtung Köln');
  assert.equal(ansage.sprechbar('Fahren Sie auf A1 und dann auf A10'), 'Fahren Sie auf A eins und dann auf A 10');
  assert.equal(ansage.sprechbar('Biegen Sie links ab auf Brühler Weg'), 'Biegen Sie links ab auf Brühler Weg');
  // Alle Anweisungen der Testroute: kein Schraegstrich, keine Nummer am Buchstaben.
  const f = JSON.parse(readFileSync(join(here, 'fixtures', 'anweisungen-meerbusch-norddeich.json'), 'utf8'));
  for (const a of f.anweisungen) {
    const s = ansage.sprechbar(a.message);
    assert.ok(!s.includes('/'), s);
    assert.ok(!/\b[A-Z]{1,2}\d/.test(s), s);
  }
});

test('entfernungKurz: fuer die Anzeige', () => {
  assert.equal(ansage.entfernungKurz(87), '90 m');
  assert.equal(ansage.entfernungKurz(260), '250 m');
  assert.equal(ansage.entfernungKurz(1540), '1,5 km');
  assert.equal(ansage.entfernungKurz(209_000), '209 km');
});

test('ansageText: Entfernung vor den Satz der API, kombiniert ab "nah"', () => {
  const links = { manoever: 'TURN_LEFT', text: 'Biegen Sie links ab auf Brühler Weg', kombiniert: null };
  assert.equal(ansage.ansageText(links, 'frueh', 480), 'In 500 Metern biegen Sie links ab auf Brühler Weg');
  assert.equal(ansage.ansageText(links, 'jetzt', 30), 'Biegen Sie links ab auf Brühler Weg');
  const doppelt = { manoever: 'TAKE_EXIT', text: 'Nehmen Sie die Ausfahrt 25', kombiniert: 'Nehmen Sie die Ausfahrt 25 dann bleiben Sie links' };
  assert.equal(ansage.ansageText(doppelt, 'frueh', 2000), 'In 2 Kilometern nehmen Sie die Ausfahrt 25');
  assert.equal(ansage.ansageText(doppelt, 'nah', 600), 'In 600 Metern nehmen Sie die Ausfahrt 25 dann bleiben Sie links');
  // "jetzt" kurz, ausser "nah" ist ausgefallen.
  assert.equal(ansage.ansageText(doppelt, 'jetzt', 100), 'Nehmen Sie die Ausfahrt 25');
  assert.equal(ansage.ansageText(doppelt, 'jetzt', 100, 0, { mitDann: true }), doppelt.kombiniert);
  const folgen = { manoever: 'FOLLOW', text: 'Folgen Sie A31 Richtung Bottrop-Kirchhellen', kombiniert: null };
  assert.equal(ansage.ansageText(folgen, 'frueh', 1500, 209_000), null);
  assert.equal(ansage.ansageText(folgen, 'jetzt', 50, 209_088), 'Folgen Sie A31 Richtung Bottrop-Kirchhellen für 209 Kilometer');
  // Kurz danach kommt die naechste Abbiegung: kein "Folgen Sie".
  assert.equal(ansage.ansageText(folgen, 'jetzt', 50, 5_000), null);
  const ziel = { manoever: 'ARRIVE_LEFT', text: 'Sie sind angekommen. Ihr Ziel liegt auf der linken Seite', kombiniert: null };
  assert.equal(ansage.ansageText(ziel, 'nah', 190), 'In 200 Metern erreichen Sie Ihr Ziel');
  assert.equal(ansage.ansageText(ziel, 'jetzt', 20), ziel.text);
  assert.equal(ansage.ansageText({ manoever: 'DEPART', text: 'Abfahrt' }, 'jetzt', 0), null);
});

test('verorteAnweisungen: jede Anweisung an ihrer Stelle der Routenlinie', () => {
  const { f, lage, anweisungen } = zielfuehrung();
  assert.equal(anweisungen.length, f.anweisungen.length);
  let vorher = -1;
  for (const a of anweisungen) {
    assert.ok(a.fortschritt >= vorher, `rueckwaerts bei ${a.text}`);
    vorher = a.fortschritt;
    // Dieselbe Route: Die Meter der API und die auf der eigenen Linie
    // liegen dicht beieinander, wenn man die Gesamtlaengen abgleicht. Die
    // eigene Rechnung kommt auf 332 km ein halbes Promille kuerzer heraus.
    const erwartet = a.offset * (lage.laenge / f.laengeMeter);
    assert.ok(Math.abs(a.fortschritt - erwartet) < 150, `${a.text}: ${a.fortschritt} statt ${erwartet}`);
  }
  assert.ok(Math.abs(lage.laenge - f.laengeMeter) < 0.01 * f.laengeMeter);
});

test('verorteAnweisungen: weicht die Linie ab, zaehlt der Meterwert, umgerechnet', () => {
  const lage = fahrt.routenLage(geradeNachOsten(10));
  const anweisungen = ansage.verorteAnweisungen([
    { offset: 0, punkt: lage.punkte[0], manoever: 'DEPART', text: '' },
    { offset: 4000, punkt: { lat: 51.2, lon: 6.05 }, manoever: 'TURN_LEFT', text: '' },
    { offset: 8000, punkt: lage.punkte[100], manoever: 'ARRIVE', text: '' },
  ], lage);
  // 4000 von 8000 API-Metern ist die Haelfte der eigenen 10 km.
  assert.ok(Math.abs(anweisungen[1].fortschritt - lage.laenge / 2) < 1);
  assert.ok(Math.abs(anweisungen[2].fortschritt - lage.laenge) < 1);
});

test('schritt: bei 130 km/h fruehe, nahe und jetzige Ansage, jede einmal', () => {
  const { lage, anweisungen } = zielfuehrung();
  const gesagt = abfahren(anweisungen, lage.laenge, 36, 36);
  const ausfahrt = anweisungen.findIndex((a) => a.text.startsWith('Nehmen Sie die Ausfahrt 9'));
  const zurAusfahrt = gesagt.filter((g) => g.index === ausfahrt);
  assert.deepEqual(zurAusfahrt.map((g) => g.stufe), ['frueh', 'nah', 'jetzt']);
  assert.equal(zurAusfahrt[0].text, 'In 2 Kilometern nehmen Sie die Ausfahrt 9 auf A31 Richtung Norddeich');
  assert.match(zurAusfahrt[1].text, /^In 600 Metern nehmen Sie die Ausfahrt 9 .* dann fahren Sie auf die Autobahn A31$/);
  // Keine Stufe doppelt.
  const schluessel = gesagt.map((g) => `${g.index}:${g.stufe}`);
  assert.equal(new Set(schluessel).size, schluessel.length);
  // Die lange A31 wird mit Strecke angesagt.
  assert.ok(gesagt.some((g) => g.text === 'Folgen Sie A31 Richtung Bottrop-Kirchhellen für 209 Kilometer'),
    gesagt.filter((g) => g.text.startsWith('Folgen Sie A31')).map((g) => g.text).join(' | '));
  // "jetzt" ohne das "dann", das bei 600 m schon kam.
  assert.equal(zurAusfahrt[2].text, 'Nehmen Sie die Ausfahrt 9 auf A31 Richtung Norddeich');
  // Und am Ende das Ziel.
  assert.equal(gesagt.at(-1).text, 'Sie sind angekommen. Ihr Ziel liegt auf der linken Seite');
});

test('schritt: was "dann ..." schon angekuendigt hat, kommt nur noch als "jetzt"', () => {
  const { lage, anweisungen } = zielfuehrung();
  const gesagt = abfahren(anweisungen, lage.laenge, 14, 14);
  // Kurz vor dem Ziel: "Biegen Sie links ab auf Nordlandstraße dann biegen
  // Sie rechts ab auf Nordmeerstraße", 150 m spaeter die Nordmeerstraße.
  const nordmeer = anweisungen.findIndex((a) => a.text === 'Biegen Sie rechts ab auf Nordmeerstraße');
  assert.ok(nordmeer > 0);
  assert.deepEqual(gesagt.filter((g) => g.index === nordmeer).map((g) => g.stufe), ['jetzt']);
});

test('schritt: in der zehnfachen Simulation kommt jede Abbiegung wenigstens einmal', () => {
  const { lage, anweisungen } = zielfuehrung();
  const gesagt = abfahren(anweisungen, lage.laenge, 361, 72);
  const angesagt = new Set(gesagt.map((g) => g.index));
  anweisungen.forEach((a, i) => {
    if (a.manoever === 'DEPART') return;
    if (a.manoever === 'FOLLOW' && anweisungen[i + 1].fortschritt - a.fortschritt < 10_000) return;
    // Liegt eine Anweisung weniger als einen Takt hinter der vorigen, ist
    // sie womoeglich nie die naechste; die vorige hat sie dann mit
    // "dann ..." angekuendigt. Das Ziel ist davon ausgenommen.
    if (i > 0 && a.fortschritt - anweisungen[i - 1].fortschritt < 72 && !a.manoever.startsWith('ARRIVE')) return;
    assert.ok(angesagt.has(i), `nicht angesagt: ${a.text}`);
  });
  assert.equal(gesagt.at(-1).text, 'Sie sind angekommen. Ihr Ziel liegt auf der linken Seite');
});

test('naechsteAnweisung: die Abfahrt zaehlt nicht, hinter dem Ziel kommt nichts', () => {
  const { lage, anweisungen } = zielfuehrung();
  assert.equal(anweisungen[ansage.naechsteAnweisung(anweisungen, 0)].manoever, 'TURN_LEFT');
  // Bis 100 m hinter dem Ziel bleibt es die naechste Anweisung.
  assert.equal(anweisungen[ansage.naechsteAnweisung(anweisungen, lage.laenge + 1)].manoever, 'ARRIVE_LEFT');
  assert.equal(ansage.naechsteAnweisung(anweisungen, lage.laenge + 200), null);
});

// ---------------------------------------------------------------- Akku

test('akkuJetzt: ab Start heruntergerechnet, nach einem Ladestopp vom neuen Stand', () => {
  const p = { start: 80, prozentJeKm: 0.25 };
  assert.equal(akku.akkuJetzt({ ...p, gefahrenMeter: 100_000 }), 55);
  const ereignisse = [{ beiMeter: 200_000, prozent: 75 }];
  // Vor dem Stopp zaehlt er noch nicht.
  assert.equal(akku.akkuJetzt({ ...p, ereignisse, gefahrenMeter: 150_000 }), 42.5);
  assert.equal(akku.akkuJetzt({ ...p, ereignisse, gefahrenMeter: 200_000 }), 75);
  assert.equal(akku.akkuJetzt({ ...p, ereignisse, gefahrenMeter: 240_000 }), 65);
  // Nie unter null.
  assert.equal(akku.akkuJetzt({ ...p, gefahrenMeter: 1_000_000 }), 0);
});

test('ladungNach: Umkehrung der Ladezeit', () => {
  const sekunden = ladeplanung.ladezeitSekunden(11.55, 50, AUTO.chargingCurve, 300);
  const erreicht = akku.ladungNach(11.55, sekunden, AUTO.chargingCurve, 300, 77);
  assert.ok(Math.abs(erreicht - 50) < 0.5, `erreicht ${erreicht}`);
  // Nie ueber voll, auch nach Stunden.
  assert.equal(akku.ladungNach(60, 5 * 3600, AUTO.chargingCurve, 300, 77), 77);
  // Eine 50-kW-Saeule laedt in derselben Zeit weniger.
  assert.ok(akku.ladungNach(11.55, 1200, AUTO.chargingCurve, 50, 77) < akku.ladungNach(11.55, 1200, AUTO.chargingCurve, 300, 77));
});

test('ladeSchaetzung: 22 Minuten an 300 kW ab 15 Prozent', () => {
  const p = akku.ladeSchaetzung({ akkuProzent: 15, haltMinuten: 22, saeulenKW: 300, fahrzeug: AUTO });
  // 20 Minuten Laden, die Kurve faellt ab 40 Prozent: knapp 80 Prozent.
  assert.ok(p > 70 && p < 90, `geschaetzt ${p}`);
  // Zwei Minuten sind nur An- und Abstecken.
  assert.equal(akku.ladeSchaetzung({ akkuProzent: 15, haltMinuten: 2, saeulenKW: 300, fahrzeug: AUTO }), 15);
});

// Ein Punkt so viele Meter oestlich einer Saeule.
const oestlich = (s, meter) => ({ lat: s.lat, lon: s.lon + meter / (111_320 * Math.cos((s.lat * Math.PI) / 180)) });

test('haltSchritt: 20 Minuten an der Saeule, dann weiter', () => {
  const saeule = { id: 'kamen', lat: 51.6, lon: 7.6 };
  const z = akku.neuerHalt();
  const ereignisse = [];
  const schritt = (zeit, position) => {
    const e = akku.haltSchritt(z, { zeit, position, stationen: [saeule] });
    if (e) ereignisse.push({ ...e, zeit });
  };
  schritt(0, oestlich(saeule, 2000));
  schritt(10, oestlich(saeule, 100));
  for (let t = 20; t <= 1200; t += 10) schritt(t, oestlich(saeule, 20));
  schritt(1210, oestlich(saeule, 200));
  schritt(1220, oestlich(saeule, 400));
  assert.deepEqual(ereignisse.map((e) => e.art), ['angekommen', 'weiter']);
  assert.equal(ereignisse[0].zeit, 130);
  assert.ok(Math.abs(ereignisse[1].minuten - 1210 / 60) < 0.01);
  assert.equal(ereignisse[1].station.id, 'kamen');
});

test('haltSchritt: vorbeifahren und kurz halten zaehlt nicht', () => {
  const saeule = { id: 'x', lat: 51.6, lon: 7.6 };
  const z = akku.neuerHalt();
  const ereignisse = [];
  // Vorbei mit 30 m/s.
  for (let m = -1000, t = 0; m <= 1000; m += 30, t += 1) {
    const e = akku.haltSchritt(z, { zeit: t, position: oestlich(saeule, m), stationen: [saeule] });
    if (e) ereignisse.push(e);
  }
  // Eine Minute gestanden, dann weiter.
  for (let t = 100; t <= 160; t += 10) {
    const e = akku.haltSchritt(z, { zeit: t, position: oestlich(saeule, 50), stationen: [saeule] });
    if (e) ereignisse.push(e);
  }
  const e = akku.haltSchritt(z, { zeit: 170, position: oestlich(saeule, 500), stationen: [saeule] });
  if (e) ereignisse.push(e);
  assert.deepEqual(ereignisse, []);
});

test('planeStopps: ein unbekannter Umweg zaehlt nicht als null', () => {
  assert.ok(Math.abs(ladeplanung.geschaetzterUmweg({ distanceFromRouteMeters: 330 }) - 199.2) < 0.1);
  // Zwei Stationen an derselben Stelle, eine mit gerechnetem Umweg von einer
  // Minute, eine ungerechnet 800 m neben der Route.
  const stations = [
    { id: 'ungerechnet', progressMeters: 250_000, distanceFromRouteMeters: 800, detourSeconds: null, maxPowerKW: 300 },
    { id: 'gerechnet', progressMeters: 250_000, distanceFromRouteMeters: 300, detourSeconds: 60, maxPowerKW: 300 },
  ];
  const ergebnis = ladeplanung.planeStopps({ routeLengthMeters: 450_000, stations, fahrzeug: AUTO });
  assert.equal(ergebnis.stopps[0].station.id, 'gerechnet');
});

// ---------------------------------------------------------------- Quellen

test('auslandsStuecke: nur ausserhalb Deutschlands, mit Rand, Nachbarn zusammen', () => {
  // 30 km nach Osten, alle 100 m ein Punkt: 0-100 DEU, 101-200 NLD, 201-250 BEL, 251-300 DEU
  const punkte = geradeNachOsten(30);
  const stuecke = quellen.auslandsStuecke(punkte, [
    { von: 0, bis: 100, land: 'DEU' },
    { von: 101, bis: 200, land: 'NLD' },
    { von: 201, bis: 250, land: 'BEL' },
    { von: 251, bis: 300, land: 'DEU' },
  ]);
  assert.equal(stuecke.length, 1);
  // 2 km Rand auf jeder Seite: 20 Punkte davor, 20 dahinter.
  assert.equal(stuecke[0][0], punkte[81]);
  assert.equal(stuecke[0].at(-1), punkte[270]);
  // Ganz in Deutschland: nichts zu suchen.
  assert.deepEqual(quellen.auslandsStuecke(punkte, [{ von: 0, bis: 300, land: 'DEU' }]), []);
});

test('zusammenfuehren: TomTom-Treffer am Registerstandort faellt weg', () => {
  const register = [{ id: 'bnetza:1', lat: 51.0, lon: 6.0 }];
  const tomtom = [
    { id: 'tt:gleich', lat: 51.0005, lon: 6.0 },   // 55 m daneben
    { id: 'tt:fastned', lat: 52.3, lon: 4.9 },
  ];
  assert.deepEqual(quellen.zusammenfuehren(register, tomtom).map((s) => s.id), ['bnetza:1', 'tt:fastned']);
});

// ---------------------------------------------------------------- Abweichung

test('neuPlanen: eine Station 800 m entfernt haelt die Neuplanung nicht mehr auf', () => {
  const position = { lat: 51.25, lon: 6.75 };
  const station = oestlich(position, 800);
  // Der Fall der ersten iPhone-Fahrt: irgendeine Station in der Stadt.
  assert.equal(abweichung.neuPlanen({ abseits: 3, position, angezeigt: [station] }), true);
  // Auf dem Gelaende einer angezeigten Station: nicht.
  assert.equal(abweichung.neuPlanen({ abseits: 3, position, angezeigt: [oestlich(position, 200)] }), false);
  // Auf dem Weg zum geplanten Stopp oder zum Zwischenziel: nicht.
  assert.equal(abweichung.neuPlanen({ abseits: 3, position, geplant: [station] }), false);
  assert.equal(abweichung.neuPlanen({ abseits: 3, position, zwischenziel: oestlich(position, 1400) }), false);
});

test('neuPlanen: erst ab drei Positionen daneben und nicht oefter als alle 20 Sekunden', () => {
  const position = { lat: 51.25, lon: 6.75 };
  assert.equal(abweichung.neuPlanen({ abseits: 2, position }), false);
  assert.equal(abweichung.neuPlanen({ abseits: 3, position, sekundenSeit: 10 }), false);
  assert.equal(abweichung.neuPlanen({ abseits: 3, position, sekundenSeit: 25 }), true);
});

// ---------------------------------------------------------------- Ziele

test('kategorieFuer: Vorschlag aus den Kategorien der Suche', () => {
  assert.equal(ziele.kategorieFuer(['electric vehicle station']), 'laden');
  assert.equal(ziele.kategorieFuer(['supermarkets & hypermarkets']), 'einkaufen');
  assert.equal(ziele.kategorieFuer(['restaurant', 'italian']), 'essen');
  assert.equal(ziele.kategorieFuer(['café/pub']), 'essen');
  assert.equal(ziele.kategorieFuer(['hotel/motel']), 'sonstiges');
  // Eine Adresse ohne POI.
  assert.equal(ziele.kategorieFuer([]), 'sonstiges');
});

test('gespeichertBei: dasselbe Ziel innerhalb von 30 m', () => {
  const liste = [{ id: 'a', lat: 51.25, lon: 6.69 }];
  assert.equal(ziele.gespeichertBei(liste, oestlich(liste[0], 20), geo.distance)?.id, 'a');
  assert.equal(ziele.gespeichertBei(liste, oestlich(liste[0], 60), geo.distance), null);
});

test('schnellerNehmen: erst ab drei Minuten Gewinn, nicht auf den letzten 5 km', () => {
  assert.equal(abweichung.schnellerNehmen({ jetztSekunden: 3600, neuSekunden: 3400, restMeter: 100_000 }), true);
  assert.equal(abweichung.schnellerNehmen({ jetztSekunden: 3600, neuSekunden: 3480, restMeter: 100_000 }), false);
  assert.equal(abweichung.schnellerNehmen({ jetztSekunden: 900, neuSekunden: 500, restMeter: 4000 }), false);
  assert.equal(abweichung.schnellerNehmen({ jetztSekunden: NaN, neuSekunden: 500, restMeter: 50_000 }), false);
});
