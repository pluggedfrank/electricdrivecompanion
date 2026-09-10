#!/usr/bin/env node
// matrix-probe.mjs
// Findet heraus, wie die Matrix-Routing-API angesprochen werden will.
//
//   node tools/matrix-probe.mjs
//   node tools/matrix-probe.mjs --gross
//
// Wozu: Der Umweg zu einer Ladestation ist die Fahrzeit vom Verlassen der Route
// bis zum Wiederauffahren. Die Along-Route-Suche liefert ihn mit, die
// Umkreissuche nicht, und die bringt den groesseren Teil der Treffer. In der
// App wirkt der Umwegregler dadurch nur auf ein Viertel der Liste.
//
// Je Station eine eigene Route zu rechnen waere exakt und bei zweihundert
// Stationen zu teuer. Die Matrix-API rechnet viele Verbindungen auf einmal.
// Was sie genau erwartet und wie gross eine Anfrage sein darf, sagt sie selbst;
// die Doku steht auf zwei Domains, die von hier aus gesperrt sind.

import { resolveApiKey } from './lib/apikey.mjs';
import * as ev from './lib/evsearch.mjs';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (t) => wrap('1', t);
const dim = (t) => wrap('2', t);
const red = (t) => wrap('31', t);
const green = (t) => wrap('32', t);

/** Ein paar Punkte auf und neben der A31, damit die Zahlen plausibel sind. */
const AUF_ROUTE = [
  { lat: 51.5030, lon: 6.5448 },
  { lat: 51.9548, lon: 7.0051 },
  { lat: 52.5194, lon: 7.1326 },
];
const ABSEITS = [
  { lat: 51.5089, lon: 6.5510 },
  { lat: 51.9601, lon: 7.0140 },
  { lat: 52.5250, lon: 7.1400 },
  { lat: 52.6000, lon: 7.2000 },
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

/**
 * Die Bauformen, die geprueft werden.
 *
 * Die Matrix-API gibt es in zwei Fassungen mit verschiedenen Pfaden und, so
 * die Vermutung, verschiedenen Rumpfformaten. Welche der Schluessel darf und
 * welche Form sie will, beantwortet die API in ihren Fehlermeldungen.
 */
function varianten(apiKey) {
  const punkt = (p) => ({ point: { latitude: p.lat, longitude: p.lon } });

  return [
    {
      name: 'v2, origins und destinations mit point',
      url: `${ev.BASE_URL}/routing/matrix/2?key=${apiKey}&routeType=fastest&travelMode=car`,
      body: {
        origins: AUF_ROUTE.map(punkt),
        destinations: ABSEITS.map(punkt),
      },
    },
    {
      name: 'v2, mit options fuer die Ausgabe',
      url: `${ev.BASE_URL}/routing/matrix/2?key=${apiKey}`,
      body: {
        origins: AUF_ROUTE.map(punkt),
        destinations: ABSEITS.map(punkt),
        options: { routeType: 'fastest', travelMode: 'car', traffic: 'live' },
      },
    },
    {
      name: 'v1 synchron',
      url:
        `${ev.BASE_URL}/routing/matrix/1/json?key=${apiKey}` +
        '&routeType=fastest&travelMode=car',
      body: {
        origins: AUF_ROUTE.map(punkt),
        destinations: ABSEITS.map(punkt),
      },
    },
  ];
}

/** Zeigt, was in der Antwort steckt, ohne sie ganz auszuschuetten. */
function zeigeAntwort(json) {
  const schluessel = Object.keys(json ?? {});
  console.log(dim(`  Felder der Antwort: ${schluessel.join(', ')}`));

  // Die Zellen stecken je nach Fassung woanders. Beide Wege probieren.
  const zellen = json?.data ?? json?.matrix?.flat() ?? null;
  if (!Array.isArray(zellen) || zellen.length === 0) {
    console.log(dim('  ' + JSON.stringify(json).slice(0, 500)));
    return;
  }

  console.log(`  ${bold(String(zellen.length))} Zellen`);
  console.log(dim('  erste Zelle: ' + JSON.stringify(zellen[0]).slice(0, 300)));

  // Fahrzeiten herausziehen, egal wie tief sie liegen.
  const zeiten = zellen
    .map((z) => z?.routeSummary?.travelTimeInSeconds ?? z?.travelTimeInSeconds)
    .filter((t) => typeof t === 'number');

  if (zeiten.length > 0) {
    const min = Math.min(...zeiten);
    const max = Math.max(...zeiten);
    console.log(
      green(
        `  Fahrzeiten von ${Math.round(min / 60)} bis ${Math.round(max / 60)} min ` +
          `in ${zeiten.length} Zellen`
      )
    );
  }
}

async function versuch(variante) {
  const antwort = await fetch(variante.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(variante.body),
  });
  const text = await antwort.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Kein JSON. Dann ist der Rohtext die Auskunft.
  }
  return { status: antwort.status, json, text };
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = await resolveApiKey({
    argumentKey: args.key,
    onFatal: (text) => console.error(red(text)),
  });
  if (!apiKey) process.exit(1);

  console.log(bold('Matrix Routing, Bauformen prüfen'));
  console.log(dim(`${AUF_ROUTE.length} Startpunkte, ${ABSEITS.length} Ziele`));

  let gelungen = null;

  for (const [index, variante] of varianten(apiKey).entries()) {
    console.log(`\n${bold(`${index + 1}. ${variante.name}`)}`);
    await new Promise((r) => setTimeout(r, ev.MIN_REQUEST_INTERVAL_MS));

    try {
      const { status, json, text } = await versuch(variante);
      if (status >= 200 && status < 300) {
        console.log(green(`  HTTP ${status}`));
        zeigeAntwort(json);
        if (!gelungen) gelungen = variante;
      } else {
        console.log(red(`  HTTP ${status}`));
        const meldung =
          json?.error?.description ??
          json?.detailedError?.message ??
          json?.message ??
          text.slice(0, 300);
        console.log(`  ${meldung}`);
      }
    } catch (fehler) {
      console.log(red(`  Anfrage fehlgeschlagen: ${fehler.message}`));
    }
  }

  // --- Wie gross darf eine Anfrage sein? ---------------------------------

  if (gelungen && args.gross) {
    console.log(`\n${bold('Grösse der Anfrage')}`);
    console.log(dim('   Wie viele Zellen nimmt die API an?'));

    for (const [starts, ziele] of [[10, 20], [25, 40], [50, 100]]) {
      await new Promise((r) => setTimeout(r, ev.MIN_REQUEST_INTERVAL_MS));

      // Punkte auf einem Raster ueber Nordwestdeutschland, nur zum Zaehlen.
      const raster = (anzahl, versatz) =>
        Array.from({ length: anzahl }, (_, i) => ({
          point: {
            latitude: 51.5 + (i % 20) * 0.05 + versatz,
            longitude: 6.6 + Math.floor(i / 20) * 0.05,
          },
        }));

      const probe = {
        ...gelungen,
        body: { ...gelungen.body, origins: raster(starts, 0), destinations: raster(ziele, 0.01) },
      };

      try {
        const { status, json, text } = await versuch(probe);
        const zellen = starts * ziele;
        if (status >= 200 && status < 300) {
          console.log(green(`  ${starts} x ${ziele} = ${zellen} Zellen: angenommen`));
        } else {
          const meldung =
            json?.error?.description ?? json?.detailedError?.message ?? text.slice(0, 200);
          console.log(red(`  ${starts} x ${ziele} = ${zellen} Zellen: HTTP ${status}`));
          console.log(`    ${meldung}`);
        }
      } catch (fehler) {
        console.log(red(`  ${starts} x ${ziele}: ${fehler.message}`));
      }
    }
  } else if (gelungen) {
    console.log(dim('\n--gross prüft zusätzlich, wie viele Zellen die API annimmt.'));
  }

  console.log('');
  if (!gelungen) {
    console.log(red('Keine Bauform hat funktioniert.'));
    console.log(
      dim(
        'Bei 403: "Matrix Routing v2 API" im Dashboard unter Products anhaken.\n' +
          'Sie steht im Selbstbedienungskatalog.'
      )
    );
  } else {
    console.log(green(`Angenommen wird: ${gelungen.name}`));
  }
}

main();
