#!/usr/bin/env node
// coverage-check.mjs
// Misst, wie vollständig die TomTom-Suche entlang einer Route ist.
//
// Maßstab ist das Ladesäulenregister der Bundesnetzagentur. Der Betrieb einer
// öffentlich zugänglichen Ladeeinrichtung ist meldepflichtig, das Register ist
// damit der einzige Datensatz, gegen den sich "vollständig" seriös messen
// lässt. Lizenz CC BY 4.0, Namensnennung "Bundesnetzagentur.de".
//
// Die Liste einmal herunterladen (rund 51 MB, CSV):
//   https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/
//   E-Mobilitaet/Ladesaeulenkarte/start.html
//
//   node coverage-check.mjs --register=~/Downloads/Ladesaeulenregister.csv
//   node coverage-check.mjs --register=... --corridor=3 --power=150
//   node coverage-check.mjs --register=... --parse-only
//
// Wichtig für die Auswertung: Ein fehlender Eintrag heißt nicht automatisch,
// dass TomTom die Station nicht kennt. Die Along-Route-Suche hat eine
// Umwegschwelle und eine Obergrenze von 20 Treffern pro Antwort. Deshalb läuft
// die Messung zweimal, einmal mit den Vorgabewerten und einmal betont
// großzügig. Die Differenz trennt Datenlücke von Suchmechanik.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import * as ev from './lib/evsearch.mjs';
import * as geo from './lib/geo.mjs';
import * as bnetza from './lib/bnetza.mjs';
import * as corridor from './lib/corridor.mjs';
import * as sites from './lib/sites.mjs';
import { resolveApiKey } from './lib/apikey.mjs';

// Ohne --register wird im Download-Ordner gesucht. Ein Dateiname, den man
// abtippen muss, ist eine Fehlerquelle ohne Gegenwert.
const DEFAULT_SEARCH_DIR = '~/Downloads';

const DEFAULTS = {
  from: '51.2560,6.6890',
  to: '53.6148,7.1621',
  corridor: '2',
  power: '50',
  examples: '12',
};

// ------------------------------------------------------------ Ausgabe

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t) => wrap('1', t);
const dim = (t) => wrap('2', t);
const red = (t) => wrap('31', t);
const green = (t) => wrap('32', t);
const amber = (t) => wrap('33', t);

function heading(text) {
  console.log(`\n${bold(text)}`);
  console.log(dim('-'.repeat(Math.max(text.length, 52))));
}

/** Balken für einen Anteil, damit die Zahl auf einen Blick einzuordnen ist. */
function bar(share, width = 28) {
  const filled = Math.round(Math.max(0, Math.min(1, share)) * width);
  return '#'.repeat(filled) + dim('.'.repeat(width - filled));
}

function percent(part, whole) {
  return whole === 0 ? 0 : (part / whole) * 100;
}

function colorForShare(share) {
  if (share >= 0.85) return green;
  if (share >= 0.6) return amber;
  return red;
}

// ------------------------------------------------------------ Argumente

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

/**
 * Sucht im Verzeichnis nach Dateien, die das Register sein könnten.
 *
 * Der Download heißt je nach Browser und Ausgabe unterschiedlich, mal mit
 * Datum, mal mit Umlaut, mal als Excel. Raten muss deshalb das Werkzeug.
 */
function findRegisterCandidates(directory) {
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }

  return names
    .filter((name) => /lade|s[äa]ul|charg/i.test(name) && /\.(csv|xlsx?)$/i.test(name))
    .map((name) => {
      const path = join(directory, name);
      try {
        return { path, sizeMB: (statSync(path).size / 1024 / 1024).toFixed(1) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.sizeMB) - Number(a.sizeMB))
    .slice(0, 5);
}

const DOWNLOAD_HINT =
  'Ladesaeulenliste als CSV holen (rund 51 MB, CC BY 4.0):\n' +
  '  https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/' +
  'E-Mobilitaet/Ladesaeulenkarte/start.html';

/**
 * Findet die Registerdatei.
 *
 * Angegeben werden darf eine Datei, ein Verzeichnis oder gar nichts. Ohne
 * Angabe wird im Download-Ordner gesucht. Ein Dateiname, den man abtippen
 * muss, ist eine Fehlerquelle ohne Gegenwert: Der Download heisst je nach
 * Browser und Ausgabe anders.
 */
function resolveRegisterPath(argument) {
  const given = expandPath(argument ?? DEFAULT_SEARCH_DIR);

  const isDirectory = existsSync(given) && statSync(given).isDirectory();
  if (!isDirectory) return given;

  const kandidaten = findRegisterCandidates(given).filter((k) => /\.csv$/i.test(k.path));
  if (kandidaten.length === 0) {
    console.error(red(`In ${given} liegt keine Registerdatei.`));
    console.error(dim(DOWNLOAD_HINT));
    console.error(dim('Danach ohne Argument starten, die Datei wird dann gefunden.'));
    process.exit(1);
  }

  // Die groesste passende CSV. Das Register ist mit Abstand die dickste Datei,
  // die auf das Namensmuster passt.
  const gewaehlt = kandidaten[0];
  console.log(dim(`Registerdatei gefunden: ${gewaehlt.path} (${gewaehlt.sizeMB} MB)`));
  if (kandidaten.length > 1) {
    console.log(dim(`${kandidaten.length - 1} weitere Kandidaten ignoriert, groesste gewaehlt.`));
  }
  return gewaehlt.path;
}

/** Macht ~ am Anfang eines Pfades auf. */
function expandPath(path) {
  const text = String(path);
  return resolve(text.startsWith('~') ? text.replace(/^~/, homedir()) : text);
}

// ------------------------------------------------------------- Routing

async function planRoute(apiKey, from, to) {
  const url = new URL(
    `${ev.BASE_URL}/routing/1/calculateRoute/${from.lat},${from.lon}:${to.lat},${to.lon}/json`
  );
  url.searchParams.set('key', apiKey);
  url.searchParams.set('routeType', 'fastest');
  url.searchParams.set('travelMode', 'car');

  const response = await ev.requestWithRetry(fetch, url, {});
  if (!response.ok) {
    throw new Error(`Routing antwortet mit ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const route = (await response.json()).routes?.[0];
  if (!route) throw new Error('Routing liefert keine Route.');

  return {
    points: (route.legs ?? []).flatMap((leg) =>
      (leg.points ?? []).map((p) => ({ lat: p.latitude, lon: p.longitude }))
    ),
    lengthKm: route.summary.lengthInMeters / 1000,
  };
}

// ---------------------------------------------------------- Hauptlauf

async function main() {
  const args = parseArgs(process.argv);

  const registerPath = resolveRegisterPath(args.register);
  if (!existsSync(registerPath)) {
    console.error(red(`Datei nicht gefunden: ${registerPath}`));

    // Der Download heisst je nach Browser und Ausgabe anders. Statt den Nutzer
    // raten zu lassen, im selben Verzeichnis nach Kandidaten sehen.
    const kandidaten = findRegisterCandidates(dirname(registerPath));
    if (kandidaten.length > 0) {
      console.error(dim('\nIm selben Verzeichnis liegen diese möglichen Dateien:'));
      for (const kandidat of kandidaten) {
        const hinweis = /\.xlsx?$/i.test(kandidat.path) ? '  [Excel, nicht lesbar]' : '';
        console.error(dim(`  --register=${kandidat.path}   (${kandidat.sizeMB} MB)${hinweis}`));
      }
    } else {
      console.error(dim('\n' + DOWNLOAD_HINT));
    }
    process.exit(1);
  }

  if (/\.xlsx?$/i.test(registerPath)) {
    console.error(red('Das ist die Excel-Fassung. Dieses Werkzeug liest nur CSV.'));
    console.error(
      dim('Die Bundesnetzagentur bietet beides an, auf der Ladesaeulenkarte-Seite die CSV waehlen.')
    );
    process.exit(1);
  }

  // 1. Register lesen
  heading('1. Ladesäulenregister lesen');
  const started = Date.now();
  const register = bnetza.loadRegister(registerPath);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(
    `${register.entries.length.toLocaleString('de-DE')} Einträge aus ` +
      `${register.rowCount.toLocaleString('de-DE')} Datensätzen, in ${seconds} s`
  );
  if (register.multiLineFields > 0) {
    // Beleg dafuer, dass zeichenweises Lesen noetig ist: Das Register fuehrt
    // den Public Key fuers Eichrecht als mehrzeiligen Block im Feld.
    console.log(
      dim(
        `${register.multiLineFields.toLocaleString('de-DE')} Datensätze enthalten ein Feld ` +
          'mit Zeilenumbruch (Public Key fürs Eichrecht).'
      )
    );
  }
  // Die Spaltenzuordnung wird immer ausgegeben. Eine stille Fehlzuordnung
  // waere schlimmer als ein Abbruch, und die Spaltennamen aendern sich.
  console.log(dim(`Kopfzeile in Zeile ${register.headerIndex + 1}. Erkannte Spalten:`));
  for (const [key, index] of Object.entries(register.columns)) {
    console.log(dim(`  ${key.padEnd(13)} -> "${register.headerFields[index]}"`));
  }
  const schnell = register.entries.filter((e) => e.isFastCharger);
  console.log(
    dim(`Davon als Schnellladeeinrichtung geführt: ${schnell.length.toLocaleString('de-DE')}`)
  );

  // Eine hohe Ausschussquote ohne Begruendung waere ein Messfehler, kein
  // Ergebnis. Deshalb hier immer aufschluesseln, woran es lag.
  if (register.skipped > 0) {
    const quote = (register.skipped / (register.skipped + register.entries.length)) * 100;
    const auffaellig = quote > 5;
    const beschriftung = {
      leereKoordinate: 'Koordinatenfeld leer',
      unlesbareKoordinate: 'Koordinate nicht lesbar',
      unplausibleKoordinate: 'Koordinate außerhalb Deutschlands',
      spaltenzahlWeicht: 'Spaltenzahl weicht ab',
    };

    console.log('');
    console.log(
      (auffaellig ? amber : dim)(
        `${register.skipped.toLocaleString('de-DE')} Zeilen übersprungen (${quote.toFixed(1)} %):`
      )
    );
    for (const [grund, anzahl] of Object.entries(register.skipReasons)) {
      if (anzahl > 0) {
        console.log(dim(`  ${String(anzahl).padStart(7)}  ${beschriftung[grund] ?? grund}`));
      }
    }

    if (auffaellig && register.skipSamples.length > 0) {
      console.log(dim('\nBeispielzeilen, damit die Ursache nachvollziehbar bleibt:'));
      for (const probe of register.skipSamples) {
        console.log(dim(`  [${probe.reason}] ${probe.line}`));
      }
      console.log(
        dim(
          '\nEin Register führt auch Anlagen ohne verwertbare Koordinate. Solange die\n' +
            'Beispiele das bestätigen, ist die Quote unschön, aber kein Fehler.'
        )
      );
    }
  }

  if (args['parse-only']) {
    console.log(dim('\n--parse-only: hier ist Schluss, es geht keine Anfrage raus.'));
    return;
  }

  console.log('');
  const apiKey = await resolveApiKey({
    argumentKey: args.key,
    onNotice: (text) => console.error(dim(text)),
    onFatal: (text) => console.error(red(text)),
  });
  if (!apiKey) process.exit(1);

  // 2. Route
  heading('2. Route planen');
  const from = parseCoordinate(args.from, '--from');
  const to = parseCoordinate(args.to, '--to');
  const route = await planRoute(apiKey, from, to);
  console.log(`${route.lengthKm.toFixed(0)} km, ${route.points.length} Stützpunkte`);

  // 3. Korridor
  const corridorMeters = Number(args.corridor) * 1000;
  const minPower = Number(args.power);

  // --nearby=radius,abstand in Metern, für dichte Gebiete.
  const nearby = args.nearby
    ? (() => {
        const [radius, spacing] = String(args.nearby).split(',').map(Number);
        return { nearbyRadiusMeters: radius, nearbySpacingMeters: spacing ?? radius };
      })()
    : {};

  heading(`3. Register auf den Korridor eingrenzen (${args.corridor} km)`);
  const imKorridor = corridor.withinCorridor(register.entries, route.points, corridorMeters);
  const relevant = imKorridor.filter((e) => !minPower || (e.powerKW ?? 0) >= minPower);

  console.log(`${imKorridor.length} Ladeeinrichtungen im Korridor`);
  console.log(`${relevant.length} davon mit mindestens ${minPower} kW`);

  if (relevant.length === 0) {
    console.log(red('\nNichts zu vergleichen. Korridor oder Leistungsgrenze anpassen.'));
    return;
  }

  // Das Register führt jede Säule einzeln, TomTom führt Standorte. Ohne dieses
  // Bündeln vergleicht man Geräte mit Standorten, und die Quote sagt nichts.
  const standorte = sites.clusterSites(relevant, sites.DEFAULT_SITE_RADIUS_M);
  console.log(
    `${bold(String(standorte.length))} Standorte daraus gebündelt` +
      dim(`  (das ist der Maßstab, Radius ${sites.DEFAULT_SITE_RADIUS_M} m)`)
  );
  console.log(
    dim(
      `im Schnitt ${(relevant.length / standorte.length).toFixed(1)} Ladeeinrichtungen je Standort`
    )
  );

  // 4. TomTom zweimal befragen
  heading('4. TomTom befragen');

  const laeufe = [
    {
      label: 'Along-Route, Vorgabe',
      note: '50-km-Abschnitte, 10 min Umweg',
      run: async () => {
        const r = await ev.searchAlongRoute(apiKey, route.points, { minPowerKW: minPower });
        return { stations: r.stations, requests: r.requests.length };
      },
    },
    {
      label: 'Along-Route, großzügig',
      note: '20-km-Abschnitte, 30 min Umweg',
      run: async () => {
        const r = await ev.searchAlongRoute(apiKey, route.points, {
          minPowerKW: minPower,
          segmentLengthMeters: 20000,
          maxDetourSeconds: 1800,
        });
        return { stations: r.stations, requests: r.requests.length };
      },
    },
    {
      // Der Vorschlag, der sich aus der Entfernungsaufschlüsselung ergibt.
      label: 'Along-Route + Umkreissuchen',
      note: `Umkreise mit ${(nearby.nearbyRadiusMeters ?? ev.DEFAULT_OPTIONS.nearbyRadiusMeters) / 1000} km Radius ` +
        `alle ${(nearby.nearbySpacingMeters ?? ev.DEFAULT_OPTIONS.nearbySpacingMeters) / 1000} km`,
      run: async () => {
        const entlang = await ev.searchAlongRoute(apiKey, route.points, { minPowerKW: minPower });
        const umkreis = await ev.searchAroundRoute(apiKey, route.points, {
          minPowerKW: minPower,
          ...nearby,
        });

        const zusammen = new Map();
        for (const station of [...entlang.stations, ...umkreis.stations]) {
          if (!zusammen.has(station.id)) zusammen.set(station.id, station);
        }
        return {
          stations: [...zusammen.values()],
          requests: entlang.requests.length + umkreis.requestCount,
          coveredCorridorMeters: umkreis.coveredCorridorMeters,
          truncated: umkreis.truncated,
        };
      },
    },
  ];

  const ergebnisse = [];
  for (const lauf of laeufe) {
    const t0 = Date.now();
    const result = await lauf.run();
    const dauer = ((Date.now() - t0) / 1000).toFixed(0);
    ergebnisse.push({ ...lauf, ...result });
    console.log(
      `${String(result.stations.length).padStart(4)} Stationen  ${bold(lauf.label)}  ` +
        dim(`(${lauf.note}, ${result.requests} Anfragen, ${dauer} s)`)
    );
    if (result.coveredCorridorMeters) {
      console.log(
        dim(`      deckt rechnerisch einen Korridor von ${Math.round(result.coveredCorridorMeters)} m ab`)
      );
    }
    if (result.truncated?.length > 0) {
      console.log(
        amber(`      ${result.truncated.length} Umkreise stießen ans Antwortlimit.`) +
          dim(' Dort fehlt vermutlich etwas.')
      );
      console.log(
        dim('      Abhilfe: kleinerer Radius bei kleinerem Abstand, etwa --nearby=3000,4000')
      );
    }
  }

  // 5. Abgleich
  heading('5. Abdeckung, gemessen an Standorten');
  for (const ergebnis of ergebnisse) {
    const { matched, missing } = corridor.matchSources(standorte, ergebnis.stations, 250);
    ergebnis.matched = matched;
    ergebnis.missing = missing;
    const share = matched.length / standorte.length;
    const farbe = colorForShare(share);
    console.log(
      `${bar(share)}  ${farbe(percent(matched.length, standorte.length).toFixed(0).padStart(3) + ' %')}  ` +
        `${bold(ergebnis.label)}  ${dim(`${matched.length} von ${standorte.length} Standorten`)}`
    );
  }

  const [vorgabe, grosszuegig, kombiniert] = ergebnisse;

  console.log('');
  const gewinnUmweg = grosszuegig.matched.length - vorgabe.matched.length;
  const gewinnUmkreis = kombiniert.matched.length - vorgabe.matched.length;

  if (gewinnUmweg <= 0) {
    console.log(
      dim('Mehr erlaubter Umweg und kleinere Abschnitte bringen nichts. Die Umwegschwelle\n' +
        'ist also nicht der Engpass.')
    );
  } else {
    console.log(`${amber('Umwegschwelle wirkt:')} ${gewinnUmweg} Standorte mehr.`);
  }

  if (gewinnUmkreis > 0) {
    const faktor = (kombiniert.matched.length / Math.max(vorgabe.matched.length, 1)).toFixed(2);
    console.log(
      `${green('Umkreissuchen wirken:')} ${gewinnUmkreis} Standorte mehr als mit der ` +
        `Along-Route-Suche allein, Faktor ${faktor}.`
    );
    console.log(
      dim(`Preis dafür: ${kombiniert.requests - vorgabe.requests} zusätzliche Anfragen je Route.`)
    );
  } else {
    console.log(dim('Auch Umkreissuchen bringen nichts. Dann fehlt es wirklich in den Daten.'));
  }

  // 6. Wo die Treffer verloren gehen
  heading('6. Trefferquote nach Entfernung zur Route');
  // Bewertet wird der beste Lauf, sonst misst man die schlechtere Methode.
  const bester = ergebnisse.reduce((a, b) => (b.matched.length > a.matched.length ? b : a));
  const missing = bester.missing;
  console.log(dim(`Grundlage: Lauf "${bester.label}"`));
  const stufen = [
    { label: 'bis 250 m', min: 0, max: 250 },
    { label: '250 bis 500 m', min: 250, max: 500 },
    { label: '500 bis 1000 m', min: 500, max: 1000 },
    { label: 'über 1000 m', min: 1000, max: Infinity },
  ];
  const gefundeneIds = new Set(bester.matched);
  for (const stufe of stufen) {
    const inStufe = standorte.filter(
      (s) =>
        (s.distanceToRouteMeters ?? 0) >= stufe.min && (s.distanceToRouteMeters ?? 0) < stufe.max
    );
    if (inStufe.length === 0) continue;
    const gefunden = inStufe.filter((s) => gefundeneIds.has(s)).length;
    const share = gefunden / inStufe.length;
    console.log(
      `${bar(share, 20)}  ${colorForShare(share)(percent(gefunden, inStufe.length).toFixed(0).padStart(3) + ' %')}  ` +
        `${stufe.label.padEnd(16)} ${dim(`${gefunden} von ${inStufe.length}`)}`
    );
  }

  heading(`7. Auch im besten Lauf nicht gefunden: ${missing.length} Standorte`);

  if (missing.length === 0) {
    console.log(green('Nichts. Die Suche findet alles, was das Register im Korridor führt.'));
  } else {
    const nachLeistung = [...missing].sort((a, b) => (b.maxPowerKW ?? 0) - (a.maxPowerKW ?? 0));
    for (const standort of nachLeistung.slice(0, Number(args.examples))) {
      const geraete = standort.deviceCount > 1 ? `${standort.deviceCount}x ` : '    ';
      console.log(
        `  ${String(Math.round(standort.maxPowerKW ?? 0)).padStart(4)} kW  ${geraete}` +
          `${(standort.operator || 'Betreiber unbekannt').slice(0, 34).padEnd(34)} ` +
          dim(
            `${standort.postalCode} ${standort.city}, ` +
              `${Math.round(standort.distanceToRouteMeters ?? 0)} m ab Route`
          )
      );
    }
    if (missing.length > Number(args.examples)) {
      console.log(dim(`  ... und ${missing.length - Number(args.examples)} weitere`));
    }

    const betreiber = new Map();
    for (const standort of missing) {
      const name = standort.operator || 'unbekannt';
      betreiber.set(name, (betreiber.get(name) ?? 0) + 1);
    }
    const top = [...betreiber.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top.length > 0) {
      console.log(dim('\nHäufigste Betreiber unter den Fehlenden:'));
      for (const [name, anzahl] of top) {
        console.log(dim(`  ${String(anzahl).padStart(4)}x  ${name}`));
      }
    }
  }

  // 7. Einordnung
  heading('8. Einordnung');
  console.log(
    'Das Register führt jede meldepflichtige Anlage, auch solche, die für eine\n' +
      'Durchgangsfahrt ohne Belang sind: Firmenparkplätze, Hotelstellplätze,\n' +
      'Anlagen mit eingeschränkten Öffnungszeiten. Ein Rückstand gegenüber dem\n' +
      'Register ist deshalb nicht automatisch ein Mangel.'
  );
  console.log(
    dim('\nQuelle Register: Bundesnetzagentur.de, CC BY 4.0. ' +
      'Ladeinfrastruktur-Daten bei TomTom: Eco-Movement.')
  );
}

main().catch((error) => {
  console.error(red(`\nAbbruch: ${error.message}`));
  process.exit(1);
});
