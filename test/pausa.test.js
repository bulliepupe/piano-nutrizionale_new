/**
 * Pausa del percorso: giorni esclusi dall'aderenza, niente inattività,
 * stato "pausa" per il professionista, niente promemoria dal server.
 *   node test/pausa.test.js
 */
const assert = require("assert");
const S = require("../js/statistiche.js");
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

const oggi = new Date(2026, 9, 29); // 29/10/2026
const k = (g) => `2026-10-${String(g).padStart(2, "0")}`;
const pieno = { colazione: true, spuntinoMattina: true, pranzo: true, spuntinoPomeriggio: true, cena: true };

// 10 giorni pieni (dal 10 al 19), poi niente dal 20 al 28
const spunte = {};
for (let g = 10; g <= 19; g++) spunte[k(g)] = pieno;
const base = { spunte, inizio: k(10), oggi, ultimoAccesso: new Date(2026, 9, 19) };

const senza = S.calcola(base);
ok(senza.stato === "rosso", "senza pausa: 10 giorni senza attività = rosso (" + senza.stato + ")");

// Pausa dal 20 al 31: in corso oggi
const conPausa = S.calcola(Object.assign({}, base, { pause: [{ dal: k(20), al: k(31) }] }));
ok(conPausa.stato === "pausa", "pausa in corso: stato pausa");
ok(conPausa.giorniInattivo === 0, "pausa in corso: nessuna inattività");
ok(conPausa.aderenza7 === null, "ultimi 7 giorni tutti in pausa: aderenza non valutata");
ok(conPausa.aderenza30 === 1, "aderenza 30 giorni solo sui giorni fuori pausa: 100%");
ok(conPausa.giorniPausa30 === 9, "9 giorni di pausa conclusi negli ultimi 30 (" + conPausa.giorniPausa30 + ")");
ok(conPausa.calendario.some((c) => c.pausa && c.chiave === k(25) && c.fatti === null), "calendario: giorno in pausa segnato");
ok(/In pausa fino al 31\/10/.test(conPausa.motivi[0]), "motivo con la data di fine");
ok(conPausa.serie === 10, "la pausa non interrompe la serie (" + conPausa.serie + ")");

// Pausa finita ieri: si riparte, nessun allarme di inattività
const finita = S.calcola(Object.assign({}, base, { pause: [{ dal: k(20), al: k(28) }] }));
ok(finita.stato !== "pausa" && finita.giorniInattivo === 1, "pausa finita ieri: inattività contata dalla fine (" + finita.giorniInattivo + ")");
ok(finita.stato !== "rosso", "pausa finita ieri: niente rosso");

ok(S.ORDINE_STATO.pausa > S.ORDINE_STATO.verde && S.ORDINE_STATO.pausa < S.ORDINE_STATO.attesa, "ordine: pausa dopo verde");
ok(S.pausaDel([{ dal: k(1), al: k(3) }], k(3)) && !S.inPausa([{ dal: k(1), al: k(3) }], k(4)), "estremi inclusi");

// Server: promemoria sospesi
const path = require("path");
const req = require("module").createRequire(path.join(__dirname, "../functions/index.js"));
process.env.GCLOUD_PROJECT = "test";
const T = req("./index.js")._test;
ok(T.inPausaServer([{ dal: k(20), al: k(31) }], k(29)), "server: giorno in pausa");
ok(!T.inPausaServer([{ dal: k(20), al: k(28) }], k(29)), "server: pausa finita");
ok(!T.inPausaServer(undefined, k(29)) && !T.inPausaServer([{ dal: 1 }], k(29)), "server: dati assenti o non validi");

console.log("OK: " + n + " verifiche superate");
