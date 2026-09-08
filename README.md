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
node tomtom-probe.mjs --fast --detour=20
npm test                            # 43 Tests
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

**Getestet und grün.** Die 43 Tests unter `tools/test/` decken Geometrie,
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
    lib/                       dieselbe Logik in JavaScript
    test/                      43 Tests gegen Fixtures
    tomtom-probe.mjs           Datenkette gegen die echte API
```
