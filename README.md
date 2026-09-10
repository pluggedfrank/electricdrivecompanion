# Electric Drive Companion

**Arbeitstitel der App: LadeRoute.** Der Xcode-Target heißt so; wenn ein
anderer Name feststeht, wird er in `project.yml` und `LadeRoute/` geändert.

Eine eigenständige Navigations-App für die Langstrecke im E-Auto. Der
Unterschied zu jedem anderen Navi ist die Liste der Schnelllader entlang der
Route: Entfernung, Ladeleistung, Anbieter, Belegung.

**Wozu die App da ist, steht in [`docs/PROJEKT.md`](docs/PROJEKT.md).** Bei
Widersprüchen zwischen diesem README und jenem Text gilt jener.

Was hier beschrieben ist, ist der Stand des Prototyps. Er beantwortet bisher
eine Frage: **Trägt die Kombination aus fremden Kartendaten und eigenem
Ladestations-Wissen?** Die Ansage, ohne die es kein Navi ist, fehlt noch.

## Was drin ist

| Baustein | Quelle | Kontingent |
|---|---|---|
| Karte, Standort, Kameraführung | Maps SDK for iOS | Tiles, 50.000 pro Tag frei |
| Route planen und zeichnen | Routing über SDK | Non-Tile |
| Ladestationen entlang der Strecke | Search API, `searchAlongRoute` | Non-Tile |
| Live-Belegung der Ladepunkte | Search API, `chargingAvailability` | Non-Tile |
| Bewertung, Testurteil, Preis, Tags | eigene Daten, lokale JSON | kostenlos |

Das Navigation SDK mit Turn-by-Turn ist **nicht** eingebunden. Es wird separat
lizenziert; im frei zugänglichen Paket `tomtom-sdk-spm-core` 0.73.2 stehen 36
Module, darunter keines für Navigation, Guidance, Sprachausgabe oder
Neuberechnung. Für den Prototypen wird die Ansage deshalb selbst gebaut, aus
den Manöverdaten der Routing-API und der Sprachausgabe von iOS. Der Plan dazu
steht in [`docs/PROJEKT.md`](docs/PROJEKT.md).

## Einrichtung

Voraussetzung ist ein TomTom-Key vom Developer-Portal. Der Freemium-Key reicht,
er deckt Maps, Search und Routing ab.

```bash
brew install xcodegen
./setup.sh
```

`setup.sh` fragt den Schlüssel ab (unsichtbar), legt `Secrets.xcconfig` an,
erzeugt das Xcode-Projekt und öffnet es. Ist `TOMTOM_API_KEY` gesetzt, wird der
Wert übernommen. Eine bereits vorhandene Schlüsseldatei bleibt unangetastet.

Von Hand ginge es auch, aber die drei Schritte haben je eine Stolperstelle: Ein
angehängter `#`-Kommentar wird von interaktivem zsh nicht als Kommentar
gelesen, sondern als Argument weitergereicht, und `cp` legt dann keine Datei
an. XcodeGen bricht anschließend ab, weil die Schlüsseldatei fehlt.

`Secrets.xcconfig` steht in `.gitignore`. Der Key landet über die Info.plist in
der App und wird beim Start an `MapsDisplayService` übergeben.

Wer XcodeGen nicht installieren möchte, legt in Xcode ein leeres iOS-App-Projekt
an, zieht den Ordner `LadeRoute` hinein und fügt das Paket
`https://github.com/tomtom-international/tomtom-sdk-spm-core` in Version 0.73.2
hinzu. Die benötigten Produkte stehen in `project.yml`.

## Bauen ohne Handarbeit

`.github/workflows/build.yml` baut die App bei jedem Push, der den App-Code
berührt, und fährt die Tests der geteilten Logik. Compilerfehler tauchen damit
im Protokoll auf und müssen nicht von einem Rechner abgetippt werden.

Der Build braucht keinen echten Schlüssel, er muss nur übersetzen; die
Schlüsseldatei entsteht mit einem Platzhalter. Ein echter Key hat im Build
nichts zu suchen, die App fragt ihn zur Laufzeit ab.

Zu den Kosten: macOS-Läufer zählen bei privaten Repositories zehnfach, das
kostenlose Kontingent von 2.000 Minuten entspricht also rund 200 macOS-Minuten
im Monat. Ein Build dauert je nach Paket-Cache fünf bis zehn Minuten. Deshalb
läuft er nur, wenn sich unter `LadeRoute/` oder in `project.yml` etwas ändert;
Änderungen an den Werkzeugen lösen ihn nicht aus. Die Tests laufen getrennt auf
einem Linux-Läufer, der einfach zählt.

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
cd ~/electricdrivecompanion/tools
node tomtom-probe.mjs --dry-run     # zeigt nur die Anfragen, ohne Netz
node tomtom-probe.mjs               # fragt den Schluessel ab, Meerbusch nach Norddeich
node tomtom-probe.mjs --diagnose    # welcher Suchbegriff trifft die Kategorie?
node tomtom-probe.mjs --no-wide     # nur Along-Route, wie die TomTom-Pro-App
node tomtom-probe.mjs --power=150 --detour=20
npm test                            # 103 Tests
```

Der Probe-Lauf nutzt beide Suchverfahren, genau wie die App. `--no-wide`
schaltet die Umkreissuchen ab und zeigt damit, was eine reine
Along-Route-Suche liefert.

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

### Warum jede Station auf die Route projiziert wird

Die beiden Suchen liefern Unterschiedliches: Die Along-Route-Suche bringt den
tatsächlichen Umweg in Minuten mit, die Umkreissuche gar keine Ortsangabe. Ohne
Gegenmaßnahme stünden deren Treffer beziehungslos in der Liste, und eine
gemeinsame Sortierung wäre unmöglich. Der erste Exportlauf zeigte das
drastisch: 59 Treffer sauber nach Umweg sortiert, danach 211 in
Abfragereihenfolge, ab Eintrag 60 sprang die Liste von Norddeich zurück nach
Meerbusch.

`GeoUtils.orderAlongRoute` projiziert deshalb jede Station auf die
Routengeometrie und ermittelt zwei Werte: den Kilometerstand entlang der
Strecke und den seitlichen Abstand. Beides kostet keine einzige zusätzliche
Anfrage. Sortiert wird danach in Fahrtrichtung, und der seitliche Abstand
dient zugleich als Grenze: Was weiter als zwei Kilometer neben der Route
liegt, fällt raus. Sonst schleppt die Umkreissuche Innenstadt-Ladepunkte mit,
für die auf einer Durchgangsfahrt niemand abfährt.

### Eine zweite Live-Quelle

Für den laufenden Abgleich und für alles außerhalb Deutschlands bietet sich
**Open Charge Map** an: kostenloser API-Key, `PowerKW` je Anschluss, offene
Lizenz, gemeinnützig. Noch nicht angebunden, weil erst die Messung zeigen
sollte, ob es überhaupt nötig ist.

Die Live-Belegung hat keine der beiden Alternativen. Die bleibt bei TomTom.

## Eigene Daten austauschen

Der Bestand liegt in `LadeRoute/Resources/editorial-stations.json` und beginnt
leer. Gefüllt wird er in zwei Schritten, beide auf dem Rechner mit dem
API-Schlüssel:

```
node tools/tomtom-probe.mjs --from=51.2560,6.6890 --to=53.6148,7.1621 \
     --export-editorial=tools/meine-stationen.json
node tools/redaktion-einbauen.mjs
```

Der erste Lauf schreibt die echten Treffer als Arbeitsliste heraus, mit den
TomTom-POI-IDs, aber ohne Urteil. Der zweite übernimmt sie in die App. Wer die
Datei danach um `verdict` und `rating` ergänzt, hat einen Test hinterlegt; ein
erneuter Import lässt ihn stehen.

Die Arbeitsteilung dabei: Kennung, Name, Anschrift und Koordinaten kommen aus
dem Import, denn das ist TomToms Aufgabe. Das Urteil bleibt beim Bestand, denn
das ist unseres. `--trocken` zeigt nur, was passieren würde, `--commit` schreibt
und schiebt gleich hoch.

Der Probelauf plant seine Route **ohne Verkehrslage**. Das kam aus einem
Fehler: Die ersten beiden Importe liefen mit `traffic=true`, und weil zwischen
ihnen zwei Tage lagen, wählte TomTom zweimal eine andere Strecke, 321 km über
Düsseldorf und 332 km über Krefeld und Moers. Von 129 Stationen des ersten Laufs
tauchten 39 im zweiten nicht mehr auf, alle im ersten Streckendrittel, weil
dieses Drittel gar nicht mehr befahren wurde. Der Bestand wuchs dadurch auf 164,
ohne dass eine einzige Station dazugekommen wäre, die es vorher nicht gab.

Eine Arbeitsliste muss zweimal dieselbe sein. Die Verkehrslage gehört dorthin,
wo tatsächlich gefahren wird, in die App; `--verkehr` schaltet sie für einen
Vergleichslauf wieder zu. Und der Import zählt seither mit, wie viele Einträge
er nicht kennt, damit ein wachsender Bestand auffällt statt sich anzusammeln.

Die Anschrift steht im Bestand nicht für die App, die kennt zur Laufzeit die von
TomTom, sondern für den Menschen, der die Liste ausfüllt. Bei Ladestationen ist
der POI-Name meist der Betreibername; im ersten echten Import hießen vierzehn
Einträge schlicht `EnBW`. Ohne Anschrift ist so eine Liste nicht zu bearbeiten.

Ein Eintrag ohne Urteil ist kein Test, sondern ein Vermerk. Die App
unterscheidet das: Ein Urteil erscheint als eigener Test mit rotem Marker, ein
bloßer Vermerk als Zeile *steht auf unserer Liste*. Ohne diese Trennung trüge
nach dem ersten Import jede zweite Station den Marker der Redaktion, ohne dass
ein Wort darin steht.

Die Beispieldatensätze von früher liegen jetzt unter
`tools/test/fixtures/editorial-entries.json`. Sie waren erfunden und haben in
einer App nichts verloren, für die Zuordnungstests sind sie dagegen genau
richtig, weil sie sich nicht mit jedem Testbericht ändern.

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

**Getestet und grün.** Die 103 Tests unter `tools/test/` decken Geometrie,
Routenaufteilung, Anfragebau, Antwortauswertung und das Matching ab. Sie laufen
gegen Fixtures, brauchen kein Netz und keinen Key.

**Gegen den Originalcode abgeglichen.** Karte, Kamera, Routenzeichnung,
Delegates und Routenplanung folgen dem offiziellen Beispielprojekt
`tomtom-international/tomtom-navigation-ios-examples`, das auf Version 0.70.0
kompiliert. Die Aufrufe wurden aus dem echten Quelltext übernommen, nicht aus
der Erinnerung.

**Erster Build gelaufen.** Am 08.09.2026 in Xcode gebaut. Drei Fehler, alle in
`MapCoordinator.swift`, alle bei den Markern; die übrigen rund 2.300 Zeilen
gingen durch. Die Fehler sind behoben, und zwar nicht durch Raten: Mit
`tools/dump-sdk-api.sh` lässt sich die tatsächliche API aus den
`.swiftinterface`-Dateien lesen, die Xcode beim Auflösen der Pakete ablegt.

Was dabei herauskam, war in allen drei Fällen eine falsche Analogie meinerseits:

| angenommen | tatsächlich |
|---|---|
| `map.addMarker(options)` | verlangt das Label `options:` |
| `map.removeMarkers()` | `map.removeAnnotations()`, Marker sind Annotationen |
| `MapInteraction.markerClicked` | `.tappedOnAnnotation(annotation:coordinate:)` |

Das Nachsehen hat den Code zusätzlich vereinfacht: Das Protokoll `Annotation`
führt ein `tag`, und `MarkerOptions` nimmt es beim Anlegen entgegen. Die
Stations-ID wandert also ins Tag und kommt beim Tap direkt zurück. Eine eigene
Liste von Nadelkoordinaten und die Suche nach der nächstgelegenen entfallen
ersatzlos.

Zwei Stellen, die ich zuvor als riskant benannt hatte, `route.summary` und
`RouteOptions.color`, kompilierten anstandslos.

**Seitdem baut GitHub Actions.** Jeder Push, der `LadeRoute/` berührt, wird auf
einem macOS-Läufer übersetzt, die Tests laufen getrennt auf Linux. Beide Läufe
sind grün, für arm64 und x86_64. Damit müssen Compilerfehler nicht mehr von Hand
aus Xcode herübergereicht werden.

Die zwei Deprecation-Hinweise sind erledigt. `RoutingError` und
`RoutePlanningOptions` gibt es in zwei Modulen, die alten in
`TomTomSDKRoutePlanner`, die aktuellen in `TomTomSDKRoutingCommon`; da beide
importiert sind, griff der unqualifizierte Name auf die alte Fassung. Die
Modulangabe entscheidet das.

**Offen geblieben sind drei Warnungen zur Actor-Isolation.** `MapCoordinator`
ist `@MainActor`, die Delegate-Protokolle des SDK sind es nicht. Im
Swift-5-Modus sind das Warnungen, im Swift-6-Modus wären es Fehler. Im
CI-Protokoll tauchen sie nicht auf, in Xcode schon.

Die alte Einschätzung, hier zur Nachvollziehbarkeit:

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
    test/                      103 Tests gegen Fixtures
    tomtom-probe.mjs           Datenkette gegen die echte API
    coverage-check.mjs         Abdeckung gegen das amtliche Register
    redaktion-einbauen.mjs     Export der Treffer in den Bestand der App
    register-schnelllader.mjs  Schnellladestandorte in Deutschland zaehlen
```
