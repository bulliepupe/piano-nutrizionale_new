
/**
 * firebase-config.js
 *
 * Incolla qui sotto la configurazione del TUO progetto Firebase.
 * La trovi in: Firebase Console → icona ingranaggio → "Impostazioni progetto"
 * → scorri fino a "Le tue app" → app web → "Configurazione SDK".
 *
 * Questi valori (apiKey compresa) NON sono segreti: identificano il progetto,
 * non danno accesso a nulla da soli — la sicurezza vera è nelle regole di
 * Firestore (file firestore.rules) e nell'autenticazione. È normale e sicuro
 * che compaiano nel codice pubblico dell'app, anche su un repository GitHub.
 *
 * Finché non li sostituisci con quelli reali, l'app mostra la schermata di
 * accesso ma non riuscirà a effettuare il login: è il comportamento atteso.
 */
window.FIREBASE_CONFIG = {
  apiKey: "INSERISCI_API_KEY",
  authDomain: "INSERISCI_PROGETTO.firebaseapp.com",
  projectId: "INSERISCI_PROGETTO",
  storageBucket: "INSERISCI_PROGETTO.appspot.com",
  messagingSenderId: "INSERISCI_SENDER_ID",
  appId: "INSERISCI_APP_ID",
};

/**
 * Chiave VAPID per le notifiche push (Firebase Cloud Messaging).
 * La trovi in: Firebase Console → icona ingranaggio → "Impostazioni progetto"
 * → scheda "Cloud Messaging" → sezione "Configurazione web push" →
 * "Genera coppia di chiavi" (se non esiste già una). Richiede il piano Blaze.
 */
window.FIREBASE_VAPID_KEY = "BGGiV2Vo6eDfeHzAylbMgodNeIly822CctM9QjPylsiD_yPytfxLWg1-ifz-D1BETiINk1O4Oxd73iyG2MLYbzI";
