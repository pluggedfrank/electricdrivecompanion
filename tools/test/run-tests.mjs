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
