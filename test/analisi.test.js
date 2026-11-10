/**
 * Sintesi AI dell'andamento (dalla v129: solo descrittiva, parere MDR dell'8/11/2026).
 * Dalla cartella dell'app: node test/analisi.test.js (dopo npm install in functions)
 */
const assert = require("assert");
const path = require("path");
const req = require("module").createRequire(path.join(__dirname, "../functions/index.js"));
process.env.GCLOUD_PROJECT = "test";
const T = req("./index.js")._test;

// 1. Solo i campi descrittivi: niente semaforo, azione, contatto o bozza di messaggio
const a = T.normalizzaAnalisi({
  valutazione: "rosso", azione: "Contattalo", contattare: true, messaggio: "Ciao, come va?",
  titolo: "Aderenza al 78% in 30 giorni; la cena è il pasto più spesso fatto diversamente",
  sintesi: "Negli ultimi 30 giorni l'aderenza è al 78%, al 85% nei feriali e al 61% nel weekend. L'app è stata aperta ogni giorno.",
  scostamenti: "12 pasti non come da piano, 7 a cena, soprattutto per impegni sociali.",
  note: "Nelle note ricorrono le cene fuori e gli impegni di lavoro.",
  dettagli: ["Peso: -1,8 kg dall'inizio", "Ultima apertura dell'app: oggi", "Promemoria attivi", "Prossimo controllo tra 5 giorni", "quinto punto in più"],
});
assert.deepStrictEqual(Object.keys(a).sort(), ["dettagli", "formato", "note", "scostamenti", "sintesi", "titolo"]);
assert.strictEqual(a.formato, 2);
assert.strictEqual(a.dettagli.length, 4, "al massimo 4 dettagli");
assert.ok(/78%/.test(a.sintesi));
console.log("ok campi solo descrittivi");

// 2. Le frasi con valutazioni o indicazioni al professionista vengono scartate
const b = T.normalizzaAnalisi({
  titolo: "Andamento preoccupante a cena",
  sintesi: "L'aderenza è al 52% negli ultimi 30 giorni. Conviene contattarlo prima del controllo. È un segnale da tenere d'occhio.",
  scostamenti: "9 cene fatte diversamente. Sarebbe utile approfondire le difficoltà.",
  note: "Nelle note ricorrono i turni di lavoro.",
  dettagli: ["Peso stabile dall'inizio", "Il calo di peso è un buon risultato", "Valuta di semplificare la cena"],
});
assert.strictEqual(b.titolo, "", "titolo con giudizio scartato");
assert.strictEqual(b.sintesi, "L'aderenza è al 52% negli ultimi 30 giorni.");
assert.strictEqual(b.scostamenti, "9 cene fatte diversamente.");
assert.deepStrictEqual(b.dettagli, ["Peso stabile dall'inizio"]);
console.log("ok frasi valutative scartate");

// 3. Frasi descrittive con parole comuni non vengono toccate
const c = T.soloFrasiNeutre("A cena 6 pasti fatti diversamente. Nel weekend l'aderenza scende al 60%. Mancano 5 giorni al controllo.");
assert.strictEqual(c, "A cena 6 pasti fatti diversamente. Nel weekend l'aderenza scende al 60%. Mancano 5 giorni al controllo.");
console.log("ok frasi descrittive conservate");

// 4. Risposta vuota o malformata: campi vuoti, nessun errore
const d = T.normalizzaAnalisi(null);
assert.strictEqual(d.titolo, ""); assert.deepStrictEqual(d.dettagli, []);
console.log("ok risposta vuota");

// 5. Riscontro irrilevante (verifica preesistente)
const r = T.normalizzaRiscontro({ impatto: "irrilevante", stima: "Pollo al posto del roastbeef: valori simili", spiegazione: "", suggerimenti: [], messaggio: "Va bene così: domani riprendi con il piano previsto." }, [], true);
assert.ok(!/ripren/i.test(r.messaggio), "irrilevante senza 'riprendi': " + r.messaggio);
console.log("ok riscontro irrilevante:", r.messaggio);
console.log("OK: 5 verifiche superate");
