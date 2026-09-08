#!/bin/sh
# dump-sdk-api.sh
# Zeigt die tatsächliche API des TomTom Maps SDK.
#
#   ./tools/dump-sdk-api.sh
#   ./tools/dump-sdk-api.sh Marker
#
# Wozu: Die SDK-Dokumentation ist online, der Code hier entsteht ohne Zugriff
# darauf. Statt Methodennamen zu raten und den Compiler entscheiden zu lassen,
# wird nachgesehen. Xcode legt beim Auflösen der Pakete .swiftinterface-Dateien
# ab, und die enthalten jede öffentliche Deklaration im Klartext.

set -e

SUCHE="${1:-Marker}"
BASIS="$HOME/Library/Developer/Xcode/DerivedData"

if [ ! -d "$BASIS" ]; then
  echo "DerivedData nicht gefunden. Wurde das Projekt schon einmal in Xcode geöffnet?" >&2
  exit 1
fi

DATEIEN=$(find "$BASIS" -name "TomTomSDKMapDisplay.swiftinterface" 2>/dev/null | head -3)

if [ -z "$DATEIEN" ]; then
  echo "Keine .swiftinterface für TomTomSDKMapDisplay gefunden." >&2
  echo "In Xcode einmal bauen (Cmd+B), damit die Pakete ausgepackt werden." >&2
  exit 1
fi

DATEI=$(echo "$DATEIEN" | head -1)
echo "Quelle: $DATEI"
echo

echo "=== enum MapInteraction ==="
awk '/enum MapInteraction/,/^}/' "$DATEI" | head -40

echo
echo "=== Deklarationen mit \"$SUCHE\" ==="
grep -nE "(public |open )?(func|var|struct|enum|class|case|init)[^{]*$SUCHE" "$DATEI" |
  sed 's/^/  /' |
  head -60

echo
echo "=== struct MarkerOptions ==="
awk '/struct MarkerOptions/,/^}/' "$DATEI" | head -40
