// ziele.mjs
// Gespeicherte Ziele: in welche Kategorie ein Ziel beim Speichern kommt.
//
// Keine Kategoriesuche, sondern ein Vorschlag beim Speichern, aus den
// Kategorien, die die Search-API zum Treffer liefert ("electric vehicle
// station", "supermarkets & hypermarkets", "restaurant"). Zuhause und
// Arbeit schlaegt die Regel nie vor; die legt man selbst fest.
//
// Gegenstueck in Swift: LadeRoute/Places/SavedPlaces.swift.

export const KATEGORIEN = ['zuhause', 'arbeit', 'laden', 'einkaufen', 'essen', 'sonstiges'];

const REGELN = [
  ['laden', /electric vehicle|charging/],
  ['einkaufen', /supermarket|hypermarket|market|shop|store|mall|bakery|pharmacy|drugstore/],
  ['essen', /restaurant|caf[eé]|coffee|bar\b|pub|fast food|bistro|food/],
];

/** Kategorie fuer ein Ziel aus den POI-Kategorien der Suche. */
export function kategorieFuer(poiKategorien = []) {
  const text = poiKategorien.join(' | ').toLowerCase();
  for (const [kategorie, muster] of REGELN) {
    if (muster.test(text)) return kategorie;
  }
  return 'sonstiges';
}

/** Ist schon ein Ziel an dieser Stelle gespeichert? Innerhalb von 30 m. */
export function gespeichertBei(ziele, punkt, distance, radius = 30) {
  return ziele.find((z) => distance(z, punkt) <= radius) ?? null;
}
