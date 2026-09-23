
/**
 * service-worker.js
 * Cache "app shell" per il funzionamento offline (una volta aperta almeno
 * una volta con connessione) + gestione del tap sulle notifiche + notifiche
 * push ricevute mentre l'app è completamente chiusa (Firebase Cloud Messaging).
 *
 * Se aggiorni i file dell'app, alza CACHE_VERSION per forzare il
 * refresh della cache sui dispositivi già installati.
 *
 * IMPORTANTE: la configurazione Firebase qui sotto va tenuta allineata a
 * quella in js/firebase-config.js — un service worker gira in un contesto
 * separato dalla pagina e non può leggere window.FIREBASE_CONFIG, quindi
 * questi valori vanno incollati anche qui (non sono comunque segreti).
 */

const CACHE_VERSION = "v14";
const CACHE_NAME = "piano-nutrizionale-" + CACHE_VERSION;

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./config.json",
  "./css/style.css",
  "./js/data.js",
  "./js/week-logic.js",
  "./js/firebase-config.js",
  "./js/cloud.js",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((nomi) =>
      Promise.all(nomi.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Strategia: rete prima (per avere sempre dati/aspetto aggiornati quando
// c'è connessione), con fallback alla cache quando offline.
// Importante: si occupa SOLO delle richieste verso questo stesso sito.
// Le chiamate verso Firebase (login, Firestore in tempo reale, i font Google)
// vanno dritte in rete — intercettarle romperebbe l'autenticazione e la
// sincronizzazione live del piano.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((risposta) => {
        const copia = risposta.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        return risposta;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match("./index.html")))
  );
});

// Porta l'app in primo piano quando si tocca una notifica.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((elenco) => {
      for (const client of elenco) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./index.html");
    })
  );
});

// ---------------------------------------------------------------------
// Notifiche push ad app chiusa (Firebase Cloud Messaging)
// ---------------------------------------------------------------------
try {
  importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");

  // Stessi valori di js/firebase-config.js — vedi nota in cima al file.
  firebase.initializeApp({
    apiKey: "INSERISCI_API_KEY",
    authDomain: "INSERISCI_PROGETTO.firebaseapp.com",
    projectId: "INSERISCI_PROGETTO",
    storageBucket: "INSERISCI_PROGETTO.appspot.com",
    messagingSenderId: "INSERISCI_SENDER_ID",
    appId: "INSERISCI_APP_ID",
  });

  const messaging = firebase.messaging();

  // Con "notification" payload (quello usato dalla funzione server) il
  // browser mostra già da solo la notifica ad app chiusa: questo handler
  // serve soprattutto da rete di sicurezza e per un eventuale payload "data".
  if (messaging) {
    messaging.onBackgroundMessage((payload) => {
      const n = payload.notification || {};
      self.registration.showNotification(n.title || "Promemoria", {
        body: n.body || "",
        icon: "./icons/icon-192.png",
        badge: "./icons/icon-192.png",
        tag: n.tag || "promemoria-pasto",
      });
    });
  }
} catch (e) {
  // Se la configurazione Firebase non è ancora stata compilata qui sopra,
  // o il browser non supporta il push, il resto dell'app (cache offline,
  // promemoria "locali" pianificati da app.js) continua a funzionare lo stesso.
}
