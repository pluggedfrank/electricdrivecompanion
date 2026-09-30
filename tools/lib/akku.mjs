// akku.mjs
// Der Ladestand waehrend der Fahrt, auch ueber Ladestopps hinweg.
//
// Drei Teile:
//  akkuJetzt       Startwert und Ladestopps, abzueglich des Verbrauchs seitdem
//  ladungNach      was eine Saeule in einer bestimmten Zeit nachlaedt
//  haltSchritt     erkennt, dass das Auto an einer Saeule gestanden hat
//
// Gegenstueck in Swift: LadeRoute/Driving/ChargeTracker.swift. Die Tests hier
// sind der Massstab fuer beide.

import { distance } from './geo.mjs';
import { leistungBei } from './ladeplanung.mjs';

/**
 * Ladestand jetzt.
 *
 *  start          Prozent bei Abfahrt
 *  ereignisse     [{ beiMeter, prozent }]: nach so viel gefahrener Strecke
 *                 stand der Akku auf so viel, etwa nach einem Ladestopp
 *  gefahrenMeter  seit Abfahrt, ueber Umleitungen hinweg
 *  prozentJeKm    Verbrauch
 *
 * Es zaehlt das letzte Ereignis, das schon hinter dem Auto liegt.
 */
export function akkuJetzt({ start, ereignisse = [], gefahrenMeter, prozentJeKm }) {
  let basis = { beiMeter: 0, prozent: start };
  for (const e of ereignisse) {
    if (e.beiMeter <= gefahrenMeter && e.beiMeter >= basis.beiMeter) basis = e;
  }
  return Math.max(0, basis.prozent - ((gefahrenMeter - basis.beiMeter) / 1000) * prozentJeKm);
}

/**
 * Ladestand nach `sekunden` an einer Saeule mit `saeulenKW`, ab `vonKWh`.
 *
 * Minutenweise vorwaerts, mit der Leistung aus der Kurve des Fahrzeugs und
 * gedeckelt durch die Saeule. Umkehrung von ladezeitSekunden().
 */
export function ladungNach(vonKWh, sekunden, kurve, saeulenKW, akkuKWh) {
  let ladung = vonKWh;
  let rest = sekunden;
  const schritt = 30;
  while (rest > 0 && ladung < akkuKWh) {
    const dt = Math.min(schritt, rest);
    const leistung = Math.min(leistungBei(ladung, kurve), saeulenKW);
    if (leistung <= 0) break;
    ladung = Math.min(akkuKWh, ladung + (leistung * dt) / 3600);
    rest -= dt;
  }
  return ladung;
}

/**
 * Schaetzt den Ladestand nach einem Halt an einer Saeule, in Prozent.
 *
 * Vom Halt gehen zwei Minuten ab: anstecken, freischalten, abstecken. Ohne
 * bekannte Saeulenleistung 50 kW, das hat jede Schnellladesaeule.
 */
export function ladeSchaetzung({ akkuProzent, haltMinuten, saeulenKW, fahrzeug }) {
  const kWh = fahrzeug.usableBatteryKWh;
  const sekunden = Math.max(0, haltMinuten - 2) * 60;
  const neu = ladungNach((akkuProzent / 100) * kWh, sekunden, fahrzeug.chargingCurve, saeulenKW ?? 50, kWh);
  return Math.min(100, (neu / kWh) * 100);
}

/** Kennzahlen der Halteerkennung. */
export const HALT = {
  /** So nah muss das Auto an der Saeule stehen. */
  radiusMeter: 150,
  /** So lange muss es dort stehen, bevor es als Ladestopp zaehlt. */
  mindestSekunden: 120,
  /** So weit muss es sich entfernen, damit der Halt vorbei ist. */
  wegMeter: 300,
};

export function neuerHalt() {
  return { station: null, seit: null, angekommen: false };
}

/**
 * Ein Schritt der Halteerkennung.
 *
 *  zeit        Sekunden, beliebiger Nullpunkt
 *  position    { lat, lon }
 *  stationen   [{ id, lat, lon, ... }]
 *
 * Liefert null oder ein Ereignis:
 *  { art: 'angekommen', station }                nach 2 Minuten an der Saeule
 *  { art: 'weiter', station, minuten }           beim Wegfahren danach
 *
 * Ein Stau neben einer Saeule sieht fuer die Rechnung aus wie ein Halt. Das
 * ist in Kauf genommen: Der Stand danach laesst sich antippen und
 * korrigieren, und zwei Minuten Stau direkt neben einer Saeule sind selten.
 */
export function haltSchritt(zustand, { zeit, position, stationen }) {
  if (zustand.station) {
    const d = distance(position, zustand.station);
    if (d <= HALT.radiusMeter) {
      if (!zustand.angekommen && zeit - zustand.seit >= HALT.mindestSekunden) {
        zustand.angekommen = true;
        return { art: 'angekommen', station: zustand.station };
      }
      return null;
    }
    if (d < HALT.wegMeter) return null;
    const war = zustand;
    const ereignis = war.angekommen
      ? { art: 'weiter', station: war.station, minuten: (zeit - war.seit) / 60 }
      : null;
    Object.assign(zustand, neuerHalt());
    return ereignis;
  }

  let naechste = null;
  let best = Infinity;
  for (const s of stationen) {
    const d = distance(position, s);
    if (d < best) {
      best = d;
      naechste = s;
    }
  }
  if (naechste && best <= HALT.radiusMeter) {
    zustand.station = naechste;
    zustand.seit = zeit;
    zustand.angekommen = false;
  }
  return null;
}
