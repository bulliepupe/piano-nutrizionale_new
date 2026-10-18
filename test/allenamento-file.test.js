// Verifiche dell'importazione degli allenamenti da file: node test/allenamento-file.test.js
process.env.TZ = "Europe/Rome";
const assert = require("assert");
const fs = require("fs");
const A = require("../js/allenamento-file.js");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const par = { fcMax: 185, fcSoglia: 165, ftp: 230 };

// TCX (corsa 45 min, Garmin Connect)
const t = A.riepilogo(A.daTcx(fs.readFileSync(__dirname + "/campioni/corsa.tcx", "utf8")), par);
ok(t.tipo === "Corsa" && t.durata === 45 && t.distanzaKm === 8.1 && t.kcal === 610, "tcx base " + JSON.stringify(t));
ok(t.fcMedia === 147 && t.fcMax === 168, "tcx fc dal giro");
ok(t.giorno === "2026-10-17" && t.ora === "11:00", "tcx ora locale");
ok(t.zoneFC && t.zoneFC.reduce((a, b) => a + b, 0) === 45 && t.zoneBase === "soglia", "tcx zone");
ok(t.intensita === "intensa" && t.intensitaFonte === "zone", "tcx intensità");
ok(!("campioni" in t) && !JSON.stringify(t).includes("lat"), "niente campioni né posizioni nel riepilogo");

// GPX (bici 60 min più una pausa di 10, Strava)
const g = A.riepilogo(A.daGpx(fs.readFileSync(__dirname + "/campioni/giro.gpx", "utf8")), par);
ok(g.tipo === "Bici" && g.durata === 60, "gpx durata senza pausa " + g.durata);
ok(g.distanzaKm > 9 && g.distanzaKm < 11, "gpx distanza " + g.distanzaKm);
ok(!g.kcal, "gpx senza calorie");
ok(g.potenzaMedia === 200 && g.intensitaFonte === "potenza" && g.intensita === "moderata", "gpx potenza");

// FIT: oggetto come lo restituisce fit-file-parser
const inizio = Date.parse("2026-10-17T07:00:00Z");
const records = []; for (let i = 0; i < 3600; i++) records.push({ timestamp: new Date(inizio + i * 1000).toISOString(), heart_rate: 125, power: 150 });
const recordsGps = records.map((r) => Object.assign({ position_lat: 45.5, position_long: 9.2 }, r));
const f = A.riepilogo(A.daFit({ sessions: [{ sport: "cycling", start_time: new Date(inizio).toISOString(), total_timer_time: 3600, total_distance: 30000, total_calories: 700, avg_heart_rate: 125, max_heart_rate: 140, avg_power: 150, total_ascent: 300 }], records: recordsGps }), { fcMax: 185 });
ok(f.tipo === "Bici" && f.durata === 60 && f.distanzaKm === 30 && f.kcal === 700 && f.dislivelloM === 300, "fit base");
ok(f.zoneBase === "massima" && f.zoneFC[1] === 60 && f.intensita === "leggera", "fit zona 2 → leggera " + JSON.stringify(f.zoneFC));

// senza parametri: nessuna intensità calcolata (resta quella scelta dal paziente)
ok(!A.riepilogo(A.daFit({ sessions: [{ sport: "running", start_time: new Date(inizio).toISOString(), total_timer_time: 1800 }], records: [] }), {}).intensita, "senza parametri");
ok(A.tipoDa("VirtualRide") === "Bici" && A.tipoDa("trail_running") === "Corsa" && A.tipoDa("kayaking") === "Altro", "tipi");
ok(A.limitiZone({ fcSoglia: 300 }) === null && A.limitiZone({ fcMax: 180 }).limiti[1] === 126, "limiti zone");
assert.throws(() => A.daGpx("<gpx></gpx>")); n++;

// indici di carico
const costante = []; for (let i = 0; i < 3600; i++) costante.push({ t: i, w: 200, fc: i < 1800 ? 130 : 143 });
ok(A.potenzaNormalizzata(costante) === 200, "NP costante");
const alterna = []; for (let i = 0; i < 3600; i++) alterna.push({ t: i, w: Math.floor(i / 60) % 2 ? 300 : 100, fc: 140 });
ok(A.potenzaNormalizzata(alterna) > 200, "NP > media con ripetute");
ok(A.derivaCardiaca(costante) === 9.1, "deriva 9,1% " + A.derivaCardiaca(costante));
ok(A.derivaCardiaca(costante.slice(0, 600)) === null, "deriva solo oltre 20 minuti");
const conFtp = A.riepilogo(A.daFit({ sessions: [{ sport: "cycling", start_time: new Date(inizio).toISOString(), total_timer_time: 3600, avg_power: 200, total_calories: 800 }],
  records: costante.map((c) => ({ timestamp: new Date(inizio + c.t * 1000).toISOString(), heart_rate: c.fc, power: c.w })) }), { ftp: 250 });
ok(conFtp.potenzaNormalizzata === 200 && conFtp.fattoreIntensita === 0.8 && conFtp.tss === 64 && conFtp.lavoroKJ === 720 && conFtp.kcalOra === 800, "TSS, IF, kJ, kcal/h " + JSON.stringify(conFtp));

// indoor / su strada
ok(!f.indoor && !t.indoor && !g.indoor, "su strada");
const rulli = A.riepilogo(A.daFit({ sessions: [{ sport: "cycling", sub_sport: "indoor_cycling", start_time: new Date(inizio).toISOString(), total_timer_time: 3600 }], records: [] }), {});
ok(rulli.indoor === true, "rulli dal sottotipo");
const senzaGps = A.riepilogo(A.daFit({ sessions: [{ sport: "cycling", start_time: new Date(inizio).toISOString(), total_timer_time: 3600 }], records }), {});
ok(senzaGps.indoor === true, "senza GPS = indoor");
ok(A.riepilogo(A.daFit({ sessions: [{ sport: "cycling", start_time: new Date(inizio).toISOString(), total_timer_time: 3600 }], records: records.map((r) => Object.assign({ position_lat: 45.5, position_long: 9.2 }, r)) }), {}).indoor === undefined, "con GPS = su strada");
console.log("OK: " + n + " verifiche superate");
