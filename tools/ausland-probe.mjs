#!/usr/bin/env node
// ausland-probe.mjs
// Stellt die Stationssuche der App auf einer Route ins Ausland nach und sagt,
// woran die Ladeplanung dort scheitert.
//
//   node tools/ausland-probe.mjs                              Meerbusch nach Rom
//   node tools/ausland-probe.mjs --to=52.3676,4.9041          nach Amsterdam
//   node tools/ausland-probe.mjs --stufen=150,300 --umweg=5 --abstand=2
//   node tools/ausland-probe.mjs --vergleich=4                bis zu vier volle
//        Abschnitte zusaetzlich mit der Stufe selbst als Serverfilter fragen
//
// Was die App tut (TripViewModel.searchStations und addForeignStations):
// Register fuer Deutschland, dazu die Along-Route-Suche von TomTom fuer die
// Stuecke ausserhalb, mit minPowerKW=50 (fetchTier), 50-km-Abschnitten und
// hoechstens 20 Treffern je Abschnitt. Danach die lokalen Filter
// (applyLocalFilters: Leistung, seitlicher Abstand, Umweg) und die Planung
// (ChargingStopPlanner, hier ladeplanung.mjs).
//
// Genau das rechnet dieser Lauf nach und gibt je Land aus: Treffer,
// Leistungsverteilung, Betreiber, detourTime, und die groesste Luecke
// zwischen zwei Stationen, die die Planung nehmen wuerde.
//
// Kosten: eine Routing-Anfrage, dazu eine Search-Anfrage je 50 km Ausland
// (Rom: gut zwanzig), plus --vergleich. Statt --key=... kann TOMTOM_API_KEY
// gesetzt sein.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ev from './lib/evsearch.mjs';
import * as corridor from './lib/corridor.mjs';
import * as ladeplanung from './lib/ladeplanung.mjs';
import * as quellen from './lib/quellen.mjs';
import * as registerquelle from './lib/registerquelle.mjs';
import { distance, downsample, perpendicularDistance, splitIntoSegments } from './lib/geo.mjs';
import { resolveApiKey } from './lib/apikey.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  from: '51.2560,6.6890',
  to: '41.9028,12.4964',
  stufen: '150,300',
  // Die Vorgaben der App: 5 min Umweg, 2 km seitlich.
  umweg: '5',
  abstand: '2',
  vergleich: '0',
  daten: 'daten/standorte-150kw.json',
};

// Wie TripViewModel: Suche mit 50 kW, aufgehoben wird bis 10 km neben der Route.
const FETCH_KW = 50;
const KEEP_M = 10_000;
const SUCH_UMWEG_S = 30 * 60;

// VehicleProfile.standard, Ladekurve wie VehicleProfile.chargingCurve.
const FAHRZEUG = (() => {
  const k = 77;
  const spitze = 240;
  return {
    usableBatteryKWh: k,
    consumptionKWhPer100km: 19,
    maxChargePowerKW: spitze,
    currentChargePercent: 80,
    minArrivalPercent: 10,
    minChargeAtStopPercent: 10,
    maxChargeAtStopPercent: 80,
    chargingCurve: [[0, 1], [0.2, 1], [0.4, 0.92], [0.6, 0.7], [0.8, 0.45], [1, 0.15]].map(
      ([anteil, leistung]) => ({ chargeKWh: k * anteil, powerKW: Math.max(11, spitze * leistung) })
    ),
  };
})();

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (const arg of argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) {
      console.error(`Unbekanntes Argument: ${arg}`);
      process.exit(1);
    }
    args[m[1]] = m[2] ?? true;
  }
  return args;
}

function punkt(text) {
  const [lat, lon] = String(text).split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.error(`Erwartet "lat,lon", bekam "${text}"`);
    process.exit(1);
  }
  return { lat, lon };
}

const km = (m) => (m / 1000).toFixed(0);
const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const quantil = (xs, q) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// ------------------------------------------------------------- Routing

async function planeRoute(apiKey, from, to) {
  const url = new URL(`${ev.BASE_URL}/routing/1/calculateRoute/${from.lat},${from.lon}:${to.lat},${to.lon}/json`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('routeType', 'fastest');
  url.searchParams.set('traffic', 'false');
  url.searchParams.set('travelMode', 'car');
  url.searchParams.set('sectionType', 'country');

  const response = await ev.requestWithRetry(fetch, url, {});
  if (!response.ok) throw new Error(`Routing antwortet mit ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const route = (await response.json()).routes?.[0];
  if (!route) throw new Error('Routing liefert keine Route.');

  const punkte = (route.legs ?? []).flatMap((leg) => (leg.points ?? []).map((p) => ({ lat: p.latitude, lon: p.longitude })));
  const abschnitte = (route.sections ?? [])
    .filter((s) => s.sectionType === 'COUNTRY')
    .map((s) => ({ von: s.startPointIndex, bis: s.endPointIndex, land: s.countryCode }));
  return {
    punkte,
    abschnitte,
    laengeM: route.summary.lengthInMeters,
    dauerS: route.summary.travelTimeInSeconds,
  };
}

// -------------------------------------------------------------- Search

/** Eine Along-Route-Anfrage wie TomTomAPIClient.searchSegment, Fehler als Wert. */
async function sucheAbschnitt(apiKey, punkte, minPowerKW) {
  const optionen = { maxDetourSeconds: SUCH_UMWEG_S, minPowerKW };
  const start = Date.now();
  const response = await ev.requestWithRetry(fetch, ev.buildAlongRouteURL(apiKey, optionen), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ev.buildRouteBody(punkte)),
  });
  const ms = Date.now() - start;
  if (!response.ok) {
    return { fehler: `HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`, ms };
  }
  const json = await response.json();
  const roh = (json.results ?? []).length;
  const alle = (json.results ?? []).map(ev.toChargingStation);
  const ev_ = alle.filter(ev.isChargingStation);
  const stationen = ev.parseAlongRouteResponse(json, optionen);
  return { roh, ev: ev_.length, stationen, ms };
}

// ---------------------------------------------------------- Auswertung

function kumuliert(punkte) {
  const k = [0];
  for (let i = 1; i < punkte.length; i++) k[i] = k[i - 1] + distance(punkte[i - 1], punkte[i]);
  return k;
}

/** Land am Wegpunkt `meter`, aus den Laenderabschnitten. */
function landBei(meter, abschnitte, kum) {
  for (const a of abschnitte) {
    if (meter >= kum[a.von] && meter <= kum[a.bis]) return a.land;
  }
  return '???';
}

/** Abstand zum naechsten Stuetzpunkt (so rechnet GeoUtils.orderAlongRoute) und zur Linie. */
function abstaende(station, punkte) {
  let best = Infinity;
  let bestI = 0;
  for (let i = 0; i < punkte.length; i++) {
    const d = distance(punkte[i], station);
    if (d < best) { best = d; bestI = i; }
  }
  let linie = best;
  for (let i = Math.max(1, bestI - 60); i < Math.min(punkte.length, bestI + 60); i++) {
    linie = Math.min(linie, perpendicularDistance(station, punkte[i - 1], punkte[i]));
  }
  return { stuetzpunkt: best, linie, index: bestI };
}

function leistungsklasse(kw) {
  if (kw == null) return 'unbekannt';
  if (kw >= 300) return '>=300';
  if (kw >= 150) return '150-299';
  if (kw >= 50) return '50-149';
  return '<50';
}

/** Die Luecken zwischen aufeinanderfolgenden Stationen, Start und Ziel eingeschlossen. */
function luecken(stationen, laengeM) {
  const orte = [0, ...stationen.map((s) => s.progressMeters).sort((a, b) => a - b), laengeM];
  const liste = [];
  for (let i = 1; i < orte.length; i++) liste.push({ von: orte[i - 1], bis: orte[i], laenge: orte[i] - orte[i - 1] });
  return liste.sort((a, b) => b.laenge - a.laenge);
}

function planText(plan) {
  const stopps = plan.stopps.map((s) => `km ${km(s.progressMeters)} ${s.station.name} (${s.station.land}, ${s.station.maxPowerKW ?? '?'} kW)`).join(' | ');
  if (plan.machbar) return `geht auf, ${plan.stopps.length} Stopps: ${stopps}`;
  const l = plan.luecke;
  const grund = plan.grund === 'keineStationen'
    ? 'keineStationen ("Auf dieser Strecke steht keine Station, die den Filter erfuellt")'
    : plan.grund === 'luecke'
      ? `Luecke km ${km(l.vonMeter)} bis km ${km(l.bisMeter)}, ${km(l.fehlendeMeter)} km zu viel`
      : plan.grund;
  return `GEHT NICHT AUF: ${grund}. Stopps bis dahin: ${stopps || 'keine'}`;
}

// ---------------------------------------------------------------- Lauf

async function main() {
  const args = parseArgs(process.argv);
  const from = punkt(args.from);
  const to = punkt(args.to);
  const stufen = String(args.stufen).split(',').map(Number).filter((n) => n > 0);
  const umwegS = Number(args.umweg) * 60;
  const abstandM = Number(args.abstand) * 1000;
  const vergleich = Number(args.vergleich) || 0;

  const apiKey = await resolveApiKey({ argumentKey: args.key });
  if (!apiKey) process.exit(1);

  // --- Route
  const route = await planeRoute(apiKey, from, to);
  const kum = kumuliert(route.punkte);
  console.log(`Route ${args.from} -> ${args.to}: ${km(route.laengeM)} km, ${(route.dauerS / 3600).toFixed(1)} h, ${route.punkte.length} Punkte`);
  const abstandStuetz = route.punkte.slice(1).map((p, i) => distance(route.punkte[i], p));
  console.log(`Stuetzpunktabstand: Median ${median(abstandStuetz).toFixed(0)} m, p99 ${quantil(abstandStuetz, 0.99).toFixed(0)} m, max ${Math.max(...abstandStuetz).toFixed(0)} m`);
  console.log('Laender:');
  for (const a of route.abschnitte) {
    console.log(`  ${a.land}  km ${km(kum[a.von])} bis ${km(kum[a.bis])}  (${km(kum[a.bis] - kum[a.von])} km)`);
  }
  if (route.abschnitte.length === 0) console.log('  KEINE Laenderabschnitte in der Antwort.');

  // --- Auslandsstuecke wie StationSources.foreignPieces
  const stuecke = quellen.auslandsStuecke(route.punkte, route.abschnitte);
  console.log(`\nAuslandsstuecke: ${stuecke.length}`);
  for (const [i, s] of stuecke.entries()) {
    const segs = splitIntoSegments(s, 50_000);
    console.log(`  Stueck ${i + 1}: ${km(kum[route.punkte.indexOf(s[0])] ?? 0)} bis ${km(kum[route.punkte.lastIndexOf(s.at(-1))] ?? 0)} km, ${segs.length} Abschnitte = ${segs.length} Search-Anfragen`);
  }

  // --- Register wie RegisterStore.stations(along:)
  const register = registerquelle.ladeStandorte(join(here, '..', args.daten));
  const regEntlang = registerquelle.entlangDerRoute(register.stationen, route.punkte, KEEP_M);
  console.log(`\nRegister (${register.meta.leistungAbKW} kW ab): ${regEntlang.length} Standorte bis 10 km neben der Route`);

  // --- TomTom auf den Auslandsstuecken, wie addForeignStations
  console.log(`\nTomTom searchAlongRoute, minPowerKW=${FETCH_KW}, maxDetourTime=${SUCH_UMWEG_S}, limit 20, je 50 km:`);
  const projektor = corridor.createRouteProjector(route.punkte);
  const tomtom = new Map();
  const volle = [];
  let anfragen = 0;
  const fehlerJeStueck = [];
  let kontingentLeer = false;
  for (const [si, stueck] of stuecke.entries()) {
    if (kontingentLeer) break;
    const segs = splitIntoSegments(stueck, 50_000);
    let fehler = 0;
    for (const [i, seg] of segs.entries()) {
      if (anfragen > 0) await ev.sleep(ev.MIN_REQUEST_INTERVAL_MS);
      const pts = downsample(seg, 200);
      const ergebnis = await sucheAbschnitt(apiKey, pts, FETCH_KW);
      anfragen++;
      const startKm = km(projektor.project(seg[0])?.progressMeters ?? 0);
      if (ergebnis.fehler) {
        fehler++;
        console.log(`  S${si + 1}/${i + 1} ab km ${startKm}: FEHLER ${ergebnis.fehler} (${ergebnis.ms} ms)`);
        // Kontingent leer: Jede weitere Anfrage scheitert genauso. So sieht
        // es auch die App, nur sagt sie es nicht (Lauf vom 30.09.2026).
        if (/InsufficientFunds/.test(ergebnis.fehler)) {
          console.log('  Search-Kontingent aufgebraucht, Suche abgebrochen.');
          kontingentLeer = true;
          break;
        }
        continue;
      }
      const leist = ergebnis.stationen.map((s) => ev.maxPowerKW(s));
      const ab150 = leist.filter((p) => p != null && p >= 150).length;
      const ab300 = leist.filter((p) => p != null && p >= 300).length;
      const unbek = leist.filter((p) => p == null).length;
      console.log(`  S${si + 1}/${i + 1} ab km ${startKm}: roh ${ergebnis.roh}, Laden ${ergebnis.ev}, behalten ${ergebnis.stationen.length} (>=150: ${ab150}, >=300: ${ab300}, Leistung unbekannt: ${unbek}), ${ergebnis.ms} ms`);
      if (ergebnis.roh >= 20) volle.push({ si, i, pts, startKm });
      for (const s of ergebnis.stationen) if (!tomtom.has(s.id)) tomtom.set(s.id, { ...s, segment: `S${si + 1}/${i + 1}` });
    }
    fehlerJeStueck.push(fehler);
  }
  console.log(`Search-Anfragen: ${anfragen}. Abschnitte mit 20 Treffern (Limit erreicht): ${volle.length}.`);
  for (const [i, f] of fehlerJeStueck.entries()) {
    if (f > 0) console.log(`  Stueck ${i + 1}: ${f} Fehler. In der App wirft der erste Fehler das GANZE Stueck weg (addForeignStations faengt je Stueck).`);
  }

  // --- Zusammenlegen und einordnen wie StationSources.merge + orderAlongRoute
  const tt = [...tomtom.values()].map((s) => ({ ...s, maxPowerKW: ev.maxPowerKW(s), quelle: 'tomtom' }));
  const zusammen = quellen.zusammenfuehren(regEntlang, tt);
  const geordnet = corridor.orderAlongRoute(zusammen, route.punkte, KEEP_M).map((s) => {
    const a = abstaende(s, route.punkte);
    return {
      ...s,
      // Die App nimmt den naechsten Stuetzpunkt, nicht die Linie.
      distanceFromRouteMeters: a.stuetzpunkt,
      linienAbstand: a.linie,
      land: landBei(s.progressMeters, route.abschnitte, kum),
    };
  });
  console.log(`\nZusammen: ${geordnet.length} Stationen bis 10 km (Register ${geordnet.filter((s) => s.quelle === 'register').length}, TomTom ${geordnet.filter((s) => s.quelle === 'tomtom').length}; ${tt.length - geordnet.filter((s) => s.quelle === 'tomtom').length} TomTom-Treffer als Dublette oder > 10 km weg)`);

  // --- Je Land
  const laender = [...new Set(route.abschnitte.map((a) => a.land))];
  console.log('\nJe Land (TomTom-Treffer):');
  for (const land of laender) {
    const hier = geordnet.filter((s) => s.land === land && s.quelle === 'tomtom');
    const reg = geordnet.filter((s) => s.land === land && s.quelle === 'register').length;
    if (hier.length === 0 && reg === 0) { console.log(`  ${land}: nichts`); continue; }
    const klassen = {};
    for (const s of hier) klassen[leistungsklasse(s.maxPowerKW)] = (klassen[leistungsklasse(s.maxPowerKW)] ?? 0) + 1;
    const umwege = hier.map((s) => s.detourSeconds).filter((d) => d != null);
    const betreiber = {};
    for (const s of hier) {
      const name = s.operatorName ?? s.name;
      betreiber[name] ??= { n: 0, kw: 0 };
      betreiber[name].n++;
      betreiber[name].kw = Math.max(betreiber[name].kw, s.maxPowerKW ?? 0);
    }
    console.log(`  ${land}: TomTom ${hier.length}, Register ${reg}`);
    if (hier.length === 0) continue;
    console.log(`    Leistung: ${Object.entries(klassen).map(([k, n]) => `${k}: ${n}`).join(', ')}`);
    console.log(`    detourTime: bekannt ${umwege.length}, Median ${median(umwege)} s, p90 ${quantil(umwege, 0.9)} s, > ${umwegS} s: ${umwege.filter((d) => d > umwegS).length}`);
    console.log(`    Abstand Stuetzpunkt: Median ${median(hier.map((s) => s.distanceFromRouteMeters)).toFixed(0)} m, > ${abstandM} m: ${hier.filter((s) => s.distanceFromRouteMeters > abstandM).length} (Linie > ${abstandM} m: ${hier.filter((s) => s.linienAbstand > abstandM).length})`);
    console.log(`    Betreiber: ${Object.entries(betreiber).sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([n, v]) => `${n} ${v.n}x/${v.kw || '?'}kW`).join(', ')}`);
  }

  // --- Je Stufe: Liste, Planung, Luecken
  for (const stufe of stufen) {
    console.log(`\n=== Stufe ${stufe} kW, Umweg ${umwegS / 60} min, Abstand ${abstandM / 1000} km ===`);
    // applyLocalFilters: unbekannte Leistung bleibt, Umweg nur, wo bekannt.
    const liste = geordnet.filter((s) =>
      ev.meetsMinPower({ connectors: s.quelle === 'register' ? [{ ratedPowerKW: s.maxPowerKW }] : s.connectors }, stufe) &&
      s.distanceFromRouteMeters <= abstandM &&
      !(s.detourSeconds != null && s.detourSeconds > umwegS));
    // ChargingStopPlanner: (maxPowerKW ?? 0) >= minPower
    const planbar = liste.filter((s) => (s.maxPowerKW ?? 0) >= stufe);
    for (const land of laender) {
      const a = geordnet.filter((s) => s.land === land);
      const ohneUmweg = a.filter((s) => s.quelle === 'tomtom' && s.maxPowerKW != null && s.maxPowerKW >= stufe && s.distanceFromRouteMeters <= abstandM && s.detourSeconds > umwegS).length;
      const zuWeit = a.filter((s) => s.quelle === 'tomtom' && s.maxPowerKW != null && s.maxPowerKW >= stufe && s.distanceFromRouteMeters > abstandM).length;
      console.log(`  ${land}: stark genug ${a.filter((s) => (s.maxPowerKW ?? 0) >= stufe).length}, in der Liste ${liste.filter((s) => s.land === land).length}, fuer die Planung ${planbar.filter((s) => s.land === land).length}  (raus wegen Umweg ${ohneUmweg}, wegen Abstand ${zuWeit})`);
    }
    const reichweite = (FAHRZEUG.usableBatteryKWh * (FAHRZEUG.maxChargeAtStopPercent - FAHRZEUG.minChargeAtStopPercent) / 100) / (FAHRZEUG.consumptionKWhPer100km / 100_000);
    console.log(`  Reichweite nach einem Stopp (10 -> 80 %): ${km(reichweite)} km`);
    console.log('  Groesste Luecken zwischen planbaren Stationen:');
    for (const l of luecken(planbar, route.laengeM).slice(0, 5)) {
      console.log(`    ${km(l.laenge)} km: km ${km(l.von)} (${landBei(l.von, route.abschnitte, kum)}) bis km ${km(l.bis)} (${landBei(l.bis, route.abschnitte, kum)})${l.laenge > reichweite ? '  ZU LANG' : ''}`);
    }

    const varianten = [
      ['wie die App', planbar],
      ['ohne Umwegfilter', geordnet.filter((s) => (s.maxPowerKW ?? 0) >= stufe && s.distanceFromRouteMeters <= abstandM)],
      ['ohne Umweg- und Abstandsfilter', geordnet.filter((s) => (s.maxPowerKW ?? 0) >= stufe)],
    ];
    for (const [name, stationen] of varianten) {
      const plan = ladeplanung.planeStopps({ routeLengthMeters: route.laengeM, stations: stationen, fahrzeug: FAHRZEUG, minPowerKW: stufe });
      console.log(`  Planung ${name} (${stationen.length} Kandidaten): ${planText(plan)}`);
    }
  }

  // --- Vergleich: verdraengen 50-kW-Saeulen im 20er-Limit die schnellen?
  if (vergleich > 0 && volle.length > 0 && !kontingentLeer) {
    const stufe = Math.min(...stufen);
    console.log(`\nVergleich auf ${Math.min(vergleich, volle.length)} vollen Abschnitten, Serverfilter ${stufe} statt ${FETCH_KW} kW:`);
    for (const v of volle.slice(0, vergleich)) {
      await ev.sleep(ev.MIN_REQUEST_INTERVAL_MS);
      const ergebnis = await sucheAbschnitt(apiKey, v.pts, stufe);
      if (ergebnis.fehler) { console.log(`  S${v.si + 1}/${v.i + 1}: FEHLER ${ergebnis.fehler}`); continue; }
      const neu = ergebnis.stationen.filter((s) => !tomtom.has(s.id) && (ev.maxPowerKW(s) ?? 0) >= stufe);
      console.log(`  S${v.si + 1}/${v.i + 1} ab km ${v.startKm}: ${ergebnis.stationen.length} Treffer, davon ${neu.length} mit >= ${stufe} kW, die die 50-kW-Suche nicht hatte${neu.length ? ': ' + neu.map((s) => `${s.operatorName ?? s.name} ${ev.maxPowerKW(s)} kW`).join(', ') : ''}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
