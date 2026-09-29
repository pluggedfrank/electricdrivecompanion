#!/usr/bin/env node
// korridore-abfahren.mjs
// Fuellt die Umwegtabelle, indem es die grossen Fernrouten abfaehrt.
//
//   node tools/korridore-abfahren.mjs                 alle Korridore, beide Richtungen
//   node tools/korridore-abfahren.mjs --nur=Hamburg-Koeln,Berlin-Muenchen
//   node tools/korridore-abfahren.mjs --max=6         hoechstens sechs Laeufe
//   node tools/korridore-abfahren.mjs --trocken       nur zeigen, was liefe
//
// Jeder Lauf ist ein register-probe.mjs mit --still. Was schon in der Tabelle
// steht, kostet keine Anfrage mehr; ein zweiter Durchgang ist deshalb fast
// umsonst. Ein Korridor von 400 km kostet grob 150 bis 250 Routing-Anfragen
// beim ersten Mal. Bei 20.000 im Monat gehen die 29 Korridore in beide
// Richtungen in einen Monat, mit Luft.
//
// Ohne Verkehrslage, absichtlich: Die Tabelle soll den Umweg der Strasse
// enthalten, nicht den der Uhrzeit, zu der der Lauf lief.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveApiKey } from './lib/apikey.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    args[key] = value ?? true;
  }
  return args;
}

const args = parseArgs(process.argv);
const daten = JSON.parse(readFileSync(join(here, '..', 'daten', 'korridore.json'), 'utf8'));

const nur = args.nur ? new Set(String(args.nur).split(',')) : null;
const max = args.max ? Number(args.max) : Infinity;

const laeufe = [];
for (const [a, b] of daten.korridore) {
  const name = `${a}-${b}`;
  if (nur && !nur.has(name) && !nur.has(`${b}-${a}`)) continue;
  laeufe.push({ name, von: a, nach: b });
  laeufe.push({ name: `${b}-${a}`, von: b, nach: a });
}

const auswahl = laeufe.slice(0, max);
console.log(`${auswahl.length} Laeufe${args.trocken ? ' (trocken)' : ''}`);

// Den Key einmal holen und den Laeufen als Umgebungsvariable mitgeben, sonst
// fragt jeder einzelne danach.
let umgebung = process.env;
if (!args.trocken) {
  const apiKey = await resolveApiKey({
    argumentKey: args.key,
    onNotice: (text) => console.error(text),
    onFatal: (text) => console.error(text),
  });
  if (!apiKey) process.exit(1);
  umgebung = { ...process.env, TOMTOM_API_KEY: apiKey };
}

let fehlgeschlagen = 0;
for (const [index, lauf] of auswahl.entries()) {
  const von = daten.orte[lauf.von];
  const nach = daten.orte[lauf.nach];
  if (!von || !nach) {
    console.log(`  ${lauf.name}: Ort fehlt in korridore.json`);
    fehlgeschlagen++;
    continue;
  }

  const kommando = [
    join(here, 'register-probe.mjs'),
    `--from=${von[0]},${von[1]}`,
    `--to=${nach[0]},${nach[1]}`,
    '--still',
  ];
  console.log(`\n[${index + 1}/${auswahl.length}] ${lauf.name}`);
  if (args.trocken) {
    console.log('  node ' + kommando.join(' '));
    continue;
  }

  const ergebnis = spawnSync(process.execPath, kommando, { stdio: 'inherit', env: umgebung });
  if (ergebnis.status !== 0) {
    fehlgeschlagen++;
    console.log(`  ${lauf.name}: abgebrochen (Status ${ergebnis.status})`);
    // Ein Kontingentfehler trifft jeden weiteren Lauf genauso.
    if (ergebnis.status === 1) {
      console.log('  Weitere Laeufe uebersprungen. Kontingent oder Key pruefen.');
      break;
    }
  }
}

console.log(`\nFertig, ${auswahl.length - fehlgeschlagen} von ${auswahl.length} Laeufen durch.`);
