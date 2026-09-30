// umwegtabelle.mjs
// Umwege einmal rechnen, dann nachschlagen.
//
// Der Umweg zu einer Station haengt nur davon ab, auf welcher Strasse man an
// ihr vorbeifaehrt und in welcher Richtung. Nicht davon, wo die Fahrt begann
// oder wohin sie geht. Die Raststaette Ratingen kostet aus Richtung Sueden
// immer null Minuten, Fastned Gescher auf der Gegenfahrbahn immer fuenfzehn.
// Das ist eine Eigenschaft von Station, Strasse und Fahrtrichtung, und die
// kann man einmal ermitteln und wegschreiben. Jede Fahrt macht die Tabelle
// voller, jede Wiederholung kostet nichts mehr.
//
// Der Schluessel: Station, Fahrtrichtung in acht Sektoren, und der naechste
// Routenpunkt auf zwei Nachkommastellen, also grob ein Kilometer. Zwei Fahrten
// auf derselben Strasse in derselben Richtung treffen denselben Schluessel;
// eine Station zwischen A1 und A46 bekommt je Autobahn einen eigenen.
// Faellt der naechste Punkt einmal knapp auf die andere Seite einer
// Rundungsgrenze, gibt es einen zweiten Eintrag statt eines Treffers. Das
// kostet eine Anfrage, nicht die Richtigkeit.
//
// Gegenstueck in Swift: DetourTable.swift. Schluessel und Rundung muessen
// dort dieselben sein, sonst findet die App nichts.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

import { distance } from './geo.mjs';

export const SEKTOREN = 8;

/** Weg bis zu jedem Routenpunkt, einmal vorab. */
export function routenLage(routePoints) {
  const kumuliert = new Array(routePoints.length).fill(0);
  for (let i = 1; i < routePoints.length; i++) {
    kumuliert[i] = kumuliert[i - 1] + distance(routePoints[i - 1], routePoints[i]);
  }
  return { punkte: routePoints, kumuliert };
}

/** Der Index des Routenpunkts bei diesem Weg. Binaere Suche. */
export function indexBeiWeg(lage, progressMeters) {
  const k = lage.kumuliert;
  let lo = 0;
  let hi = k.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (k[mid] < progressMeters) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Kurs in Grad, 0 = Nord, 90 = Ost. */
export function kurs(a, b) {
  const phi1 = (a.lat * Math.PI) / 180;
  const phi2 = (b.lat * Math.PI) / 180;
  const dLambda = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** 0 = Nord, 1 = Nordost, ..., 7 = Nordwest. */
export function sektor(kursGrad) {
  return Math.floor((((kursGrad + 22.5) % 360) + 360) % 360 / 45) % SEKTOREN;
}

/** Zwei Nachkommastellen, in beiden Sprachen gleich gerechnet. */
export function gerundet(x) {
  return (Math.round(x * 100) / 100).toFixed(2);
}

/**
 * Wo und wie die Route an der Station vorbeifuehrt.
 *
 * Die Richtung kommt aus dem Punkt davor und dem dahinter, nicht aus zwei
 * benachbarten Punkten der Geometrie: Die liegen manchmal zehn Meter
 * auseinander und zeigen dann in jede Richtung.
 */
export function passage(station, lage) {
  const n = lage.punkte.length;
  if (n === 0 || !Number.isFinite(station.progressMeters)) return null;
  const i = indexBeiWeg(lage, station.progressMeters);
  const davor = lage.punkte[Math.max(0, i - 3)];
  const dahinter = lage.punkte[Math.min(n - 1, i + 3)];
  const punkt = lage.punkte[i];
  const richtung = davor === dahinter ? 0 : kurs(davor, dahinter);
  return { punkt, sektor: sektor(richtung) };
}

export function schluessel(station, lage) {
  const p = passage(station, lage);
  if (!p) return null;
  return `${station.id}|${p.sektor}|${gerundet(p.punkt.lat)},${gerundet(p.punkt.lon)}`;
}

// ------------------------------------------------------------------ Datei

export function leereTabelle() {
  return {
    quelle: 'TomTom Routing API, Route mit Zwischenziel gegen Route des Abschnitts',
    hinweis: 'Schluessel: Station|Richtungssektor|naechster Routenpunkt. Sekunden ohne Verkehrslage.',
    eintraege: {},
  };
}

export function lade(pfad) {
  if (!existsSync(pfad)) return leereTabelle();
  const daten = JSON.parse(readFileSync(pfad, 'utf8'));
  if (!daten.eintraege || typeof daten.eintraege !== 'object') {
    throw new Error(`${pfad}: keine Umwegtabelle, "eintraege" fehlt.`);
  }
  return daten;
}

/** Sortiert nach Schluessel, damit Diffs lesbar bleiben. */
export function speichere(pfad, tabelle) {
  const sortiert = Object.fromEntries(
    Object.keys(tabelle.eintraege).sort().map((k) => [k, tabelle.eintraege[k]])
  );
  writeFileSync(pfad, JSON.stringify({ ...tabelle, eintraege: sortiert }, null, 1) + '\n');
}

export function nachschlagen(tabelle, station, lage) {
  return nachschlagenEintrag(tabelle, station, lage)?.sekunden ?? null;
}

/** Der ganze Eintrag, mit Metern, sofern sie mitgeschrieben wurden. */
export function nachschlagenEintrag(tabelle, station, lage) {
  const k = schluessel(station, lage);
  if (!k) return null;
  return tabelle.eintraege[k] ?? null;
}

/**
 * Traegt einen gerechneten Umweg ein.
 *
 * Werte mit Verkehrslage ueberschreiben keine ohne: Die Tabelle soll den
 * Umweg der Strasse enthalten, nicht den des Nachmittags, an dem gemessen
 * wurde. Ohne Verkehr ist der Wert der bessere, und er bleibt.
 */
export function eintragen(tabelle, station, lage, sekunden, { mitVerkehr = false, datum, meter } = {}) {
  const k = schluessel(station, lage);
  if (!k || sekunden == null) return false;
  const vorhanden = tabelle.eintraege[k];
  if (vorhanden && !vorhanden.verkehr && mitVerkehr) return false;
  tabelle.eintraege[k] = {
    sekunden: Math.round(sekunden),
    ...(Number.isFinite(meter) ? { meter: Math.round(meter) } : {}),
    verkehr: mitVerkehr,
    datum: datum ?? new Date().toISOString().slice(0, 10),
  };
  return true;
}
