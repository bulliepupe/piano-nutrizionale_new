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

// ---------------------------------------------------------------------
// Casi dai piani reali (pasti scritti su più righe, con "e" / "o" / "0")
// ---------------------------------------------------------------------
const reali = [
  ["1 cucchiaino di olio di oliva extravergine (5 g)", ["Olio extravergine d'oliva"]],
  ["1 pacchetto di crackers integrali (30 g)", ["Crackers integrali"]],
  ["1 porzione di croccole", ["Croccole"]],
  ["1/2 porzione di muffin all'acqua cioccolatosi", ["Muffin all'acqua cioccolatosi"]],
  ["1 porzione di marmellata senza zuccheri aggiunti Rigoni di Asiago (20 g)", ["Marmellata senza zuccheri"]],
  ["1 porzione di hummus di ceci", ["Hummus"]],
  ["1 porzione di insalata di seppie con carote, sedano e ravanelli", ["Seppie", "Carote", "Sedano", "Ravanelli"]],
  ["1 porzione di scaloppina di pollo al limone", ["Pollo", "Limoni"]],
  ["1 porzione di merluzzo con olive taggiasche", ["Merluzzo", "Olive"]],
  ["1 pacchetto di triangolini di legumi Fiorentini (20 g)", ["Snack di legumi"]],
  ["2 fette di pan bauletto integrale Mulino Bianco (50 g)", ["Pane in cassetta integrale"]],
  ["125 grammi dii latte di soia senza zuccheri aggiunti", ["Bevanda vegetale"]],
  ["10 grammi di cocco rapè", ["Cocco rapè"]],
];
reali.forEach(([testo, attesi]) => { assert.deepStrictEqual(nomi(testo), attesi, `"${testo}"`); ok++; });
const unico = (testo) => A.analizzaPasto(testo);
// prodotti pronti di marca restano prodotti
assert.strictEqual(unico("2 burger di merluzzo Frosta")[0].voce.nome, "Burger di merluzzo Frosta"); ok++;
// refuso "9" al posto di "g"
assert.strictEqual(q(unico("1 porzione di ricotta di vacca (100 9)")[0]), "100 g"); ok++;
// "o" dentro le parentesi non è un'alternativa
const frutta = unico("1 porzione di frutta (1 frutto grande o 2 piccoli) (150 g)");
assert.deepStrictEqual(frutta.map((e) => `${e.tipo} ${e.voce && e.voce.nome} ${q(e)}`), ["voce Frutta fresca 150 g"]); ok++;
// pasto libero
assert.deepStrictEqual(unico("PIATTO A PIACERE + SE VUOI UN CONTORNO DI VERDURE DA CONDIRE CON\n1 CUCCHIAINO DI OLIO (e\nlimone/aceto se preferisci)"), []); ok++;
// hummus di ceci o hummus Noa (88 g): un solo articolo con la quantità
const hummus = unico("1 porzione di hummus di ceci o 1/2 porzione di hummus Noa (88 g)\ne\n80 grammi di pane integrale (un panino)");
assert.deepStrictEqual(hummus.map((e) => `${e.voce.nome} ${q(e)}`), ["Hummus 88 g", "Pane integrale 80 g"]); ok++;
// giovedì a pranzo: 9 carboidrati e 3 proteine a scelta, istruzione ignorata, verdura e olio fissi
const giovedi = "60 grammi di pasta di semola integrale\no\n60 grammi di riso basmati o 60 grammi di riso venere\no \n60 grammi di cous cous\no \n60 grammi di orzo perlato\no \n60 grammi di frisella\no \n60 grammi di pasta di mais\no \n60 grammi di quinoa\no \npasta di quinoa\ne\n1 scatoletta piccola di tonno confezionato al naturale (56 g)\no \n1 fetta di salmone affumicato (40 g)\no \n50 grammi di tonno sott'olio, sgocciolato (in vetro).\nSe scegli questo riduci l'olio ad 1 cucchiaino (5 g)\ne\n1 porzione di media di verdura (200 g)\ne\n1 cucchiaio di olio di oliva extravergine (10 g)";
const gv = unico(giovedi);
assert.deepStrictEqual(gv.map((e) => (e.tipo === "voce" ? `${e.voce.nome} ${q(e)}` : `${e.gruppo}: ${e.opzioni.length}`)),
  ["carboidrato: 9", "proteina: 3", "Verdure di stagione 200 g", "Olio extravergine d'oliva 10 g"]); ok++;
// cena: quattro piatti alternativi, ognuno con i suoi ingredienti
const cena = unico("1 porzione di bocconcini di pollo cremosi con limone e zenzero\n0 \n1 porzione di pollo alle mandorle\n0\n1 porzione di burger di riso e fagioli\n0\n1 porzione di polpette di pollo e zucchine\ne\n1 porzione di media di verdura (200 g)\ne\n1 cucchiaio di olio di oliva extravergine (10 g)");
assert.strictEqual(cena[0].gruppo, "piatto");
assert.deepStrictEqual(cena[0].opzioni.map((o) => `${o.etichetta}: ${o.voci.map((v) => v.voce.nome).join("+")}`), [
  "Bocconcini di pollo cremosi con limone e zenzero: Pollo+Limoni+Zenzero", "Pollo alle mandorle: Pollo+Mandorle",
  "Burger di riso e fagioli: Riso+Fagioli", "Polpette di pollo e zucchine: Pollo+Zucchine"]);
assert.deepStrictEqual(cena.slice(1).map((e) => `${e.voce.nome} ${q(e)}`), ["Verdure di stagione 200 g", "Olio extravergine d'oliva 10 g"]);
ok += 3;
// riga spezzata a metà e opzione composta con "+"
const venerdi = unico("230 grammi di orata fresca\no \n1/2 porzione di polpette di merluzzo Frosta (120 g) +\n1 cucchiaino di olio extra (5g)\no \n1 porzione di polpette di lenticchie o 1 porzione di\npolpette di piselli");
assert.deepStrictEqual(venerdi[0].opzioni.map((o) => o.etichetta), ["Orata fresca", "Polpette di merluzzo Frosta", "Polpette di lenticchie", "Polpette di piselli"]);
assert.deepStrictEqual(venerdi[0].opzioni[1].voci.map((v) => `${v.voce.nome} ${q(v)}`), ["Polpette di merluzzo Frosta 120 g", "Olio extravergine d'oliva 5 g"]);
ok += 2;

// Confezioni indicative
const conf = (nome, tot) => { const c = A.confezioniNecessarie({ nome, tot }); return c && c.testo; };
assert.strictEqual(conf("Latte parzialmente scremato", { ml: 1400 }), "2 × 1 L");
assert.strictEqual(conf("Uova", { pz: { pz: 5 } }), "1 × conf. da 6");
assert.strictEqual(conf("Pasta", { g: 505 }), "1 × 500 g");
assert.strictEqual(conf("Yogurt greco", { g: 225 }), "2 × vasetto da 150 g");
assert.strictEqual(conf("Zucchine", { g: 400 }), null);
ok += 5;

console.log(`OK: ${ok} verifiche superate`);
