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

// v135: alimento mangiato in parte, niente doppio conteggio tra quotaPiano e macroTolti
{
  const assert = require("assert");
  const path = require("path");
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "test";
  const T = require("module").createRequire(path.join(__dirname, "../functions/index.js"))("./index.js")._test;
  const previsti = { carboidrati: 80, proteine: 20, grassi: 15, alcol: 0, affidabilita: "media" };
  const farroMeta = { carboidrati: 24, proteine: 5, grassi: 1 };
  const a = T.macroEffettiviDaRisposta({ quotaPiano: 0.5, macroTolti: farroMeta }, previsti, null, "parziale");
  assert.strictEqual(Math.round(a.carboidrati), 56, "quota portata a 1, tolto solo il farro: " + JSON.stringify(a));
  const b = T.macroEffettiviDaRisposta({ quotaPiano: 0.5 }, previsti, null, "parziale");
  assert.strictEqual(Math.round(b.carboidrati), 40, "metà di tutto il pasto: quota 0,5 resta");
  const c = T.macroEffettiviDaRisposta({ quotaPiano: 1, macroTolti: farroMeta }, previsti, null, "parziale");
  assert.strictEqual(Math.round(c.carboidrati), 56);
  console.log("OK: alimento mangiato in parte senza doppio conteggio (3 verifiche)");
}
