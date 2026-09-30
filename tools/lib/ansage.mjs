// ansage.mjs
// Zielfuehrung: welche Anweisung als naechste kommt, wann sie angesagt wird
// und mit welchen Worten.
//
// Die Texte liefert die Routing-API (instructionsType=text, language=de-DE),
// fertig formuliert: "Biegen Sie links ab auf Brühler Weg". Hier wird nur
// entschieden, wann welcher Satz faellt, und die Entfernung davorgesetzt.
// Das SDK kennt Sprachtexte nur noch als veraltete Felder; die Ansage selbst
// steckt im Navigation SDK, das separat lizenziert wird.
//
// Gegenstueck in Swift: LadeRoute/Driving/Guidance.swift. Die Tests hier sind
// der Massstab fuer beide.

import { aufSegment } from './fahrt.mjs';

/** Die drei Stufen einer Ansage, von fern nach nah. */
export const STUFEN = ['frueh', 'nah', 'jetzt'];

/** Aus der REST-Antwort das, was die Fahrt braucht. */
export function anweisungenAusAntwort(instructions) {
  return instructions.map((a) => ({
    offset: a.routeOffsetInMeters,
    punkt: { lat: a.point.latitude, lon: a.point.longitude },
    manoever: a.maneuver,
    text: a.message,
    kombiniert: a.combinedMessage ?? null,
  }));
}

/**
 * Legt die Anweisungen auf die eigene Routengeometrie.
 *
 * Die Anweisungen kommen aus einer eigenen Anfrage, die Linie auf der Karte
 * aus dem SDK. Beide sind dieselbe Route, aber die Meterangaben weichen um
 * ein paar Promille ab. Massgeblich ist deshalb der Manoeverpunkt, gesucht
 * ab der vorigen Anweisung vorwaerts: So landet eine Ausfahrt nicht auf dem
 * Gegenast eines Kreuzes. Liegt der Punkt mehr als 100 m neben der Linie,
 * weicht die Route ab; dann bleibt der Meterwert, auf die Laenge umgerechnet.
 */
export function verorteAnweisungen(anweisungen, lage, { fang = 100 } = {}) {
  const gesamt = anweisungen.at(-1)?.offset ?? 0;
  const faktor = gesamt > 0 ? lage.laenge / gesamt : 1;
  let ab = 0;
  let zuletzt = 0;
  return anweisungen.map((a) => {
    let best = null;
    for (let i = ab; i < lage.punkte.length - 1; i++) {
      const s = aufSegment(a.punkt, lage.punkte[i], lage.punkte[i + 1]);
      // Echt kleiner: Kommt die Route zweimal an denselben Punkt, gilt der erste.
      if (!best || s.abstand < best.abstand) {
        const seg = lage.kumuliert[i + 1] - lage.kumuliert[i];
        best = { index: i, abstand: s.abstand, fortschritt: lage.kumuliert[i] + s.t * seg };
      }
      if (best.abstand < 1) break;
    }
    let fortschritt;
    if (best && best.abstand <= fang) {
      fortschritt = best.fortschritt;
      ab = best.index;
    } else {
      fortschritt = a.offset * faktor;
    }
    fortschritt = Math.max(zuletzt, fortschritt);
    zuletzt = fortschritt;
    return { ...a, fortschritt };
  });
}

/**
 * Ab welcher Entfernung welche Stufe gilt, nach Tempo in m/s.
 * Autobahn frueh, Stadt spaet: Bei 130 km/h sind 600 m eine Viertelminute.
 */
export function schwellen(tempo) {
  if (tempo >= 22) return { frueh: 2000, nah: 600, jetzt: Math.min(300, Math.max(60, tempo * 4)) };
  if (tempo >= 12) return { frueh: 800, nah: 250, jetzt: Math.min(120, Math.max(40, tempo * 4)) };
  return { frueh: 400, nah: 120, jetzt: 40 };
}

export function stufeFuer(abstand, tempo) {
  const s = schwellen(tempo);
  if (abstand <= s.jetzt) return 'jetzt';
  if (abstand <= s.nah) return 'nah';
  if (abstand <= s.frueh) return 'frueh';
  return null;
}

const komma = (x) => String(x).replace('.', ',');

/** "500 Metern", "1,5 Kilometern", "einem Kilometer": fuer "In ..." */
export function entfernungGesprochen(m) {
  if (m >= 950) {
    const km = m < 9500 ? Math.round(m / 500) / 2 : Math.round(m / 1000);
    return km === 1 ? 'einem Kilometer' : `${komma(km)} Kilometern`;
  }
  const gerundet = m >= 300 ? Math.round(m / 100) * 100 : Math.max(50, Math.round(m / 50) * 50);
  return `${gerundet} Metern`;
}

/** Fuer die Anzeige: "250 m", "1,5 km", "209 km". */
export function entfernungKurz(m) {
  if (m >= 1000) {
    const km = m / 1000;
    return km < 10 ? `${komma(km.toFixed(1))} km` : `${Math.round(km)} km`;
  }
  if (m >= 200) return `${Math.round(m / 50) * 50} m`;
  return `${Math.max(0, Math.round(m / 10) * 10)} m`;
}

// Saetze, die mit "Verb Sie" anfangen, lassen sich hinter "In 500 Metern"
// setzen: "In 500 Metern biegen Sie links ab". Alles andere bekommt einen
// Doppelpunkt.
const VERB_SIE = /^(Biegen|Halten|Bleiben|Nehmen|Fahren|Folgen|Wenden|Verlassen|Wechseln|Ordnen) Sie\b/;

const istZiel = (m) => /^ARRIVE/.test(m);
const istZwischenhalt = (m) => /^WAYPOINT/.test(m);

/**
 * Der Satz fuer eine Anweisung in einer Stufe, oder null, wenn die Stufe
 * nichts zu sagen hat.
 *
 *  bisNaechste   Meter von dieser Anweisung bis zur folgenden; fuer "Folgen
 *                Sie A31 fuer 209 Kilometer"
 *  mitDann       "jetzt" auch mit "dann ...", weil "nah" ausgefallen ist
 *
 * "nah" nimmt den kombinierten Satz der API ("... dann bleiben Sie links"),
 * "jetzt" nur den kurzen: Das "dann" ist 600 m vorher schon gefallen.
 */
export function ansageText(a, stufe, abstand, bisNaechste = 0, { mitDann = false } = {}) {
  if (a.manoever === 'DEPART') return null;
  if (a.manoever === 'FOLLOW') {
    // "Folgen Sie" steht direkt hinter der Auffahrt und kuendigt nichts an.
    // Gesagt wird es nur, wenn danach lange nichts kommt: Dann ist die
    // Strecke bis zur naechsten Abbiegung die Nachricht. Sonst waeren es
    // drei Saetze hintereinander, Ausfahrt, Auffahrt, Folgen.
    if (stufe !== 'jetzt' || bisNaechste < 10_000) return null;
    return `${a.text} für ${Math.round(bisNaechste / 1000)} Kilometer`;
  }
  const satz = stufe === 'nah' || (stufe === 'jetzt' && mitDann) ? (a.kombiniert ?? a.text) : a.text;
  if (stufe === 'jetzt') return satz;
  const vorne = `In ${entfernungGesprochen(abstand)}`;
  if (istZiel(a.manoever)) return `${vorne} erreichen Sie Ihr Ziel`;
  if (istZwischenhalt(a.manoever)) return `${vorne} erreichen Sie Ihren Zwischenhalt`;
  if (VERB_SIE.test(satz)) return `${vorne} ${satz[0].toLowerCase()}${satz.slice(1)}`;
  return `${vorne}: ${satz}`;
}

/** Was schon gesagt ist, ueber die Fahrt hinweg. */
export function neuerAnsager() {
  return { gesagt: new Set(), gesprochen: new Set(), abgedeckt: new Set() };
}

/**
 * Index der naechsten Anweisung vor dem Auto, ohne die Abfahrt.
 *
 * Das Ziel bleibt noch 100 m ueber seinen Punkt hinaus die naechste
 * Anweisung: Es liegt oft nur ein paar Meter hinter der letzten Abbiegung,
 * und eine Ortung im Sekundentakt springt sonst darueber, ohne dass
 * "Sie sind angekommen" je faellt.
 */
export function naechsteAnweisung(anweisungen, fortschritt) {
  for (let i = 0; i < anweisungen.length; i++) {
    if (anweisungen[i].manoever === 'DEPART') continue;
    if (anweisungen[i].fortschritt > fortschritt) return i;
  }
  const letzte = anweisungen.length - 1;
  if (letzte >= 0 && istZiel(anweisungen[letzte].manoever) && fortschritt - anweisungen[letzte].fortschritt < 100) {
    return letzte;
  }
  return null;
}

/**
 * Ein Schritt der Zielfuehrung.
 *
 * Gibt die naechste Anweisung zurueck, den Abstand dahin und, wenn jetzt
 * etwas zu sagen ist, den Satz. Jede Stufe faellt hoechstens einmal. Ist
 * eine spaetere Stufe schon erreicht (kurze Abstaende, Ortung kam spaet),
 * entfallen die frueheren: lieber ein Satz zur rechten Zeit als drei auf
 * einmal. Hat die vorige Anweisung ihren Nachfolger schon mit "dann ..."
 * angekuendigt, sagt der Nachfolger nur noch "jetzt".
 */
export function schritt(zustand, anweisungen, fortschritt, tempo) {
  const index = naechsteAnweisung(anweisungen, fortschritt);
  if (index === null) return { index: null, abstand: null, stufe: null, text: null };
  const a = anweisungen[index];
  const abstand = Math.max(0, a.fortschritt - fortschritt);
  const stufe = stufeFuer(abstand, tempo);
  const ergebnis = { index, abstand, stufe, text: null };
  if (!stufe) return ergebnis;

  const rang = STUFEN.indexOf(stufe);
  if (STUFEN.slice(rang).some((s) => zustand.gesagt.has(`${index}:${s}`))) return ergebnis;
  for (const s of STUFEN.slice(0, rang + 1)) zustand.gesagt.add(`${index}:${s}`);
  if (zustand.abgedeckt.has(index) && stufe !== 'jetzt') return ergebnis;

  const bisNaechste = index + 1 < anweisungen.length ? anweisungen[index + 1].fortschritt - a.fortschritt : 0;
  const mitDann = stufe === 'jetzt' && !zustand.gesprochen.has(`${index}:nah`);
  const text = ansageText(a, stufe, abstand, bisNaechste, { mitDann });
  if (text) {
    zustand.gesprochen.add(`${index}:${stufe}`);
    if ((stufe === 'nah' || mitDann) && a.kombiniert) zustand.abgedeckt.add(index + 1);
  }
  return { ...ergebnis, text };
}
