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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// ------------------------------------------------------------ Datei finden

export const DOWNLOAD_HINT =
  'Ladesaeulenliste als CSV holen (rund 51 MB, CC BY 4.0):\n' +
  '  https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/' +
  'E-Mobilitaet/Ladesaeulenkarte/start.html';

/** Ohne Angabe wird hier gesucht. */
export const DEFAULT_SEARCH_DIR = '~/Downloads';

/** Macht ~ am Anfang eines Pfades auf. */
export function expandPath(path) {
  const text = String(path);
  return resolve(text.startsWith('~') ? text.replace(/^~/, homedir()) : text);
}

/**
 * Sucht in einem Verzeichnis nach Dateien, die das Register sein koennten.
 *
 * Nach Groesse sortiert, die groesste zuerst: Das Register ist mit Abstand die
 * dickste Datei, die auf das Namensmuster passt.
 */
export function findRegisterCandidates(directory) {
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }

  return names
    .filter((name) => /lade|s[\u00e4a]ul|charg/i.test(name) && /\.(csv|xlsx?)$/i.test(name))
    .map((name) => {
      const path = join(directory, name);
      try {
        return { path, sizeMB: (statSync(path).size / 1024 / 1024).toFixed(1) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.sizeMB) - Number(a.sizeMB))
    .slice(0, 5);
}

/**
 * Loest die Angabe zu einem Dateipfad auf.
 *
 * Angegeben werden darf eine Datei, ein Verzeichnis oder gar nichts. Ohne
 * Angabe wird im Download-Ordner gesucht. Ein Dateiname, den man abtippen muss,
 * ist eine Fehlerquelle ohne Gegenwert: Der Download heisst je nach Browser und
 * Ausgabe anders.
 *
 * Gibt aus statt auszugeben: Das Melden bleibt beim Aufrufer, damit dieselbe
 * Aufloesung in mehreren Werkzeugen und im Test benutzbar ist.
 */
export function pickRegisterFile(argument, options = {}) {
  const {
    onInfo = (text) => console.log(text),
    onFatal = (text) => console.error(text),
  } = options;

  const { path, candidates, searchedDirectory } = resolveRegisterPath(argument);
  if (!searchedDirectory) return path;

  if (!path) {
    onFatal(`In ${searchedDirectory} liegt keine Registerdatei.`);
    onFatal(DOWNLOAD_HINT);
    onFatal('Danach ohne Argument starten, die Datei wird dann gefunden.');
    return null;
  }

  onInfo(`Registerdatei gefunden: ${candidates[0].path} (${candidates[0].sizeMB} MB)`);
  if (candidates.length > 1) {
    onInfo(`${candidates.length - 1} weitere Kandidaten ignoriert, groesste gewaehlt.`);
  }
  return path;
}

export function resolveRegisterPath(argument, { defaultDir = DEFAULT_SEARCH_DIR } = {}) {
  const given = expandPath(argument ?? defaultDir);
  const isDirectory = existsSync(given) && statSync(given).isDirectory();
  if (!isDirectory) return { path: given, candidates: [], searchedDirectory: null };

  const candidates = findRegisterCandidates(given).filter((k) => /\.csv$/i.test(k.path));
  return { path: candidates[0]?.path ?? null, candidates, searchedDirectory: given };
}

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

/**
 * Zerlegt die gesamte Datei in Datensätze.
 *
 * Zeichenweise statt erst nach Zeilen und dann nach Feldern. Das ist der
 * entscheidende Unterschied bei dieser Datei: Sie führt eine Public-Key-Spalte
 * für das Eichrecht, und dieser Schlüssel steht als mehrzeiliger Hex-Block im
 * Feld. Wer erst an Zeilenumbrüchen trennt, zerreißt jeden solchen Datensatz
 * und verliert ihn. Innerhalb von Anführungszeichen ist ein Zeilenumbruch
 * deshalb Teil des Feldes, nicht das Ende des Datensatzes.
 *
 * `maxFieldLength` ist eine Reißleine: Bleibt ein Anführungszeichen unpaarig,
 * würde der Rest der Datei in ein Feld laufen. Dann wird das Zeichen als
 * gewöhnliches Zeichen behandelt und ab dem nächsten Zeilenumbruch neu
 * aufgesetzt.
 */
export function parseRows(content, separator = ';', maxFieldLength = 200000) {
  const rows = [];
  let fields = [];
  let current = '';
  let inQuotes = false;

  const endRow = () => {
    fields.push(current);
    rows.push(fields);
    fields = [];
    current = '';
  };

  for (let i = 0; i < content.length; i++) {
    const character = content[i];

    if (inQuotes) {
      if (character === '"') {
        // Zwei Anführungszeichen hintereinander sind ein echtes Zeichen.
        if (content[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (current.length > maxFieldLength && character === '\n') {
        // Reißleine: Das Anführungszeichen war offenbar keines.
        inQuotes = false;
        endRow();
      } else {
        current += character;
      }
      continue;
    }

    switch (character) {
      case '"':
        inQuotes = true;
        break;
      case separator:
        fields.push(current);
        current = '';
        break;
      case '\r':
        break; // CRLF: das \n erledigt den Zeilenwechsel
      case '\n':
        endRow();
        break;
      default:
        current += character;
    }
  }

  if (current !== '' || fields.length > 0) endRow();

  // Leerzeilen tragen nichts bei.
  return rows.filter((row) => row.some((field) => field.trim() !== ''));
}

/** Zerlegt eine einzelne Zeile. Nur noch für Tests und Einzelfälle. */
export function splitRow(line, separator = ';') {
  const rows = parseRows(line, separator);
  return rows[0] ?? [''];
}

/**
 * Sucht die Kopfzeile.
 *
 * Erkennungsmerkmal sind die beiden Koordinatenspalten: Ohne sie ist die Datei
 * für uns ohnehin wertlos, und keine Vorspannzeile enthält beide.
 */
export function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const fields = rows[i].map(normalize);
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
  const rows = parseRows(content, separator);

  const header = findHeaderRow(rows);
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
  // Warum ein Datensatz wegfaellt, gehoert protokolliert. Eine hohe
  // Ausschussquote ohne Begruendung ist ein Messfehler, kein Ergebnis.
  const skipReasons = {
    leereKoordinate: 0,
    unlesbareKoordinate: 0,
    unplausibleKoordinate: 0,
    spaltenzahlWeicht: 0,
  };
  const skipSamples = [];
  let multiLineFields = 0;

  const noteSkip = (reason, row) => {
    skipReasons[reason]++;
    if (skipSamples.length < 5) {
      skipSamples.push({ reason, line: row.join(separator).slice(0, 160) });
    }
  };

  for (let i = header.index + 1; i < rows.length; i++) {
    const fields = rows[i];

    // Nach dem Umbau auf zeichenweises Lesen darf die Spaltenzahl exakt
    // stimmen. Weicht sie ab, ist der Datensatz wirklich kaputt.
    if (fields.length !== columnCount) {
      noteSkip('spaltenzahlWeicht', fields);
      continue;
    }

    if (fields.some((field) => field.includes('\n'))) multiLineFields++;

    const rawLat = fields[columns.latitude];
    const rawLon = fields[columns.longitude];
    const lat = parseGermanNumber(rawLat);
    const lon = parseGermanNumber(rawLon);

    if (lat == null || lon == null) {
      const leer = !String(rawLat ?? '').trim() || !String(rawLon ?? '').trim();
      noteSkip(leer ? 'leereKoordinate' : 'unlesbareKoordinate', fields);
      continue;
    }
    if (!isPlausibleGermanCoordinate(lat, lon)) {
      noteSkip('unplausibleKoordinate', fields);
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
    rowCount: rows.length - header.index - 1,
    // Wie viele Datensaetze ein Feld mit Zeilenumbruch enthalten. Beleg dafuer,
    // dass das zeichenweise Lesen noetig war.
    multiLineFields,
    skipped,
    skipReasons,
    skipSamples,
  };
}

export function loadRegister(path, options = {}) {
  return parseRegister(readRegisterFile(path), options);
}
