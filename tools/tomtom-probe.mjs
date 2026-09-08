#!/usr/bin/env node
// tomtom-probe.mjs
// Fährt die komplette Datenkette einmal durch, ohne Xcode und ohne Simulator:
// Route planen, Ladestationen entlang der Strecke suchen, eigene Daten
// dazulegen, Live-Belegung abfragen.
//
//   node tomtom-probe.mjs --key=DEIN_KEY
//   node tomtom-probe.mjs --key=DEIN_KEY --fast --detour=20
//   node tomtom-probe.mjs --key=DEIN_KEY --diagnose
//   node tomtom-probe.mjs --key=DEIN_KEY --export-editorial=neu.json
//   node tomtom-probe.mjs --dry-run
//
// Statt --key=... kann TOMTOM_API_KEY gesetzt sein. Das ist der bessere Weg,
// weil der Schlüssel sonst in der Shell-History landet.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ev from './lib/evsearch.mjs';
import * as geo from './lib/geo.mjs';
import * as corridor from './lib/corridor.mjs';
import * as editorial from './lib/editorial.mjs';
import { resolveApiKey } from './lib/apikey.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Voreinstellung: Meerbusch nach Norddeich. Passt zu den Beispieldaten.
const DEFAULTS = {
  from: '51.2560,6.6890',
  to: '53.6148,7.1621',
  detour: '10',
  availability: '5',
  // Wie weit darf eine Station seitlich der Route liegen? Ohne diese Grenze
  // schleppt die Umkreissuche Innenstadt-Ladepunkte mit, fuer die niemand von
  // der Autobahn abfaehrt.
  // 270 Zeilen sind im Terminal unbrauchbar.
  show: '40',
};

// ------------------------------------------------------------- Argumente

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    args[key] = value ?? true;
  }
  return args;
}

function parseCoordinate(text, label) {
  const [lat, lon] = String(text).split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`${label} muss die Form lat,lon haben, war "${text}"`);
  }
  return { lat, lon };
}

// ------------------------------------------------------------ Ausgabe

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t) => wrap('1', t);
const dim = (t) => wrap('2', t);
const red = (t) => wrap('31', t);
const green = (t) => wrap('32', t);

function heading(text) {
  console.log(`\n${bold(text)}`);
  console.log(dim('-'.repeat(Math.max(text.length, 44))));
}

// ------------------------------------------------------------- Routing

/** Plant eine Route über die Routing-API und gibt die Geometrie zurück. */
async function planRoute(apiKey, from, to) {
  const url = new URL(
    `${ev.BASE_URL}/routing/1/calculateRoute/${from.lat},${from.lon}:${to.lat},${to.lon}/json`
  );
  url.searchParams.set('key', apiKey);
  url.searchParams.set('routeType', 'fastest');
  url.searchParams.set('traffic', 'true');
  url.searchParams.set('travelMode', 'car');

  const response = await ev.requestWithRetry(fetch, url, {});
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    // Schon die erste Anfrage scheitert, ein Tempolimit scheidet damit aus.
    const hint = {
      401: '\nDer Schluessel wird nicht akzeptiert. Pruefen: echo $TOMTOM_API_KEY,' +
        ' und im Dashboard, ob der Key noch existiert.',
      403: '\nDie Routing API ist fuer diesen Key nicht freigeschaltet.' +
        ' Im Dashboard unter Products nachtragen.',
      429: '\nTageskontingent aufgebraucht.',
    }[response.status] ?? '';
    throw new Error(`Routing antwortet mit ${response.status}: ${body}${hint}`);
  }

  const json = await response.json();
  const route = json.routes?.[0];
  if (!route) throw new Error('Routing liefert keine Route.');

  const points = (route.legs ?? []).flatMap((leg) =>
    (leg.points ?? []).map((p) => ({ lat: p.latitude, lon: p.longitude }))
  );

  return {
    points,
    lengthKm: route.summary.lengthInMeters / 1000,
    durationMin: route.summary.travelTimeInSeconds / 60,
  };
}

/** Eine einzelne Along-Route-Anfrage, mit Nachfassversuch bei Drosselung. */
async function searchSegment(apiKey, points, options) {
  const response = await ev.requestWithRetry(fetch, ev.buildAlongRouteURL(apiKey, options), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ev.buildRouteBody(points)),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 160);
    const error = new Error(`HTTP ${response.status}: ${body}`);
    error.wasThrottledTwice = response.wasThrottledTwice === true;
    throw error;
  }
  const json = await response.json();
  return {
    raw: ev.parseAlongRouteResponse(json, { onlyEVStations: false }),
    stations: ev.parseAlongRouteResponse(json, options),
  };
}

// ------------------------------------------------------------ Diagnose

// Der Suchbegriff steht bei searchAlongRoute im Pfad und ist Pflicht. Ob er als
// Freitext über POI-Namen läuft oder als Kategorie aufgelöst wird, entscheidet
// über Erfolg und Misserfolg der ganzen Suche. Diese Varianten klären das mit
// wenigen Anfragen auf einem einzigen Routenabschnitt.
const VARIANTS = [
  { label: 'electric vehicle station, ohne Kategorie', query: 'electric vehicle station', useCategoryFilter: false },
  { label: 'electric vehicle station + categorySet 7309', query: 'electric vehicle station', useCategoryFilter: true, categoryId: '7309' },
  { label: 'Ladestation, ohne Kategorie', query: 'Ladestation', useCategoryFilter: false },
  { label: 'charging, ohne Kategorie', query: 'charging', useCategoryFilter: false },
  { label: 'ev charging station, ohne Kategorie', query: 'ev charging station', useCategoryFilter: false },
  {
    label: 'electric vehicle station, ohne spreadingMode',
    query: 'electric vehicle station',
    useCategoryFilter: false,
    spreadResults: false,
  },
  { label: 'petrol station, ohne Kategorie (Gegenprobe)', query: 'petrol station', useCategoryFilter: false },
];

/**
 * Prueft, ob der Server den minPowerKW-Filter tatsaechlich anwendet.
 *
 * Nach dem Befund zu categorySet, das Ergebnisse stillschweigend geloescht hat,
 * wird kein Filterparameter mehr ungeprueft geglaubt. Drei Anfragen auf
 * demselben Abschnitt genuegen fuer eine belastbare Aussage.
 */
async function diagnosePowerFilter(apiKey, points, baseOptions) {
  heading('Greift der Leistungsfilter serverseitig?');

  const stufen = [
    { label: 'ohne Filter', minPowerKW: 0 },
    { label: 'ab 50 kW', minPowerKW: ev.POWER_TIERS.schnell },
    { label: 'ab 150 kW', minPowerKW: ev.POWER_TIERS.hpc },
  ];

  const ergebnisse = [];
  for (const [index, stufe] of stufen.entries()) {
    if (index > 0) await ev.sleep(ev.MIN_REQUEST_INTERVAL_MS * 4);

    // Ohne lokale Nachfilterung, sonst pruefen wir unseren eigenen Code.
    const options = {
      ...baseOptions,
      minPowerKW: stufe.minPowerKW,
      enforceMinPowerLocally: false,
      onlyEVStations: false,
    };
    try {
      const { raw } = await searchSegment(apiKey, points, options);
      const powers = raw.map(ev.maxPowerKW).filter((p) => p != null);
      const unterGrenze = powers.filter((p) => stufe.minPowerKW && p < stufe.minPowerKW);
      ergebnisse.push({ stufe, count: raw.length, powers, unterGrenze });

      console.log(`${String(raw.length).padStart(3)} Treffer  ${bold(stufe.label)}`);
      if (powers.length > 0) {
        console.log(dim(`      Leistung ${Math.min(...powers)} bis ${Math.max(...powers)} kW`));
      }
      if (unterGrenze.length > 0) {
        console.log(
          red(`      ${unterGrenze.length} Treffer unter der Grenze: ${unterGrenze.join(', ')} kW`)
        );
      }
    } catch (error) {
      ergebnisse.push({ stufe, count: 0, error: error.message });
      console.log(`${red('!!')}          ${bold(stufe.label)}`);
      console.log(dim(`      ${error.message}`));
    }
  }

  const [ohne, ab50] = ergebnisse;
  console.log('');
  if (ohne?.error || ab50?.error) {
    console.log(dim('Nicht auswertbar, eine der Anfragen scheiterte.'));
  } else if (ohne.count > 0 && ab50.count === 0) {
    console.log(
      red('minPowerKW loescht das Ergebnis, genau wie categorySet.') +
        ' Der Parameter gehoert raus, gefiltert wird dann nur lokal.'
    );
  } else if (ab50.unterGrenze.length > 0) {
    console.log(
      red('Der Server ignoriert minPowerKW') +
        ', es kommen Saeulen unter der Grenze durch. Die lokale Pruefung faengt das ab.'
    );
  } else {
    console.log(green('minPowerKW arbeitet korrekt.') + ' Der Filter darf serverseitig bleiben.');
    console.log(
      dim('Das ist wertvoll: langsame Saeulen belegen dann keine der 20 Antwortplaetze.')
    );
  }
}

async function diagnose(apiKey, route, baseOptions) {
  const segments = geo.splitIntoSegments(route.points, 100000);
  // Ein Abschnitt aus der Mitte: dort liegt echte Autobahn, nicht Stadtrand.
  const segment = segments[Math.floor(segments.length / 2)] ?? segments[0];
  const points = geo.downsample(segment, ev.DEFAULT_OPTIONS.maxRoutePointsPerRequest);

  heading('Diagnose: welcher Suchbegriff trifft die Kategorie?');
  console.log(
    dim(
      `ein Abschnitt von ${(geo.pathLength(segment) / 1000).toFixed(0)} km, ` +
        `${points.length} Stuetzpunkte, je eine Anfrage pro Variante`
    )
  );
  console.log('');

  const findings = [];
  for (const [index, variant] of VARIANTS.entries()) {
    // Ohne Pause laufen die Varianten in dieselbe Sekunde und TomTom drosselt.
    // Die Drosselung meldet sich als HTTP 401, was wie ein kaputter Key aussieht.
    if (index > 0) await ev.sleep(ev.MIN_REQUEST_INTERVAL_MS * 4);

    const options = { ...baseOptions, ...variant };
    try {
      const { raw, stations } = await searchSegment(apiKey, points, options);
      const powers = stations.map(ev.maxPowerKW).filter((p) => p != null);
      findings.push({ variant, count: stations.length, rawCount: raw.length, stations });

      const marker = stations.length >= 10 ? green('OK ') : stations.length > 0 ? '   ' : red('-- ');
      const verworfen = raw.length - stations.length;
      console.log(
        `${marker}${String(stations.length).padStart(2)} Ladestationen  ${bold(variant.label)}`
      );
      console.log(
        dim(`      ${raw.length} Treffer roh, davon ${verworfen} ohne Ladeinfrastruktur verworfen`)
      );
      if (stations.length > 0) {
        console.log(dim(`      ${stations.slice(0, 3).map((s) => s.name).join(' | ')}`));
        if (powers.length > 0) {
          console.log(
            dim(`      Leistung ${Math.min(...powers)} bis ${Math.max(...powers)} kW`)
          );
        }
      }
    } catch (error) {
      findings.push({ variant, count: 0, error: error.message, throttled: error.wasThrottledTwice });
      console.log(`${red('!! ')}          ${bold(variant.label)}`);
      console.log(dim(`      ${error.message}`));
      if (!error.wasThrottledTwice) {
        console.log(dim('      (der Nachfassversuch half, es war also das Tempolimit)'));
      }
    }
  }

  const best = findings.filter((f) => !f.error).sort((a, b) => b.count - a.count)[0];
  heading('Empfehlung');
  const hardFailures = findings.filter((f) => f.throttled).length;
  if (hardFailures > 0) {
    console.log(
      red(`${hardFailures} Variante(n) scheiterten auch im zweiten Anlauf.`) +
        ' Das ist dann kein Tempolimit mehr:'
    );
    console.log(dim('  401 -> Key ungueltig oder Search API nicht freigeschaltet'));
    console.log(dim('  403 -> Produkt fehlt in der Key-Konfiguration'));
    console.log(dim('  429 -> Tageskontingent aufgebraucht'));
  }
  if (!best || best.count === 0) {
    console.log(red('Keine Variante liefert Treffer.'));
    if (hardFailures === 0) {
      console.log(dim('Die Anfragen kamen durch, nur passt kein Suchbegriff. Mit --query=... weiter probieren.'));
    }
    return;
  }
  console.log(`Beste Variante: ${bold(best.variant.label)} mit ${best.count} Ladestationen.`);
  console.log(
    dim(
      `In lib/evsearch.mjs DEFAULT_OPTIONS setzen: query = "${best.variant.query}", ` +
        `useCategoryFilter = ${best.variant.useCategoryFilter}`
    )
  );
  if (best.rawCount >= 20) {
    console.log(
      dim(
        'Der Abschnitt stoesst ans 20-Treffer-Limit der API, es bleiben also Stationen\n' +
          'unsichtbar. Kuerzere Abschnitte helfen: --segment=25'
      )
    );
  }

  await ev.sleep(ev.MIN_REQUEST_INTERVAL_MS * 4);
  await diagnosePowerFilter(apiKey, points, { ...baseOptions, ...best.variant });

  const gegenprobe = findings.find((f) => f.variant.query === 'petrol station');
  if (gegenprobe && !gegenprobe.error) {
    const verworfen = gegenprobe.rawCount - gegenprobe.count;
    console.log(
      dim(
        `\nGegenprobe "petrol station": ${gegenprobe.rawCount} Treffer roh, ` +
          `${verworfen} davon als Nicht-Ladestation verworfen, ${gegenprobe.count} blieben uebrig.`
      )
    );
    console.log(
      dim(
        gegenprobe.count === 0
          ? 'Der Filter an den Daten greift also sauber.'
          : 'Die uebrigen sind Tankstellen MIT Ladepark, das ist korrekt so.'
      )
    );
  }
}

// ------------------------------------------------- Redaktionsdaten erzeugen

/**
 * Schreibt aus echten Suchtreffern einen Startbestand fuer die eigenen Daten.
 *
 * Die mitgelieferten Beispieldaten haben erfundene Koordinaten und treffen
 * deshalb keine echten POIs. Wer das Matching sehen will, braucht Eintraege an
 * den Stellen, an denen TomTom tatsaechlich Stationen kennt.
 */
function exportEditorial(stations, targetPath) {
  const entries = stations.map((station, index) => ({
    id: `ed-${String(index + 1).padStart(3, '0')}`,
    tomtomPoiID: station.id,
    name: station.name,
    operatorName: station.operatorName,
    latitude: station.lat,
    longitude: station.lon,
    rating: null,
    verdict: 'NOCH NICHT GETESTET. Urteil hier eintragen.',
    testedAt: null,
    pricePerKWh: null,
    tags: [],
    author: 'Electric Drive',
  }));

  writeFileSync(targetPath, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  return entries.length;
}

// ------------------------------------------------------------- Hauptlauf

async function main() {
  const args = parseArgs(process.argv);
  const from = parseCoordinate(args.from, '--from');
  const to = parseCoordinate(args.to, '--to');

  const options = {
    maxDetourSeconds: Number(args.detour) * 60,
    // Nur setzen, wenn ausdrücklich angegeben. Sonst gilt die Vorgabe der
    // Bibliothek, und die hat einen Grund: Ein 100-km-Abschnitt lief im Test
    // ins 20-Treffer-Limit der Antwort, es blieben also Stationen unsichtbar.
    ...(args.segment ? { segmentLengthMeters: Number(args.segment) * 1000 } : {}),
    ...(args.query ? { query: args.query } : {}),
    ...(args.category ? { useCategoryFilter: true, categoryId: String(args.category) } : {}),
    ...(args.all ? { onlyEVStations: false } : {}),
    // --power=0 schaltet den Filter ab, --power=150 verlangt HPC.
    ...(args.power !== undefined ? { minPowerKW: Number(args.power) } : {}),
    ...(args.fast ? { minPowerKW: ev.POWER_TIERS.hpc } : {}),
  };

  if (args['dry-run']) {
    heading('Trockenlauf, es geht keine Anfrage raus');
    console.log('Suche-URL:');
    console.log('  ' + ev.buildAlongRouteURL('DEIN_KEY', options));
    console.log('\nBody-Beispiel (hier gekuerzt auf zwei Punkte):');
    console.log(JSON.stringify(ev.buildRouteBody([from, to]), null, 2));
    return;
  }

  const apiKey = await resolveApiKey({
    argumentKey: args.key,
    onNotice: (text) => console.error(dim(text)),
    onFatal: (text) => console.error(red(text)),
  });
  if (!apiKey) process.exit(1);

  // 1. Route
  heading('1. Route planen');
  const route = await planRoute(apiKey, from, to);
  console.log(
    `${route.lengthKm.toFixed(0)} km, ${Math.round(route.durationMin)} min, ` +
      `${route.points.length} Stuetzpunkte in der Geometrie`
  );

  if (args.diagnose) {
    await diagnose(apiKey, route, options);
    return;
  }

  const segmentLength = options.segmentLengthMeters ?? ev.DEFAULT_OPTIONS.segmentLengthMeters;
  const segments = geo.splitIntoSegments(route.points, segmentLength);
  console.log(
    dim(
      `wird fuer die Suche in ${segments.length} Abschnitt(e) zu je ${segmentLength / 1000} km ` +
        'zerlegt, weil eine Antwort hoechstens 20 Treffer enthaelt'
    )
  );

  // 2. Ladestationen
  heading('2. Ladestationen entlang der Strecke');
  console.log(dim(`Suchbegriff "${options.query ?? ev.DEFAULT_OPTIONS.query}"`));
  const started = Date.now();
  const result = await ev.searchAlongRoute(apiKey, route.points, options);
  let stationen = result.stations;
  let anfragen = result.requests.length;
  console.log(
    dim(`Along-Route: ${stationen.length} Stationen aus ${anfragen} Anfragen`)
  );

  // Zweite Runde, sofern nicht abgeschaltet. Am 08.09.2026 gegen das amtliche
  // Register gemessen: Die Along-Route-Suche allein findet 51 Prozent der
  // Standorte im Zwei-Kilometer-Korridor, mit den Umkreissuchen 93 Prozent.
  // Jenseits von einem Kilometer neben der Route findet sie ohne sie nichts.
  if (!args['no-wide']) {
    const umkreis = await ev.searchAroundRoute(apiKey, route.points, options);
    const bekannt = new Set(stationen.map((s) => s.id));
    const neue = umkreis.stations.filter((s) => !bekannt.has(s.id));

    stationen = [...stationen, ...neue];
    anfragen += umkreis.requestCount;
    console.log(
      dim(
        `Umkreise:    ${neue.length} weitere aus ${umkreis.requestCount} Anfragen ` +
          `(${umkreis.coveredCorridorMeters.toFixed(0)} m Korridor)`
      )
    );
    if (umkreis.truncated.length > 0) {
      console.log(
        red(`${umkreis.truncated.length} Umkreise stießen ans Antwortlimit.`) +
          dim(' Dort fehlt vermutlich etwas, --no-wide oder engere Abtastung prüfen.')
      );
    }
  } else {
    console.log(dim('--no-wide: nur Along-Route, wie in der TomTom-Pro-App'));
  }

  // Auf die Route projizieren: Lage entlang der Strecke und seitlicher
  // Abstand. Die Umkreissuche liefert keinen Umweg mit, ohne das stuenden ihre
  // Treffer ohne jede Ortsangabe in der Liste und liessen sich nicht sortieren.
  const vorFilter = stationen.length;
  stationen = corridor.orderAlongRoute(stationen, route.points, Number(args.corridor) * 1000);
  const verworfen = vorFilter - stationen.length;

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `${bold(String(stationen.length))} Stationen aus ${anfragen} Anfragen in ${seconds} s`
  );
  if (verworfen > 0) {
    console.log(
      dim(`${verworfen} weitere lagen mehr als ${args.corridor} km neben der Route und fielen raus`)
    );
  }
  const grenze = options.minPowerKW ?? ev.DEFAULT_OPTIONS.minPowerKW;
  console.log(
    dim(grenze ? `Leistungsfilter: ab ${grenze} kW` : 'Leistungsfilter aus, alle Saeulen')
  );

  if (stationen.length < segments.length * 3) {
    console.log(
      dim('Auffaellig wenige Treffer. --diagnose zeigt, welcher Suchbegriff besser trifft.')
    );
  }

  // 3. Eigene Daten
  heading('3. Eigene Daten zuordnen');
  const entries = JSON.parse(
    readFileSync(join(here, '..', 'LadeRoute', 'Resources', 'editorial-stations.json'), 'utf8')
  );
  const annotated = editorial.annotate(stationen, entries);
  const matched = annotated.filter((a) => a.editorial);
  console.log(
    `${matched.length} von ${annotated.length} Stationen haben einen Redaktionseintrag ` +
      `(Bestand: ${entries.length} Eintraege)`
  );
  if (matched.length === 0 && entries.length > 0) {
    console.log(
      dim(
        'Die mitgelieferten Beispieldaten haben erfundene Koordinaten und treffen deshalb\n' +
          'keine echten POIs. --export-editorial=datei.json schreibt einen Startbestand\n' +
          'aus den echten Treffern, den man dann redaktionell fuellt.'
      )
    );
  }

  // 4. Live-Belegung fuer die ersten N
  const availabilityCount = Number(args.availability);
  if (availabilityCount > 0) {
    heading(`4. Live-Belegung der ersten ${availabilityCount}`);
    for (const item of annotated.slice(0, availabilityCount)) {
      if (!item.station.availabilityID) {
        console.log(`${item.station.name}: ${dim('keine Live-Anbindung')}`);
        continue;
      }
      try {
        const response = await fetch(ev.buildAvailabilityURL(apiKey, item.station.availabilityID));
        if (!response.ok) {
          console.log(`${item.station.name}: ${red('HTTP ' + response.status)}`);
          continue;
        }
        const a = ev.parseAvailability(await response.json());
        item.availability = a;
        console.log(`${item.station.name}: ${green(a.available + ' frei')} von ${a.total}`);
      } catch (error) {
        console.log(`${item.station.name}: ${red(error.message)}`);
      }
    }
  }

  // 5. Ergebnis
  const zeige = Number(args.show);
  const sichtbar = args['all-results'] ? annotated : annotated.slice(0, zeige);
  heading(`5. Ergebnis, in Fahrtrichtung sortiert${
    sichtbar.length < annotated.length ? ` (erste ${sichtbar.length} von ${annotated.length})` : ''
  }`);

  sichtbar.forEach((item, index) => {
    const s = item.station;
    const power = ev.maxPowerKW(s);
    const parts = [
      power ? `${power.toFixed(0)} kW` : 'kW unbekannt',
      // Seitlicher Abstand gilt fuer alle Treffer, der Umweg nur fuer die aus
      // der Along-Route-Suche.
      `${Math.round(s.distanceFromRouteMeters)} m ab Route`,
      s.detourSeconds != null ? `+${Math.round(s.detourSeconds / 60)} min Umweg` : null,
      item.availability ? `${item.availability.available}/${item.availability.total} frei` : null,
    ].filter(Boolean);

    const km = String(Math.round(s.progressMeters / 1000)).padStart(3);
    const marker = item.editorial ? red('*') : dim('.');
    console.log(`${marker} km ${km}  ${bold(s.name)}`);
    console.log(`         ${dim(parts.join(' | '))}`);
    if (s.address) console.log(`         ${dim(s.address)}`);
    if (item.editorial) {
      const e = item.editorial;
      console.log(`         ${red('eigener Test:')} Note ${e.rating} - ${e.verdict.slice(0, 80)}...`);
    }
  });

  if (sichtbar.length < annotated.length) {
    console.log(dim(`\n... und ${annotated.length - sichtbar.length} weitere. --all-results zeigt alle.`));
  }

  // 6. Optional: Startbestand schreiben
  if (args['export-editorial']) {
    const target = resolve(String(args['export-editorial']));
    const count = exportEditorial(stationen, target);
    heading('6. Startbestand geschrieben');
    console.log(`${count} Eintraege nach ${target}`);
    console.log(
      dim('Die POI-IDs sind eingetragen, damit spaeter ohne Heuristik zugeordnet wird.')
    );
  }

  const used = 1 + anfragen + Math.min(availabilityCount, annotated.length);
  console.log(`\n${dim('Legende:')} ${red('*')} mit eigenem Test   ${dim('. nur TomTom-Daten')}`);
  console.log(dim(`Verbrauch: ${used} Non-Tile-Anfragen (Freemium: 2.500 pro Tag)`));
}

main().catch((error) => {
  console.error(red(`\nAbbruch: ${error.message}`));
  process.exit(1);
});
