# Projektbeschreibung: Electric Drive Companion

_Stand: 10.09.2026_

Dieses Dokument sagt, wozu die App da ist. Bei Widersprüchen zwischen Code,
README und diesem Text gilt dieser Text.

## Ein Satz

Eine eigenständige Navigations-App für die Langstrecke im E-Auto, deren
Unterschied zu jedem anderen Navi die Liste der Schnelllader entlang der Route
ist: Entfernung, Ladeleistung, Anbieter, Belegung.

## Problem

Wer eine Langstrecke elektrisch fährt, braucht zwei Dinge gleichzeitig: eine
Ansage, wo es langgeht, und eine belastbare Liste, wo unterwegs schnell geladen
werden kann. Die verbreiteten Navigationsprogramme können das erste und
scheitern am zweiten. Die im Alltag genutzte TomTom-Pro-App filtert die
angezeigten Lademöglichkeiten nicht nach Leistung und übergeht viele Standorte.

Ladeplaner wiederum können das zweite und nicht das erste. Sie planen, und zum
Fahren übergeben sie an eine andere App. Damit ist der Zusammenhang weg: Ändert
sich die Route unterwegs durch Verkehr, weiß der Planer nichts davon, und die
Planung muss ab dem aktuellen Punkt von Hand neu aufgesetzt werden. Genau das
ist während der Fahrt unbrauchbar.

Die Messung im Projekt hat gezeigt, dass das Datenproblem lösbar ist: Die
Suche entlang der Route allein findet 51 Prozent der Schnelllade-Standorte im
Zwei-Kilometer-Korridor, weil TomTom dort einen festen, schmalen geometrischen
Korridor anlegt. Mit zusätzlichen Umkreissuchen steigen es auf 93 Prozent,
gemessen gegen das Ladesäulenregister der Bundesnetzagentur auf 321 Kilometern.
Die verbleibenden Lücken sind ein Sportwagenhändler, eine Musikakademie und
Verwaltungsgesellschaften, sieben von acht unter 150 kW.

## Zwei Zwecke

**Primär, und das ist die App:** navigieren mit Ansage, dabei durchgehend die
Schnelllader entlang der Route im Blick.

**Sekundär, und das kommt später:** State of Charge. Die Zuschauerschaft des
YouTube-Kanals erfasst und bewertet die Schnellladepunkte in Deutschland
systematisch. Die App ist dafür ein Zugang, nicht der einzige.

## Nutzer und Rollen

| Rolle | Zugang | Hauptaktion |
|---|---|---|
| Fahrer, v1 nur Redaktion | TestFlight | Ziel eingeben, fahren, Ladestopps sehen |
| Zuschauer, State of Charge | Web, ohne Installation | einen Ladepunkt bewerten |
| Zuschauer, Vielfahrer | App | bewerten mit Standort und Ladevorgang im Rücken |
| Redaktion | App und Backend | eigene Testurteile hinterlegen, Datenbestand pflegen |

v1 geht nicht in den App Store. TestFlight für die Redaktion spart Review,
Datenschutzerklärung und Supportlast, solange noch offen ist, wie gut die
eigene Ansage im Alltag trägt.

## Was v1 können muss

1. **Ansagen.** Ohne Ansage ist es kein Navi, und der Grund dafür ist nicht
   Bequemlichkeit: Nur wer die Route selbst führt, weiß nach einer
   verkehrsbedingten Änderung noch, welche Ladestopps jetzt gelten.
2. **Ladestopps in der Route.** Nicht als Liste daneben, sondern als Teil der
   Planung, mit Ladezeit und Ladestand.
3. **Die Liste.** Entlang der Fahrtrichtung sortiert, ab 50 oder ab 150 kW,
   mit Anbieter, Leistung, Umweg und Belegung.

**Ausdrücklich nicht in v1:** App Store, Nutzerkonten, Bezahlfunktion,
Ladekarten-Tarife, Routen über mehrere Tage, Anhängerbetrieb,
Fahrzeugdatenanbindung, Android.

## Der Weg zur Ansage

Das Navigation SDK von TomTom ist im frei zugänglichen Paket nicht enthalten.
Die geprüfte Modulliste von `tomtom-sdk-spm-core` 0.73.2 hat 36 Module und
darunter kein einziges für Navigation, Guidance, Text-to-Speech oder
Neuberechnung. Es wird separat lizenziert.

Für den Prototypen wird die Ansage deshalb selbst gebaut, und zwar aus Teilen,
die der Freemium-Key hergibt:

| Bestandteil | Woher |
|---|---|
| Manöver, Straßennamen, Abbiegepunkte | Routing API, `instructionsType` |
| Route samt Ladestopps, Ladezeit, Ladestand | Long Distance EV Routing API |
| Position und Kurs | CoreLocation |
| Sprachausgabe | `AVSpeechSynthesizer`, in iOS enthalten |
| Neuberechnung bei Abweichung | erneuter Routing-Aufruf |

Was dabei fehlt und ehrlich benannt gehört: keine Kartenanpassung der Position,
also Zittern an Parallelstraßen und in Tunneln; keine Spurführung, keine
Kreuzungsgrafiken, keine Tempolimit-Warnungen. Für einen Prototypen, mit dem
gefahren und dann bei TomTom vorgesprochen wird, reicht das.

Parallel läuft die Lizenzanfrage, eingeleitet über die Presseabteilung von
TomTom statt über das Vertriebsformular.

## Datenmodell

**Station.** Ein Ladestandort. Kommt von TomTom, Kennung ist die POI-ID.
Felder: Name, Anbieter, Anschrift, Koordinate, Anschlüsse mit Leistung,
Kennung für die Belegungsabfrage.

**Bewertung.** Was jemand über einen Standort weiß. Kennung des Standorts,
Verfasser, Note, Urteil, Datum, Preis, Merkmale. Zwei Herkünfte, die getrennt
bleiben müssen: Redaktion und Zuschauer.

**Ladepunkt-Register.** Die Grundgesamtheit für State of Charge. Nicht aus
einem Routen-Export, denn der ist immer nur ein Ausschnitt einer Strecke,
sondern aus dem Ladesäulenregister der Bundesnetzagentur: 116.442
Ladeeinrichtungen, Leser und Standort-Clustering stehen und sind getestet.
Daraus die Schnelllader, zu Standorten zusammengefasst, ergibt den
Erfassungsbogen.

**Zuordnung.** Register und TomTom-POI müssen zusammenfinden, sonst hängt eine
Bewertung an nichts. Der Mechanismus steht: erst die POI-ID, sonst Entfernung
zu 60 Prozent und Namens- oder Betreiberähnlichkeit zu 40 Prozent, Radius 150
Meter, Mindestpunktzahl 0,45.

## Technik

| Baustein | Entscheidung | Stand |
|---|---|---|
| App | Swift, SwiftUI, iOS | steht |
| Karte, Suche, Routing | TomTom Maps SDK und REST, Freemium | steht |
| Ansage | selbst gebaut, siehe oben | offen |
| Ladestopps in der Route | Long Distance EV Routing API | offen |
| Verteilung v1 | TestFlight | offen |
| Backend | nötig, sobald State of Charge beginnt | offen |
| Geteilte Logik prüfen | Node-Werkzeuge unter `tools/`, 99 Tests | steht |
| Build | GitHub Actions, macOS-Läufer | steht |

Zum Backend: Die Antwort *beides von Anfang an*, Web und App, macht einen
gemeinsamen Datenspeicher zur Voraussetzung, nicht zur Option. Eine im
App-Bundle mitgelieferte JSON-Datei kann das nicht leisten. Sie bleibt, bis
State of Charge beginnt, und wird dann ersetzt; `EditorialStore.loadBundled()`
ist genau dafür die einzige auszutauschende Stelle.

## Offene Fragen und Risiken

- [ ] Trägt die selbst gebaute Ansage im Alltag? Das entscheidet eine Fahrt,
      keine Überlegung. Größter technischer Brocken von v1.
- [ ] Was kostet das Navigation SDK, und was geht über die Presseschiene?
- [ ] Deckt das Freemium-Kontingent eine Fahrt mit Neuberechnungen? Non-Tile
      liegt bei 2.500 Anfragen am Tag, eine Fahrt braucht davon wenige Dutzend.
      Zu prüfen, ob Long Distance EV Routing aus demselben Topf zählt.
- [ ] Woher kommen Verbrauch und Ladekurve des Fahrzeugs? Ohne beides plant die
      EV-Route falsch. Für v1 reicht ein Profil von Hand.
- [ ] Missbrauch bei State of Charge: Offene Bewertungen aus dem Web ohne Konto
      laden zu Mehrfachabgaben ein.
- [ ] Belegungsabfrage kostet eine Anfrage je Standort. Bei 125 Standorten
      entlang einer Route ist das zu viel für einen Rutsch.

## Nächste Schritte

1. Presseanfrage an TomTom entwerfen, Ziel: Konditionen und Versuchskontingent
   für das Navigation SDK.
2. Long Distance EV Routing anbinden und gegen die bisherige Routenplanung
   stellen. Ergebnis: Ladestopps stecken in der Route statt daneben.
3. Ansage bauen: Manöverliste, Entfernung zum nächsten Manöver, Sprachausgabe,
   Abweichungserkennung.
4. Fahren. Eine echte Strecke, danach entscheiden, was die Liste können muss.
5. Erst danach State of Charge und damit die Backend-Entscheidung.
