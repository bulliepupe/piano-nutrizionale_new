/**
 * Custodia dei dati trattati per conto del nutrizionista (accordo, sezione 8):
 * scollegamento (60 giorni), licenza cessata (avvisi a 0, 30, 60 giorni,
 * chiusura a 90), conferma del paziente per continuare da solo (90 giorni).
 * Server simulato in memoria: node test/custodia.test.js
 */
const Module = require("module");
const assert = require("assert");
const G = 86400000;
let store = {};
const DEL = { __del: true };
const NOW = { __now: true };
let ORA = Date.UTC(2026, 10, 3, 3, 30);
const ts = (m) => ({ toMillis: () => m, __ts: m });
const clone = (x) => JSON.parse(JSON.stringify(x, (k, v) => (v && v.__ts !== undefined ? { __ts: v.__ts } : v)), (k, v) => (v && v.__ts !== undefined ? ts(v.__ts) : v));
function applica(dest, dati) {
  for (const k of Object.keys(dati)) {
    const v = dati[k];
    const parti = k.split(".");
    let o = dest;
    for (const p of parti.slice(0, -1)) { o[p] = o[p] && typeof o[p] === "object" ? o[p] : {}; o = o[p]; }
    const ult = parti[parti.length - 1];
    if (v === DEL) delete o[ult];
    else if (v === NOW) o[ult] = ts(ORA);
    else o[ult] = v && typeof v === "object" && !Array.isArray(v) && v.__ts === undefined ? applica({}, v) : v;
  }
  return dest;
}
const leggi = (o, campo) => campo.split(".").reduce((x, p) => (x == null ? undefined : x[p]), o);
const valore = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : v);
function ref(path) {
  return {
    path, id: path.split("/").pop(),
    collection: (c) => col(path + "/" + c),
    async get() { return snap(path); },
    async update(d) { if (!(path in store)) throw new Error("no doc " + path); applica(store[path], d); },
    async set(d, o) { store[path] = o && o.merge ? applica(store[path] || {}, d) : applica({}, d); },
  };
}
function snap(path) { return { exists: path in store, id: path.split("/").pop(), ref: ref(path), data: () => (path in store ? store[path] : undefined) }; }
let auto = 0;
function col(path, filtri = [], lim = 0) {
  const q = {
    path,
    doc: (id) => ref(path + "/" + (id || "auto" + (++auto))),
    where: (campo, op, v) => col(path, filtri.concat([[campo, op, v]]), lim),
    limit: (n) => col(path, filtri, n),
    orderBy: () => q, startAt: () => q, endAt: () => q,
    async add(d) { const r = q.doc(); await r.set(d); return r; },
    async get() {
      const pref = path + "/";
      let docs = Object.keys(store).filter((k) => k.startsWith(pref) && !k.slice(pref.length).includes("/")).map(snap);
      for (const [campo, op, v] of filtri) {
        docs = docs.filter((d) => {
          const x = valore(leggi(d.data(), campo)); const y = valore(v);
          if (op === "==") return x === y;
          if (op === "<=") return x != null && x <= y;
          return false;
        });
      }
      if (lim) docs = docs.slice(0, lim);
      return { empty: !docs.length, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
    },
  };
  return q;
}
const db = {
  collection: (c) => col(c),
  async recursiveDelete(r) { const p = r.path; Object.keys(store).forEach((k) => { if (k === p || k.startsWith(p + "/")) delete store[k]; }); },
  batch() { const ops = []; return { set: (r, d, o) => ops.push(() => r.set(d, o)), update: (r, d) => ops.push(() => r.update(d)), delete: (r) => ops.push(() => db.recursiveDelete(r)), commit: async () => { for (const o of ops) await o(); } }; },
  async runTransaction(fn) { const ops = []; const r = await fn({ get: (x) => x.get(), update: (x, d) => ops.push(() => x.update(d)), set: (x, d, o) => ops.push(() => x.set(d, o)), create: (x, d) => ops.push(() => x.set(d)) }); for (const o of ops) await o(); return r; },
};
const fake = {
  "firebase-functions/v2/scheduler": { onSchedule: () => () => {} },
  "firebase-functions/v2/https": { onCall: (o, f) => (f || o), onRequest: () => () => {}, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } },
  "firebase-functions/v2/firestore": { onDocumentCreated: () => () => {} },
  "firebase-functions/params": { defineSecret: () => ({ value: () => "k" }), defineString: () => ({ value: () => "" }) },
  "firebase-functions/v2": { setGlobalOptions: () => {} },
  "firebase-admin/app": { initializeApp: () => {} },
  "firebase-admin/firestore": { getFirestore: () => db, FieldValue: { serverTimestamp: () => NOW, increment: (n) => n, delete: () => DEL, arrayUnion: (...a) => a, arrayRemove: () => [] }, FieldPath: { documentId: () => "id" }, Timestamp: { fromMillis: (m) => ts(m), now: () => ts(ORA) } },
  "firebase-admin/auth": { getAuth: () => ({ deleteUser: async () => {} }) }, "firebase-admin/messaging": { getMessaging: () => ({}) }, "stripe": function () { return {}; },
};
const orig = Module._load; Module._load = function (r, ...a) { return fake[r] || orig.call(this, r, ...a); };
const realNow = Date.now; Date.now = () => ORA;
const f = require(__dirname + "/../functions/index.js");
const T = f._test;
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const email = () => Object.keys(store).filter((k) => k.startsWith("mail/")).map((k) => store[k]);
const giorni = async (g) => { ORA += g * G; return T.eseguiCustodia(ORA); };

(async () => {
  // fasi
  ok(JSON.stringify(T.fasiDaEseguire(null, 0)) === '["avviso"]', "primo avviso");
  ok(JSON.stringify(T.fasiDaEseguire({ avviso: 1 }, 29)) === "[]", "niente tra 1 e 29");
  ok(JSON.stringify(T.fasiDaEseguire({ avviso: 1 }, 30)) === '["promemoria"]', "promemoria a 30");
  ok(JSON.stringify(T.fasiDaEseguire({ avviso: 1, promemoria: 1 }, 60)) === '["pazienti"]', "pazienti a 60");
  ok(JSON.stringify(T.fasiDaEseguire({ avviso: 1, promemoria: 1, pazienti: 1 }, 90)) === '["chiusura"]', "chiusura a 90");
  ok(JSON.stringify(T.fasiDaEseguire(null, 200)) === '["avviso","pazienti"]', "licenza scaduta da tempo: prima l'avviso, la chiusura mai subito");

  // --- Scollegamento volontario del paziente autonomo ---
  store = {
    "users/prof": { ruolo: "professionista", nome: "Dott.ssa Rossi", email: "rossi@x.it", licenza: { stato: "attiva", maxPazienti: 10, scadenza: ts(ORA + 300 * G) } },
    "users/pa": { ruolo: "paziente", autonomo: true, nome: "Anna", email: "anna@x.it", professionistaUid: "prof", consensi: { ai: { si: true } } },
    "piani/p1": { pazienteUid: "pa", professionistaUid: "prof", gestore: "professionista", feedbackAI: { modo: "breve" }, settimane: {} },
    "piani/p1/noteMisure/m1": { testo: "nota riservata" },
    "piani/p1/analisi/a1": { testo: "analisi" },
    "piani/p1/condivisioni/c1": { tipo: "report" },
    "piani/p1/misure/m1": { peso: 70, fonte: "studio" },
  };
  await f.scollegaNutrizionista({ auth: { uid: "pa" } });
  ok(store["piani/p1"].professionistaUid === null && store["piani/p1"].exProfessionistaUid === "prof", "scollegato, ricordato il nutrizionista");
  ok(store["piani/p1"].datiProfessionistaEntro.toMillis() === ORA + 60 * G, "cancellazione programmata a 60 giorni");
  await giorni(59);
  ok("piani/p1/noteMisure/m1" in store, "a 59 giorni le note ci sono ancora");
  await giorni(1);
  ok(!("piani/p1/noteMisure/m1" in store) && !("piani/p1/analisi/a1" in store) && !("piani/p1/condivisioni/c1" in store), "a 60 giorni note, analisi e registro cancellati");
  ok("piani/p1/misure/m1" in store && "piani/p1" in store, "piano e misure restano al paziente");
  ok(!store["piani/p1"].feedbackAI && !store["piani/p1"].datiProfessionistaEntro, "impostazioni del nutrizionista tolte");

  // --- Ricollegamento: stesso nutrizionista tiene i dati, un altro no ---
  store["piani/p1/noteMisure/m2"] = { testo: "x" };
  store["piani/p1"].professionistaUid = null; store["piani/p1"].exProfessionistaUid = "prof"; store["piani/p1"].datiProfessionistaEntro = ts(ORA + 10 * G);
  store["users/pa"].professionistaUid = undefined; delete store["users/pa"].professionistaUid;
  store["codiciStudio/ABCDEF"] = { professionistaUid: "prof" };
  await f.collegaNutrizionista({ auth: { uid: "pa" }, data: { codice: "ABCDEF" } }).catch(() => {});
  ok("piani/p1/noteMisure/m2" in store && !store["piani/p1"].datiProfessionistaEntro, "torna dallo stesso: dati conservati");
  store["piani/p1"].professionistaUid = null; store["piani/p1"].exProfessionistaUid = "prof";
  store["users/altro"] = { ruolo: "professionista", licenza: { stato: "attiva", maxPazienti: 10 } };
  store["codiciStudio/WXYZ23"] = { professionistaUid: "altro" };
  await f.collegaNutrizionista({ auth: { uid: "pa" }, data: { codice: "WXYZ23" } }).catch(() => {});
  ok(!("piani/p1/noteMisure/m2" in store), "nuovo nutrizionista: i dati del precedente non passano");
  const copie = Object.keys(store).filter((k) => /^custodiaRestituzioni\/[^/]+$/.test(k));
  ok(copie.length === 1 && store[copie[0]].exProfessionistaUid === "prof" && store[copie[0]].documenti >= 1, "copia separata per la restituzione al precedente");
  ok(Object.keys(store).some((k) => k.startsWith(copie[0] + "/noteMisure/m2")), "la copia contiene le note riservate");
  const scadenzaCopia = store[copie[0]].entro.toMillis();
  ok(scadenzaCopia > ORA && scadenzaCopia <= ORA + 60 * G, "scadenza della copia entro i 60 giorni dallo scollegamento");

  // --- Scollegati prima della v114: cancellazione programmata dalla data di scollegamento ---
  store = {
    "users/vecchio": { ruolo: "paziente", autonomo: true, scollegato: ts(ORA - 100 * G) },
    "piani/pv": { pazienteUid: "vecchio", professionistaUid: null, gestore: "paziente" },
    "piani/pv/noteMisure/n": { testo: "vecchia nota" },
    "users/mai": { ruolo: "paziente", autonomo: true },
    "piani/pm": { pazienteUid: "mai", professionistaUid: null, gestore: "paziente" },
  };
  await giorni(1);
  ok(!("piani/pv/noteMisure/n" in store), "scollegato da 100 giorni: dati cancellati alla prima esecuzione");
  ok(store["users/vecchio"].datiProfessionistaCancellati, "annotato sull'utente");
  ok(!store["piani/pm"].datiProfessionistaEntro, "mai collegato: nessuna programmazione");

  // --- Licenza cessata ---
  store = {
    "users/prof": { ruolo: "professionista", nome: "Dott.ssa Rossi", email: "rossi@x.it", licenza: { stato: "scaduta", maxPazienti: 10, scadenza: ts(ORA - G) } },
    "users/creato": { ruolo: "paziente", nome: "Bruno", email: "bruno@x.it", professionistaUid: "prof", consensi: { ai: { si: true } } },
    "piani/pc": { pazienteUid: "creato", professionistaUid: "prof", gestore: "professionista", pazienteEmail: "bruno@x.it" },
    "piani/pc/noteMisure/n": { testo: "riservata" },
    "users/auto": { ruolo: "paziente", autonomo: true, nome: "Carla", email: "carla@x.it", professionistaUid: "prof" },
    "piani/pa": { pazienteUid: "auto", professionistaUid: "prof", gestore: "professionista" },
    "piani/pa/analisi/a": { testo: "analisi" },
    "users/senza": { ruolo: "professionista", email: "s@x.it", licenza: { stato: "scaduta", scadenza: ts(ORA - 400 * G) } },
    "users/sceglie": { ruolo: "paziente", nome: "Dario", email: "dario@x.it", professionistaUid: "prof" },
    "piani/ps": { pazienteUid: "sceglie", professionistaUid: "prof", gestore: "professionista" },
    "piani/ps/noteMisure/x": { testo: "nota" },
  };
  await giorni(0);
  let m = email();
  ok(m.length === 1 && m[0].to === "rossi@x.it" && /3 pazienti/.test(m[0].message.text), "avviso al nutrizionista con i pazienti e la data");
  ok(!store["users/senza"].custodia, "nutrizionista senza pazienti: nessun avviso");
  const inizio = ORA;
  await giorni(29); ok(email().length === 1, "nessun'altra email prima dei 30 giorni");
  await giorni(1); ok(email().length === 2 && /promemoria/.test(email()[1].message.subject), "promemoria a 30 giorni");
  // rinnovo e nuova scadenza: si riparte da capo
  store["users/prof"].licenza = { stato: "attiva", maxPazienti: 10, scadenza: ts(ORA + 10 * G) };
  await giorni(1); ok(!store["users/prof"].custodia, "licenza rinnovata: custodia azzerata");
  store["users/prof"].licenza = { stato: "scaduta", maxPazienti: 10, scadenza: ts(ORA - G) };
  await giorni(1);
  const ripartenza = ORA;
  ok(store["users/prof"].custodia.cessata.toMillis() === ripartenza, "nuova cessazione, termini da oggi");
  await giorni(60);
  m = email().filter((e) => e.to !== "rossi@x.it");
  ok(m.length >= 2 && m.some((e) => e.to === "bruno@x.it" && /accetta i Termini/.test(e.message.text)) && m.some((e) => e.to === "carla@x.it" && /restano tuoi/.test(e.message.text)), "avviso ai pazienti a 60 giorni, testi diversi");
  ok("piani/pc/noteMisure/n" in store, "a 60 giorni nulla di cancellato");
  ok(store["users/creato"].sceltaFineLicenza && store["users/creato"].sceltaFineLicenza.entro.toMillis() === ripartenza + 90 * G, "paziente creato: scelta offerta durante la chiusura, fino ai 90 giorni");
  ok(!store["users/auto"].sceltaFineLicenza, "autonomo: nessuna scelta da fare");
  // --- Conferma durante la chiusura: continua da solo ---
  await assert.rejects(f.confermaContinuaDaSolo({ auth: { uid: "sceglie" }, data: { consensi: { maggiorenne: true } } }), /consensi-mancanti/); n++;
  await f.confermaContinuaDaSolo({ auth: { uid: "sceglie" }, data: { consensi: { maggiorenne: true, salute: true, ai: true } } });
  ok(store["users/sceglie"].autonomo === true && !store["users/sceglie"].sceltaFineLicenza && store["users/sceglie"].consensi.ai.si === true && store["users/sceglie"].consensi.ai.versione === "2026-11-05", "sceglie di continuare: autonomo con i suoi consensi");
  ok(Object.keys(store).filter((k) => k.startsWith("users/sceglie/consensiStorico/")).length === 3, "consensi nello storico");
  ok(T.consensoAINegato(store["users/sceglie"]) === false, "AI disponibile con il consenso nuovo");
  await giorni(30);
  ok(!("users/creato" in store) && !("piani/pc" in store), "a 90 giorni il paziente creato che non ha scelto viene cancellato");
  ok(store["piani/pa"].professionistaUid === null && !("piani/pa/analisi/a" in store), "autonomo: scollegato e dati del nutrizionista cancellati");
  ok(store["users/sceglie"] && store["users/sceglie"].autonomo === true && !store["users/sceglie"].professionistaUid && !store["users/sceglie"].sceltaFineLicenza, "chi ha scelto di continuare resta, scollegato");
  ok(store["piani/ps"] && store["piani/ps"].professionistaUid === null && !("piani/ps/noteMisure/x" in store), "il suo piano resta, senza i dati del nutrizionista");

  // --- Licenza rinnovata durante la chiusura: la scelta offerta si toglie ---
  store["users/prof2"] = { ruolo: "professionista", email: "p2@x.it", licenza: { stato: "attiva", maxPazienti: 10, scadenza: ts(ORA + 30 * G) }, custodia: { cessata: ts(ORA - 61 * G), avviso: ts(ORA), pazienti: ts(ORA) } };
  store["users/inattesa"] = { ruolo: "paziente", professionistaUid: "prof2", sceltaFineLicenza: { da: "prof2", entro: ts(ORA + 29 * G) } };
  await giorni(0);
  ok(!store["users/inattesa"].sceltaFineLicenza && !store["users/prof2"].custodia, "licenza rinnovata: niente più scelta né custodia");

  // --- Copie per la restituzione scadute ---
  store["custodiaRestituzioni/r1"] = { exProfessionistaUid: "x", entro: ts(ORA - G) };
  store["custodiaRestituzioni/r1/noteMisure/a"] = { testo: "t" };
  await giorni(0);
  ok(!("custodiaRestituzioni/r1" in store) && !("custodiaRestituzioni/r1/noteMisure/a" in store), "copia scaduta cancellata");

  // --- Revoca del consenso AI: riscontri e analisi cancellati ---
  store["users/rev"] = { ruolo: "paziente", autonomo: true, consensi: { ai: { si: true, versione: "2026-11-05" } } };
  store["users/rev/riscontri/2026-11-05_pranzo"] = { impatto: "lieve" };
  store["piani/prev"] = { pazienteUid: "rev", professionistaUid: null };
  store["piani/prev/analisi/a1"] = { testo: "analisi" };
  store["piani/prev/misure/m1"] = { peso: 70 };
  const esitoRevoca = await f.aggiornaConsensoAI({ auth: { uid: "rev" }, data: { si: false } });
  ok(esitoRevoca.cancellati === true && !("users/rev/riscontri/2026-11-05_pranzo" in store) && !("piani/prev/analisi/a1" in store), "revoca: riscontri e analisi cancellati");
  ok("piani/prev/misure/m1" in store && store["users/rev"].consensi.ai.si === false, "revoca: il resto resta, scelta registrata");

  // --- Senza conferma entro 90 giorni (vecchie richieste): account cancellato ---
  store["users/zeta"] = { ruolo: "paziente", nome: "Zeta", confermaRichiesta: { motivo: "fine-licenza", entro: ts(ORA + 90 * G) } };
  store["piani/pz"] = { pazienteUid: "zeta", professionistaUid: null, gestore: "paziente" };
  await giorni(89); ok("users/zeta" in store, "a 89 giorni c'è ancora");
  await giorni(1); ok(!("users/zeta" in store) && !("piani/pz" in store), "a 90 giorni account e piano cancellati");
  ok("users/sceglie" in store, "chi ha confermato resta");

  // --- Codici di invito scaduti ---
  store = {
    "liste/l1": { nome: "Casa", proprietario: "x", membri: ["x"], codiceInvito: "VECCHIO1" },
    "inviti/VECCHIO1": { listaId: "l1", creatoDa: "x", scade: ts(ORA - G) },
    "liste/l2": { nome: "Casa 2", proprietario: "y", membri: ["y"], codiceInvito: "NUOVO123" },
    "inviti/NUOVO123": { listaId: "l2", creatoDa: "y", scade: ts(ORA + 5 * G) },
  };
  const es = await giorni(0);
  ok(!("inviti/VECCHIO1" in store) && !store["liste/l1"].codiceInvito, "invito scaduto cancellato e tolto dalla lista");
  ok("inviti/NUOVO123" in store && store["liste/l2"].codiceInvito === "NUOVO123", "invito valido intatto");
  ok(es.invitiScaduti === 1, "conteggio degli inviti scaduti");

  Date.now = realNow;
  console.log("OK: " + n + " verifiche superate");
})().catch((e) => { console.error(e); process.exit(1); });
