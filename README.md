# Il mio Piano — app del piano nutrizionale

App per telefono (installabile come una vera app, senza passare dagli store)
che mostra ogni giorno il menu del piano nutrizionale personalizzato e manda
un promemoria nei momenti dei pasti.

Da questa versione l'app ha un **accesso cloud**: il professionista
(dietista/nutrizionista) ha un pannello per creare pazienti e modificarne il
piano, e ogni paziente vede il proprio piano sincronizzato in tempo reale, su
qualsiasi dispositivo — senza dover più modificare file su GitHub per ogni
paziente. Il codice resta comunque un sito statico, pubblicato gratis su
GitHub Pages; il "cloud" è **Firebase** (Google), nel suo piano gratuito.

---

## 1. Cosa troverai nel progetto

```
piano-nutrizionale/
├── index.html            → la pagina dell'app (login + vista paziente + pannello professionista)
├── manifest.json         → dice al telefono come installare l'app (nome, icona…)
├── service-worker.js     → fa funzionare l'app offline e gestisce le notifiche
├── config.json           → ciclo delle settimane e orari di default (condivisi da tutti i pazienti)
├── firestore.rules       → regole di sicurezza da incollare nella console Firebase
├── css/style.css         → l'aspetto grafico
├── js/data.js            → piano di ESEMPIO usato come punto di partenza per un nuovo paziente
├── js/week-logic.js      → calcola quale settimana/giorno mostrare oggi
├── js/firebase-config.js → i tuoi parametri del progetto Firebase (da compilare)
├── js/cloud.js           → tutte le chiamate a Firebase (accesso, Firestore)
├── js/app.js             → la logica dell'interfaccia, dei ruoli e delle notifiche
├── functions/            → Cloud Function per le notifiche push ad app chiusa (facoltativa, punto 12)
└── icons/                → le icone dell'app
```

Non c'è nessun passaggio di "compilazione": è HTML/CSS/JS semplice, apri e funziona.

---

## 2. Pubblicare il codice su GitHub

### Opzione A — dal sito GitHub (più semplice, nessuna riga di comando)

1. Vai su [github.com](https://github.com) ed entra nel tuo account (creane uno gratuito se non l'hai già).
2. In alto a destra premi **+** → **New repository**.
3. Dai un nome al repository, ad esempio `piano-nutrizionale`. Lascialo **Public** (necessario per usare GitHub Pages gratuitamente) e premi **Create repository**.
4. Nella pagina del repository appena creato, premi **uploading an existing file**.
5. Trascina dentro **tutti i file e le cartelle** di questo progetto (mantenendo la struttura: `index.html`, `manifest.json`, le cartelle `css/`, `js/`, `icons/`, ecc.) e premi **Commit changes**.

### Opzione B — da terminale, con git

```bash
cd piano-nutrizionale
git init
git add .
git commit -m "Prima versione dell'app"
git branch -M main
git remote add origin https://github.com/TUO-USERNAME/piano-nutrizionale.git
git push -u origin main
```

---

## 3. Attivare GitHub Pages (per avere un indirizzo web)

1. Nel repository su GitHub, vai su **Settings** → **Pages** (menu a sinistra).
2. In **Build and deployment → Source** scegli **Deploy from a branch**.
3. In **Branch** scegli `main` e cartella `/ (root)`, poi **Save**.
4. Dopo 1-2 minuti, in cima alla stessa pagina comparirà l'indirizzo del tuo sito, del tipo:

   `https://TUO-USERNAME.github.io/piano-nutrizionale/`

Ogni volta che modifichi un file e fai un nuovo commit/push, GitHub Pages
aggiorna automaticamente il sito in un minuto o due.

---

## 4. Configurare l'accesso cloud (Firebase) — da fare una sola volta

Senza questo passaggio l'app mostra solo la schermata di accesso, senza
poter funzionare: è il "motore" che tiene sincronizzati professionista e
pazienti.

1. Vai su [console.firebase.google.com](https://console.firebase.google.com) ed entra col tuo account Google.
2. **Aggiungi progetto** → dagli un nome (es. "Il mio Piano") → puoi disattivare Google Analytics (non serve) → **Crea progetto**.
3. Nel menu a sinistra apri **Build → Authentication** → **Inizia** → nella lista dei provider abilita **Email/Password** (primo interruttore) → **Salva**.
4. Sempre nel menu a sinistra apri **Build → Firestore Database** → **Crea database** → scegli una posizione (una europea, es. `eur3`) → **Avvia in modalità produzione** → **Abilita**.
5. Apri la scheda **Regole** del database appena creato, cancella il contenuto e incolla quello del file `firestore.rules` di questo progetto → **Pubblica**.
6. Torna alla pagina principale del progetto (icona ingranaggio in alto → **Impostazioni progetto**) → scorri fino a **Le tue app** → icona **</>** (Web) → dai un nome all'app → **Registra app**. Comparirà un blocco `firebaseConfig = {...}`: copia quei valori.
7. Apri `js/firebase-config.js` in questo progetto e incolla i valori copiati al posto dei segnaposto `INSERISCI_...`. Salva, fai commit e push su GitHub.

Fatto: dopo 1-2 minuti (il tempo che GitHub Pages aggiorni il sito) l'app è
pronta per la registrazione del primo professionista.

**Sui costi:** il piano gratuito di Firebase ("Spark") include Authentication
illimitata e Firestore fino a 1 GB di dati e 50.000 letture/20.000
scritture al giorno — più che sufficiente per uno studio con decine o
centinaia di pazienti. Non serve inserire una carta di credito.

---

## 5. I due ruoli: professionista e paziente

- **Professionista** (tu, o chi gestisce i piani): alla prima apertura
  dell'app tocca **"Registrati come professionista"** nella schermata di
  accesso e crea il proprio account con email e password. Da lì si entra
  nel **pannello professionista**: elenco pazienti, "+ Nuovo paziente" per
  crearne uno (viene generata anche una password provvisoria da comunicare
  al paziente), e l'editor per modificare i pasti di ciascun piano — le
  modifiche arrivano **subito** sull'app del paziente, anche se è su un
  altro telefono.
- **Paziente**: riceve dal professionista email e password provvisoria,
  le usa per accedere e vede il proprio piano (Oggi / Settimana /
  Impostazioni) esattamente come nella versione precedente dell'app — con
  la differenza che ora **non può più modificare pasti, regole generali o
  dati anagrafici**: quelli si aggiornano solo dal pannello del
  professionista. Il paziente può però attivare/disattivare i promemoria,
  cambiare tema, e spuntare i pasti fatti — anche queste spunte sono
  sincronizzate sul cloud.

Un professionista può gestire più pazienti dallo stesso account; ogni
paziente vede solo il proprio piano (lo impongono anche le regole di
sicurezza in `firestore.rules`, non solo l'interfaccia).

---

## 6. Installare l'app sul telefono

**Android (Chrome):**
1. Apri l'indirizzo GitHub Pages nel browser Chrome.
2. Tocca il menu ⋮ in alto a destra → **Aggiungi a schermata Home** (o comparirà un banner automatico "Installa app").
3. Conferma: l'icona comparirà tra le tue app, e si aprirà a schermo intero come un'app vera.

**iPhone (Safari) — serve iOS 16.4 o successivo per i promemoria:**
1. Apri l'indirizzo GitHub Pages in **Safari**.
2. Tocca l'icona **Condividi** (il quadrato con la freccia verso l'alto).
3. Scorri e tocca **Aggiungi alla schermata Home** → **Aggiungi**.
4. Apri l'app **dall'icona sulla Home** e accedi di nuovo (l'app installata ha un accesso separato da Safari: è normale).

Su iPhone **le notifiche funzionano solo nell'app installata**, mai in una
scheda di Safari: è una regola di Apple. L'app lo sa e, se viene aperta da
Safari, mostra un avviso "Installa l'app sull'iPhone" con questi passaggi.

---

## 7. Attivare i promemoria dei pasti

1. Apri l'app e accedi.
2. Vai su **Impostazioni** e attiva **Attiva promemoria**, oppure tocca la campanella in alto.
3. Il telefono chiederà il permesso di mostrare notifiche: conferma.
4. Da **Impostazioni** scegli anche **"Anticipo promemoria"** (10/15/20/30 minuti prima del pasto) e, se vuoi, modifica l'orario di ciascun pasto — entrambi personali per dispositivo, ma sincronizzati anche sul server per le notifiche push (vedi sotto).

**Due livelli di promemoria, insieme:**
- **Locale** (funziona sempre, nessuna configurazione aggiuntiva): l'app programma il promemoria di ogni pasto mentre è aperta o rimane in background di recente; se la riapri entro 90 minuti dall'orario del pasto già passato, ti mostra comunque il promemoria di quel pasto ("recupero").
- **Push, anche ad app completamente chiusa** (richiede la Cloud Function — vedi punto 12): appena attivi i promemoria, l'app registra questo dispositivo per le notifiche push. Se la Cloud Function è stata pubblicata, il promemoria arriva anche con l'app chiusa da ore; altrimenti resta comunque il livello "locale" qui sopra, senza che nulla si rompa.

---

## 8. Il ciclo delle settimane — `config.json`

```json
{
  "startDate": "2026-09-14",
  "week5Months": [],
  "overrideWeek": null,
  "orari": { "colazione": "08:00", "spuntinoMattina": "10:30", "pranzo": "13:00", "spuntinoPomeriggio": "16:30", "cena": "20:00" }
}
```

- **`startDate`** — il lunedì da cui parte la "Settimana 1". Da lì in poi
  l'app ruota automaticamente 1 → 2 → 3 → 4 → 1 → 2… una settimana alla volta.
- **`week5Months`** — mesi (`"2026-12"`, ecc.) in cui si usa il menu della
  Settimana 5, solo al 5° lunedì di quel mese.
- **`overrideWeek`** — per forzare una settimana fissa (1-5) indipendentemente
  dalla data; altrimenti `null`.
- **`orari`** — orari di default dei pasti, personalizzabili anche per
  singolo dispositivo dall'app.

Questo file è **condiviso da tutti i pazienti** di questo deployment (lo
stesso sito serve tutti): oggi il ciclo delle settimane è unico per tutti,
non ancora personalizzabile per singolo paziente — è tra le prossime
migliorie pianificate.

---

## 9. Il pannello professionista, sezione per sezione

Da **"I tuoi pazienti"**, tocca il paziente: si apre l'editor.

- **I miei dati di contatto** (pulsante nella lista pazienti) — nome, qualifica,
  studio, email, telefono, se usi WhatsApp e una nota per i pazienti. Compaiono
  nell'app di tutti i tuoi pazienti con il pulsante **Contatta** (WhatsApp,
  email, chiamata). Quando li modifichi si aggiornano su tutti i pazienti.
- **Dati paziente** — nome, obiettivo, target kcal giornaliero, nutrizionista (usato solo se i dati di contatto non sono compilati): modificabili e sincronizzati subito. L'email di accesso resta di sola consultazione (serve per il login).
- **Regole generali del piano** — una per riga, compaiono nella vista "Oggi" del paziente.
- **Sostituzioni pasto** — gruppi di alimenti che consideri equivalenti tra loro (per calorie, macronutrienti, tipologia): **è una tua valutazione clinica, l'app non la genera da sola**. Un gruppo per riga, con questo formato:

  ```
  Fonti proteiche magre: Pollo 150g, Tacchino 150g, Merluzzo 200g, Albume 200g
  Cereali integrali: Pane integrale 50g, Riso integrale 60g, Farro 60g
  ```

  Quando il testo di un pasto del paziente contiene il nome di un'opzione (es. "Pollo alla griglia 220g" contiene "Pollo"), nella sua app compare un pulsante **"Sostituisci"** che mostra le altre opzioni dello stesso gruppo.
- **Modifica un pasto** — scegli settimana e giorno dai due menu a tendina,
  cambia il testo dei pasti (i 5 sono obbligatori; coccola e kcal
  facoltativi) e premi **"Salva questo giorno"**: si sincronizza subito con
  l'app del paziente, ovunque si trovi.
- **Copia una settimana** — scegli la settimana da copiare e tocca i numeri
  delle settimane in cui incollarla (anche la 5, se non esiste ancora). Se
  una settimana di destinazione ha già dei pasti, l'app chiede conferma
  prima di sostituirli.
- **Elimina paziente** (in fondo all'editor) — cancella per sempre account di
  accesso, piano, spunte dei pasti e promemoria del paziente. Per sicurezza
  chiede di scrivere "elimina". L'operazione passa dalla Cloud Function
  `eliminaPaziente` (vedi punto 12), che controlla che il paziente sia davvero
  tuo prima di cancellare qualunque cosa. Dopo l'eliminazione la stessa email
  può essere riusata per un nuovo paziente.
- **Importa / sostituisci l'intero piano** — per un cambio grosso (piano
  completamente nuovo) puoi scaricare il piano attuale come modello `.json`,
  modificarlo con un editor di testo mantenendo la struttura dei campi, e
  ricaricarlo: sostituisce tutte le settimane in un colpo solo. L'app
  controlla il file prima di accettarlo (7 giorni per settimana, tutti i
  pasti compilati, ecc.) e segnala con precisione cosa manca, senza
  applicare nulla di incompleto. Il file scaricato include anche regole
  generali e sostituzioni, quindi puoi modificarle in blocco da lì se preferisci.

---

## 9bis. La scheda "Spesa" (lato paziente)

Genera automaticamente una lista della spesa aggregando gli ingredienti di
tutti i pasti della settimana selezionata (menu a tendina in alto, come
nella scheda Settimana). Ogni voce ha una spunta (si ricorda da un
accesso all'altro, solo su questo dispositivo) e si possono aggiungere o
togliere articoli a mano. Il pulsante **"Copia lista negli appunti"**
prepara un testo semplice da incollare altrove (note, WhatsApp, ecc.).

**Un limite onesto:** la lista viene estratta dal testo libero dei pasti con
un'interpretazione automatica (riconosce quantità come "220g" o "1 uovo",
scompone le parentesi tipo "Riso 70g, Robiola 25g"), non da un database
alimentare strutturato — funziona bene nella maggior parte dei casi ma va
sempre ricontrollata prima di uscire a fare la spesa.

---

## 10. Il piano di esempio — `js/data.js`

Non è più "il" piano di un singolo paziente: è lo **schema di partenza**
copiato automaticamente ogni volta che il professionista crea un nuovo
paziente dal pannello (così non si parte da zero). Modificalo se vuoi che i
nuovi pazienti partano da un modello diverso dal tuo — non tocca i pazienti
già creati.

---

## 11. Aggiornare l'app dopo una modifica al codice

L'app salva una copia offline dei file per funzionare anche senza
connessione. Dopo ogni modifica al codice (non al piano di un paziente, che
si sincronizza da solo via Firestore) che vuoi vedere subito riflessa anche
su un telefono che ha già installato l'app, apri `service-worker.js` e alza:

```js
const CACHE_VERSION = "v8";
```

di uno — questo forza il telefono a scaricare la versione aggiornata al
prossimo avvio dell'app.

---

## 12. Notifiche push anche ad app chiusa — pubblicare la Cloud Function

Questo passaggio è **facoltativo**: senza, l'app funziona comunque, con i
promemoria "locali" descritti al punto 7. Se vuoi anche quelli veri ad app
chiusa, serve pubblicare un piccolo programma che gira sui server di
Google (una "Cloud Function") — un passaggio più tecnico dei precedenti,
perché richiede il terminale invece della sola Console web. Vai con calma,
un passaggio alla volta.

### 13.1 Passaggi in Firebase Console

1. **Passa al piano Blaze.** Console Firebase → in basso a sinistra "Modifica piano" (o icona ingranaggio → "Utilizzo e fatturazione") → **Blaze (Pay as you go)** → segui la procedura, che chiede una carta di credito. Per i volumi di uno studio nutrizionale il costo reale resta €0 (vedi le stime discusse in chat) — l'unico vincolo è avere una carta collegata.
2. **Imposta subito un avviso di budget** (consigliato, richiede due minuti): nella pagina di fatturazione di Google Cloud → "Budget e avvisi" → crea un budget, es. 1€, con avviso email al superamento. Non blocca la spesa da solo, ma ti avvisa subito se mai dovesse succedere qualcosa di anomalo.
3. **Genera la chiave VAPID:** icona ingranaggio → "Impostazioni progetto" → scheda **Cloud Messaging** → sezione "Configurazione web push" → **Genera coppia di chiavi**. Copia la chiave.
4. Apri `js/firebase-config.js` e incolla la chiave al posto di `INSERISCI_VAPID_KEY` in `window.FIREBASE_VAPID_KEY`.
5. Apri `service-worker.js` e incolla LA STESSA configurazione che hai già in `js/firebase-config.js` (i 6 valori `apiKey`, `authDomain`, ecc.) al posto dei segnaposto `INSERISCI_...`, nel blocco `firebase.initializeApp({...})` verso la fine del file.
6. Carica su GitHub entrambi i file modificati (`js/firebase-config.js` e `service-worker.js`).

### 13.2 Installare gli strumenti sul computer (una tantum)

1. **Node.js** — se non l'hai già, scaricalo da [nodejs.org](https://nodejs.org) (versione "LTS") e installalo come un programma qualsiasi. Per controllare se ce l'hai già: apri il terminale (su Windows "Prompt dei comandi" o "PowerShell", su Mac "Terminale") e digita:
   ```bash
   node -v
   ```
   Se stampa un numero di versione (es. `v20.x.x`), ce l'hai già.
2. **Firebase CLI** — nello stesso terminale:
   ```bash
   npm install -g firebase-tools
   ```
3. **Accedi con il tuo account Google:**
   ```bash
   firebase login
   ```
   Si apre il browser per il login, poi torna pure al terminale.

### 13.3 Scaricare il progetto sul computer

1. Sulla pagina GitHub del repository, pulsante verde **"Code"** → **"Download ZIP"**.
2. Estrai lo ZIP in una cartella (es. sul Desktop).
3. Apri il terminale in quella cartella: su Windows, dentro la cartella estratta tieni premuto Maiusc e tasto destro → "Apri finestra PowerShell qui"; su Mac, tasto destro sulla cartella nel Finder → "Nuovo terminale nella cartella" (se non compare, apri Terminale e scrivi `cd ` seguito da uno spazio, poi trascina la cartella nella finestra, poi Invio).

### 13.4 Collegare il progetto e pubblicare la funzione

Nel terminale, dentro la cartella del progetto:

```bash
firebase use --add
```
Scegli il tuo progetto Firebase dalla lista (quello creato al punto 4), dagli un alias qualsiasi quando richiesto (es. `default`).

La cartella `functions/` con `index.js`, `package.json` e `week-logic.js` è già pronta dentro il progetto che hai scaricato — non serve ricrearla con `firebase init`. Basta installare le sue dipendenze:

```bash
cd functions
npm install
cd ..
```

E infine pubblicare:

```bash
firebase deploy --only functions
```

La prima pubblicazione richiede un paio di minuti. Alla fine il terminale mostra il nome della funzione (`controllaPromemoria`) con un segno di spunta verde: da quel momento gira automaticamente ogni 5 minuti sui server di Google, senza che tu debba lasciare nulla acceso.

### 13.5 Verifica

1. Da un dispositivo, accedi come paziente e attiva i promemoria in Impostazioni.
2. Console Firebase → Firestore Database → collezione `users` → il documento di quel paziente dovrebbe avere un campo `fcmTokens` con un valore lungo (il token del dispositivo) e `notificheAttive: true`.
3. Chiudi completamente l'app su quel dispositivo (non solo la scheda: rimuovila dalle app recenti). Al prossimo orario-pasto meno l'anticipo scelto, entro 5 minuti dovrebbe arrivare la notifica anche così.
4. Se non arriva: Console Firebase → menu a sinistra → **Functions** → apri `controllaPromemoria` → scheda "Registri" (Logs), per vedere eventuali errori.

### 13.6 Quando modifichi qualcosa

- La configurazione Firebase si scrive **solo** in `js/firebase-config.js`: il
  service worker la legge da lì. Non serve più copiarla in `service-worker.js`.

- Se cambi `config.json` (il ciclo delle settimane), aggiorna anche gli stessi
  valori in `functions/index.js` (costanti `CONFIG_BASE` e `ORARI_DEFAULT` in
  cima al file) e ripubblica con `firebase deploy --only functions`.
- Se in futuro aggiorno `js/week-logic.js`, copia il file anche dentro
  `functions/week-logic.js` prima di ripubblicare — è un doppione voluto,
  perché la Cloud Function viene pubblicata solo con i file dentro `functions/`.

---

## 13. Domande frequenti

**Devo pagare qualcosa?** No: GitHub Pages e il piano gratuito di Firebase
coprono comodamente uno studio con centinaia di pazienti (vedi punto 4). Il
piano Blaze (punto 12, solo se vuoi le notifiche push vere) resta a sua
volta gratuito nella pratica per questi volumi — richiede solo una carta
collegata, non un costo mensile fisso.

**I dati dei pazienti finiscono nel repository pubblico su GitHub?** No —
è proprio il cambiamento di questa versione: il codice dell'app (uguale per
tutti) resta su GitHub, pubblico; i dati di ciascun paziente (piano,
pasti fatti) vivono su Firestore, protetti dalle regole di sicurezza in
`firestore.rules`, e sono leggibili solo dal paziente stesso e dal
professionista che li ha creati.

**Un paziente può vedere il piano di un altro?** No, le regole di sicurezza
di Firestore lo impediscono a livello di database, non solo di interfaccia.

**Posso usarla anche senza installarla?** Sì, funziona come sito web
normale; installarla serve solo per averla come icona a schermo intero e
per i promemoria.
