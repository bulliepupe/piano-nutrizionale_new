// v151: allineamento dell'app ai termini rivisti dall'avvocato (18/11/2026): node test/allineamento-termini.test.js
const assert = require("assert");
const T = require("../functions/index.js")._test;
const app = require("fs").readFileSync(__dirname + "/../js/app.js", "utf8");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const adesso = Date.parse("2026-11-20T12:00:00Z");
// 11.3: modifiche imposte dalla legge con preavviso breve
const base = { destinatari: "tutti", inVigoreDal: "2026-12-01", sintesi: "Adeguamento a una nuova norma sui servizi digitali." };
ok(/30 giorni/.test(T.erroreAvvisoTermini(base, adesso)), "senza obbligo di legge servono 30 giorni");
ok(T.erroreAvvisoTermini(Object.assign({}, base, { obbligoDiLegge: true }), adesso) === null, "con obbligo di legge il preavviso può essere breve");
ok(/obbligo di legge/.test(T.emailAvvisoTermini(Object.assign({}, base, { obbligoDiLegge: true })).text), "l'email lo dice");
// 6.3 e 12.2: richieste arrivate per email o PEC
const r = T.datiRichiestaManuale({ tipo: "reclamo", email: "Mario@Esempio.it", ricevutoIl: "2026-11-20 10:30", canale: "PEC", testo: "L'app non salva i pasti da ieri sera." }, adesso);
ok(!r.errore && r.email === "mario@esempio.it" && r.canale === "PEC", "reclamo per PEC valido");
ok(r.ms === Date.parse("2026-11-20T09:30:00Z"), "ora italiana d'inverno");
const e = T.datiRichiestaManuale({ tipo: "recesso", email: "a@b.it", ricevutoIl: "2026-07-10 10:30" }, Date.parse("2026-07-20T12:00:00Z"));
ok(e.ms === Date.parse("2026-07-10T08:30:00Z"), "ora italiana d'estate");
ok(/tipo/.test(T.datiRichiestaManuale({ tipo: "altro", email: "a@b.it", ricevutoIl: "2026-11-20 10:30" }, adesso).errore), "tipo sbagliato");
ok(/testo/.test(T.datiRichiestaManuale({ tipo: "reclamo", email: "a@b.it", ricevutoIl: "2026-11-20 10:30" }, adesso).errore), "reclamo senza testo");
ok(/plausibile/.test(T.datiRichiestaManuale({ tipo: "recesso", email: "a@b.it", ricevutoIl: "2026-11-25 10:30" }, adesso).errore), "data nel futuro rifiutata");
// app: casella facoltativa, nome del pulsante, prova con le date, promemoria del rinnovo
ok(!/data-pacchetto="\$\{i\}" style="margin-top:8px;" disabled/.test(app) && /Facoltativo\. Se non spunti la casella/.test(app), "consenso all'esecuzione immediata facoltativo");
ok(app.includes(">Conferma recesso</button>"), "pulsante «Conferma recesso»");
ok(app.includes("function mostraInizioProva") && app.includes("mostraInizioProva(r)"), "inizio prova con le date");
ok(app.includes("function bannerRinnovoHTML") && app.includes("si rinnova"), "promemoria del rinnovo");
console.log("allineamento-termini: " + n + " verifiche ok");
