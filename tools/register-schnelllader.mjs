#!/usr/bin/env node
// register-schnelllader.mjs
// Sagt, wie gross die Aufgabe von State of Charge ist.
//
//   node tools/register-schnelllader.mjs
//   node tools/register-schnelllader.mjs --register=~/Downloads/Ladesaeulenregister.csv
//   node tools/register-schnelllader.mjs --leistung=150
//   node tools/register-schnelllader.mjs --export=tools/standorte.json
//
// Die Grundgesamtheit von State of Charge sind die Schnellladestandorte in
// Deutschland, nicht die Treffer entlang einer Route. Quelle ist das
// Ladesaeulenregister der Bundesnetzagentur.
//
// Warum Standorte und nicht Ladeeinrichtungen: Das Register fuehrt jede
// Ladeeinrichtung als eigene Zeile. Ein Ladepark mit acht Saeulen sind acht
// Zeilen, aber nur ein Ort, an den jemand faehrt und den jemand bewertet.
// Bewertet wird der Ort.

import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as bnetza from './lib/bnetza.mjs';
import { clusterSites, DEFAULT_SITE_RADIUS_M } from './lib/sites.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const wurzel = join(here, '..');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t) => wrap('1', t);
const dim = (t) => wrap('2', t);
const red = (t) => wrap('31', t);

const STUFEN = [
  { label: 'ab 50 kW', min: 50 },
  { label: 'ab 150 kW', min: 150 },
  { label: 'ab 300 kW', min: 300 },
];

function parseArgs(argv) {
  const args = {};
  for (const arg of argv.slice(2)) {
    const treffer = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!treffer) {
      console.error(`Unbekanntes Argument: ${arg}`);
      process.exit(1);
    }
    args[treffer[1]] = treffer[2] ?? true;
  }
  return args;
}

function heading(text) {
  console.log(`\n${bold(text)}`);
  console.log(dim('-'.repeat(Math.max(text.length, 44))));
}

const zahl = (n) => n.toLocaleString('de-DE');

function main() {
  const args = parseArgs(process.argv);
  const pfad = bnetza.pickRegisterFile(args.register, {
    onInfo: (text) => console.log(dim(text)),
    onFatal: (text) => console.error(red(text)),
  });
  if (!pfad) process.exit(1);

  if (!existsSync(pfad)) {
    console.error(red(`Datei nicht gefunden: ${pfad}`));
    console.error(dim(bnetza.DOWNLOAD_HINT));
    process.exit(1);
  }

  heading('1. Register lesen');
  const register = bnetza.loadRegister(pfad);
  console.log(
    `${zahl(register.entries.length)} Ladeeinrichtungen aus ${zahl(register.rowCount)} Datensaetzen`
  );

  // Zwei Wege zur selben Frage, und sie fallen auseinander: Das Register
  // klassifiziert selbst in Normal- und Schnellladeeinrichtung, unabhaengig
  // davon steht in jeder Zeile eine Nennleistung. Beides zu zeigen ist
  // ehrlicher, als sich fuer eine Zahl zu entscheiden.
  const laut = register.entries.filter((e) => e.isFastCharger);
  const ab50 = register.entries.filter((e) => (e.powerKW ?? 0) >= 50);
  console.log(
    dim(
      `davon als Schnellladeeinrichtung ausgewiesen: ${zahl(laut.length)}, ` +
        `mit mindestens 50 kW Nennleistung: ${zahl(ab50.length)}`
    )
  );

  heading('2. Zu Standorten zusammengefasst');
  console.log(dim(`Radius ${DEFAULT_SITE_RADIUS_M} m, verkettet`));
  console.log('');
  console.log(
    `${'Leistung'.padEnd(12)}${'Ladeeinrichtungen'.padStart(18)}${'Standorte'.padStart(12)}${'Ladepunkte'.padStart(13)}`
  );

  const ergebnisse = new Map();
  for (const stufe of STUFEN) {
    const treffer = register.entries.filter((e) => (e.powerKW ?? 0) >= stufe.min);
    const standorte = clusterSites(treffer, DEFAULT_SITE_RADIUS_M);
    const punkte = standorte.reduce((summe, s) => summe + (s.pointCount ?? 0), 0);
    ergebnisse.set(stufe.min, standorte);
    console.log(
      stufe.label.padEnd(12) +
        zahl(treffer.length).padStart(18) +
        zahl(standorte.length).padStart(12) +
        zahl(punkte).padStart(13)
    );
  }

  const gewaehlt = Number(args.leistung ?? 50);
  const standorte = ergebnisse.get(gewaehlt) ?? clusterSites(
    register.entries.filter((e) => (e.powerKW ?? 0) >= gewaehlt),
    DEFAULT_SITE_RADIUS_M
  );

  heading(`3. Standorte ab ${gewaehlt} kW nach Bundesland`);
  const nachLand = new Map();
  for (const standort of standorte) {
    const land = standort.state || '(ohne Angabe)';
    nachLand.set(land, (nachLand.get(land) ?? 0) + 1);
  }
  for (const [land, anzahl] of [...nachLand.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${zahl(anzahl).padStart(6)}  ${land}`);
  }

  heading(`4. Groesste Betreiber ab ${gewaehlt} kW`);
  const nachBetreiber = new Map();
  for (const standort of standorte) {
    const name = standort.operator || '(ohne Angabe)';
    nachBetreiber.set(name, (nachBetreiber.get(name) ?? 0) + 1);
  }
  const sortiert = [...nachBetreiber.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, anzahl] of sortiert.slice(0, 15)) {
    console.log(`  ${zahl(anzahl).padStart(6)}  ${name}`);
  }
  console.log(dim(`  ${zahl(sortiert.length)} Betreiber insgesamt`));

  if (args.export) {
    const ziel = resolve(String(args.export));
    const eintraege = standorte.map((s) => ({
      lat: Number(s.lat.toFixed(6)),
      lon: Number(s.lon.toFixed(6)),
      operator: s.operator,
      maxPowerKW: s.maxPowerKW,
      deviceCount: s.deviceCount,
      pointCount: s.pointCount,
      address: s.address,
      postalCode: s.postalCode,
      city: s.city,
      state: s.state,
    }));
    // Kopfdaten statt nackter Liste, und zwar nicht aus Ordnungsliebe: Die
    // Lizenz verlangt Namensnennung. Steht sie in der Datei, wandert sie mit,
    // wenn die Daten irgendwann auf einer Webseite landen.
    const daten = {
      quelle: 'Ladesaeulenregister der Bundesnetzagentur',
      lizenz: 'CC BY 4.0',
      namensnennung: 'Bundesnetzagentur.de',
      registerdatei: basename(pfad),
      erzeugtAm: new Date().toISOString().slice(0, 10),
      leistungAbKW: gewaehlt,
      standortRadiusM: DEFAULT_SITE_RADIUS_M,
      anzahl: eintraege.length,
      standorte: eintraege,
    };

    writeFileSync(ziel, JSON.stringify(daten, null, 2) + '\n', 'utf8');
    heading('5. Erfassungsbogen geschrieben');
    console.log(`${zahl(eintraege.length)} Standorte ab ${gewaehlt} kW nach ${ziel}`);
    console.log(
      dim(
        'Ohne Kennungen. Die vergibt der Datenspeicher, sobald er steht; ein\n' +
          'spaeteres Register wird ueber die Naehe zugeordnet, nicht ueber eine\n' +
          'Kennung aus dieser Datei.'
      )
    );
    console.log(
      dim('Lizenz CC BY 4.0. Wo die Daten oeffentlich stehen, gehoert die\n' +
        'Namensnennung "Bundesnetzagentur.de" sichtbar dazu.')
    );
  } else {
    console.log('');
    console.log(dim('--export=datei.json schreibt die Standorte als Erfassungsbogen heraus.'));
  }
}

main();
