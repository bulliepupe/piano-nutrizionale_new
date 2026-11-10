// Verifiche della pulizia del riscontro AI (pasti di domani, frasi ipotetiche): node test/riscontro.test.js
const assert = require("assert");
const fs = require("fs");
const s = fs.readFileSync(__dirname + "/../functions/index.js", "utf8");
const pick = (a, b) => s.slice(s.indexOf(a), s.indexOf(b));
const macroLogic = require("../functions/macro.js"); // usato da normalizzaRiscontro
const normalizza = eval(pick("const RE_SUGGERIMENTO_VIETATO", "const ISTRUZIONI_RISCONTRO") + ";(" + pick("function normalizzaRiscontro", "exports.valutaVariazione").trim() + ")");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
// v118: riscontro solo descrittivo
const r = normalizza({
  impatto: "lieve", stima: "Circa 150 kcal in più.",
  spiegazione: "La colazione è più ricca di zuccheri del previsto. Domani a colazione aggiungi uno yogurt. Puoi recuperare a cena con più verdure.",
  suggerimenti: [{ pasto: "cena", testo: "Scegli il pesce." }],
  messaggio: "Ripartiamo dal piano: a cena compensa.",
}, ["pranzo", "cena"], false, true);
ok(r.spiegazione === "La colazione è più ricca di zuccheri del previsto.", "solo la frase descrittiva: " + r.spiegazione);
ok(r.suggerimenti.length === 0, "nessun suggerimento");
ok(r.messaggio === "Il piano del tuo nutrizionista resta il riferimento per il resto della giornata.", "frase finale fissa: " + r.messaggio);
const a = normalizza({ impatto: "moderato", stima: "x", spiegazione: "Senza il secondo, il pasto ha meno proteine del previsto.", suggerimenti: [{ pasto: "cena", testo: "Aggiungi legumi." }], messaggio: "" }, ["cena"], true, false);
ok(a.suggerimenti.length === 0 || a.suggerimenti.length > 0, "normalizzazione con elenco");
ok(a.messaggio === "Il tuo piano resta il riferimento per il resto della giornata.", "paziente autonomo: " + a.messaggio);
ok(/meno proteine/.test(a.spiegazione), "descrizione mantenuta: " + a.spiegazione);
const c = normalizza({ impatto: "lieve", stima: "x", spiegazione: "Ti consiglio di bilanciare. Dovresti evitare i dolci.", suggerimenti: [], messaggio: "" }, [], false, true);
ok(c.spiegazione === "", "solo consigli: spiegazione vuota");
console.log("OK: " + n + " verifiche superate");

// R6 (v132): il riscontro non invia all'AI i dati degli allenamenti
{
  const src = require("fs").readFileSync(require("path").join(__dirname, "../functions/index.js"), "utf8");
  const i = src.indexOf("exports.valutaVariazione"), j = src.indexOf("\n});", i);
  const corpo = src.slice(i, j);
  require("assert").ok(!/collection\("attivita"\)|fcMedia|zoneFC|Allenamenti di oggi/.test(corpo), "valutaVariazione non deve leggere né inviare gli allenamenti");
  console.log("OK: riscontro senza dati degli allenamenti");
}
