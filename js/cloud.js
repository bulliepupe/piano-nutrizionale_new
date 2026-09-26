


/**
 * cloud.js
 * Livello di accesso a Firebase (Auth + Firestore). Nessun altro file
 * dell'app parla direttamente con l'SDK Firebase: passa sempre da qui,
 * tramite l'oggetto globale `window.cloud`.
 *
 * Richiede che in index.html siano già stati caricati, in ordine:
 *   firebase-app-compat.js, firebase-auth-compat.js, firebase-firestore-compat.js,
 *   poi firebase-config.js, poi questo file.
 */
(function () {
  "use strict";

  if (typeof firebase === "undefined") {
    console.error("SDK Firebase non caricato: controlla gli script in index.html");
    return;
  }

  const CONFIGURATO = window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey !== "INSERISCI_API_KEY";

  const app = firebase.initializeApp(window.FIREBASE_CONFIG);
  const auth = app.auth();
  const db = app.firestore();

  // Persistenza offline: letture disponibili anche senza connessione, con
  // sincronizzazione automatica al ritorno della rete. Fallisce silenziosamente
  // se l'app è aperta in più schede contemporaneamente (limite noto di Firestore).
  db.enablePersistence({ synchronizeTabs: true }).catch(() => {});

  // Firebase Messaging (notifiche push): non tutti i browser lo supportano
  // (es. Safari su iOS prima della 16.4) — se l'inizializzazione fallisce,
  // le notifiche push restano semplicemente non disponibili su quel
  // dispositivo, senza bloccare il resto dell'app.
  // Su iPhone il push esiste solo con iOS 16.4+ e SOLO quando l'app è aperta
  // dall'icona sulla schermata Home (non da una scheda di Safari): in tutti
  // gli altri casi isSupported() risponde false e il push resta spento.
  let messaging = null;
  try {
    const supportato = typeof firebase.messaging.isSupported === "function" ? firebase.messaging.isSupported() : true;
    if (supportato) messaging = app.messaging();
  } catch (e) {
    console.warn("Firebase Messaging non disponibile su questo browser:", e);
  }

  const FieldValue = firebase.firestore.FieldValue;

  // Firebase Storage: foto delle ricette e allegati (PDF o immagini) caricati
  // dal professionista. Se lo script non è caricato, le ricette funzionano
  // lo stesso ma senza file.
  const storage = typeof firebase.storage === "function" ? app.storage() : null;

  // Funzioni server (Cloud Functions), stessa regione della funzione dei promemoria.
  const funzioni = typeof app.functions === "function" ? app.functions("europe-west1") : null;

  window.cloud = {
    configurato: CONFIGURATO,
    pushSupportato: !!messaging,
    auth,
    db,

    // ---------------------------------------------------------------
    // Autenticazione
    // ---------------------------------------------------------------
    onAuthChange(cb) {
      return auth.onAuthStateChanged(cb);
    },

    async login(email, password) {
      const cred = await auth.signInWithEmailAndPassword(email.trim(), password);
      return cred.user;
    },

    async logout() {
      return auth.signOut();
    },

    async resetPassword(email) {
      return auth.sendPasswordResetEmail(email.trim());
    },

    /** Registrazione self-service per il professionista (dietista/nutrizionista). */
    async registraProfessionista(email, password, nome) {
      const cred = await auth.createUserWithEmailAndPassword(email.trim(), password);
      // Prova gratuita: 30 giorni, fino a 3 pazienti. È l'unica licenza che
      // l'app può scrivere da sola (lo impongono le regole Firestore); gli
      // abbonamenti pagati li scrive il server quando Stripe conferma il pagamento.
      const scadenzaProva = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await db.collection("users").doc(cred.user.uid).set({
        ruolo: "professionista",
        nome: (nome || "").trim(),
        email: email.trim().toLowerCase(),
        creato: FieldValue.serverTimestamp(),
        licenza: {
          piano: "prova",
          maxPazienti: 3,
          stato: "attiva",
          scadenza: firebase.firestore.Timestamp.fromDate(scadenzaProva),
        },
      });
      return cred.user;
    },

    /** Ascolta in tempo reale il documento utente (per vedere subito una licenza appena pagata). */
    ascoltaUtente(uid, cb) {
      return db.collection("users").doc(uid).onSnapshot(
        (doc) => cb(doc.exists ? doc.data() : null),
        (err) => { console.error("Errore ascolto utente:", err); }
      );
    },

    /** Legge il record utente (ruolo, nome, ecc.) dato l'uid. */
    async caricaUtente(uid) {
      const doc = await db.collection("users").doc(uid).get();
      return doc.exists ? doc.data() : null;
    },

    /**
     * Crea l'account e il record Firestore per un nuovo paziente. Va chiamata
     * mentre il professionista è loggato: usa l'app secondaria apposta per
     * non toccare la sessione principale. Ritorna l'uid del nuovo paziente.
     */
    /**
     * Crea un paziente (account, profilo e piano di partenza) passando dal
     * server, che verifica licenza e limite di pazienti. Ritorna
     * { pazienteUid, pianoId }.
     */
    async creaPaziente({ email, password, nome, piano }) {
      if (!funzioni) throw { code: "functions/unavailable" };
      const chiama = funzioni.httpsCallable("creaPaziente");
      const risultato = await chiama({ email, password, nome, piano });
      return risultato.data;
    },

    /**
     * Salva i dati di contatto del professionista sul suo profilo e li copia
     * su tutti i piani dei suoi pazienti (campo contattiNutrizionista): il
     * paziente non può leggere il profilo del professionista (regole di
     * sicurezza), ma può leggere il proprio piano — così vede sempre i
     * contatti aggiornati senza toccare le regole Firestore.
     */
    async salvaProfiloProfessionista(uid, contatti) {
      await db.collection("users").doc(uid).update({ contatti, nome: contatti.nome || "" });
      const snap = await db.collection("piani").where("professionistaUid", "==", uid).get();
      // Scritture a blocchi (limite Firestore: 500 operazioni per batch).
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = db.batch();
        snap.docs.slice(i, i + 400).forEach((d) => batch.update(d.ref, { contattiNutrizionista: contatti }));
        await batch.commit();
      }
      return snap.docs.length;
    },

    /**
     * Elimina definitivamente un paziente (account, dati, piano). Passa dal
     * server: dall'app non si può cancellare l'account di un'altra persona.
     */
    async eliminaPaziente(pianoId) {
      if (!funzioni) throw { code: "functions/unavailable" };
      const chiama = funzioni.httpsCallable("eliminaPaziente");
      const risultato = await chiama({ pianoId });
      return risultato.data;
    },

    /** Apre il portale clienti Stripe (abbonamento, fatture, disdetta) già autenticato. Ritorna l'indirizzo. */
    async apriPortaleClienti(ritorno) {
      if (!funzioni) throw { code: "functions/unavailable" };
      const chiama = funzioni.httpsCallable("apriPortaleClienti");
      const risultato = await chiama({ ritorno });
      return risultato.data.url;
    },

    // ---------------------------------------------------------------
    // Piani nutrizionali
    // ---------------------------------------------------------------
    /** Aggiorna (in blocco o parzialmente) un piano esistente. Solo il professionista può chiamarla. */
    async salvaPiano(pianoId, campi) {
      await db.collection("piani").doc(pianoId).update(Object.assign({}, campi, {
        aggiornato: FieldValue.serverTimestamp(),
      }));
    },

    async leggiPiano(pianoId) {
      const doc = await db.collection("piani").doc(pianoId).get();
      return doc.exists ? Object.assign({ id: doc.id }, doc.data()) : null;
    },

    /** Ascolto in tempo reale del piano attivo di UN paziente (si aggiorna da solo se il professionista lo modifica altrove). */
    ascoltaPianoPaziente(pazienteUid, cb) {
      return db.collection("piani").where("pazienteUid", "==", pazienteUid).limit(1)
        .onSnapshot(
          (snap) => cb(snap.empty ? null : Object.assign({ id: snap.docs[0].id }, snap.docs[0].data())),
          (err) => { console.error("Errore ascolto piano:", err); cb(null); }
        );
    },

    /** Elenco (in tempo reale) di tutti i piani/pazienti in carico a un professionista. */
    ascoltaPazientiProfessionista(professionistaUid, cb) {
      return db.collection("piani").where("professionistaUid", "==", professionistaUid)
        .onSnapshot(
          (snap) => cb(snap.docs.map((d) => Object.assign({ id: d.id }, d.data()))),
          (err) => { console.error("Errore ascolto pazienti:", err); cb([]); }
        );
    },

    // ---------------------------------------------------------------
    // Spunte "pasto fatto" — per paziente, per giorno (sincronizzate)
    // ---------------------------------------------------------------
    async salvaPastiFattiCloud(pazienteUid, dateKey, stato) {
      await db.collection("users").doc(pazienteUid).collection("pastiFatti").doc(dateKey).set(stato);
    },

    ascoltaPastiFattiCloud(pazienteUid, dateKey, cb) {
      return db.collection("users").doc(pazienteUid).collection("pastiFatti").doc(dateKey)
        .onSnapshot(
          (doc) => cb(doc.exists ? doc.data() : {}),
          (err) => { console.error("Errore ascolto spunte:", err); cb({}); }
        );
    },

    // ---------------------------------------------------------------
    // Notifiche push (Firebase Cloud Messaging)
    // ---------------------------------------------------------------
    /**
     * Chiede il "token" di questo dispositivo/browser e lo salva sul
     * documento utente (in un array: un paziente può avere più dispositivi).
     * Va chiamata SOLO dopo che il permesso di notifica è già stato concesso.
     * Ritorna il token salvato, o null se il push non è supportato/configurato.
     */
    async registraTokenPush(uid) {
      if (!messaging) return null;
      if (!window.FIREBASE_VAPID_KEY || window.FIREBASE_VAPID_KEY === "INSERISCI_VAPID_KEY") {
        console.warn("Chiave VAPID non configurata: le notifiche push restano disattivate.");
        return null;
      }
      const registrazioneSW = await navigator.serviceWorker.ready;
      const token = await messaging.getToken({
        vapidKey: window.FIREBASE_VAPID_KEY,
        serviceWorkerRegistration: registrazioneSW,
      });
      if (!token) return null;
      await db.collection("users").doc(uid).update({
        fcmTokens: FieldValue.arrayUnion(token),
      });
      return token;
    },

    /** Rimuove il token di questo dispositivo (es. quando l'utente disattiva i promemoria). */
    async rimuoviTokenPush(uid, token) {
      if (!token) return;
      await db.collection("users").doc(uid).update({
        fcmTokens: FieldValue.arrayRemove(token),
      });
    },

    /** Notifica ricevuta mentre l'app è aperta in primo piano (a differenza di quelle ad app chiusa, gestite dal service worker). */
    onMessaggioPrimoPiano(cb) {
      if (!messaging) return () => {};
      return messaging.onMessage(cb);
    },

    // ------------------------------------------------------------------
    // Ricette del professionista
    // Documento /ricette/{id}: professionistaUid, titolo, porzioni, tempoMin,
    // kcal e macro per porzione, etichette, ingredienti [righe], procedimento
    // [passaggi], foto {path,url}, allegato {path,url,nome,tipo}, visibilita
    // ("tutti" | "selezionati") e destinatari [uid dei pazienti].
    // I file stanno in Storage sotto ricette/{professionistaUid}/{id}/.
    // ------------------------------------------------------------------
    nuovoIdRicetta() {
      return db.collection("ricette").doc().id;
    },

    ascoltaRicetteProfessionista(professionistaUid, cb) {
      return db.collection("ricette").where("professionistaUid", "==", professionistaUid).onSnapshot(
        (snap) => cb(snap.docs.map((d) => Object.assign({ id: d.id }, d.data()))),
        (err) => { console.error("Errore ascolto ricettario:", err); cb([]); }
      );
    },

    /** Ricette visibili a un paziente: quelle per tutti + quelle scelte per lui. */
    ascoltaRicettePaziente(professionistaUid, pazienteUid, cb) {
      const perTutti = new Map(), perLui = new Map();
      let pronte = 0;
      const emetti = () => {
        if (pronte < 2) return;
        const tutte = new Map(perTutti);
        perLui.forEach((v, k) => tutte.set(k, v));
        cb(Array.from(tutte.values()));
      };
      const base = db.collection("ricette").where("professionistaUid", "==", professionistaUid);
      const ascolta = (query, mappa) => query.onSnapshot(
        (snap) => {
          mappa.clear();
          snap.docs.forEach((d) => mappa.set(d.id, Object.assign({ id: d.id }, d.data())));
          if (!mappa.__pronta) { mappa.__pronta = true; pronte++; }
          emetti();
        },
        (err) => { console.error("Errore ascolto ricette:", err); if (!mappa.__pronta) { mappa.__pronta = true; pronte++; } emetti(); }
      );
      const u1 = ascolta(base.where("visibilita", "==", "tutti"), perTutti);
      const u2 = ascolta(base.where("destinatari", "array-contains", pazienteUid), perLui);
      return () => { u1(); u2(); };
    },

    async salvaRicetta(id, dati, nuova) {
      const ref = db.collection("ricette").doc(id);
      if (nuova) {
        await ref.set(Object.assign({}, dati, { creato: FieldValue.serverTimestamp(), aggiornato: FieldValue.serverTimestamp() }));
      } else {
        await ref.update(Object.assign({}, dati, { aggiornato: FieldValue.serverTimestamp() }));
      }
    },

    async eliminaRicetta(id, percorsiFile) {
      for (const p of percorsiFile || []) {
        try { await storage.ref(p).delete(); } catch (e) { /* file già assente */ }
      }
      await db.collection("ricette").doc(id).delete();
    },

    /**
     * Carica un file di una ricetta su Storage. Ritorna { path, url }: l'url
     * è quello di download (con token), salvato nella ricetta e usato dai
     * pazienti per vedere foto e allegati.
     */
    async caricaFileRicetta(professionistaUid, ricettaId, nome, blob, tipo, suAvanzamento) {
      if (!storage) throw new Error("storage-non-disponibile");
      const pulito = String(nome || "file").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-").slice(-60);
      const path = `ricette/${professionistaUid}/${ricettaId}/${Date.now()}-${pulito}`;
      const ref = storage.ref(path);
      const task = ref.put(blob, { contentType: tipo, cacheControl: "public, max-age=31536000" });
      await new Promise((ok, ko) => task.on("state_changed",
        (s) => { if (suAvanzamento && s.totalBytes) suAvanzamento(s.bytesTransferred / s.totalBytes); },
        ko, ok));
      const url = await ref.getDownloadURL();
      return { path, url };
    },

    async eliminaFileRicetta(path) {
      if (!storage || !path) return;
      try { await storage.ref(path).delete(); } catch (e) { /* già eliminato */ }
    },

    /** Aggiunge più articoli insieme alla lista della spesa di una settimana. */
    async aggiungiArticoliSpesa(uid, docId, testi) {
      if (!testi.length) return;
      await db.collection("users").doc(uid).collection("spesa").doc(docId).set({
        extra: FieldValue.arrayUnion.apply(null, testi), aggiornato: FieldValue.serverTimestamp(),
      }, { merge: true });
    },

    // ------------------------------------------------------------------
    // Statistiche per il professionista
    // ------------------------------------------------------------------
    /** Il paziente registra l'ultima apertura dell'app (serve all'avviso di abbandono). */
    async registraAccesso(uid) {
      await db.collection("users").doc(uid).update({ ultimoAccesso: FieldValue.serverTimestamp() });
    },

    /**
     * Dati di un paziente per le statistiche (letti dal professionista):
     * il documento utente (ultimo accesso, notifiche, data di creazione) e le
     * spunte dei pasti a partire dal giorno `daGiorno` ("YYYY-MM-DD").
     */
    async leggiDatiStatistiche(pazienteUid, daGiorno) {
      const utenteRef = db.collection("users").doc(pazienteUid);
      const [utente, spunteSnap] = await Promise.all([
        utenteRef.get(),
        utenteRef.collection("pastiFatti")
          .where(firebase.firestore.FieldPath.documentId(), ">=", daGiorno)
          .get(),
      ]);
      const spunte = {};
      spunteSnap.forEach((d) => { spunte[d.id] = d.data(); });
      return { utente: utente.exists ? utente.data() : null, spunte };
    },

    // ------------------------------------------------------------------
    // Lista della spesa: spunte e articoli aggiunti a mano, sincronizzati
    // tra tutti i dispositivi del paziente. Un documento per settimana di
    // calendario (id = data del lunedì, es. "2026-09-28") più un documento
    // "preferenze" con le correzioni del paziente (categoria, nome, nascosti).
    // ------------------------------------------------------------------
    ascoltaSpesa(uid, docId, cb) {
      return db.collection("users").doc(uid).collection("spesa").doc(docId).onSnapshot(
        (doc) => cb(doc.exists ? doc.data() : {}),
        (err) => { console.error("Errore ascolto lista spesa:", err); cb({}); }
      );
    },

    async spuntaSpesa(uid, docId, chiave, spuntata) {
      await db.collection("users").doc(uid).collection("spesa").doc(docId).set({
        spuntate: spuntata ? FieldValue.arrayUnion(chiave) : FieldValue.arrayRemove(chiave),
        aggiornato: FieldValue.serverTimestamp(),
      }, { merge: true });
    },

    async azzeraSpunteSpesa(uid, docId) {
      await db.collection("users").doc(uid).collection("spesa").doc(docId).set({
        spuntate: [], aggiornato: FieldValue.serverTimestamp(),
      }, { merge: true });
    },

    async aggiungiArticoloSpesa(uid, docId, testo) {
      await db.collection("users").doc(uid).collection("spesa").doc(docId).set({
        extra: FieldValue.arrayUnion(testo), aggiornato: FieldValue.serverTimestamp(),
      }, { merge: true });
    },

    async rimuoviArticoloSpesa(uid, docId, testo) {
      await db.collection("users").doc(uid).collection("spesa").doc(docId).set({
        extra: FieldValue.arrayRemove(testo), aggiornato: FieldValue.serverTimestamp(),
      }, { merge: true });
    },

    /** Correzioni del paziente: { categoria: {chiave: idCategoria}, nome: {chiave: testo}, nascosti: [chiave] } */
    async salvaPreferenzaSpesa(uid, tipo, chiave, valore) {
      const ref = db.collection("users").doc(uid).collection("spesa").doc("preferenze");
      if (tipo === "nascosti") {
        await ref.set({ nascosti: valore ? FieldValue.arrayUnion(chiave) : FieldValue.arrayRemove(chiave) }, { merge: true });
      } else {
        await ref.set({ [tipo]: { [chiave]: valore == null ? FieldValue.delete() : valore } }, { merge: true });
      }
    },

    /**
     * Salva su Firestore gli orari dei pasti (se personalizzati) e l'anticipo
     * del promemoria: la funzione server-side che invia le notifiche push
     * legge da qui, perché non ha accesso al localStorage del telefono.
     */
    async salvaPreferenzeNotifiche(uid, { orariOverride, anticipoMinuti, notificheAttive }) {
      const campi = { notificheAttive: !!notificheAttive };
      if (orariOverride !== undefined) campi.orariOverride = orariOverride;
      if (anticipoMinuti !== undefined) campi.anticipoMinuti = anticipoMinuti;
      await db.collection("users").doc(uid).update(campi);
    },
  };
})();
