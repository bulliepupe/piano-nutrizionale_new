// v148: professione e partita IVA dei professionisti: node test/partita-iva.test.js
const assert = require("assert");
const s = require("fs").readFileSync(__dirname + "/../js/app.js", "utf8");
const pick = (a, b) => s.slice(s.indexOf(a), s.indexOf(b));
const api = eval(pick("const PROFESSIONI", "function mostraErroreIn") + ";({ partitaIvaValida, qualificaComposta, PROFESSIONI })");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
ok(api.partitaIvaValida("03059830905") === "03059830905", "partita IVA reale valida");
ok(api.partitaIvaValida("IT 030 5983 0905") === "03059830905", "con IT e spazi");
ok(api.partitaIvaValida("03059830904") === null, "cifra di controllo sbagliata");
ok(api.partitaIvaValida("0305983090") === null && api.partitaIvaValida("00000000000") === null, "lunghezza sbagliata o tutti zeri");
ok(api.qualificaComposta("Dietista", " Nutrizione sportiva ") === "Dietista · Nutrizione sportiva", "qualifica con specializzazione");
ok(api.qualificaComposta("Medico", "") === "Medico", "qualifica senza specializzazione");
// le regole accettano la stessa lista di professioni dell'app
const regole = require("fs").readFileSync(__dirname + "/../firestore.rules", "utf8");
api.PROFESSIONI.forEach((p) => ok(regole.includes(`"${p}"`), "professione nelle regole: " + p));
const html = require("fs").readFileSync(__dirname + "/../index.html", "utf8");
api.PROFESSIONI.forEach((p) => ok(html.includes(`<option>${p}</option>`), "professione nel modulo: " + p));
console.log("partita-iva: " + n + " verifiche ok");
