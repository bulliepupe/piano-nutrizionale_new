// v150: reclami (risposta definitiva e interlocutoria): node test/reclami.test.js
const assert = require("assert");
const T = require("../functions/index.js")._test;
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const r = { id: "abc123def456", ricevutoMs: Date.parse("2026-12-01T10:00:00Z") };
const d = T.emailRispostaReclamo(r, "definitiva", "Abbiamo verificato e corretto il problema.");
ok(/risposta al tuo reclamo/.test(d.subject) && d.text.includes("Abbiamo verificato") && d.text.includes("abc123def456"), "risposta definitiva");
const i = T.emailRispostaReclamo(r, "interlocutoria", "Stiamo verificando con il fornitore del servizio.", Date.parse("2027-01-15T10:00:00Z"));
ok(/aggiornamento/.test(i.subject) && /15 gennaio 2027/.test(i.text), "interlocutoria con la nuova data");
const s = require("fs").readFileSync(__dirname + "/../js/app.js", "utf8");
ok(s.includes('chiamaFunzione("inviaReclamo"') && s.includes("data-reclamo"), "pulsante e chiamata nell'app");
console.log("reclami: " + n + " verifiche ok");
