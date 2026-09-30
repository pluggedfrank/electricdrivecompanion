// quellen.mjs
// Register und TomTom auf einer Route, die ueber die Grenze geht.
//
// Das Ladesaeulenregister der Bundesnetzagentur kennt nur Deutschland. Bis
// zum 30.09.2026 galt: Hat das Register etwas auf der Route, wird TomTom
// nicht gefragt. Auf dem Weg nach Amsterdam hiess das: deutscher Teil voll,
// niederlaendischer leer, auch mit Fastned als Favorit. Jetzt sucht TomTom
// die Abschnitte ausserhalb Deutschlands ab, und beides wird zusammengelegt.
//
// Gegenstueck in Swift: LadeRoute/Register/StationSources.swift.

import { distance } from './geo.mjs';

/**
 * Die Stuecke der Route ausserhalb Deutschlands, als Punktlisten.
 *
 *  punkte      Routengeometrie [{ lat, lon }]
 *  abschnitte  Laenderabschnitte [{ von, bis, land }], Punktindizes, land
 *              als ISO-3166-alpha-3 ("DEU", "NLD")
 *  rand        so viele Meter reicht ein Stueck in den deutschen Teil
 *              hinein: Grenzstationen sollen nicht zwischen beiden Quellen
 *              verloren gehen
 *
 * Benachbarte Auslandsabschnitte (NLD direkt nach BEL) werden ein Stueck.
 */
export function auslandsStuecke(punkte, abschnitte, { rand = 2000 } = {}) {
  const kumuliert = [0];
  for (let i = 1; i < punkte.length; i++) kumuliert[i] = kumuliert[i - 1] + distance(punkte[i - 1], punkte[i]);

  const bereiche = [];
  for (const a of [...abschnitte].sort((x, y) => x.von - y.von)) {
    if (a.land === 'DEU') continue;
    const letzter = bereiche.at(-1);
    if (letzter && a.von <= letzter.bis + 1) letzter.bis = Math.max(letzter.bis, a.bis);
    else bereiche.push({ von: a.von, bis: a.bis });
  }

  return bereiche.map(({ von, bis }) => {
    let start = von;
    while (start > 0 && kumuliert[von] - kumuliert[start - 1] <= rand) start--;
    let ende = bis;
    while (ende < punkte.length - 1 && kumuliert[ende + 1] - kumuliert[bis] <= rand) ende++;
    return punkte.slice(start, ende + 1);
  });
}

/**
 * Register und TomTom-Treffer zusammen. Ein TomTom-Treffer innerhalb von
 * `radius` Metern eines Registerstandorts ist derselbe Standort und
 * faellt weg: Das Register ist fuer Deutschland die bessere Quelle.
 */
export function zusammenfuehren(register, tomtom, { radius = 150 } = {}) {
  const neu = tomtom.filter((t) => !register.some((r) => distance(r, t) <= radius));
  return [...register, ...neu];
}
