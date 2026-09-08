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
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import * as ev from './lib/evsearch.mjs';
import * as geo from './lib/geo.mjs';
import * as editorial from './lib/editorial.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Voreinstellung: Meerbusch nach Norddeich. Passt zu den Beispieldaten.
const DEFAULTS = {
  from: '51.2560,6.6890',
  to: '53.6148,7.1621',
  detour: '10',
  availability: '5',
  segment: '100',
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

// Platzhalter, die in Anleitungen stehen und versehentlich mitkopiert werden.
const PLACEHOLDER_KEYS = new Set([
  'IHR_KEY', 'DEIN_KEY', 'NEUER_KEY', 'MEIN_KEY',
  'YOUR_API_KEY', 'YOUR_KEY', 'DEIN_API_KEY', 'API_KEY', 'KEY',
]);

/**
 * Prueft den Schluessel, bevor die erste Anfrage rausgeht.
 *
 * Ein Platzhalter ist nicht leer, kommt also durch jede Vorhandensein-Pruefung
 * und produziert dann ein 401, das nach einem kaputten Key aussieht. Ein
 * echter TomTom-Key besteht aus 32 alphanumerischen Zeichen.
 */
function checkApiKey(key) {
  if (PLACEHOLDER_KEYS.has(key.trim().toUpperCase())) {
    return {
      fatal: true,
      message:
        `"${key}" ist ein Platzhalter aus der Anleitung, kein Schluessel.\n` +
        'Den echten Key eintragen: export TOMTOM_API_KEY=<32 Zeichen aus dem Dashboard>',
    };
  }
  if (!/^[A-Za-z0-9]{20,}$/.test(key.trim())) {
    return {
      fatal: false,
      message:
        `Der Schluessel sieht ungewoehnlich aus (${key.trim().length} Zeichen). ` +
        'Ein TomTom-Key hat 32 alphanumerische Zeichen.',
    };
  }
  return null;
}

/**
 * Fragt den Schluessel im Terminal ab, ohne ihn anzuzeigen.
 *
 * Das raeumt zwei wiederkehrende Fehlerquellen ab: ein export gilt nur fuer das
 * eine Terminalfenster und ist im naechsten wieder weg, und ein Schluessel auf
 * der Kommandozeile landet in der Shell-History.
 *
 * Der Raw-Mode schaltet das Echo des Terminals ab, die getippten Zeichen werden
 * bewusst nirgends ausgegeben. Ohne Raw-Mode spiegelt das Terminal die Eingabe
 * selbst zurueck, dann steht der Schluessel doch wieder sichtbar da.
 *
 * Gibt null zurueck, wenn keine Eingabe moeglich ist, etwa in einer Pipeline.
 */
function promptForKey() {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return Promise.resolve(null);

  stdout.write('TomTom-Key (Eingabe bleibt unsichtbar): ');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve) => {
    let buffer = '';

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        switch (character) {
          case '\r':
          case '\n':
          case '\u0004': // Ctrl+D
            cleanup();
            resolve(buffer.trim() || null);
            return;
          case '\u0003': // Ctrl+C
            cleanup();
            process.exit(130);
            return;
          case '\u007f': // Backspace
          case '\b':
            buffer = buffer.slice(0, -1);
            break;
          default:
            // Steuerzeichen ignorieren, alles andere sammeln.
            if (character >= ' ') buffer += character;
        }
      }
    };

    stdin.on('data', onData);
  });
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
  const entries = stations.slice(0, 12).map((station, index) => ({
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
    segmentLengthMeters: Number(args.segment) * 1000,
    ...(args.query ? { query: args.query } : {}),
    ...(args.category ? { useCategoryFilter: true, categoryId: String(args.category) } : {}),
    ...(args.all ? { onlyEVStations: false } : {}),
    ...(args.fast
      ? { minPowerKW: 100, connectorTypes: ['IEC62196Type2CCS', 'Chademo', 'Tesla'] }
      : {}),
  };

  if (args['dry-run']) {
    heading('Trockenlauf, es geht keine Anfrage raus');
    console.log('Suche-URL:');
    console.log('  ' + ev.buildAlongRouteURL('DEIN_KEY', options));
    console.log('\nBody-Beispiel (hier gekuerzt auf zwei Punkte):');
    console.log(JSON.stringify(ev.buildRouteBody([from, to]), null, 2));
    return;
  }

  const apiKey = args.key || process.env.TOMTOM_API_KEY || (await promptForKey());
  if (!apiKey) {
    console.error(red('Kein Key.'));
    console.error(dim('Entweder hier eingeben, --key=... setzen oder TOMTOM_API_KEY exportieren.'));
    console.error(dim('Key anlegen: https://developer.tomtom.com/ -> Dashboard -> API Keys'));
    process.exit(1);
  }

  const keyProblem = checkApiKey(apiKey);
  if (keyProblem?.fatal) {
    console.error(red(keyProblem.message));
    process.exit(1);
  }
  if (keyProblem) console.error(dim(keyProblem.message + '\n'));

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

  const segments = geo.splitIntoSegments(route.points, options.segmentLengthMeters);
  console.log(
    dim(
      `wird fuer die Suche in ${segments.length} Abschnitt(e) zu je ${args.segment} km zerlegt, ` +
        'weil eine Antwort hoechstens 20 Treffer enthaelt'
    )
  );

  // 2. Ladestationen
  heading('2. Ladestationen entlang der Strecke');
  console.log(dim(`Suchbegriff "${options.query ?? ev.DEFAULT_OPTIONS.query}"`));
  const started = Date.now();
  const result = await ev.searchAlongRoute(apiKey, route.points, options);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `${result.stations.length} Stationen aus ${result.requests.length} Anfragen in ${seconds} s`
  );
  if (args.fast) console.log(dim('Filter aktiv: ab 100 kW, nur DC-Stecker'));

  if (result.stations.length < segments.length * 3) {
    console.log(
      dim('Auffaellig wenige Treffer. --diagnose zeigt, welcher Suchbegriff besser trifft.')
    );
  }

  // 3. Eigene Daten
  heading('3. Eigene Daten zuordnen');
  const entries = JSON.parse(
    readFileSync(join(here, '..', 'LadeRoute', 'Resources', 'editorial-stations.json'), 'utf8')
  );
  const annotated = editorial.annotate(result.stations, entries);
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
  heading('5. Ergebnis');
  annotated.forEach((item, index) => {
    const s = item.station;
    const power = ev.maxPowerKW(s);
    const parts = [
      power ? `${power.toFixed(0)} kW` : 'kW unbekannt',
      s.detourSeconds != null ? `+${Math.round(s.detourSeconds / 60)} min Umweg` : null,
      item.availability ? `${item.availability.available}/${item.availability.total} frei` : null,
    ].filter(Boolean);

    const marker = item.editorial ? red('*') : dim('.');
    console.log(`${marker} ${String(index + 1).padStart(3)}. ${bold(s.name)}`);
    console.log(`      ${dim(parts.join(' | '))}`);
    if (s.address) console.log(`      ${dim(s.address)}`);
    if (item.editorial) {
      const e = item.editorial;
      console.log(`      ${red('eigener Test:')} Note ${e.rating} - ${e.verdict.slice(0, 90)}...`);
    }
  });

  // 6. Optional: Startbestand schreiben
  if (args['export-editorial']) {
    const target = resolve(String(args['export-editorial']));
    const count = exportEditorial(result.stations, target);
    heading('6. Startbestand geschrieben');
    console.log(`${count} Eintraege nach ${target}`);
    console.log(
      dim('Die POI-IDs sind eingetragen, damit spaeter ohne Heuristik zugeordnet wird.')
    );
  }

  const used = 1 + result.requests.length + Math.min(availabilityCount, annotated.length);
  console.log(`\n${dim('Legende:')} ${red('*')} mit eigenem Test   ${dim('. nur TomTom-Daten')}`);
  console.log(dim(`Verbrauch: ${used} Non-Tile-Anfragen (Freemium: 2.500 pro Tag)`));
}

main().catch((error) => {
  console.error(red(`\nAbbruch: ${error.message}`));
  process.exit(1);
});
