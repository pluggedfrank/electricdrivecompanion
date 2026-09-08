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

/** Deutsche Dezimalzahl in eine Zahl. */
export function parseGermanNumber(text) {
  if (text == null) return null;
  const cleaned = String(text).trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
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
  let skipped = 0;

  for (let i = header.index + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const fields = splitRow(lines[i], separator);

    const lat = parseGermanNumber(fields[columns.latitude]);
    const lon = parseGermanNumber(fields[columns.longitude]);
    if (lat == null || lon == null) {
      skipped++;
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

  return {
    entries,
    columns,
    headerIndex: header.index,
    headerFields: header.fields,
    skipped,
  };
}

export function loadRegister(path, options = {}) {
  return parseRegister(readRegisterFile(path), options);
}
