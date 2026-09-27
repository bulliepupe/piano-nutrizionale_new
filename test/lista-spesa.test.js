/**
 * Casi di prova del motore della lista della spesa (js/alimenti.js).
 * Si eseguono dalla cartella dell'app con:  node test/lista-spesa.test.js
 * Ogni caso nasce da un testo reale dei piani: se una modifica al catalogo
 * lo rompe, il comando lo segnala.
 */
const assert = require("assert");
const A = require("../js/alimenti.js");

const nomi = (testo) => A.vociDaPasto(testo).map((v) => v.nome);
const q = (el) => (el && el.qta ? A.formattaQuantita(el.qta.g ? { g: el.qta.g } : el.qta.ml ? { ml: el.qta.ml } : { pz: { [el.qta.unita]: el.qta.pz } }) : null);

const casi = [
  // forma del piatto ≠ alimento
  ["Burger di riso e fagioli", ["Riso", "Fagioli"]],
  ["Burger di ceci e patate", ["Ceci", "Patate"]],
  ["Polpette di piselli", ["Piselli"]],
  ["Burger vegetale 100g", ["Burger vegetali"]],
  // "piatto alla/alle X" contiene entrambi
  ["Pollo alle mandorle", ["Pollo", "Mandorle"]],
  ["Tofu alla tahina", ["Tofu", "Tahina"]],
  // piatti che richiedono un prodotto diverso
  ["Mini cecine", ["Farina di ceci"]],
  // prodotti trasformati distinti dall'ingrediente
  ["Fiocchi d'avena 40g", ["Fiocchi d'avena"]],
  ["Farina di avena 40g", ["Farina d'avena"]],
  ["Farina di farro 50g", ["Farina di farro"]],
  ["Pane integrale 50g", ["Pane integrale"]],
  ["Pan bauletto integrale 2 fette", ["Pane in cassetta integrale"]],
  ["Crema Novi 15g", ["Crema spalmabile"]],
  ["Cioccolato fondente 10g", ["Cioccolato fondente"]],
  // niente falsi amici
  ["1 scatoletta piccola di tonno confezionato al naturale (56 g)", ["Tonno al naturale"]],
  ["50 grammi di tonno sott'olio, sgocciolato (in vetro)", ["Tonno sott'olio"]],
  ["60 grammi di pasta di mais", ["Pasta di mais"]],
  ["Zucchina", ["Zucchine"]], ["zucchine grigliate 200g", ["Zucchine"]],
];
let ok = 0;
casi.forEach(([testo, attesi]) => {
  assert.deepStrictEqual(nomi(testo), attesi, `"${testo}"`);
  ok++;
});

// Alternative: una riga "a scelta" per gruppo, con le quantità di ciascuna opzione
const lungo = "60 grammi di pasta di semola integrale o 60 grammi di riso basmati o 60 grammi di riso venere o 60 grammi di cous cous o 60 grammi di orzo perlato o 60 grammi di frisella o 60 grammi di pasta di mais o 60 grammi di quinoa o pasta di quinoa e 1 scatoletta piccola di tonno confezionato al naturale (56 g) o 1 fetta di salmone affumicato (40 g) o 50 grammi di tonno sott'olio, sgocciolato (in vetro)";
const el = A.analizzaPezzo(lungo);
assert.strictEqual(el.length, 2, "due gruppi a scelta");
assert.strictEqual(el[0].tipo, "alternativa"); assert.strictEqual(el[0].gruppo, "carboidrato");
assert.deepStrictEqual(el[0].opzioni.map((o) => o.voce.nome), ["Pasta integrale", "Riso basmati", "Riso venere", "Cous cous", "Orzo", "Friselle", "Pasta di mais", "Quinoa", "Pasta di quinoa"]);
assert.ok(el[0].opzioni.every((o) => q(o) === "60 g"), "60 g per ogni carboidrato");
assert.strictEqual(el[1].gruppo, "proteina");
assert.deepStrictEqual(el[1].opzioni.map((o) => `${o.voce.nome} ${q(o)}`), ["Tonno al naturale 56 g", "Salmone affumicato 40 g", "Tonno sott'olio 50 g"]);
ok += 6;

// Quantità condivisa tra alternative e quantità della voce generica
const pt = A.analizzaPezzo("Carne bianca (Pollo/Tacchino 250g)")[0];
assert.deepStrictEqual(pt.opzioni.map((o) => `${o.voce.nome} ${q(o)}`), ["Pollo 250 g", "Tacchino 250 g"]); ok++;
const fs = A.analizzaPezzo("Frutta secca 20g (noci/mandorle)")[0];
assert.deepStrictEqual(fs.opzioni.map((o) => `${o.voce.nome} ${q(o)}`), ["Noci 20 g", "Mandorle 20 g"]); ok++;
// La variante prevale sulla base, con la quantità tra parentesi
const pi = A.analizzaPezzo("Pasta integrale con Olio EVO 12g (Pasta 70g)");
assert.deepStrictEqual(pi.map((e) => `${e.voce.nome} ${q(e)}`), ["Pasta integrale 70 g", "Olio extravergine d'oliva 12 g"]); ok++;
// "+" dentro le parentesi separa gli ingredienti
const fr = A.analizzaPezzo("Frittata al forno (1 uovo + 150g albumi + spinaci)");
assert.deepStrictEqual(fr.map((e) => `${e.voce.nome} ${q(e)}`), ["Uova 1 pz", "Albumi 150 g", "Spinaci null"]); ok++;

// Somma della settimana con il dettaglio dei giorni
const settimana = [{ cena: "Pollo 250g + Zucchine 200g" }, {}, {}, { pranzo: "Pollo alla griglia 250g" }, {}, {}, {}];
const pollo = A.listaDaSettimana(settimana, ["pranzo", "cena"]).find((v) => v.nome === "Pollo");
assert.strictEqual(A.formattaQuantita(pollo.tot), "500 g");
assert.strictEqual(A.testoGiorni(pollo), "lun 250 g · gio 250 g");
const soloGiovedi = A.restringiGiorni(pollo, [3, 4, 5, 6]);
assert.strictEqual(A.formattaQuantita(soloGiovedi.tot), "250 g");
ok += 3;

console.log(`OK: ${ok} verifiche superate`);
