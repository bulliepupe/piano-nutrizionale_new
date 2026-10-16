/**
 * Analisi AI con piano appena iniziato e riscontro "irrilevante".
 * Dalla cartella dell'app: node test/analisi.test.js (dopo npm install in functions)
 */
const assert = require("assert");
const path = require("path");
const req = require("module").createRequire(path.join(__dirname, "../functions/index.js"));
process.env.GCLOUD_PROJECT = "test";
const T = req("./index.js")._test;
const base = { valutazione: "giallo", titolo: "x", sintesi: "x", impattoScostamenti: "x", puntiAttenzione: [], puntiForza: [], azione: "Contattalo", contattare: true, messaggio: "Ciao" };
let a = T.correggiPianoAppenaIniziato(base, { giorniValutati30: 1, usoApp: { giorniInattivo: 0 } });
assert.strictEqual(a.contattare, false); assert.strictEqual(a.messaggio, ""); assert.ok(/appena iniziato/.test(a.azione));
a = T.correggiPianoAppenaIniziato(Object.assign({}, base, { valutazione: "rosso" }), { giorniValutati30: 3, usoApp: { giorniInattivo: 1 } });
assert.strictEqual(a.valutazione, "giallo");
a = T.correggiPianoAppenaIniziato(base, { giorniValutati30: 5, usoApp: { giorniInattivo: 5 } });
assert.strictEqual(a.contattare, true, "mai usata da più di 3 giorni: si può contattare");
a = T.correggiPianoAppenaIniziato(base, { giorniValutati30: 20, usoApp: { giorniInattivo: 0 } });
assert.strictEqual(a.contattare, true, "piano avviato da tempo: invariato");
console.log("ok analisi piano appena iniziato");
const r = T.normalizzaRiscontro({ impatto: "irrilevante", stima: "Pollo al posto del roastbeef: valori simili", spiegazione: "", suggerimenti: [], messaggio: "Va bene così: domani riprendi con il piano previsto." }, [], true);
assert.ok(!/ripren/i.test(r.messaggio), "irrilevante senza 'riprendi': " + r.messaggio);
console.log("ok riscontro irrilevante:", r.messaggio);
