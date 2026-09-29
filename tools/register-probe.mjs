#!/usr/bin/env node
// register-probe.mjs
// Probelauf ohne die Search API: Route von TomTom, Stationen aus dem
// Ladesaeulenregister, Umwege je Station ueber die Routing API.
//
//   node tools/register-probe.mjs
//   node tools/register-probe.mjs --from=51.256,6.689 --to=53.6148,7.1621
//   node tools/register-probe.mjs --corridor=2         Korridor in km
//   node tools/register-probe.mjs --daten=daten/standorte-150kw.json
//   node tools/register-probe.mjs --verkehr            mit Verkehrslage
//   node tools/register-probe.mjs --ohne-umwege        nur die Liste, eine Anfrage
//   node tools/register-probe.mjs --all-results        alle Zeilen
//   node tools/register-probe.mjs --tabelle=daten/umwege.json   Umwegtabelle (Vorgabe)
//   node tools/register-probe.mjs --ohne-tabelle       alles frisch rechnen, nichts schreiben
//   node tools/register-probe.mjs --still              nur Kopfzahlen, fuer Korridorlaeufe
//
// Die Umwegtabelle: Was einmal gerechnet ist, wird nachgeschlagen und nicht
// noch einmal gefragt. Jeder Lauf traegt seine neuen Werte ein. Die Tabelle
// liegt im Repo und wandert ins Bundle der App, siehe umwegtabelle.mjs.
//
// Warum ein zweiter Probelauf: tomtom-probe.mjs haengt an der Search API, und
// die hat im Freemium 2.500 Anfragen im Monat, fuenfzig je Lauf. Dieser hier
// kostet eine Anfrage fuer die Route und eine je Station fuer den Umweg, alles
// aus dem Routing-Kontingent von 20.000. Statt --key=... kann TOMTOM_API_KEY
// gesetzt sein.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ev from './lib/evsearch.mjs';
import * as editorial from './lib/editorial.mjs';
import * as registerquelle from './lib/registerquelle.mjs';
import * as umwege from './lib/umwege.mjs';
import * as umwegtabelle from './lib/umwegtabelle.mjs';
import { istGetestet, urteil } from './lib/redaktion.mjs';
import { resolveApiKey } from './lib/apikey.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  from: '51.2560,6.6890',
  to: '53.6148,7.1621',
  corridor: '2',
  show: '40',
  daten: 'daten/standorte-150kw.json',
  tabelle: 'daten/umwege.json',
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
  const parts = String(text).split(',').map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`${label} erwartet lat,lon, bekommen: ${text}`);
  }
  return { lat: parts[0], lon: parts[1] };
}

function numberArg(args, key) {
  const n = Number(args[key]);
  if (!Number.isFinite(n)) throw new Error(`--${key} erwartet eine Zahl, bekommen: ${args[key]}`);
  return n;
}

// --------------------------------------------------------------- Ausgabe

const farbe = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = farbe('1');
const dim = farbe('2');
const red = farbe('31');
const green = farbe('32');

function heading(text) {
  console.log(`\n${bold(text)}`);
  console.log('-'.repeat(Math.max(44, text.length)));
}

// --------------------------------------------------------------- Routing

async function routeAntwort(apiKey, punkte, mitVerkehr) {
  const pfad = punkte.map((p) => `${p.lat},${p.lon}`).join(':');
  const url = new URL(`${ev.BASE_URL}/routing/1/calculateRoute/${pfad}/json`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('routeType', 'fastest');
  url.searchParams.set('traffic', mitVerkehr ? 'true' : 'false');
  url.searchParams.set('travelMode', 'car');

  const response = await ev.requestWithRetry(fetch, url, {});
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    const hint = {
      401: ' Der Schluessel wird nicht akzeptiert.',
      403: ' Routing API nicht freigeschaltet oder Kontingent aufgebraucht.',
      429: ' Kontingent aufgebraucht.',
    }[response.status] ?? '';
    throw new Error(`Routing antwortet mit ${response.status}: ${body}${hint}`);
  }
  const json = await response.json();
  const route = json.routes?.[0];
  if (!route) throw new Error('Routing liefert keine Route.');
  return route;
}

async function planRoute(apiKey, from, to, mitVerkehr) {
  const route = await routeAntwort(apiKey, [from, to], mitVerkehr);
  const points = (route.legs ?? []).flatMap((leg) =>
    (leg.points ?? []).map((p) => ({ lat: p.latitude, lon: p.longitude }))
  );
  return {
    points,
    lengthKm: route.summary.lengthInMeters / 1000,
    durationMin: route.summary.travelTimeInSeconds / 60,
  };
}

// ------------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv);
  const from = parseCoordinate(args.from, '--from');
  const to = parseCoordinate(args.to, '--to');
  const korridorKm = numberArg(args, 'corridor');
  const show = numberArg(args, 'show');
  const mitVerkehr = Boolean(args.verkehr);

  // Register laden, bevor der Key abgefragt wird: Ein fehlender Export soll
  // nicht erst nach der Eingabe auffallen.
  const datenPfad = resolve(join(here, '..'), String(args.daten));
  const register = registerquelle.ladeStandorte(datenPfad);
  const still = Boolean(args.still);
  const tabellenPfad = args['ohne-tabelle'] ? null : resolve(join(here, '..'), String(args.tabelle));
  const tabelle = tabellenPfad ? umwegtabelle.lade(tabellenPfad) : null;

  const apiKey = await resolveApiKey({
    argumentKey: args.key,
    onNotice: (text) => console.error(dim(text)),
    onFatal: (text) => console.error(red(text)),
  });
  if (!apiKey) process.exit(1);

  let anfragen = 0;

  // 1. Route
  heading('1. Route planen');
  const route = await planRoute(apiKey, from, to, mitVerkehr);
  anfragen++;
  console.log(
    `${route.lengthKm.toFixed(0)} km, ${Math.round(route.durationMin)} min, ` +
      `${route.points.length} Punkte in der Geometrie`
  );
  console.log(
    mitVerkehr
      ? dim('mit Verkehrslage, wie in der App')
      : dim('ohne Verkehrslage, damit derselbe Aufruf dieselbe Strecke liefert')
  );

  // 2. Stationen aus dem Register
  heading('2. Ladestationen aus dem Register');
  console.log(
    dim(`${register.meta.quelle}, ${register.meta.registerdatei}, ab ${register.meta.leistungAbKW} kW`)
  );
  const stationen = registerquelle.entlangDerRoute(register.stationen, route.points, korridorKm * 1000);
  console.log(
    `${bold(String(stationen.length))} Standorte bis ${korridorKm} km neben der Route, ` +
      `aus ${register.stationen.length} im Register, ohne eine Anfrage`
  );

  // 3. Eigene Daten
  heading('3. Eigene Daten zuordnen');
  const entries = JSON.parse(
    readFileSync(join(here, '..', 'LadeRoute', 'Resources', 'editorial-stations.json'), 'utf8')
  );
  const annotated = editorial.annotate(stationen, entries);
  const matched = annotated.filter((a) => a.editorial);
  const getestet = matched.filter((a) => istGetestet(a.editorial));
  console.log(
    `${matched.length} von ${annotated.length} Standorten stehen im Bestand, ` +
      `davon ${getestet.length} getestet (Bestand insgesamt: ${entries.length})`
  );

  // 4. Umwege ueber die Routing API
  let umwegErgebnis = null;
  if (!args['ohne-umwege']) {
    heading('4. Umwege je Standort, Route mit Zwischenziel');
    const stuetzen = umwege.stuetzpunkte(route.points, route.durationMin * 60);
    const begonnen = Date.now();

    // Erst die Tabelle: Was schon einmal gerechnet wurde, kostet nichts.
    const lage = umwegtabelle.routenLage(route.points);
    let ausTabelle = 0;
    if (tabelle) {
      for (const s of stationen) {
        const bekannt = umwegtabelle.nachschlagen(tabelle, s, lage);
        if (bekannt != null) {
          s.detourSeconds = bekannt;
          s.detourAusTabelle = true;
          ausTabelle++;
        }
      }
      console.log(
        dim(`Tabelle ${tabellenPfad.replace(join(here, '..') + '/', '')}: ` +
          `${Object.keys(tabelle.eintraege).length} Eintraege, ${ausTabelle} Treffer fuer diese Route`)
      );
    }
    const offen = stationen.filter((s) => s.detourSeconds == null);

    const routeSekunden = async (punkte) => {
      await ev.sleep(ev.MIN_REQUEST_INTERVAL_MS);
      const antwort = await routeAntwort(apiKey, punkte, mitVerkehr);
      return antwort.summary.travelTimeInSeconds;
    };

    let zuletzt = 0;
    umwegErgebnis = await umwege.berechneUmwege(routeSekunden, stuetzen, offen, {
      onFortschritt: (n, von) => {
        if (n - zuletzt >= 20 || n === von) {
          process.stdout.write(dim(`  ${n} von ${von}\r`));
          zuletzt = n;
        }
      },
    });
    anfragen += umwegErgebnis.anfragen;
    const sekunden = ((Date.now() - begonnen) / 1000).toFixed(1);
    console.log(
      `Umweg für ${bold(String(umwegErgebnis.gerechnet + ausTabelle))} von ${stationen.length} Standorten: ` +
        `${ausTabelle} aus der Tabelle, ${umwegErgebnis.gerechnet} gerechnet in ` +
        `${umwegErgebnis.anfragen} Anfragen (${umwegErgebnis.abschnitte} Abschnitte), ${sekunden} s` +
        (umwegErgebnis.fehler ? red(`, ${umwegErgebnis.fehler} Fehler`) : '')
    );

    // Dann eintragen, was neu ist. Mit Verkehr gerechnete Werte kommen nur
    // hinein, wo noch nichts steht; die Tabelle soll den Umweg der Strasse
    // enthalten, nicht den des Nachmittags.
    if (tabelle) {
      let neu = 0;
      for (const s of offen) {
        if (s.detourSeconds == null) continue;
        if (umwegtabelle.eintragen(tabelle, s, lage, s.detourSeconds, { mitVerkehr })) neu++;
      }
      if (neu > 0) umwegtabelle.speichere(tabellenPfad, tabelle);
      console.log(
        dim(`${neu} neue Eintraege, Tabelle jetzt ${Object.keys(tabelle.eintraege).length}`)
      );
    }
  }

  // 5. Liste
  heading(`5. Ergebnis, in Fahrtrichtung sortiert (erste ${Math.min(show, annotated.length)} von ${annotated.length})`);
  const sichtbar = still ? [] : args['all-results'] ? annotated : annotated.slice(0, show);
  for (const item of sichtbar) {
    const s = item.station;
    const parts = [
      s.maxPowerKW ? `${s.maxPowerKW} kW` : 'kW unbekannt',
      s.pointCount ? `${s.pointCount} Ladepunkte` : null,
      `${Math.round(s.distanceFromRouteMeters)} m ab Route`,
      s.detourSeconds != null
        ? `+${Math.round(s.detourSeconds / 60)} min Umweg` + (s.detourAusTabelle ? ' (Tabelle)' : '')
        : null,
    ].filter(Boolean);

    const km = String(Math.round(s.progressMeters / 1000)).padStart(3);
    const marker = istGetestet(item.editorial) ? red('*') : item.editorial ? green('o') : dim('.');
    console.log(`${marker} km ${km}  ${bold(s.name)}`);
    console.log(`         ${dim(parts.join(' | '))}`);
    if (s.address) console.log(`         ${dim(s.address)}`);
    const eigenes = urteil(item.editorial);
    if (eigenes) {
      const note = item.editorial.rating != null ? `Note ${item.editorial.rating} - ` : '';
      console.log(`         ${red('eigener Test:')} ${note}${eigenes.slice(0, 80)}`);
    } else if (item.editorial) {
      console.log(`         ${green('auf der Liste,')} ${dim('noch nicht getestet')}`);
    }
  }
  if (still) {
    console.log(dim('--still: Liste weggelassen'));
  } else if (sichtbar.length < annotated.length) {
    console.log(dim(`\n... und ${annotated.length - sichtbar.length} weitere. --all-results zeigt alle.`));
  }

  console.log(
    `\n${dim('Legende:')} ${red('*')} mit eigenem Test   ${green('o')} erfasst   ${dim('. nur Register')}`
  );
  console.log(dim(`Verbrauch: ${anfragen} Anfragen an die Routing API (Freemium: 20.000 im Monat), 0 an die Search API`));
  console.log(dim(`Quelle: ${register.meta.quelle}, ${register.meta.lizenz}, ${register.meta.namensnennung}`));
}

main().catch((error) => {
  console.error(red(`\nAbbruch: ${error.message}`));
  process.exit(1);
});
