#!/usr/bin/env node
// redaktion-einbauen.mjs
// Uebernimmt einen Export von Suchtreffern in den Datenbestand der App.
//
//   node tools/redaktion-einbauen.mjs
//   node tools/redaktion-einbauen.mjs --von=tools/meine-stationen.json
//   node tools/redaktion-einbauen.mjs --trocken
//   node tools/redaktion-einbauen.mjs --commit
//
// Wozu: Der Export entsteht auf dem Rechner mit dem API-Schluessel
// (tomtom-probe.mjs --export-editorial=...) und enthaelt die echten POI-IDs.
// Die App liest LadeRoute/Resources/editorial-stations.json. Zwischen beidem
// stand bisher Handarbeit, und Handarbeit an einer Datei mit hundert Eintraegen
// geht schief.
//
// Was der Import nicht tut: ein vorhandenes Urteil ueberschreiben. Wer einmal
// getestet hat, verliert das durch keinen weiteren Import.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { fuehreZusammen, istGetestet, urteil } from './lib/redaktion.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const wurzel = join(here, '..');

const ZIEL = join(wurzel, 'LadeRoute', 'Resources', 'editorial-stations.json');
const VORGABE_QUELLE = join(wurzel, 'tools', 'meine-stationen.json');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t) => wrap('1', t);
const dim = (t) => wrap('2', t);
const red = (t) => wrap('31', t);
const green = (t) => wrap('32', t);

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

function lies(pfad, wennLeer) {
  if (!existsSync(pfad)) return wennLeer;
  const inhalt = readFileSync(pfad, 'utf8').trim();
  if (inhalt === '') return wennLeer;
  try {
    const daten = JSON.parse(inhalt);
    if (!Array.isArray(daten)) throw new Error('erwartet wird eine Liste');
    return daten;
  } catch (fehler) {
    console.error(red(`${pfad} laesst sich nicht lesen: ${fehler.message}`));
    process.exit(1);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const quelle = args.von ? resolve(String(args.von)) : VORGABE_QUELLE;

  if (!existsSync(quelle)) {
    console.error(red(`Der Export fehlt: ${quelle}`));
    console.error('');
    console.error('Erzeugen laesst er sich auf dem Rechner mit dem Schluessel:');
    console.error(dim('  node tools/tomtom-probe.mjs --from=51.2560,6.6890 \\'));
    console.error(dim('       --to=53.6148,7.1621 --export-editorial=tools/meine-stationen.json'));
    process.exit(1);
  }

  const bestand = lies(ZIEL, []);
  const importiert = lies(quelle, []);

  let ergebnis;
  try {
    ergebnis = fuehreZusammen(bestand, importiert);
  } catch (fehler) {
    console.error(red(fehler.message));
    for (const zeile of fehler.details ?? []) console.error(`  ${zeile}`);
    process.exit(1);
  }

  const { entries, statistik } = ergebnis;

  console.log(bold('Redaktionsbestand'));
  console.log(`  Quelle    ${relative(wurzel, quelle)} mit ${importiert.length} Eintraegen`);
  console.log(`  Bestand   ${statistik.bestand}`);
  console.log(`  neu       ${statistik.neu}`);
  console.log(`  ergaenzt  ${statistik.ergaenzt}`);
  console.log(dim(`  gleich    ${statistik.unveraendert}`));
  console.log('');
  console.log(
    `  ${bold(String(statistik.gesamt))} Eintraege, davon ` +
      `${green(String(statistik.getestet))} getestet und ${statistik.erfasst} nur erfasst`
  );

  if (statistik.getestet > 0) {
    console.log('');
    console.log(bold('Getestet'));
    for (const entry of entries.filter(istGetestet)) {
      const note = entry.rating != null ? entry.rating.toFixed(1) : ' - ';
      const text = urteil(entry) ?? '';
      console.log(`  ${note}  ${entry.name}`);
      console.log(dim(`       ${text.slice(0, 88)}${text.length > 88 ? '...' : ''}`));
    }
  } else {
    console.log('');
    console.log(
      dim(
        'Noch kein einziges Urteil. Der Bestand ist die Arbeitsliste: verdict und\n' +
          'rating in der Zieldatei fuellen, dann zeigt die App den Eintrag als eigenen\n' +
          'Test. Bis dahin steht dort, die Station stehe auf unserer Liste.'
      )
    );
  }

  if (args.trocken) {
    console.log('');
    console.log(dim('Trockenlauf, nichts geschrieben.'));
    return;
  }

  writeFileSync(ZIEL, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  console.log('');
  console.log(`Geschrieben: ${relative(wurzel, ZIEL)}`);

  if (args.commit) {
    const git = (...argumente) =>
      execFileSync('git', argumente, { cwd: wurzel, encoding: 'utf8' }).trim();

    if (git('status', '--porcelain', '--', ZIEL) === '') {
      console.log(dim('Nichts zu committen, die Datei ist unveraendert.'));
      return;
    }
    git('add', '--', ZIEL);
    git(
      'commit',
      '-m',
      `Redaktionsbestand: ${statistik.gesamt} Stationen, ${statistik.getestet} getestet`,
      '--',
      ZIEL
    );
    git('push');
    console.log(green('Committet und gepusht.'));
  }
}

main();
