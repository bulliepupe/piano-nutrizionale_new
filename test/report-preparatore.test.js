// Verifiche del report per il preparatore: node test/report-preparatore.test.js
const assert = require("assert");
const R = require("../js/report-preparatore.js");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const oggi = new Date(2026, 9, 18); // domenica 18 ottobre 2026
const spunte = {};
// settimana 5-11 ottobre: tutto fatto; 12-17: metà fatto, metà saltato
for (let g = 5; g <= 11; g++) spunte[`2026-10-${String(g).padStart(2, "0")}`] = { colazione: true, spuntinoMattina: true, pranzo: true, spuntinoPomeriggio: true, cena: true };
for (let g = 12; g <= 17; g++) spunte[`2026-10-${g}`] = { colazione: true, spuntinoMattina: "saltato", pranzo: "diverso", spuntinoPomeriggio: true, cena: true };
spunte["2026-10-18"] = { colazione: true }; // oggi: non conta
const attivita = {
  "2026-10-11": { allenamenti: [{ tipo: "Bici", durata: 180, distanzaKm: 90, dislivelloM: 1200, lavoroKJ: 2400, tss: 210, kcal: 2500, intensita: "moderata", zoneFC: [20, 140, 15, 5, 0], fonte: "file" }] },
  "2026-10-15": { allenamenti: [{ tipo: "Corsa", durata: 45, intensita: "leggera", fonte: "manuale" }] },
  "2026-10-17": { allenamenti: [{ tipo: "Bici", durata: 92, distanzaKm: 48, dislivelloM: 450, lavoroKJ: 1038, tss: 122, kcal: 1150, intensita: "moderata", fonte: "file" }] },
  "2026-09-01": { allenamenti: [{ tipo: "Bici", durata: 60 }] }, // fuori periodo
};
const misure = [{ data: "2026-10-06", peso: 72.4 }, { data: "2026-10-16", peso: 71.8, vita: 82 }, { data: "2026-08-01", peso: 74 }];
const r = R.calcola({ da: "2026-10-05", a: "2026-10-18", oggi, inizioPiano: "2026-09-01", spunte, attivita, misure });
ok(r.giorniValutati === 13, "13 giorni conclusi " + r.giorniValutati);
ok(r.settimane.length === 2 && r.settimane[0].lunedi === "2026-10-05" && r.settimane[1].lunedi === "2026-10-12", "due settimane");
ok(r.settimane[0].aderenza === 1, "prima settimana 100%");
ok(Math.abs(r.settimane[1].aderenza - 0.7) < 1e-9, "seconda settimana 70% " + r.settimane[1].aderenza);
ok(r.conta.saltato === 6 && r.conta.diverso === 6, "conteggi");
ok(r.allenamenti.totale.n === 3 && r.allenamenti.totale.km === 138 && r.allenamenti.totale.tss === 332 && r.allenamenti.totale.minuti === 317, "totali allenamenti");
ok(r.settimane[0].allenamenti.tss === 210 && r.settimane[1].allenamenti.n === 2, "carico per settimana");
ok(r.allenamenti.totale.conZone === 1 && r.allenamenti.totale.zone[1] === 140, "zone");
ok(r.peso && r.peso.variazione === -0.6 && r.misure.length === 2, "peso del periodo");
// piano iniziato a metà periodo
const r2 = R.calcola({ da: "2026-10-05", a: "2026-10-18", oggi, inizioPiano: "2026-10-12", spunte, attivita, misure });
ok(r2.giorniValutati === 6 && r2.settimane[0].aderenza === null, "prima dell'inizio non si valuta");
// periodo che inizia a metà settimana
const r3 = R.calcola({ da: "2026-10-08", a: "2026-10-18", oggi, spunte, attivita, misure: [] });
ok(r3.settimane[0].parziale && r3.settimane[0].giorniValutati === 4 && r3.peso === null, "settimana parziale");
console.log("OK: " + n + " verifiche superate");
