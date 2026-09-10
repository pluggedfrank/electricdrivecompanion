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

**Sekundär, aber nicht später:** State of Charge. Die Zuschauerschaft des
YouTube-Kanals erfasst und bewertet die Schnellladepunkte in Deutschland
systematisch. Das beginnt im Web und wartet nicht auf die App, denn eine
Installation vor der ersten Bewertung kostet die meisten Teilnehmer, und die
App hat noch kein Fertigstellungsdatum. Die App wird der zweite Zugang, und für
Vielfahrer der bessere.

Die beiden Zwecke sind damit zwei Arbeitsstränge, die sich eine Datenbasis
teilen, aber einander nicht blockieren.

## Nutzer und Rollen

| Rolle | Zugang | Hauptaktion |
|---|---|---|
| Fahrer, v1 nur Redaktion | TestFlight | Ziel eingeben, fahren, Ladestopps sehen |
| Zuschauer, Gelegenheitsbewerter | Web, ohne Installation | einen Ladepunkt bewerten, sehen was schon erfasst ist |
| Zuschauer, Tester | App, Haken gesetzt | unterwegs erfassen, Lücken gezielt anfahren |
| Redaktion | App und Backend | eigene Testurteile hinterlegen, Einsendungen sichten |

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

## State of Charge

**Grundgesamtheit.** Die Schnelllader aus dem Ladesäulenregister der
Bundesnetzagentur, zu Standorten zusammengefasst. Das ist der Erfassungsbogen,
und daran misst sich der Fortschritt: erfasst gegen bekannt. Ein Routen-Export
kann das nicht leisten, er ist immer nur ein Ausschnitt einer Strecke.

Gemessen am Register vom 01.09.2026, 116.442 Ladeeinrichtungen:

| Leistung | Ladeeinrichtungen | Standorte | Ladepunkte |
|---|---:|---:|---:|
| ab 50 kW | 31.505 | 14.804 | 61.025 |
| ab 150 kW | 23.582 | 9.285 | 42.922 |
| ab 300 kW | 11.248 | 4.668 | 21.496 |

Zwei Kontrollen, die beide beruhigen: Die eigene Klassifizierung des Registers
zählt 31.154 Schnellladeeinrichtungen, die Nennleistungsschwelle 31.505. Ein
Prozent Abweichung, die beiden Wege beschreiben dasselbe. Und aus 31.505
Einrichtungen werden 14.804 Standorte, das Zusammenfassen leistet also
tatsächlich etwas, im Schnitt zwei Einrichtungen und vier Ladepunkte je Ort.

**Entschieden: ab 300 kW, danach 150 kW, 50 kW gar nicht.** 4.668 Orte im
ersten Schritt, 9.285 im zweiten. Die 50-kW-Lader bleiben draußen, und das ist
kein Aufwandsargument: Sie werden heute nicht mehr gezielt angefahren, sie sind
Notlösungen. Eine Erhebung, die sie mitführte, würde Aufwand in Orte stecken,
über die niemand eine Kaufentscheidung trifft.

14.804 Orte wären ohnehin nicht zu schaffen gewesen. Eine Karte, die auf Jahre
zu 99 Prozent leer bleibt, entmutigt statt anzuspornen.

Dieselbe Entscheidung gilt in der App: Die Voreinstellung der Liste liegt bei
150 kW statt bei 50, mit 300 kW als Stufe darüber. 50 kW bleibt wählbar, denn
im Auto ist eine Notlösung immer noch besser als nichts, aber sie steht nicht
mehr vorn.

Für den Fortschritt spricht auch die Verteilung: Die fünfzehn größten Betreiber
decken rund die Hälfte aller Standorte ab. Eine Kampagne kann daran entlang
laufen, statt die Landkarte gleichmäßig abzuarbeiten.

**Im Web zuerst.** Eine Seite auf **plugged.de**, WordPress, aus einem Video
heraus mit einem Klick erreichbar. Sie zeigt die Karte mit dem Stand der Erfassung,
also welche Standorte schon bewertet sind und welche nicht, und nimmt neue
Bewertungen entgegen. Das Zeigen ist nicht Beiwerk: Wer sieht, dass in seiner
Ecke noch nichts steht, hat einen Grund mitzumachen.

**Zwei Tiefen, nicht eine.** Ein Bogen, der alles fragt, was ein Magazintest
braucht, schreckt Gelegenheitsteilnehmer ab. Ein Bogen, der nur die Note
abfragt, ergibt keine Geschichte. Deshalb:

*Kurz, unter einer Minute:* Standort, Gesamtnote, hat es funktioniert,
Preis je kWh, ein Foto.

*Voll, für Tester:* dazu Zufahrt und Beschilderung, Zahl der Ladepunkte und
davon defekte, tatsächliche Spitzenleistung mit Ladestand und Außentemperatur,
ob die Leistung geteilt wurde, Zeit bis die Ladung lief, welche Bezahlart
funktionierte, Kabellänge und Anordnung, Dach, Beleuchtung, WC, Essen,
Sicherheitsgefühl bei Nacht, Barrierefreiheit.

Die Kurzform ist die Voreinstellung, die Vollform hängt hinter einem Aufklapper
und an dem Haken, den ein Tester in der App setzt.

**Ohne Anmeldung, mit Sichtung.** Ein Konto vor der ersten Bewertung kostet mehr
Teilnehmer, als Mehrfachabgaben schaden. Dafür geht keine Einsendung
ungeprüft online. Die Sichtung ist ohnehin nötig, sobald aus den Daten ein
Artikel wird, und sie fängt beides ab, Unfug und ehrliche Fehler. Technisch
heißt das: Einsendungen landen in einem Eingang, veröffentlicht wird, was
freigegeben ist, und nur das Freigegebene sieht die App.

**In der App.** Wer sich als Bewerter beteiligt, setzt einen Haken. Danach
tragen die Ladestationen entlang der Route einen zusätzlichen Marker: schon
bewertet, oder noch offen. Ein offener Standort in erreichbarer Nähe ist dann
kein Umweg mehr, sondern ein Grund. Technisch ist das ein kleiner Abruf des
Erfassungsstands, POI-Kennung mit Anzahl und Durchschnitt, und der vorhandene
Zuordnungsmechanismus.

## Die Fahransicht

So soll es laufen: Ziel in ein Suchfeld eingeben, Treffer wählen, Navigation
startet. Danach zeigt der Bildrand kleine Kärtchen mit den nächsten Ladepunkten,
die dem gewählten Filter entsprechen:

```
50 km   EnBW          
90 km   Fastned      +4 min
140 km  IONITY        
```

Die Entfernung ist die entlang der Route ab der aktuellen Position, nicht die
Luftlinie und nicht der seitliche Abstand. Die kleine Zahl daneben ist der
Umweg in Minuten, und sie steht nur dort, wo die Station wirklich abseits liegt.
Wer fährt, will nicht rechnen.

Der lange Druck auf die Karte bleibt als zweiter Weg für Orte ohne Namen. Als
einziger Weg war er nie brauchbar: Die Karte zoomt auf den eigenen Standort, ein
Ziel dreihundert Kilometer weiter liegt außerhalb des Bildes.

## Wie die Ladestopps in die Route kommen

Der Prototyp sucht die Ladestationen für die ganze Strecke auf einmal: 49
Anfragen und 27 Sekunden für 332 Kilometer. Das ist für eine Messung richtig
gewesen und für ein Navi falsch.

Der naheliegende Schluss wäre, kürzere Abschnitte zu suchen, etwa nur bis zur
Reichweite des Fahrzeugs. Der bessere ist, die Stopps gar nicht zu suchen: Die
**Long Distance EV Routing API** plant sie in einem einzigen Aufruf in die
Route hinein, samt Ladezeit und Ladestand je Etappe, auf Grundlage von Verbrauch
und Ladekurve. Eine Anfrage statt neunundvierzig.

Die vorhandene Suche bleibt, aber als zweite Schicht mit anderer Aufgabe: Was
gibt es sonst noch in der Nähe, wenn der geplante Stopp belegt ist oder nicht
gefällt. Diese Schicht darf sich auf den nächsten Abschnitt beschränken, denn
weiter vorauszuplanen ist ohnehin Spekulation; bis dahin hat der Verkehr die
Route geändert.

Voraussetzung für beides ist ein **Fahrzeugprofil**: Akkukapazität, Verbrauch,
aktueller Ladestand. Ohne das plant die EV-Route falsch, und ohne das lässt sich
auch keine Reichweite bestimmen. Für v1 genügt ein von Hand gepflegtes Profil.

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
| Backend | in WordPress, siehe unten | offen |
| Web-Erfassung | plugged.de, WordPress-Erweiterung | offen |
| Geteilte Logik prüfen | Node-Werkzeuge unter `tools/`, 99 Tests | steht |
| Build | GitHub Actions, macOS-Läufer | steht |

Zum Backend: Web und App zusammen brauchen einen gemeinsamen Datenspeicher, und
weil die Erfassung zeitnah beginnen soll, steht die Entscheidung jetzt an.
Da die Seite auf WordPress läuft, ist WordPress auch der Datenspeicher. Eine
eigene Erweiterung mit eigenen Tabellen, nicht mit Beiträgen: Standorte,
Einsendungen, Freigabestand.

Der Grund gegen einen zweiten Dienst daneben ist nicht Technikliebe, sondern
Betrieb. Die Redaktion ist auf plugged.de ohnehin angemeldet, die Sichtung
gehört damit dorthin, wo ohnehin gearbeitet wird. Sicherung, Zugriffsrechte und
Impressum gelten für die Seite und decken die Daten mit ab. Und die App braucht
nur einen offenen Lesepunkt, den die WordPress-REST-Schnittstelle hergibt.

Was das kostet: PHP statt Swift oder JavaScript, und die Karte will vorbereitet
ausgeliefert werden. Bei 4.668 Orten ist das eine zwischengespeicherte Datei von
gut einem Megabyte, die sich clientseitig zu Gruppen zusammenfassen lässt. Bei
14.804 wäre es das Dreifache und der Punkt, an dem es Kartenkacheln oder eine
Abfrage nach Bildausschnitt braucht. Auch das spricht für den engeren
Zuschnitt zu Beginn.

Die im App-Bundle mitgelieferte JSON-Datei bleibt bis dahin und wird dann
ersetzt. `EditorialStore.loadBundled()` ist dafür die einzige auszutauschende
Stelle, das Matching bleibt unberührt.

## Offene Fragen und Risiken

- [ ] Trägt die selbst gebaute Ansage im Alltag? Das entscheidet eine Fahrt,
      keine Überlegung. Größter technischer Brocken von v1.
- [ ] Was kostet das Navigation SDK, und was geht über die Presseschiene?
- [ ] Deckt das Freemium-Kontingent eine Fahrt mit Neuberechnungen? Non-Tile
      liegt bei 2.500 Anfragen am Tag, eine Fahrt braucht davon wenige Dutzend.
      Zu prüfen, ob Long Distance EV Routing aus demselben Topf zählt.
- [ ] Welches Fahrzeug ist das Standardprofil? Akkukapazität, Verbrauch und
      Ladekurve müssen von irgendwo kommen. Für v1 reicht ein Profil von Hand,
      aber es braucht eines.
- [ ] Namensnennung: Das Register steht unter CC BY 4.0. Wo die Daten auf
      plugged.de sichtbar werden, gehört "Bundesnetzagentur.de" sichtbar dazu.
      Der Erfassungsbogen trägt den Hinweis in seinen Kopfdaten mit.
- [ ] Fotos aus Einsendungen: Speicherort, Rechte, Haftung. Ein Foto von einer
      fremden Person ist rechtlich etwas anderes als eines von einer Ladesäule.
- [ ] Mehrfachabgaben trotz Sichtung: Ein Sichter, der hundert gleichlautende
      Einsendungen durchsehen muss, ist das eigentliche Problem, nicht die
      Datenqualität. Einfache Bremsen vorher einbauen.
- [ ] Wie kommt ein neues Register in den Bestand, ohne dass vorhandene
      Bewertungen ihren Standort verlieren? Zuordnung über Nähe, nicht über
      Kennungen aus der Registerdatei.
- [ ] Belegungsabfrage kostet eine Anfrage je Standort. Bei 125 Standorten
      entlang einer Route ist das zu viel für einen Rutsch.

## Nächste Schritte

Zwei Stränge, die parallel laufen können.

**Navi**

1. Presseanfrage an TomTom entwerfen, Ziel: Konditionen und Versuchskontingent
   für das Navigation SDK.
2. Fahrzeugprofil anlegen: Kapazität, Verbrauch, Ladestand. Voraussetzung für
   alles Weitere.
3. Long Distance EV Routing anbinden und gegen die bisherige Routenplanung
   stellen. Ergebnis: Ladestopps stecken in der Route statt daneben, und die
   Suche schrumpft von neunundvierzig Anfragen auf eine.
4. Fahransicht bauen: Kärtchen am Bildrand mit Entfernung entlang der Route und
   Umweg in Minuten.
5. Ansage bauen: Manöverliste, Entfernung zum nächsten Manöver, Sprachausgabe,
   Abweichungserkennung.
6. Fahren. Eine echte Strecke, danach entscheiden, was die Liste können muss.

**State of Charge**

1. ~~Domain und Technik festlegen.~~ plugged.de, WordPress, ohne Anmeldung,
   mit Sichtung.
2. ~~Grundgesamtheit erzeugen.~~ Gezählt am 10.09.2026, siehe oben.
   Erfassungsbogen ab 300 kW:
   `node tools/register-schnelllader.mjs --leistung=300 --export=daten/standorte-300kw.json`
3. Datenspeicher aufsetzen: Standorte, Bewertungen, Fotos, Sichtungsstand.
4. Erfassungsseite bauen: Karte mit Stand der Erfassung, Kurzformular,
   Vollformular für Tester.
5. In der App: Haken für Beteiligung, zusätzlicher Marker für den
   Erfassungsstand.
