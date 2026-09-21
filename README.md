[README.md](https://github.com/user-attachments/files/32471357/README.md)
# Il mio Piano — app del piano nutrizionale

App per telefono (installabile come una vera app, senza passare dagli store)
che mostra ogni giorno il menu del tuo piano nutrizionale personalizzato e
manda un promemoria nei momenti dei pasti.

Non richiede account, server o abbonamenti: è un sito web che, una volta
pubblicato su GitHub Pages, puoi "installare" sulla schermata Home del
telefono. Il codice è tutto qui dentro, pronto per essere caricato.

---

## 1. Cosa troverai nel progetto

```
piano-nutrizionale/
├── index.html          → la pagina dell'app
├── manifest.json        → dice al telefono come installare l'app (nome, icona…)
├── service-worker.js    → fa funzionare l'app offline e gestisce le notifiche
├── config.json           → LE IMPOSTAZIONI DEL TUO PIANO (data, orari, regole)
├── css/style.css         → l'aspetto grafico
├── js/data.js            → i menu delle 5 settimane (dai PDF della nutrizionista)
├── js/week-logic.js      → calcola quale settimana/giorno mostrare oggi
├── js/app.js              → la logica dell'interfaccia e delle notifiche
└── icons/                 → le icone dell'app
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

   È l'indirizzo della tua app: aprilo dal telefono.

Ogni volta che modifichi un file e fai un nuovo commit/push, GitHub Pages
aggiorna automaticamente il sito in un minuto o due.

---

## 4. Installare l'app sul telefono

**Android (Chrome):**
1. Apri l'indirizzo GitHub Pages nel browser Chrome.
2. Tocca il menu ⋮ in alto a destra → **Aggiungi a schermata Home** (o comparirà un banner automatico "Installa app").
3. Conferma: l'icona a foglia comparirà tra le tue app, e si aprirà a schermo intero come un'app vera.

**iPhone (Safari):**
1. Apri l'indirizzo GitHub Pages in **Safari** (deve essere Safari, non Chrome, perché su iOS solo Safari può installare app web).
2. Tocca l'icona **Condividi** (il quadrato con la freccia verso l'alto).
3. Scorri e tocca **Aggiungi alla schermata Home** → **Aggiungi**.

Da questo momento l'app si apre dall'icona sulla Home, senza barra del browser.

---

## 5. Attivare i promemoria dei pasti

1. Apri l'app (dall'icona installata, idealmente).
2. Vai su **Impostazioni** e attiva **Attiva promemoria**, oppure tocca la campanella in alto.
3. Il telefono chiederà il permesso di mostrare notifiche: conferma.
4. Da **Impostazioni** puoi anche modificare l'orario di ciascun pasto.

**Come funzionano, onestamente:** l'app programma il promemoria di ogni pasto
mentre è aperta o rimane in background di recente; se la riapri entro 90
minuti da un orario già passato, ti mostra comunque il promemoria di quel
pasto ("recupero"). È un funzionamento locale, senza server: molto affidabile
su Android se tieni l'app tra le app recenti, meno prevedibile se il telefono
la chiude del tutto per ore, specialmente su iPhone (Safari limita le notifiche
web in background più di Chrome/Android).

Se in futuro vuoi notifiche "vere" anche ad app completamente chiusa per
giorni, serve un servizio di invio push lato server (es. Firebase Cloud
Messaging o OneSignal) che manda la notifica dall'esterno a un orario
prestabilito: è un passo in più, fammelo sapere quando vuoi e ti preparo
anche quello.

---

## 6. Configurare il tuo piano — `config.json`

Questo è il file da modificare quando cambia qualcosa nel piano. Aprilo,
cambia i valori e fai commit/push: l'app si aggiorna da sola.

```json
{
  "startDate": "2026-09-14",
  "week5Months": [],
  "overrideWeek": null,
  "orari": {
    "colazione": "08:00",
    "spuntinoMattina": "10:30",
    "pranzo": "13:00",
    "spuntinoPomeriggio": "16:30",
    "cena": "20:00"
  }
}
```

- **`startDate`** — il lunedì da cui parte la "Settimana 1". Da lì in poi
  l'app ruota automaticamente 1 → 2 → 3 → 4 → 1 → 2… una settimana alla volta.
- **`week5Months`** — elenco di mesi (`"2026-12"`, ecc.) in cui, secondo la
  regola della nutrizionista, si usa il menu della Settimana 5. Si attiva
  solo nel 5° lunedì di quel mese (i mesi che ne hanno cinque).
- **`overrideWeek`** — per forzare manualmente una settimana fissa (1-5)
  indipendentemente dalla data, scrivi il numero; altrimenti lascia `null`.
- **`orari`** — gli orari di default usati per il promemoria di ciascun
  pasto (personalizzabili anche dall'app, per dispositivo, in Impostazioni).

> Nota sulla "Regola 5ª settimana": nel PDF originale la regola era
> troncata ("si applica ai mesi in cui le settimane con più di tre giorni
> lavorativi sono più di 4…"). Ho implementato l'interpretazione più
> naturale (5° lunedì del mese), ma se la nutrizionista intendeva altro,
> usa semplicemente `overrideWeek` nelle settimane in questione, oppure
> aggiorna `week5Months` di conseguenza.

---

## 7. Spuntare i pasti fatti

Nella vista **Oggi**, sotto ogni pasto c'è un pulsante "Segna come fatto".
Toccandolo il pasto si spunta (bordo verde, testo barrato) e in alto compare
il conteggio "3/5 pasti fatti". Le spunte sono salvate solo sul telefono
usato (localStorage) e si azzerano automaticamente ogni giorno; lo storico
delle spunte più vecchie di 21 giorni viene ripulito da solo.

## 8. Modificare un pasto senza file (consigliato per le modifiche di routine)

In **Impostazioni → "Modifica un pasto"** puoi cambiare il testo di un singolo
pasto direttamente dall'app: scegli settimana e giorno dai due menu a
tendina, i campi si riempiono con il testo attuale, li modifichi e premi
**"Salva questo giorno"**. Nessun file da scaricare o caricare — il piano
che stai usando si aggiorna immediatamente e resta salvato sul telefono.

I 5 pasti (colazione, spuntino mattina, pranzo, spuntino pomeriggio, cena)
sono obbligatori; coccola e kcal totali sono facoltativi. Se lasci un campo
vuoto, l'app te lo segnala e non salva nulla, così il piano resta sempre
coerente.

## 9. Importare o sostituire l'intero piano da file

Per modifiche di routine usa la sezione "Modifica un pasto" qui sopra. Il
caricamento da file `.json` resta utile per cambi grossi — ad esempio
quando la nutrizionista consegna un piano completamente nuovo — perché
sostituisce tutte le settimane in un colpo solo:

1. Tocca **"Scarica il piano attuale come modello (.json)"**: ottieni un
   file già nel formato corretto, con i tuoi pasti attuali.
2. Modifica i testi dei pasti nel file scaricato con un editor di testo
   (mantieni la struttura invariata: non cambiare i nomi dei campi).
3. In Impostazioni tocca **"Importa piano da file…"** e seleziona il file
   modificato.

L'app controlla che il file sia formattato correttamente prima di
accettarlo (7 giorni per settimana, tutti i pasti compilati, ecc.): se
manca qualcosa te lo segnala con un messaggio preciso (es. "Sett. 2,
Giovedì: manca 'Pranzo'") e non applica nulla, così non rischi di rompere
l'app. Il piano importato resta salvato solo su quel dispositivo
(localStorage) — non modifica i file su GitHub. Per tornare al piano di
partenza, usa **"Ripristina il piano originale"** (compare solo quando un
piano importato è attivo).

Formato atteso del file (puoi anche scriverlo da zero seguendo questo schema):

```json
{
  "paziente": { "nome": "…", "obiettivo": "…", "targetKcal": 1500, "nutrizionista": "…" },
  "orariDefault": { "colazione": "08:00", "spuntinoMattina": "10:30", "pranzo": "13:00", "spuntinoPomeriggio": "16:30", "cena": "20:00" },
  "normeGenerali": ["Regola 1", "Regola 2"],
  "settimane": {
    "1": [
      { "colazione": "…", "spuntinoMattina": "…", "pranzo": "…", "spuntinoPomeriggio": "…", "cena": "…", "coccola": "…", "kcal": 1500 },
      { "…": "… (7 oggetti in tutto, uno per giorno, da Lunedì a Domenica, nell'ordine)" }
    ]
  }
}
```

Servono almeno le settimane `"1"`, `"2"`, `"3"`, `"4"` (la `"5"` è
opzionale, si applica solo nei mesi con 5ª settimana). `kcal` e `coccola`
sono facoltativi.

## 10. Aggiornare i menu — `js/data.js`

Quando la nutrizionista ti dà un nuovo piano (nuova settimana, sostituzioni,
ecc.), apri `js/data.js` e modifica i testi dei pasti: è un oggetto con una
voce per ogni settimana (1-5) e, dentro, un elenco dei 7 giorni con gli
stessi campi (`colazione`, `spuntinoMattina`, `pranzo`, `spuntinoPomeriggio`,
`cena`, `coccola`, `kcal`). Basta modificare il testo tra virgolette, salvare
e fare commit/push.

---

## 11. Aggiornare l'app dopo una modifica

L'app salva una copia offline dei file (per funzionare anche senza
connessione). Dopo ogni modifica che vuoi vedere subito riflessa anche su un
telefono che ha già installato l'app, apri `service-worker.js` e cambia:

```js
const CACHE_VERSION = "v1";
```

in `"v2"`, `"v3"`, ecc. — questo forza il telefono a scaricare la versione
aggiornata al prossimo avvio dell'app.

---

## 12. Domande frequenti

**Devo pagare qualcosa?** No. GitHub Pages è gratuito per repository pubblici, e l'app non usa servizi a pagamento.

**I miei dati (piano, nome, peso) finiscono da qualche parte online?** Il
repository su GitHub è pubblico per impostazione predefinita (necessario per
Pages gratuito), quindi chiunque conosca l'indirizzo può vedere i file,
incluso il tuo piano in `js/data.js`. Se preferisci tenerlo privato, GitHub
permette repository privati anche gratuitamente, ma **GitHub Pages gratuito
richiede un repository pubblico** (i repository privati con Pages
richiedono un piano GitHub Pro). Se per te è importante, fammelo sapere: si
può ospitare l'app altrove (es. Netlify o Vercel, gratuiti anche con
repository privati) con pochissime modifiche.

**Posso usarla anche senza installarla?** Sì, funziona come sito web
normale; installarla serve solo per averla come icona a schermo intero e
per i promemoria.
