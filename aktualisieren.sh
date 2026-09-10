#!/bin/sh
# aktualisieren.sh
# Holt den neuen Stand und richtet das Xcode-Projekt nach, wenn noetig.
#
#   ./aktualisieren.sh              einmal holen
#   lade node tools/matrix-probe.mjs   holen, dann den Befehl hier ausfuehren
#   ./aktualisieren.sh --einrichten Abkuerzung "lade" und Automatik einrichten
#   ./aktualisieren.sh --still      ohne Ausgabe, fuer die Automatik
#
# Wozu: git pull, xcodegen generate, Projekt oeffnen. Drei Schritte, von denen
# der zweite nur manchmal noetig ist, naemlich wenn sich eine Datei unter
# LadeRoute/ oder project.yml geaendert hat. Wer das von Hand macht, vergisst
# ihn irgendwann und sucht dann eine neue Datei, die Xcode nicht kennt.

set -e

VERZEICHNIS=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$VERZEICHNIS"

STILL=0
EINRICHTEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --still) STILL=1; shift ;;
    --einrichten) EINRICHTEN=1; shift ;;
    --*) echo "Unbekanntes Argument: $1" >&2; exit 1 ;;
    # Alles ohne Strich davor ist ein Befehl, der im Projektverzeichnis
    # laufen soll. Grund: Die Werkzeuge liegen unter tools/ und wollen von der
    # Wurzel aus gestartet werden. Wer sie von anderswo aufruft, bekommt
    # "Cannot find module", und das ist hier schon passiert.
    *) break ;;
  esac
done

sage() { [ "$STILL" -eq 1 ] || echo "$@"; }

# Am Ende jedes Weges: den mitgegebenen Befehl im Projektverzeichnis ausfuehren.
fertig() {
  if [ $# -gt 0 ]; then
    exec "$@"
  fi
  exit 0
}

# --- Einrichten --------------------------------------------------------

if [ "$EINRICHTEN" -eq 1 ]; then
  PROFIL="$HOME/.zshrc"
  ZEILE="alias lade='$VERZEICHNIS/aktualisieren.sh'"

  if [ -f "$PROFIL" ] && grep -qF "$ZEILE" "$PROFIL"; then
    echo "1. Abkuerzung \"lade\" steht schon in $PROFIL."
  else
    printf '\n# Electric Drive Companion aktualisieren\n%s\n' "$ZEILE" >> "$PROFIL"
    echo "1. Abkuerzung \"lade\" in $PROFIL eingetragen."
    echo "   Wirksam im naechsten Terminalfenster, oder sofort mit: source $PROFIL"
  fi

  PLIST="$HOME/Library/LaunchAgents/de.plugged.laderoute.aktualisieren.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLISTENDE
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>de.plugged.laderoute.aktualisieren</string>
	<key>ProgramArguments</key>
	<array>
		<string>$VERZEICHNIS/aktualisieren.sh</string>
		<string>--still</string>
	</array>
	<key>StartInterval</key>
	<integer>600</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$HOME/Library/Logs/laderoute-aktualisieren.log</string>
	<key>StandardErrorPath</key>
	<string>$HOME/Library/Logs/laderoute-aktualisieren.log</string>
</dict>
</plist>
PLISTENDE

  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "2. Automatik eingerichtet: holt alle zehn Minuten und meldet sich, wenn"
  echo "   etwas Neues da war. Protokoll: ~/Library/Logs/laderoute-aktualisieren.log"
  echo "   Abschalten mit: launchctl unload $PLIST"
  echo
  echo "Ab jetzt reicht das Wort: lade"
  exit 0
fi

# --- Holen -------------------------------------------------------------

VORHER=$(git rev-parse HEAD)

# Nur vorspulen. Gibt es hier eigene Aenderungen, soll nichts zusammengefuehrt
# werden; dann bricht es ab und sagt warum, statt einen Merge anzulegen, den
# niemand bestellt hat.
if ! AUSGABE=$(git pull --ff-only --quiet origin main 2>&1); then
  sage "Konnte nicht holen:"
  sage "$AUSGABE"
  if [ "$STILL" -eq 1 ]; then
    osascript -e 'display notification "Eigene Aenderungen im Weg" with title "LadeRoute"' 2>/dev/null || true
  fi
  exit 1
fi

NACHHER=$(git rev-parse HEAD)

NICHTS_GEHOLT=0
if [ "$VORHER" = "$NACHHER" ]; then
  NICHTS_GEHOLT=1
  sage "Schon aktuell."
fi

ANZAHL=$(git rev-list --count "$VORHER..$NACHHER")

if [ "$NICHTS_GEHOLT" -eq 0 ]; then
  sage "$ANZAHL neue Commit(s):"
  [ "$STILL" -eq 1 ] || git log --oneline "$VORHER..$NACHHER" | sed 's/^/  /'
fi

# --- Projekt nachziehen ------------------------------------------------

# Ob das Projekt neu erzeugt werden muss, entscheidet der Zustand auf der
# Platte und nicht dieser eine Abgleich.
#
# Die erste Fassung sah nur nach, was gerade geholt wurde. Das ging schief,
# sobald eine Erzeugung einmal ausfiel, etwa weil gerade gebaut wurde: Beim
# naechsten Mal standen im Abgleich andere Dateien, die Information war weg, und
# das Projekt blieb veraltet zurueck. Xcode kannte die neuen Dateien nicht, und
# der Fehler sah aus wie ein Compilerproblem.
#
# Der Vergleich der Zeitstempel heilt das von selbst: Was aelter ist als die
# letzte Erzeugung, steckt drin; was neuer ist, fehlt.
BRAUCHT_XCODEGEN=0

if [ ! -d "LadeRoute.xcodeproj" ]; then
  BRAUCHT_XCODEGEN=1
elif [ -n "$(find LadeRoute project.yml -newer LadeRoute.xcodeproj/project.pbxproj 2>/dev/null | head -1)" ]; then
  BRAUCHT_XCODEGEN=1
fi

if [ "$BRAUCHT_XCODEGEN" -eq 1 ]; then
  # Nicht waehrend gebaut wird. xcodegen schreibt die .xcodeproj neu, und das
  # mitten in einem laufenden Build ergibt eine Fehlermeldung, deren Ursache
  # niemand vermutet.
  #
  # Geprueft wird der Compiler, nicht Xcode. Die erste Fassung hat bei jedem
  # offenen Xcode abgelehnt, und damit lehnte sie fast immer ab: Wer die App
  # entwickelt, hat Xcode offen. Ein offenes Xcode ohne laufenden Build vertraegt
  # ein neu erzeugtes Projekt problemlos, es laedt es nach.
  if pgrep -x swift-frontend > /dev/null 2>&1 ||
     pgrep -x xcodebuild > /dev/null 2>&1 ||
     pgrep -x swift-driver > /dev/null 2>&1; then
    sage "Xcode baut gerade, das Projekt wurde nicht neu erzeugt."
    sage "Nach dem Build noch einmal: lade"
    if [ "$STILL" -eq 1 ]; then
      osascript -e "display notification \"$ANZAHL neue Commits. Nach dem Build noch einmal lade tippen.\" with title \"LadeRoute\"" 2>/dev/null || true
    fi
    fertig "$@"
  fi

  if command -v xcodegen > /dev/null 2>&1; then
    xcodegen generate > /dev/null
    sage "Projekt neu erzeugt, es waren Dateien der App dabei."
    if pgrep -x Xcode > /dev/null 2>&1; then
      sage "Xcode laedt es von selbst nach."
    fi
  else
    sage "xcodegen fehlt: brew install xcodegen"
  fi
fi

if [ "$STILL" -eq 1 ] && [ "$NICHTS_GEHOLT" -eq 0 ]; then
  osascript -e "display notification \"$ANZAHL neue Commits geholt.\" with title \"LadeRoute\"" 2>/dev/null || true
fi

fertig "$@"
