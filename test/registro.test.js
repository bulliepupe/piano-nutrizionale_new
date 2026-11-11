/**
 * Registro e ripristino (v137, DPIA rev. 4 punto R9).
 * Dalla cartella dell'app: node test/registro.test.js (dopo npm install in functions)
 */
const assert = require("assert");
const path = require("path");
process.env.GCLOUD_PROJECT = "test";
const T = require("module").createRequire(path.join(__dirname, "../functions/index.js"))("./index.js")._test;
const ts = (ms) => ({ toMillis: () => ms });

// 1. Solo revoca: AI spenta
assert.deepStrictEqual(T.esitoConsensiDaRegistro([{ tipo: "revocaAI", uid: "a" }]), { a: "revocato" });
// 2. Revoca e poi nuovo consenso prima del ripristino: scelta da richiedere, AI non riattivata
assert.deepStrictEqual(T.esitoConsensiDaRegistro([{ tipo: "revocaAI", uid: "a" }, { tipo: "consensoAI", uid: "a" }]), { a: "daRichiedere" });
// 3. Revoca, consenso, revoca: vale l'ultima revoca
assert.deepStrictEqual(T.esitoConsensiDaRegistro([{ tipo: "revocaAI", uid: "a" }, { tipo: "consensoAI", uid: "a" }, { tipo: "revocaAI", uid: "a" }]), { a: "revocato" });
// 4. Solo consenso, senza revoca: nessun intervento (resta lo stato della copia ripristinata)
assert.deepStrictEqual(T.esitoConsensiDaRegistro([{ tipo: "consensoAI", uid: "b" }]), {});
// 5. Utenti diversi non si influenzano
assert.deepStrictEqual(T.esitoConsensiDaRegistro([{ tipo: "revocaAI", uid: "a" }, { tipo: "consensoAI", uid: "b" }]), { a: "revocato" });
console.log("ok consensi dopo il ripristino");

// 6-9. La manutenzione si chiude solo dopo una riapplicazione riuscita
assert.strictEqual(T.puoChiudereManutenzione({ attiva: true, quando: ts(1000) }, false), false, "senza riapplicazione resta chiusa");
assert.strictEqual(T.puoChiudereManutenzione({ attiva: true, quando: ts(1000), riapplicata: ts(500) }, false), false, "riapplicazione precedente all'inizio non vale");
assert.strictEqual(T.puoChiudereManutenzione({ attiva: true, quando: ts(1000), riapplicata: ts(2000) }, false), true);
assert.strictEqual(T.puoChiudereManutenzione({ attiva: true, quando: ts(1000) }, true), true, "forzatura esplicita");
console.log("ok chiusura della manutenzione");

// 10. Il consenso dato viene registrato, la revoca pure
const src = require("fs").readFileSync(path.join(__dirname, "../functions/index.js"), "utf8");
assert.ok(/registra\("consensoAI"/.test(src) && /registra\("revocaAI"/.test(src));
console.log("OK: 10 verifiche superate");
