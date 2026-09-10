// ladeplanung.mjs
// Setzt Ladestopps in eine geplante Route.
//
// Warum selbst rechnen: Die Long Distance EV Routing API von TomTom kann das,
// steht aber nicht zur Selbstbedienung. Alles Noetige liegt ohnehin vor: die
// Route, jede Station mit ihrer Lage entlang der Strecke, Leistung und Umweg,
// dazu Kapazitaet, Verbrauch und Ladekurve des Fahrzeugs.
//
// Fuer ein Magazin ist das eher Vorteil als Notbehelf. Warum genau dieser Stopp
// vorgeschlagen wird, laesst sich damit erklaeren, und die Begruendung steht in
// den Daten statt in einer fremden Blackbox.
//
// Spiegelt ChargingStopPlanner.swift. Wer eine Fassung aendert, aendert beide.

/**
 * Ladeleistung bei einem bestimmten Ladestand, aus der Kurve des Fahrzeugs.
 *
 * Zwischen den Stuetzstellen wird linear interpoliert. Die Kurve ist eine Form,
 * keine Messung; ihr Sinn ist, dass die letzten Prozent laenger dauern als die
 * ersten, denn genau daran haengt die Entscheidung, wie voll geladen wird.
 */
export function leistungBei(ladungKWh, kurve) {
  if (kurve.length === 0) return 0;
  if (ladungKWh <= kurve[0].chargeKWh) return kurve[0].powerKW;

  for (let i = 1; i < kurve.length; i++) {
    const a = kurve[i - 1];
    const b = kurve[i];
    if (ladungKWh <= b.chargeKWh) {
      const spanne = b.chargeKWh - a.chargeKWh;
      if (spanne <= 0) return b.powerKW;
      const anteil = (ladungKWh - a.chargeKWh) / spanne;
      return a.powerKW + (b.powerKW - a.powerKW) * anteil;
    }
  }
  return kurve[kurve.length - 1].powerKW;
}

/**
 * Wie lange dauert es, von einem Ladestand auf einen anderen zu kommen.
 *
 * In kleinen Schritten aufsummiert, weil die Leistung waehrend des Ladens
 * faellt. Begrenzt wird sie doppelt: durch die Kurve des Fahrzeugs und durch
 * das, was die Saeule hergibt. Eine 400-kW-Saeule laedt ein Auto nicht
 * schneller, als das Auto kann, und umgekehrt.
 */
export function ladezeitSekunden(vonKWh, bisKWh, kurve, saeulenleistungKW) {
  if (bisKWh <= vonKWh) return 0;

  const schritte = 60;
  const schritt = (bisKWh - vonKWh) / schritte;
  let sekunden = 0;

  for (let i = 0; i < schritte; i++) {
    const mitte = vonKWh + schritt * (i + 0.5);
    const leistung = Math.min(leistungBei(mitte, kurve), saeulenleistungKW);
    if (leistung <= 0) return Infinity;
    sekunden += (schritt / leistung) * 3600;
  }

  return sekunden;
}

/** Verbrauch je Meter, in kWh. */
function verbrauchProMeter(fahrzeug) {
  return fahrzeug.consumptionKWhPer100km / 100000;
}

/** Die Schwellen des Fahrzeugs in kWh statt in Prozent. */
export function schwellen(fahrzeug) {
  const k = fahrzeug.usableBatteryKWh;
  return {
    start: (k * fahrzeug.currentChargePercent) / 100,
    amZiel: (k * fahrzeug.minArrivalPercent) / 100,
    unterwegs: (k * fahrzeug.minChargeAtStopPercent) / 100,
    ladenBis: (k * fahrzeug.maxChargeAtStopPercent) / 100,
  };
}

/**
 * Waehlt die Ladestopps.
 *
 * Zwei Regeln, in dieser Reihenfolge:
 *
 * 1. So wenige Stopps wie moeglich. Kommt eine Station in Reichweite, von der
 *    aus sich das Ziel erreichen laesst, wird eine davon genommen, und zwar die
 *    mit der kuerzesten Standzeit aus Laden und Umweg.
 * 2. Sonst die Station, die je Minute Standzeit am weitesten bringt.
 *
 * Die Reihenfolge ist der Kern. Die naheliegende Auswahl waere, immer die
 * staerkste Saeule in Reichweite zu nehmen; das ist falsch, weil eine
 * 300-kW-Saeule nach 60 km einen zweiten Stopp erzwingt, den eine 150-kW-Saeule
 * nach 260 km erspart. Ein Stopp kostet mehr als die Ladezeit: Abfahren,
 * anstecken, bezahlen, wieder auffahren.
 *
 * Die Fahrzeit steht bewusst in keiner der beiden Regeln. Sie faellt an, egal
 * welche Station gewaehlt wird; sie mitzurechnen liess weit entfernte
 * Stationen teuer aussehen und bevorzugte den fruehen Stopp.
 */
export function planeStopps({
  routeLengthMeters,
  stations,
  fahrzeug,
  minPowerKW = 50,
}) {
  const s = schwellen(fahrzeug);
  const proMeter = verbrauchProMeter(fahrzeug);
  const kurve = fahrzeug.chargingCurve;

  // Nur was entlang der Route liegt, stark genug ist und noch vor dem Ziel.
  const kandidaten = stations
    .filter((st) => (st.maxPowerKW ?? 0) >= minPowerKW)
    .filter((st) => st.progressMeters > 0 && st.progressMeters < routeLengthMeters)
    .sort((a, b) => a.progressMeters - b.progressMeters);

  const stopps = [];
  let position = 0;
  let ladung = s.start;

  // Mehr Stopps als Kandidaten kann es nicht geben; die Schranke faengt einen
  // Programmierfehler ab, statt die App haengen zu lassen.
  for (let runde = 0; runde <= kandidaten.length; runde++) {
    const bisZiel = routeLengthMeters - position;
    const brauchtBisZiel = bisZiel * proMeter + s.amZiel;

    if (ladung >= brauchtBisZiel) {
      return {
        machbar: true,
        stopps,
        ankunftKWh: ladung - bisZiel * proMeter,
        ladezeitGesamtSekunden: stopps.reduce((sum, st) => sum + st.ladezeitSekunden, 0),
        umwegGesamtSekunden: stopps.reduce((sum, st) => sum + (st.umwegSekunden ?? 0), 0),
      };
    }

    // So weit kommen wir noch, ohne unter die Untergrenze zu fallen.
    const reichweiteMeter = Math.max(0, (ladung - s.unterwegs) / proMeter);
    const erreichbare = kandidaten.filter(
      (st) => st.progressMeters > position && st.progressMeters - position <= reichweiteMeter
    );

    if (erreichbare.length === 0) {
      const naechste = kandidaten.find((st) => st.progressMeters > position);
      return {
        machbar: false,
        stopps,
        grund: naechste
          ? 'luecke'
          : 'keineStationen',
        luecke: naechste
          ? {
              vonMeter: position,
              bisMeter: naechste.progressMeters,
              reichweiteMeter,
              fehlendeMeter: naechste.progressMeters - position - reichweiteMeter,
              station: naechste,
            }
          : null,
        reichweiteMeter,
      };
    }

    const bewertet = [];
    for (const station of erreichbare) {
      const strecke = station.progressMeters - position;
      const ankunft = ladung - strecke * proMeter;
      const umweg = station.detourSeconds ?? 0;

      // Bis wohin laden: so viel, wie bis zum Ziel noch fehlt, hoechstens aber
      // bis zur Grenze, ab der jede Saeule langsam wird.
      const restNachStopp = routeLengthMeters - station.progressMeters;
      const noetig = restNachStopp * proMeter + s.amZiel;
      const ziel = Math.min(
        s.ladenBis,
        Math.max(ankunft, Math.min(noetig, fahrzeug.usableBatteryKWh))
      );

      const ladezeit = ladezeitSekunden(ankunft, ziel, kurve, station.maxPowerKW ?? 0);
      const weiterMeter = Math.max(0, (ziel - s.unterwegs) / proMeter);
      const gesamtMeter = station.progressMeters + weiterMeter;
      if (gesamtMeter <= position) continue;

      bewertet.push({
        station,
        ankunftKWh: ankunft,
        zielKWh: ziel,
        ladezeitSekunden: ladezeit,
        umwegSekunden: umweg,
        standzeit: ladezeit + umweg,
        gewinnMeter: gesamtMeter - position,
        // Reicht es von hier bis zum Ziel, mit Reserve?
        bisZumZiel: ziel - restNachStopp * proMeter >= s.amZiel - 1e-9,
      });
    }

    if (bewertet.length === 0) {
      return { machbar: false, stopps, grund: 'keinFortschritt', reichweiteMeter };
    }

    const abschliessende = bewertet.filter((k) => k.bisZumZiel);
    const bester = abschliessende.length > 0
      ? abschliessende.reduce((a, b) => (b.standzeit < a.standzeit ? b : a))
      : bewertet.reduce((a, b) =>
          b.standzeit / b.gewinnMeter < a.standzeit / a.gewinnMeter ? b : a
        );

    stopps.push({
      station: bester.station,
      progressMeters: bester.station.progressMeters,
      ankunftKWh: Number(bester.ankunftKWh.toFixed(2)),
      abfahrtKWh: Number(bester.zielKWh.toFixed(2)),
      ladezeitSekunden: Math.round(bester.ladezeitSekunden),
      umwegSekunden: Math.round(bester.umwegSekunden),
    });

    position = bester.station.progressMeters;
    ladung = bester.zielKWh;
  }

  return { machbar: false, stopps, grund: 'zuVieleRunden' };
}
