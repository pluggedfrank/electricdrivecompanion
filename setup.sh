#!/bin/sh
# setup.sh
# Richtet das Xcode-Projekt ein: Schlüsseldatei anlegen, Projekt erzeugen.
#
#   ./setup.sh
#
# Warum als Skript und nicht als Anleitung: Die Einrichtung besteht aus drei
# Schritten, von denen jeder einzeln schiefgehen kann. Eine kopierte Zeile mit
# einem Kommentar dahinter reicht schon, denn interaktives zsh behandelt "#"
# nicht als Kommentarzeichen und reicht den Rest als Argumente weiter.

set -e

VERZEICHNIS=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$VERZEICHNIS"

VORLAGE="Secrets.xcconfig.example"
ZIEL="Secrets.xcconfig"

echo "Electric Drive Companion, Einrichtung"
echo "-------------------------------------"

# --- 1. Schlüsseldatei -------------------------------------------------

if [ -f "$ZIEL" ] && ! grep -q "YOUR_API_KEY" "$ZIEL"; then
  echo "1. $ZIEL liegt bereits vor und enthält einen Schlüssel."
else
  if [ ! -f "$VORLAGE" ]; then
    echo "Vorlage $VORLAGE fehlt. Ist das das richtige Verzeichnis?" >&2
    exit 1
  fi

  KEY="${TOMTOM_API_KEY:-}"
  if [ -z "$KEY" ]; then
    printf "1. TomTom-Key (Eingabe bleibt unsichtbar): "
    # Echo abschalten, damit der Schlüssel nicht im Terminal steht. Die
    # Wiederherstellung läuft über trap, sonst bliebe das Terminal bei einem
    # Abbruch stumm.
    ALTE_EINSTELLUNG=$(stty -g)
    trap 'stty "$ALTE_EINSTELLUNG" 2>/dev/null' EXIT INT TERM
    stty -echo
    read -r KEY
    stty "$ALTE_EINSTELLUNG"
    trap - EXIT INT TERM
    echo
  else
    echo "1. Schlüssel aus TOMTOM_API_KEY übernommen."
  fi

  if [ -z "$KEY" ]; then
    echo "   Kein Schlüssel eingegeben. Abbruch." >&2
    echo "   Key anlegen: https://developer.tomtom.com/ -> Dashboard -> API Keys" >&2
    exit 1
  fi

  # Grobe Formprüfung, damit ein versehentlich kopierter Platzhalter nicht
  # erst beim ersten Aufruf als 401 auffällt.
  case "$KEY" in
    IHR_KEY|DEIN_KEY|YOUR_API_KEY|NEUER_KEY)
      echo "   \"$KEY\" ist ein Platzhalter, kein Schlüssel. Abbruch." >&2
      exit 1
      ;;
  esac

  sed "s|YOUR_API_KEY|$KEY|" "$VORLAGE" > "$ZIEL"
  echo "   $ZIEL angelegt. Die Datei steht in .gitignore."
fi

# --- 2. Projekt erzeugen -----------------------------------------------

if ! command -v xcodegen > /dev/null 2>&1; then
  echo "2. xcodegen fehlt. Installieren mit:" >&2
  echo "   brew install xcodegen" >&2
  exit 1
fi

echo "2. Projekt erzeugen"
xcodegen generate

# --- 3. Öffnen ---------------------------------------------------------

if [ -d "LadeRoute.xcodeproj" ]; then
  echo "3. LadeRoute.xcodeproj öffnen"
  open LadeRoute.xcodeproj 2>/dev/null || echo "   Nicht auf macOS, bitte von Hand öffnen."
else
  echo "LadeRoute.xcodeproj wurde nicht erzeugt." >&2
  exit 1
fi

echo
echo "Fertig. In Xcode ein Gerät oder den Simulator wählen und bauen."
