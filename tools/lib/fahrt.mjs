// fahrt.mjs
// Was die Fahransicht rechnet: wo das Auto auf der Route steht, und welche
// Ladestationen in den drei Kacheln rechts stehen.
//
// Gegenstueck in Swift: LadeRoute/Driving/DrivingTiles.swift und
// RouteTracker.swift. Die Tests hier sind der Massstab fuer beide.

import { distance } from './geo.mjs';

/** Weg bis zu jedem Routenpunkt. */
export function routenLage(punkte) {
  const kumuliert = new Array(punkte.length).fill(0);
  for (let i = 1; i < punkte.length; i++) {
    kumuliert[i] = kumuliert[i - 1] + distance(punkte[i - 1], punkte[i]);
  }
  return { punkte, kumuliert, laenge: kumuliert[punkte.length - 1] ?? 0 };
}

/**
 * Lotfusspunkt von p auf das Segment a-b, als Anteil 0..1 und Abstand in Metern.
 * Lokal eben gerechnet; auf Segmentlaenge ist der Fehler vernachlaessigbar.
 */
export function aufSegment(p, a, b) {
  const breite = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const mx = 111_320 * Math.cos(breite);
  const my = 111_132;
  const ax = 0, ay = 0;
  const bx = (b.lon - a.lon) * mx, by = (b.lat - a.lat) * my;
  const px = (p.lon - a.lon) * mx, py = (p.lat - a.lat) * my;
  const l2 = bx * bx + by * by;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / l2)) : 0;
  const dx = px - t * bx, dy = py - t * by;
  return { t, abstand: Math.sqrt(dx * dx + dy * dy) };
}

/**
 * Wo steht das Auto auf der Route?
 *
 * Gesucht wird zuerst in einem Fenster ab dem letzten Treffer, nicht auf der
 * ganzen Route: Eine Autobahn kommt sich selbst manchmal nahe, etwa an einem
 * Kreuz, und eine globale Suche springt dann auf den falschen Ast. Erst wenn
 * im Fenster nichts unter 300 m liegt, wird die ganze Route abgesucht; dann
 * ist das Auto abgebogen oder die Ortung kam gerade zurueck.
 */
export function verorte(lage, p, letzterIndex = 0, { zurueck = 20, vor = 400, fang = 300 } = {}) {
  const suche = (von, bis) => {
    let best = null;
    for (let i = Math.max(0, von); i < Math.min(lage.punkte.length - 1, bis); i++) {
      const s = aufSegment(p, lage.punkte[i], lage.punkte[i + 1]);
      if (!best || s.abstand < best.abstand) {
        const segLaenge = lage.kumuliert[i + 1] - lage.kumuliert[i];
        best = { index: i, abstand: s.abstand, fortschritt: lage.kumuliert[i] + s.t * segLaenge };
      }
    }
    return best;
  };
  const nah = suche(letzterIndex - zurueck, letzterIndex + vor);
  if (nah && nah.abstand <= fang) return { ...nah, aufDerRoute: true };
  const weit = suche(0, lage.punkte.length);
  if (!weit) return null;
  return { ...weit, aufDerRoute: weit.abstand <= fang };
}

/**
 * Weg von der Route bis zur Saeule, einfach.
 *
 * Am genauesten ist die halbe Umwegstrecke: Hin und zurueck sind meist gleich
 * lang. Kennt man nur die Umwegzeit, wird sie mit Stadttempo in Meter
 * umgerechnet, 50 km/h. Ohne beides bleibt die Luftlinie zur Route.
 */
export function zugangMeter(s) {
  if (Number.isFinite(s.detourMeters)) return s.detourMeters / 2;
  if (Number.isFinite(s.detourSeconds)) return (s.detourSeconds * (50 / 3.6)) / 2;
  return s.distanceFromRouteMeters ?? 0;
}

/**
 * Die Kacheln der Fahransicht.
 *
 *  stationen      die angezeigte Liste, schon gefiltert (Leistung, Umweg,
 *                 Abstand), mit progressMeters
 *  fortschritt    wo das Auto steht, Meter ab Routenbeginn
 *  akkuJetzt      Ladestand jetzt, Prozent
 *  prozentJeKm    Verbrauch als Prozent Akku je Kilometer
 *  reserve        darunter gilt eine Station als nicht erreichbar
 *  geplant        Kennungen der geplanten Ladestopps
 *
 * Regeln aus dem Konzept: hoechstens drei, nur was vor dem Auto liegt,
 * Stationen innerhalb von 2 km zu einer Kachel gebuendelt (es zaehlt die mit
 * dem kleinsten Umweg, ein geplanter Stopp geht vor), und die Linie der
 * Reichweite dort, wo die Reserve erreicht ist.
 */
export function kacheln({
  stationen,
  fortschritt,
  akkuJetzt,
  prozentJeKm,
  reserve = 10,
  geplant = new Set(),
  anzahl = 3,
  buendel = 2000,
  vorbei = 100,
}) {
  const vorne = stationen
    .filter((s) => Number.isFinite(s.progressMeters) && s.progressMeters > fortschritt + vorbei)
    .sort((a, b) => a.progressMeters - b.progressMeters);

  const gruppen = [];
  for (const s of vorne) {
    const letzte = gruppen[gruppen.length - 1];
    if (letzte && s.progressMeters - letzte[0].progressMeters <= buendel) letzte.push(s);
    else gruppen.push([s]);
    if (gruppen.length > anzahl) break;
  }

  const umweg = (s) => (Number.isFinite(s.detourSeconds) ? s.detourSeconds : Infinity);
  const reichweiteMeter = Math.max(0, ((akkuJetzt - reserve) / prozentJeKm) * 1000);

  return gruppen.slice(0, anzahl).map((gruppe) => {
    const beste = gruppe.find((s) => geplant.has(s.id)) ??
      gruppe.reduce((a, b) => (umweg(b) < umweg(a) ? b : a));
    const meter = beste.progressMeters - fortschritt + zugangMeter(beste);
    const akkuBeiAnkunft = akkuJetzt - (meter / 1000) * prozentJeKm;
    return {
      station: beste,
      meter,
      akkuBeiAnkunft,
      erreichbar: meter <= reichweiteMeter,
      geplant: geplant.has(beste.id),
      weitere: gruppe.length - 1,
    };
  });
}

/** Wo die Linie der Reichweite in der Spalte steht: vor dieser Kachel, oder -1. */
export function reichweitenLinie(liste) {
  return liste.findIndex((k) => !k.erreichbar);
}
