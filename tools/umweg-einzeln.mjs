#!/usr/bin/env node
// umweg-einzeln.mjs
// Eine Station, vier Routen: Grundstrecke und Route ueber die Station, je
// einmal ohne und einmal mit Verkehrslage. Zeigt Sekunden und Meter.
//
//   node tools/umweg-einzeln.mjs --station=51.23966,6.74420
//   node tools/umweg-einzeln.mjs --station=... --from=... --to=...
//
// Wozu: In der Umwegtabelle standen elf Eintraege auf null Sekunden, darunter
// Stationen, die mit Verkehr fuenf Minuten kosteten. Die Frage ist, ob
// traffic=false den Umweg wegrechnet, weil Stadtstrassen ohne Verkehrsdaten
// mit Tempolimit durchgehen. Fuenf Anfragen, dann weiss man es.

import * as ev from './lib/evsearch.mjs';
import * as matrix from './lib/matrix.mjs';
import * as corridor from './lib/corridor.mjs';
import { resolveApiKey } from './lib/apikey.mjs';

const args = {};
for (const raw of process.argv.slice(2)) {
  const [k, v] = raw.replace(/^--/, '').split('=');
  args[k] = v ?? true;
}
const koord = (t) => { const [lat, lon] = String(t).split(',').map(Number); return { lat, lon }; };
const from = koord(args.from ?? '51.2560,6.6890');
const to = koord(args.to ?? '53.6148,7.1621');
if (!args.station) { console.error('--station=lat,lon fehlt'); process.exit(1); }
const station = koord(args.station);

const apiKey = await resolveApiKey({ argumentKey: args.key, onNotice: console.error, onFatal: console.error });
if (!apiKey) process.exit(1);

async function route(punkte, mitVerkehr, departAt) {
  const pfad = punkte.map((p) => `${p.lat},${p.lon}`).join(':');
  const url = new URL(`${ev.BASE_URL}/routing/1/calculateRoute/${pfad}/json`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('routeType', 'fastest');
  url.searchParams.set('traffic', mitVerkehr ? 'true' : 'false');
  url.searchParams.set('travelMode', 'car');
  if (departAt) url.searchParams.set('departAt', departAt);
  await ev.sleep(ev.MIN_REQUEST_INTERVAL_MS);
  const r = await ev.requestWithRetry(fetch, url, {});
  if (!r.ok) throw new Error(`Routing ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const json = await r.json();
  const s = json.routes[0].summary;
  const points = json.routes[0].legs.flatMap((l) => l.points.map((p) => ({ lat: p.latitude, lon: p.longitude })));
  return { sekunden: s.travelTimeInSeconds, meter: s.lengthInMeters, verzoegerung: s.trafficDelayInSeconds ?? 0, points };
}

// Grundroute und Stuetzpunkte wie im Probelauf.
const ganze = await route([from, to], false);
const stuetzen = matrix.stuetzpunkte(ganze.points, ganze.sekunden);
const [lage] = corridor.orderAlongRoute([{ ...station, id: 'x' }], ganze.points, 20_000);
if (!lage) { console.error('Station liegt mehr als 20 km neben der Route.'); process.exit(1); }
const { davor, dahinter } = matrix.klammer(stuetzen, lage.progressMeters);
const a = stuetzen[davor];
const b = stuetzen[dahinter];
console.log(`Station bei km ${(lage.progressMeters / 1000).toFixed(1)}, ${Math.round(lage.distanceFromRouteMeters)} m neben der Route`);
console.log(`Abschnitt: Stuetzpunkt ${davor} (km ${(a.progressMeters / 1000).toFixed(0)}) bis ${dahinter} (km ${(b.progressMeters / 1000).toFixed(0)})\n`);

// Naechster Dienstag 10 Uhr: historische Verkehrslage ohne die Stoerungen
// von heute. Das ist der Kandidat fuer die Tabelle.
const dienstag = new Date();
dienstag.setDate(dienstag.getDate() + ((9 - dienstag.getDay()) % 7 || 7));
dienstag.setHours(10, 0, 0, 0);
const departAt = dienstag.toISOString();

const zeile = (name, grund, via) => {
  const umweg = via.sekunden - grund.sekunden;
  console.log(
    `${name.padEnd(30)} Grund ${String(grund.sekunden).padStart(5)} s / ${(grund.meter / 1000).toFixed(1)} km   ` +
      `via ${String(via.sekunden).padStart(5)} s / ${(via.meter / 1000).toFixed(1)} km   ` +
      `Umweg ${String(Math.round(umweg)).padStart(5)} s, ${((via.meter - grund.meter) / 1000).toFixed(1)} km` +
      (via.verzoegerung || grund.verzoegerung ? `   (Verzoegerung ${grund.verzoegerung}/${via.verzoegerung} s)` : '')
  );
};

zeile('ohne Verkehr', await route([a, b], false), await route([a, station, b], false));
zeile('mit Verkehr, jetzt', await route([a, b], true), await route([a, station, b], true));
zeile(`historisch, Di 10 Uhr`, await route([a, b], true, departAt), await route([a, station, b], true, departAt));
console.log('\n7 Anfragen an die Routing API.');
