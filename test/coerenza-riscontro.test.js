// v145: marcatori dello strumento nel testo e frasi contrarie ai numeri: node test/coerenza-riscontro.test.js
const assert = require("assert");
const s = require("fs").readFileSync(__dirname + "/../functions/index.js", "utf8");
const pick = (a, b) => s.slice(s.indexOf(a), s.indexOf(b));
const api = eval(pick("function togliMarcatori", "function ripulisciRiscontro") + ";({ togliMarcatori, frasiCoerentiConNumeri })");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const caso = "La pizza margherita sostituisce il riso integrale: aggiunge soprattutto carboidrati raffinati e grassi, mentre le proteine risultano inferiori al previsto perché il riso integrale è stato sostituito. Le zucchine e l'olio EVO risultano invariati rispetto al previsto. </spiegazione> <parameter name=\"suggerimenti\">[]";
const t = api.togliMarcatori(caso);
ok(!/[<>]/.test(t) && t.endsWith("al previsto."), "via i marcatori: " + t);
const prev = { carboidrati: 80, proteine: 25, grassi: 15, kcal: 560 };
const eff = { carboidrati: 75, proteine: 35, grassi: 40, kcal: 800 };
const c = api.frasiCoerentiConNumeri(t, prev, eff);
ok(c === "Le zucchine e l'olio EVO risultano invariati rispetto al previsto.", "frase contraddittoria scartata: " + c);
ok(api.frasiCoerentiConNumeri("La pizza aggiunge soprattutto grassi.", prev, eff) === "La pizza aggiunge soprattutto grassi.", "frase coerente tenuta");
ok(api.frasiCoerentiConNumeri("Senza il secondo, il pasto ha meno proteine del previsto.", { proteine: 30 }, { proteine: 10 }) !== "", "meno proteine coerente");
ok(api.frasiCoerentiConNumeri("Il pasto ha più proteine del previsto.", { proteine: 30 }, { proteine: 10 }) === "", "più proteine contraddittorio");
ok(api.frasiCoerentiConNumeri("Testo.", null, eff) === "Testo.", "senza numeri resta tutto");

// v145: nota senza alimenti → nessun numero
const ns = eval(pick("const RE_NON_STIMABILE", "function ripulisciRiscontro") + ";nonStimabile");
ok(ns("Non è indicato quale alimento sia stato consumato al posto dello yogurt greco previsto, quindi non è possibile descrivere la differenza nutrizionale."), "nota senza alimenti riconosciuta");
ok(!ns("La pizza aggiunge soprattutto grassi."), "testo normale non toccato");
ok(!ns("Le zucchine risultano invariate rispetto al previsto."), "invariato non è non stimabile");
console.log("coerenza-riscontro: " + n + " verifiche ok");
