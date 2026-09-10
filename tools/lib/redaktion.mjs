// redaktion.mjs
// Führt einen Export echter Suchtreffer mit dem vorhandenen Redaktionsbestand
// zusammen.
//
// Die Arbeitsteilung dahinter ist dieselbe, die auch die App zeigt: Woher eine
// Station kommt, wie sie heißt und wo sie steht, weiß TomTom. Ob sie etwas
// taugt, wissen nur wir. Ein Import darf deshalb Kennung, Name und Koordinaten
// überschreiben, aber niemals ein Urteil.
//
// Der Export selbst enthält noch kein Urteil. Er ist die Arbeitsliste: die
// Stationen, an denen TomTom tatsächlich POIs kennt, mit ihren echten IDs.
// Erst das Fahren füllt sie.

/** Was `--export-editorial` in ein noch nicht ausgefülltes Urteil schreibt. */
export const PLATZHALTER = 'NOCH NICHT GETESTET';

/**
 * Liefert das Urteil oder null.
 *
 * Spiegelt EditorialEntry.verdictText in Swift, mit einer Zutat: Der
 * Platzhalter aus dem Export gilt hier als "kein Urteil". In die App gelangt
 * er dadurch gar nicht erst, dort steht dann schlicht null.
 */
export function urteil(entry) {
  const text = (entry?.verdict ?? '').trim();
  if (text === '') return null;
  if (text.toUpperCase().startsWith(PLATZHALTER)) return null;
  return text;
}

/** Getestet ist, wozu ein Urteil vorliegt. Spiegelt EditorialEntry.isTested. */
export function istGetestet(entry) {
  return urteil(entry) !== null;
}

/** Kennung für den Abgleich: die POI-ID, sonst die eigene Kennung. */
function schluessel(entry) {
  return entry.tomtomPoiID ? `poi:${entry.tomtomPoiID}` : `id:${entry.id}`;
}

/**
 * Prüft einen Datensatz auf das, was die App voraussetzt.
 *
 * Bewusst streng bei den Koordinaten: Ein Eintrag bei 0/0 trifft im Atlantik
 * nichts und fiele erst auf, wenn jemand sich fragt, warum sein Testbericht
 * nirgends auftaucht.
 */
export function pruefe(entry, index) {
  const fehler = [];
  const wo = entry?.id ? `Eintrag ${entry.id}` : `Eintrag Nr. ${index + 1}`;

  if (!entry || typeof entry !== 'object') return [`${wo}: kein Objekt`];
  if (!entry.id) fehler.push(`${wo}: ohne id`);
  if (!entry.name) fehler.push(`${wo}: ohne name`);

  const lat = entry.latitude;
  const lon = entry.longitude;
  if (typeof lat !== 'number' || Number.isNaN(lat) || lat < -90 || lat > 90) {
    fehler.push(`${wo}: latitude ${lat}`);
  }
  if (typeof lon !== 'number' || Number.isNaN(lon) || lon < -180 || lon > 180) {
    fehler.push(`${wo}: longitude ${lon}`);
  }
  if (lat === 0 && lon === 0) fehler.push(`${wo}: Koordinate 0/0`);

  if (entry.rating != null && (entry.rating < 1 || entry.rating > 5)) {
    fehler.push(`${wo}: rating ${entry.rating} liegt außerhalb 1 bis 5`);
  }
  if (entry.testedAt != null && Number.isNaN(Date.parse(entry.testedAt))) {
    fehler.push(`${wo}: testedAt ${entry.testedAt} ist kein Datum`);
  }

  return fehler;
}

/** Bringt einen Datensatz in die Form, die die App liest. */
function normalisiere(entry) {
  return {
    id: entry.id,
    tomtomPoiID: entry.tomtomPoiID ?? null,
    name: entry.name,
    operatorName: entry.operatorName ?? null,
    address: entry.address ?? null,
    latitude: entry.latitude,
    longitude: entry.longitude,
    rating: entry.rating ?? null,
    verdict: urteil(entry),
    testedAt: entry.testedAt ?? null,
    pricePerKWh: entry.pricePerKWh ?? null,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    author: entry.author ?? null,
  };
}

/** Nächste freie Kennung in der Form ed-NNN. */
function kennungsgeber(vorhanden) {
  let hoechste = 0;
  for (const entry of vorhanden) {
    const treffer = /^ed-(\d+)$/.exec(entry.id ?? '');
    if (treffer) hoechste = Math.max(hoechste, Number(treffer[1]));
  }
  const belegt = new Set(vorhanden.map((e) => e.id));
  return () => {
    let kandidat;
    do {
      hoechste += 1;
      kandidat = `ed-${String(hoechste).padStart(3, '0')}`;
    } while (belegt.has(kandidat));
    belegt.add(kandidat);
    return kandidat;
  };
}

/**
 * Führt Bestand und Import zusammen.
 *
 * Was zusammengehört, erkennt die POI-ID. Sie steht im Export und ist bei
 * TomTom eindeutig; die Namensheuristik der App braucht es hier nicht, weil
 * beide Seiten aus derselben Quelle stammen.
 */
export function fuehreZusammen(bestand, importiert) {
  const fehler = [
    ...bestand.flatMap(pruefe),
    ...importiert.flatMap(pruefe),
  ];
  if (fehler.length > 0) {
    const fehlerObjekt = new Error(`${fehler.length} fehlerhafte Datensätze`);
    fehlerObjekt.details = fehler;
    throw fehlerObjekt;
  }

  const nachSchluessel = new Map();
  for (const entry of bestand) {
    const key = schluessel(entry);
    if (nachSchluessel.has(key)) {
      throw new Error(`Bestand enthält ${key} doppelt`);
    }
    nachSchluessel.set(key, normalisiere(entry));
  }

  const naechsteKennung = kennungsgeber(bestand);
  const statistik = { bestand: bestand.length, neu: 0, ergaenzt: 0, unveraendert: 0 };

  for (const roh of importiert) {
    const eingang = normalisiere(roh);
    const key = schluessel(eingang);
    const alt = nachSchluessel.get(key);

    if (!alt) {
      nachSchluessel.set(key, { ...eingang, id: naechsteKennung() });
      statistik.neu += 1;
      continue;
    }

    // Standortdaten kommen aus dem Import, das Urteil bleibt beim Bestand.
    const zusammengefuehrt = {
      ...alt,
      tomtomPoiID: eingang.tomtomPoiID ?? alt.tomtomPoiID,
      name: eingang.name || alt.name,
      operatorName: eingang.operatorName ?? alt.operatorName,
      address: eingang.address ?? alt.address,
      latitude: eingang.latitude,
      longitude: eingang.longitude,
    };

    // Ein Urteil aus dem Import zählt nur, wo noch keines steht. So kann ein
    // erneuter Import eine bereits getestete Station nicht zurücksetzen.
    if (eingang.verdict && !alt.verdict) {
      zusammengefuehrt.verdict = eingang.verdict;
      zusammengefuehrt.rating = eingang.rating ?? alt.rating;
      zusammengefuehrt.testedAt = eingang.testedAt ?? alt.testedAt;
      zusammengefuehrt.pricePerKWh = eingang.pricePerKWh ?? alt.pricePerKWh;
      zusammengefuehrt.tags = eingang.tags.length > 0 ? eingang.tags : alt.tags;
      zusammengefuehrt.author = eingang.author ?? alt.author;
    }

    const veraendert = JSON.stringify(zusammengefuehrt) !== JSON.stringify(alt);
    if (veraendert) statistik.ergaenzt += 1;
    else statistik.unveraendert += 1;

    nachSchluessel.set(key, zusammengefuehrt);
  }

  const entries = [...nachSchluessel.values()].sort((a, b) => a.id.localeCompare(b.id));
  statistik.gesamt = entries.length;
  statistik.getestet = entries.filter(istGetestet).length;
  statistik.erfasst = statistik.gesamt - statistik.getestet;

  return { entries, statistik };
}
