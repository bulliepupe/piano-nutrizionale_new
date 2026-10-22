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

## Icona e schermata di avvio

Le immagini di partenza sono in `assets/` (icona, primo piano trasparente della foglia, sfondo verde #2F5142, schermate di avvio chiara e scura). Per rigenerare tutte le dimensioni Android dopo averle cambiate:

    npx @capacitor/assets@3.0.5 generate --android --iconBackgroundColor "#2F5142" --iconBackgroundColorDark "#2F5142" --splashBackgroundColor "#EEF2E8" --splashBackgroundColorDark "#151A16"

Su Android 12 e successivi la schermata di avvio mostra l'icona su un colore fisso: `res/values/colori_avvio.xml` (chiaro) e `res/values-night/colori_avvio.xml` (scuro).
