// apikey.mjs
// Beschafft den TomTom-Schlüssel für die Werkzeuge.
//
// Liegt in einer eigenen Datei, weil beide Werkzeuge ihn brauchen und die
// Fallstricke identisch sind: Ein export gilt nur für das eine Terminalfenster,
// ein Schlüssel auf der Kommandozeile landet in der Shell-History, und ein aus
// einer Anleitung mitkopierter Platzhalter ist nicht leer und kommt deshalb
// durch jede Vorhandensein-Prüfung.

import { stdin, stdout } from 'node:process';

/** Platzhalter, die in Anleitungen stehen und versehentlich mitkopiert werden. */
export const PLACEHOLDER_KEYS = new Set([
  'IHR_KEY', 'DEIN_KEY', 'NEUER_KEY', 'MEIN_KEY',
  'YOUR_API_KEY', 'YOUR_KEY', 'DEIN_API_KEY', 'API_KEY', 'KEY',
  'DATEINAME', 'PFAD',
]);

/**
 * Prüft den Schlüssel, bevor die erste Anfrage rausgeht.
 *
 * Gibt null zurück, wenn nichts zu beanstanden ist, sonst einen Befund mit
 * `fatal`, ob der Lauf abgebrochen werden soll.
 */
export function checkApiKey(key) {
  const trimmed = String(key ?? '').trim();

  if (PLACEHOLDER_KEYS.has(trimmed.toUpperCase())) {
    return {
      fatal: true,
      message:
        `"${trimmed}" ist ein Platzhalter aus der Anleitung, kein Schluessel.\n` +
        'Den echten Key gibt es unter developer.tomtom.com im Dashboard bei API Keys.',
    };
  }

  if (!/^[A-Za-z0-9]{20,}$/.test(trimmed)) {
    return {
      fatal: false,
      message:
        `Der Schluessel sieht ungewoehnlich aus (${trimmed.length} Zeichen). ` +
        'Ein TomTom-Key hat 32 alphanumerische Zeichen.',
    };
  }

  return null;
}

/**
 * Fragt den Schlüssel im Terminal ab, ohne ihn anzuzeigen.
 *
 * Der Raw-Mode schaltet das Echo des Terminals ab, die getippten Zeichen werden
 * bewusst nirgends ausgegeben. Ohne Raw-Mode spiegelt das Terminal die Eingabe
 * selbst zurück, dann steht der Schlüssel doch wieder sichtbar da.
 *
 * Gibt null zurück, wenn keine Eingabe möglich ist, etwa in einer Pipeline.
 */
export function promptForKey(prompt = 'TomTom-Key (Eingabe bleibt unsichtbar): ') {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return Promise.resolve(null);

  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve) => {
    let buffer = '';

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        switch (character) {
          case '\r':
          case '\n':
          case '\u0004': // Ctrl+D
            cleanup();
            resolve(buffer.trim() || null);
            return;
          case '\u0003': // Ctrl+C
            cleanup();
            process.exit(130);
            return;
          case '\u007f': // Backspace
          case '\b':
            buffer = buffer.slice(0, -1);
            break;
          default:
            // Steuerzeichen ignorieren, alles andere sammeln.
            if (character >= ' ') buffer += character;
        }
      }
    };

    stdin.on('data', onData);
  });
}

/**
 * Der komplette Weg zum Schlüssel: Argument, Umgebungsvariable, Nachfrage.
 *
 * `onMessage` und `onError` werden für die Ausgabe durchgereicht, damit die
 * Werkzeuge ihre eigene Formatierung behalten.
 */
export async function resolveApiKey(options = {}) {
  const {
    argumentKey,
    env = process.env.TOMTOM_API_KEY,
    onNotice = (text) => console.error(text),
    onFatal = (text) => console.error(text),
  } = options;

  const key = argumentKey || env || (await promptForKey());
  if (!key) {
    onFatal('Kein Key.');
    onNotice('Entweder hier eingeben, --key=... setzen oder TOMTOM_API_KEY exportieren.');
    onNotice('Key anlegen: https://developer.tomtom.com/ -> Dashboard -> API Keys');
    return null;
  }

  const problem = checkApiKey(key);
  if (problem?.fatal) {
    onFatal(problem.message);
    return null;
  }
  if (problem) onNotice(problem.message);

  return key;
}
