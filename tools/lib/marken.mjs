// marken.mjs
// Welche Marke steckt hinter einem Ladebetreiber?
//
// Das Register fuehrt Firmennamen ("BP Europa SE"), TomTom Markennamen
// ("Aral pulse"), und wer Favoriten waehlt, denkt in Marken. Die Tabelle
// liegt in daten/marken.json und wird von der App genauso gelesen; das
// Gegenstueck in Swift ist ChargingBrands.swift.

import { readFileSync } from 'node:fs';

export function ladeMarken(pfad) {
  return JSON.parse(readFileSync(pfad, 'utf8')).marken;
}

/** Die Marke eines Betreibers, oder null. Erste passende gewinnt. */
export function markeVon(marken, ...namen) {
  const text = namen.filter(Boolean).join(' | ').toLowerCase();
  if (!text) return null;
  return marken.find((m) => m.muster.some((muster) => text.includes(muster))) ?? null;
}

/** Alle Marken, die passen wuerden. Fuer den Test auf Doppeltreffer. */
export function alleMarkenVon(marken, ...namen) {
  const text = namen.filter(Boolean).join(' | ').toLowerCase();
  return marken.filter((m) => m.muster.some((muster) => text.includes(muster)));
}
