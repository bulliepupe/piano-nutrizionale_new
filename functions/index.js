

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

      // Pasti già segnati oggi (fatto, in parte o saltato): letti solo se
      // c'è davvero un promemoria da mandare, una volta per paziente.
      let segnati = null;

      for (const key of MEAL_KEYS) {
        if (giaInviate.includes(key)) continue;
        if (!pastoDaNotificareOra(ora, orari[key], anticipo, FINESTRA_MINUTI)) continue;

        const testo = giorno[key];
        if (!testo) continue;

        // Il paziente ha già segnato questo pasto: niente promemoria.
        if (segnati === null) {
          const fattiDoc = await utenteRef.collection("pastiFatti").doc(dateKey).get();
          segnati = fattiDoc.exists ? (fattiDoc.data() || {}) : {};
        }
        if (segnati[key]) continue;

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
    // Il paziente si era registrato da solo: il professionista non può
    // cancellargli l'account, lo scollega soltanto (resta autonomo con il piano).
    if (utente.exists && utente.data().autonomo) {
      await scollegaPazienteDalProfessionista(pazienteUid, pianoRef);
      return { ok: true, scollegato: true };
    }
  }

  await cancellaDatiPaziente(pazienteUid, pianoRef);
  return { ok: true };
});

/**
 * Cancella tutto ciò che riguarda un paziente: account di accesso, eventuale
 * lista di casa, documento utente con sottoraccolte, registro dei promemoria
 * e infine il piano (con misure e note). Usata dal professionista
 * (eliminaPaziente) e dal paziente stesso (eliminaAccount).
 */
async function cancellaDatiPaziente(pazienteUid, pianoRef) {
  if (pazienteUid) {
    const utenteRef = db.collection("users").doc(pazienteUid);
    const utente = await utenteRef.get();

    // 1) Account di accesso (se era già stato cancellato, si prosegue).
    try {
      await getAuth().deleteUser(pazienteUid);
    } catch (e) {
      if (e.code !== "auth/user-not-found") throw new HttpsError("internal", "Impossibile eliminare l'account di accesso.");
    }

    // 2) Esce dalla eventuale lista di casa (gli altri membri non vedono più i suoi alimenti)
    if (utente.exists && utente.data().listaCasa) await lasciaLista(pazienteUid, utente.data().listaCasa).catch(() => {});
    // 3) Documento utente + sottoraccolte (spunte "pasto fatto", spesa, riscontri).
    if (utente.exists) await db.recursiveDelete(utenteRef);

    // 4) Registro dei promemoria inviati (documenti "<uid>_<data>").
    await cancellaRegistroNotifiche(pazienteUid);
  }

  // 5) Il piano, per ultimo, con misure e note dei controlli.
  if (pianoRef) await db.recursiveDelete(pianoRef);
}

async function cancellaRegistroNotifiche(uid) {
  const registro = await db.collection("notificheInviate")
    .orderBy(FieldPath.documentId())
    .startAt(uid + "_")
    .endAt(uid + "_\uf8ff")
    .get();
  for (let i = 0; i < registro.docs.length; i += 400) {
    const batch = db.batch();
    registro.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

/** Il paziente autonomo torna a gestire da solo il proprio piano. */
async function scollegaPazienteDalProfessionista(pazienteUid, pianoRef) {
  await db.runTransaction(async (t) => {
    t.update(db.collection("users").doc(pazienteUid), { professionistaUid: FieldValue.delete(), scollegato: FieldValue.serverTimestamp() });
    t.update(pianoRef, { professionistaUid: null, gestore: "paziente", aggiornato: FieldValue.serverTimestamp() });
  });
}

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
const CAMPI_PIANO_RISERVATI = ["professionistaUid", "pazienteUid", "pazienteNome", "pazienteEmail", "aggiornato", "creato", "gestore"];

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
        gestore: "professionista",
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
// PAZIENTE AUTONOMO E PREMIUM
// =========================================================================
// Il paziente può registrarsi da solo dall'app ("autonomo"): in quel caso è
// lui il gestore del proprio piano (piani/{id}.gestore = "paziente"). Può
// collegarsi a un nutrizionista con il codice studio: il nutrizionista
// diventa gestore dello STESSO piano (gestore = "professionista") e lo
// ritrova con tutto lo storico. Se si scollega torna gestore lui.
//
// Premium (importazione AI, consigli AI sui pasti e le altre funzioni a
// pagamento) è attivo se:
//   - il paziente è seguito da un nutrizionista con licenza attiva, oppure
//   - ha un abbonamento attivo (users/{uid}.premium, stato "attivo"), oppure
//   - è nei 14 giorni di prova (stato "prova").
// users/{uid}.premium lo scrive SOLO il server: { stato, origine,
// provaIniziata, scadenza }. La prova parte una sola volta, quando il primo
// piano viene caricato (importazione AI o inserimento a mano + avviaProva).
const GIORNI_PROVA = 14;
const LIMITE_IMPORTAZIONI_PAZIENTE_MESE = 10;
const ALFABETO_CODICE_STUDIO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // niente 0/O, 1/I

function millisDi(t) {
  if (t == null) return null;
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t === "number") return t;
  return null;
}

/**
 * Stato Premium di un paziente. licenzaProf è la licenza del suo
 * nutrizionista (o null se non è seguito). Ritorna
 * { attivo, origine: "nutrizionista"|"prova"|"abbonamento"|null, scadenza, provaUsata }.
 */
function statoPremiumServer(premium, licenzaProf, adesso) {
  const provaUsata = !!(premium && premium.provaIniziata);
  if (licenzaProf && statoLicenzaServer(licenzaProf, adesso).attiva) {
    return { attivo: true, origine: "nutrizionista", scadenza: null, provaUsata };
  }
  if (premium && (premium.stato === "attivo" || premium.stato === "prova")) {
    const scadenza = millisDi(premium.scadenza);
    if (scadenza == null || scadenza > adesso) {
      return { attivo: true, origine: premium.stato === "prova" ? "prova" : "abbonamento", scadenza, provaUsata };
    }
  }
  return { attivo: false, origine: null, scadenza: null, provaUsata };
}

async function statoPremiumPaziente(utente, adesso) {
  let licenzaProf = null;
  if (utente && utente.professionistaUid) {
    const prof = await db.collection("users").doc(utente.professionistaUid).get();
    licenzaProf = prof.exists ? prof.data().licenza || null : null;
  }
  return statoPremiumServer(utente && utente.premium, licenzaProf, adesso);
}

function nuovaProva(adesso) {
  return {
    stato: "prova",
    origine: "prova",
    provaIniziata: Timestamp.fromMillis(adesso),
    scadenza: Timestamp.fromMillis(adesso + GIORNI_PROVA * 86400000),
  };
}

/** Vero se almeno un pasto di almeno una settimana è compilato. */
function pianoHaContenuto(piano) {
  const settimane = (piano && piano.settimane) || {};
  return Object.values(settimane).some((giorni) => Array.isArray(giorni) && giorni.some((g) =>
    g && CAMPI_PASTO_AI.some((k) => typeof g[k] === "string" && g[k].trim().length > 1)));
}

function codiceStudioValido(c) {
  return typeof c === "string" && /^[A-HJ-NP-Z2-9]{6}$/.test(c);
}

function nuovoCodiceStudio() {
  let c = "";
  for (let i = 0; i < 6; i++) c += ALFABETO_CODICE_STUDIO[Math.floor(Math.random() * ALFABETO_CODICE_STUDIO.length)];
  return c;
}

async function pianoDelPaziente(uid) {
  const snap = await db.collection("piani").where("pazienteUid", "==", uid).limit(1).get();
  return snap.empty ? null : snap.docs[0];
}

/**
 * Registrazione del paziente autonomo. L'app crea prima l'account di accesso
 * (email e password), poi chiama questa funzione che crea profilo e piano.
 * Dati attesi: { nome, piano } (piano = piano di partenza, anche vuoto).
 */
exports.registraPaziente = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const d = request.data || {};
  const nome = String(d.nome || "").trim().slice(0, 120);
  const email = String((request.auth.token && request.auth.token.email) || "").toLowerCase();
  if (!nome) throw new HttpsError("invalid-argument", "Indica il tuo nome.");
  if (!email) throw new HttpsError("invalid-argument", "Account senza email.");
  const piano = d.piano && typeof d.piano === "object" && !Array.isArray(d.piano) ? d.piano : { settimane: {} };
  if (Buffer.byteLength(JSON.stringify(piano)) > 900 * 1024) {
    throw new HttpsError("invalid-argument", "Piano di partenza troppo grande.");
  }

  const utenteRef = db.collection("users").doc(uid);
  const pianoRef = db.collection("piani").doc();
  const pulito = Object.assign({ settimane: {} }, piano);
  CAMPI_PIANO_RISERVATI.forEach((k) => delete pulito[k]);
  delete pulito.feedbackAI;
  await db.runTransaction(async (t) => {
    const esistente = await t.get(utenteRef);
    if (esistente.exists) throw new HttpsError("already-exists", "profilo-esistente");
    t.create(utenteRef, { ruolo: "paziente", nome, email, autonomo: true, creato: FieldValue.serverTimestamp() });
    t.create(pianoRef, Object.assign(pulito, {
      professionistaUid: null,
      gestore: "paziente",
      pazienteUid: uid,
      pazienteNome: nome,
      pazienteEmail: email,
      creato: FieldValue.serverTimestamp(),
      aggiornato: FieldValue.serverTimestamp(),
    }));
  });
  return { pianoId: pianoRef.id };
});

/** Stato Premium del paziente che la chiama (per mostrarlo nell'app). */
exports.statoPremium = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const utente = (await db.collection("users").doc(uid).get()).data() || {};
  if (utente.ruolo !== "paziente") return { attivo: false, origine: null, scadenza: null, provaUsata: false };
  return statoPremiumPaziente(utente, Date.now());
});

/**
 * Avvia la prova di 14 giorni quando il paziente autonomo ha salvato a mano
 * il suo primo piano. Una sola volta per account; se è già Premium o la prova
 * è già stata usata non cambia nulla.
 */
exports.avviaProva = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const utenteRef = db.collection("users").doc(uid);
  const adesso = Date.now();
  return db.runTransaction(async (t) => {
    const snap = await t.get(utenteRef);
    const utente = snap.data() || {};
    if (utente.ruolo !== "paziente" || !utente.autonomo) throw new HttpsError("permission-denied", "Solo per i pazienti registrati dall'app.");
    if (utente.premium && utente.premium.provaIniziata) return statoPremiumServer(utente.premium, null, adesso);
    const pianoSnap = await t.get(db.collection("piani").where("pazienteUid", "==", uid).limit(1));
    if (pianoSnap.empty || !pianoHaContenuto(pianoSnap.docs[0].data())) throw new HttpsError("failed-precondition", "piano-vuoto");
    const prova = nuovaProva(adesso);
    t.update(utenteRef, { premium: prova });
    return statoPremiumServer(prova, null, adesso);
  });
});

/** Codice studio del professionista (lo crea la prima volta). */
exports.codiceStudio = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const profRef = db.collection("users").doc(uid);
  const prof = (await profRef.get()).data() || {};
  if (prof.ruolo !== "professionista") throw new HttpsError("permission-denied", "Solo per i professionisti.");
  if (codiceStudioValido(prof.codiceStudio)) return { codice: prof.codiceStudio };
  for (let tentativo = 0; tentativo < 8; tentativo++) {
    const codice = nuovoCodiceStudio();
    const codiceRef = db.collection("codiciStudio").doc(codice);
    try {
      await db.runTransaction(async (t) => {
        const c = await t.get(codiceRef);
        if (c.exists) throw new Error("occupato");
        t.create(codiceRef, { professionistaUid: uid, creato: FieldValue.serverTimestamp() });
        t.update(profRef, { codiceStudio: codice });
      });
      return { codice };
    } catch (e) {
      if (e.message !== "occupato") throw e;
    }
  }
  throw new HttpsError("internal", "Impossibile creare il codice studio, riprova.");
});

/**
 * Il paziente autonomo si collega al nutrizionista con il codice studio. Il
 * nutrizionista diventa gestore dello stesso piano; il paziente conta nella
 * sua licenza.
 */
exports.collegaNutrizionista = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const codice = String((request.data && request.data.codice) || "").trim().toUpperCase();
  if (!codiceStudioValido(codice)) throw new HttpsError("invalid-argument", "codice-non-valido");

  const codiceSnap = await db.collection("codiciStudio").doc(codice).get();
  if (!codiceSnap.exists) throw new HttpsError("not-found", "codice-non-trovato");
  const profUid = codiceSnap.data().professionistaUid;
  const profRef = db.collection("users").doc(profUid);
  const utenteRef = db.collection("users").doc(uid);
  const queryPazienti = db.collection("piani").where("professionistaUid", "==", profUid);

  const nomeStudio = await db.runTransaction(async (t) => {
    const [utenteSnap, profSnap] = await Promise.all([t.get(utenteRef), t.get(profRef)]);
    const utente = utenteSnap.data() || {};
    if (utente.ruolo !== "paziente" || !utente.autonomo) throw new HttpsError("permission-denied", "Solo per i pazienti registrati dall'app.");
    if (utente.professionistaUid) throw new HttpsError("failed-precondition", "gia-collegato");
    const prof = profSnap.data() || {};
    if (prof.ruolo !== "professionista") throw new HttpsError("not-found", "codice-non-trovato");
    const lic = statoLicenzaServer(prof.licenza, Date.now());
    if (!lic.attiva) throw new HttpsError("failed-precondition", "licenza-nutrizionista-non-attiva");
    const usati = (await t.get(queryPazienti.count())).data().count;
    if (usati >= lic.max) throw new HttpsError("resource-exhausted", "limite-nutrizionista");
    const pianoSnap = await t.get(db.collection("piani").where("pazienteUid", "==", uid).limit(1));
    if (pianoSnap.empty) throw new HttpsError("failed-precondition", "nessun-piano");
    t.update(utenteRef, { professionistaUid: profUid, collegato: FieldValue.serverTimestamp() });
    t.update(pianoSnap.docs[0].ref, { professionistaUid: profUid, gestore: "professionista", aggiornato: FieldValue.serverTimestamp() });
    return prof.nome || prof.studio || "";
  });
  return { ok: true, nutrizionista: nomeStudio };
});

/** Il paziente autonomo si scollega dal nutrizionista e torna gestore del piano. */
exports.scollegaNutrizionista = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const utente = (await db.collection("users").doc(uid).get()).data() || {};
  if (utente.ruolo !== "paziente" || !utente.autonomo) throw new HttpsError("permission-denied", "Solo per i pazienti registrati dall'app.");
  if (!utente.professionistaUid) return { ok: true };
  const piano = await pianoDelPaziente(uid);
  if (!piano) throw new HttpsError("failed-precondition", "nessun-piano");
  await scollegaPazienteDalProfessionista(uid, piano.ref);
  return { ok: true };
});

/**
 * Eliminazione dell'account da parte dell'utente stesso (obbligatoria per gli
 * store). Paziente: tutti i dati, piano compreso. Familiare: esce dalla lista
 * e viene cancellato. Per il professionista non è ancora disponibile qui
 * (ha pazienti e abbonamento da chiudere): scrive a info@ilmiopiano.it.
 */
exports.eliminaAccount = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const utenteRef = db.collection("users").doc(uid);
  const utenteSnap = await utenteRef.get();
  const utente = utenteSnap.data() || {};
  if (utente.ruolo === "professionista") throw new HttpsError("failed-precondition", "professionista");
  if (utente.ruolo === "paziente") {
    const piano = await pianoDelPaziente(uid);
    await cancellaDatiPaziente(uid, piano ? piano.ref : null);
    return { ok: true };
  }
  // Familiare (o profilo incompleto)
  try {
    await getAuth().deleteUser(uid);
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw new HttpsError("internal", "Impossibile eliminare l'account di accesso.");
  }
  if (utente.listaCasa) await lasciaLista(uid, utente.listaCasa).catch(() => {});
  if (utenteSnap.exists) await db.recursiveDelete(utenteRef);
  await cancellaRegistroNotifiche(uid);
  return { ok: true };
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
  const adesso = Date.now();
  let limiteMese = LIMITE_IMPORTAZIONI_MESE;
  if (utente.ruolo === "professionista") {
    if (!statoLicenzaServer(utente.licenza, adesso).attiva) throw new HttpsError("failed-precondition", "licenza-non-attiva");
  } else if (utente.ruolo === "paziente" && utente.autonomo) {
    // Paziente autonomo: importa nel proprio piano, solo se ne è il gestore.
    const pianoDoc = await pianoDelPaziente(uid);
    if (!pianoDoc || pianoDoc.data().gestore !== "paziente") throw new HttpsError("permission-denied", "piano-del-nutrizionista");
    const premium = await statoPremiumPaziente(utente, adesso);
    if (!premium.attivo) {
      // La prima importazione avvia la prova di 14 giorni; dopo serve Premium.
      if (premium.provaUsata) throw new HttpsError("failed-precondition", "premium-richiesto");
      await utenteRef.update({ premium: nuovaProva(adesso) });
    }
    limiteMese = LIMITE_IMPORTAZIONI_PAZIENTE_MESE;
  } else {
    throw new HttpsError("permission-denied", "Funzione non disponibile per questo account.");
  }

  const mese = new Date().toISOString().slice(0, 7);
  const usate = (utente.importazioniAI && utente.importazioniAI.mese === mese) ? Number(utente.importazioniAI.n) || 0 : 0;
  if (usate >= limiteMese) throw new HttpsError("resource-exhausted", "limite-mensile");

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
  return { piano, rimaste: limiteMese - usate - 1 };
});

// =========================================================================
// RISCONTRO AI SUI PASTI NON COME DA PIANO
// =========================================================================
// Quando il paziente segna un pasto come fatto diversamente, in parte o
// saltato, l'app chiede un riscontro: impatto stimato e, se il nutrizionista
// lo consente, piccoli aggiustamenti sui pasti rimasti della giornata, scelti
// tra gli alimenti del piano. Il telefono invia solo quale pasto: stato,
// motivo, nota e piano si leggono qui. Al modello non arrivano dati
// identificativi. Limiti fissi: mai digiuni, pasti saltati, tagli drastici o
// attività fisica come compensazione.
const MODELLO_RISCONTRO = "claude-haiku-4-5-20251001";
const LIMITE_RISCONTRI_GIORNO = 8;
const STATI_NON_COME_PIANO = { diverso: "fatto diversamente dal piano", parziale: "fatto solo in parte", saltato: "saltato" };
const MOTIVI_RISCONTRO = {
  nonFinito: "non l'ha finito", cambiato: "ha cambiato qualcosa", fuori: "ha mangiato fuori casa", fame: "non aveva fame",
  tempo: "non ha avuto tempo", altroPiatto: "ha mangiato altro", noAlimenti: "non aveva gli alimenti", alimentiCambiati: "ha cambiato alimenti", altro: "altro",
};
const RE_SUGGERIMENTO_VIETATO = /digiun|salta(re|lo|la|te)?\b|non mangiare|niente (colazione|pranzo|cena|merenda|spuntino)|elimina (il|la|lo) (pasto|cena|pranzo)|attivit[aà] fisic|allenament|camminat|\bcorsa\b|palestra|bruci|compens|purg|vomit|lassativ/i;
const RE_SUGGERIMENTO_VUOTO = /(niente|nulla|non) (da )?cambia|così com'è|va bene così|resta invariat|^\s*(mantieni|continua con|segui) (il|la|lo) (piano|cena|pranzo|spuntino|merenda|colazione)( del piano| come previst[oa])?\s*[.:,]?\s*(la|il|è)?\b(?!.*\b(scegli|aggiungi|preferisci|al posto|invece)\b)/i;
const MESSAGGIO_BASE = "Un pasto diverso dal previsto non compromette il percorso: al prossimo pasto riparti dal piano.";

const ISTRUZIONI_RISCONTRO = `Sei l'assistente dell'app "Il mio Piano", usata dai pazienti di un nutrizionista. Il paziente ha segnato un pasto come non svolto come da piano. Dai un riscontro breve, rassicurante e pratico chiamando lo strumento riscontro_pasto.

COSA FARE
- Stima l'impatto sulla giornata rispetto al pasto previsto: "irrilevante", "lieve", "moderato" o "rilevante". Un singolo pasto diverso è quasi sempre irrilevante, lieve o moderato.
- "irrilevante" quando la variazione è uno scambio equivalente: stesso gruppo alimentare e quantità simile, anche se i valori differiscono di poco. Esempi: mela al posto dei frutti di bosco, mandorle al posto delle noci, merluzzo al posto dell'orata, riso, farro o pasta integrale al posto dell'orzo o della pasta, tacchino al posto del pollo, oppure un alimento presente nelle sostituzioni approvate dal nutrizionista. In questo caso: stima breve che lo dica (es. "Pasta integrale al posto dell'orzo: valori nutrizionali simili"), spiegazione vuota o di una frase, nessun suggerimento, e un messaggio che confermi soltanto che va bene così (es. "Va bene così: prosegui con il piano."). Non dire di "tornare" o "riprendere" il piano: con uno scambio equivalente il paziente non ne è mai uscito.
- stima: una frase con l'effetto principale in termini semplici e approssimati (es. "Circa 25-30 g di proteine in meno del previsto", "Circa 250 kcal in più, soprattutto zuccheri"). Usa "circa": sono stime, non misure.
- spiegazione: una o due frasi su cosa significa per la giornata, senza allarmismi.
- suggerimenti (al massimo 2, solo se richiesti e solo se servono davvero): piccoli aggiustamenti sui PASTI RIMASTI di oggi, che chiedano di fare qualcosa di diverso o di scegliere un'opzione precisa del piano; se per un pasto non c'è nulla da cambiare, non citarlo. Mai suggerimenti del tipo "niente cambia" o "va bene così com'è". Non ridurre mai le porzioni di proteine (carne, pesce, uova, legumi, latticini) né di verdura: saziano e sostengono il piano. Se serve alleggerire, agisci su carboidrati aggiunti e condimenti (pane, cracker, olio oltre il previsto, opzione più ricca) o scegli l'alternativa più leggera prevista dal piano. Usa solo alimenti già presenti nel piano del giorno, nelle sostituzioni o nelle indicazioni del nutrizionista. Esempi: aggiungere una fonte proteica del piano allo spuntino; scegliere la verdura al posto del pane a cena; preferire l'opzione più leggera tra quelle del piano.
- messaggio: UNA frase breve (al massimo 25 parole), sobria e incoraggiante, che ricordi che si riparte dal piano. Niente esclamazioni né complimenti enfatici ("Perfetto!", "scelta intelligente", "esattamente quello che serviva").
- Non parlare della frequenza degli scostamenti: ci pensa l'app.

LIMITI INVIOLABILI
- Mai suggerire digiuni, pasti saltati, riduzioni oltre circa un quarto di un pasto, eliminazione di gruppi alimentari, attività fisica per "compensare", lassativi o qualsiasi comportamento compensatorio.
- Non dare indicazioni mediche, non cambiare il piano, non introdurre alimenti estranei al piano.
- Tono non giudicante: niente colpe, niente parole come "sgarro" o "errore".
- Scrivi in italiano, rivolgendoti al paziente con il "tu".`;

const STRUMENTO_RISCONTRO = {
  name: "riscontro_pasto",
  description: "Riscontro sul pasto non svolto come da piano.",
  input_schema: {
    type: "object",
    properties: {
      impatto: { type: "string", enum: ["irrilevante", "lieve", "moderato", "rilevante"] },
      stima: { type: "string" },
      spiegazione: { type: "string" },
      suggerimenti: {
        type: "array",
        items: {
          type: "object",
          properties: { pasto: { type: "string", enum: MEAL_KEYS }, testo: { type: "string" } },
          required: ["pasto", "testo"],
        },
      },
      messaggio: { type: "string" },
    },
    required: ["impatto", "stima", "spiegazione", "suggerimenti", "messaggio"],
  },
};

/** Ripulisce il riscontro: solo pasti rimasti, niente suggerimenti vietati, testi brevi. */
function normalizzaRiscontro(r, rimanenti, conSuggerimenti) {
  // Accorcia senza troncare a metà frase: si ferma all'ultima frase intera
  const breve = (t, max) => {
    const x = String(t == null ? "" : t).replace(/\s+/g, " ").trim();
    if (x.length <= max) return x;
    const taglio = x.slice(0, max);
    const fine = Math.max(taglio.lastIndexOf(". "), taglio.lastIndexOf("! "), taglio.lastIndexOf("? "));
    if (fine > max * 0.4) return taglio.slice(0, fine + 1);
    return taglio.slice(0, taglio.lastIndexOf(" ")).replace(/[,;:–-]\s*$/, "") + "…";
  };
  const impatto = r.impatto === "nessuno" ? "irrilevante" : ["irrilevante", "lieve", "moderato", "rilevante"].includes(r.impatto) ? r.impatto : "lieve";
  // variazione irrilevante: mai aggiustamenti
  const suggerimenti = !conSuggerimenti || impatto === "irrilevante" ? [] : (Array.isArray(r.suggerimenti) ? r.suggerimenti : [])
    .filter((x) => x && rimanenti.includes(x.pasto) && x.testo && !RE_SUGGERIMENTO_VIETATO.test(x.testo) && !RE_SUGGERIMENTO_VUOTO.test(x.testo))
    .slice(0, 2).map((x) => ({ pasto: x.pasto, testo: breve(x.testo, 300) }));
  let messaggio = breve(r.messaggio, 240);
  if (!messaggio || RE_SUGGERIMENTO_VIETATO.test(messaggio)) messaggio = impatto === "irrilevante" ? "Va benissimo così: continua con il piano." : MESSAGGIO_BASE;
  let spiegazione = breve(r.spiegazione, 420);
  if (RE_SUGGERIMENTO_VIETATO.test(spiegazione)) spiegazione = "";
  return { impatto, stima: breve(r.stima, 200), spiegazione, suggerimenti, messaggio };
}

exports.valutaVariazione = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60 }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const pasto = String((request.data && request.data.pasto) || "");
  if (!MEAL_KEYS.includes(pasto)) throw new HttpsError("invalid-argument", "Pasto non valido.");

  const utenteRef = db.collection("users").doc(uid);
  const utente = (await utenteRef.get()).data() || {};
  if (utente.ruolo !== "paziente") throw new HttpsError("permission-denied", "Solo per i pazienti.");
  if (!(await statoPremiumPaziente(utente, Date.now())).attivo) throw new HttpsError("failed-precondition", "premium-richiesto");
  const pianiSnap = await db.collection("piani").where("pazienteUid", "==", uid).limit(1).get();
  if (pianiSnap.empty) throw new HttpsError("failed-precondition", "nessun-piano");
  const piano = pianiSnap.docs[0].data();
  const impostazioni = piano.feedbackAI || {};
  const modo = ["spento", "riscontro", "suggerimenti"].includes(impostazioni.modo) ? impostazioni.modo : "suggerimenti";
  if (modo === "spento") return { spento: true };

  const ora = oraItaliana(new Date());
  const dateKey = chiaveData(ora);
  const fatti = ((await utenteRef.collection("pastiFatti").doc(dateKey).get()).data()) || {};
  const stato = fatti[pasto];
  if (!STATI_NON_COME_PIANO[stato]) throw new HttpsError("failed-precondition", "pasto-non-segnato");

  const riscontriRef = utenteRef.collection("riscontri");
  const giaOggi = await riscontriRef.where("data", "==", dateKey).get();
  if (giaOggi.size >= LIMITE_RISCONTRI_GIORNO) throw new HttpsError("resource-exhausted", "limite-giornaliero");

  const { giorno } = weekLogic.menuDelGiorno(ora, CONFIG_BASE, piano);
  if (!giorno) throw new HttpsError("failed-precondition", "nessun-piano");
  const indice = MEAL_KEYS.indexOf(pasto);
  const rimanenti = MEAL_KEYS.slice(indice + 1).filter((k) => !fatti[k] && giorno[k] && !/pasto libero/i.test(giorno[k]));
  const conSuggerimenti = modo === "suggerimenti" && rimanenti.length > 0;

  // Scostamenti frequenti: più di 5 pasti non come da piano negli ultimi 7 giorni
  let scostamenti = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(ora); d.setDate(d.getDate() - i);
    const f = i === 0 ? fatti : (((await utenteRef.collection("pastiFatti").doc(chiaveData(d)).get()).data()) || {});
    MEAL_KEYS.forEach((k) => { if (STATI_NON_COME_PIANO[f[k]]) scostamenti++; });
  }
  const frequente = scostamenti > 5;

  const motivo = fatti.motivi && MOTIVI_RISCONTRO[fatti.motivi[pasto]];
  const nota = fatti.note && fatti.note[pasto] ? String(fatti.note[pasto]).slice(0, 200) : "";
  const sostituzioni = (Array.isArray(piano.sostituzioni) ? piano.sostituzioni : []).slice(0, 12)
    .map((g) => `${g.nome}: ${(g.opzioni || []).join(", ")}`).join("\n");
  const testo = [
    `Pasto: ${MEAL_LABELS[pasto]}`,
    `Previsto dal piano: ${String(giorno[pasto]).slice(0, 800)}`,
    `Com'è andato: ${STATI_NON_COME_PIANO[stato]}${motivo ? ` (motivo: ${motivo})` : ""}${nota ? `. Il paziente scrive: "${nota}"` : ""}`,
    "",
    rimanenti.length ? "Pasti rimasti di oggi:\n" + rimanenti.map((k) => `- ${MEAL_LABELS[k]} [${k}]: ${String(giorno[k]).slice(0, 600)}`).join("\n") : "Non ci sono altri pasti oggi: niente suggerimenti per oggi, solo il riscontro e il ritorno al piano da domani.",
    giorno.kcal ? `Calorie previste per la giornata: circa ${giorno.kcal} kcal.` : "",
    sostituzioni ? `\nSostituzioni approvate dal nutrizionista:\n${sostituzioni}` : "",
    impostazioni.indicazioni ? `\nIndicazioni del nutrizionista per questi casi: ${String(impostazioni.indicazioni).slice(0, 600)}` : "",
    "",
    conSuggerimenti ? "Suggerimenti richiesti: sì, al massimo 2, solo sui pasti rimasti." : "Suggerimenti richiesti: no, lascia l'elenco vuoto.",
  ].filter((x) => x !== "").join("\n");

  let risposta;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY.value(), "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODELLO_RISCONTRO, max_tokens: 1200, system: ISTRUZIONI_RISCONTRO,
        tools: [STRUMENTO_RISCONTRO], tool_choice: { type: "tool", name: "riscontro_pasto" },
        messages: [{ role: "user", content: testo }],
      }),
    });
    risposta = await r.json();
    if (!r.ok) {
      console.error("Riscontro AI: errore API", r.status, risposta && risposta.error && risposta.error.type);
      throw new HttpsError("unavailable", "servizio-ai-non-disponibile");
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError("unavailable", "servizio-ai-non-disponibile");
  }
  const blocco = (risposta.content || []).find((c) => c.type === "tool_use" && c.name === "riscontro_pasto");
  if (!blocco || !blocco.input) throw new HttpsError("internal", "risposta-non-valida");
  const riscontro = Object.assign(normalizzaRiscontro(blocco.input, rimanenti, conSuggerimenti), { data: dateKey, pasto, stato, frequente });
  await riscontriRef.doc(`${dateKey}_${pasto}`).set(Object.assign({}, riscontro, { creato: FieldValue.serverTimestamp() }));
  return riscontro;
});

// =========================================================================
// ANALISI AI DELL'ANDAMENTO DEL PAZIENTE (per il professionista)
// =========================================================================
// All'apertura della scheda Andamento l'app invia un riassunto dei dati del
// paziente (aderenza, pasti non come da piano, riscontri, peso, uso
// dell'app), senza nome né dati identificativi, con la sua "impronta". Il
// risultato si salva in /piani/{id}/analisi/ultima, leggibile solo dal
// professionista: se i dati non cambiano, l'app mostra quello salvato.
const MODELLO_ANALISI = "claude-sonnet-5";
const LIMITE_ANALISI_GIORNO = 80;

const ISTRUZIONI_ANALISI = `Sei l'assistente di un nutrizionista che usa l'app "Il mio Piano". Ricevi i dati di andamento di un suo paziente (ultimi 30 giorni circa) e prepari per il professionista una lettura sintetica e utile, chiamando lo strumento analisi_andamento.

COME VALUTARE
- valutazione: "verde" se il paziente segue il piano con regolarità e gli scostamenti sono pochi o di scarso impatto; "giallo" se ci sono segnali da tenere d'occhio (aderenza in calo, scostamenti moderati ricorrenti su un pasto, uso dell'app discontinuo); "rosso" se conviene contattarlo (aderenza bassa, scostamenti rilevanti frequenti, pasti saltati ricorrenti, app non usata da giorni).
- Valuta il peso degli scostamenti: gli scambi equivalenti o irrilevanti non sono un problema; conta la frequenza di quelli moderati e rilevanti e i pasti su cui si concentrano.
- Se i dati sono pochi (piano iniziato da pochi giorni, poche segnalazioni), dillo e sii prudente.
- Basati solo sui dati ricevuti: non inventare, non fare diagnosi, non dare indicazioni cliniche al posto del professionista.

COSA SCRIVERE (in italiano, rivolto al professionista, tono professionale e concreto)
- titolo: una frase breve che riassume (es. "Segue bene il piano, cena più difficile nel weekend").
- sintesi: 2-3 frasi sull'andamento generale.
- impattoScostamenti: una frase sul peso degli scostamenti (quanti e di che impatto, su quali pasti).
- puntiAttenzione: fino a 4 punti brevi e specifici; puntiForza: fino a 3 punti brevi.
- azione: una frase con l'azione suggerita al professionista (es. "Contattalo per capire le difficoltà a cena" oppure "Nessuna azione necessaria: conferma al prossimo controllo").
- contattare: true se suggerisci di contattarlo prima del prossimo controllo.
- messaggio: solo se contattare è true, una bozza breve (al massimo 5 righe) che il professionista può inviare al paziente: tono caldo, non giudicante, dando del tu, senza nome e senza firma. Altrimenti stringa vuota.`;

const STRUMENTO_ANALISI = {
  name: "analisi_andamento",
  description: "Lettura dell'andamento del paziente per il professionista.",
  input_schema: {
    type: "object",
    properties: {
      valutazione: { type: "string", enum: ["verde", "giallo", "rosso"] },
      titolo: { type: "string" },
      sintesi: { type: "string" },
      impattoScostamenti: { type: "string" },
      puntiAttenzione: { type: "array", items: { type: "string" } },
      puntiForza: { type: "array", items: { type: "string" } },
      azione: { type: "string" },
      contattare: { type: "boolean" },
      messaggio: { type: "string" },
    },
    required: ["valutazione", "titolo", "sintesi", "impattoScostamenti", "puntiAttenzione", "puntiForza", "azione", "contattare", "messaggio"],
  },
};

function normalizzaAnalisi(r) {
  const breve = (t, max) => {
    const x = String(t == null ? "" : t).replace(/[ \t]+/g, " ").trim();
    if (x.length <= max) return x;
    const taglio = x.slice(0, max);
    const fine = Math.max(taglio.lastIndexOf(". "), taglio.lastIndexOf("! "), taglio.lastIndexOf("? "));
    return fine > max * 0.4 ? taglio.slice(0, fine + 1) : taglio.slice(0, taglio.lastIndexOf(" ")) + "…";
  };
  const elenco = (a, n, max) => (Array.isArray(a) ? a : []).map((x) => breve(x, max)).filter(Boolean).slice(0, n);
  const contattare = !!r.contattare;
  return {
    valutazione: ["verde", "giallo", "rosso"].includes(r.valutazione) ? r.valutazione : "giallo",
    titolo: breve(r.titolo, 140),
    sintesi: breve(r.sintesi, 600),
    impattoScostamenti: breve(r.impattoScostamenti, 300),
    puntiAttenzione: elenco(r.puntiAttenzione, 4, 200),
    puntiForza: elenco(r.puntiForza, 3, 200),
    azione: breve(r.azione, 240),
    contattare,
    messaggio: contattare ? breve(r.messaggio, 700) : "",
  };
}

exports.analizzaAndamento = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120 }, async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const pianoId = String((request.data && request.data.pianoId) || "");
  const dati = request.data && request.data.dati;
  const impronta = String((request.data && request.data.impronta) || "").slice(0, 64);
  if (!pianoId || !dati || typeof dati !== "object") throw new HttpsError("invalid-argument", "Dati mancanti.");

  const utenteRef = db.collection("users").doc(uid);
  const utente = (await utenteRef.get()).data() || {};
  if (utente.ruolo !== "professionista") throw new HttpsError("permission-denied", "Solo per i professionisti.");
  if (!statoLicenzaServer(utente.licenza, Date.now()).attiva) throw new HttpsError("failed-precondition", "licenza-non-attiva");
  const pianoRef = db.collection("piani").doc(pianoId);
  const piano = (await pianoRef.get()).data();
  if (!piano || piano.professionistaUid !== uid) throw new HttpsError("permission-denied", "Paziente non tuo.");

  const oggi = new Date().toISOString().slice(0, 10);
  const usate = (utente.analisiAI && utente.analisiAI.data === oggi) ? Number(utente.analisiAI.n) || 0 : 0;
  if (usate >= LIMITE_ANALISI_GIORNO) throw new HttpsError("resource-exhausted", "limite-giornaliero");

  const testo = JSON.stringify(dati).slice(0, 14000);
  let risposta;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY.value(), "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODELLO_ANALISI, max_tokens: 1500, system: ISTRUZIONI_ANALISI,
        tools: [STRUMENTO_ANALISI], tool_choice: { type: "tool", name: "analisi_andamento" },
        messages: [{ role: "user", content: `Dati di andamento del paziente (JSON):\n${testo}` }],
      }),
    });
    risposta = await r.json();
    if (!r.ok) {
      console.error("Analisi AI: errore API", r.status, risposta && risposta.error && risposta.error.type);
      throw new HttpsError("unavailable", "servizio-ai-non-disponibile");
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError("unavailable", "servizio-ai-non-disponibile");
  }
  const blocco = (risposta.content || []).find((c) => c.type === "tool_use" && c.name === "analisi_andamento");
  if (!blocco || !blocco.input) throw new HttpsError("internal", "risposta-non-valida");
  const analisi = Object.assign(normalizzaAnalisi(blocco.input), { impronta, creata: Date.now() });
  await pianoRef.collection("analisi").doc("ultima").set(Object.assign({}, analisi, { aggiornata: FieldValue.serverTimestamp() }));
  await utenteRef.set({ analisiAI: { data: oggi, n: usate + 1 } }, { merge: true });
  return analisi;
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
  module.exports._test = { statoPremiumServer, pianoHaContenuto, codiceStudioValido, nuovoCodiceStudio, normalizzaAnalisi, normalizzaRiscontro, pastoDaNotificareOra, chiaveData, oraItaliana, licenzaDaAbbonamento, pianoDaPrezzo, statoLicenzaServer };
}
