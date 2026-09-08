# Electric Drive Companion

**Arbeitstitel der App: LadeRoute.** Der Xcode-Target heißt so; wenn ein
anderer Name feststeht, wird er in `project.yml` und `LadeRoute/` geändert.

Eine iOS-App, die eine Route auf einer TomTom-Karte zeigt, Ladestationen entlang
der Strecke sucht und die Treffer mit eigenen Redaktionsdaten anreichert.

Der Prototyp beantwortet genau eine Frage: **Trägt die Kombination aus fremden
Kartendaten und eigenem Ladestations-Wissen?** Alles, was diese Frage nicht
berührt, fehlt bewusst.

## Was drin ist

| Baustein | Quelle | Kontingent |
|---|---|---|
| Karte, Standort, Kameraführung | Maps SDK for iOS | Tiles, 50.000 pro Tag frei |
| Route planen und zeichnen | Routing über SDK | Non-Tile |
| Ladestationen entlang der Strecke | Search API, `searchAlongRoute` | Non-Tile |
| Live-Belegung der Ladepunkte | Search API, `chargingAvailability` | Non-Tile |
| Bewertung, Testurteil, Preis, Tags | eigene Daten, lokale JSON | kostenlos |

Das Navigation SDK mit Turn-by-Turn ist **nicht** eingebunden. Es wird separat
lizenziert und ist für die Kernfrage nicht nötig.

## Einrichtung

Voraussetzung ist ein TomTom-Key vom Developer-Portal. Der Freemium-Key reicht,
er deckt Maps, Search und Routing ab.

```bash
cp Secrets.xcconfig.example Secrets.xcconfig   # Key eintragen
brew install xcodegen
xcodegen generate
open LadeRoute.xcodeproj
```

`Secrets.xcconfig` steht in `.gitignore`. Der Key landet über die Info.plist in
der App und wird beim Start an `MapsDisplayService` übergeben.

Wer XcodeGen nicht installieren möchte, legt in Xcode ein leeres iOS-App-Projekt
an, zieht den Ordner `LadeRoute` hinein und fügt das Paket
`https://github.com/tomtom-international/tomtom-sdk-spm-core` in Version 0.73.2
hinzu. Die benötigten Produkte stehen in `project.yml`.

## Bedienung

Ziel per langem Druck auf die Karte setzen. Die App plant die Route, sucht
Ladestationen und öffnet die Trefferliste. Stationen mit rotem Punkt haben einen
eigenen Testeintrag. Antippen holt die Live-Belegung nach und öffnet die
Detailkarte.

Zwei Filter wirken direkt auf die Suchanfrage: Schnellladen ab 100 kW und der
maximale Umweg.

## Die Datenkette ohne Xcode prüfen

Unter `tools/` liegt dieselbe Logik noch einmal in JavaScript. Damit lässt sich
die ganze Kette gegen die echte API fahren, bevor der Simulator startet.

```bash
cd tools
node tomtom-probe.mjs --dry-run     # zeigt nur die Anfragen, ohne Netz
node tomtom-probe.mjs               # fragt den Schluessel ab, Meerbusch nach Norddeich
node tomtom-probe.mjs --diagnose    # welcher Suchbegriff trifft die Kategorie?
node tomtom-probe.mjs --power=150 --detour=20
npm test                            # 81 Tests
```

Ohne `--key` fragt das Werkzeug den Schlüssel im Terminal ab, unsichtbar. Das
ist der empfohlene Weg: Ein `export` gilt nur für das eine Terminalfenster und
ist im nächsten wieder weg, und ein Schlüssel auf der Kommandozeile landet in
der Shell-History. `--key=` und `TOMTOM_API_KEY` funktionieren weiterhin, etwa
für Skripte.

Platzhalter aus Anleitungen werden abgefangen, bevor eine Anfrage rausgeht. Ein
mitkopiertes `IHR_KEY` ist nicht leer, käme also durch jede
Vorhandensein-Prüfung und erzeugte sonst ein 401, das nach einem defekten
Schlüssel aussieht.

Das Werkzeug plant die Route, sucht die Stationen, ordnet die eigenen Daten zu,
holt die Belegung der ersten fünf Treffer und zählt am Ende auf, wie viele
Anfragen das gekostet hat. Wenn der Key etwas nicht freigibt, sieht man es hier
in Sekunden statt nach einer halben Stunde Xcode.

## Zwei Entscheidungen, die Erklärung brauchen

**Der Kategoriefilter der Search API ist unbrauchbar.** `categorySet=7309`
liefert auf einem 100-km-Abschnitt der A31 null Treffer. Dieselbe Anfrage ohne
den Parameter liefert 20, mit echten Betreibern von 22 bis 400 kW. Das gilt für
jeden getesteten Suchbegriff, auch für den, der ohne Filter funktioniert. Der
Parameter filtert nicht, er löscht das Ergebnis.

Statt seiner wird am Datensatz selbst entschieden: Ein Ladepark bringt seine
Anschlüsse mit, das ist ein harter Beleg und kein Namensraten. Fehlen sie,
entscheidet ersatzweise die Kategorieangabe des POI. Die Freitextsuche bringt
sonst auch Tankstellen und Werkstätten mit, die fallen so raus. Wer andere
Kategorie-IDs durchprobieren will: `--category=7313`.

**Die Suche läuft über REST, nicht über das Search-SDK.** Die Antwortstruktur ist
dokumentiert und stabil, Filter und Paginierung bleiben in eigener Hand, und die
Schicht ist ohne Simulator testbar. Karte und Routing laufen weiterhin über das
SDK, weil die Kartendarstellung sich nicht sinnvoll nachbauen lässt.

**Die Route wird in Abschnitte zerlegt.** Eine Along-Route-Antwort enthält
höchstens 20 Treffer. Auf einer 330-km-Strecke wären das 20 Stationen für die
gesamte Länge. Deshalb zerlegt `splitIntoSegments` die Route in Abschnitte von
50 km und stellt pro Abschnitt eine Anfrage. Die Geometrie wird vorher per
Douglas-Peucker auf höchstens 200 Stützpunkte gedünnt, sonst wandern mehrere
tausend Koordinaten in jeden Request-Body.

## Verbrauch im Freemium-Kontingent

Ein kompletter Durchlauf Meerbusch nach Norddeich, rund 330 km:

| Schritt | Anfragen |
|---|---|
| Route planen | 1 |
| Ladestationen suchen, 7 Abschnitte | 7 |
| Live-Belegung, nur bei Antippen | 1 pro Station |

Also etwa 8 bis 15 Non-Tile-Anfragen pro geplanter Fahrt. Bei 2.500 pro Tag sind
das immer noch über 150 Routen täglich. Für die Evaluierung ist das weit mehr als
genug. Deshalb wird die Belegung auch erst beim Antippen geholt und nicht für
alle Treffer auf einmal: das wäre der teuerste Teil.

## Das Tempolimit, das wie ein kaputter Key aussieht

Neben dem Tageskontingent deckelt TomTom die Anfragen pro Sekunde. Wird zu
schnell gefeuert, kommt **HTTP 401 mit "missing valid authentication
credentials"** zurück, obwohl der Key gültig ist und dieselbe Anfrage eine
Sekunde später anstandslos durchgeht.

Im ersten Diagnoselauf war das deutlich zu sehen: sieben Varianten ohne Pause
hintereinander, die erste kam durch, die restlichen sechs nicht. Vier Anfragen
über 2,3 Sekunden im Lauf davor waren dagegen unauffällig.

Beide Fassungen bremsen deshalb clientseitig mit 300 ms zwischen den Anfragen
und fassen bei 401, 403 oder 429 genau einmal nach. Das trennt zugleich die
Ursachen: klappt der zweite Versuch, war es das Tempolimit. Bleibt es beim
Fehler, stimmt etwas mit dem Key oder der Produktfreigabe nicht, und genau das
wird dann gemeldet statt einer irreführenden Vermutung.

## Ladeleistung: 50 kW ist die Untergrenze

Auf der Langstrecke ist alles unter 50 kW ohne Belang. Wer 300 km vor sich hat,
lädt nicht an einer 22-kW-AC-Säule. Da eine Antwort nur 20 Treffer fasst,
verdrängen langsame Säulen sonst genau die Ladeparks, um die es geht. Der erste
Lauf zeigte das exemplarisch: Der einzige Treffer war eine 22-kW-Säule mitten in
Oberhausen.

Drei Stufen, in App und Werkzeug dieselben:

| Stufe | Grenze | wofür |
|---|---|---|
| alle | kein Filter | Stadtverkehr, Vollständigkeit |
| **ab 50 kW** | 50 kW | **Vorgabe.** Die sinnvolle Untergrenze für lange Fahrten |
| ab 150 kW | 150 kW | Nur Hochleistungslader. Kurze Stopps, weniger Auswahl |

Gefiltert wird doppelt: serverseitig über `minPowerKW`, weil langsame Säulen
sonst Plätze in der 20er-Antwort belegen, und danach noch einmal an den Daten.
Die zweite Prüfung ist keine Paranoia, sondern die Lehre aus `categorySet`: Ein
Filterparameter, der stillschweigend etwas anderes tut als angenommen, fällt
sonst nicht auf. `node tomtom-probe.mjs --diagnose` prüft am Ende eigens nach, ob
der Server `minPowerKW` tatsächlich anwendet.

Stationen **ohne** Leistungsangabe bleiben drin und werden in der Liste als
„kW unbekannt" gekennzeichnet. Fehlende Daten sind kein Beleg für eine langsame
Säule, und einen echten Ladepark wegen einer Lücke im Datensatz zu verwerfen
wäre der schlimmere Fehler.

Im Werkzeug: `--power=0` schaltet den Filter ab, `--power=150` verlangt HPC.

## Wie vollständig ist TomTom eigentlich?

Ein berechtigter Verdacht aus der Praxis: In der TomTom-Pro-App fehlen
Lademöglichkeiten. Bevor man deshalb die Quelle wechselt, lohnt eine Messung.

Zur Einordnung vorweg: TomToms Ladeinfrastruktur-Daten stammen von
Eco-Movement, demselben Zulieferer, der Google, Tesla, Waze, A Better
Routeplanner, Apple und HERE beliefert. Die Datenbasis ist erstklassig. Was in
Apps fehlt, fehlt deshalb eher an der Darstellung als an der Datenbank, und
genau so eine Mechanik haben wir hier selbst gefunden: 20 Treffer pro Antwort.

`coverage-check.mjs` misst das gegen das **Ladesäulenregister der
Bundesnetzagentur**. Der Betrieb einer öffentlich zugänglichen Ladeeinrichtung
ist meldepflichtig, das Register ist damit der einzige Datensatz, gegen den
sich „vollständig" seriös messen lässt. Lizenz CC BY 4.0, Namensnennung
„Bundesnetzagentur.de".

Die Liste einmal als **CSV** laden, nicht als Excel:
[Ladesäulenkarte der Bundesnetzagentur](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/Ladesaeulenkarte/start.html)

```bash
node coverage-check.mjs --parse-only    # nur einlesen, ohne Netz und ohne Key
node coverage-check.mjs                 # volle Messung
node coverage-check.mjs --corridor=3 --power=150
```

Ein Dateiname muss nirgends eingetippt werden. Ohne `--register` sucht das
Werkzeug im Download-Ordner und nimmt die größte passende CSV. `--register`
akzeptiert wahlweise eine Datei oder ein Verzeichnis.

**Gemessen wird an Standorten, nicht an Ladeeinrichtungen.** Das Register führt
jede Säule als eigene Zeile, ein Ladepark mit acht Säulen sind acht Zeilen.
TomTom führt denselben Ladepark als einen POI. Wer beides direkt gegeneinander
zählt, vergleicht Geräte mit Standorten. Das Werkzeug bündelt die Einträge
deshalb erst über Nachbarschaft zu Standorten, mit 75 m Radius und transitiver
Verkettung, damit eine Säulenreihe entlang eines Parkplatzes nicht in mehrere
Standorte zerfällt.

Das Werkzeug grenzt das Register auf einen Korridor um die Route ein, befragt
TomTom **zweimal** und stellt beide Ergebnisse gegenüber:

| Lauf | Parameter | wozu |
|---|---|---|
| Along-Route, Vorgabe | 50-km-Abschnitte, 10 min Umweg | was die App tatsächlich zeigt |
| Along-Route, großzügig | 20-km-Abschnitte, 30 min Umweg | ob die Umwegschwelle der Engpass ist |
| **+ Umkreissuchen** | 5-km-Umkreise alle 8 km | was zusätzlich erreichbar ist |

Die Differenz trennt Datenlücke von Suchmechanik. Was auch großzügig nicht
auftaucht, ist eine echte Lücke; alles davor ist eine Frage der Parameter.

Zusätzlich schlüsselt es die Trefferquote nach Entfernung zur Route auf. Bricht
sie mit der Entfernung ein, ist es eine Frage des Suchradius und keine
Datenlücke. Das ist die aussagekräftigste Zahl des ganzen Laufs.

Zwei Dinge, die das Werkzeug bewusst laut macht: Es gibt bei jedem Lauf aus,
welche Spalte es wie zugeordnet hat, denn die Spaltennamen des Registers
ändern sich zwischen den Ausgaben und eine stille Fehlzuordnung wäre schlimmer
als ein Abbruch. Und es sagt dazu, dass das Register auch Firmenparkplätze und
Hotelstellplätze führt, die für eine Durchgangsfahrt ohne Belang sind. Ein
Rückstand gegenüber dem Register ist also nicht automatisch ein Mangel.

### Das Ergebnis der ersten Messung

Meerbusch nach Norddeich, 321 km, Zwei-Kilometer-Korridor, alles ab 50 kW.
118 Standorte im Register, gemessen am 08.09.2026:

| Entfernung zur Route | Trefferquote der Along-Route-Suche |
|---|---|
| bis 250 m | 97 % (34 von 35) |
| 250 bis 500 m | 95 % (20 von 21) |
| 500 bis 1000 m | 29 % (6 von 21) |
| über 1000 m | **0 % (0 von 41)** |

**Die Daten sind nicht das Problem, die Suche ist schmal.** Innerhalb von
500 m deckt TomTom das amtliche Register nahezu vollständig ab. Jenseits von
einem Kilometer liefert `searchAlongRoute` nichts, und daran ändert auch eine
Umwegschwelle von 30 Minuten nichts. TomTom legt offenbar einen festen
geometrischen Korridor um die Route, unabhängig vom erlaubten Umweg.

Mit ergänzenden Umkreissuchen im selben Lauf:

| Verfahren | Standorte gefunden | Anfragen |
|---|---|---|
| Along-Route, Vorgabe | 55 von 108 (51 %) | 7 |
| Along-Route, großzügig | 53 von 108 (49 %) | 17 |
| **+ Umkreissuchen** | **100 von 108 (93 %)** | 49 |

Was dann noch fehlt, sind acht Standorte: ein Sportwagenzentrum, eine
Musikakademie, zwei Verwaltungsgesellschaften, kommunale Anlagen. Sieben davon
unter 150 kW. Genau die Kategorie, die das Register führt und die für eine
Durchgangsfahrt ohne Belang ist.

**Damit ist auch die Quellenfrage beantwortet: Für Deutschland genügt TomTom.**
Eine zweite Datenquelle würde nichts hinzufügen, was auf einer Langstrecke
zählt.

Die App sucht deshalb zweistufig. Zuerst Along-Route, sieben Anfragen, in
Sekunden da, und die Liste steht. Danach laufen die Umkreissuchen nach und
ergänzen sie. Der Nutzer sieht sofort etwas, statt eine halbe Minute auf die
vollständige Liste zu warten.

### Eine zweite Live-Quelle

Für den laufenden Abgleich und für alles außerhalb Deutschlands bietet sich
**Open Charge Map** an: kostenloser API-Key, `PowerKW` je Anschluss, offene
Lizenz, gemeinnützig. Noch nicht angebunden, weil erst die Messung zeigen
sollte, ob es überhaupt nötig ist.

Die Live-Belegung hat keine der beiden Alternativen. Die bleibt bei TomTom.

## Eigene Daten austauschen

Der Bestand liegt in `LadeRoute/Resources/editorial-stations.json`. Die zehn
Einträge sind Beispieldaten entlang der Strecke Meerbusch nach Norddeich, keine
echten Messwerte.

Produktiv träte an die Stelle von `EditorialStore.loadBundled()` ein Backend. Der
Rest der Klasse bliebe unverändert, insbesondere das Matching.

Die Zuordnung läuft zweistufig. Ist im Datensatz eine `tomtomPoiID` hinterlegt,
gilt sie und die Heuristik entfällt. Sonst zählt Entfernung zu 60 Prozent und
Namens- oder Betreiberähnlichkeit zu 40 Prozent, mit einem Radius von 150 Metern
und einer Mindestpunktzahl von 0,45.

Beides zusammen ist nötig. Entfernung allein verwechselt zwei Ladeparks auf
demselben Rastplatz. Name allein trifft eine Kette wie EnBW bundesweit. Der Test
`Nähe allein reicht nicht` prüft genau diesen Fall: eine Autohaus-Wallbox
67 Meter neben einem getesteten Ladepark darf dessen Bewertung nicht erben.

## Stand der Prüfung

Ehrlich getrennt nach dem, was belegt ist, und dem, was nicht:

**Getestet und grün.** Die 81 Tests unter `tools/test/` decken Geometrie,
Routenaufteilung, Anfragebau, Antwortauswertung und das Matching ab. Sie laufen
gegen Fixtures, brauchen kein Netz und keinen Key.

**Gegen den Originalcode abgeglichen.** Karte, Kamera, Routenzeichnung,
Delegates und Routenplanung folgen dem offiziellen Beispielprojekt
`tomtom-international/tomtom-navigation-ios-examples`, das auf Version 0.70.0
kompiliert. Die Aufrufe wurden aus dem echten Quelltext übernommen, nicht aus
der Erinnerung.

**Nicht kompiliert.** Der Swift-Code hat nie einen Compiler gesehen, weil in der
Entwicklungsumgebung weder Xcode noch eine Swift-Toolchain vorhanden ist. Beim
ersten Build sind Fehler zu erwarten. Zwei Stellen sind die wahrscheinlichsten
Kandidaten:

1. `MapCoordinator.redrawMarkers()` benutzt `MarkerOptions(coordinate:pinImage:)`
   und `map.addMarker(_:)`. Diese Aufrufe stammen aus der Dokumentation, nicht
   aus dem Beispielprojekt, das keine Marker setzt.
2. `TripViewModel.routeSummary` greift auf `route.summary.length` und
   `.travelTime` zu. Die Namen können in 0.73 abweichen.
3. `RouteOptions.color` bekommt eine `UIColor`. Das Beispielprojekt setzt dort
   die SDK-Vorgabe `.activeRoute`. Erwartet der Compiler einen anderen Typ, ist
   das der schnellste Ersatz.

Alle drei sind lokal begrenzt und in wenigen Minuten korrigiert. Die getestete
Logik hängt nicht daran.

Zwei Fallen wurden vorsorglich entschärft: Angetippte Kartennadeln werden über
ihre Koordinate zugeordnet, nicht über Objektidentität, weil unklar ist, ob
`Marker` ein Wert- oder ein Referenztyp ist. Und `MapCoordinator` ist
`@MainActor`, damit die Zugriffe auf das ebenfalls dort isolierte
`TripViewModel` keine Isolationsfehler auslösen.

**Nicht gegen die Live-API gefahren.** In der Entwicklungsumgebung ist
`api.tomtom.com` durch den Netzwerk-Proxy gesperrt. Der erste echte Aufruf
passiert bei Ihnen. Genau dafür ist `tomtom-probe.mjs` da.

## Wenn der Prototyp trägt

Die nächsten drei Schritte, in dieser Reihenfolge:

1. **Long Distance EV Routing** statt eigener Auswahl. TomTom setzt die
   Ladestopps dann anhand von Akkugröße und Ladekurve selbst. Eigene Bewertungen
   fließen als Präferenz ein, statt die Auswahl allein zu treffen.
2. **Backend statt JSON.** Die Redaktionsdaten gehören in eine Datenbank mit
   einer Oberfläche, in der Testergebnisse ohne Entwickler landen können.
3. **Navigation SDK anfragen.** Erst wenn Turn-by-Turn wirklich gebraucht wird.
   Zu diesem Zeitpunkt kann man TomTom konkrete Anforderungen und
   Volumenschätzungen nennen, statt allgemein nach Zugang zu fragen.

## Aufbau

```
electricdrivecompanion/
  project.yml                  XcodeGen-Spezifikation
  Secrets.xcconfig.example     Vorlage für den API-Key
  LadeRoute/
    App/                       Einstiegspunkt, Key-Handhabung, Info.plist
    DesignSystem/              Farbwerte aus dem Haus-CI
    TomTom/                    REST-Client, Geometrie, Modelle
    Editorial/                 eigene Daten und das Matching
    Map/                       SwiftUI-Brücke zur Karte, Kartennadeln
    Routing/                   async-Hülle um den Routenplaner
    Features/                  ViewModel und Oberfläche
    Resources/                 editorial-stations.json
  tools/
    lib/                       dieselbe Logik in JavaScript, dazu Registerleser
                               und Korridorfilter
    test/                      81 Tests gegen Fixtures
    tomtom-probe.mjs           Datenkette gegen die echte API
    coverage-check.mjs         Abdeckung gegen das amtliche Register
```
