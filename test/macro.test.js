// Verifiche del modulo macro.js: node test/macro.test.js
const assert = require("assert");
const M = require("../js/macro.js");
const S = require("../functions/macro.js");
assert.strictEqual(require("fs").readFileSync(__dirname + "/../js/macro.js", "utf8"), require("fs").readFileSync(__dirname + "/../functions/macro.js", "utf8"), "le due copie di macro.js devono essere identiche");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

ok(M.normalizzaPasto("  Pollo  alla Griglia 220g ") === "pollo alla griglia 220g", "normalizza");
ok(M.normalizzaPasto("Fiocchi d’avena") === M.normalizzaPasto("fiocchi d'avena"), "apostrofi");
ok(!M.daStimare("Nessuno spuntino"), "nessuno spuntino");
ok(!M.daStimare("Incluso nel pasto libero"), "incluso nel libero");
ok(M.daStimare("Mela 250g"), "mela");

const p = M.pulisciStima({ carboidrati: 50, proteine: 30, grassi: 10, affidabilita: "alta" });
ok(p.kcal === 410, "kcal 4/4/9: " + p.kcal);
ok(M.pulisciStima({ carboidrati: -5, proteine: "x", grassi: 9999 }).grassi === 200, "limiti");
ok(M.pulisciStima({ libero: true, carboidrati: 90 }).kcal === 0, "libero a zero");

// giorno con kcal del nutrizionista: le stime si proporzionano
const giorno = { colazione: "Latte 200ml", spuntinoMattina: "Mela 250g", pranzo: "Pasta 70g", spuntinoPomeriggio: "Noci 20g", cena: "Pollo 220g", coccola: "Cioccolato 10g", kcal: 1500 };
const st = {};
["colazione", "spuntinoMattina", "pranzo", "spuntinoPomeriggio", "cena", "coccola"].forEach((c) => { st[c] = M.pulisciStima({ carboidrati: 30, proteine: 15, grassi: 10 }); }); // 270 kcal x 6 = 1620
const g = M.macroGiorno(giorno, st);
ok(g.completo && Math.abs(g.fattore - 1500 / 1620) < 0.001, "fattore " + g.fattore);
ok(Math.abs(g.totale.kcal - 1500) <= 6, "totale vicino a 1500: " + g.totale.kcal);

// giorno incompleto: nessuna calibrazione
const parz = Object.assign({}, st); delete parz.cena;
ok(M.macroGiorno(giorno, parz).fattore === 1 && !M.macroGiorno(giorno, parz).completo, "incompleto");
// differenza eccessiva: nessuna calibrazione
ok(M.macroGiorno(Object.assign({}, giorno, { kcal: 3000 }), st).fattore === 1, "fuori limite");
// pasto libero: nessuna calibrazione e libero escluso dal totale
const lib = Object.assign({}, st, { cena: M.pulisciStima({ libero: true }) });
const gl = M.macroGiorno(giorno, lib);
ok(gl.haLibero && gl.fattore === 1 && gl.totale.kcal === 1350, "libero " + gl.totale.kcal);

// assunti
const a = M.macroAssunti(g, { colazione: true, pranzo: "saltato", cena: "parziale", spuntinoMattina: "diverso" },
  { spuntinoMattina: M.pulisciStima({ carboidrati: 10, proteine: 0, grassi: 0 }) });
const c0 = g.pasti.colazione.carboidrati;
ok(a.carboidrati === Math.round(c0 + 10 + g.pasti.cena.carboidrati / 2), "assunti " + a.carboidrati);
ok(M.macroAssunti(g, {}).kcal === 0, "niente segnato");
console.log("OK: " + n + " verifiche superate");
