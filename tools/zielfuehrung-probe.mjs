#!/usr/bin/env node
// zielfuehrung-probe.mjs
// Holt eine Route mit Fahranweisungen auf Deutsch und zeigt, was drinsteht.
//
//   node tools/zielfuehrung-probe.mjs
//   node tools/zielfuehrung-probe.mjs --from=51.2560,6.6890 --to=53.6148,7.1621
//   node tools/zielfuehrung-probe.mjs --json     alle Anweisungen als JSON ins Protokoll
//   node tools/zielfuehrung-probe.mjs --fixture  Anweisungen und Routenpunkte als
//        Testdatei nach tools/test/fixtures/anweisungen-meerbusch-norddeich.json
//
// Wozu: Bevor die App Anweisungen ansagt, soll feststehen, welche Felder
// die Routing-API liefert, wie die Texte klingen und wie viele es auf einer
// langen Strecke sind. Eine Anfrage.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ev from './lib/evsearch.mjs';
import { resolveApiKey } from './lib/apikey.mjs';

const args = {};
for (const raw of process.argv.slice(2)) {
  const [k, v] = raw.replace(/^--/, '').split('=');
  args[k] = v ?? true;
}
const koord = (t) => { const [lat, lon] = String(t).split(',').map(Number); return { lat, lon }; };
const from = koord(args.from ?? '51.2560,6.6890');
const to = koord(args.to ?? '53.6148,7.1621');

const apiKey = await resolveApiKey({ argumentKey: args.key, onNotice: console.error, onFatal: console.error });
if (!apiKey) process.exit(1);

const url = new URL(`${ev.BASE_URL}/routing/1/calculateRoute/${from.lat},${from.lon}:${to.lat},${to.lon}/json`);
url.searchParams.set('key', apiKey);
url.searchParams.set('routeType', 'fastest');
url.searchParams.set('traffic', 'true');
url.searchParams.set('travelMode', 'car');
url.searchParams.set('instructionsType', 'text');
url.searchParams.set('language', 'de-DE');
url.searchParams.set('sectionType', 'motorway');

const r = await ev.requestWithRetry(fetch, url, {});
if (!r.ok) {
  console.error(`Routing ${r.status}: ${(await r.text()).slice(0, 300)}`);
  process.exit(1);
}
const json = await r.json();
const route = json.routes[0];
const anweisungen = route.guidance?.instructions ?? [];
const punkte = route.legs.reduce((n, l) => n + l.points.length, 0);

console.log(`Route: ${(route.summary.lengthInMeters / 1000).toFixed(1)} km, ${Math.round(route.summary.travelTimeInSeconds / 60)} min, ${punkte} Punkte`);
console.log(`Anweisungen: ${anweisungen.length}, Gruppen: ${route.guidance?.instructionGroups?.length ?? 0}`);
console.log(`Abschnitte: ${(route.sections ?? []).map((s) => `${s.sectionType} ${s.startPointIndex}-${s.endPointIndex}`).join(', ')}`);

const felder = new Map();
for (const a of anweisungen) for (const k of Object.keys(a)) felder.set(k, (felder.get(k) ?? 0) + 1);
console.log(`\nFelder (Anzahl Anweisungen mit dem Feld):`);
for (const [k, n] of felder) console.log(`  ${k}: ${n}`);

const manoever = new Map();
for (const a of anweisungen) manoever.set(a.maneuver, (manoever.get(a.maneuver) ?? 0) + 1);
console.log(`\nManoever: ${[...manoever].map(([m, n]) => `${m} ${n}`).join(', ')}`);

console.log('\nkm     | Manoever              | Text');
for (const a of anweisungen) {
  const km = (a.routeOffsetInMeters / 1000).toFixed(1).padStart(6);
  console.log(`${km} | ${String(a.maneuver).padEnd(21)} | ${a.message}${a.combinedMessage ? `  [kombiniert: ${a.combinedMessage}]` : ''}`);
}

console.log('\nDrei Anweisungen vollstaendig:');
for (const i of [0, Math.floor(anweisungen.length / 2), anweisungen.length - 1]) {
  console.log(JSON.stringify(anweisungen[i]));
}

if (args.json) {
  console.log('\nJSON-ANFANG');
  console.log(JSON.stringify(anweisungen));
  console.log('JSON-ENDE');
}

if (args.fixture) {
  const ziel = join(dirname(fileURLToPath(import.meta.url)), 'test', 'fixtures', 'anweisungen-meerbusch-norddeich.json');
  const punkteListe = route.legs.flatMap((l) => l.points.map((p) => [p.latitude, p.longitude]));
  writeFileSync(ziel, JSON.stringify({
    abgerufen: new Date().toISOString().slice(0, 10),
    von: from, nach: to,
    laengeMeter: route.summary.lengthInMeters,
    punkte: punkteListe,
    anweisungen,
  }) + '\n');
  console.log(`\nTestdatei geschrieben: ${ziel}`);
}
