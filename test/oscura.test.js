// Verifiche dell'oscuramento dei dati identificativi prima dell'invio all'AI: node test/oscura.test.js
const assert = require("assert");
const s = require("fs").readFileSync(__dirname + "/../functions/index.js", "utf8");
const oscura = eval("(" + s.slice(s.indexOf("function oscuraIdentificativi"), s.indexOf("const MESSAGGIO_BASE")).trim() + ")");
const casi = [
  ["chiamami al 333 123 4567", "chiamami al [telefono]"],
  ["tel. 3331234567 dopo cena", "tel. [telefono] dopo cena"],
  ["+39 02 1234 5678", "[telefono]"],
  ["scrivimi a mario.rossi@gmail.com", "scrivimi a [email]"],
  ["CF RSSMRA80A01F205X", "CF [codice fiscale]"],
  ["IBAN IT60X0542811101000000123456", "IBAN [IBAN]"],
  ["pasta 100 g e 2 uova, ore 13:30", "pasta 100 g e 2 uova, ore 13:30"],
  ["il 20/10/2026 ho fatto 45 minuti", "il 20/10/2026 ho fatto 45 minuti"],
  ['{"peso":72.4,"data":"2026-10-20","fc":[132,140,128]}', '{"peso":72.4,"data":"2026-10-20","fc":[132,140,128]}'],
  ["1500 kcal, 2.300 passi", "1500 kcal, 2.300 passi"],
];
casi.forEach(([da, atteso]) => assert.strictEqual(oscura(da), atteso, da));
console.log("OK: " + casi.length + " verifiche superate");
