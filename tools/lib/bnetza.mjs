// bnetza.mjs
// Liest die Ladesäulenliste der Bundesnetzagentur.
//
// Warum diese Quelle als Maßstab: Der Betrieb einer öffentlich zugänglichen
// Ladeeinrichtung ist meldepflichtig. Das Register ist damit der einzige
// Datensatz, gegen den sich "vollständig" überhaupt seriös messen lässt.
// Lizenz CC BY 4.0, Namensnennung "Bundesnetzagentur.de".
//
// Zum Format: Die Datei ist semikolongetrennt, hat mehrere Zeilen Vorspann vor
// der eigentlichen Kopfzeile, deutsche Dezimalkommata und wechselt zwischen
// UTF-8 und Windows-1252. Die Spaltennamen ändern sich zwischen den Ausgaben.
// Deshalb wird die Kopfzeile gesucht statt gezählt und die Spalten werden über
// Namensfragmente zugeordnet, nicht über Positionen. Was erkannt wurde, gibt
// das Werkzeug aus; eine Fehlzuordnung fällt damit sofort auf.

import { readFileSync } from 'node:fs';

/** Spalten, die uns interessieren, mit den Fragmenten zu ihrer Erkennung. */
const COLUMN_HINTS = {
  operator: ['betreiber'],
  street: ['straße', 'strasse'],
  houseNumber: ['hausnummer'],
  postalCode: ['postleitzahl', 'plz'],
  city: ['ort'],
  state: ['bundesland'],
  latitude: ['breitengrad', 'latitude'],
  longitude: ['längengrad', 'laengengrad', 'longitude'],
  powerKW: ['nennleistung'],
  kind: ['art der ladeein'],
  pointCount: ['anzahl der ladepunkte', 'anzahl ladepunkte'],
  commissioned: ['inbetriebnahme'],
};

/** Normalisiert einen Spaltennamen für den Vergleich. */
function normalize(text) {
  return String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/"/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Liest die Datei und rät die Kodierung.
 *
 * Ein Umlaut, der als Ersatzzeichen ankommt, ist der Beleg dafür, dass es
 * nicht UTF-8 war. Dann noch einmal als Windows-1252.
 */
export function readRegisterFile(path) {
  const buffer = readFileSync(path);
  const asUtf8 = buffer.toString('utf8');
  if (!asUtf8.includes('�')) return asUtf8;
  return buffer.toString('latin1');
}

/** Zerlegt eine Zeile in Felder, respektiert Anführungszeichen. */
export function splitRow(line, separator = ';') {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const character = line[i];
    if (character === '"') {
      // Zwei Anführungszeichen hintereinander sind ein echtes Zeichen.
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (character === separator && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Sucht die Kopfzeile.
 *
 * Erkennungsmerkmal sind die beiden Koordinatenspalten: Ohne sie ist die Datei
 * für uns ohnehin wertlos, und keine Vorspannzeile enthält beide.
 */
export function findHeaderRow(lines, separator = ';') {
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const fields = splitRow(lines[i], separator).map(normalize);
    const hasLat = fields.some((f) => COLUMN_HINTS.latitude.some((h) => f.includes(h)));
    const hasLon = fields.some((f) => COLUMN_HINTS.longitude.some((h) => f.includes(h)));
    if (hasLat && hasLon) return { index: i, fields };
  }
  return null;
}

/** Ordnet die gesuchten Spalten ihren Positionen zu. */
export function mapColumns(headerFields) {
  const mapping = {};
  for (const [key, hints] of Object.entries(COLUMN_HINTS)) {
    const index = headerFields.findIndex((field) => hints.some((hint) => field.includes(hint)));
    if (index >= 0) mapping[key] = index;
  }
  return mapping;
}

/**
 * Zahl aus einem Feld, egal ob deutsch oder englisch geschrieben.
 *
 * Punkte blind als Tausendertrennzeichen zu entfernen wäre gefährlich: Aus
 * "51.50305" würde 5150305, und das fiele nicht als Fehler auf, sondern
 * landete als Koordinate irgendwo im Nichts. Deshalb wird entschieden statt
 * geraten: Sind Komma und Punkt vorhanden, ist das hintere das
 * Dezimaltrennzeichen. Steht nur eines da, ist es das Dezimaltrennzeichen.
 */
export function parseGermanNumber(text) {
  if (text == null) return null;

  let cleaned = String(text).trim().replace(/\s/g, '').replace(/"/g, '');
  if (cleaned === '') return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // 1.234,56 -> Punkte sind Tausender.
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      // 1,234.56 -> Kommas sind Tausender.
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    cleaned = cleaned.replace(',', '.');
  }
  // Nur ein Punkt: bleibt, wie er ist. Das ist bereits ein Dezimalpunkt.

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Liegt die Koordinate plausibel in Deutschland?
 *
 * Die Prüfung fängt genau den Fehler ab, den ein falsch geratenes
 * Dezimaltrennzeichen erzeugt: eine formal gültige Zahl an unmöglicher Stelle.
 */
export function isPlausibleGermanCoordinate(lat, lon) {
  return lat >= 47.0 && lat <= 55.3 && lon >= 5.5 && lon <= 15.6;
}

/**
 * Liest das Register in Datensätze.
 *
 * Gibt neben den Einträgen auch zurück, welche Spalten erkannt wurden und wie
 * viele Zeilen verworfen werden mussten. Beides gehört in die Ausgabe: Eine
 * stille Fehlzuordnung wäre schlimmer als ein Abbruch.
 */
export function parseRegister(content, options = {}) {
  const separator = options.separator ?? ';';
  const lines = content.split(/\r?\n/);

  const header = findHeaderRow(lines, separator);
  if (!header) {
    throw new Error(
      'Keine Kopfzeile mit Breiten- und Längengrad gefunden. ' +
        'Ist das wirklich die Ladesäulenliste der Bundesnetzagentur?'
    );
  }

  const columns = mapColumns(header.fields);
  for (const required of ['latitude', 'longitude']) {
    if (columns[required] === undefined) {
      throw new Error(`Spalte "${required}" nicht gefunden.`);
    }
  }

  const entries = [];
  const columnCount = header.fields.length;
  // Warum eine Zeile wegfaellt, gehoert protokolliert. Eine hohe Ausschussquote
  // ohne Begruendung ist ein Messfehler, kein Ergebnis.
  const skipReasons = {
    leereKoordinate: 0,
    unlesbareKoordinate: 0,
    unplausibleKoordinate: 0,
    spaltenzahlWeicht: 0,
  };
  const skipSamples = [];

  const noteSkip = (reason, line) => {
    skipReasons[reason]++;
    if (skipSamples.length < 5) skipSamples.push({ reason, line: line.slice(0, 160) });
  };

  for (let i = header.index + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const fields = splitRow(lines[i], separator);

    if (Math.abs(fields.length - columnCount) > 2) {
      noteSkip('spaltenzahlWeicht', lines[i]);
      continue;
    }

    const rawLat = fields[columns.latitude];
    const rawLon = fields[columns.longitude];
    const lat = parseGermanNumber(rawLat);
    const lon = parseGermanNumber(rawLon);

    if (lat == null || lon == null) {
      const leer = !String(rawLat ?? '').trim() || !String(rawLon ?? '').trim();
      noteSkip(leer ? 'leereKoordinate' : 'unlesbareKoordinate', lines[i]);
      continue;
    }
    if (!isPlausibleGermanCoordinate(lat, lon)) {
      noteSkip('unplausibleKoordinate', lines[i]);
      continue;
    }

    const value = (key) => (columns[key] !== undefined ? fields[columns[key]]?.trim() ?? '' : '');
    const kind = value('kind');

    entries.push({
      operator: value('operator'),
      address: [value('street'), value('houseNumber')].filter(Boolean).join(' '),
      postalCode: value('postalCode'),
      city: value('city'),
      state: value('state'),
      lat,
      lon,
      powerKW: parseGermanNumber(value('powerKW')),
      // Das Register unterscheidet Normal- und Schnellladeeinrichtung.
      isFastCharger: /schnell/i.test(kind),
      kind,
      pointCount: parseGermanNumber(value('pointCount')),
      commissioned: value('commissioned'),
    });
  }

  const skipped = Object.values(skipReasons).reduce((sum, n) => sum + n, 0);

  return {
    entries,
    columns,
    headerIndex: header.index,
    headerFields: header.fields,
    columnCount,
    skipped,
    skipReasons,
    skipSamples,
  };
}

export function loadRegister(path, options = {}) {
  return parseRegister(readRegisterFile(path), options);
}
