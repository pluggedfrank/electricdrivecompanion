// matrix.mjs
// Rechnet Umwege zu Ladestationen mit der Matrix-Routing-API.
//
// Der Umweg ist die Fahrzeit vom Verlassen der Route bis zum Wiederauffahren.
// Die Along-Route-Suche liefert ihn mit, die Umkreissuche nicht, und die bringt
// den groesseren Teil der Treffer. Ohne diesen Wert steht in der App die
// Luftlinie, und die sagt ueber die Fahrzeit fast nichts: Eine Saeule 200 Meter
// neben der Autobahn kann zehn Kilometer Umweg bedeuten, wenn die naechste
// Abfahrt weit weg ist.
//
// Je Station eine eigene Route zu rechnen waere exakt und bei zweihundert
// Stationen zu teuer. Die Matrix-API rechnet viele Verbindungen auf einmal,
// nimmt aber nur 200 Zellen je Anfrage. Gemessen, nicht geraten: Bei 300 kommt
// "The matrix size and parameters combination violates the API limitations."
//
// Das Verfahren:
//   1. Auf der Route alle 50 km einen Stuetzpunkt setzen.
//   2. Fuer jede Station den Stuetzpunkt davor und den dahinter bestimmen.
//   3. Zwei Matrizen rechnen: Stuetzpunkt davor zur Station, Station zum
//      Stuetzpunkt dahinter.
//   4. Umweg = Hinfahrt + Rueckfahrt minus der Strecke, die man ohnehin
//      gefahren waere. Die letzte Zeit steckt schon in der Route.

import { distance } from './geo.mjs';

export const BASE_URL = 'https://api.tomtom.com';

/** Hoechstzahl der Zellen je synchroner Anfrage. Gemessen am 10.09.2026. */
export const MAX_ZELLEN = 200;

/** Abstand der Stuetzpunkte auf der Route. */
export const STUETZPUNKT_ABSTAND_M = 50000;

export function buildMatrixURL(apiKey) {
  return `${BASE_URL}/routing/matrix/2?key=${encodeURIComponent(apiKey)}`;
}

/** Der Rumpf der Anfrage. Die Punkte muessen in point stehen, das ist Pflicht. */
export function buildMatrixBody(origins, destinations) {
  const punkt = (p) => ({ point: { latitude: p.lat, longitude: p.lon } });
  return {
    origins: origins.map(punkt),
    destinations: destinations.map(punkt),
  };
}

/**
 * Macht aus der Antwort eine Tabelle [startIndex][zielIndex] mit Sekunden.
 *
 * Die Antwort kommt als flache Liste mit originIndex und destinationIndex,
 * nicht als Matrix. Zellen ohne Route fehlen einfach; das muss der Aufrufer
 * vertragen, deshalb null statt einer Ausrede.
 */
export function parseMatrix(json, originCount, destinationCount) {
  const tabelle = Array.from({ length: originCount }, () =>
    new Array(destinationCount).fill(null)
  );

  for (const zelle of json?.data ?? []) {
    const i = zelle.originIndex;
    const j = zelle.destinationIndex;
    if (i == null || j == null) continue;
    if (i >= originCount || j >= destinationCount) continue;
    const sekunden = zelle.routeSummary?.travelTimeInSeconds;
    if (typeof sekunden === 'number') tabelle[i][j] = sekunden;
  }

  return tabelle;
}

/**
 * Setzt Stuetzpunkte auf die Route und merkt sich Weg und Zeit bis dahin.
 *
 * Die Zeit wird anteilig aus der Gesamtfahrzeit gerechnet. Genauer waere, sie
 * je Abschnitt aus der Route zu nehmen; fuer die Differenzbildung reicht der
 * Anteil, weil sich der Fehler bei Hin- und Rueckweg weitgehend aufhebt.
 */
export function stuetzpunkte(routePoints, routeDurationSeconds, abstandMeter = STUETZPUNKT_ABSTAND_M) {
  if (routePoints.length === 0) return [];

  const gesamt = [];
  let weg = 0;
  gesamt.push({ ...routePoints[0], progressMeters: 0 });

  let letzterGesetzt = 0;
  for (let i = 1; i < routePoints.length; i++) {
    weg += distance(routePoints[i - 1], routePoints[i]);
    if (weg - letzterGesetzt >= abstandMeter) {
      gesamt.push({ ...routePoints[i], progressMeters: weg });
      letzterGesetzt = weg;
    }
  }

  const letzter = routePoints[routePoints.length - 1];
  if (gesamt[gesamt.length - 1].progressMeters < weg) {
    gesamt.push({ ...letzter, progressMeters: weg });
  }

  const gesamtWeg = weg || 1;
  return gesamt.map((p) => ({
    ...p,
    timeSeconds: routeDurationSeconds
      ? (p.progressMeters / gesamtWeg) * routeDurationSeconds
      : null,
  }));
}

/** Der Stuetzpunkt davor und der dahinter, als Indizes. */
export function klammer(stuetzen, progressMeters) {
  let davor = 0;
  for (let i = 0; i < stuetzen.length; i++) {
    if (stuetzen[i].progressMeters <= progressMeters) davor = i;
    else break;
  }
  const dahinter = Math.min(davor + 1, stuetzen.length - 1);
  return { davor, dahinter };
}

/**
 * Teilt die Arbeit in Anfragen unter der Zellengrenze auf.
 *
 * Gierig: Stationen kommen der Reihe nach in den Block, solange das Produkt aus
 * verschiedenen Stuetzpunkten und Blockgroesse unter der Grenze bleibt. Weil
 * die Stationen entlang der Route sortiert sind, teilen sich benachbarte
 * Stationen ihre Stuetzpunkte, und die Bloecke werden von selbst gross.
 *
 * `stuetzeVon` sagt, welcher Stuetzpunkt zu einem Eintrag gehoert. Als Funktion
 * und nicht als Feldname, und das hat einen Grund: Vorher erwartete diese
 * Funktion ein Feld `stuetzIndex`, der Aufrufer legte es mit einer Kopie an,
 * und die Bloecke enthielten Kopien statt der Originale. Was er hineinschrieb,
 * landete im Nichts. Vier Anfragen liefen durch und lieferten null Umwege.
 *
 * Die Bloecke enthalten die uebergebenen Objekte selbst. Wer etwas
 * hineinschreibt, schreibt in das Original.
 */
export function bloecke(eintraege, stuetzeVon, maxZellen = MAX_ZELLEN) {
  const ergebnis = [];
  let block = [];
  let stuetzenImBlock = new Set();

  for (const zuordnung of eintraege) {
    const naechste = new Set(stuetzenImBlock);
    naechste.add(stuetzeVon(zuordnung));

    if (block.length > 0 && naechste.size * (block.length + 1) > maxZellen) {
      ergebnis.push({ eintraege: block, stuetzen: [...stuetzenImBlock] });
      block = [];
      stuetzenImBlock = new Set([stuetzeVon(zuordnung)]);
    } else {
      stuetzenImBlock = naechste;
    }
    block.push(zuordnung);
  }

  if (block.length > 0) {
    ergebnis.push({ eintraege: block, stuetzen: [...stuetzenImBlock] });
  }
  return ergebnis;
}

/**
 * Umweg aus Hin- und Rueckfahrt und der ohnehin gefahrenen Strecke.
 *
 * Negative Werte gibt es: Wenn die Matrix einen kuerzeren Weg findet als die
 * geplante Route, kommt rechnerisch ein Gewinn heraus. Das ist kein Umweg,
 * sondern Rauschen, und wird auf null gesetzt.
 */
export function umwegSekunden(hin, zurueck, entlangDerRoute) {
  if (hin == null || zurueck == null || entlangDerRoute == null) return null;
  return Math.max(0, hin + zurueck - entlangDerRoute);
}
