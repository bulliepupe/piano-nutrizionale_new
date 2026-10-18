
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

const CACHE_VERSION = "v86";
const CACHE_NAME = "piano-nutrizionale-" + CACHE_VERSION;

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./config.json",
  "./css/style.css",
  "./css/fonts.css",
  "./fonts/fraunces-latin-opsz-normal.woff2",
  "./fonts/inter-latin-400-normal.woff2",
  "./fonts/inter-latin-500-normal.woff2",
  "./fonts/inter-latin-600-normal.woff2",
  "./fonts/inter-latin-700-normal.woff2",
  "./js/data.js",
  "./js/alimenti.js",
  "./js/mealprep.js",
  "./js/statistiche.js",
  "./js/week-logic.js",
  "./js/macro.js",
  "./js/allenamento-file.js",
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
      Promise.all(nomi.filter((n) => n !== CACHE_NAME && n !== "pnut-condivisi").map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Android: "Condividi con Il mio Piano" da un'app di allenamento (share_target
// nel manifest). Il file si mette da parte in una cache temporanea e l'app lo
// apre subito dopo; lo cancella appena letto.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.origin !== self.location.origin || !url.pathname.endsWith("/condividi-allenamento")) return;
  event.respondWith((async () => {
    try {
      const dati = await event.request.formData();
      const file = dati.get("file");
      if (file && file.size) {
        const cache = await caches.open("pnut-condivisi");
        await cache.put("/condiviso/allenamento", new Response(file, { headers: { "x-nome": encodeURIComponent(file.name || "allenamento") } }));
      }
    } catch (e) { /* l'app avvisa che il file non è arrivato */ }
    return Response.redirect(new URL("./?importa-allenamento=1", self.registration.scope).href, 303);
  })());
});

// Rete prima (dati/aspetto sempre aggiornati), cache come riserva offline.
// Solo richieste verso questo stesso sito: Firebase e i font vanno dritti in rete.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  // "no-cache": il browser chiede sempre al server se il file è cambiato
  // (risposta leggera se è uguale). Così un aggiornamento pubblicato arriva
  // subito, senza aspettare i 10 minuti di cache di GitHub Pages.
  // Le pagine (navigazioni) seguono i reindirizzamenti in modo "manuale": se
  // il sito risponde con un redirect (es. dal vecchio indirizzo
  // bulliepupe.github.io al nuovo app.ilmiopiano.it) è il browser a seguirlo e
  // a cambiare indirizzo. Senza questo, il browser rifiuterebbe la pagina.
  const navigazione = event.request.mode === "navigate";
  const richiesta = new Request(event.request.url, {
    cache: "no-cache", credentials: "same-origin", redirect: navigazione ? "manual" : "follow",
  });
  event.respondWith(
    fetch(richiesta)
      .then((risposta) => {
        if (risposta.type === "opaqueredirect" || risposta.redirected) return risposta;
        if (risposta.ok) {
          const copia = risposta.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
          return risposta;
        }
        // Il server risponde con un errore (per esempio una pagina "Site Not
        // Found" durante un disservizio): all'apertura si usa la copia salvata
        // dell'app, invece di mostrare la pagina di errore al paziente.
        if (navigazione && risposta.status >= 400) {
          return caches.match(event.request).then((r) => r || caches.match("./index.html")).then((r) => r || risposta);
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
