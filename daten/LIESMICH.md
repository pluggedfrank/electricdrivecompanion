# daten/

Erfassungsbogen für State of Charge: die Schnellladestandorte, die erhoben
werden sollen.

Erzeugt aus dem Ladesäulenregister der Bundesnetzagentur mit

```
node tools/register-schnelllader.mjs --leistung=300 --export=daten/standorte-300kw.json
```

Die Dateien tragen ihre Herkunft in den Kopfdaten: Registerausgabe,
Erzeugungsdatum, Leistungsschwelle, Standortradius.

**Lizenz der zugrundeliegenden Daten: CC BY 4.0, Namensnennung
„Bundesnetzagentur.de".** Wo die Daten öffentlich sichtbar werden, auf
plugged.de oder in der App, gehört die Nennung sichtbar dazu.

Warum die Dateien hier liegen und nicht nur auf einem Rechner entstehen: Der
Bestand ist die Grundgesamtheit, an der der Fortschritt der Erhebung gemessen
wird. Wer nachvollziehen will, warum ein Ort dazugehört oder fehlt, muss den
Stand von damals sehen können.
