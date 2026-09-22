/**
 * service-worker.js
 * Cache "app shell" per il funzionamento offline (una volta aperta almeno
 * una volta con connessione) + gestione del tap sulle notifiche.
 *
 * Se aggiorni i file dell'app, alza CACHE_VERSION per forzare il
 * refresh della cache sui dispositivi già installati.
 */

const CACHE_VERSION = "v12";
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
