/**
 * Prodotti confezionati letti dalla foto dell'etichetta: pulizia dei valori,
 * calcolo sui grammi mangiati, somma con il resto del pasto e normalizzazione
 * della risposta del modello. Dalla cartella dell'app:
 *   node test/etichette.test.js   (dopo npm install nella cartella functions)
 */
const assert = require("assert");
const path = require("path");
const M = require("../js/macro.js");
const req = require("module").createRequire(path.join(__dirname, "../functions/index.js"));
process.env.GCLOUD_PROJECT = "test";
const T = req("./index.js")._test;
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// le due copie del modulo devono restare identiche
const fs = require("fs");
ok(fs.readFileSync(path.join(__dirname, "../js/macro.js"), "utf8") === fs.readFileSync(path.join(__dirname, "../functions/macro.js"), "utf8"), "js/macro.js e functions/macro.js identici");

// calcolo sui grammi
const cracker = { nome: "  Cracker   integrali ", per100: { kcal: 428, carboidrati: 68, zuccheri: 3, proteine: 10, grassi: 11, fibre: 4, sale: 2 }, grammi: 30 };
const x = M.valoriVoceEtichetta(cracker);
ok(x.kcal === 128 && x.carboidrati === 20.4 && x.proteine === 3 && x.grassi === 3.3, "30 g di cracker: " + JSON.stringify(x));
ok(M.pulisciVoceEtichetta(cracker).nome === "Cracker integrali", "nome ripulito");
ok(M.etichettaCoerente(cracker.per100), "etichetta coerente");
ok(!M.etichettaCoerente({ kcal: 100, carboidrati: 68, proteine: 10, grassi: 11 }), "kcal incoerenti segnalate");

// valori assurdi limitati
const strano = M.pulisciVoceEtichetta({ per100: { kcal: 5000, carboidrati: 300, zuccheri: 400, proteine: -5, grassi: "x" }, grammi: 99999, unita: "litri" });
ok(strano.per100.kcal === 950 && strano.per100.carboidrati === 100 && strano.per100.zuccheri === 100 && strano.per100.proteine === 0 && strano.per100.grassi === 0, "valori limitati: " + JSON.stringify(strano.per100));
ok(strano.grammi === 2000 && strano.unita === "g" && strano.nome === "Prodotto confezionato", "grammi, unità e nome di riserva");

// somma dei prodotti e del resto del pasto
const prodotti = M.macroDaEtichette([cracker, { nome: "Yogurt", per100: { kcal: 60, carboidrati: 5, proteine: 4, grassi: 2.5 }, grammi: 125 }]);
ok(prodotti.carboidrati === 26.7 && prodotti.affidabilita === "alta", "somma dei prodotti: " + JSON.stringify(prodotti));
const conResto = M.sommaStime(prodotti, M.pulisciStima({ carboidrati: 20, proteine: 2, grassi: 1, affidabilita: "bassa" }));
ok(conResto.carboidrati === 46.7 && conResto.affidabilita === "media", "con il resto del pasto: " + JSON.stringify(conResto));
const restoVuoto = M.sommaStime(prodotti, M.pulisciStima({ carboidrati: 0, proteine: 0, grassi: 0, affidabilita: "media" }));
ok(restoVuoto.affidabilita === "alta" && restoVuoto.kcal === prodotti.kcal, "resto vuoto: resta l'affidabilità dell'etichetta");
ok(M.sommaStime(prodotti, null).kcal === prodotti.kcal, "senza stima del resto");

// risposta del modello
const e1 = T.normalizzaEtichetta({ leggibile: true, nome: "Fette biscottate", riferimento: "100g",
  valori: { kcal: 410, carboidrati: 72, zuccheri: 6, proteine: 11.5, grassi: 7, fibre: 4, sale: 1.2 },
  porzione: { grammi: 25, descrizione: "3 fette" }, confezione: { grammi: 250 } });
ok(e1 && e1.per100.kcal === 410 && e1.porzione.grammi === 25 && e1.confezione === 250 && e1.unita === "g" && e1.coerente, "lettura per 100 g: " + JSON.stringify(e1));
const e2 = T.normalizzaEtichetta({ leggibile: true, riferimento: "porzione", grammiPorzione: 40, valori: { kcal: 180, carboidrati: 24, proteine: 4, grassi: 7.2 } });
ok(e2 && e2.per100.kcal === 450 && e2.per100.carboidrati === 60 && e2.per100.grassi === 18, "solo per porzione, riportata a 100 g: " + JSON.stringify(e2 && e2.per100));
const e3 = T.normalizzaEtichetta({ leggibile: true, riferimento: "100ml", valori: { carboidrati: 10.6, proteine: 0, grassi: 0 } });
ok(e3 && e3.unita === "ml" && e3.per100.kcal === 42, "kcal ricavate dai macronutrienti: " + JSON.stringify(e3 && e3.per100));
ok(T.normalizzaEtichetta({ leggibile: false }) === null, "non leggibile");
ok(T.normalizzaEtichetta({ leggibile: true, valori: {} }) === null, "nessun valore");
ok(T.normalizzaEtichetta({ leggibile: true, riferimento: "porzione", valori: { kcal: 100 } }) === null, "porzione senza grammi");
ok(T.normalizzaEtichetta({ leggibile: true, valori: { carboidrati: 80, proteine: 30, grassi: 20 } }) === null, "somma oltre 100 g scartata");

// prodotti salvati nel pasto
const voci = T.vociEtichettaPasto({ etichette: { pranzo: [cracker, { nome: "zero", per100: {}, grammi: 0 }, ...Array(8).fill(cracker)] } }, "pranzo");
ok(voci.length === 5 && voci.every((v) => v.grammi === 30), "massimo 6 voci, senza quelle a 0 g: " + voci.length);
ok(T.vociEtichettaPasto({}, "pranzo").length === 0, "pasto senza prodotti");

// valori effettivi del pasto calcolati dal server (caso del 2/11: pranzo "in parte" con cioccolato aggiunto)
const previsti = M.pulisciStima({ carboidrati: 30, proteine: 23, grassi: 24, affidabilita: "media" });
const cioccolato = M.macroDaEtichette([{ nome: "Cioccolato fondente 70%", per100: { kcal: 570, carboidrati: 33, proteine: 8, grassi: 42, fibre: 11 }, grammi: 20 }]);
const zero = { carboidrati: 0, proteine: 0, grassi: 0, affidabilita: "alta" };
const conAggiunta = T.macroEffettiviDaRisposta({ quotaPiano: 1, macroAggiunti: zero }, previsti, cioccolato, "parziale");
ok(conAggiunta.carboidrati > previsti.carboidrati && conAggiunta.grassi > previsti.grassi && conAggiunta.kcal > previsti.kcal, "tutto il previsto + cioccolato = più del previsto: " + JSON.stringify(conAggiunta));
const meta = T.macroEffettiviDaRisposta({ quotaPiano: 0.5, macroAggiunti: zero }, previsti, null, "parziale");
ok(meta.carboidrati === 15 && meta.proteine === 11.5, "metà del pasto: " + JSON.stringify(meta));
const sostituito = T.macroEffettiviDaRisposta({ quotaPiano: 0, macroAggiunti: { carboidrati: 60, proteine: 10, grassi: 15, affidabilita: "media" } }, previsti, null, "diverso");
ok(sostituito.carboidrati === 60 && sostituito.affidabilita === "media", "pasto sostituito: " + JSON.stringify(sostituito));
const fuoriScala = T.macroEffettiviDaRisposta({ quotaPiano: 3 }, previsti, null, "diverso");
ok(fuoriScala.carboidrati === 30, "quota limitata a 1");
const saltato = T.macroEffettiviDaRisposta({ quotaPiano: 1 }, previsti, null, "saltato");
ok(saltato.kcal === 0, "saltato: zero");
const senzaPrevisti = T.macroEffettiviDaRisposta({ macroEffettivi: { carboidrati: 40, proteine: 20, grassi: 10, affidabilita: "bassa" } }, null, null, "diverso");
ok(senzaPrevisti.carboidrati === 40, "senza previsti: stima dell'AI");
const soloProdotti = T.macroEffettiviDaRisposta({ macroAggiunti: zero }, null, cioccolato, "diverso");
ok(soloProdotti.kcal === cioccolato.kcal, "senza previsti, con prodotti");
ok(T.macroEffettiviDaRisposta({}, null, null, "diverso") === null, "nessun dato: nessuna stima");

// v119: etichetta della differenza calcolata sulla giornata
const prev = M.pulisciStima({ carboidrati: 5, proteine: 3, grassi: 8, affidabilita: "media" }); // mandorle 15 g, circa 100 kcal
ok(T.impattoSullaGiornata("rilevante", prev, M.pulisciStima({ carboidrati: 0, proteine: 0, grassi: 0 }), 1500) === "lieve", "spuntino saltato da 100 kcal su 1500 (7%): lieve");
ok(T.impattoSullaGiornata("lieve", prev, M.pulisciStima({ carboidrati: 45, proteine: 3, grassi: 13 }), 1500) === "moderato", "circa 200 kcal in più su 1500 (13%): moderato");
ok(T.impattoSullaGiornata("moderato", prev, M.pulisciStima({ carboidrati: 7, proteine: 3, grassi: 9 }), 1500) === "lieve", "piccola aggiunta: lieve");
ok(T.impattoSullaGiornata("irrilevante", prev, M.pulisciStima({ carboidrati: 6, proteine: 3, grassi: 8 }), 1500) === "irrilevante", "scambio equivalente resta irrilevante");
ok(T.impattoSullaGiornata("lieve", prev, M.pulisciStima({ carboidrati: 80, proteine: 10, grassi: 30 }), 1500) === "rilevante", "oltre il 15%: marcata");
ok(T.impattoSullaGiornata("lieve", prev, null, 1500) === "lieve", "senza numeri resta l'AI");
ok(T.impattoSullaGiornata("lieve", prev, prev, 0) === "lieve", "senza calorie del giorno resta l'AI");

// v121: sostituzione di un singolo alimento (tacchino 60 g al posto del grana 20 g)
const pranzo = M.pulisciStima({ carboidrati: 60, proteine: 18, grassi: 20, affidabilita: "media" });
const scambio = T.macroEffettiviDaRisposta({ quotaPiano: 1, macroTolti: { carboidrati: 0, proteine: 7, grassi: 6, affidabilita: "media" }, macroAggiunti: { carboidrati: 0, proteine: 14, grassi: 1, affidabilita: "media" } }, pranzo, null, "diverso");
ok(scambio.carboidrati === 60 && scambio.proteine === 25 && scambio.grassi === 15, "carboidrati invariati, proteine +7, grassi -5: " + JSON.stringify(scambio));
const meno = T.macroEffettiviDaRisposta({ quotaPiano: 1, macroTolti: { carboidrati: 90, proteine: 0, grassi: 0, affidabilita: "media" } }, pranzo, null, "diverso");
ok(meno.carboidrati === 0, "mai sotto zero");
const saltatoTolti = T.macroEffettiviDaRisposta({ quotaPiano: 1, macroTolti: { carboidrati: 10, proteine: 0, grassi: 0, affidabilita: "media" } }, pranzo, null, "saltato");
ok(saltatoTolti.kcal === 0, "saltato: i tolti non contano");

console.log("OK: " + n + " verifiche superate");
