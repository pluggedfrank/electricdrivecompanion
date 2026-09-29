// registerquelle.mjs
// Das Ladesaeulenregister als Stationsquelle, statt der TomTom-Suche.
//
// Warum: Die Search API hat im Freemium 2.500 Anfragen im Monat, und eine
// Routenplanung mit Along-Route- und Umkreissuche kostet rund fuenfzig. Am
// 29.09.2026 standen 2.295 auf der Uhr. Das Register liegt als Datei im Repo,
// deckt Deutschland vollstaendig ab und kostet nichts. TomTom bleibt fuer das,
// was das Register nicht hat: Zielsuche und Live-Belegung, beides auf Abruf.
//
// Was dem Register fehlt: Steckertypen, eine Live-Anbindung und eine
// TomTom-Kennung. Die Kennung wird beim Antippen per Umkreissuche nachgeholt.

import { readFileSync } from 'node:fs';

import * as corridor from './corridor.mjs';

/** Liest einen Export von register-schnelllader.mjs --export. */
export function ladeStandorte(pfad) {
  const daten = JSON.parse(readFileSync(pfad, 'utf8'));
  if (!Array.isArray(daten.standorte)) {
    throw new Error(`${pfad}: kein Register-Export, "standorte" fehlt.`);
  }
  return {
    meta: {
      quelle: daten.quelle,
      lizenz: daten.lizenz,
      namensnennung: daten.namensnennung,
      registerdatei: daten.registerdatei,
      leistungAbKW: daten.leistungAbKW,
    },
    stationen: daten.standorte.map(alsStation),
  };
}

/**
 * Eine stabile Kennung aus den Koordinaten.
 *
 * Das Register hat keine Standort-ID, nur Zeilen je Ladeeinrichtung. Fuenf
 * Nachkommastellen sind rund ein Meter; zwei Standorte mit derselben Kennung
 * waeren derselbe Ort.
 */
export function kennung(standort) {
  return `bnetza:${standort.lat.toFixed(5)},${standort.lon.toFixed(5)}`;
}

/**
 * Macht aus einem Registerstandort dieselbe Form, die die TomTom-Suche liefert.
 *
 * Dann laufen Zuordnung, Sortierung und Ausgabe unveraendert. Der Name ist
 * der Betreiber, kuerzer geschrieben: "Shell Deutschland GmbH" ist in einer
 * Liste von vierzig Stationen nur Rauschen.
 */
export function alsStation(standort) {
  const betreiber = kurzerBetreiber(standort.operator);
  const anschrift = [standort.address, [standort.postalCode, standort.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');

  return {
    id: kennung(standort),
    name: betreiber,
    operatorName: standort.operator ?? null,
    address: anschrift,
    lat: standort.lat,
    lon: standort.lon,
    maxPowerKW: standort.maxPowerKW ?? null,
    pointCount: standort.pointCount ?? null,
    deviceCount: standort.deviceCount ?? null,
    connectors: [],
    availabilityID: null,
    detourSeconds: null,
    quelle: 'register',
  };
}

/**
 * Rechtsformen weg, der Rest bleibt, wie er ist.
 *
 * Das Register schreibt "EnBW mobility+ AG und Co.KG", mit "und" und ohne
 * Leerzeichen vor KG. Erst das Anhaengsel "& Co. KG" in allen Schreibweisen,
 * dann die einzelnen Formen.
 */
export function kurzerBetreiber(operator) {
  if (!operator) return 'Ladestation';
  return operator
    .replace(/\s*(&|und)\s*Co\.?\s*(KG|OHG)?\b\.?/gi, ' ')
    .replace(/\b(GmbH|AG|SE|KG|mbH|e\.?V\.?|OHG|Ltd\.?|B\.?V\.?|S\.?A\.?|Inc\.?)\b\.?/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,]+$/, '')
    .trim() || operator;
}

/**
 * Die Stationen entlang der Route, sortiert in Fahrtrichtung.
 *
 * Erst eine grobe Vorauswahl ueber die Bounding Box, dann die Projektion:
 * Ohne Vorauswahl wuerden 4.668 Standorte gegen 3.700 Routenpunkte gerechnet.
 */
export function entlangDerRoute(stationen, routePoints, korridorMeter) {
  const box = corridor.boundingBox(routePoints, korridorMeter / 111_000 + 0.01);
  const kandidaten = stationen.filter(
    (s) => s.lat >= box.minLat && s.lat <= box.maxLat && s.lon >= box.minLon && s.lon <= box.maxLon
  );
  return corridor.orderAlongRoute(kandidaten, routePoints, korridorMeter);
}
