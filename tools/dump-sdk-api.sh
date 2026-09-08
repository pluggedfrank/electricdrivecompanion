#!/bin/sh
# dump-sdk-api.sh
# Zeigt die tatsächliche API des TomTom Maps SDK.
#
#   ./tools/dump-sdk-api.sh
#   ./tools/dump-sdk-api.sh Marker
#
# Wozu: Die SDK-Dokumentation ist online, der Code hier entsteht ohne Zugriff
# darauf. Statt Methodennamen zu raten und den Compiler entscheiden zu lassen,
# wird nachgesehen.
#
# Drei Stufen, weil binäre Pakete unterschiedlich ausgeliefert werden:
#   1. .swiftinterface im xcframework, der Klartext. Die Datei heißt nach der
#      Architektur, nicht nach dem Modul, etwa arm64-apple-ios.swiftinterface.
#   2. Ist keine da, liegt nur ein binäres .swiftmodule vor.
#   3. Dann bleibt strings auf der Framework-Binärdatei. Enum-Fälle und
#      Methodennamen stehen dort im Klartext, wenn auch ohne Signatur.

set -e

SUCHE="${1:-Marker}"
MODUL="TomTomSDKMapDisplay"
BASIS="$HOME/Library/Developer/Xcode/DerivedData"

if [ ! -d "$BASIS" ]; then
  echo "DerivedData nicht gefunden. Wurde das Projekt schon in Xcode geöffnet?" >&2
  exit 1
fi

echo "Suche nach $MODUL unter DerivedData"
echo

# --- Stufe 1: Klartext-Interface ---------------------------------------

INTERFACE=$(find "$BASIS" -path "*$MODUL*" -name "*.swiftinterface" 2>/dev/null | head -1)

if [ -n "$INTERFACE" ]; then
  echo "Gefunden (Klartext): $INTERFACE"
  echo
  echo "=== enum MapInteraction ==="
  awk '/enum MapInteraction/,/^}/' "$INTERFACE" | head -40
  echo
  echo "=== struct MarkerOptions ==="
  awk '/struct MarkerOptions/,/^}/' "$INTERFACE" | head -40
  echo
  echo "=== Deklarationen mit \"$SUCHE\" ==="
  grep -nE "(func|var|let|struct|enum|class|case|init)[^{]*$SUCHE" "$INTERFACE" |
    sed 's/^/  /' | head -60
  exit 0
fi

echo "Kein .swiftinterface vorhanden, das Paket liefert nur Binärmodule."
echo

# --- Stufe 2: Wo liegt das Framework überhaupt? ------------------------

FRAMEWORK=$(find "$BASIS" -path "*$MODUL*" -name "$MODUL" -type f 2>/dev/null | head -1)

if [ -z "$FRAMEWORK" ]; then
  echo "Auch keine Framework-Binärdatei gefunden. Was liegt da:" >&2
  find "$BASIS" -path "*$MODUL*" -maxdepth 12 2>/dev/null | head -20 >&2
  echo >&2
  echo "Falls nichts kommt: in Xcode einmal bauen (Cmd+B)." >&2
  exit 1
fi

echo "Framework-Binärdatei: $FRAMEWORK"
echo

# --- Stufe 3: Namen aus der Binärdatei ---------------------------------

echo "=== Namen mit \"$SUCHE\" (aus der Binärdatei, ohne Signatur) ==="
strings "$FRAMEWORK" 2>/dev/null |
  grep -E "$SUCHE" |
  grep -vE "^_|\.o$|/|\.swift$" |
  sort -u |
  head -60 |
  sed 's/^/  /'

echo
echo "=== Kandidaten für MapInteraction-Fälle ==="
# Enum-Faelle tauchen als Kleinbuchstaben-Wortmarken auf. Die Suche nach
# "marker" plus Verb-Endung trifft die ueblichen Benennungen.
strings "$FRAMEWORK" 2>/dev/null |
  grep -iE "^marker(Clicked|Selected|Tapped|Pressed|Touched)?$|^(clicked|selected|tapped)Marker$" |
  sort -u |
  sed 's/^/  /'

echo
echo "=== Methoden zum Entfernen ==="
strings "$FRAMEWORK" 2>/dev/null |
  grep -iE "^remove[A-Za-z]*(Marker|Markers|All)[A-Za-z]*$|^clearMarkers$" |
  sort -u |
  sed 's/^/  /'
