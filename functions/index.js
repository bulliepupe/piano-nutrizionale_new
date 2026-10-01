

/**
 * functions/index.js
 * Cloud Function programmata: ogni 5 minuti controlla tutti i piani attivi
 * e invia una notifica push (Firebase Cloud Messaging) ai pazienti che
 * hanno le notifiche attive e per cui è il momento del promemoria — anche
 * ad app completamente chiusa. Questo è il pezzo "server" che completa i
 * promemoria locali già gestiti da js/app.js.
 *
 * IMPORTANTE — valori duplicati da tenere allineati manualmente:
 *  - CONFIG_BASE e ORARI_DEFAULT qui sotto devono restare uguali a config.json
 *    nella cartella principale del sito. Se modifichi config.json, aggiorna
 *    anche questi due oggetti e ripubblica la funzione (`firebase deploy --only functions`).
 *  - week-logic.js qui dentro è una COPIA di js/week-logic.js (i Cloud
 *    Functions vengono pubblicate solo con i file dentro functions/, non
 *    possono "vedere" il resto del repository).
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
// firebase-admin 14 accetta solo le API "modulari": il vecchio stile
// admin.firestore(), getAuth() e simili è stato rimosso.
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, FieldPath, Timestamp } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { getMessaging } = require("firebase-admin/messaging");
const weekLogic = require("./week-logic.js");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

// Regione europea: più vicina, e coerente con la posizione scelta per Firestore.
setGlobalOptions({ region: "europe-west1" });

const MEAL_KEYS = ["colazione", "spuntinoMattina", "pranzo", "spuntinoPomeriggio", "cena"];
const MEAL_LABELS = {
  colazione: "Colazione",
  spuntinoMattina: "Spuntino di metà mattina",
  pranzo: "Pranzo",
  spuntinoPomeriggio: "Spuntino pomeridiano",
  cena: "Cena",
};

// Stessi valori di config.json (vedi nota in cima al file).
// ATTENZIONE: prima c'era "2026-09-14" mentre config.json dice "2026-08-31":
// due settimane di differenza, quindi i promemoria push potevano mostrare il
// menu di un'altra settimana rispetto a quello visto nell'app. Ora allineati.
const CONFIG_BASE = {
  startDate: "2026-08-31",
  week5Months: [],
  overrideWeek: null,
};
const ORARI_DEFAULT = {
  colazione: "08:00",
  spuntinoMattina: "10:30",
  pranzo: "13:00",
  spuntinoPomeriggio: "16:30",
  cena: "20:00",
};
const ANTICIPO_DEFAULT = 15;
const FINESTRA_MINUTI = 5; // stessa cadenza dello scheduler: un solo tick "vede" ogni pasto

function chiaveData(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/**
 * Il server (Cloud Functions) gira in UTC, non in ora italiana: senza questa
 * conversione, un pasto delle 16:30 verrebbe confrontato con le 16:30 UTC,
 * cioè le 18:30 in Italia (ora legale) — promemoria sistematicamente sfasati
 * di 1-2 ore. Questa funzione costruisce un Date i cui "getter locali"
 * (getHours, getDay, getDate, ecc.) restituiscono i valori dell'ora di Roma,
 * qualunque sia il fuso orario reale del server: tutto il resto del file può
 * quindi continuare a usare i normali getHours()/setHours() come se girasse
 * su un computer impostato sull'ora italiana.
 */
function oraItaliana(adesso) {
  const parti = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(adesso);
  const get = (tipo) => Number(parti.find((p) => p.type === tipo).value);
  return new Date(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/**
 * Vero se "adesso" cade nella finestra [orario-anticipo, orario-anticipo+finestra)
 * per un pasto — cioè se è il momento di inviare il promemoria. Funzione pura,
 * testabile da sola senza bisogno di Firestore/FCM veri. Richiede che
 * `oraCorrente` sia già in ora italiana (vedi oraItaliana sopra).
 */
function pastoDaNotificareOra(oraCorrente, orarioPastoStr, anticipoMinuti, finestraMinuti) {
  if (!orarioPastoStr) return false;
  const parti = orarioPastoStr.split(":").map(Number);
  if (parti.length !== 2 || Number.isNaN(parti[0]) || Number.isNaN(parti[1])) return false;
  const orarioPasto = new Date(oraCorrente);
  orarioPasto.setHours(parti[0], parti[1], 0, 0);
  const momentoInvio = new Date(orarioPasto.getTime() - anticipoMinuti * 60000);
  const diffMinuti = (oraCorrente.getTime() - momentoInvio.getTime()) / 60000;
  return diffMinuti >= 0 && diffMinuti < finestraMinuti;
}

exports.controllaPromemoria = onSchedule(
  { schedule: "every 5 minutes", timeZone: "Europe/Rome" },
  async () => {
    const ora = oraItaliana(new Date());
    const dateKey = chiaveData(ora);

    const pianiSnap = await db.collection("piani").get();

    for (const pianoDoc of pianiSnap.docs) {
      const piano = pianoDoc.data();
      const pazienteUid = piano.pazienteUid;
      if (!pazienteUid) continue;

      const utenteRef = db.collection("users").doc(pazienteUid);
      const utenteDoc = await utenteRef.get();
      if (!utenteDoc.exists) continue;
      const utente = utenteDoc.data();

      if (!utente.notificheAttive) continue;
      const tokens = Array.isArray(utente.fcmTokens) ? utente.fcmTokens.filter(Boolean) : [];
      if (!tokens.length) continue;

      const { giorno } = weekLogic.menuDelGiorno(ora, CONFIG_BASE, piano);
      if (!giorno) continue;

      const orari = Object.assign({}, ORARI_DEFAULT, utente.orariOverride || {});
      const anticipo = typeof utente.anticipoMinuti === "number" ? utente.anticipoMinuti : ANTICIPO_DEFAULT;

      const trackingRef = db.collection("notificheInviate").doc(pazienteUid + "_" + dateKey);
      const trackingDoc = await trackingRef.get();
      const giaInviate = (trackingDoc.exists && trackingDoc.data().pasti) || [];

      for (const key of MEAL_KEYS) {
        if (giaInviate.includes(key)) continue;
        if (!pastoDaNotificareOra(ora, orari[key], anticipo, FINESTRA_MINUTI)) continue;

        const testo = giorno[key];
        if (!testo) continue;

        try {
          const titolo = `${MEAL_LABELS[key]} tra ${anticipo} minuti`;
          const risultato = await messaging.sendEachForMulticast({
            tokens,
            notification: { title: titolo, body: testo },
            // Opzioni specifiche per le notifiche web (Android e iPhone):
            //  - Urgency "high": iOS e Android la consegnano subito anche col
            //    telefono in risparmio energetico, invece di rimandarla;
            //  - TTL: se il telefono è spento/offline, dopo 30 minuti il
            //    promemoria non ha più senso e viene scartato;
            //  - tag: lo stesso usato dai promemoria locali dell'app, così
            //    eventuali doppioni si sostituiscono invece di sommarsi.
            webpush: {
              headers: { Urgency: "high", TTL: "1800" },
              notification: {
                icon: "icons/icon-192.png",
                badge: "icons/icon-192.png",
                tag: "pasto-" + titolo,
              },
            },
          });

          // Ripulisce eventuali token scaduti/disinstallati.
          const tokenDaRimuovere = [];
          risultato.responses.forEach((r, i) => {
            const codice = r.error && r.error.code;
            if (!r.success && (codice === "messaging/registration-token-not-registered" || codice === "messaging/invalid-registration-token")) {
              tokenDaRimuovere.push(tokens[i]);
            }
          });
          if (tokenDaRimuovere.length) {
            await utenteRef.update({ fcmTokens: FieldValue.arrayRemove(...tokenDaRimuovere) });
          }
        } catch (e) {
          console.error("Errore invio notifica a", pazienteUid, key, e);
          continue; // non segna come inviato: ci riprova al prossimo tick
        }

        await trackingRef.set(
          { pasti: FieldValue.arrayUnion(key), aggiornato: FieldValue.serverTimestamp() },
          { merge: true }
        );
      }
    }
  }
);

/**
 * Eliminazione definitiva di un paziente, chiamata dal pannello professionista.
 *
 * Serve una funzione "server" perché dall'app non si può cancellare l'account
 * di accesso di un'altra persona, né i suoi dati privati (spunte dei pasti,
 * dispositivi registrati): solo il server, con i permessi di amministratore,
 * può farlo. Prima di cancellare qualunque cosa verifica che:
 *  - chi chiama sia un professionista autenticato;
 *  - il piano indicato appartenga proprio a quel professionista;
 *  - l'account da cancellare sia davvero un paziente (mai un professionista).
 *
 * Cancella: account di accesso, documento utente con tutte le spunte dei
 * pasti, registro delle notifiche inviate e infine il piano. L'ordine è
 * voluto: il piano va via per ultimo, così se qualcosa si interrompe a metà
 * basta ripetere l'eliminazione dall'app e il lavoro viene completato.
 */
exports.eliminaPaziente = onCall(async (request) => {
  const uidChiamante = request.auth && request.auth.uid;
  if (!uidChiamante) throw new HttpsError("unauthenticated", "Accesso richiesto.");

  const pianoId = request.data && request.data.pianoId;
  if (typeof pianoId !== "string" || !pianoId || pianoId.includes("/")) {
    throw new HttpsError("invalid-argument", "Paziente non indicato correttamente.");
  }

  const chiamante = await db.collection("users").doc(uidChiamante).get();
  if (!chiamante.exists || chiamante.data().ruolo !== "professionista") {
    throw new HttpsError("permission-denied", "Solo un professionista può eliminare un paziente.");
  }

  const pianoRef = db.collection("piani").doc(pianoId);
  const piano = await pianoRef.get();
  if (!piano.exists) throw new HttpsError("not-found", "Paziente già eliminato o inesistente.");
  const { professionistaUid, pazienteUid } = piano.data();
  if (professionistaUid !== uidChiamante) {
    throw new HttpsError("permission-denied", "Questo paziente non è tra i tuoi.");
  }

  if (pazienteUid) {
    const utenteRef = db.collection("users").doc(pazienteUid);
    const utente = await utenteRef.get();
    if (utente.exists && utente.data().ruolo !== "paziente") {
      throw new HttpsError("permission-denied", "L'account collegato non è un paziente: eliminazione bloccata.");
    }

    // 1) Account di accesso (se era già stato cancellato, si prosegue).
    try {
      await getAuth().deleteUser(pazienteUid);
    } catch (e) {
      if (e.code !== "auth/user-not-found") throw new HttpsError("internal", "Impossibile eliminare l'account di accesso.");
    }

    // 2) Esce dalla eventuale lista di casa (gli altri membri non vedono più i suoi alimenti)
    if (utente.exists && utente.data().listaCasa) await lasciaLista(pazienteUid, utente.data().listaCasa).catch(() => {});
    // 3) Documento utente + sottoraccolte (spunte "pasto fatto").
    if (utente.exists) await db.recursiveDelete(utenteRef);

    // 4) Registro dei promemoria inviati (documenti "<uid>_<data>").
    const registro = await db.collection("notificheInviate")
      .orderBy(FieldPath.documentId())
      .startAt(pazienteUid + "_")
      .endAt(pazienteUid + "_\uf8ff")
      .get();
    for (let i = 0; i < registro.docs.length; i += 400) {
      const batch = db.batch();
      registro.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }

  // 5) Il piano, per ultimo, con misure e note dei controlli.
  await db.recursiveDelete(pianoRef);
  return { ok: true };
});

// =========================================================================
// CREAZIONE DI UN PAZIENTE (con controllo del limite della licenza)
// =========================================================================
/**
 * Crea account, profilo e piano di un nuovo paziente per il professionista
 * che la chiama. Il limite di pazienti della licenza è verificato QUI, sul
 * server: dal browser non si possono più creare profili "paziente" né piani
 * (vedi firestore.rules), quindi il limite non si può aggirare.
 *
 * Dati attesi: { nome, email, password, piano } dove piano è il piano di
 * partenza preparato dall'app (settimane, regole, dati paziente...).
 * Ritorna { pazienteUid, pianoId }.
 */
const CAMPI_PIANO_RISERVATI = ["professionistaUid", "pazienteUid", "pazienteNome", "pazienteEmail", "aggiornato", "creato"];

function statoLicenzaServer(licenza, adesso) {
  if (!licenza || licenza.stato !== "attiva") return { attiva: false, max: 0 };
  const scadenza = licenza.scadenza && typeof licenza.scadenza.toMillis === "function" ? licenza.scadenza.toMillis() : null;
  const attiva = scadenza == null || scadenza > adesso;
  return { attiva, max: Number(licenza.maxPazienti) || 0 };
}

exports.creaPaziente = onCall(async (request) => {
  const uidProf = request.auth && request.auth.uid;
  if (!uidProf) throw new HttpsError("unauthenticated", "Accesso richiesto.");

  const d = request.data || {};
  const nome = String(d.nome || "").trim().slice(0, 120);
  const email = String(d.email || "").trim().toLowerCase();
  const password = String(d.password || "");
  const piano = d.piano;
  if (!nome || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "Indica nome ed email validi.");
  }
  if (password.length < 6 || password.length > 128) {
    throw new HttpsError("invalid-argument", "La password deve avere almeno 6 caratteri.");
  }
  if (!piano || typeof piano !== "object" || Array.isArray(piano) || !piano.settimane) {
    throw new HttpsError("invalid-argument", "Piano di partenza non valido.");
  }
  if (Buffer.byteLength(JSON.stringify(piano)) > 900 * 1024) {
    throw new HttpsError("invalid-argument", "Piano di partenza troppo grande.");
  }

  const profRef = db.collection("users").doc(uidProf);
  const queryPazienti = db.collection("piani").where("professionistaUid", "==", uidProf);

  // Controllo del limite: ripetuto dentro la transazione più sotto, qui serve
  // solo a non creare l'account di accesso se la licenza non lo permette.
  const verifica = async (lettore) => {
    const prof = await lettore(profRef);
    if (!prof.exists || prof.data().ruolo !== "professionista") {
      throw new HttpsError("permission-denied", "Solo un professionista può creare pazienti.");
    }
    const lic = statoLicenzaServer(prof.data().licenza, Date.now());
    if (!lic.attiva) throw new HttpsError("failed-precondition", "licenza-non-attiva");
    const conteggio = await lettore(queryPazienti.count());
    const usati = conteggio.data().count;
    if (usati >= lic.max) throw new HttpsError("resource-exhausted", `limite-raggiunto:${lic.max}`);
    return prof.data();
  };
  await verifica((x) => x.get());

  // 1) Account di accesso
  let utente;
  try {
    utente = await getAuth().createUser({ email, password, displayName: nome });
  } catch (e) {
    if (e.code === "auth/email-already-exists") throw new HttpsError("already-exists", "email-gia-usata");
    if (e.code === "auth/invalid-email") throw new HttpsError("invalid-argument", "Email non valida.");
    if (e.code === "auth/invalid-password") throw new HttpsError("invalid-argument", "La password deve avere almeno 6 caratteri.");
    console.error("creaPaziente: creazione account", e);
    throw new HttpsError("internal", "Impossibile creare l'account di accesso.");
  }

  // 2) Profilo e piano, in una transazione che ricontrolla il limite: se due
  //    creazioni partono insieme, solo quelle che ci stanno vanno a buon fine.
  const pianoRef = db.collection("piani").doc();
  const pulito = Object.assign({}, piano);
  CAMPI_PIANO_RISERVATI.forEach((k) => delete pulito[k]);
  try {
    await db.runTransaction(async (t) => {
      await verifica((x) => t.get(x));
      t.create(db.collection("users").doc(utente.uid), {
        ruolo: "paziente",
        nome,
        email,
        professionistaUid: uidProf,
        creato: FieldValue.serverTimestamp(),
      });
      t.create(pianoRef, Object.assign(pulito, {
        professionistaUid: uidProf,
        pazienteUid: utente.uid,
        pazienteNome: nome,
        pazienteEmail: email,
        creato: FieldValue.serverTimestamp(),
        aggiornato: FieldValue.serverTimestamp(),
      }));
    });
  } catch (e) {
    // Qualcosa è andato storto: si cancella l'account appena creato, così non
    // restano accessi "orfani" senza profilo e senza piano.
    await getAuth().deleteUser(utente.uid).catch(() => {});
    if (e instanceof HttpsError) throw e;
    console.error("creaPaziente: salvataggio profilo e piano", e);
    throw new HttpsError("internal", "Impossibile salvare il nuovo paziente.");
  }

  return { pazienteUid: utente.uid, pianoId: pianoRef.id };
});

// =========================================================================
// LISTA DELLA SPESA CONDIVISA ("lista di casa")
// =========================================================================
// /liste/{id}: nome, proprietario, membri [uid], nomiMembri {uid: nome},
// codiceInvito. /liste/{id}/settimane/{lunedì}: spunte, articoli aggiunti,
// scelte e gli alimenti pubblicati da ogni paziente membro (piani.{uid}).
// /inviti/{codice}: { listaId, scade } — letto solo dal server.
// Dal browser le liste si leggono e le settimane si compilano (solo membri);
// membri e inviti li gestiscono queste funzioni.
const MAX_MEMBRI_LISTA = 6;
const GIORNI_VALIDITA_INVITO = 14;
const ALFABETO_INVITO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // niente 0/O, 1/I

function nuovoCodice() {
  let c = "";
  for (let i = 0; i < 8; i++) c += ALFABETO_INVITO[Math.floor(Math.random() * ALFABETO_INVITO.length)];
  return c;
}

async function utenteListaAmmesso(uid) {
  const snap = await db.collection("users").doc(uid).get();
  const u = snap.exists ? snap.data() : null;
  if (!u || (u.ruolo !== "paziente" && u.ruolo !== "familiare")) {
    throw new HttpsError("permission-denied", "La lista di casa è disponibile per pazienti e familiari.");
  }
  return u;
}

async function creaInvito(listaId, uid) {
  const codice = nuovoCodice();
  await db.collection("inviti").doc(codice).set({
    listaId, creatoDa: uid, scade: Timestamp.fromMillis(Date.now() + GIORNI_VALIDITA_INVITO * 86400000),
  });
  return codice;
}

/** Toglie un membro da una lista; se era l'ultimo la lista viene cancellata. */
async function lasciaLista(uid, listaId) {
  const listaRef = db.collection("liste").doc(listaId);
  let cancellare = false, codiceVecchio = null;
  await db.runTransaction(async (t) => {
    const lista = await t.get(listaRef);
    t.set(db.collection("users").doc(uid), { listaCasa: FieldValue.delete() }, { merge: true });
    if (!lista.exists) return;
    const d = lista.data();
    const membri = (d.membri || []).filter((m) => m !== uid);
    if (!membri.length) { cancellare = true; codiceVecchio = d.codiceInvito || null; return; }
    t.update(listaRef, {
      membri,
      [`nomiMembri.${uid}`]: FieldValue.delete(),
      proprietario: d.proprietario === uid ? membri[0] : d.proprietario,
      aggiornata: FieldValue.serverTimestamp(),
    });
  });
  if (cancellare) {
    await db.recursiveDelete(listaRef);
    if (codiceVecchio) await db.collection("inviti").doc(codiceVecchio).delete().catch(() => {});
    return;
  }
  // Gli alimenti che aveva pubblicato non devono restare visibili agli altri
  const settimane = await listaRef.collection("settimane").get();
  await Promise.all(settimane.docs.map((doc) => doc.ref.update({ [`piani.${uid}`]: FieldValue.delete() }).catch(() => {})));
}

exports.creaListaCasa = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const u = await utenteListaAmmesso(uid);
  if (u.listaCasa) throw new HttpsError("failed-precondition", "gia-in-lista");
  const nomeProprio = String(u.nome || "").trim().split(/\s+/)[0] || "Io";
  const nomeLista = String((request.data && request.data.nome) || "").trim().slice(0, 60) || `Spesa di casa ${nomeProprio}`;
  const listaRef = db.collection("liste").doc();
  const codice = await creaInvito(listaRef.id, uid);
  await db.runTransaction(async (t) => {
    t.create(listaRef, {
      nome: nomeLista, proprietario: uid, membri: [uid], nomiMembri: { [uid]: nomeProprio },
      codiceInvito: codice, creata: FieldValue.serverTimestamp(), aggiornata: FieldValue.serverTimestamp(),
    });
    t.set(db.collection("users").doc(uid), { listaCasa: listaRef.id }, { merge: true });
  });
  return { listaId: listaRef.id, codice };
});

exports.entraInLista = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const codice = String((request.data && request.data.codice) || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (codice.length !== 8) throw new HttpsError("invalid-argument", "codice-non-valido");
  const u = await utenteListaAmmesso(uid);
  const invito = await db.collection("inviti").doc(codice).get();
  if (!invito.exists || invito.data().scade.toMillis() < Date.now()) throw new HttpsError("not-found", "codice-non-valido");
  const listaId = invito.data().listaId;
  if (u.listaCasa === listaId) return { listaId, giaMembro: true };
  if (u.listaCasa) throw new HttpsError("failed-precondition", "gia-in-lista");
  const listaRef = db.collection("liste").doc(listaId);
  const nomeProprio = String(u.nome || "").trim().split(/\s+/)[0] || "Membro";
  let nomeLista = "";
  await db.runTransaction(async (t) => {
    const lista = await t.get(listaRef);
    if (!lista.exists) throw new HttpsError("not-found", "codice-non-valido");
    const d = lista.data();
    if ((d.membri || []).length >= MAX_MEMBRI_LISTA) throw new HttpsError("resource-exhausted", "lista-piena");
    nomeLista = d.nome;
    t.update(listaRef, {
      membri: FieldValue.arrayUnion(uid),
      [`nomiMembri.${uid}`]: nomeProprio,
      aggiornata: FieldValue.serverTimestamp(),
    });
    t.set(db.collection("users").doc(uid), { listaCasa: listaId }, { merge: true });
  });
  return { listaId, nome: nomeLista };
});

exports.esciDaLista = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const u = (await db.collection("users").doc(uid).get()).data() || {};
  if (u.listaCasa) await lasciaLista(uid, u.listaCasa);
  return { ok: true };
});

exports.rimuoviMembroLista = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const membro = String((request.data && request.data.uid) || "");
  const u = (await db.collection("users").doc(uid).get()).data() || {};
  if (!u.listaCasa) throw new HttpsError("failed-precondition", "Non fai parte di una lista.");
  const lista = await db.collection("liste").doc(u.listaCasa).get();
  if (!lista.exists || lista.data().proprietario !== uid) throw new HttpsError("permission-denied", "Solo chi ha creato la lista può togliere i membri.");
  if (!membro || membro === uid || !(lista.data().membri || []).includes(membro)) throw new HttpsError("invalid-argument", "Membro non valido.");
  await lasciaLista(membro, u.listaCasa);
  return { ok: true };
});

exports.nuovoInvitoLista = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const u = (await db.collection("users").doc(uid).get()).data() || {};
  if (!u.listaCasa) throw new HttpsError("failed-precondition", "Non fai parte di una lista.");
  const listaRef = db.collection("liste").doc(u.listaCasa);
  const lista = await listaRef.get();
  if (!lista.exists || !(lista.data().membri || []).includes(uid)) throw new HttpsError("permission-denied", "Non fai parte di questa lista.");
  const vecchio = lista.data().codiceInvito;
  const codice = await creaInvito(u.listaCasa, uid);
  await listaRef.update({ codiceInvito: codice, aggiornata: FieldValue.serverTimestamp() });
  if (vecchio) await db.collection("inviti").doc(vecchio).delete().catch(() => {});
  return { codice };
});

// =========================================================================
// IMPORTAZIONE DI UN PIANO DA DOCUMENTO (AI)
// =========================================================================
// Il browser del professionista invia solo le pagine che ha scelto, con il
// nome del paziente già oscurato (testo e immagini). Qui si controllano
// licenza e limite mensile, si chiede al modello il piano in un formato
// rigido (strumento "piano_convertito") e lo si restituisce per la
// revisione: nulla viene salvato nel piano senza la conferma del
// professionista.
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const MODELLO_IMPORTAZIONE = "claude-sonnet-5";
const LIMITE_IMPORTAZIONI_MESE = 30;
const MAX_PAGINE_IMPORTAZIONE = 12;

const CAMPI_PASTO_AI = ["colazione", "spuntinoMattina", "pranzo", "spuntinoPomeriggio", "cena", "coccola"];

const ISTRUZIONI_IMPORTAZIONE = `Sei l'assistente di importazione dell'app "Il mio Piano", usata da nutrizionisti italiani. Ricevi le pagine di un piano alimentare (immagine della pagina e testo estratto: se il testo è disordinato, come nelle tabelle, fidati dell'immagine) e lo converti nel formato dell'app chiamando lo strumento piano_convertito.

REGOLE FONDAMENTALI
- Riporta alimenti, grammature e indicazioni come sono scritti: non inventare alimenti, non cambiare quantità, non aggiungere consigli tuoi.
- Non riportare mai dati personali del paziente (nome, età, peso, altezza, misure, analisi, date di visite e appuntamenti, contatti). Nel testo il nome può comparire come "[paziente]".
- Scrivi in italiano, con frasi brevi.

I PASTI
L'app ha sei pasti al giorno: colazione, spuntinoMattina, pranzo, spuntinoPomeriggio (merenda), cena, coccola (facoltativa: spuntino serale, dolce, "al bisogno").
- Scrivi l'alimento seguito dalla quantità ("Pollo 150 g", "2 uova", "Olio EVO 10 g") e separa gli alimenti con " + ".
- Alternative: " o " nella stessa riga ("pane integrale 80 g o fette Wasa 60 g"); se le alternative sono piatti o gruppi interi, mettile su righe separate con una riga che contiene solo "o", cioè "\\no\\n".
- Quando un'alternativa è una combinazione di più alimenti (per esempio "oppure whey protein 1 scoop + latte 200 ml + frutta 200 g" in alternativa a un frullato), metti ogni combinazione su righe separate con una riga che contiene solo "o": così si capisce a cosa si riferisce ciascuna alternativa.
- Metti ogni specificazione tra parentesi subito dopo l'alimento a cui si riferisce ("Carne rossa sgrassata 150 g (filetto, tagliata) o uova o formaggi magri"), anche se nel documento è impaginata altrove.
- Esclusioni e condizioni tra parentesi, iniziando con "no" ("Frutta 200 g (no banane, fichi)"); note brevi tra parentesi.
- Pasto non previsto: "Nessuno spuntino" / "Nessuna colazione". Pasto o giornata liberi: "Pasto libero" (eventualmente "Pasto libero: pizza margherita").
- Se un pasto dice "verdura a piacere" o simili, scrivilo così. Se il documento indica quantità giornaliere comuni (per esempio olio 20 g al giorno), ripartiscile tra pranzo e cena e segnalalo negli avvisi.
- Integratori e snack pre-allenamento vanno nel pasto più vicino (di solito lo spuntino del pomeriggio).
- kcal: le calorie della giornata se il documento le indica, altrimenti null.

GIORNATE E SETTIMANE
- giornate: una voce per ogni giornata diversa del piano, con un nome ("Lunedì", "Giorno A", "Con sport", "Senza sport", "Giornata tipo").
- settimane: per ogni settimana del piano (di solito una, al massimo 5) indica quale giornata si segue da lunedì a domenica (7 nomi presi da giornate).
- Piano per giorni della settimana: una giornata per giorno. Giornate tipo (A, B, C…) o una sola giornata tipo: assegnale ai giorni in ordine e spiega negli avvisi che l'ordine è modificabile. Giornate con e senza sport: proponi i giorni di allenamento (in base al documento, altrimenti 3 giorni alterni) e aggiungi una domanda per il professionista.
- Giornata libera: tutti i pasti "Pasto libero".

REGOLE GENERALI E SOSTITUZIONI
- normeGenerali: al massimo 12 regole brevi prese dal documento (condimenti, bevande, cotture, scambi di pasti o giornate, frequenze settimanali). Escludi ricettari, tabelle educative generiche, stagionalità, FAQ e schede di allenamento.
- sostituzioni: gruppi di alimenti equivalenti, ognuno con almeno 2 opzioni scritte come "Alimento quantità" (es. "Pane integrale 88g"). Se il documento dà coefficienti di conversione (es. "pane = cereali × 1,25"), calcola le grammature partendo dalle quantità più usate nel piano, metti calcolata = true e dillo negli avvisi. Se non ci sono equivalenze, lascia l'elenco vuoto.

AVVISI E DOMANDE
- avvisi: ogni interpretazione che hai dovuto fare e ogni incoerenza del documento (es. "la tabella dice frutta ma il consiglio accanto dice crackers"), al massimo 12, una frase ciascuno.
- domande: decisioni che spettano al professionista (es. "In quali giorni si allena il paziente?"), al massimo 3.`;

const STRUMENTO_IMPORTAZIONE = {
  name: "piano_convertito",
  description: "Restituisce il piano alimentare convertito nel formato dell'app Il mio Piano.",
  input_schema: {
    type: "object",
    properties: {
      giornate: {
        type: "array",
        description: "Le giornate diverse del piano.",
        items: {
          type: "object",
          properties: {
            nome: { type: "string" },
            colazione: { type: "string" },
            spuntinoMattina: { type: "string" },
            pranzo: { type: "string" },
            spuntinoPomeriggio: { type: "string" },
            cena: { type: "string" },
            coccola: { type: "string" },
            kcal: { type: ["number", "null"] },
          },
          required: ["nome", "colazione", "spuntinoMattina", "pranzo", "spuntinoPomeriggio", "cena"],
        },
      },
      settimane: {
        type: "array",
        description: "Per ogni settimana, 7 nomi di giornata da lunedì a domenica.",
        items: { type: "array", items: { type: "string" } },
      },
      normeGenerali: { type: "array", items: { type: "string" } },
      sostituzioni: {
        type: "array",
        items: {
          type: "object",
          properties: {
            nome: { type: "string" },
            opzioni: { type: "array", items: { type: "string" } },
            calcolata: { type: "boolean" },
          },
          required: ["nome", "opzioni"],
        },
      },
      avvisi: { type: "array", items: { type: "string" } },
      domande: { type: "array", items: { type: "string" } },
    },
    required: ["giornate", "settimane", "normeGenerali", "sostituzioni", "avvisi"],
  },
};

const testoBreve = (t, max) => String(t == null ? "" : t).slice(0, max);

/** Ripulisce e limita il risultato del modello prima di mandarlo al browser. */
function normalizzaPianoAI(r) {
  const giornate = (Array.isArray(r.giornate) ? r.giornate : []).slice(0, 35).map((g, i) => {
    const out = { nome: testoBreve(g.nome || `Giornata ${i + 1}`, 60) };
    CAMPI_PASTO_AI.forEach((k) => { out[k] = testoBreve(g[k], 1500); });
    out.kcal = typeof g.kcal === "number" && g.kcal > 0 && g.kcal < 10000 ? Math.round(g.kcal) : null;
    return out;
  });
  const nomi = new Set(giornate.map((g) => g.nome));
  const settimane = (Array.isArray(r.settimane) ? r.settimane : []).slice(0, 5)
    .map((sett) => (Array.isArray(sett) ? sett : []).slice(0, 7).map((n) => (nomi.has(n) ? n : (giornate[0] ? giornate[0].nome : ""))))
    .filter((sett) => sett.length === 7);
  return {
    giornate,
    settimane: settimane.length ? settimane : (giornate.length ? [Array.from({ length: 7 }, (_, i) => giornate[i % giornate.length].nome)] : []),
    normeGenerali: (Array.isArray(r.normeGenerali) ? r.normeGenerali : []).slice(0, 12).map((x) => testoBreve(x, 400)).filter(Boolean),
    sostituzioni: (Array.isArray(r.sostituzioni) ? r.sostituzioni : []).slice(0, 15)
      .map((gr) => ({ nome: testoBreve(gr.nome, 80), opzioni: (Array.isArray(gr.opzioni) ? gr.opzioni : []).slice(0, 12).map((o) => testoBreve(o, 80)).filter(Boolean), calcolata: !!gr.calcolata }))
      .filter((gr) => gr.nome && gr.opzioni.length >= 2),
    avvisi: (Array.isArray(r.avvisi) ? r.avvisi : []).slice(0, 12).map((x) => testoBreve(x, 400)).filter(Boolean),
    domande: (Array.isArray(r.domande) ? r.domande : []).slice(0, 3).map((x) => testoBreve(x, 300)).filter(Boolean),
  };
}

exports.importaPianoAI = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 300, memory: "512MiB" }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const utenteRef = db.collection("users").doc(uid);
  const utente = (await utenteRef.get()).data() || {};
  if (utente.ruolo !== "professionista") throw new HttpsError("permission-denied", "Solo per i professionisti.");
  if (!statoLicenzaServer(utente.licenza, Date.now()).attiva) throw new HttpsError("failed-precondition", "licenza-non-attiva");

  const mese = new Date().toISOString().slice(0, 7);
  const usate = (utente.importazioniAI && utente.importazioniAI.mese === mese) ? Number(utente.importazioniAI.n) || 0 : 0;
  if (usate >= LIMITE_IMPORTAZIONI_MESE) throw new HttpsError("resource-exhausted", "limite-mensile");

  const pagine = Array.isArray(request.data && request.data.pagine) ? request.data.pagine : [];
  if (!pagine.length) throw new HttpsError("invalid-argument", "Nessuna pagina da leggere.");
  if (pagine.length > MAX_PAGINE_IMPORTAZIONE) throw new HttpsError("invalid-argument", "troppe-pagine");

  const contenuto = [];
  pagine.forEach((p, i) => {
    const img = String((p && p.immagine) || "");
    if (img && /^[A-Za-z0-9+/=]+$/.test(img.slice(0, 200)) && img.length < 3500000) {
      contenuto.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img } });
    }
    contenuto.push({ type: "text", text: `Pagina ${i + 1} — testo estratto:\n${testoBreve(p && p.testo, 12000) || "(nessun testo: usa l'immagine)"}` });
  });
  const note = testoBreve(request.data && request.data.note, 1000);
  contenuto.push({ type: "text", text: `Converti il piano di queste ${pagine.length} pagine chiamando lo strumento piano_convertito.${note ? `\nIndicazioni del professionista: ${note}` : ""}` });

  let risposta;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY.value(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODELLO_IMPORTAZIONE,
        max_tokens: 16000,
        system: ISTRUZIONI_IMPORTAZIONE,
        tools: [STRUMENTO_IMPORTAZIONE],
        tool_choice: { type: "tool", name: "piano_convertito" },
        messages: [{ role: "user", content: contenuto }],
      }),
    });
    risposta = await r.json();
    if (!r.ok) {
      console.error("Importazione AI: errore API", r.status, risposta && risposta.error && risposta.error.type);
      throw new HttpsError("unavailable", "servizio-ai-non-disponibile");
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error("Importazione AI: chiamata non riuscita", err && err.message);
    throw new HttpsError("unavailable", "servizio-ai-non-disponibile");
  }

  const blocco = (risposta.content || []).find((c) => c.type === "tool_use" && c.name === "piano_convertito");
  if (!blocco || !blocco.input) throw new HttpsError("internal", "risposta-non-valida");
  const piano = normalizzaPianoAI(blocco.input);
  if (!piano.giornate.length) throw new HttpsError("failed-precondition", "nessun-pasto-trovato");

  const uso = risposta.usage || {};
  await utenteRef.set({
    importazioniAI: { mese, n: usate + 1, ultimaIl: FieldValue.serverTimestamp() },
  }, { merge: true });
  console.log("Importazione AI completata", { uid, pagine: pagine.length, input: uso.input_tokens, output: uso.output_tokens });
  return { piano, rimaste: LIMITE_IMPORTAZIONI_MESE - usate - 1 };
});

// Esposta solo per i test automatici (Node), non usata da Firebase in produzione.

// =========================================================================
// LICENZE E PAGAMENTI (Stripe)
// =========================================================================
/**
 * Il sito vende gli abbonamenti con i "Link di pagamento" di Stripe. Quando
 * Stripe conferma un pagamento, un rinnovo, un cambio di piano o una disdetta,
 * chiama questo indirizzo (webhook). La funzione aggiorna la licenza del
 * professionista in users/{uid}.licenza, che l'app e le regole Firestore
 * usano per decidere cosa può fare.
 *
 * Il professionista viene riconosciuto dall'EMAIL usata per pagare. Se paga
 * prima di essersi registrato nell'app, la licenza resta "in attesa"
 * (collezione licenzeInAttesa) e viene applicata appena si registra con
 * quella email (funzione applicaLicenzaInAttesa più sotto).
 *
 * Chiavi segrete (mai nel codice): si impostano una volta con
 *   firebase functions:secrets:set STRIPE_SECRET_KEY
 *   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
 */
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

// Piani in vendita. La chiave è il "lookup key" del prezzo su Stripe; in
// mancanza si riconosce il piano dall'importo mensile in centesimi.
const PIANI = {
  base:   { maxPazienti: 15, importo: 900 },
  studio: { maxPazienti: 50, importo: 1900 },
};
const GIORNI_TOLLERANZA = 3; // margine dopo la data di rinnovo, per pagamenti in ritardo di qualche ora

function pianoDaPrezzo(prezzo, metadati) {
  const chiave = (metadati && metadati.piano) || (prezzo && prezzo.lookup_key) || "";
  if (PIANI[chiave]) return chiave;
  if (chiave === "oltre" && metadati && Number(metadati.maxPazienti) > 0) return "oltre";
  const importo = prezzo && prezzo.unit_amount;
  const trovato = Object.keys(PIANI).find((k) => PIANI[k].importo === importo);
  return trovato || null;
}

/** Converte un abbonamento Stripe nella licenza da salvare su Firestore. */
function licenzaDaAbbonamento(sub) {
  const voce = sub.items && sub.items.data && sub.items.data[0];
  const prezzo = voce && voce.price;
  // Il prezzo ha la precedenza: dopo un cambio di piano dal portale clienti
  // i metadati dell'abbonamento potrebbero riferirsi ancora al piano precedente.
  const metadati = Object.assign({}, sub.metadata, prezzo && prezzo.metadata);
  const piano = pianoDaPrezzo(prezzo, metadati);
  if (!piano) return null;
  const maxPazienti = piano === "oltre" ? Number(metadati.maxPazienti) : PIANI[piano].maxPazienti;
  const fine = (voce && voce.current_period_end) || sub.current_period_end;
  const attivo = ["active", "trialing", "past_due"].includes(sub.status);
  const chiuso = sub.ended_at || (sub.status === "canceled" ? (sub.canceled_at || Math.floor(Date.now() / 1000)) : null);
  return {
    piano,
    maxPazienti,
    stato: attivo ? "attiva" : "scaduta",
    // Abbonamento già chiuso (disdetta immediata o fine periodo): vale la data
    // reale di chiusura. Altrimenti fine del periodo pagato + qualche giorno
    // di tolleranza per i rinnovi pagati con qualche ora di ritardo.
    scadenza: chiuso
      ? Timestamp.fromMillis(chiuso * 1000)
      : (fine ? Timestamp.fromMillis((fine + GIORNI_TOLLERANZA * 86400) * 1000) : null),
    // Disdetta programmata: l'abbonamento resta attivo fino a questa data, poi non si rinnova.
    disdetto: !!(sub.cancel_at || sub.cancel_at_period_end),
    fineAbbonamento: sub.cancel_at
      ? Timestamp.fromMillis(sub.cancel_at * 1000)
      : (sub.cancel_at_period_end && fine ? Timestamp.fromMillis(fine * 1000) : null),
    stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    stripeSubscriptionId: sub.id,
    statoStripe: sub.status,
    aggiornata: FieldValue.serverTimestamp(),
  };
}

async function trovaProfessionista(email, customerId) {
  if (customerId) {
    const q = await db.collection("users").where("licenza.stripeCustomerId", "==", customerId).limit(1).get();
    if (!q.empty) return q.docs[0].ref;
  }
  if (email) {
    const q = await db.collection("users").where("email", "==", email.toLowerCase()).limit(5).get();
    const doc = q.docs.find((d) => d.data().ruolo === "professionista");
    if (doc) return doc.ref;
  }
  return null;
}

async function salvaLicenza(stripe, sub) {
  const licenza = licenzaDaAbbonamento(sub);
  if (!licenza) {
    console.warn("Abbonamento con prezzo non riconosciuto:", sub.id);
    return;
  }
  const customer = typeof sub.customer === "string" ? await stripe.customers.retrieve(sub.customer) : sub.customer;
  const email = (customer && customer.email || "").toLowerCase();
  const ref = await trovaProfessionista(email, licenza.stripeCustomerId);
  if (ref) {
    await ref.update({ licenza });
    console.log("Licenza aggiornata:", ref.id, licenza.piano, licenza.stato);
  } else if (email) {
    await db.collection("licenzeInAttesa").doc(email).set({ licenza, email });
    console.log("Licenza in attesa di registrazione per", email);
  }
}

exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET], cors: false },
  async (req, res) => {
    const Stripe = require("stripe");
    const stripe = new Stripe(STRIPE_SECRET_KEY.value());
    let evento;
    try {
      evento = stripe.webhooks.constructEvent(req.rawBody, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET.value());
    } catch (e) {
      console.error("Firma webhook non valida:", e.message);
      res.status(400).send("Firma non valida");
      return;
    }
    try {
      const o = evento.data.object;
      switch (evento.type) {
        case "checkout.session.completed":
          if (o.mode === "subscription" && o.subscription) {
            const sub = await stripe.subscriptions.retrieve(o.subscription, { expand: ["items.data.price"] });
            await salvaLicenza(stripe, sub);
          }
          break;
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
          await salvaLicenza(stripe, o);
          break;
        default:
          break; // altri eventi: ignorati
      }
      res.status(200).send("ok");
    } catch (e) {
      console.error("Errore gestione evento", evento.type, e);
      res.status(500).send("errore"); // Stripe ritenterà in automatico
    }
  }
);

/**
 * Apre il portale clienti di Stripe direttamente dall'app, già autenticato:
 * il professionista è già entrato con email e password, quindi non serve il
 * link via email. Restituisce l'indirizzo della sessione del portale.
 */
const RITORNI_AMMESSI = ["https://app.ilmiopiano.it/", "https://bulliepupe.github.io/", "https://ilmiopiano.it/", "https://www.ilmiopiano.it/"];

exports.apriPortaleClienti = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");

  const utente = await db.collection("users").doc(uid).get();
  const dati = utente.exists ? utente.data() : null;
  if (!dati || dati.ruolo !== "professionista") {
    throw new HttpsError("permission-denied", "Solo i professionisti hanno un abbonamento.");
  }
  const customerId = dati.licenza && dati.licenza.stripeCustomerId;
  if (!customerId) {
    throw new HttpsError("failed-precondition", "Nessun abbonamento a pagamento collegato a questo account.");
  }

  const richiesto = request.data && typeof request.data.ritorno === "string" ? request.data.ritorno : "";
  const ritorno = RITORNI_AMMESSI.some((r) => richiesto.startsWith(r)) ? richiesto : RITORNI_AMMESSI[0] + "piano-nutrizionale_new/";

  const Stripe = require("stripe");
  const stripe = new Stripe(STRIPE_SECRET_KEY.value());
  const sessione = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: ritorno, locale: "it" });
  return { url: sessione.url };
});

/** Applica una licenza pagata prima della registrazione, quando il professionista si registra. */
exports.applicaLicenzaInAttesa = onDocumentCreated("users/{uid}", async (event) => {
  const dati = event.data && event.data.data();
  if (!dati || dati.ruolo !== "professionista" || !dati.email) return;
  const attesaRef = db.collection("licenzeInAttesa").doc(dati.email.toLowerCase());
  const attesa = await attesaRef.get();
  if (!attesa.exists) return;
  await event.data.ref.update({ licenza: attesa.data().licenza });
  await attesaRef.delete();
});

if (typeof module !== "undefined") {
  module.exports._test = { pastoDaNotificareOra, chiaveData, oraItaliana, licenzaDaAbbonamento, pianoDaPrezzo, statoLicenzaServer };
}
