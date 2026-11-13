/**
 * R12 (v140): scelte separate per l'account autonomo collegato.
 * Dalla cartella dell'app: node test/sintesi-consenso.test.js (dopo npm install in functions)
 */
const assert = require("assert");
const path = require("path");
process.env.GCLOUD_PROJECT = "test";
const T = require("module").createRequire(path.join(__dirname, "../functions/index.js"))("./index.js")._test;
const aiSi = { si: true, versione: "2026-11-13" };
const sintesi = (si, titolare, versione) => ({ si, titolare, versione: versione || "2026-11-13" });

// Paziente autonomo collegato al nutrizionista P1
const auto = (consensi) => ({ ruolo: "paziente", autonomo: true, professionistaUid: "P1", consensi });
assert.strictEqual(T.consensoSintesiNegato(auto({ ai: aiSi }), "P1"), true, "1. AI personale sì, sintesi mai scelta: sintesi bloccata");
assert.strictEqual(T.consensoSintesiNegato(auto({ ai: { si: false, versione: "2026-11-13" }, aiNutrizionista: sintesi(true, "P1") }), "P1"), false, "2. AI personale no, sintesi sì: sintesi consentita (scelte indipendenti)");
assert.strictEqual(T.consensoSintesiNegato(auto({ ai: aiSi, aiNutrizionista: sintesi(false, "P1") }), "P1"), true, "3. sintesi rifiutata: bloccata anche con l'AI personale attiva");
assert.strictEqual(T.consensoSintesiNegato(auto({ aiNutrizionista: sintesi(true, "P2") }), "P1"), true, "4. scelta data per un altro nutrizionista: non vale");
assert.strictEqual(T.consensoSintesiNegato(auto({ aiNutrizionista: sintesi(true, "P1", "2026-11-12") }), "P1"), true, "5. versione precedente del testo: non vale");
assert.strictEqual(T.consensoSintesiNegato(Object.assign(auto({ aiNutrizionista: sintesi(true, "P1") }), { confermaRichiesta: { entro: 1 } }), "P1"), true, "6. conferma di fine licenza in sospeso: bloccata");
// Il rifiuto della sintesi non tocca l'AI personale
assert.strictEqual(T.consensoAINegato(auto({ ai: aiSi, aiNutrizionista: sintesi(false, "P1") })), false, "7. sintesi rifiutata: AI personale resta attiva");
assert.strictEqual(T.consensoAINegato(auto({ ai: { si: false, versione: "2026-11-13" }, aiNutrizionista: sintesi(true, "P1") })), true, "8. sintesi accettata non attiva l'AI personale");
// Paziente creato dal nutrizionista: invariato, vale il consenso unico
// v142: anche per il paziente creato dal nutrizionista la sintesi ha una scelta separata
const delProf = (consensi) => ({ ruolo: "paziente", professionistaUid: "P1", consensi });
assert.strictEqual(T.consensoSintesiNegato(delProf({ ai: aiSi }), "P1"), true, "9. paziente del nutrizionista con solo il consenso AI personale: sintesi bloccata");
assert.strictEqual(T.consensoSintesiNegato(delProf({ ai: { si: false, versione: "2026-11-13" }, aiNutrizionista: sintesi(true, "P1") }), "P1"), false, "10. paziente del nutrizionista con la scelta sulla sintesi: consentita, anche con l'AI personale spenta");
// Registro: revoca e nuovo consenso della sintesi dopo un ripristino
assert.deepStrictEqual(T.esitoConsensiDaRegistro([{ tipo: "revocaAINutrizionista", uid: "a" }, { tipo: "consensoAINutrizionista", uid: "a" }], "revocaAINutrizionista", "consensoAINutrizionista"), { a: "daRichiedere" }, "11");
assert.deepStrictEqual(T.esitoConsensiDaRegistro([{ tipo: "revocaAINutrizionista", uid: "a" }]), {}, "12. le voci della sintesi non toccano il consenso AI personale");
console.log("OK: 12 verifiche superate");
