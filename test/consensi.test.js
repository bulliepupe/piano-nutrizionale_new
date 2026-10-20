// Verifiche dei consensi del paziente (server simulato): node test/consensi.test.js
const Module = require("module");
const store = {};
const TS = "TS";
function ref(path) { return { path, id: path.split("/").pop(), collection: (c) => col(path + "/" + c),
  async get() { return { exists: path in store, data: () => store[path] }; } }; }
let auto = 0;
function col(path) { return { doc: (id) => ref(path + "/" + (id || ("auto" + (++auto)))), where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }), get: async () => ({ empty: true, docs: [], forEach() {} }) }) }; }
function merge(a, b) { for (const k in b) { if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) && a[k] && typeof a[k] === "object") merge(a[k], b[k]); else a[k] = b[k]; } return a; }
const db = { collection: (c) => col(c), getAll: async (...r) => Promise.all(r.map((x) => x.get())),
  batch: () => { const ops = []; return { set: (r, d, o) => ops.push([r, d, o]), update: (r, d) => ops.push([r, d, { merge: true }]), commit: async () => ops.forEach(([r, d, o]) => { store[r.path] = o && o.merge ? merge(store[r.path] || {}, JSON.parse(JSON.stringify(d))) : JSON.parse(JSON.stringify(d)); }) }; },
  runTransaction: async (fn) => { const ops = []; await fn({ get: (r) => r.get(), create: (r, d) => ops.push([r, d]), set: (r, d) => ops.push([r, d]) }); ops.forEach(([r, d]) => { store[r.path] = JSON.parse(JSON.stringify(d)); }); } };
const fake = {
  "firebase-functions/v2/scheduler": { onSchedule: () => () => {} },
  "firebase-functions/v2/https": { onCall: (o, f) => (f || o), onRequest: () => () => {}, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } },
  "firebase-functions/v2/firestore": { onDocumentCreated: () => () => {} },
  "firebase-functions/params": { defineSecret: () => ({ value: () => "k" }), defineString: () => ({ value: () => "" }) },
  "firebase-functions/v2": { setGlobalOptions: () => {} },
  "firebase-admin/app": { initializeApp: () => {} },
  "firebase-admin/firestore": { getFirestore: () => db, FieldValue: { serverTimestamp: () => TS, increment: (n) => n, delete: () => null, arrayUnion: (...a) => a, arrayRemove: () => [] }, FieldPath: { documentId: () => "id" }, Timestamp: { fromMillis: (m) => ({ toMillis: () => m }), now: () => ({}) } },
  "firebase-admin/auth": { getAuth: () => ({}) }, "firebase-admin/messaging": { getMessaging: () => ({}) }, "stripe": function () { return {}; },
};
const orig = Module._load; Module._load = function (r, ...a) { return fake[r] || orig.call(this, r, ...a); };
let chiamateAI = 0; global.fetch = async () => { chiamateAI++; return { ok: true, json: async () => ({ content: [] }) }; };
const f = require(__dirname + "/../functions/index.js");
const assert = require("assert");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
(async () => {
  await assert.rejects(f.registraPaziente({ auth: { uid: "a", token: { email: "a@x.it" } }, data: { nome: "A" } }), /consensi-mancanti/); n++;
  await assert.rejects(f.registraPaziente({ auth: { uid: "a", token: { email: "a@x.it" } }, data: { nome: "A", consensi: { maggiorenne: true, salute: false } } }), /consensi-mancanti/); n++;
  await f.registraPaziente({ auth: { uid: "b", token: { email: "b@x.it" } }, data: { nome: "B", consensi: { maggiorenne: true, salute: true, ai: false } } });
  ok(store["users/b"].consensi.ai.si === false && store["users/b"].consensi.salute.si === true, "consensi salvati");
  ok(Object.keys(store).filter((k) => k.startsWith("users/b/consensiStorico")).length === 3, "storico alla registrazione");
  store["users/b"].premium = { stato: "prova", scadenza: { toMillis: () => Date.now() + 1e9 } };
  await assert.rejects(f.stimaMacro({ auth: { uid: "b" }, data: { testi: ["Pasta 70g al pomodoro"] } }), /consenso-ai-negato/); n++;
  await assert.rejects(f.valutaVariazione({ auth: { uid: "b" }, data: { pasto: "pranzo" } }), /consenso-ai-negato/); n++;
  await assert.rejects(f.stimaRese({ auth: { uid: "b" }, data: { nomi: ["riso"] } }), /consenso-ai-negato/); n++;
  ok(chiamateAI === 0, "nessuna chiamata ad Anthropic senza consenso");
  await f.aggiornaConsensoAI({ auth: { uid: "b" }, data: { si: true } });
  ok(store["users/b"].consensi.ai.si === true && store["users/b"].consensi.salute.si === true, "consenso AI attivato, salute invariato");
  ok(Object.keys(store).filter((k) => k.startsWith("users/b/consensiStorico")).length === 4, "storico del cambio");
  await f.stimaMacro({ auth: { uid: "b" }, data: { testi: ["Pasta 70g al pomodoro"] } });
  ok(chiamateAI === 1, "AI di nuovo disponibile");
  console.log("OK: " + n + " verifiche superate");
})().catch((e) => { console.error(e); process.exit(1); });
