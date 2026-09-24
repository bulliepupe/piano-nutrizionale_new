
/**
 * service-worker.js
 * Cache "app shell" per il funzionamento offline + tap sulle notifiche +
 * notifiche push ricevute ad app chiusa (Firebase Cloud Messaging), anche su
 * iPhone (iOS 16.4 o successivo, app aggiunta alla schermata Home).
 *
 * Se aggiorni i file dell'app, alza CACHE_VERSION per forzare il
 * refresh della cache sui dispositivi già installati.
 *
 * La configurazione Firebase NON va più incollata qui: viene letta
 * direttamente da js/firebase-config.js (vedi importScripts più sotto).
 */

const CACHE_VERSION = "v17";
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
  "./img/hero.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    // File salvati uno per uno: se ne manca uno (es. caricato con il nome
    // sbagliato), l'aggiornamento dell'app va avanti lo stesso invece di
    // bloccarsi del tutto come succede con cache.addAll.
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((nomi) =>
      Promise.all(nomi.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Rete prima (dati/aspetto sempre aggiornati), cache come riserva offline.
// Solo richieste verso questo stesso sito: Firebase e i font vanno dritti in rete.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((risposta) => {
        if (risposta.ok) {
          const copia = risposta.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        }
        return risposta;
      })
      .catch(() =>
        caches.match(event.request).then((r) => {
          if (r) return r;
          // La pagina di riserva solo per le navigazioni, non per immagini o script.
          if (event.request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});

// Tocco su una notifica: porta in primo piano l'app (o la apre).
// È registrato PRIMA di Firebase apposta, così viene eseguito sempre per primo.
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
  importScripts("./js/firebase-config.js");
  importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");

  firebase.initializeApp(self.FIREBASE_CONFIG);
  const messaging = firebase.messaging();

  // I promemoria inviati dal server contengono già il blocco "notification":
  // in quel caso è Firebase stesso a mostrare la notifica, e mostrarla di
  // nuovo qui creerebbe un doppione. Questo handler interviene solo per
  // eventuali messaggi "solo dati", e li mostra sempre: su iPhone un push
  // ricevuto senza notifica visibile porta iOS a revocare l'iscrizione.
  messaging.onBackgroundMessage((payload) => {
    if (payload && payload.notification) return;
    const d = (payload && payload.data) || {};
    return self.registration.showNotification(d.title || "Il mio Piano", {
      body: d.body || "",
      icon: "./icons/icon-192.png",
      tag: d.tag || "promemoria-pasto",
    });
  });
} catch (e) {
  // Push non disponibile su questo browser: cache offline e promemoria
  // "locali" gestiti da app.js continuano a funzionare lo stesso.
}
