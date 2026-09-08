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

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import * as ev from './lib/evsearch.mjs';
import * as geo from './lib/geo.mjs';
import * as bnetza from './lib/bnetza.mjs';
import * as corridor from './lib/corridor.mjs';

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

  if (!args.register) {
    console.error(red('Bitte die Registerdatei angeben: --register=/pfad/zur/datei.csv'));
    console.error(
      dim(
        'Download (CSV, rund 51 MB, CC BY 4.0):\n' +
          '  bundesnetzagentur.de -> Fachthemen -> E-Mobilitaet -> Ladesaeulenkarte'
      )
    );
    process.exit(1);
  }

  const registerPath = expandPath(args.register);
  if (!existsSync(registerPath)) {
    console.error(red(`Datei nicht gefunden: ${registerPath}`));
    process.exit(1);
  }

  // 1. Register lesen
  heading('1. Ladesäulenregister lesen');
  const started = Date.now();
  const register = bnetza.loadRegister(registerPath);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(
    `${register.entries.length.toLocaleString('de-DE')} Einträge in ${seconds} s` +
      (register.skipped ? `, ${register.skipped} ohne Koordinaten übersprungen` : '')
  );
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

  if (args['parse-only']) {
    console.log(dim('\n--parse-only: hier ist Schluss, es geht keine Anfrage raus.'));
    return;
  }

  const apiKey = args.key || process.env.TOMTOM_API_KEY;
  if (!apiKey) {
    console.error(red('\nKein TomTom-Key. --key=... setzen oder TOMTOM_API_KEY exportieren.'));
    process.exit(1);
  }

  // 2. Route
  heading('2. Route planen');
  const from = parseCoordinate(args.from, '--from');
  const to = parseCoordinate(args.to, '--to');
  const route = await planRoute(apiKey, from, to);
  console.log(`${route.lengthKm.toFixed(0)} km, ${route.points.length} Stützpunkte`);

  // 3. Korridor
  const corridorMeters = Number(args.corridor) * 1000;
  const minPower = Number(args.power);

  heading(`3. Register auf den Korridor eingrenzen (${args.corridor} km)`);
  const imKorridor = corridor.withinCorridor(register.entries, route.points, corridorMeters);
  const relevant = imKorridor.filter((e) => !minPower || (e.powerKW ?? 0) >= minPower);

  console.log(`${imKorridor.length} Einträge im Korridor`);
  console.log(
    `${relevant.length} davon mit mindestens ${minPower} kW` +
      dim('  (das ist der Maßstab)')
  );

  if (relevant.length === 0) {
    console.log(red('\nNichts zu vergleichen. Korridor oder Leistungsgrenze anpassen.'));
    return;
  }

  // 4. TomTom zweimal befragen
  heading('4. TomTom befragen');

  const laeufe = [
    {
      label: 'Vorgabewerte',
      options: { minPowerKW: minPower },
      note: '50-km-Abschnitte, 10 min Umweg',
    },
    {
      label: 'betont großzügig',
      options: { minPowerKW: minPower, segmentLengthMeters: 20000, maxDetourSeconds: 1800 },
      note: '20-km-Abschnitte, 30 min Umweg',
    },
  ];

  const ergebnisse = [];
  for (const lauf of laeufe) {
    const t0 = Date.now();
    const result = await ev.searchAlongRoute(apiKey, route.points, lauf.options);
    const dauer = ((Date.now() - t0) / 1000).toFixed(0);
    ergebnisse.push({ ...lauf, stations: result.stations, requests: result.requests.length });
    console.log(
      `${String(result.stations.length).padStart(4)} Stationen  ${bold(lauf.label)}  ` +
        dim(`(${lauf.note}, ${result.requests.length} Anfragen, ${dauer} s)`)
    );
  }

  // 5. Abgleich
  heading('5. Abdeckung');
  for (const ergebnis of ergebnisse) {
    const { matched } = corridor.matchSources(relevant, ergebnis.stations, 250);
    ergebnis.matched = matched;
    const share = matched.length / relevant.length;
    const farbe = colorForShare(share);
    console.log(
      `${bar(share)}  ${farbe(percent(matched.length, relevant.length).toFixed(0).padStart(3) + ' %')}  ` +
        `${bold(ergebnis.label)}  ${dim(`${matched.length} von ${relevant.length}`)}`
    );
  }

  const [vorgabe, grosszuegig] = ergebnisse;
  const gewinn = grosszuegig.matched.length - vorgabe.matched.length;

  console.log('');
  if (gewinn > 0) {
    console.log(
      `${amber('Suchmechanik statt Datenlücke:')} ${gewinn} Stationen kommen allein durch ` +
        'kleinere Abschnitte und mehr erlaubten Umweg dazu.'
    );
    console.log(
      dim('Das 20-Treffer-Limit je Antwort ist der wahrscheinlichste Grund, warum in Apps\n' +
        'Ladepunkte fehlen. Es liegt nicht an der Datenbank.')
    );
  } else {
    console.log(dim('Großzügigere Suchparameter bringen nichts. Was fehlt, fehlt in den Daten.'));
  }

  // 6. Was auch großzügig nicht gefunden wird
  const { missing } = corridor.matchSources(relevant, grosszuegig.stations, 250);
  heading(`6. Auch großzügig nicht gefunden: ${missing.length}`);

  if (missing.length === 0) {
    console.log(green('Nichts. Die Suche findet alles, was das Register im Korridor führt.'));
  } else {
    const nachLeistung = [...missing].sort((a, b) => (b.powerKW ?? 0) - (a.powerKW ?? 0));
    for (const eintrag of nachLeistung.slice(0, Number(args.examples))) {
      console.log(
        `  ${String(Math.round(eintrag.powerKW ?? 0)).padStart(4)} kW  ` +
          `${(eintrag.operator || 'Betreiber unbekannt').slice(0, 38).padEnd(38)} ` +
          dim(`${eintrag.postalCode} ${eintrag.city}, ${Math.round(eintrag.distanceToRouteMeters)} m ab Route`)
      );
    }
    if (missing.length > Number(args.examples)) {
      console.log(dim(`  ... und ${missing.length - Number(args.examples)} weitere`));
    }

    const betreiber = new Map();
    for (const eintrag of missing) {
      const name = eintrag.operator || 'unbekannt';
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
  heading('7. Einordnung');
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
