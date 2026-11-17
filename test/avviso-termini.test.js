// v149: avviso di modifica dei termini (30 giorni, email e app): node test/avviso-termini.test.js
const assert = require("assert");
const T = require("../functions/index.js")._test;
const s = require("fs").readFileSync(__dirname + "/../js/app.js", "utf8");
const pick = (a, b) => s.slice(s.indexOf(a), s.indexOf(b));
const UID = "u1"; const app = eval(pick("const RUOLI_AVVISO", "async function controllaAvvisoTermini") + ";({ avvisoTerminiDaMostrare })");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const oggi = Date.parse("2026-12-01T10:00:00Z");
const base = { destinatari: "pazienti", inVigoreDal: "2027-01-05", sintesi: "Nuova sezione sul recesso e sui reclami, con i tempi di risposta." };
ok(T.erroreAvvisoTermini(base, oggi) === null, "avviso valido con più di 30 giorni");
ok(/30 giorni/.test(T.erroreAvvisoTermini(Object.assign({}, base, { inVigoreDal: "2026-12-20" }), oggi)), "preavviso troppo corto rifiutato");
ok(/destinatari/.test(T.erroreAvvisoTermini(Object.assign({}, base, { destinatari: "clienti" }), oggi)), "destinatari sbagliati");
ok(/sintesi/.test(T.erroreAvvisoTermini(Object.assign({}, base, { sintesi: "breve" }), oggi)), "sintesi troppo corta");
ok(/link/.test(T.erroreAvvisoTermini(Object.assign({}, base, { link: "https://altro.it/x" }), oggi)), "link esterno rifiutato");
const m = T.emailAvvisoTermini(base);
ok(/5 gennaio 2027/.test(m.subject) && m.text.includes(base.sintesi) && /termini\.html/.test(m.text), "email con data, sintesi e link");
// nell'app
const avvisi = [Object.assign({ id: "a1", stato: "inviato" }, base), { id: "a0", stato: "errore", destinatari: "pazienti", inVigoreDal: "2027-01-05" }];
ok(app.avvisoTerminiDaMostrare(avvisi, "paziente", [], oggi).id === "a1", "avviso mostrato al paziente");
ok(app.avvisoTerminiDaMostrare(avvisi, "professionista", [], oggi) === null, "non ai professionisti");
ok(app.avvisoTerminiDaMostrare(avvisi, "paziente", ["a1"], oggi) === null, "non dopo la lettura");
ok(app.avvisoTerminiDaMostrare(avvisi, "paziente", [], Date.parse("2027-03-10T10:00:00Z")) === null, "non oltre 60 giorni dall'entrata in vigore");
ok(app.avvisoTerminiDaMostrare([Object.assign({ id: "p", stato: "inviato", prova: "altro" }, base)], "paziente", [], oggi) === null, "avviso di prova solo per l'utente indicato");
ok(app.avvisoTerminiDaMostrare([Object.assign({ id: "p", stato: "inviato", prova: "u1" }, base)], "paziente", [], oggi).id === "p", "avviso di prova all'utente indicato");
console.log("avviso-termini: " + n + " verifiche ok");
