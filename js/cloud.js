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

  // Persistenza offline: letture disponibili anche senza connessione, con
  // sincronizzazione automatica al ritorno della rete. Fallisce silenziosamente
  // se l'app è aperta in più schede contemporaneamente (limite noto di Firestore).
  db.enablePersistence({ synchronizeTabs: true }).catch(() => {});

  const FieldValue = firebase.firestore.FieldValue;

  window.cloud = {
    configurato: CONFIGURATO,
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
      await db.collection("users").doc(cred.user.uid).set({
        ruolo: "professionista",
        nome: (nome || "").trim(),
        email: email.trim(),
        creato: FieldValue.serverTimestamp(),
      });
      return cred.user;
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
      await secondaryAuth.signOut();

      await db.collection("users").doc(nuovoUid).set({
        ruolo: "paziente",
        nome: (nome || "").trim(),
        email: email.trim(),
        professionistaUid,
        creato: FieldValue.serverTimestamp(),
      });
      return nuovoUid;
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
  };
})();
