#!/usr/bin/env node
// ev-route-probe.mjs
// Findet heraus, wie die Long Distance EV Routing API angesprochen werden will.
//
//   node tools/ev-route-probe.mjs
//   node tools/ev-route-probe.mjs --from=51.2560,6.6890 --to=53.6148,7.1621
//   node tools/ev-route-probe.mjs --nur=3
//
// Wozu ein Probelauf statt einfach die Doku lesen: Die Doku steht auf
// developer.tomtom.com, und von dort, wo dieser Code entsteht, ist die Seite
// nicht erreichbar. Geraten wird trotzdem nicht. Stattdessen werden mehrere
// Bauformen der Anfrage nacheinander abgeschickt; die API sagt in ihrer
// Fehlermeldung ziemlich genau, was ihr fehlt. Dasselbe Vorgehen hat schon den
// unbrauchbaren categorySet-Filter und das als 401 getarnte Tempolimit
// aufgedeckt.
//
// Der Endpunkt plant Ladestopps in die Route hinein, statt sie daneben zu
// suchen. Eine Anfrage statt neunundvierzig.

import { resolveApiKey } from './lib/apikey.mjs';
import * as ev from './lib/evsearch.mjs';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t) => wrap('1', t);
const dim = (t) => wrap('2', t);
const red = (t) => wrap('31', t);
const green = (t) => wrap('32', t);

const VORGABE = { from: '51.2560,6.6890', to: '53.6148,7.1621' };

// Ein Fahrzeug, mit dem sich die Strecke nicht ohne Stopp fahren laesst.
// Sonst plant die API keinen einzigen und der Probelauf zeigt nichts.
const FAHRZEUG = {
  usableBatteryKWh: 77,
  consumptionKWhPer100km: 19,
  maxChargePowerKW: 240,
  currentChargePercent: 80,
  minArrivalPercent: 10,
  minChargeAtStopPercent: 10,
  maxChargeAtStopPercent: 80,
};

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

function parseCoordinate(text, name) {
  const teile = String(text).split(',').map((t) => Number(t.trim()));
  if (teile.length !== 2 || teile.some((n) => !Number.isFinite(n))) {
    console.error(`${name} erwartet "lat,lon", bekam "${text}"`);
    process.exit(1);
  }
  return { lat: teile[0], lon: teile[1] };
}

/** Verbrauch ueber der Geschwindigkeit. Spiegelt VehicleProfile.consumptionTable. */
function verbrauchstabelle(kWhPro100km) {
  const stuetzstellen = [
    [30, 0.62], [50, 0.68], [80, 0.83], [100, 1.0], [120, 1.24], [130, 1.38],
  ];
  return stuetzstellen
    .map(([tempo, faktor]) => `${tempo},${(kWhPro100km * faktor).toFixed(2)}`)
    .join(':');
}

/** Ladekurve als Stuetzstellen. Spiegelt VehicleProfile.chargingCurve. */
function ladekurve(kapazitaetKWh, spitzeKW) {
  const punkte = [[0.0, 1.0], [0.2, 1.0], [0.4, 0.92], [0.6, 0.7], [0.8, 0.45], [1.0, 0.15]];
  let sekunden = 0;
  let letzteLadung = 0;
  return punkte.map(([anteil, faktor], i) => {
    const ladung = kapazitaetKWh * anteil;
    const leistung = Math.max(11, spitzeKW * faktor);
    if (i > 0) sekunden += ((ladung - letzteLadung) / leistung) * 3600;
    letzteLadung = ladung;
    return {
      chargeInkWh: Number(ladung.toFixed(2)),
      timeToChargeInSeconds: Math.round(sekunden),
    };
  });
}

function grundparameter(apiKey) {
  const f = FAHRZEUG;
  return {
    key: apiKey,
    vehicleEngineType: 'electric',
    constantSpeedConsumptionInkWhPerHundredkm: verbrauchstabelle(f.consumptionKWhPer100km),
    currentChargeInkWh: (f.usableBatteryKWh * f.currentChargePercent) / 100,
    maxChargeInkWh: f.usableBatteryKWh,
    minChargeAtDestinationInkWh: (f.usableBatteryKWh * f.minArrivalPercent) / 100,
    minChargeAtChargingStopsInkWh: (f.usableBatteryKWh * f.minChargeAtStopPercent) / 100,
  };
}

const KURVE = ladekurve(FAHRZEUG.usableBatteryKWh, FAHRZEUG.maxChargePowerKW);

/**
 * Die Bauformen, die geprueft werden.
 *
 * Von der kleinsten zur vollstaendigsten. Die erste beantwortet die Frage, ob
 * der Endpunkt fuer diesen Schluessel ueberhaupt freigeschaltet ist; erst
 * danach lohnt es, ueber Feldnamen nachzudenken.
 */
const VARIANTEN = [
  {
    name: 'ohne Rumpf',
    zweck: 'Ist der Endpunkt freigeschaltet und akzeptiert er die Parameter?',
    body: null,
  },
  {
    name: 'chargingModes mit Anschluss und Kurve',
    zweck: 'Die in der Doku beschriebene Form.',
    body: {
      chargingModes: [
        {
          chargingConnections: [
            { facilityType: 'Charge_200_to_240V_1_Phase_at_32A', plugType: 'IEC_62196_Type_2_Outlet' },
          ],
          chargingCurve: KURVE,
        },
      ],
    },
  },
  {
    name: 'chargingModes mit Schnellladeanschluss',
    zweck: 'CCS statt Typ 2, denn geladen wird an Schnellladern.',
    body: {
      chargingModes: [
        {
          chargingConnections: [
            { facilityType: 'Charge_50000W', plugType: 'IEC_62196_Type_2_CCS' },
          ],
          chargingCurve: KURVE,
        },
      ],
    },
  },
  {
    name: 'chargingModes nur mit Kurve',
    zweck: 'Sind die Anschlussangaben Pflicht?',
    body: { chargingModes: [{ chargingCurve: KURVE }] },
  },
];

async function versuch(apiKey, from, to, variante) {
  const url = new URL(
    `${ev.BASE_URL}/routing/1/calculateLongDistanceEVRoute/` +
      `${from.lat},${from.lon}:${to.lat},${to.lon}/json`
  );
  for (const [name, wert] of Object.entries(grundparameter(apiKey))) {
    url.searchParams.set(name, String(wert));
  }

  const optionen = variante.body
    ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(variante.body),
      }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };

  const antwort = await fetch(url, optionen);
  const text = await antwort.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Keine JSON-Antwort. Der Rohtext ist dann die Auskunft.
  }

  return { status: antwort.status, json, text };
}

function zeigeRoute(json) {
  const route = json.routes?.[0];
  if (!route) {
    console.log(red('  Antwort ohne Route.'));
    return;
  }

  const s = route.summary ?? {};
  console.log(
    `  ${bold(`${Math.round((s.lengthInMeters ?? 0) / 1000)} km`)}, ` +
      `${Math.round((s.travelTimeInSeconds ?? 0) / 60)} min Fahrt` +
      (s.totalChargingTimeInSeconds != null
        ? `, ${Math.round(s.totalChargingTimeInSeconds / 60)} min Laden`
        : '')
  );
  if (s.remainingChargeAtArrivalInkWh != null) {
    console.log(dim(`  Am Ziel noch ${s.remainingChargeAtArrivalInkWh.toFixed(1)} kWh`));
  }

  const legs = route.legs ?? [];
  console.log(`  ${legs.length} Etappe(n), also ${Math.max(0, legs.length - 1)} Ladestopp(s)`);

  legs.forEach((leg, i) => {
    const ls = leg.summary ?? {};
    const laden = ls.chargingInformationAtEndOfLeg;
    const km = Math.round((ls.lengthInMeters ?? 0) / 1000);
    let zeile = `    Etappe ${i + 1}: ${String(km).padStart(4)} km`;
    if (ls.remainingChargeAtArrivalInkWh != null) {
      zeile += `, Ankunft mit ${ls.remainingChargeAtArrivalInkWh.toFixed(1)} kWh`;
    }
    console.log(zeile);
    if (laden) {
      const name = laden.chargingStopDetails?.name ?? laden.name ?? '(ohne Namen)';
      const dauer = laden.chargingTimeInSeconds != null
        ? `${Math.round(laden.chargingTimeInSeconds / 60)} min`
        : '?';
      const ziel = laden.targetChargeInkWh != null
        ? `auf ${laden.targetChargeInkWh.toFixed(1)} kWh`
        : '';
      console.log(green(`      Laden: ${name}, ${dauer} ${ziel}`));
      // Einmal die Rohform zeigen, damit die Feldnamen fuer den Swift-Teil
      // feststehen und nicht noch einmal geraten werden muessen.
      if (i === 0) console.log(dim('      ' + JSON.stringify(laden).slice(0, 400)));
    }
  });
}

/**
 * Prueft die Reichweiten-API.
 *
 * Sie steht im Selbstbedienungskatalog und ist fuer den Schluessel bereits
 * freigeschaltet. Sie beantwortet genau die Frage, wie weit das Fahrzeug mit
 * dem aktuellen Ladestand kommt, und liefert die Antwort als Flaeche. Damit
 * laesst sich die Suche nach Ladestationen auf den Abschnitt begrenzen, der
 * ueberhaupt erreichbar ist, statt die ganze Strecke abzugrasen.
 */
async function reichweite(apiKey, from) {
  const f = FAHRZEUG;
  const budget = (f.usableBatteryKWh * (f.currentChargePercent - f.minArrivalPercent)) / 100;

  const url = new URL(
    `${ev.BASE_URL}/routing/1/calculateReachableRange/${from.lat},${from.lon}/json`
  );
  url.searchParams.set('key', apiKey);
  url.searchParams.set('vehicleEngineType', 'electric');
  url.searchParams.set('energyBudgetInkWh', String(budget.toFixed(2)));
  url.searchParams.set(
    'constantSpeedConsumptionInkWhPerHundredkm',
    verbrauchstabelle(f.consumptionKWhPer100km)
  );

  const antwort = await fetch(url);
  const text = await antwort.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Rohtext ist dann die Auskunft.
  }
  return { status: antwort.status, json, text, budget };
}

function zeigeReichweite(json, from, budget) {
  const grenze = json?.reachableRange?.boundary;
  if (!Array.isArray(grenze) || grenze.length === 0) {
    console.log(red('  Antwort ohne Grenzlinie.'));
    return;
  }

  // Wie weit reicht es? Groesster Abstand vom Startpunkt, grob ueber die
  // Kugeloberflaeche.
  const R = 6371000;
  const rad = (g) => (g * Math.PI) / 180;
  let weiteste = 0;
  for (const punkt of grenze) {
    const dLat = rad(punkt.latitude - from.lat);
    const dLon = rad(punkt.longitude - from.lon);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(from.lat)) * Math.cos(rad(punkt.latitude)) * Math.sin(dLon / 2) ** 2;
    const d = 2 * R * Math.asin(Math.sqrt(a));
    if (d > weiteste) weiteste = d;
  }

  console.log(
    `  ${bold(`${Math.round(weiteste / 1000)} km`)} in der weitesten Richtung, ` +
      `mit ${budget.toFixed(1)} kWh Budget`
  );
  console.log(dim(`  Grenzlinie aus ${grenze.length} Punkten`));
}

async function main() {
  const args = parseArgs(process.argv);
  const from = parseCoordinate(args.from ?? VORGABE.from, '--from');
  const to = parseCoordinate(args.to ?? VORGABE.to, '--to');

  const apiKey = await resolveApiKey({
    argumentKey: args.key,
    onFatal: (text) => console.error(red(text)),
  });
  if (!apiKey) process.exit(1);

  console.log(bold('Long Distance EV Routing, Bauformen prüfen'));
  console.log(
    dim(
      `${from.lat},${from.lon} nach ${to.lat},${to.lon}, ` +
        `${FAHRZEUG.usableBatteryKWh} kWh, ${FAHRZEUG.consumptionKWhPer100km} kWh/100 km`
    )
  );

  const nur = args.nur ? Number(args.nur) : null;
  let erfolgreich = 0;

  for (const [index, variante] of VARIANTEN.entries()) {
    if (nur && index + 1 !== nur) continue;

    console.log(`\n${bold(`${index + 1}. ${variante.name}`)}`);
    console.log(dim(`   ${variante.zweck}`));

    // Tempolimit einhalten, sonst kommt 401 statt einer echten Antwort.
    await new Promise((r) => setTimeout(r, ev.MIN_REQUEST_INTERVAL_MS));

    try {
      const { status, json, text } = await versuch(apiKey, from, to, variante);

      if (status >= 200 && status < 300) {
        console.log(green(`  HTTP ${status}`));
        zeigeRoute(json ?? {});
        erfolgreich++;
      } else {
        console.log(red(`  HTTP ${status}`));
        const meldung =
          json?.error?.description ??
          json?.detailedError?.message ??
          json?.message ??
          text.slice(0, 400);
        console.log(`  ${meldung}`);
        if (json?.detailedError?.details) {
          console.log(dim('  ' + JSON.stringify(json.detailedError.details).slice(0, 400)));
        }
      }
    } catch (fehler) {
      console.log(red(`  Anfrage fehlgeschlagen: ${fehler.message}`));
    }
  }

  // --- Reichweite ------------------------------------------------------

  console.log(`\n${bold('5. Reichweite (calculateReachableRange)')}`);
  console.log(dim('   Steht im Selbstbedienungskatalog. Wie weit kommt das Fahrzeug?'));
  await new Promise((r) => setTimeout(r, ev.MIN_REQUEST_INTERVAL_MS));

  try {
    const { status, json, text, budget } = await reichweite(apiKey, from);
    if (status >= 200 && status < 300) {
      console.log(green(`  HTTP ${status}`));
      zeigeReichweite(json, from, budget);
      console.log(
        dim('  Damit laesst sich die Stationssuche auf das Erreichbare begrenzen.')
      );
    } else {
      console.log(red(`  HTTP ${status}`));
      console.log(
        `  ${json?.error?.description ?? json?.detailedError?.message ?? text.slice(0, 300)}`
      );
    }
  } catch (fehler) {
    console.log(red(`  Anfrage fehlgeschlagen: ${fehler.message}`));
  }

  console.log('');
  if (erfolgreich === 0) {
    console.log(
      red('Keine Bauform hat funktioniert.') +
        ' Die Fehlermeldungen oben sagen, woran es liegt.'
    );
    console.log(
      dim(
        'Bei 403 ist der Endpunkt fuer den Schluessel nicht freigeschaltet.\n' +
          'Long Distance EV Routing steht nicht im Selbstbedienungskatalog;\n' +
          'am ehesten verbirgt es sich hinter "Extended Routing API". Steht es\n' +
          'auch danach nicht zur Verfuegung, planen wir die Ladestopps selbst,\n' +
          'aus Fahrzeugprofil, Reichweite und Stationsliste.'
      )
    );
  } else {
    console.log(green(`${erfolgreich} von ${VARIANTEN.length} Bauformen akzeptiert.`));
    console.log(dim('Die einfachste davon wandert in den Swift-Code.'));
  }
}

main();
