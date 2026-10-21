# Il mio Piano — app Android (Capacitor)

L'app Android è un contenitore che apre **https://app.ilmiopiano.it** (opzione A):
gli aggiornamenti pubblicati con `firebase deploy` arrivano subito anche su Android,
senza una nuova versione sul Play Store. Android Studio serve solo quando cambia la
parte nativa (plugin, versioni richieste da Google, icone).

- `capacitor.config.json` — identificativo dell'app (`it.ilmiopiano.app`, non si cambia più dopo la pubblicazione) e indirizzo caricato.
- `www/` — solo la pagina di riserva per il primo avvio senza connessione.
- `android/` — progetto Android generato da Capacitor (`npx cap add android`).

Prima volta, su un PC con Android Studio:

    cd mobile
    npm install
    npx cap add android
    npx cap open android

Dopo ogni modifica alla configurazione o ai plugin: `npm run sincronizza`.

**La chiave di firma (file .jks / .keystore) non va mai su GitHub né su Dropbox:** se si perde non si possono più pubblicare aggiornamenti dell'app. Va conservata in due copie sicure, con la sua password.
