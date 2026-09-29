// umwege.mjs
// Umwege je Station als Route mit Zwischenziel, ueber die Routing API.
//
// Der Nachfolger von matrix.mjs, und der Grund ist das Kontingent: Die Matrix
// hat im Freemium 2.500 Zellen im Monat, die Routing API 20.000 Anfragen.
// Eine Route mit Zwischenziel rechnet ausserdem exakt, was ein Navi beim
// Umrouten ueber die Station ansagen wuerde. Das war ohnehin der Massstab,
// an dem die Matrix gemessen werden sollte.
//
// Das Verfahren:
//   1. Auf der Route alle 50 km einen Stuetzpunkt setzen (aus matrix.mjs).
//   2. Fuer jede Station den Stuetzpunkt davor und den dahinter.
//   3. Eine Route davor -> Station -> dahinter, und je Abschnitt einmal die
//      Route davor -> dahinter.
//   4. Umweg = Fahrzeit ueber die Station minus Fahrzeit des Abschnitts.
//
// Kosten: eine Anfrage je Station plus eine je Abschnitt. Fuer 104 Stationen
// auf 320 km sind das 111 Anfragen, etwa eine halbe Minute bei 300 ms Abstand.

import { abschnitte, abschnittSchluessel, klammer, stuetzpunkte } from './matrix.mjs';

export { stuetzpunkte, klammer };

/**
 * Plant die Routenanfragen fuer eine Liste von Stationen.
 *
 * Reine Funktion, damit sie ohne Netz testbar ist: Sie liefert, was gefragt
 * werden muss, und `umwegAus` rechnet hinterher. Dazwischen liegt der Aufruf.
 */
export function planeAnfragen(stuetzen, stationen) {
  const zuordnungen = stationen
    .filter((s) => Number.isFinite(s.progressMeters))
    .map((station) => {
      const { davor, dahinter } = klammer(stuetzen, station.progressMeters);
      return { station, davor, dahinter };
    });

  const grundstrecken = abschnitte(zuordnungen).map((a) => ({
    schluessel: abschnittSchluessel(a.davor, a.dahinter),
    punkte: [stuetzen[a.davor], stuetzen[a.dahinter]],
  }));

  const viaStrecken = zuordnungen.map((z) => ({
    station: z.station,
    schluessel: abschnittSchluessel(z.davor, z.dahinter),
    punkte: [stuetzen[z.davor], z.station, stuetzen[z.dahinter]],
  }));

  return { zuordnungen, grundstrecken, viaStrecken };
}

/** Umweg aus den beiden Fahrzeiten. Negatives ist Rauschen und wird null. */
export function umwegAus(ueberStationSekunden, grundstreckeSekunden) {
  if (ueberStationSekunden == null || grundstreckeSekunden == null) return null;
  return Math.max(0, ueberStationSekunden - grundstreckeSekunden);
}

/**
 * Rechnet die Umwege, mit einer beliebigen Routenfunktion.
 *
 * `routeSekunden(punkte)` liefert die Fahrzeit einer Route ueber die Punkte.
 * Im Probelauf ist das die Routing API, im Test eine Tabelle. Schreibt das
 * Ergebnis in `station.detourSeconds` und `station.detourGerechnet`.
 *
 * Grundstrecken zuerst: Wenn eine davon scheitert, sind alle Stationen des
 * Abschnitts ohne Wert, das soll frueh auffallen. Danach die Stationen in
 * Fahrtrichtung, damit bei einem Abbruch die vorderen Werte da sind.
 */
export async function berechneUmwege(routeSekunden, stuetzen, stationen, { onFortschritt } = {}) {
  const plan = planeAnfragen(stuetzen, stationen);
  const grund = new Map();
  let anfragen = 0;
  let fehler = 0;

  for (const strecke of plan.grundstrecken) {
    try {
      grund.set(strecke.schluessel, await routeSekunden(strecke.punkte));
    } catch {
      fehler++;
    }
    anfragen++;
  }

  let gerechnet = 0;
  for (const [index, via] of plan.viaStrecken.entries()) {
    const basis = grund.get(via.schluessel);
    if (basis == null) continue;

    try {
      const ueberStation = await routeSekunden(via.punkte);
      via.station.detourSeconds = umwegAus(ueberStation, basis);
      via.station.detourGerechnet = true;
      gerechnet++;
    } catch {
      fehler++;
    }
    anfragen++;
    onFortschritt?.(index + 1, plan.viaStrecken.length);
  }

  return { anfragen, gerechnet, fehler, abschnitte: plan.grundstrecken.length };
}
