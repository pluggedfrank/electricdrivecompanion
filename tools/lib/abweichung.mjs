// abweichung.mjs
// Wann nach dem Verlassen der Route neu geplant wird.
//
// Gegenstueck in Swift: TripViewModel.shouldReroute(). Die Tests hier sind
// der Massstab.
//
// Die erste Fassung (30.09.2026) plante nicht neu, solange irgendeine
// aufbewahrte Station im Umkreis von 1 km lag. Aufbewahrt wird bis 10 km
// neben der Route, und in einer Stadt liegt fast ueberall eine davon in der
// Naehe: Auf der ersten Fahrt mit dem iPhone kam nach dem Abbiegen keine
// Ansage mehr, weil nie neu geplant wurde. Jetzt zaehlen nur Stationen, zu
// denen jemand absichtlich faehrt.

import { distance } from './geo.mjs';

export const REGELN = {
  /** So oft hintereinander mehr als 50 m neben der Route. */
  abseitsMindestens: 3,
  /** Nicht oefter als alle 20 Sekunden. */
  sekundenZwischen: 20,
  /** Zum Zwischenziel darf man die Route so weit vorher verlassen. */
  zwischenzielMeter: 1500,
  /** Zu einem geplanten Ladestopp so weit. */
  geplantMeter: 1000,
  /** Zu jeder anderen angezeigten Station erst auf dem Gelaende. */
  angezeigtMeter: 300,
};

/**
 *  abseits          wie oft hintereinander mehr als 50 m neben der Route
 *  sekundenSeit     seit der letzten Neuplanung, Infinity wenn noch keine
 *  position         { lat, lon }
 *  zwischenziel     Station, ueber die geroutet wird, oder null
 *  geplant          Stationen der geplanten Ladestopps
 *  angezeigt        Stationen der angezeigten Liste
 */
export function neuPlanen({ abseits, sekundenSeit = Infinity, position, zwischenziel = null, geplant = [], angezeigt = [] }) {
  if (abseits < REGELN.abseitsMindestens) return false;
  if (sekundenSeit < REGELN.sekundenZwischen) return false;
  if (zwischenziel && distance(zwischenziel, position) <= REGELN.zwischenzielMeter) return false;
  if (geplant.some((s) => distance(s, position) <= REGELN.geplantMeter)) return false;
  if (angezeigt.some((s) => distance(s, position) <= REGELN.angezeigtMeter)) return false;
  return true;
}
