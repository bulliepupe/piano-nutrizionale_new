



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
  // App Firebase secondaria, usata SOLO per creare l'account del nuovo paziente:
  // firebase.auth().createUserWithEmailAndPassword effettua sempre il login
  // automatico con l'utente appena creato — usando un'app separata evitiamo che
  // questo disconnetta la sessione del professionista sull'app principale.
  const secondaryApp = firebase.initializeApp(window.FIREBASE_CONFIG, "Secondaria");

  const auth = app.auth();
  const secondaryAuth = secondaryApp.auth();
  const db = app.firestore();
  // Firestore "legato" all'app secondaria: usato SOLO per scrivere il
  // documento users/{uid} del nuovo paziente mentre è ancora autenticato
  // come se stesso (subito dopo la creazione, prima del signOut). Le regole
  // di sicurezza permettono a un utente di creare solo il proprio documento
  // — passando dall'app secondaria questo resta vero anche quando è il
  // professionista a creare l'account per lui.
  const secondaryDb = secondaryApp.firestore();

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
    async creaPaziente({ email, password, nome, professionistaUid }) {
      const cred = await secondaryAuth.createUserWithEmailAndPassword(email.trim(), password);
      const nuovoUid = cred.user.uid;

      // Scritto tramite secondaryDb MENTRE è ancora autenticato come il
      // nuovo paziente (non ancora disconnesso): è l'unico modo per
      // rispettare la regola "solo l'utente stesso può creare il proprio
      // documento" anche quando è il professionista ad avviare la creazione.
      await secondaryDb.collection("users").doc(nuovoUid).set({
        ruolo: "paziente",
        nome: (nome || "").trim(),
        email: email.trim(),
        professionistaUid,
        creato: FieldValue.serverTimestamp(),
      });

      await secondaryAuth.signOut();
      return nuovoUid;
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

    // ---------------------------------------------------------------
    // Piani nutrizionali
    // ---------------------------------------------------------------
    /** Crea un nuovo piano in cloud per un paziente. Ritorna l'id del documento. */
    async creaPiano(pianoData, professionistaUid, pazienteUid, pazienteNome, pazienteEmail) {
      const ref = db.collection("piani").doc();
      await ref.set(Object.assign({}, pianoData, {
        professionistaUid,
        pazienteUid,
        pazienteNome: pazienteNome || "",
        pazienteEmail: pazienteEmail || "",
        aggiornato: FieldValue.serverTimestamp(),
      }));
      return ref.id;
    },

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
