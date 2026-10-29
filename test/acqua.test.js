/**
 * Promemoria dell'acqua: orari tra le 10 e le 20.
 *   node test/acqua.test.js
 */
const assert = require("assert");
const path = require("path");
const req = require("module").createRequire(path.join(__dirname, "../functions/index.js"));
process.env.GCLOUD_PROJECT = "test";
const T = req("./index.js")._test;
assert.deepStrictEqual(T.orariAcqua(2), ["10:00", "12:00", "14:00", "16:00", "18:00", "20:00"]);
assert.deepStrictEqual(T.orariAcqua(3), ["10:00", "13:00", "16:00", "19:00"]);
assert.deepStrictEqual(T.orariAcqua(undefined), T.orariAcqua(2), "intervallo predefinito 2 ore");
assert.deepStrictEqual(T.orariAcqua(1), T.orariAcqua(2), "intervallo non previsto: 2 ore");
// stesso calcolo nell'app (promemoria del browser)
const fs = require("fs");
const app = fs.readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
assert.ok(/for \(let h = 10; h <= 20; h \+= passo\)/.test(app), "l'app usa gli stessi orari");
console.log("OK: 5 verifiche superate");
