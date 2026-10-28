/**
 * Controlli dello stato Premium del paziente, del contenuto del piano e del
 * codice studio (functions/index.js). Dalla cartella dell'app:
 *   node test/premium.test.js   (dopo npm install nella cartella functions)
 */
const assert = require("assert");
const path = require("path");
const req = require("module").createRequire(path.join(__dirname, "../functions/index.js"));
process.env.GCLOUD_PROJECT = "test";
const T = req("./index.js")._test;
const { Timestamp } = req("firebase-admin/firestore");
const ora = Date.UTC(2026, 9, 13);
const giorno = 86400000;
const licAttiva = { stato: "attiva", maxPazienti: 10, scadenza: Timestamp.fromMillis(ora + 30 * giorno) };
const licScaduta = { stato: "attiva", maxPazienti: 10, scadenza: Timestamp.fromMillis(ora - giorno) };
// nessun premium
let r = T.statoPremiumServer(null, null, ora);
assert.deepStrictEqual([r.attivo, r.origine, r.provaUsata], [false, null, false]);
// nutrizionista con licenza attiva
r = T.statoPremiumServer(null, licAttiva, ora); assert.equal(r.attivo, true); assert.equal(r.origine, "nutrizionista");
// licenza scaduta, nessun premium
r = T.statoPremiumServer(null, licScaduta, ora); assert.equal(r.attivo, false);
// prova in corso
const prova = { stato: "prova", origine: "prova", provaIniziata: Timestamp.fromMillis(ora), scadenza: Timestamp.fromMillis(ora + 14 * giorno) };
r = T.statoPremiumServer(prova, null, ora + 5 * giorno); assert.equal(r.attivo, true); assert.equal(r.origine, "prova"); assert.equal(r.provaUsata, true);
// prova scaduta
r = T.statoPremiumServer(prova, null, ora + 15 * giorno); assert.equal(r.attivo, false); assert.equal(r.provaUsata, true);
// prova scaduta ma nutrizionista attivo
r = T.statoPremiumServer(prova, licAttiva, ora + 15 * giorno); assert.equal(r.attivo, true); assert.equal(r.origine, "nutrizionista");
// abbonamento attivo
r = T.statoPremiumServer({ stato: "attivo", origine: "play", scadenza: Timestamp.fromMillis(ora + 20 * giorno) }, null, ora); assert.equal(r.attivo, true); assert.equal(r.origine, "abbonamento");
// abbonamento scaduto
r = T.statoPremiumServer({ stato: "attivo", scadenza: Timestamp.fromMillis(ora - 1) }, null, ora); assert.equal(r.attivo, false);
// stato annullato
r = T.statoPremiumServer({ stato: "scaduto" }, null, ora); assert.equal(r.attivo, false);
// contenuto del piano
assert.equal(T.pianoHaContenuto({ settimane: {} }), false);
assert.equal(T.pianoHaContenuto({}), false);
assert.equal(T.pianoHaContenuto({ settimane: { 1: [{ giorno: "Lunedì", colazione: " " }] } }), false);
assert.equal(T.pianoHaContenuto({ settimane: { 1: [{ giorno: "Lunedì", pranzo: "Pasta 70g" }] } }), true);
// codice studio
for (let i = 0; i < 200; i++) assert.ok(T.codiceStudioValido(T.nuovoCodiceStudio()));
assert.equal(T.codiceStudioValido("ABC12O"), false);
assert.equal(T.codiceStudioValido("abcdef"), false);
assert.equal(T.codiceStudioValido("ABCDE"), false);
// Abbonamento da RevenueCat (Google Play)
const iso = (ms) => new Date(ms).toISOString();
const sub = (scade, extra) => ({
  entitlements: { il_mio_piano_premium: { expires_date: iso(scade), product_identifier: "premium:annuale" } },
  subscriptions: { "premium:annuale": Object.assign({ store: "play_store" }, extra || {}) },
});
let p = T.premiumDaRevenueCat(sub(ora + 300 * giorno), ora);
assert.equal(p.stato, "attivo"); assert.equal(p.origine, "play_store"); assert.equal(p.rinnovo, true);
r = T.statoPremiumServer(p, null, ora); assert.equal(r.attivo, true); assert.equal(r.origine, "abbonamento");
p = T.premiumDaRevenueCat(sub(ora + 300 * giorno, { unsubscribe_detected_at: iso(ora) }), ora);
assert.equal(p.stato, "attivo"); assert.equal(p.rinnovo, false); // disdetto: attivo fino a scadenza
p = T.premiumDaRevenueCat(sub(ora - giorno), ora);
assert.equal(p.stato, "scaduto"); r = T.statoPremiumServer(p, null, ora); assert.equal(r.attivo, false);
p = T.premiumDaRevenueCat(sub(ora + 3 * giorno, { billing_issues_detected_at: iso(ora) }), ora);
assert.equal(p.problemaPagamento, true);
assert.equal(T.premiumDaRevenueCat({ entitlements: {} }, ora), null);
assert.equal(T.premiumDaRevenueCat(null, ora), null);
console.log("Tutti i controlli superati");
