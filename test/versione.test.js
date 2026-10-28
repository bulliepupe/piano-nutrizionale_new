/**
 * Il numero di versione mostrato nelle Impostazioni (VERSIONE_APP in js/app.js)
 * deve coincidere con CACHE_VERSION di service-worker.js.
 *   node test/versione.test.js
 */
const fs = require("fs");
const path = require("path");
const leggi = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const app = /const VERSIONE_APP = "([^"]+)"/.exec(leggi("js/app.js"));
const sw = /const CACHE_VERSION = "([^"]+)"/.exec(leggi("service-worker.js"));
if (!app || !sw || app[1] !== sw[1]) {
  console.error(`VERSIONE_APP (${app && app[1]}) e CACHE_VERSION (${sw && sw[1]}) devono coincidere`);
  process.exit(1);
}
console.log("OK: versione " + app[1]);
