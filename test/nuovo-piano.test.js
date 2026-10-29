/**
 * Nuovo piano dal nutrizionista: identificativo per la presa visione, uguale
 * nell'app (weekLogic.pianoEffettivo) e sul server (applicaPianiProgrammati).
 *   node test/nuovo-piano.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const W = require("../js/week-logic.js");
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

const attuale = { settimane: { 1: { lunedi: {} } }, dataInizio: "2026-10-01", gestore: "professionista" };
const prossimo = { settimane: { 1: { martedi: {} } }, dataInizio: "2026-11-02", settimanaIniziale: 1, caricato: 1793300000000 };
const piano = Object.assign({}, attuale, { prossimo });

ok(!W.pianoEffettivo(piano, new Date(2026, 10, 1)).pianoNuovo, "prima della data: nessun nuovo piano");
const dopo = W.pianoEffettivo(piano, new Date(2026, 10, 2));
ok(dopo.pianoNuovo && dopo.pianoNuovo.id === "1793300000000" && dopo.pianoNuovo.dal === "2026-11-02", "dalla data: nuovo piano con id e data");
ok(W.pianoEffettivo(Object.assign({}, attuale, { prossimo: Object.assign({}, prossimo, { caricato: undefined }) }), new Date(2026, 10, 3)).pianoNuovo.id === "2026-11-02", "senza caricato: id = data di inizio");

const server = fs.readFileSync(path.join(__dirname, "../functions/index.js"), "utf8");
ok(server.includes("pianoNuovo: { id: String(pr.caricato || pr.dataInizio), dal: pr.dataInizio }"), "il server usa lo stesso identificativo");
const app = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
ok(/IMPORTA\.ctx\.paziente \? \{\} : \{ pianoNuovo:/.test(app), "solo i piani caricati dal nutrizionista chiedono la presa visione");
console.log("OK: " + n + " verifiche superate");
