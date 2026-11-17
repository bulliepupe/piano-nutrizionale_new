// v147: recesso dal Premium ed esecuzione immediata: node test/recesso.test.js
const assert = require("assert");
const T = require("../functions/index.js")._test;
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const g = 86400000, t0 = Date.parse("2026-12-01T10:00:00Z");
const base = { prodotto: "premium:annuale", primoAcquisto: t0, ultimoAcquisto: t0, prezzo: { importo: 19.99, valuta: "EUR" } };
let e = T.esitoRecessoProposto(Object.assign({}, base, { richiesta: t0 + 3 * g, consenso: null }));
ok(e.esito === "totale" && e.importo === 19.99, "entro 14 giorni senza consenso: totale");
e = T.esitoRecessoProposto(Object.assign({}, base, { richiesta: t0 + 3 * g, consenso: { data: t0 - 60000 } }));
ok(e.esito === "parziale" && e.giorniGoduti === 3 && e.importo === Math.round(19.99 * 362 / 365 * 100) / 100, "con consenso: parte non goduta " + JSON.stringify(e));
e = T.esitoRecessoProposto(Object.assign({}, base, { richiesta: t0 + 15 * g, consenso: null }));
ok(e.esito === "rifiuto", "oltre 14 giorni: rifiuto");
e = T.esitoRecessoProposto(Object.assign({}, base, { prodotto: "premium:mensile", prezzo: { importo: 2.99 }, richiesta: t0 + 10 * g, consenso: { data: t0 } }));
ok(e.esito === "parziale" && e.giorniPeriodo === 30 && e.importo === Math.round(2.99 * 20 / 30 * 100) / 100, "mensile parziale");
ok(T.esitoRecessoProposto({ richiesta: t0 }).esito === "da_verificare", "senza data di acquisto: da verificare");
// consenso valido: l'ultimo prima dell'acquisto (o entro un'ora dopo)
const ts = (ms) => ({ toMillis: () => ms });
const c = T.consensoPerAcquisto([{ versione: "a", data: ts(t0 - 5 * g) }, { versione: "b", data: ts(t0 - 60000) }, { versione: "c", data: ts(t0 + 5 * g) }], t0);
ok(c && c.versione === "b", "consenso più recente prima dell'acquisto");
ok(T.consensoPerAcquisto([{ versione: "c", data: ts(t0 + 5 * g) }], t0) === null, "consenso successivo all'acquisto non vale");
// email di esito
const r = Object.assign({}, base, { id: "abc", store: "play_store", richiestaMs: t0 + 3 * g, scadenza: t0 + 365 * g });
ok(/intero importo pagato \(19,99 €\)/.test(T.emailEsitoRecesso(r, "totale").text), "email totale");
ok(/pari a 19,83 €/.test(T.emailEsitoRecesso(r, "parziale", 19.83).text), "email parziale");
ok(/oltre i 14 giorni/.test(T.emailEsitoRecesso(r, "rifiuto").text) && /disdire il rinnovo/.test(T.emailEsitoRecesso(r, "rifiuto").text), "email rifiuto");
// stato Premium: dati per il pulsante
const s = T.statoPremiumServer({ stato: "attivo", prodotto: "premium:annuale", scadenza: ts(Date.now() + 100 * g), primoAcquisto: ts(t0) }, null, Date.now());
ok(s.origine === "abbonamento" && s.recedibile === true && s.primoAcquisto === t0, "stato con dati di recesso");
console.log("recesso: " + n + " verifiche ok");
