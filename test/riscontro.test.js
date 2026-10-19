// Verifiche della pulizia del riscontro AI (pasti di domani, frasi ipotetiche): node test/riscontro.test.js
const assert = require("assert");
const fs = require("fs");
const s = fs.readFileSync(__dirname + "/../functions/index.js", "utf8");
const pick = (a, b) => s.slice(s.indexOf(a), s.indexOf(b));
const macroLogic = require("../functions/macro.js"); // usato da normalizzaRiscontro
const normalizza = eval(pick("const RE_SUGGERIMENTO_VIETATO", "const ISTRUZIONI_RISCONTRO") + ";(" + pick("function normalizzaRiscontro", "exports.valutaVariazione").trim() + ")");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const r = normalizza({
  impatto: "lieve", stima: "Circa 150 kcal in più.",
  spiegazione: "La colazione è più ricca. Domani a colazione aggiungi uno yogurt. Oggi dai spazio alle proteine.",
  suggerimenti: [
    { pasto: "spuntinoPomeriggio", testo: "Abbina la frutta alla ricotta, se presente nel tuo piano." },
    { pasto: "cena", testo: "Domani a cena scegli il pesce." },
    { pasto: "pranzo", testo: "Scegli il radicchio al posto del pane (se previsto dal piano)." },
  ],
  messaggio: "Ripartiamo dal piano: domani a colazione torna allo yogurt.",
}, ["pranzo", "spuntinoPomeriggio", "cena"], true);
ok(!/domani/i.test(r.spiegazione) && /proteine/.test(r.spiegazione), "spiegazione senza domani: " + r.spiegazione);
ok(r.suggerimenti.length === 2 && r.suggerimenti.every((x) => !/domani|se present|se previst/i.test(x.testo)), "suggerimenti ripuliti " + JSON.stringify(r.suggerimenti));
ok(r.suggerimenti[0].testo === "Abbina la frutta alla ricotta.", "frase ipotetica tolta: " + r.suggerimenti[0].testo);
ok(!/domani a colazione/i.test(r.messaggio) && r.messaggio.length > 20, "messaggio di riserva: " + r.messaggio);
ok(normalizza({ impatto: "lieve", stima: "x", spiegazione: "y", suggerimenti: [], messaggio: "Da domani si riparte dal piano." }, [], false).messaggio === "Da domani si riparte dal piano.", "domani generico consentito");
console.log("OK: " + n + " verifiche superate");
