



/**
 * app.js — logica dell'interfaccia.
 * Nessuna dipendenza di build: apre index.html via HTTPS/GitHub Pages e funziona.
 *
 * Novità di questa versione: il piano NON vive più solo su questo dispositivo.
 * C'è un accesso (Firebase Auth) e due ruoli:
 *  - "professionista": pannello per creare pazienti e modificare i loro piani
 *    (salva su Firestore — vedi js/cloud.js);
 *  - "paziente": vede il proprio piano in tempo reale (si aggiorna da solo se
 *    il professionista lo cambia, anche da un altro dispositivo) e può solo
 *    usarlo (spunte pasti, promemoria, aspetto) — non modificarlo.
 */

(function () {
  "use strict";

  const MEAL_KEYS = ["colazione", "spuntinoMattina", "pranzo", "spuntinoPomeriggio", "cena"];
  const MEAL_META = {
    colazione: { label: "Colazione", classe: "meal--colazione" },
    spuntinoMattina: { label: "Spuntino di metà mattina", classe: "meal--spuntino1" },
    pranzo: { label: "Pranzo", classe: "meal--pranzo" },
    spuntinoPomeriggio: { label: "Spuntino pomeridiano", classe: "meal--spuntino2" },
    cena: { label: "Cena", classe: "meal--cena" },
  };

  // Solo preferenze locali al dispositivo: non riguardano il contenuto del
  // piano (quello ora vive su Firestore), quindi restano in localStorage.
  const LS_KEYS = {
    notifiche: "pnut:notifiche-attive",
    orari: "pnut:orari-override",
    tema: "pnut:tema",
    ultimoCheck: "pnut:ultimo-check",
    anticipo: "pnut:anticipo-promemoria",
    pushOk: "pnut:push-ok",               // "1" se questo dispositivo è registrato per il push dal server
    bannerIosChiuso: "pnut:banner-ios-chiuso",
    ultimoAccessoInviato: "pnut:ultimo-accesso-inviato",
    invitoRiattivaNotifiche: "pnut:invito-riattiva-notifiche",
  };
  const ANTICIPI_VALIDI = [10, 15, 20, 30];
  const ANTICIPO_DEFAULT = 15;

  // Struttura di esempio (5 settimane) usata come punto di partenza quando il
  // professionista crea un nuovo paziente — resta comunque disponibile offline.
  const PIANO_TEMPLATE = window.PIANO;

  const DEFAULT_CONFIG = {
    startDate: "2026-09-14",
    week5Months: [],
    overrideWeek: null,
    orari: Object.assign({}, PIANO_TEMPLATE.orariDefault),
  };

  let CONFIG = DEFAULT_CONFIG;
  let currentView = "oggi";
  let settimanaAnteprima = null; // per la vista Settimana: null = usa quella corrente calcolata

  // ---------------------------------------------------------------------
  // Stato di autenticazione / ruolo
  // ---------------------------------------------------------------------
  let RUOLO = null; // "paziente" | "professionista"
  let UID = null;

  // ---- stato lato paziente ----
  let PIANO_ATTIVO = null; // piano corrente letto da Firestore in tempo reale
  let PIANO_GREZZO = null; // come salvato (con l'eventuale piano programmato in "prossimo")
  let ATTIVITA_OGGI = {}; // allenamenti di oggi { allenamenti: [...] }
  let PARAMETRI_ALLENAMENTO = {}; // { fcMax, fcSoglia, ftp } dalle Impostazioni, per zone e intensità
  let CONSENSO_AI = true;        // false se il paziente ha negato o revocato il consenso alle funzioni AI
  let unsubAttivitaOggi = null;
  const PASTI_APERTI = new Set(); // righe della scheda Oggi aperte dall'utente (restano aperte quando la scheda si ridisegna)
  let ATTESA_REGISTRAZIONE = null; // registrazione del paziente autonomo in corso
  let REGISTRAZIONE_PAZIENTE_APERTA = false; // pulsante pubblico (config.json → registrazionePaziente)
  let PASTI_FATTI_OGGI = {};
  let unsubPiano = null;
  let unsubPastiOggi = null;

  // ---- stato lato professionista ----
  let PAZIENTI_PROF = [];
  let unsubPazienti = null;
  let vistaProfCorrente = "lista"; segnaVistaProf("lista"); // "lista" | "editor" | "nuovo"
  let pazienteSelezionatoId = null;
  let PIANO_ATTIVO_PROF = null;
  let unsubProfilo = null; // ascolto in tempo reale del profilo (licenza)
  let PROFILO_PROF = {}; // documento users/{uid} del professionista (nome, contatti)
  const EDITOR_PROF = { settSel: null, giornoSel: null };

  const elAuthLoading = document.getElementById("auth-loading");
  const elAuthScreen = document.getElementById("auth-screen");
  const elAppPaziente = document.getElementById("app-paziente");
  const elAppProfessionista = document.getElementById("app-professionista");
  const root = document.getElementById("view-root");
  const profRoot = document.getElementById("prof-root");
  const dataOggiEl = document.getElementById("data-oggi");

  // ---------------------------------------------------------------------
  // Avvio
  // ---------------------------------------------------------------------
  // Codice di invito a una lista di casa arrivato con un link (?invito=…): letto prima dell'accesso
  const LS_INVITO = "pnut:invito-lista";
  init();

  function memorizzaInvitoDalLink() {
    const codice = new URLSearchParams(location.search).get("invito");
    if (!codice) return;
    sessionStorage.setItem(LS_INVITO, codice.toUpperCase().replace(/[^A-Z0-9]/g, ""));
    history.replaceState(null, "", location.pathname + location.hash);
  }

  function init() {
    memorizzaInvitoDalLink();
    mostraSchermata("loading");
    collegaFormAutenticazione();

    if (!window.cloud) {
      mostraSchermata("login");
      mostraErroreIn("auth-error", "Errore nel caricamento di Firebase: controlla i tag <script> in index.html.");
      return;
    }
    if (!window.cloud.configurato) {
      mostraSchermata("login");
      document.getElementById("auth-sub").textContent =
        "Configurazione Firebase mancante: incolla i tuoi valori in js/firebase-config.js per attivare l'accesso.";
      return;
    }
    window.cloud.onAuthChange(onAuthStateChanged);
  }

  async function onAuthStateChanged(user) {
    pulisciListenerCloud();
    if (!user) {
      RUOLO = null;
      UID = null;
      mostraSchermata("login");
      return;
    }
    UID = user.uid;
    // Registrazione del paziente in corso: profilo e piano li crea il server
    // dopo l'account di accesso, quindi si aspetta che abbia finito.
    if (ATTESA_REGISTRAZIONE) {
      try { await ATTESA_REGISTRAZIONE; } catch (e) { return; } // l'account viene cancellato: arriverà il logout
    }
    // Subito dopo una registrazione, Firebase può avvisare dell'accesso avvenuto
    // prima che il documento users/{uid} (scritto subito dopo, in una chiamata
    // separata) sia effettivamente disponibile in lettura: qualche tentativo con
    // una breve attesa evita di disconnettere per errore un account appena creato.
    let utenteDati = null;
    for (let tentativo = 0; tentativo < 4 && !utenteDati; tentativo++) {
      if (tentativo > 0) await new Promise((r) => setTimeout(r, 400));
      try {
        utenteDati = await window.cloud.caricaUtente(user.uid);
      } catch (e) {
        // riprova
      }
    }
    if (!utenteDati) {
      await window.cloud.logout();
      mostraSchermata("login");
      mostraErroreIn("auth-error", "Account non configurato correttamente. Contatta il tuo professionista.");
      return;
    }
    RUOLO = utenteDati.ruolo;
    if (utenteDati.aspetto && window.temaApp) window.temaApp.daProfilo(utenteDati.aspetto);
    if (RUOLO === "professionista") {
      avviaProfessionista(utenteDati);
    } else if (RUOLO === "familiare") {
      avviaFamiliare(utenteDati);
    } else {
      avviaPaziente(utenteDati);
    }
  }

  function mostraSchermata(nome) {
    elAuthLoading.hidden = nome !== "loading";
    elAuthScreen.hidden = nome !== "login";
    elAppPaziente.hidden = nome !== "paziente";
    elAppProfessionista.hidden = nome !== "professionista";
  }

  function pulisciListenerCloud() {
    if (unsubPiano) { unsubPiano(); unsubPiano = null; }
    scollegaMisure();
    if (unsubPastiOggi) { unsubPastiOggi(); unsubPastiOggi = null; }
    scollegaSpesa();
    azzeraStatistiche();
    scollegaRicette();
    scollegaRicettario();
    scollegaRichiestePaziente();
    scollegaRichiesteProfessionista();
    scollegaListaCasa();
    document.body.classList.remove("ruolo-familiare");
    if (unsubPazienti) { unsubPazienti(); unsubPazienti = null; }
    pazienteSelezionatoId = null;
    vistaProfCorrente = "lista"; segnaVistaProf("lista");
  }

  // ---------------------------------------------------------------------
  // Form di accesso / registrazione professionista
  // ---------------------------------------------------------------------
  function collegaFormAutenticazione() {
    document.getElementById("form-login").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("auth-email").value;
      const password = document.getElementById("auth-password").value;
      const errEl = document.getElementById("auth-error");
      errEl.hidden = true;
      const btn = document.getElementById("btn-auth-submit");
      btn.disabled = true;
      btn.textContent = "Accesso in corso…";
      try {
        await window.cloud.login(email, password);
        // onAuthStateChanged gestisce il resto.
      } catch (err) {
        mostraErroreIn("auth-error", traduciErroreAuth(err));
      } finally {
        btn.disabled = false;
        btn.textContent = "Accedi";
      }
    });

    document.getElementById("btn-password-dimenticata").addEventListener("click", async () => {
      const email = document.getElementById("auth-email").value;
      if (!email) {
        mostraErroreIn("auth-error", "Scrivi prima la tua email nel campo sopra.");
        return;
      }
      try {
        await window.cloud.resetPassword(email);
        mostraErroreIn("auth-error", "Email per reimpostare la password inviata — controlla la posta.");
      } catch (err) {
        mostraErroreIn("auth-error", traduciErroreAuth(err));
      }
    });

    // Passaggio tra "accesso" e "registrazione professionista": oltre ai due
    // moduli cambiano anche il sottotitolo e il link "Password dimenticata?",
    // che riguarda solo l'accesso.
    const SUB_ACCESSO = "Accedi con le credenziali che ti ha fornito il tuo nutrizionista.";
    const SUB_REGISTRAZIONE = "Crea il tuo account professionista: dopo potrai aggiungere i tuoi pazienti.";
    function modalitaRegistrazione(attiva) {
      document.getElementById("blocco-signup-professionista").hidden = attiva;
      document.getElementById("blocco-signup-familiare").hidden = attiva;
      document.getElementById("blocco-signup-paziente").hidden = attiva || !REGISTRAZIONE_PAZIENTE_APERTA;
      document.getElementById("form-login").hidden = attiva;
      document.getElementById("btn-password-dimenticata").hidden = attiva;
      document.getElementById("form-signup").hidden = !attiva;
      document.getElementById("auth-sub").textContent = attiva ? SUB_REGISTRAZIONE : SUB_ACCESSO;
    }
    document.getElementById("btn-mostra-signup").addEventListener("click", () => modalitaRegistrazione(true));

    // Registrazione del paziente autonomo. Il pulsante pubblico compare solo
    // se config.json ha "registrazionePaziente": true; nel frattempo la si
    // prova aprendo l'app con l'indirizzo che finisce in #nuovo-paziente.
    const SUB_PAZIENTE = "Crea il tuo account: poi carichi il piano del tuo nutrizionista.";
    function modalitaPaziente(attiva) {
      ["blocco-signup-professionista", "blocco-signup-familiare", "blocco-signup-paziente", "form-login", "btn-password-dimenticata"]
        .forEach((id) => { document.getElementById(id).hidden = attiva || (id === "blocco-signup-paziente" && !REGISTRAZIONE_PAZIENTE_APERTA); });
      document.getElementById("form-signup-paziente").hidden = !attiva;
      document.getElementById("auth-sub").textContent = attiva ? SUB_PAZIENTE : SUB_ACCESSO;
    }
    document.getElementById("btn-mostra-signup-paziente").addEventListener("click", () => modalitaPaziente(true));
    document.getElementById("btn-annulla-signup-paziente").addEventListener("click", () => modalitaPaziente(false));
    document.getElementById("form-signup-paziente").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("btn-signup-paziente");
      document.getElementById("paz-error").hidden = true;
      btn.disabled = true; btn.textContent = "Creazione in corso…";
      ATTESA_REGISTRAZIONE = window.cloud.registraPaziente(
        document.getElementById("paz-email").value,
        document.getElementById("paz-password").value,
        document.getElementById("paz-nome").value,
        {
          maggiorenne: document.getElementById("paz-cons-maggiorenne").checked,
          salute: document.getElementById("paz-cons-salute").checked,
          ai: document.getElementById("paz-cons-ai").checked,
        }
      );
      try {
        await ATTESA_REGISTRAZIONE;
      } catch (err) {
        mostraErroreIn("paz-error", traduciErroreAuth(err));
      } finally {
        ATTESA_REGISTRAZIONE = null;
        btn.disabled = false; btn.textContent = "Crea account";
      }
    });
    if (/^#nuovo-paziente/.test(location.hash)) modalitaPaziente(true);

    // Registrazione del familiare (solo spesa condivisa)
    const SUB_FAMILIARE = "Crea il tuo account per la spesa condivisa: vedrai solo la lista della spesa di casa.";
    function modalitaFamiliare(attiva) {
      document.getElementById("blocco-signup-professionista").hidden = attiva;
      document.getElementById("blocco-signup-familiare").hidden = attiva;
      document.getElementById("blocco-signup-paziente").hidden = attiva || !REGISTRAZIONE_PAZIENTE_APERTA;
      document.getElementById("form-login").hidden = attiva;
      document.getElementById("btn-password-dimenticata").hidden = attiva;
      document.getElementById("form-signup-familiare").hidden = !attiva;
      document.getElementById("auth-sub").textContent = attiva ? SUB_FAMILIARE : SUB_ACCESSO;
    }
    document.getElementById("btn-mostra-signup-familiare").addEventListener("click", () => modalitaFamiliare(true));
    document.getElementById("btn-annulla-signup-familiare").addEventListener("click", () => modalitaFamiliare(false));
    document.getElementById("form-signup-familiare").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type="submit"]');
      document.getElementById("fam-error").hidden = true;
      btn.disabled = true;
      try {
        await window.cloud.registraFamiliare(
          document.getElementById("fam-email").value,
          document.getElementById("fam-password").value,
          document.getElementById("fam-nome").value
        );
      } catch (err) {
        mostraErroreIn("fam-error", traduciErroreAuth(err));
      } finally {
        btn.disabled = false;
      }
    });
    if (sessionStorage.getItem(LS_INVITO)) {
      const avviso = document.getElementById("avviso-invito");
      avviso.hidden = false;
    }
    document.getElementById("btn-annulla-signup").addEventListener("click", () => modalitaRegistrazione(false));

    // Link legali presi da config.json (così si cambiano in un posto solo)
    caricaConfig().then((c) => {
      REGISTRAZIONE_PAZIENTE_APERTA = c.registrazionePaziente === true;
      if (REGISTRAZIONE_PAZIENTE_APERTA && document.getElementById("form-signup-paziente").hidden
        && !document.getElementById("form-login").hidden) {
        document.getElementById("blocco-signup-paziente").hidden = false;
      }
      const mappa = { privacy: c.linkPrivacy, termini: c.linkTermini, dpa: c.linkAccordoDati };
      document.querySelectorAll("[data-link]").forEach((a) => { if (mappa[a.dataset.link]) a.href = mappa[a.dataset.link]; });
    });

    // Link dal sito "Inizia la prova gratuita": index.html#registrati(&email=...)
    if (/^#registrati/.test(location.hash)) {
      modalitaRegistrazione(true);
      const m = location.hash.match(/email=([^&]+)/);
      if (m) document.getElementById("signup-email").value = decodeURIComponent(m[1]);
    }

    document.getElementById("form-signup").addEventListener("submit", async (e) => {
      e.preventDefault();
      const nome = document.getElementById("signup-nome").value;
      const email = document.getElementById("signup-email").value;
      const password = document.getElementById("signup-password").value;
      const errEl = document.getElementById("signup-error");
      errEl.hidden = true;
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        await window.cloud.registraProfessionista(email, password, nome);
      } catch (err) {
        mostraErroreIn("signup-error", traduciErroreAuth(err));
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("btn-logout-paziente").addEventListener("click", eseguiLogout);
    document.getElementById("btn-logout-prof").addEventListener("click", eseguiLogout);
  }

  async function eseguiLogout() {
    // prima di uscire: il telefono non deve più ricevere i promemoria di questo account
    if (UID) {
      const scollega = window.cloud.scollegaDispositivo(UID).catch(() => {});
      await Promise.race([scollega, new Promise((r) => setTimeout(r, 4000))]);
    }
    try { localStorage.setItem(LS_KEYS.notifiche, "0"); } catch (e) { /* niente */ }
    dispositivoRinnovato = false;
    if (unsubProfilo) { unsubProfilo(); unsubProfilo = null; }
    pulisciListenerCloud();
    await window.cloud.logout();
  }

  function mostraErroreIn(id, msg) {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.hidden = false;
  }

  function traduciErroreAuth(err) {
    const code = err && err.code;
    const mappa = {
      "auth/invalid-email": "Email non valida.",
      "auth/user-not-found": "Nessun account con questa email.",
      "auth/wrong-password": "Password errata.",
      "auth/invalid-credential": "Email o password errate.",
      "auth/email-already-in-use": "Esiste già un account con questa email.",
      "auth/weak-password": "Password troppo debole (minimo 6 caratteri).",
      "auth/too-many-requests": "Troppi tentativi, riprova tra qualche minuto.",
      "auth/network-request-failed": "Problema di connessione.",
      "functions/unavailable": "Servizio non raggiungibile: controlla la connessione e riprova.",
      "functions/internal": "Il server non ha risposto correttamente. Riprova tra poco.",
      "functions/already-exists": "Esiste già un profilo per questo account.",
      "permission-denied": "Permesso negato da Firestore: controlla di aver pubblicato le regole di sicurezza corrette nella console Firebase.",
    };
    return (code && mappa[code]) || "Si è verificato un errore imprevisto. Riprova.";
  }

  // =======================================================================
  // LATO PAZIENTE
  // =======================================================================
  // ---------------------------------------------------------------------
  // Informativa al primo accesso (paziente e familiare)
  // ---------------------------------------------------------------------
  // Presa visione, non consenso: il titolare dei dati del paziente è il suo
  // nutrizionista, che resta tenuto a fornire la propria informativa. Se
  // l'informativa cambia in modo rilevante, basta alzare la versione e la
  // schermata ricompare una volta.
  const VERSIONE_INFORMATIVA = "2026-10-08";
  const URL_INFORMATIVA = "https://ilmiopiano.it/privacy.html";

  function mostraInformativaPrimoAccesso(utenteDati, ruolo) {
    if (!utenteDati || utenteDati.informativaVersione === VERSIONE_INFORMATIVA) return;
    if (document.getElementById("informativa-primo-accesso")) return;
    const familiare = ruolo === "familiare";
    const autonomo = !familiare && !!utenteDati.autonomo && !utenteDati.professionistaUid;
    const box = document.createElement("div");
    box.id = "informativa-primo-accesso";
    box.className = "informativa-primo";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "informativa-titolo");
    box.innerHTML = `
      <div class="informativa-primo__carta">
        <h2 id="informativa-titolo">Benvenuto in Il mio Piano</h2>
        <p class="informativa-primo__intro">Prima di iniziare, ecco in breve come vengono trattati i tuoi dati.</p>
        <ul>
          ${familiare ? `
          <li>Con l'account familiare usi solo la <strong>lista della spesa condivisa</strong>. I dati del tuo account (nome, email, lista) sono trattati da <strong>Bulli e Pupe S.r.l.</strong>, che gestisce l'app.</li>
          <li>Non vedi i piani, le misure o le note dei pazienti: solo gli alimenti della lista di casa.</li>` : autonomo ? `
          <li>Il piano che carichi, i pasti che segni, le tue note e le misure sono trattati da <strong>Bulli e Pupe S.r.l.</strong>, che gestisce l'app ed è titolare di questi dati. Servono solo a farti seguire il piano.</li>
          <li>Alcune funzioni usano l'<strong>intelligenza artificiale</strong> (Anthropic): la lettura del piano dal PDF e i consigli sui pasti non come da piano. Vengono inviati solo i testi del piano e dei pasti, senza nome né altri dati identificativi.</li>
          <li>Se ti colleghi a un nutrizionista con il suo codice, lui vedrà il tuo piano e il tuo andamento.</li>` : `
          <li>Il piano, i pasti che segni, le tue note, le misure e gli appuntamenti sono trattati dal <strong>tuo nutrizionista</strong>, che ne è il titolare. <strong>Bulli e Pupe S.r.l.</strong> gestisce l'app per suo conto. Il tuo nutrizionista ti fornisce anche la sua informativa.</li>
          <li>Alcune funzioni usano l'<strong>intelligenza artificiale</strong> (Anthropic): per esempio il riscontro sui pasti non come da piano. In quei casi vengono inviati solo i testi dei pasti e le tue note, senza nome né altri dati identificativi. Il tuo nutrizionista può disattivarle.</li>`}
          <li>I dati sono conservati su server nell'Unione Europea e protetti da accesso personale. Puoi esercitare i tuoi diritti (accesso, correzione, cancellazione) ${familiare || autonomo ? "scrivendo a info@ilmiopiano.it" : "tramite il tuo nutrizionista o scrivendo a info@ilmiopiano.it"}.</li>
        </ul>
        <p><a href="${URL_INFORMATIVA}" target="_blank" rel="noopener" class="link-inline">Leggi l'informativa completa ↗</a></p>
        <button type="button" class="btn" id="informativa-ok">Ho letto, continua</button>
      </div>`;
    document.body.appendChild(box);
    document.body.classList.add("con-informativa");
    box.querySelector("#informativa-ok").addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try { await window.cloud.segnaInformativaVista(UID, VERSIONE_INFORMATIVA); } catch (err) { /* si riproporrà al prossimo accesso */ }
      box.remove();
      document.body.classList.remove("con-informativa");
    });
  }

  async function avviaPaziente(utenteDati) {
    AUTONOMO = !!utenteDati.autonomo;
    PARAMETRI_ALLENAMENTO = Object.assign({}, utenteDati.parametriAllenamento || {});
    CONSENSO_AI = !(utenteDati.consensi && utenteDati.consensi.ai && utenteDati.consensi.ai.si === false);
    mostraSchermata("paziente");
    aggiornaPremium().then(() => caricaReseAI());
    if (!avviaPaziente.collegato) {
      avviaPaziente.collegato = true;
      document.addEventListener("click", (e) => {
        if (e.target.closest("[data-premium]")) { apriPremium(); return; }
        const cotto = e.target.closest("[data-cotto]");
        if (cotto) apriPesoCotto(cotto.dataset.cotto, cotto.dataset.cottoPasto);
      });
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") aggiornaPremium(); });
    }
    mostraInformativaPrimoAccesso(utenteDati, "paziente");
    migraDominioSeServe(utenteDati);
    rinnovaDispositivoNotifiche(utenteDati);
    setTimeout(controllaAllenamentoCondiviso, 1200);
    if (!window.temaApp) applyTema(localStorage.getItem(LS_KEYS.tema) || "sistema");
    CONFIG = await caricaConfig();
    aggiornaEyebrowData();
    registraServiceWorker();
    collegaTabbar();

    // Piano in tempo reale: si aggiorna da solo se il professionista lo modifica,
    // anche da un altro dispositivo — questo è il "cloud sync" richiesto.
    unsubPiano = window.cloud.ascoltaPianoPaziente(UID, (piano) => {
      // se il piano programmato è già partito vale quello (il server lo rende definitivo di notte)
      PIANO_GREZZO = piano;
      PIANO_ATTIVO = piano ? window.weekLogic.pianoEffettivo(piano, new Date()) : piano;
      if (piano) collegaRicettePaziente();
      if (piano) richiediStimeRese();
      if (piano) pubblicaPianoInLista();
      collegaMisurePaziente();
      if (currentView === "oggi" || currentView === "settimana" || currentView === "impostazioni") render();
    });
    collegaAscoltoPastiOggi();
    collegaRichiestePaziente();
    LISTA.nomeUtente = String(utenteDati.nome || "").trim().split(/\s+/)[0];
    collegaListaCasa(utenteDati.listaCasa || null);
    gestisciInvitoInSospeso();

    // Notifiche push ricevute mentre l'app è aperta: quelle ad app chiusa le
    // mostra invece il service worker (vedi service-worker.js).
    window.cloud.onMessaggioPrimoPiano((payload) => {
      const n = payload && payload.notification;
      if (n) mostraNotifica(n.title || "Promemoria", n.body || "");
    });

    if (notificheAttive()) {
      pianificaNotificheOggi();
      mostraPromemoriaPerso();
      // Ri-registra il token a ogni avvio: su alcuni browser scade o cambia,
      // e comunque un nuovo dispositivo deve comunque registrarsi.
      sincronizzaPreferenzeNotifichePush().catch(() => {});
    }
    aggiornaIconaCampanella();
    render();
    registraAccessoSeServe();

    setInterval(controllaCambioGiorno, 60 * 1000);

    // Su iPhone un'app in background viene "congelata": timer e intervalli si
    // fermano. Quando torna in primo piano ricontrolliamo giorno e promemoria.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || RUOLO !== "paziente") return;
      controllaCambioGiorno();
      registraAccessoSeServe();
      if (notificheAttive()) {
        pianificaNotificheOggi();
        mostraPromemoriaPerso();
      }
    });
  }

  /**
   * Registra su Firestore l'apertura dell'app (al massimo ogni 30 minuti):
   * il professionista la vede nelle statistiche e nell'avviso di abbandono.
   */
  function registraAccessoSeServe() {
    const ultimo = Number(localStorage.getItem(LS_KEYS.ultimoAccessoInviato) || 0);
    if (Date.now() - ultimo < 30 * 60 * 1000) return;
    localStorage.setItem(LS_KEYS.ultimoAccessoInviato, String(Date.now()));
    window.cloud.registraAccesso(UID).catch(() => localStorage.removeItem(LS_KEYS.ultimoAccessoInviato));
  }

  function controllaCambioGiorno() {
    const oggi = new Date().toDateString();
    if (oggi !== ultimoGiornoRenderizzato) {
      ultimoGiornoRenderizzato = oggi;
      aggiornaEyebrowData();
      collegaAscoltoPastiOggi();
      render();
      if (notificheAttive()) pianificaNotificheOggi();
    }
  }

  let ultimoGiornoRenderizzato = new Date().toDateString();

  async function caricaConfig() {
    try {
      const res = await fetch("config.json", { cache: "no-store" });
      if (!res.ok) throw new Error("config.json non trovato");
      const remoto = await res.json();
      return Object.assign({}, DEFAULT_CONFIG, remoto, {
        orari: Object.assign({}, DEFAULT_CONFIG.orari, remoto.orari),
      });
    } catch (e) {
      return DEFAULT_CONFIG;
    }
  }

  function orariEffettivi() {
    const override = JSON.parse(localStorage.getItem(LS_KEYS.orari) || "null");
    return Object.assign({}, CONFIG.orari, override || {});
  }

  /** Minuti di anticipo del promemoria rispetto all'orario del pasto (10/15/20/30, salvato per dispositivo). */
  function anticipoMinutiEffettivo() {
    const v = parseInt(localStorage.getItem(LS_KEYS.anticipo), 10);
    return ANTICIPI_VALIDI.includes(v) ? v : ANTICIPO_DEFAULT;
  }

  // ---------------------------------------------------------------------
  // Navigazione (tabbar paziente)
  // ---------------------------------------------------------------------
  function collegaTabbar() {
    document.querySelectorAll(".tabbar__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.view === "ricette" && currentView === "ricette") RIC.aperta = null;
        currentView = btn.dataset.view;
        document.querySelectorAll(".tabbar__btn").forEach((b) => b.classList.toggle("is-active", b === btn));
        render();
      });
    });
    document.getElementById("btn-notifiche").addEventListener("click", onToggleNotificheRapido);
  }

  // Link di navigazione del pannello professionista: pillole con icona
  const ICONE_NAV = {
    pazienti: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.2c2.4.1 4.3 1.6 4.9 4.3"/></svg>',
    andamento: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><rect x="5.5" y="11" width="3" height="6" rx="1"/><rect x="10.5" y="7" width="3" height="10" rx="1"/><rect x="15.5" y="4" width="3" height="13" rx="1"/></svg>',
    ricettario: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5h10.5a3 3 0 0 1 3 3v12h-12a1.5 1.5 0 0 1-1.5-1.5V4.5Z"/><path d="M5 18a1.5 1.5 0 0 1 1.5-1.5h12M9 8.5h6M9 11.5h4"/></svg>',
    piano: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M8.5 10h7M8.5 13.5h7M8.5 17h4"/></svg>',
  };
  function navLink(id, icona, testo, indietro) {
    return `<button type="button" class="nav-link ${indietro ? "nav-link--indietro" : ""}" id="${id}">`
      + (indietro ? '<span class="nav-link__freccia" aria-hidden="true">‹</span>' : "")
      + `<span class="nav-link__icona" aria-hidden="true">${ICONE_NAV[icona]}</span><span>${testo}</span></button>`;
  }

  /** Segna la schermata del professionista (serve all'impaginazione desktop). */
  function segnaVistaProf(vista) {
    const el = document.getElementById("prof-root");
    if (el) el.dataset.vista = vista;
  }

  /**
   * Testo di un pasto per la visualizzazione. I pasti scritti su più righe
   * (un alimento per riga, con "e" / "o" tra una riga e l'altra) restano su
   * più righe, con un piccolo "oppure" tra le alternative.
   */
  function testoPastoHTML(testo) {
    const t = String(testo || "").replace(/\r/g, "");
    if (!/\n/.test(t.trim())) return escapeHTML(t);
    const pezzi = [];
    t.split("\n").map((r) => r.trim()).forEach((r) => {
      if (!r || r === ".") return;
      if (/^(o|0|oppure)$/i.test(r)) { pezzi.push('<span class="meal__oppure">oppure</span>'); return; }
      if (/^(e|ed|\+)$/i.test(r)) return;
      const inizioO = r.match(/^(o|0|oppure)\s+/i);
      if (inizioO) { pezzi.push('<span class="meal__oppure">oppure</span>'); r = r.slice(inizioO[0].length); }
      pezzi.push(`<span class="meal__riga">${escapeHTML(r)}</span>`);
    });
    return pezzi.join("");
  }

  function render() {
    root.dataset.vista = currentView;
    if (currentView === "oggi") renderOggi();
    else if (currentView === "settimana") renderSettimana();
    else if (currentView === "spesa") renderSpesa();
    else if (currentView === "ricette") renderRicette();
    else if (currentView === "mioPiano") renderMioPiano();
    else renderImpostazioni();
  }

  function aggiornaEyebrowData() {
    const oggi = new Date();
    dataOggiEl.textContent = oggi.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
  }

  // ---------------------------------------------------------------------
  // Vista "Oggi"
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // Paziente autonomo: il suo piano (importazione da PDF o foto, a mano)
  // ---------------------------------------------------------------------
  const DA_COMPILARE = "Da compilare";
  const EDITOR_PAZ = { settSel: 1, giornoSel: 0, ritorno: "oggi" };
  let PROVA_RICHIESTA = false;

  // ---- Premium ----
  // Lo stato lo decide il server (statoPremium): abbonamento, prova di 14
  // giorni o nutrizionista con licenza attiva. Finché non è noto non si
  // blocca nulla; i limiti veri li applica comunque il server.
  const PREMIUM = { noto: false, attivo: true, origine: null, scadenza: null, provaUsata: false };
  let AUTONOMO = false;
  const LS_FINE_PROVA = "pnut:fine-prova-vista";

  function premiumLimitato() { return RUOLO === "paziente" && PREMIUM.noto && !PREMIUM.attivo; }

  function giorniProvaRimasti() {
    if (!PREMIUM.attivo || PREMIUM.origine !== "prova" || !PREMIUM.scadenza) return null;
    return Math.max(1, Math.ceil((PREMIUM.scadenza - Date.now()) / 86400000));
  }

  let TENTATIVI_PREMIUM = 0;
  async function aggiornaPremium(ridisegna) {
    if (RUOLO !== "paziente") return;
    const prima = JSON.stringify([PREMIUM.noto, PREMIUM.attivo, PREMIUM.origine, PREMIUM.scadenza, PREMIUM.errore]);
    try {
      if (!window.cloud.chiamaFunzione) throw { code: "app-non-aggiornata" };
      const r = await window.cloud.chiamaFunzione("statoPremium");
      if (!r || typeof r.attivo !== "boolean") throw { code: "risposta-non-valida" };
      Object.assign(PREMIUM, r, { noto: true, errore: null });
      TENTATIVI_PREMIUM = 0;
    } catch (e) {
      PREMIUM.errore = String((e && (e.code || e.message)) || "errore");
      // nuovo tentativo automatico dopo 5, 15 e 45 secondi
      if (TENTATIVI_PREMIUM < 3) { const attesa = [5, 15, 45][TENTATIVI_PREMIUM++] * 1000; setTimeout(() => aggiornaPremium(), attesa); }
    }
    const dopo = JSON.stringify([PREMIUM.noto, PREMIUM.attivo, PREMIUM.origine, PREMIUM.scadenza, PREMIUM.errore]);
    if ((ridisegna || prima !== dopo) && ["oggi", "spesa", "impostazioni", "mioPiano"].includes(currentView)) {
      try { render(); } catch (e) { console.warn(e); }
    }
    if (PREMIUM.noto) controllaFineProva();
    if (PREMIUM.noto && PREMIUM.attivo) richiediStimeRese();
  }

  const FUNZIONI_PREMIUM = [
    ["✨", "Lettura del piano con l'AI", "carichi il nuovo piano dal PDF o dalle foto in un minuto, a ogni cambio di stagione"],
    ["💡", "Consigli quando un pasto cambia", "come riequilibrare la giornata quando mangi fuori o salti un pasto"],
    ["🛒", "Lista della spesa della settimana", "tutta la settimana, divisa in una o due spese, condivisibile in famiglia"],
    ["🥡", "Meal prep", "cosa preparare in anticipo per i pasti della settimana"],
    ["📈", "Andamento completo", "grafico del peso e storico delle misure"],
    ["⚖️", "Peso da crudo a cotto", "quanto deve pesare il cibo già cotto quando non puoi pesarlo prima di cucinarlo"],
    ["📅", "Piano successivo programmato", "carichi il nuovo piano in anticipo: parte da solo nel giorno giusto, il vecchio resta in archivio"],
    ["📄", "Riepilogo per la visita", "un PDF con pasti, cambiamenti, peso e note da portare o inviare al nutrizionista"],
  ];

  function bannerPremiumHTML() {
    if (!AUTONOMO || RUOLO !== "paziente") return "";
    const giorni = giorniProvaRimasti();
    if (giorni == null) return "";
    return `<button type="button" class="banner-prova" data-premium><span class="banner-prova__testo">Prova Premium · ${giorni === 1 ? "ultimo giorno" : `ancora ${giorni} giorni`}</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>`;
  }

  function bloccoPremiumHTML(testo) {
    return `<button type="button" class="blocco-premium" data-premium><span>🔒 ${escapeHTML(testo)}</span><strong>Premium</strong></button>`;
  }

  function apriPremium() {
    const giorni = giorniProvaRimasti();
    const stato = !PREMIUM.noto ? "Non riesco a verificare il tuo stato Premium in questo momento."
      : PREMIUM.attivo
      ? (PREMIUM.origine === "nutrizionista" ? "Premium è incluso perché sei seguito dal tuo nutrizionista."
        : giorni != null ? `Sei in prova: ${giorni === 1 ? "oggi è l'ultimo giorno" : `ancora ${giorni} giorni`}.` : "Premium è attivo.")
      : PREMIUM.provaUsata ? "La prova gratuita è terminata: ora usi la versione gratuita." : "Stai usando la versione gratuita.";
    apriSheet(`
      <h2 class="sheet__titolo">Il mio Piano Premium</h2>
      <p class="sheet__nota">${escapeHTML(stato)}</p>
      <ul class="premium-elenco">${FUNZIONI_PREMIUM.map(([i, t, d]) => `<li><span>${i}</span><div><strong>${escapeHTML(t)}</strong><small>${escapeHTML(d)}</small></div></li>`).join("")}</ul>
      <p class="premium-prezzo">2,99 € al mese oppure <strong>19,99 € all'anno</strong></p>
      ${PREMIUM.attivo && PREMIUM.origine !== "prova" ? "" : `<p class="hint">L'abbonamento si attiverà dall'app scaricata da Google Play o App Store, in arrivo a breve.</p>`}
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Chiudi</button>`);
  }

  /** Alla scadenza della prova, una volta sola: cosa ha usato e cosa si perde. */
  function controllaFineProva() {
    if (!AUTONOMO || !PREMIUM.noto || PREMIUM.attivo || !PREMIUM.provaUsata) return;
    const chiave = `${LS_FINE_PROVA}:${UID}`;
    if (localStorage.getItem(chiave)) return;
    localStorage.setItem(chiave, "1");
    const pesate = (MISURE.lista || []).length;
    const usate = [
      "il piano letto e caricato nell'app",
      pesate ? `${pesate} ${pesate === 1 ? "misura registrata" : "misure registrate"} con il grafico dell'andamento` : null,
      "la lista della spesa di tutta la settimana e il meal prep",
      "i consigli quando un pasto va diversamente",
    ].filter(Boolean);
    apriSheet(`
      <h2 class="sheet__titolo">La prova Premium è terminata</h2>
      <p class="sheet__nota">In questi 14 giorni hai avuto:</p>
      <ul class="premium-elenco premium-elenco--semplice">${usate.map((u) => `<li>✓ ${escapeHTML(u)}</li>`).join("")}</ul>
      <p class="sheet__nota">Il menù del giorno, i promemoria dei pasti e le spunte restano gratuiti. Lettura del piano con l'AI, consigli sui pasti, lista della settimana, meal prep e andamento completo richiedono Premium.</p>
      <p class="premium-prezzo">2,99 € al mese oppure <strong>19,99 € all'anno</strong></p>
      <p class="hint">L'abbonamento si attiverà dall'app scaricata da Google Play o App Store, in arrivo a breve.</p>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Continua con la versione gratuita</button>`);
  }

  // ---- Collegamento al nutrizionista con il codice studio ----
  function nutrizionistaSezioneHTML() {
    const collegato = PIANO_ATTIVO && PIANO_ATTIVO.professionistaUid;
    if (collegato) {
      const c = contattiNutrizionistaCorrenti().nome || "il tuo nutrizionista";
      return `
      <section class="settings-section" id="sezione-nutrizionista">
        <h2>Il tuo nutrizionista</h2>
        <p class="hint">Sei collegato a <strong>${escapeHTML(c)}</strong>: vede il tuo piano e il tuo andamento e aggiorna lui il piano. Premium è incluso finché ha la licenza attiva.</p>
        <button type="button" class="btn btn--ghost" id="btn-scollega-nutrizionista">Scollegati</button>
      </section>`;
    }
    return `
      <section class="settings-section" id="sezione-nutrizionista">
        <h2>Il tuo nutrizionista</h2>
        <p class="hint">Il tuo nutrizionista usa Il mio Piano? Inserisci il suo codice studio: vedrà il tuo piano e il tuo andamento, potrà aggiornarti il piano e Premium sarà incluso.</p>
        <label class="editor-campo"><span>Codice studio</span><input type="text" id="codice-nutrizionista" maxlength="6" autocapitalize="characters" autocomplete="off" placeholder="Es. K7M2QX" style="text-transform:uppercase; letter-spacing:2px;"></label>
        <p class="auth-error" id="errore-collegamento" hidden></p>
        <button type="button" class="btn" id="btn-collega-nutrizionista" style="margin-top:8px;">Collegati</button>
      </section>`;
  }

  function erroreCollegamento(e) {
    const m = String((e && e.message) || "");
    if (/codice-non-valido/.test(m)) return "Il codice è di 6 caratteri, lettere e numeri: controllalo.";
    if (/codice-non-trovato/.test(m)) return "Nessun nutrizionista con questo codice: controllalo con lui.";
    if (/licenza-nutrizionista-non-attiva/.test(m)) return "Il nutrizionista non ha in questo momento un abbonamento attivo: avvisalo.";
    if (/limite-nutrizionista/.test(m)) return "Il nutrizionista ha raggiunto il numero massimo di pazienti del suo abbonamento: avvisalo.";
    if (/gia-collegato/.test(m)) return "Sei già collegato a un nutrizionista.";
    return "Collegamento non riuscito: controlla la connessione e riprova.";
  }

  function collegaSezioneNutrizionista() {
    const collega = document.getElementById("btn-collega-nutrizionista");
    if (collega) collega.addEventListener("click", async () => {
      const codice = document.getElementById("codice-nutrizionista").value.trim().toUpperCase();
      const err = document.getElementById("errore-collegamento");
      err.hidden = true;
      if (!/^[A-Z0-9]{6}$/.test(codice)) { err.textContent = erroreCollegamento({ message: "codice-non-valido" }); err.hidden = false; return; }
      if (!window.confirm("Collegarti a questo nutrizionista? Vedrà il tuo piano, i pasti segnati e le misure, e da quel momento sarà lui ad aggiornare il piano.")) return;
      collega.disabled = true; collega.textContent = "Collegamento…";
      try {
        const r = await window.cloud.chiamaFunzione("collegaNutrizionista", { codice });
        mostraToast(r && r.nutrizionista ? `Collegato a ${r.nutrizionista}` : "Collegato al tuo nutrizionista", 3500);
        setTimeout(() => location.reload(), 1200);
      } catch (e) {
        err.textContent = erroreCollegamento(e); err.hidden = false;
        collega.disabled = false; collega.textContent = "Collegati";
      }
    });
    const scollega = document.getElementById("btn-scollega-nutrizionista");
    if (scollega) scollega.addEventListener("click", async () => {
      if (!window.confirm("Scollegarti dal tuo nutrizionista? Il piano resta nell'app e torni a gestirlo tu; lui non vedrà più i tuoi dati e Premium non sarà più incluso.")) return;
      scollega.disabled = true;
      try {
        await window.cloud.chiamaFunzione("scollegaNutrizionista");
        mostraToast("Scollegato: ora gestisci tu il tuo piano", 3500);
        setTimeout(() => location.reload(), 1200);
      } catch (e) {
        scollega.disabled = false;
        mostraToast("Non riuscito: controlla la connessione e riprova", 4000);
      }
    });
  }

  // ---- Eliminazione dell'account (paziente e familiare) ----
  function eliminaAccountSezioneHTML() {
    if (RUOLO !== "paziente" && RUOLO !== "familiare") return "";
    return `
      <section class="settings-section">
        <h2>Il tuo account</h2>
        <p class="hint">Puoi eliminare il tuo account in qualsiasi momento: vengono cancellati${RUOLO === "paziente" ? " il piano, i pasti segnati, le note, le misure" : ""} e i dati di accesso. L'operazione non si può annullare.</p>
        <button type="button" class="btn btn--ghost btn--pericolo" id="btn-elimina-account">Elimina il mio account</button>
      </section>`;
  }

  function collegaEliminaAccount() {
    const btn = document.getElementById("btn-elimina-account");
    if (!btn) return;
    btn.addEventListener("click", () => {
      apriSheet(`
        <h2 class="sheet__titolo">Eliminare l'account?</h2>
        <p class="sheet__nota">Vengono cancellati definitivamente tutti i tuoi dati${PIANO_ATTIVO && PIANO_ATTIVO.professionistaUid && !AUTONOMO ? ", anche quelli che vede il tuo nutrizionista" : ""}. Per confermare scrivi <strong>ELIMINA</strong>.</p>
        <label class="editor-campo"><input type="text" id="conferma-elimina-account" autocomplete="off" autocapitalize="characters"></label>
        <p class="auth-error" id="errore-elimina-account" hidden></p>
        <button type="button" class="btn btn--pericolo" id="btn-conferma-elimina-account" disabled>Elimina definitivamente</button>
        <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>`);
      const input = document.getElementById("conferma-elimina-account");
      const conferma = document.getElementById("btn-conferma-elimina-account");
      input.addEventListener("input", () => { conferma.disabled = input.value.trim().toUpperCase() !== "ELIMINA"; });
      conferma.addEventListener("click", async () => {
        conferma.disabled = true; conferma.textContent = "Eliminazione in corso…";
        document.querySelectorAll("#sheet-overlay [data-chiudi-sheet]").forEach((b) => (b.disabled = true));
        try {
          await window.cloud.chiamaFunzione("eliminaAccount");
          chiudiSheet();
          await window.cloud.logout().catch(() => {});
          mostraToast("Account eliminato. Grazie per aver usato Il mio Piano.", 5000);
        } catch (e) {
          const err = document.getElementById("errore-elimina-account");
          err.textContent = /professionista/.test(String(e && e.message)) ? "Per eliminare un account professionista scrivi a info@ilmiopiano.it." : "Eliminazione non riuscita: controlla la connessione e riprova.";
          err.hidden = false;
          conferma.disabled = false; conferma.textContent = "Elimina definitivamente";
          document.querySelectorAll("#sheet-overlay [data-chiudi-sheet]").forEach((b) => (b.disabled = false));
        }
      });
      input.focus();
    });
  }

  // ---- Peso da crudo a cotto (Premium) ----
  const fmtG = (g) => `${g} g`;
  // Archivio comune delle stime AI per gli alimenti fuori tabella LARN
  let RESE_AI = {};
  let RESE_CARICATE = false;
  const RESE_RICHIESTE = new Set();

  async function caricaReseAI() {
    if (RESE_CARICATE || !window.cloud.leggiRese) return;
    try { RESE_AI = (await window.cloud.leggiRese()) || {}; RESE_CARICATE = true; } catch (e) { return; }
    if (currentView === "oggi" || currentView === "settimana") render();
    richiediStimeRese();
  }

  /** In sottofondo: chiede all'AI le rese degli alimenti del piano non ancora stimati (solo Premium). */
  async function richiediStimeRese() {
    if (!RESE_CARICATE || !CONSENSO_AI || !PREMIUM.noto || !PREMIUM.attivo || !PIANO_ATTIVO || !window.conversioni || !window.cloud.chiamaFunzione) return;
    const nomi = new Set();
    Object.values(PIANO_ATTIVO.settimane || {}).forEach((giorni) => (giorni || []).forEach((g) => g && MEAL_KEYS.forEach((k) => {
      window.conversioni.daStimare(g[k], RESE_AI).forEach((n) => { if (!RESE_RICHIESTE.has(n)) nomi.add(n); });
    })));
    const elenco = Array.from(nomi).slice(0, 30);
    if (!elenco.length) return;
    elenco.forEach((n) => RESE_RICHIESTE.add(n));
    let cambiato = false;
    for (let i = 0; i < elenco.length; i += 10) {
      try {
        const r = await window.cloud.chiamaFunzione("stimaRese", { nomi: elenco.slice(i, i + 10) });
        if (r && r.rese) { Object.assign(RESE_AI, r.rese); cambiato = true; }
        if (r && r.limite) break;
      } catch (e) { break; }
    }
    if (cambiato && (currentView === "oggi" || currentView === "settimana")) render();
  }

  // ---- Macronutrienti del giorno (Premium) ----
  // Le stime per pasto stanno nell'archivio comune /macroPasti (chiave = impronta
  // del testo del pasto). Sul dispositivo se ne tiene una copia: le stime non
  // cambiano, quindi ogni pasto si legge dal cloud una volta sola.
  const MACRO_LS = "pnut:macro-pasti";
  let MACRO = {};
  try { MACRO = JSON.parse(localStorage.getItem(MACRO_LS) || "{}") || {}; } catch (e) { MACRO = {}; }
  const MACRO_CHIAVI = new Map();   // testo normalizzato → chiave
  const MACRO_TENTATI = new Set();  // testi già chiesti in questa sessione (non si richiedono in loop)
  let MACRO_IN_CORSO = false;
  let MACRO_LIMITE = false;

  async function chiaveMacro(testo) {
    const dati = new TextEncoder().encode(window.macro.normalizzaPasto(testo));
    const h = await crypto.subtle.digest("SHA-256", dati);
    return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  }

  function macroDisponibile() {
    return RUOLO === "paziente" && CONSENSO_AI && PREMIUM.noto && PREMIUM.attivo && !!PIANO_ATTIVO && !!window.macro
      && !(PIANO_ATTIVO.macro && PIANO_ATTIVO.macro.visibile === false)
      && typeof crypto !== "undefined" && !!crypto.subtle;
  }

  /** In sottofondo: chiavi dei pasti del piano, lettura dall'archivio e stima AI di quelli mancanti (prima quelli di oggi). */
  async function aggiornaMacro(giornoOggi) {
    if (MACRO_IN_CORSO || !macroDisponibile()) return;
    MACRO_IN_CORSO = true;
    let cambiato = false;
    try {
      const M = window.macro;
      const testi = [];
      const visti = new Set();
      const aggiungi = (g) => g && M.CAMPI_PASTO.forEach((k) => {
        if (!M.daStimare(g[k])) return;
        const t = M.normalizzaPasto(g[k]);
        if (!visti.has(t)) { visti.add(t); testi.push(t); }
      });
      aggiungi(giornoOggi);
      Object.values(PIANO_ATTIVO.settimane || {}).forEach((giorni) => (giorni || []).forEach(aggiungi));
      for (const t of testi) {
        if (!MACRO_CHIAVI.has(t)) { MACRO_CHIAVI.set(t, await chiaveMacro(t)); cambiato = true; }
      }
      let mancanti = testi.filter((t) => !MACRO[MACRO_CHIAVI.get(t)] && !MACRO_TENTATI.has(t));
      if (!mancanti.length) return;
      mancanti.forEach((t) => MACRO_TENTATI.add(t));
      if (window.cloud.leggiMacro) {
        const letti = await window.cloud.leggiMacro(mancanti.map((t) => MACRO_CHIAVI.get(t))).catch(() => ({}));
        Object.keys(letti).forEach((k) => { MACRO[k] = M.pulisciStima(letti[k]); cambiato = true; });
        mancanti = mancanti.filter((t) => !MACRO[MACRO_CHIAVI.get(t)]);
      }
      for (let i = 0; i < mancanti.length && !MACRO_LIMITE; i += 20) {
        try {
          const r = await window.cloud.chiamaFunzione("stimaMacro", { testi: mancanti.slice(i, i + 20) });
          if (r && r.macro) Object.keys(r.macro).forEach((k) => { MACRO[k] = M.pulisciStima(r.macro[k]); cambiato = true; });
          if (r && r.limite) MACRO_LIMITE = true;
        } catch (e) { break; }
      }
    } catch (e) {
      // le stime sono un di più: in caso di errore la scheda Oggi resta com'è
    } finally {
      MACRO_IN_CORSO = false;
      if (cambiato) {
        try { localStorage.setItem(MACRO_LS, JSON.stringify(MACRO)); } catch (e) { /* spazio esaurito: si rileggono dal cloud */ }
        if (currentView === "oggi") render();
      }
    }
  }

  /** Riquadro dei macronutrienti nella scheda Oggi: previsti dal piano e coperti dai pasti segnati. */
  function macroOggiHTML(giorno, fatti) {
    if (!macroDisponibile()) return "";
    const M = window.macro;
    const stime = {};
    M.CAMPI_PASTO.forEach((k) => {
      if (!M.daStimare(giorno[k])) return;
      const ch = MACRO_CHIAVI.get(M.normalizzaPasto(giorno[k]));
      if (ch && MACRO[ch]) stime[k] = M.pulisciStima(MACRO[ch]);
    });
    const g = M.macroGiorno(giorno, stime);
    if (!g.completo) {
      if (MACRO_LIMITE || !MACRO_CHIAVI.size) return "";
      return `<section class="macro-oggi macro-oggi--attesa" aria-live="polite"><span class="macro-oggi__titolo">Macronutrienti di oggi</span><p class="hint">Sto calcolando i valori del tuo piano…</p></section>`;
    }
    if (!g.totale.kcal) return "";
    // la coccola non si segna: segue la cena
    const stati = {};
    M.CAMPI_PASTO.forEach((k) => { stati[k] = window.statistiche.statoPasto(fatti, k === "coccola" ? "cena" : k); });
    // pasti fatti diversamente o in parte: la stima del riscontro AI, se c'è
    const effettivi = {};
    M.CAMPI_PASTO.forEach((k) => {
      const r = RISCONTRI.perPasto[k];
      if ((stati[k] === "diverso" || stati[k] === "parziale") && r && r.macroEffettivi) effettivi[k] = M.pulisciStima(r.macroEffettivi);
    });
    const assunti = M.macroAssunti(g, stati, effettivi);
    const pastoLibero = M.CAMPI_PASTO.find((k) => g.pasti[k] && g.pasti[k].libero);
    const righe = [
      { k: "carboidrati", nome: "Carboidrati" },
      { k: "proteine", nome: "Proteine" },
      { k: "grassi", nome: "Grassi" },
    ].map(({ k, nome }) => {
      const prev = g.totale[k];
      const ass = assunti[k];
      const quota = prev > 0 ? Math.min(100, Math.round((ass / prev) * 100)) : 0;
      return `<div class="macro-riga macro-riga--${k}">
          <div class="macro-riga__testa"><span class="macro-riga__nome">${nome}</span><span class="macro-riga__valori"><b>${ass}</b> di ${prev} g</span></div>
          <div class="macro-riga__barra" role="progressbar" aria-label="${nome}" aria-valuemin="0" aria-valuemax="${prev}" aria-valuenow="${ass}"><span style="width:${quota}%"></span></div>
        </div>`;
    }).join("");
    const nota = [
      "Stima indicativa calcolata con l'intelligenza artificiale sui pasti del tuo piano" + (g.fattore !== 1 ? ", proporzionata alle calorie indicate dal nutrizionista." : "."),
      Object.keys(effettivi).length ? "Per i pasti fatti diversamente o in parte uso la stima del riscontro." : "",
    ].filter(Boolean).join(" ");
    const escluso = pastoLibero ? `<span class="macro-oggi__escluso">${pastoLibero === "cena" ? "esclusa la cena libera" : pastoLibero === "pranzo" ? "escluso il pranzo libero" : "escluso il pasto libero"}</span>` : "";
    return `<section class="macro-oggi" aria-label="Macronutrienti di oggi">
        <div class="macro-oggi__testa"><span class="macro-oggi__titolo">Macronutrienti di oggi${escluso}</span><span class="badge-stima">stima</span></div>
        ${righe}
        <p class="macro-oggi__nota">${nota}</p>
      </section>`;
  }

  function rigaConversioneHTML(r) {
    const C = window.conversioni;
    return r.voci.map((v) => {
      const metodi = Object.keys(v.metodi);
      return `<li class="cotto-voce">
        <strong>${escapeHTML(r.testo)}${v.stima ? ` <span class="badge-stima">stima</span>` : ""}</strong>${r.ambiguo ? `<small>${escapeHTML(v.nome)}</small>` : ""}${v.stima && RESE_AI[window.conversioni.chiaveAlimento(window.conversioni.nomeAlimento(r.testo))] && RESE_AI[window.conversioni.chiaveAlimento(window.conversioni.nomeAlimento(r.testo))].nota ? `<small>${escapeHTML(RESE_AI[window.conversioni.chiaveAlimento(window.conversioni.nomeAlimento(r.testo))].nota)}</small>` : ""}
        <ul>${metodi.map((m) => `<li><span>${metodi.length > 1 || v.id === "pesce" || v.stima ? escapeHTML(m) : "da cotto"}</span><b>circa ${fmtG(C.daCrudoACotto(r.grammi, v.metodi[m]))}</b></li>`).join("")}</ul>
      </li>`;
    }).join("");
  }

  function notaFonteCottoHTML(conStime) {
    return `<p class="hint" style="margin-top:12px;">Valori medi di riferimento delle tabelle ${window.conversioni.FONTE}, per alimenti al netto degli scarti: la resa reale cambia con tempo di cottura, taglio e condimento.${conStime ? " Le voci segnate come <strong>stima</strong> non sono nelle tabelle ufficiali: sono calcolate con l'intelligenza artificiale e vanno prese come indicazione." : ""} Se il tuo nutrizionista ti ha dato indicazioni diverse, segui le sue.</p>`;
  }

  function apriPesoCotto(testo, pasto) {
    if (premiumLimitato()) { apriPremium(); return; }
    const righe = window.conversioni.riconosci(testo, RESE_AI);
    apriSheet(`
      <h2 class="sheet__titolo">⚖️ ${escapeHTML(MEAL_META[pasto] ? MEAL_META[pasto].label : "Peso da cotto")}</h2>
      <p class="sheet__nota">I pesi del piano sono a crudo. Se pesi l'alimento già cotto, punta a questi valori:</p>
      <ul class="cotto-elenco">${righe.map(rigaConversioneHTML).join("")}</ul>
      ${notaFonteCottoHTML(righe.some((r) => r.stima))}
      <button type="button" class="btn btn--ghost" id="btn-apri-calcolatore">Apri il calcolatore</button>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Chiudi</button>`);
    document.getElementById("btn-apri-calcolatore").addEventListener("click", apriCalcolatoreCotto);
  }

  function apriCalcolatoreCotto() {
    if (premiumLimitato()) { apriPremium(); return; }
    const C = window.conversioni;
    const stime = Object.keys(RESE_AI).filter((k) => RESE_AI[k].siCuoce && RESE_AI[k].metodi && Object.keys(RESE_AI[k].metodi).length)
      .map((k) => ({ id: "ai:" + k, nome: RESE_AI[k].nome || k, metodi: RESE_AI[k].metodi }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "it"));
    const voci = {};
    C.TABELLA.concat(stime).forEach((v) => { voci[v.id] = v; });
    apriSheet(`
      <h2 class="sheet__titolo">⚖️ Crudo e cotto</h2>
      <label class="editor-campo"><span>Alimento</span>
        <select id="calc-voce">
          <optgroup label="Tabelle LARN 2024">${C.TABELLA.map((v) => `<option value="${v.id}">${escapeHTML(v.nome)}</option>`).join("")}</optgroup>
          ${stime.length ? `<optgroup label="Stime AI">${stime.map((v) => `<option value="${escapeHTML(v.id)}">${escapeHTML(v.nome)}</option>`).join("")}</optgroup>` : ""}
        </select></label>
      <label class="editor-campo" id="calc-metodo-campo"><span>Cottura</span><select id="calc-metodo"></select></label>
      <div class="ric-griglia">
        <label class="editor-campo"><span>Peso a crudo (g)</span><input type="number" inputmode="numeric" id="calc-crudo" min="0" step="1"></label>
        <label class="editor-campo"><span>Peso a cotto (g)</span><input type="number" inputmode="numeric" id="calc-cotto" min="0" step="1"></label>
      </div>
      ${notaFonteCottoHTML(stime.length > 0)}
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Chiudi</button>`);
    const selVoce = document.getElementById("calc-voce"), selMetodo = document.getElementById("calc-metodo");
    const crudo = document.getElementById("calc-crudo"), cotto = document.getElementById("calc-cotto");
    const fattore = () => voci[selVoce.value].metodi[selMetodo.value];
    const aggiornaMetodi = () => {
      const metodi = Object.keys(voci[selVoce.value].metodi);
      selMetodo.innerHTML = metodi.map((m) => `<option value="${escapeHTML(m)}">${escapeHTML(m)}</option>`).join("");
      document.getElementById("calc-metodo-campo").hidden = metodi.length < 2;
    };
    const daCrudo = () => { const g = Number(crudo.value); cotto.value = g > 0 ? C.daCrudoACotto(g, fattore()) : ""; };
    const daCotto = () => { const g = Number(cotto.value); crudo.value = g > 0 ? C.daCottoACrudo(g, fattore()) : ""; };
    selVoce.addEventListener("change", () => { aggiornaMetodi(); daCrudo(); });
    selMetodo.addEventListener("change", daCrudo);
    crudo.addEventListener("input", daCrudo);
    cotto.addEventListener("input", daCotto);
    aggiornaMetodi();
  }

  function privacyPazienteSezioneHTML() {
    if (RUOLO !== "paziente") return "";
    return `
      <section class="settings-section" id="sezione-privacy">
        <h2>Privacy</h2>
        <p class="hint">Riscontri sui pasti, stime dei macronutrienti e del peso da cotto e lettura del piano da PDF usano l'intelligenza artificiale di Anthropic (Stati Uniti): ricevono i testi del piano e dei pasti, mai nome né email.</p>
        <label class="check-riga"><input type="checkbox" id="consenso-ai"${CONSENSO_AI ? " checked" : ""}> <span>Acconsento all'uso delle funzioni di intelligenza artificiale</span></label>
        <p class="stat-nota">Senza questo consenso l'app funziona, senza le funzioni AI. Puoi cambiarlo quando vuoi.</p>
        <button type="button" class="btn btn--ghost" id="btn-salva-consenso-ai">Salva</button>
        <p class="hint" style="margin-top:12px;">Il consenso ai dati sulla salute serve per usare l'app: per revocarlo elimina l'account, qui sotto. Tutti i dettagli sono nell'<a href="https://ilmiopiano.it/privacy.html" target="_blank" rel="noopener" data-link="privacy">Informativa privacy</a>.</p>
      </section>`;
  }

  function collegaPrivacyPaziente() {
    const btn = document.getElementById("btn-salva-consenso-ai");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const si = document.getElementById("consenso-ai").checked;
      if (si === CONSENSO_AI) { mostraToast("Nessuna modifica"); return; }
      btn.disabled = true;
      try {
        await window.cloud.chiamaFunzione("aggiornaConsensoAI", { si });
        CONSENSO_AI = si;
        mostraToast(si ? "Funzioni AI attivate" : "Funzioni AI disattivate: non inviamo più nulla ad Anthropic");
      } catch (e) { mostraToast(msgErroreScrittura(e, "Non salvato: controlla la connessione"), 4000); }
      finally { btn.disabled = false; }
    });
  }

  function parametriAllenamentoSezioneHTML() {
    if (RUOLO !== "paziente") return "";
    const v = (k) => (PARAMETRI_ALLENAMENTO[k] ? String(PARAMETRI_ALLENAMENTO[k]) : "");
    return `
      <section class="settings-section">
        <h2>Allenamenti</h2>
        <p class="hint">Facoltativi. Servono a calcolare zone e intensità quando importi un allenamento da file. Se li conosci, usa quelli del tuo test o del tuo preparatore.</p>
        <div class="ric-griglia">
          <label class="editor-campo"><span>FC massima (bpm)</span><input type="number" id="par-fcmax" inputmode="numeric" min="120" max="230" value="${v("fcMax")}"></label>
          <label class="editor-campo"><span>FC di soglia (bpm)</span><input type="number" id="par-fcsoglia" inputmode="numeric" min="100" max="220" value="${v("fcSoglia")}"></label>
          <label class="editor-campo"><span>FTP (watt, bici)</span><input type="number" id="par-ftp" inputmode="numeric" min="80" max="600" value="${v("ftp")}"></label>
        </div>
        <p class="stat-nota">Con la FC di soglia le zone seguono quella; altrimenti la FC massima. Con un misuratore di potenza e la FTP l'intensità si calcola dalla potenza.</p>
        <button type="button" class="btn btn--ghost" id="btn-salva-parametri">Salva</button>
      </section>`;
  }

  function collegaParametriAllenamento() {
    const btn = document.getElementById("btn-salva-parametri");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const lim = { "par-fcmax": ["fcMax", 120, 230], "par-fcsoglia": ["fcSoglia", 100, 220], "par-ftp": ["ftp", 80, 600] };
      const nuovi = {};
      for (const id of Object.keys(lim)) {
        const [k, min, max] = lim[id];
        const raw = document.getElementById(id).value.trim();
        if (!raw) continue;
        const n = Math.round(Number(raw));
        if (!(n >= min && n <= max)) { mostraToast(`Controlla il valore: deve essere tra ${min} e ${max}`); return; }
        nuovi[k] = n;
      }
      btn.disabled = true;
      try {
        await window.cloud.salvaParametriAllenamento(UID, nuovi);
        PARAMETRI_ALLENAMENTO = nuovi;
        mostraToast("Salvato");
      } catch (e) { mostraToast(msgErroreScrittura(e, "Non salvato: controlla la connessione"), 4000); }
      finally { btn.disabled = false; }
    });
  }

  function calcolatoreSezioneHTML() {
    if (RUOLO !== "paziente") return "";
    return `
      <section class="settings-section">
        <h2>Crudo e cotto</h2>
        <p class="hint">Converti il peso di pasta, riso, legumi, carne e pesce tra crudo e cotto, quando non puoi pesarli prima di cucinarli.</p>
        <button type="button" class="btn btn--ghost" id="btn-calcolatore-cotto">${premiumLimitato() ? "🔒 " : "⚖️ "}Apri il calcolatore</button>
      </section>`;
  }

  // ---- Riepilogo per la visita (PDF) ----
  let jsPdfPromessa = null;
  function caricaJsPdf() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    if (!jsPdfPromessa) {
      jsPdfPromessa = new Promise((ok, ko) => {
        const s = document.createElement("script");
        s.src = "js/vendor/jspdf/jspdf.umd.min.js";
        s.onload = () => (window.jspdf && window.jspdf.jsPDF ? ok(window.jspdf.jsPDF) : ko(new Error("jspdf")));
        s.onerror = () => { jsPdfPromessa = null; ko(new Error("jspdf-non-trovato")); };
        document.head.appendChild(s);
      });
    }
    return jsPdfPromessa;
  }

  function riepilogoVisitaSezioneHTML() {
    if (RUOLO !== "paziente" || !PIANO_ATTIVO) return "";
    return `
      <section class="settings-section">
        <h2>Visita dal nutrizionista</h2>
        <p class="hint">Prepara un riepilogo in PDF degli ultimi 30 giorni da portare alla visita o da inviare al nutrizionista: pasti rispettati, cosa è cambiato e perché, peso e misure, le tue note.</p>
        <button type="button" class="btn ${premiumLimitato() ? "btn--ghost" : ""}" id="btn-riepilogo-visita">${premiumLimitato() ? "🔒 " : ""}Prepara il riepilogo (PDF)</button>
      </section>`;
  }

  function collegaRiepilogoVisita() {
    const btn = document.getElementById("btn-riepilogo-visita");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      if (premiumLimitato()) { apriPremium(); return; }
      btn.disabled = true; btn.textContent = "Preparo il riepilogo…";
      try {
        const file = await creaRiepilogoVisitaPdf();
        await condividiOScaricaFile(file);
      } catch (e) {
        console.warn(e);
        mostraToast("Non sono riuscito a preparare il riepilogo: controlla la connessione e riprova", 4500);
      } finally {
        btn.disabled = false; btn.textContent = "Prepara il riepilogo (PDF)";
      }
    });
  }

  function scaricaFile(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    mostraToast("PDF salvato nella cartella Download", 3500);
  }

  /** PDF pronto: si sceglie se salvarlo sul dispositivo o condividerlo (email, WhatsApp…). */
  async function condividiOScaricaFile(file) {
    const puoCondividere = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    if (!puoCondividere) { scaricaFile(file); return; }
    apriSheet(`
      <h2 class="sheet__titolo">PDF pronto</h2>
      <p class="sheet__nota">${escapeHTML(file.name)}</p>
      <button type="button" class="btn" id="btn-file-salva">Salva sul dispositivo</button>
      <button type="button" class="btn btn--ghost" id="btn-file-condividi">Condividi (email, WhatsApp…)</button>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Chiudi</button>`);
    document.getElementById("btn-file-salva").addEventListener("click", () => { scaricaFile(file); chiudiSheet(); });
    document.getElementById("btn-file-condividi").addEventListener("click", async () => {
      try { await navigator.share({ files: [file], title: file.name }); chiudiSheet(); }
      catch (e) { if (!(e && e.name === "AbortError")) { scaricaFile(file); chiudiSheet(); } }
    });
  }

  /** Testo sicuro per i caratteri del PDF (niente emoji né simboli fuori dall'alfabeto latino). */
  function testoPdf(t) {
    return String(t == null ? "" : t)
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...")
      .replace(/→/g, "->").replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "");
  }

  function immagineDataUrl(url) {
    return fetch(url).then((r) => { if (!r.ok) throw new Error("logo"); return r.blob(); })
      .then((b) => new Promise((ok, ko) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = ko; fr.readAsDataURL(b); }));
  }

  async function creaRiepilogoVisitaPdf() {
    const S = window.statistiche;
    const JsPDF = await caricaJsPdf();
    const oggi = new Date();
    const { utente, spunte } = await window.cloud.leggiDatiStatistiche(UID, S.primoGiornoStorico(oggi));
    const piano = PIANO_ATTIVO;
    const creato = utente && utente.creato && typeof utente.creato.toDate === "function" ? S.chiave(utente.creato.toDate()) : null;
    const inizio = [piano.dataInizio || null, creato].filter(Boolean).sort().pop() || null;
    const r = S.calcola({ spunte, inizio });
    const nome = (utente && utente.nome) || piano.pazienteNome || "";
    const dalGiorno = new Date(oggi); dalGiorno.setDate(dalGiorno.getDate() - 30);
    const data = (d) => `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
    const pct = (v) => (v == null ? "-" : `${Math.round(v * 100)}%`);

    const doc = new JsPDF({ unit: "mm", format: "a4" });
    const M = 16, L = 210 - 2 * M;
    let y = 18;
    const verde = [30, 54, 42], grigio = [100, 110, 100];
    const nuovaPaginaSeServe = (h) => { if (y + h > 280) { doc.addPage(); y = 18; } };
    const titolo = (t) => { nuovaPaginaSeServe(14); y += 4; doc.setFont("helvetica", "bold"); doc.setFontSize(12.5); doc.setTextColor(...verde); doc.text(testoPdf(t), M, y); y += 6.5; };
    const riga = (t, opz) => {
      doc.setFont("helvetica", (opz && opz.bold) ? "bold" : "normal"); doc.setFontSize((opz && opz.size) || 10.5);
      doc.setTextColor(...((opz && opz.colore) || [30, 30, 30]));
      const righe = doc.splitTextToSize(testoPdf(t), L - ((opz && opz.rientro) || 0));
      nuovaPaginaSeServe(righe.length * 5);
      doc.text(righe, M + ((opz && opz.rientro) || 0), y); y += righe.length * 5 + ((opz && opz.dopo) || 1.2);
    };

    // Carta intestata: logo, nome dell'app e sito
    const logo = await immagineDataUrl("icons/icon-192.png").catch(() => null);
    if (logo) doc.addImage(logo, "PNG", M, 10, 13, 13);
    doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(...verde);
    doc.text("Il mio Piano", M + (logo ? 16 : 0), 17.5);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...grigio);
    doc.text("Il tuo piano nutrizionale, ogni giorno", M + (logo ? 16 : 0), 22);
    doc.text("ilmiopiano.it", M + L, 17.5, { align: "right" });
    doc.setDrawColor(...verde); doc.setLineWidth(0.7); doc.line(M, 27, M + L, 27); doc.setLineWidth(0.2);
    y = 38;
    // Titolo
    doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(...verde);
    doc.text("Riepilogo per la visita", M, y); y += 7;
    riga(`${nome ? nome + " - " : ""}dal ${data(dalGiorno)} al ${data(oggi)}`, { colore: grigio, dopo: 2 });
    doc.setDrawColor(200, 210, 195); doc.line(M, y, M + L, y); y += 3;

    // Aderenza
    titolo("Quanto ho seguito il piano");
    if (!r.pianoIniziato || !r.giorniValutati30) {
      riga("Il piano è iniziato da poco: non ci sono ancora giorni completi da valutare.");
    } else {
      riga(`Aderenza negli ultimi 30 giorni: ${pct(r.aderenza30)} (ultimi 7 giorni: ${pct(r.aderenza7)})`, { bold: true });
      riga(`Giorni feriali ${pct(r.feriali)} - fine settimana ${pct(r.weekend)}. Giornate rispettate di fila: ${r.serie} (record ${r.record}).`);
      riga("Un pasto fatto come previsto conta 1, fatto diversamente o in parte 0,5, saltato o non segnato 0.", { colore: grigio, size: 9 });
      // tabella per pasto
      y += 1;
      const col = [M, M + 52, M + 82, M + 112, M + 137, M + 160];
      const intest = ["Pasto", "Come previsto", "Diversamente", "In parte", "Saltato", "Non segnato"];
      nuovaPaginaSeServe(8 + r.perPasto.length * 6);
      doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(...grigio);
      intest.forEach((t, i) => doc.text(t, col[i], y)); y += 5.5;
      doc.setFont("helvetica", "normal"); doc.setTextColor(30, 30, 30);
      r.perPasto.forEach((p) => {
        const c = p.conta;
        [MEAL_META[p.pasto].label, c.fatto, c.diverso, c.parziale, c.saltato, c.nonSegnato]
          .forEach((t, i) => doc.text(testoPdf(String(t)), col[i], y));
        y += 5.5;
      });
    }

    // Cosa è cambiato e perché
    const im = r.imprevisti;
    const totaleImprevisti = im.diverso.totale + im.parziale.totale + im.saltato.totale;
    titolo("Cosa è cambiato e perché");
    if (!totaleImprevisti) riga("Nessun pasto segnato come fatto diversamente, in parte o saltato.");
    else {
      const desc = (g, nomeGruppo) => {
        if (!g.totale) return;
        const pasti = Object.keys(g.perPasto).sort((a, b) => g.perPasto[b] - g.perPasto[a]).map((k) => `${MEAL_META[k].label.toLowerCase()} ${g.perPasto[k]}`).join(", ");
        const motivi = Object.keys(g.motivi).sort((a, b) => g.motivi[b] - g.motivi[a]).map((k) => `${S.MOTIVI[k].toLowerCase()} (${g.motivi[k]})`).join(", ");
        riga(`${nomeGruppo}: ${g.totale} - ${pasti}${motivi ? `. Motivi: ${motivi}` : ""}`);
      };
      desc(im.diverso, "Fatti diversamente");
      desc(im.parziale, "Fatti in parte");
      desc(im.saltato, "Saltati");
    }

    // Allenamenti
    try {
      const da = S.chiave(dalGiorno);
      const t = testoSintesiAllenamenti(sintesiAllenamenti(await window.cloud.leggiAttivitaPeriodo(UID, da), da));
      if (t) { titolo("Allenamenti"); riga(t.riga, { bold: true }); if (t.dettaglio) riga(t.dettaglio); }
    } catch (e) { /* sezione facoltativa */ }

    // Peso e misure
    const misure = (MISURE.lista || []).slice().sort((a, b) => (a.data < b.data ? -1 : 1));
    titolo("Peso e misure");
    if (!misure.length) riga("Nessuna misura registrata.");
    else {
      const prima = misure[0], ultima = misure[misure.length - 1];
      const kg = (n) => `${String(Math.round(n * 10) / 10).replace(".", ",")} kg`;
      const dataIt = (k) => { const d = S.daChiave(k); return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`; };
      riga(`Ultimo peso: ${kg(ultima.peso)} il ${dataIt(ultima.data)}${misure.length > 1 ? ` - variazione dal ${dataIt(prima.data)}: ${(ultima.peso - prima.peso >= 0 ? "+" : "") + String(Math.round((ultima.peso - prima.peso) * 10) / 10).replace(".", ",")} kg` : ""}`, { bold: true });
      const altre = [["vita", "Vita"], ["fianchi", "Fianchi"]].filter(([k]) => ultima[k] != null).map(([k, n]) => `${n} ${String(ultima[k]).replace(".", ",")} cm`);
      if (altre.length) riga(`Ultime circonferenze: ${altre.join(", ")}`);
      // grafico del peso
      if (misure.length >= 2) {
        nuovaPaginaSeServe(48);
        const gx = M, gy = y + 2, gw = L, gh = 38;
        const pesi = misure.map((m) => m.peso);
        const min = Math.min(...pesi) - 0.5, max = Math.max(...pesi) + 0.5;
        const t0 = S.daChiave(prima.data).getTime(), t1 = Math.max(S.daChiave(ultima.data).getTime(), t0 + 86400000);
        const px = (k) => gx + 12 + ((S.daChiave(k).getTime() - t0) / (t1 - t0)) * (gw - 16);
        const py = (v) => gy + gh - ((v - min) / (max - min)) * gh;
        doc.setDrawColor(215, 222, 210); doc.setLineWidth(0.2);
        [min + 0.5, (min + max) / 2, max - 0.5].forEach((v) => { doc.line(gx + 10, py(v), gx + gw, py(v)); doc.setFontSize(7.5); doc.setTextColor(...grigio); doc.text(String(Math.round(v * 10) / 10).replace(".", ","), gx, py(v) + 1); });
        doc.setDrawColor(...verde); doc.setLineWidth(0.6);
        for (let i = 1; i < misure.length; i++) doc.line(px(misure[i - 1].data), py(misure[i - 1].peso), px(misure[i].data), py(misure[i].peso));
        doc.setFillColor(...verde);
        misure.forEach((m) => doc.circle(px(m.data), py(m.peso), 0.9, "F"));
        doc.setFontSize(7.5); doc.setTextColor(...grigio);
        doc.text(dataIt(prima.data), gx + 12, gy + gh + 5); doc.text(dataIt(ultima.data), gx + gw - 14, gy + gh + 5);
        y = gy + gh + 9;
        doc.setLineWidth(0.2);
      }
    }

    // Note
    titolo("Le mie note");
    if (!im.note.length) riga("Nessuna nota scritta.");
    else im.note.forEach((n) => {
      const d = S.daChiave(n.giorno);
      riga(`${d.getDate()}/${d.getMonth() + 1} - ${MEAL_META[n.pasto].label}: "${n.nota}"`, { size: 10 });
    });

    // Piè di pagina
    const pagine = doc.getNumberOfPages();
    for (let i = 1; i <= pagine; i++) {
      doc.setPage(i); doc.setFontSize(8); doc.setTextColor(...grigio);
      doc.setDrawColor(200, 210, 195); doc.line(M, 285, M + L, 285);
      doc.text(testoPdf(`Preparato con Il mio Piano il ${data(oggi)} - ilmiopiano.it`), M, 290);
      doc.text(`Pagina ${i} di ${pagine}`, M + L, 290, { align: "right" });
    }
    const blob = doc.output("blob");
    const chiaveOggi = S.chiave(oggi);
    return new File([blob], `riepilogo-visita-${chiaveOggi}.pdf`, { type: "application/pdf" });
  }

  // ---- Report per il preparatore (professionista) ----
  const SEZIONI_REPORT = [["aderenza", "Aderenza al piano"], ["peso", "Peso e misure"], ["allenamenti", "Allenamenti e carico"], ["note", "Le tue note per il preparatore"]];

  function apriReportPreparatore(piano) {
    const nome = (piano.pazienteNome || "il paziente").split(" ")[0];
    const P = window.reportPreparatore.PERIODI;
    apriSheet(`
      <h2 class="sheet__titolo">Report per il preparatore</h2>
      <p class="sheet__nota">Un PDF da inviare al preparatore di ${escapeHTML(nome)}, con la tua intestazione. Note del paziente e consigli AI non sono inclusi.</p>
      <p class="impost-etichetta">Periodo</p>
      <div class="segmento segmento--a-capo" id="rep-periodo">${P.map(([id, etichetta], i) => `<button type="button" class="segmento__voce" data-periodo="${id}" aria-pressed="${i === 1}">${etichetta}</button>`).join("")}<button type="button" class="segmento__voce" data-periodo="date" aria-pressed="false">Date a scelta</button></div>
      <div class="ric-griglia" id="rep-date" hidden>
        <label class="editor-campo"><span>Dal</span><input type="date" id="rep-da"></label>
        <label class="editor-campo"><span>Al</span><input type="date" id="rep-a"></label>
      </div>
      <p class="impost-etichetta">Sezioni</p>
      ${SEZIONI_REPORT.map(([k, t]) => `<label class="check-riga"><input type="checkbox" data-sezione="${k}" checked> <span>${t}</span></label>`).join("")}
      <label class="editor-campo" id="rep-note-campo"><span>Note per il preparatore (facoltative)</span>
        <textarea id="rep-note" rows="4" maxlength="1500" placeholder="Es. nelle settimane di carico alto aumentiamo i carboidrati a colazione e prima delle uscite lunghe."></textarea></label>
      <label class="check-riga rep-consenso"><input type="checkbox" id="rep-consenso"> <span>${escapeHTML(nome)} ha acconsentito a condividere questi dati con il preparatore.</span></label>
      <button type="button" class="btn" id="btn-crea-report" style="margin-top:12px;" disabled>Crea il PDF</button>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>`);
    let periodo = "30";
    const oggiK = oggiISO();
    document.querySelectorAll("#rep-periodo [data-periodo]").forEach((b) => b.addEventListener("click", () => {
      periodo = b.dataset.periodo;
      document.querySelectorAll("#rep-periodo [data-periodo]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      document.getElementById("rep-date").hidden = periodo !== "date";
    }));
    const daI = document.getElementById("rep-da"), aI = document.getElementById("rep-a");
    aI.value = oggiK; aI.max = oggiK; daI.max = oggiK;
    const consenso = document.getElementById("rep-consenso"), crea = document.getElementById("btn-crea-report");
    consenso.addEventListener("change", () => { crea.disabled = !consenso.checked; });
    const casellaNote = document.querySelector('[data-sezione="note"]');
    casellaNote.addEventListener("change", () => { document.getElementById("rep-note-campo").hidden = !casellaNote.checked; });
    crea.addEventListener("click", async () => {
      const sezioni = {};
      document.querySelectorAll("[data-sezione]").forEach((c) => { sezioni[c.dataset.sezione] = c.checked; });
      if (!sezioni.aderenza && !sezioni.peso && !sezioni.allenamenti) { mostraToast("Scegli almeno una sezione tra aderenza, peso e allenamenti"); return; }
      let da, a = oggiK;
      if (periodo === "date") {
        da = daI.value; a = aI.value;
        if (!da || !a || da > a) { mostraToast("Controlla le date del periodo"); return; }
        if (window.statistiche.differenzaGiorni(window.statistiche.daChiave(a), window.statistiche.daChiave(da)) > 366) { mostraToast("Il periodo può durare al massimo un anno"); return; }
      } else {
        da = window.statistiche.chiave(new Date(Date.now() - (Number(periodo) - 1) * 86400000));
      }
      crea.disabled = true; crea.textContent = "Preparo il report…";
      try {
        const file = await creaReportPreparatorePdf(piano, { da, a, sezioni, note: sezioni.note ? document.getElementById("rep-note").value.trim() : "" });
        chiudiSheet();
        await condividiOScaricaFile(file);
      } catch (e) {
        console.warn(e);
        mostraToast("Non sono riuscito a preparare il report: controlla la connessione e riprova", 4500);
        crea.disabled = false; crea.textContent = "Crea il PDF";
      }
    });
  }

  async function creaReportPreparatorePdf(piano, opz) {
    const S = window.statistiche, RP = window.reportPreparatore;
    const JsPDF = await caricaJsPdf();
    const uid = piano.pazienteUid;
    const [{ utente, spunte }, misure, attivita] = await Promise.all([
      window.cloud.leggiDatiStatistiche(uid, opz.da),
      opz.sezioni.peso ? window.cloud.leggiMisure(piano.id).catch(() => []) : Promise.resolve([]),
      opz.sezioni.allenamenti ? window.cloud.leggiAttivitaPeriodo(uid, opz.da).catch(() => ({})) : Promise.resolve({}),
    ]);
    const creato = utente && utente.creato && typeof utente.creato.toDate === "function" ? S.chiave(utente.creato.toDate()) : null;
    const inizioPiano = [piano.dataInizio || null, creato].filter(Boolean).sort().pop() || null;
    const r = RP.calcola({ da: opz.da, a: opz.a, inizioPiano, spunte, misure, attivita });
    const sez = opz.sezioni;

    const nomePaziente = piano.pazienteNome || (utente && utente.nome) || "Paziente";
    const c = PROFILO_PROF.contatti || {};
    const nomeProf = c.nome || PROFILO_PROF.nome || "";
    const dataIt = (k) => { const d = S.daChiave(k); return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`; };
    const breve = (k) => { const d = S.daChiave(k); return `${d.getDate()}/${d.getMonth() + 1}`; };
    const pct = (v) => (v == null ? "-" : `${Math.round(v * 100)}%`);
    const num = (n, dec) => (n == null ? "-" : Number(n).toLocaleString("it-IT", { maximumFractionDigits: dec || 0, minimumFractionDigits: 0 }));
    const ore = (min) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`; };

    const doc = new JsPDF({ unit: "mm", format: "a4" });
    const M = 16, L = 210 - 2 * M;
    const verde = [30, 54, 42], grigio = [100, 110, 100], chiaro = [215, 222, 210], arancio = [200, 110, 40];
    let y = 18;
    const nuovaPaginaSeServe = (h) => { if (y + h > 278) { doc.addPage(); y = 18; return true; } return false; };
    const titolo = (t) => { nuovaPaginaSeServe(16); y += 5; doc.setFont("helvetica", "bold"); doc.setFontSize(12.5); doc.setTextColor(...verde); doc.text(testoPdf(t), M, y); y += 6.5; };
    const riga = (t, o) => {
      o = o || {};
      doc.setFont("helvetica", o.bold ? "bold" : "normal"); doc.setFontSize(o.size || 10.5); doc.setTextColor(...(o.colore || [30, 30, 30]));
      const righe = doc.splitTextToSize(testoPdf(t), L - (o.rientro || 0));
      nuovaPaginaSeServe(righe.length * 5);
      doc.text(righe, M + (o.rientro || 0), y); y += righe.length * (o.size && o.size < 10 ? 4.2 : 5) + (o.dopo == null ? 1.2 : o.dopo);
    };
    /** Tabella semplice: colonne { t, w, dx } e righe di testi. */
    const tabella = (col, righe, o) => {
      o = o || {};
      const h = o.altezza || 5.4, fs = o.size || 9;
      const intestazione = () => {
        doc.setFont("helvetica", "bold"); doc.setFontSize(fs - 0.5); doc.setTextColor(...grigio);
        let x = M; col.forEach((cc) => { doc.text(testoPdf(cc.t), cc.dx ? x + cc.w - 1 : x, y, cc.dx ? { align: "right" } : undefined); x += cc.w; });
        y += 1.6; doc.setDrawColor(...chiaro); doc.line(M, y, M + L, y); y += h - 1.6;
      };
      nuovaPaginaSeServe(h * 3); intestazione();
      doc.setFont("helvetica", "normal"); doc.setFontSize(fs); doc.setTextColor(30, 30, 30);
      righe.forEach((rr, i) => {
        if (nuovaPaginaSeServe(h)) { intestazione(); doc.setFont("helvetica", "normal"); doc.setFontSize(fs); doc.setTextColor(30, 30, 30); }
        if (i % 2 === 1) { doc.setFillColor(244, 246, 241); doc.rect(M, y - h + 1.6, L, h, "F"); }
        let x = M;
        rr.forEach((t, j) => { const cc = col[j]; doc.text(testoPdf(String(t)), cc.dx ? x + cc.w - 1 : x, y, cc.dx ? { align: "right" } : undefined); x += cc.w; });
        y += h;
      });
      y += 2;
    };

    // --- intestazione del professionista
    const logo = await immagineDataUrl("icons/icon-192.png").catch(() => null);
    doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(...verde);
    doc.text(testoPdf(nomeProf || "Il tuo nutrizionista"), M, 15);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...grigio);
    const sx = [c.qualifica, c.studio].filter(Boolean);
    sx.forEach((t, i) => doc.text(testoPdf(t), M, 20 + i * 4.2));
    const dx = [c.email, c.telefono].filter(Boolean);
    dx.forEach((t, i) => doc.text(testoPdf(t), M + L, 15 + i * 4.2, { align: "right" }));
    const fineTestata = Math.max(20 + sx.length * 4.2, 15 + dx.length * 4.2) + 1;
    doc.setDrawColor(...verde); doc.setLineWidth(0.7); doc.line(M, fineTestata, M + L, fineTestata); doc.setLineWidth(0.2);
    y = fineTestata + 10;
    doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(...verde);
    doc.text("Report per il preparatore", M, y); y += 7;
    riga(`${nomePaziente} - dal ${dataIt(r.da)} al ${dataIt(r.a)}`, { bold: true, dopo: 0.5 });
    const obiettivo = piano.obiettivo || (piano.paziente && piano.paziente.obiettivo);
    if (obiettivo) riga(`Obiettivo del piano: ${obiettivo}`, { colore: grigio, size: 9.5 });
    y += 1;

    // --- riquadri di sintesi
    const t = r.allenamenti.totale;
    const riquadri = [];
    if (sez.aderenza) riquadri.push([pct(r.aderenza), "aderenza al piano"]);
    if (sez.allenamenti) riquadri.push([String(t.n), `allenamenti, ${ore(t.minuti)}`]);
    if (sez.allenamenti && t.tss) riquadri.push([num(t.tss), "carico totale (TSS)"]);
    else if (sez.allenamenti && t.km) riquadri.push([`${num(t.km)} km`, "distanza totale"]);
    if (sez.peso && r.peso) riquadri.push([r.peso.variazione == null ? `${num(r.peso.ultimo.peso, 1)} kg` : `${r.peso.variazione > 0 ? "+" : ""}${num(r.peso.variazione, 1)} kg`, r.peso.variazione == null ? "peso" : "variazione di peso"]);
    if (riquadri.length) {
      const w = (L - (riquadri.length - 1) * 4) / riquadri.length;
      riquadri.forEach(([v, e], i) => {
        const x = M + i * (w + 4);
        doc.setFillColor(238, 243, 234); doc.roundedRect(x, y, w, 17, 2, 2, "F");
        doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(...verde); doc.text(testoPdf(v), x + 4, y + 8);
        doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(...grigio); doc.text(testoPdf(e), x + 4, y + 13.5);
      });
      y += 22;
    }

    // --- settimana per settimana: grafico e tabella
    if (sez.aderenza || sez.allenamenti) {
      titolo("Settimana per settimana");
      const sett = r.settimane;
      const usaTss = sez.allenamenti && sett.some((w) => w.allenamenti.tss);
      const carico = (w) => (usaTss ? w.allenamenti.tss : w.allenamenti.minuti / 60);
      if (sett.length >= 2 && (sez.allenamenti || sez.aderenza)) {
        nuovaPaginaSeServe(56);
        const gx = M + 12, gw = L - 24, gh = 40, gy = y + 3;
        const grezzo = Math.max(1, ...sett.map(carico)) * 1.1;
        const ordine = Math.pow(10, Math.floor(Math.log10(grezzo)));
        const maxC = Math.ceil(grezzo / (ordine / 2)) * (ordine / 2);
        const passo = gw / sett.length, lb = Math.min(12, passo * 0.55);
        doc.setDrawColor(...chiaro); doc.setLineWidth(0.2);
        [0, 0.5, 1].forEach((f) => doc.line(gx, gy + gh - f * gh, gx + gw, gy + gh - f * gh));
        doc.setFontSize(7.5); doc.setTextColor(...grigio);
        if (sez.allenamenti) {
          doc.text(usaTss ? "TSS" : "ore", gx - 2, gy - 2, { align: "right" });
          [0, 0.5, 1].forEach((f) => doc.text(num(maxC * f, usaTss ? 0 : 1), gx - 2, gy + gh - f * gh + 1, { align: "right" }));
          doc.setFillColor(94, 158, 110);
          sett.forEach((w, i) => { const v = carico(w); if (v > 0) { const h = (v / maxC) * gh; doc.rect(gx + i * passo + (passo - lb) / 2, gy + gh - h, lb, h, "F"); } });
        }
        if (sez.aderenza) {
          doc.text("aderenza", gx + gw + 2, gy - 2);
          [0, 0.5, 1].forEach((f) => doc.text(`${Math.round(f * 100)}%`, gx + gw + 2, gy + gh - f * gh + 1));
          doc.setDrawColor(...arancio); doc.setLineWidth(0.7);
          let prec = null;
          sett.forEach((w, i) => {
            if (w.aderenza == null) { prec = null; return; }
            const px = gx + i * passo + passo / 2, py = gy + gh - w.aderenza * gh;
            if (prec) doc.line(prec[0], prec[1], px, py);
            doc.setFillColor(...arancio); doc.circle(px, py, 1, "F");
            prec = [px, py];
          });
          doc.setLineWidth(0.2);
        }
        doc.setFontSize(7.5); doc.setTextColor(...grigio);
        const ogni = Math.ceil(sett.length / 14);
        sett.forEach((w, i) => { if (i % ogni === 0) doc.text(breve(w.lunedi), gx + i * passo + passo / 2, gy + gh + 4.5, { align: "center" }); });
        y = gy + gh + 8;
        const leg = [sez.allenamenti ? `barre verdi: ${usaTss ? "carico (TSS)" : "ore di allenamento"}` : "", sez.aderenza ? "linea arancione: aderenza al piano" : ""].filter(Boolean).join(" - ");
        riga(`Settimane dal lunedì indicato. ${leg}.`, { colore: grigio, size: 8.5 });
      }
      const col = [{ t: "Settimana", w: 30 }];
      if (sez.aderenza) col.push({ t: "Aderenza", w: 20, dx: true });
      if (sez.allenamenti) col.push({ t: "Allen.", w: 15, dx: true }, { t: "Durata", w: 22, dx: true }, { t: "Km", w: 18, dx: true }, { t: "D+ m", w: 18, dx: true }, { t: "kJ", w: 18, dx: true }, { t: "TSS", w: 16, dx: true });
      const righe = sett.map((w) => {
        const fine = new Date(S.daChiave(w.lunedi)); fine.setDate(fine.getDate() + 6);
        const rr = [`${breve(w.lunedi)}-${fine.getDate()}/${fine.getMonth() + 1}${w.parziale ? "*" : ""}`];
        if (sez.aderenza) rr.push(pct(w.aderenza));
        if (sez.allenamenti) { const a = w.allenamenti; rr.push(String(a.n), a.minuti ? ore(a.minuti) : "-", a.km ? num(a.km) : "-", a.dplus ? num(a.dplus) : "-", a.kj ? num(a.kj) : "-", a.tss ? num(a.tss) : "-"); }
        return rr;
      });
      tabella(col, righe);
      if (sett.some((w) => w.parziale)) riga("* settimana compresa solo in parte nel periodo.", { colore: grigio, size: 8.5 });
    }

    // --- aderenza
    if (sez.aderenza) {
      titolo("Aderenza al piano alimentare");
      if (!r.giorniValutati) riga("Nel periodo non ci sono giornate concluse da valutare (il piano è iniziato da poco).");
      else {
        const k = r.conta, tot = k.fatto + k.diverso + k.parziale + k.saltato + k.nonSegnato;
        riga(`Aderenza ${pct(r.aderenza)} su ${r.giorniValutati} giornate concluse.`, { bold: true });
        riga(`Pasti: ${k.fatto} come previsto, ${k.diverso} fatti diversamente, ${k.parziale} in parte, ${k.saltato} saltati, ${k.nonSegnato} non segnati (su ${tot}).`);
        riga("Un pasto come previsto conta 1, diversamente o in parte 0,5, saltato o non segnato 0.", { colore: grigio, size: 8.5 });
      }
    }

    // --- allenamenti
    if (sez.allenamenti) {
      titolo("Allenamenti e carico");
      if (!t.n) riga("Nessun allenamento segnato nel periodo.");
      else {
        riga(`${t.n} allenamenti${t.indoor ? ` (${t.indoor} al chiuso)` : ""}, ${ore(t.minuti)}${t.km ? ` - ${num(t.km)} km` : ""}${t.dplus ? ` - ${num(t.dplus)} m di dislivello` : ""}${t.kj ? ` - ${num(t.kj)} kJ` : ""}${t.tss ? ` - TSS ${num(t.tss)}` : ""}.`, { bold: true });
        const pi = t.perIntensita;
        riga(`Intensità: ${pi.leggera} leggeri, ${pi.moderata} moderati, ${pi.intensa} intensi.${t.kcal ? ` Calorie stimate dai dispositivi: ${num(t.kcal)} kcal.` : ""}`);
        if (t.conZone) {
          const totZ = t.zone.reduce((a, b) => a + b, 0) || 1;
          nuovaPaginaSeServe(16);
          const colori = [[154, 165, 177], [94, 158, 110], [217, 177, 59], [224, 123, 57], [200, 66, 59]];
          let x = M;
          t.zone.forEach((m, i) => {
            const w = (m / totZ) * L; if (w <= 0) return;
            doc.setFillColor(...colori[i]); doc.rect(x, y, w, 6, "F");
            if (w > 14) { doc.setFontSize(7.5); doc.setTextColor(255, 255, 255); doc.text(`Z${i + 1} ${Math.round((m / totZ) * 100)}%`, x + w / 2, y + 4.1, { align: "center" }); }
            x += w;
          });
          y += 10;
          riga(`Tempo nelle zone di frequenza cardiaca, sui ${t.conZone} allenamenti importati con i dati del cardiofrequenzimetro.`, { colore: grigio, size: 8.5 });
        }
        const el = r.allenamenti.elenco.slice().sort((a, b) => (a.giorno < b.giorno ? 1 : a.giorno > b.giorno ? -1 : 0));
        y += 1;
        tabella(
          [{ t: "Data", w: 14 }, { t: "Attività", w: 29 }, { t: "Durata", w: 18, dx: true }, { t: "Km", w: 14, dx: true }, { t: "D+ m", w: 15, dx: true }, { t: "FC", w: 12, dx: true }, { t: "Watt NP", w: 17, dx: true }, { t: "IF", w: 12, dx: true }, { t: "TSS", w: 12, dx: true }, { t: "Deriva", w: 17, dx: true }, { t: "Intensità", w: 18, dx: true }],
          el.map((a) => [breve(a.giorno), nomeAllenamento(a), a.durata ? ore(a.durata) : "-", a.distanzaKm ? num(a.distanzaKm, 1) : "-", a.dislivelloM ? num(a.dislivelloM) : "-",
            a.fcMedia || "-", a.potenzaNormalizzata || a.potenzaMedia || "-", a.fattoreIntensita ? num(a.fattoreIntensita, 2) : "-", a.tss || "-",
            a.derivaCardiaca != null ? `${num(a.derivaCardiaca, 1)}%` : "-", a.intensita || "-"]),
          { size: 8.3, altezza: 5 });
        riga("Dati dai file dei dispositivi del paziente quando importati, altrimenti inseriti a mano (solo attività, durata e intensità). IF e TSS richiedono la FTP indicata dal paziente; deriva cardiaca: rapporto potenza/frequenza tra prima e seconda metà, sotto il 5% sforzo aerobico stabile.", { colore: grigio, size: 8 });
      }
    }

    // --- peso
    if (sez.peso) {
      if (r.peso && r.peso.serie.length >= 2) nuovaPaginaSeServe(72); // titolo, testo e grafico sulla stessa pagina
      titolo("Peso e misure");
      if (!r.peso) riga("Nessuna misura registrata nel periodo.");
      else {
        const p = r.peso, kg = (n) => `${num(n, 1)} kg`;
        riga(`Ultimo peso ${kg(p.ultimo.peso)} il ${dataIt(p.ultimo.data)}${p.variazione != null ? ` - variazione dal ${dataIt(p.primo.data)}: ${p.variazione > 0 ? "+" : ""}${num(p.variazione, 1)} kg` : ""}.`, { bold: true });
        const altre = [["vita", "vita"], ["fianchi", "fianchi"]].filter(([k]) => p.ultimo[k] != null).map(([k, n]) => `${n} ${num(p.ultimo[k], 1)} cm`);
        if (altre.length) riga(`Ultime circonferenze: ${altre.join(", ")}.`);
        if (p.serie.length >= 2) {
          nuovaPaginaSeServe(50);
          const gx = M, gy = y + 2, gw = L, gh = 34;
          const pesi = p.serie.map((m) => m.peso);
          const min = Math.min(...pesi) - 0.5, max = Math.max(...pesi) + 0.5;
          const t0 = S.daChiave(r.da).getTime(), t1 = Math.max(S.daChiave(r.a).getTime(), t0 + 86400000);
          const px = (k) => gx + 12 + ((S.daChiave(k).getTime() - t0) / (t1 - t0)) * (gw - 16);
          const py = (v) => gy + gh - ((v - min) / (max - min)) * gh;
          doc.setDrawColor(...chiaro);
          [min + 0.5, (min + max) / 2, max - 0.5].forEach((v) => { doc.line(gx + 10, py(v), gx + gw, py(v)); doc.setFontSize(7.5); doc.setTextColor(...grigio); doc.text(num(v, 1), gx, py(v) + 1); });
          doc.setDrawColor(...verde); doc.setLineWidth(0.6);
          for (let i = 1; i < p.serie.length; i++) doc.line(px(p.serie[i - 1].data), py(p.serie[i - 1].peso), px(p.serie[i].data), py(p.serie[i].peso));
          doc.setFillColor(...verde); p.serie.forEach((m) => doc.circle(px(m.data), py(m.peso), 0.9, "F"));
          doc.setFontSize(7.5); doc.setTextColor(...grigio);
          doc.text(dataIt(r.da), gx + 12, gy + gh + 5); doc.text(dataIt(r.a), gx + gw, gy + gh + 5, { align: "right" });
          y = gy + gh + 9; doc.setLineWidth(0.2);
        }
      }
    }

    // --- note del nutrizionista
    if (sez.note && opz.note) {
      titolo("Note del nutrizionista");
      opz.note.split(/\n+/).forEach((par) => riga(par));
    }

    // --- piè di pagina
    const pagine = doc.getNumberOfPages();
    const oggiIt = dataIt(oggiISO());
    for (let i = 1; i <= pagine; i++) {
      doc.setPage(i);
      doc.setDrawColor(...chiaro); doc.line(M, 283, M + L, 283);
      if (logo) doc.addImage(logo, "PNG", M, 285.5, 5, 5);
      doc.setFontSize(7.5); doc.setTextColor(...grigio);
      doc.text(testoPdf(`Report del ${oggiIt}, condiviso dal nutrizionista con il consenso del paziente.`), M + (logo ? 7 : 0), 287.6);
      doc.text(testoPdf("Dati riservati: non inoltrare ad altri. Preparato con Il mio Piano - ilmiopiano.it"), M + (logo ? 7 : 0), 291);
      doc.text(`Pagina ${i} di ${pagine}`, M + L, 289, { align: "right" });
    }
    const pulito = nomePaziente.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
    return new File([doc.output("blob")], `report-preparatore-${pulito || "paziente"}-${r.da}_${r.a}.pdf`, { type: "application/pdf" });
  }

  /** Il paziente gestisce da solo il proprio piano (registrato dall'app, non collegato). */
  function gestisceIlPiano() {
    return RUOLO === "paziente" && !!PIANO_ATTIVO && PIANO_ATTIVO.gestore === "paziente";
  }

  function contaPasti(piano, filtro) {
    let n = 0;
    Object.values((piano && piano.settimane) || {}).forEach((giorni) => {
      if (Array.isArray(giorni)) giorni.forEach((g) => { if (g) MEAL_KEYS.forEach((k) => { if (filtro(g[k])) n++; }); });
    });
    return n;
  }
  const pastiDaCompilare = (piano) => contaPasti(piano, (v) => v === DA_COMPILARE);
  const pastiCompilati = (piano) => contaPasti(piano, (v) => typeof v === "string" && v.trim().length > 1 && v !== DA_COMPILARE);

  /** Piano del paziente autonomo ancora da caricare (nessun pasto scritto). */
  function pianoAutonomoVuoto() {
    return gestisceIlPiano() && pastiCompilati(PIANO_ATTIVO) === 0 && pastiDaCompilare(PIANO_ATTIVO) === 0;
  }

  /** Piano del paziente autonomo in compilazione a mano. */
  function pianoInCompilazione() {
    return gestisceIlPiano() && pastiDaCompilare(PIANO_ATTIVO) > 0;
  }

  function lunediCorrenteISO() {
    const d = new Date();
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function attivaTab(view) {
    currentView = view;
    document.querySelectorAll(".tabbar__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.view === view));
  }

  function benvenutoAutonomoHTML() {
    if (pianoInCompilazione()) {
      const mancano = pastiDaCompilare(PIANO_ATTIVO);
      return `<section class="benvenuto-autonomo">
        <h2>Il tuo piano è in compilazione</h2>
        <p>${mancano === 1 ? "Manca ancora 1 pasto" : `Mancano ancora ${mancano} pasti`} da scrivere. Quando hai finito, qui compare il menù del giorno e partono i promemoria.</p>
        <button type="button" class="btn" data-mio-piano="modifica">Continua a compilare</button>
      </section>`;
    }
    return `<section class="benvenuto-autonomo">
      <h2>Benvenuto in Il mio Piano</h2>
      <p>Per iniziare carica il piano alimentare che ti ha dato il tuo nutrizionista: poi l'app ti mostra il menù del giorno e ti ricorda i pasti.</p>
      <button type="button" class="btn" data-mio-piano="importa">✨ Carica il PDF o le foto del piano</button>
      <p class="hint" style="margin-top:8px;">L'intelligenza artificiale legge il piano e lo converte: tu controlli e confermi. Con il primo caricamento parte la prova gratuita di Premium di 14 giorni.</p>
      <button type="button" class="btn btn--ghost" data-mio-piano="manuale">Oppure compilalo a mano</button>
    </section>`;
  }

  function mostraBenvenutoAutonomo() {
    root.innerHTML = benvenutoAutonomoHTML();
    collegaPulsantiMioPiano(root, currentView);
  }

  function collegaPulsantiMioPiano(contenitore, ritorno) {
    contenitore.querySelectorAll("[data-mio-piano]").forEach((b) => b.addEventListener("click", () => {
      EDITOR_PAZ.ritorno = ritorno || "oggi";
      if (b.dataset.mioPiano === "importa") avviaImportazionePaziente();
      else if (b.dataset.mioPiano === "manuale") creaBozzaManuale();
      else apriMioPiano();
    }));
  }

  /**
   * Consenso alle funzioni AI chiesto nel momento in cui serve (es. caricare il
   * PDF del piano): con "Attiva e continua" si registra il consenso, con lo
   * storico sul server, e si prosegue; in alternativa si compila a mano.
   */
  function chiediConsensoAI(poi, alternativa) {
    apriSheet(`
      <h2 class="sheet__titolo">Leggere il piano con l'intelligenza artificiale</h2>
      <p class="sheet__nota">Per leggere il PDF o le foto, e per riscontri, macronutrienti e stime, l'app usa l'intelligenza artificiale di Anthropic negli Stati Uniti. Riceve solo le pagine e i testi del piano e dei pasti, mai il tuo nome né la tua email; prima dell'invio vedi e copri i dati personali.</p>
      <label class="check-riga rep-consenso"><input type="checkbox" id="jit-consenso-ai"> <span>Acconsento all'invio dei testi del mio piano e dei pasti, senza nome né email, ad Anthropic negli Stati Uniti per le funzioni di intelligenza artificiale. Posso revocare il consenso in Impostazioni → Privacy.</span></label>
      <button type="button" class="btn" id="btn-jit-attiva" disabled>Attiva e continua</button>
      ${alternativa ? `<button type="button" class="btn btn--ghost" id="btn-jit-mano">Compilo il piano a mano</button>` : ""}
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>`);
    const casella = document.getElementById("jit-consenso-ai");
    const attiva = document.getElementById("btn-jit-attiva");
    casella.addEventListener("change", () => { attiva.disabled = !casella.checked; });
    attiva.addEventListener("click", async () => {
      attiva.disabled = true; attiva.textContent = "Attivo…";
      try {
        await window.cloud.chiamaFunzione("aggiornaConsensoAI", { si: true, da: "richiesta" });
        CONSENSO_AI = true;
        chiudiSheet();
        if (poi) poi();
      } catch (e) {
        attiva.disabled = false; attiva.textContent = "Attiva e continua";
        mostraToast(msgErroreScrittura(e, "Non salvato: controlla la connessione"), 4000);
      }
    });
    const mano = document.getElementById("btn-jit-mano");
    if (mano) mano.addEventListener("click", () => { chiudiSheet(); alternativa(); });
  }

  function contestoImportPaziente() {
    return {
      paziente: true,
      radice: () => root,
      titolo: () => { currentView = "importa"; root.dataset.vista = "importa"; window.scrollTo(0, 0); },
      indietroIcona: "piano", indietroTesto: "Il mio piano",
      indietro: () => apriMioPiano(),
      pianoCorrente: () => PIANO_ATTIVO,
      salvaTesto: "Salva il mio piano",
      conferma: () => (pastiCompilati(PIANO_ATTIVO) > 0 ? "Sostituire il tuo piano attuale con quello importato?" : null),
      extra: () => ({ bozza: false }),
      toastOk: "Piano salvato: ecco il tuo menù di oggi",
      dopoSalvataggio: () => { attivaTab("oggi"); render(); window.scrollTo(0, 0); aggiornaPremium(); },
    };
  }

  function avviaImportazionePaziente() {
    if (!gestisceIlPiano()) return;
    if (!CONSENSO_AI) { chiediConsensoAI(avviaImportazionePaziente, creaBozzaManuale); return; }
    if (premiumLimitato() && PREMIUM.provaUsata) { apriPremium(); return; }
    avviaImportazioneAI(PIANO_ATTIVO, contestoImportPaziente());
  }

  /** Compilazione a mano: una settimana di 7 giorni da riempire, poi la si copia nelle altre. */
  async function creaBozzaManuale() {
    if (!gestisceIlPiano()) return;
    const giorni = window.weekLogic.GIORNI.map((g) => {
      const d = { giorno: g, coccola: "", kcal: null };
      MEAL_KEYS.forEach((k) => { d[k] = DA_COMPILARE; });
      return d;
    });
    const esito = validaPiano({ paziente: PIANO_ATTIVO.paziente || {}, orariDefault: PIANO_ATTIVO.orariDefault || {}, normeGenerali: [], sostituzioni: [], settimane: { 1: giorni } });
    if (!esito.ok) { mostraToast("Non riesco a preparare il piano: riprova"); return; }
    try {
      await window.cloud.salvaPiano(PIANO_ATTIVO.id, Object.assign(esito.piano, { bozza: true, dataInizio: PIANO_ATTIVO.dataInizio || lunediCorrenteISO(), settimanaIniziale: 1 }));
      Object.assign(PIANO_ATTIVO, esito.piano);
      EDITOR_PAZ.settSel = 1; EDITOR_PAZ.giornoSel = 0;
      apriMioPiano();
    } catch (err) {
      mostraToast(msgErroreScrittura(err, "Non salvato: controlla la connessione"), 4000);
    }
  }

  function apriMioPiano() {
    attivaTab("mioPiano");
    document.querySelectorAll(".tabbar__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.view === "impostazioni"));
    render();
    window.scrollTo(0, 0);
  }

  /** Il piano ha già dei pasti scritti (per proporre la programmazione del successivo). */
  function pianoHaPasti(piano) {
    return Object.values((piano && piano.settimane) || {}).some((g) => Array.isArray(g) && g.some((d) => d && MEAL_KEYS.some((k) => typeof d[k] === "string" && d[k].trim().length > 1 && d[k] !== DA_COMPILARE)));
  }

  /** Piano successivo programmato ancora da partire (o null). */
  function pianoProgrammato(piano) {
    const pr = piano && piano.prossimo;
    return pr && typeof pr.dataInizio === "string" && pr.settimane && pr.dataInizio > oggiISO() ? pr : null;
  }

  function dataLunga(chiave) {
    const d = window.statistiche.daChiave(chiave);
    return d.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
  }

  function avvisoProgrammatoHTML(piano, conAnnulla) {
    const pr = pianoProgrammato(piano);
    if (!pr) return "";
    return `<div class="nota-versione">📅 Dal <strong>${escapeHTML(dataLunga(pr.dataInizio))}</strong> parte il nuovo piano (dalla Settimana ${pr.settimanaIniziale || 1}). Fino ad allora resta quello attuale.
      ${conAnnulla ? `<button type="button" class="link-btn link-btn--inline" id="btn-annulla-programmato">Annulla il piano programmato</button>` : ""}</div>`;
  }

  function collegaAnnullaProgrammato(piano, dopo) {
    const b = document.getElementById("btn-annulla-programmato");
    if (!b) return;
    b.addEventListener("click", async () => {
      if (!window.confirm("Annullare il piano programmato? Il piano attuale resterà in uso.")) return;
      try {
        await window.cloud.salvaPiano(piano.id, { prossimo: null });
        piano.prossimo = null;
        mostraToast("Piano programmato annullato");
        if (dopo) dopo();
      } catch (err) { mostraToast(msgErroreScrittura(err, "Non riuscito: controlla la connessione"), 4000); }
    });
  }

  /** Data di inizio e settimana del piano da cui partire (per paziente e professionista). */
  function sceltaInizioHTML(dataInizio, settimanaIniziale, numeri) {
    const sel = numeri.includes(Number(settimanaIniziale)) ? Number(settimanaIniziale) : numeri[0];
    return `
      <div class="ric-griglia">
        <label class="editor-campo"><span>Data di inizio</span><input type="date" id="inizio-data" value="${escapeHTML(dataInizio || "")}"></label>
        <label class="editor-campo"><span>Si parte dalla</span>
          <select id="inizio-settimana">${numeri.map((n) => `<option value="${n}" ${n === sel ? "selected" : ""}>Settimana ${n}</option>`).join("")}</select></label>
      </div>
      <p class="hint">Dalla settimana della data scelta il piano parte dalla settimana indicata, poi prosegue con le successive e ricomincia. Utile se il piano nuovo deve continuare un ciclo già avviato.</p>`;
  }

  /**
   * Partire da una settimana diversa dalla 1 serve solo per continuare un ciclo
   * già avviato (es. il menù di una mensa): chiede conferma, perché è facile
   * confondere la numerazione del piano con quella di un altro calendario.
   * Restituisce true se si può procedere.
   */
  function confermaSettimanaPartenza(inizio, settimanaPrima) {
    const n = Number(inizio && inizio.settimanaIniziale) || 1;
    if (n === 1 || n === Number(settimanaPrima)) return true;
    const quando = inizio.dataInizio ? `dalla settimana del ${dataLunga(inizio.dataInizio)}` : "dalla data di inizio";
    return window.confirm(`Hai scelto di partire dalla Settimana ${n}: ${quando} l'app mostrerà i pasti della Settimana ${n} del piano, non della Settimana 1.\n\nControlla la numerazione del piano: se nel documento la prima settimana da seguire è la "Settimana 1", lascia la 1.\n\nVuoi partire davvero dalla Settimana ${n}?`);
  }

  function leggiSceltaInizio() {
    const data = (document.getElementById("inizio-data") || {}).value || "";
    const sett = Number((document.getElementById("inizio-settimana") || {}).value) || 1;
    return { dataInizio: /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : null, settimanaIniziale: sett };
  }

  function renderMioPiano() {
    if (!gestisceIlPiano()) { attivaTab("oggi"); renderOggi(); return; }
    const piano = PIANO_ATTIVO;
    const disponibili = [1, 2, 3, 4, 5].filter((n) => Array.isArray(piano.settimane && piano.settimane[n]));
    if (!disponibili.includes(EDITOR_PAZ.settSel)) EDITOR_PAZ.settSel = disponibili[0] || 1;
    const mancano = pastiDaCompilare(piano);
    root.innerHTML = `
      <div class="nav-riga">${navLink("btn-mio-piano-indietro", "piano", EDITOR_PAZ.ritorno === "impostazioni" ? "Impostazioni" : "Oggi", true)}</div>
      <section class="settings-section">
        <h2>Il mio piano</h2>
        ${!disponibili.length ? `<p class="hint">Il piano è ancora vuoto.</p>` : mancano
          ? `<p class="hint">Scegli un giorno, scrivi i pasti e salva: si passa da solo al giorno dopo. ${mancano === 1 ? "Manca 1 pasto" : `Mancano ${mancano} pasti`}. Se le settimane si ripetono, compilane una e copiala nelle altre qui sotto.</p>`
          : `<p class="hint">Qui puoi correggere un pasto, copiare una settimana o caricare un nuovo piano quando il nutrizionista te lo cambia.</p>`}
        ${avvisoProgrammatoHTML(PIANO_GREZZO || piano, true)}
        <button type="button" class="btn" id="btn-mio-piano-importa">${premiumLimitato() && PREMIUM.provaUsata ? "🔒" : "✨"} ${disponibili.length ? "Carica un nuovo piano (PDF o foto)" : "Carica il PDF o le foto del piano"}</button>
        ${premiumLimitato() && PREMIUM.provaUsata ? `<p class="stat-nota" style="margin-top:6px;">La lettura con l'AI fa parte di Premium. Puoi sempre modificare il piano a mano qui sotto.</p>` : ""}
        ${disponibili.length ? "" : `<button type="button" class="btn btn--ghost" id="btn-mio-piano-manuale" style="margin-top:8px;">Compila a mano</button>`}
      </section>
      ${disponibili.length ? `
      ${renderEditorPastoHTML(piano, EDITOR_PAZ.settSel, EDITOR_PAZ.giornoSel, disponibili)}
      ${renderCopiaSettimanaHTML(disponibili, EDITOR_PAZ.settSel)}
      <section class="settings-section">
        <h2>Inizio del piano</h2>
        ${sceltaInizioHTML(piano.dataInizio, piano.settimanaIniziale, disponibili)}
        <button type="button" class="btn btn--ghost" id="btn-mio-data-inizio" style="margin-top:8px;">Salva</button>
      </section>
      <section class="settings-section">
        <h2>Regole generali</h2>
        <p class="hint">Le indicazioni generali del nutrizionista (acqua, olio, cotture…), una per riga.</p>
        <textarea id="mio-norme" rows="5" style="width:100%;">${(piano.normeGenerali || []).map(escapeHTML).join("\n")}</textarea>
        <button type="button" class="btn btn--ghost" id="btn-mio-norme" style="margin-top:8px;">Salva le regole</button>
      </section>
      <section class="settings-section">
        <h2>Sostituzioni</h2>
        <p class="hint">Gli alimenti equivalenti indicati dal nutrizionista. Un gruppo per riga: <code class="inline">Nome: opzione 1, opzione 2</code>.</p>
        <textarea id="mio-sostituzioni" rows="5" style="width:100%;" placeholder="Frutta: Mela 150g, Pera 150g, Arancia 150g">${(piano.sostituzioni || []).map((g) => escapeHTML(g.nome + ": " + g.opzioni.join(", "))).join("\n")}</textarea>
        <button type="button" class="btn btn--ghost" id="btn-mio-sostituzioni" style="margin-top:8px;">Salva le sostituzioni</button>
      </section>` : ""}`;
    document.getElementById("btn-mio-piano-indietro").addEventListener("click", () => { attivaTab(EDITOR_PAZ.ritorno === "impostazioni" ? "impostazioni" : "oggi"); render(); });
    document.getElementById("btn-mio-piano-importa").addEventListener("click", avviaImportazionePaziente);
    collegaAnnullaProgrammato(PIANO_GREZZO || piano, renderMioPiano);
    const manuale = document.getElementById("btn-mio-piano-manuale");
    if (manuale) manuale.addEventListener("click", creaBozzaManuale);
    if (!disponibili.length) return;
    document.getElementById("sel-edit-settimana").addEventListener("change", (e) => { EDITOR_PAZ.settSel = Number(e.target.value); EDITOR_PAZ.giornoSel = 0; renderMioPiano(); });
    document.getElementById("sel-edit-giorno").addEventListener("change", (e) => { EDITOR_PAZ.giornoSel = Number(e.target.value); renderMioPiano(); });
    document.getElementById("btn-salva-pasto").addEventListener("click", salvaGiornoPaziente);
    collegaCopiaSettimana(piano, (nuovo) => { Object.assign(PIANO_ATTIVO, nuovo); controllaPianoCompleto(nuovo); renderMioPiano(); });
    document.getElementById("btn-mio-data-inizio").addEventListener("click", async () => {
      const inizio = leggiSceltaInizio();
      if (!confermaSettimanaPartenza(inizio, piano.settimanaIniziale)) return;
      try { await window.cloud.salvaPiano(piano.id, inizio); Object.assign(piano, inizio); mostraToast("Inizio del piano salvato"); }
      catch (err) { mostraToast(msgErroreScrittura(err, "Non salvata: controlla la connessione")); }
    });
    document.getElementById("btn-mio-norme").addEventListener("click", async () => {
      const normeGenerali = document.getElementById("mio-norme").value.split("\n").map((r) => r.trim()).filter(Boolean);
      try { await window.cloud.salvaPiano(piano.id, { normeGenerali }); mostraToast("Regole salvate"); }
      catch (err) { mostraToast(msgErroreScrittura(err, "Non salvate: controlla la connessione")); }
    });
    document.getElementById("btn-mio-sostituzioni").addEventListener("click", async () => {
      const righe = document.getElementById("mio-sostituzioni").value.split("\n").map((x) => x.trim()).filter(Boolean);
      const errata = righe.find((r) => { const i = r.indexOf(":"); return i <= 0 || r.slice(i + 1).split(",").map((o) => o.trim()).filter(Boolean).length < 2; });
      if (errata) { mostraToast("Riga non valida (serve \"Nome: opzione1, opzione2\"): " + errata, 5000); return; }
      const sostituzioni = righe.map((r) => { const i = r.indexOf(":"); return { nome: r.slice(0, i).trim(), opzioni: r.slice(i + 1).split(",").map((o) => o.trim()).filter(Boolean) }; });
      try { await window.cloud.salvaPiano(piano.id, { sostituzioni }); mostraToast("Sostituzioni salvate"); }
      catch (err) { mostraToast(msgErroreScrittura(err, "Non salvate: controlla la connessione")); }
    });
  }

  async function salvaGiornoPaziente() {
    const piano = PIANO_ATTIVO;
    const { settSel, giornoSel } = EDITOR_PAZ;
    const campi = {};
    document.querySelectorAll("#editor-pasti-form [data-campo]").forEach((el) => { campi[el.dataset.campo] = el.value.trim(); });
    if (!campi.colazione) campi.colazione = "Nessuna colazione";
    if (!campi.spuntinoMattina) campi.spuntinoMattina = "Nessuno spuntino";
    if (!campi.spuntinoPomeriggio) campi.spuntinoPomeriggio = "Nessuno spuntino";
    const mancanti = ["pranzo", "cena"].filter((k) => !campi[k]);
    if (mancanti.length) { mostraToast("Scrivi anche " + mancanti.map((k) => MEAL_META[k].label.toLowerCase()).join(" e ") + " (o \"Pasto libero\")", 4200); return; }
    const modificato = JSON.parse(JSON.stringify({ paziente: piano.paziente || {}, orariDefault: piano.orariDefault || {}, normeGenerali: piano.normeGenerali || [], sostituzioni: piano.sostituzioni || [], settimane: piano.settimane }));
    const g = modificato.settimane[settSel][giornoSel];
    MEAL_KEYS.forEach((k) => { g[k] = campi[k]; });
    g.coccola = campi.coccola || "";
    const kcal = Number(campi.kcal);
    g.kcal = campi.kcal && !Number.isNaN(kcal) ? kcal : null;
    const esito = validaPiano(modificato);
    if (!esito.ok) { mostraToast("Non salvato — " + esito.errori[0], 4200); return; }
    const btn = document.getElementById("btn-salva-pasto");
    btn.disabled = true; btn.textContent = "Salvataggio…";
    try {
      await window.cloud.salvaPiano(piano.id, esito.piano);
      Object.assign(PIANO_ATTIVO, esito.piano);
      mostraToast(`${window.weekLogic.GIORNI[giornoSel]} salvato`);
      const completo = await controllaPianoCompleto(esito.piano);
      if (!completo && giornoSel < 6) EDITOR_PAZ.giornoSel = giornoSel + 1;
      renderMioPiano();
      if (completo) mostraToast("Piano completo: ecco il tuo menù nella scheda Oggi", 4000);
    } catch (err) {
      btn.disabled = false; btn.textContent = "Salva questo giorno";
      mostraToast(msgErroreScrittura(err, "Salvataggio non riuscito: controlla la connessione"), 4000);
    }
  }

  /** Quando non resta nessun pasto da scrivere: fine bozza e avvio della prova Premium. */
  async function controllaPianoCompleto(piano) {
    if (pastiDaCompilare(piano) > 0) return false;
    if (PIANO_ATTIVO.bozza) {
      try { await window.cloud.salvaPiano(PIANO_ATTIVO.id, { bozza: false }); PIANO_ATTIVO.bozza = false; } catch (e) { /* riprova al prossimo salvataggio */ }
    }
    if (!PROVA_RICHIESTA && window.cloud.chiamaFunzione) {
      PROVA_RICHIESTA = true;
      window.cloud.chiamaFunzione("avviaProva").then((r) => {
        if (r && r.attivo && r.origine === "prova") mostraToast("Prova gratuita di Premium attiva per 14 giorni", 4000);
        aggiornaPremium();
      }).catch(() => { PROVA_RICHIESTA = false; });
    }
    return true;
  }

  /** Riepilogo in cima alla scheda Oggi: avanzamento (anello, segmenti o numero, secondo lo stile) e prossimo pasto. */
  function riepilogoGiornoHTML({ settimana, giornoNome, giorno, orari, statoDi, numFatti, numDiversi, numParziali }) {
    const tot = MEAL_KEYS.length;
    const prossimo = MEAL_KEYS.find((k) => !statoDi(k));
    const circ = 2 * Math.PI * 27;
    const quota = (numFatti + 0.5 * (numDiversi + numParziali)) / tot;
    const dettagli = [numDiversi ? `${numDiversi} ${numDiversi === 1 ? "diverso" : "diversi"}` : "", numParziali ? `${numParziali} in parte` : ""].filter(Boolean).join(", ");
    return `
      <section class="oggi-riepilogo" aria-label="Riepilogo della giornata">
        <div class="oggi-riepilogo__segmenti" aria-hidden="true">${MEAL_KEYS.map((k) => `<span class="seg seg--${statoDi(k) || (k === prossimo ? "prossimo" : "vuoto")}"></span>`).join("")}</div>
        <div class="oggi-riepilogo__corpo">
          <svg class="oggi-riepilogo__anello" width="60" height="60" viewBox="0 0 64 64" aria-hidden="true">
            <circle cx="32" cy="32" r="27" fill="none" stroke-width="7" class="anello__fondo"></circle>
            <circle cx="32" cy="32" r="27" fill="none" stroke-width="7" stroke-linecap="round" class="anello__valore" stroke-dasharray="${(quota * circ).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 32 32)"></circle>
            <text x="32" y="37" text-anchor="middle" class="anello__testo">${numFatti}/${tot}</text>
          </svg>
          <div class="oggi-riepilogo__testi">
            <span class="oggi-riepilogo__eyebrow">Settimana ${settimana} · ${escapeHTML(giornoNome)}</span>
            <span class="oggi-riepilogo__titolo">${numFatti === tot ? "Tutti i pasti fatti" : `${numFatti} ${numFatti === 1 ? "pasto" : "pasti"} su ${tot} fatti`}${dettagli ? `<small>, ${dettagli}</small>` : ""}</span>
            <span class="oggi-riepilogo__prossimo">${prossimo ? `Prossimo: ${MEAL_META[prossimo].label.toLowerCase()}${orari[prossimo] ? ` alle ${orari[prossimo]}` : ""}` : "Giornata completata"}</span>
          </div>
          <span class="oggi-riepilogo__numero" aria-hidden="true"><b>${numFatti}</b>/${tot}</span>
        </div>
        ${allenamentiOggiHTML()}
        ${giorno.kcal != null || (PIANO_ATTIVO.paziente && PIANO_ATTIVO.paziente.obiettivo) ? `<div class="oggi-riepilogo__pill">
          ${giorno.kcal != null ? `<span class="pill pill--kcal">${giorno.kcal} kcal circa</span>` : ""}
          ${PIANO_ATTIVO.paziente && PIANO_ATTIVO.paziente.obiettivo ? `<span class="pill">${escapeHTML(PIANO_ATTIVO.paziente.obiettivo)}</span>` : ""}
        </div>` : ""}
      </section>`;
  }

  function renderOggi() {
    if (pianoAutonomoVuoto() || pianoInCompilazione()) { mostraBenvenutoAutonomo(); return; }
    if (!PIANO_ATTIVO) {
      root.innerHTML = `<div class="empty">Il tuo professionista non ha ancora assegnato un piano a questo account. Controlla di nuovo più tardi.</div>`;
      return;
    }

    const oggi = new Date();
    const { settimana, giornoNome, giorno, pianoIniziato } = window.weekLogic.menuDelGiorno(oggi, CONFIG, PIANO_ATTIVO);
    const orari = orariEffettivi();
    const avvisoInizio = (pianoIniziato === false && PIANO_ATTIVO.dataInizio)
      ? `<p class="hint avviso-inizio">Il tuo piano inizia ${formattaDataIt(PIANO_ATTIVO.dataInizio)}. Intanto puoi dare un'occhiata alla prima settimana.</p>`
      : "";

    if (!giorno) {
      root.innerHTML = `<div class="empty">Nessun dato disponibile per oggi nel piano caricato.</div>`;
      return;
    }

    const fatti = PASTI_FATTI_OGGI;
    const statoDi = (k) => window.statistiche.statoPasto(fatti, k);
    const numFatti = MEAL_KEYS.filter((k) => statoDi(k) === "fatto").length;
    const numParziali = MEAL_KEYS.filter((k) => statoDi(k) === "parziale").length;
    const numDiversi = MEAL_KEYS.filter((k) => statoDi(k) === "diverso").length;

    root.innerHTML = `
      ${bannerPremiumHTML()}
      ${avvisoProgrammatoHTML(PIANO_GREZZO, false)}
      ${renderBannerRiattivaHTML()}
      ${renderAvvisoAppuntamentoHTML()}
      ${avvisoPesataHTML()}
      ${renderBannerIosHTML()}
      ${avvisoInizio}
      ${riepilogoGiornoHTML({ settimana, giornoNome, giorno, orari, statoDi, numFatti, numDiversi, numParziali })}
      ${macroOggiHTML(giorno, fatti)}
      <div class="timeline">${renderTimelineHTML(giorno, orari, { checkable: true, fatti })}</div>
      ${renderCoccolaHTML(giorno)}
      ${renderNormeHTML()}
      ${renderContattoNutrizionistaHTML()}
    `;

    aggiornaMacro(giorno);

    root.querySelectorAll("[data-meal-check]").forEach((btn) => {
      btn.addEventListener("click", () => onToggleMealCheck(btn.dataset.mealCheck));
    });
    collegaAllenamentiOggi();
    root.querySelectorAll("[data-meal-apri]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const art = btn.closest(".meal");
        const aperta = art.classList.toggle("is-aperta");
        btn.setAttribute("aria-expanded", String(aperta));
        if (aperta) PASTI_APERTI.add(btn.dataset.mealApri); else PASTI_APERTI.delete(btn.dataset.mealApri);
      });
    });
    root.querySelectorAll("[data-meal-altro]").forEach((btn) => {
      btn.addEventListener("click", () => apriStatoPasto(btn.dataset.mealAltro));
    });
    collegaBannerIos();
    collegaBannerRiattiva();
    collegaContattoNutrizionista();
    root.querySelectorAll("[data-chiudi-riscontro]").forEach((b) => b.addEventListener("click", () => {
      const chiusi = riscontriChiusi(); chiusi[b.dataset.chiudiRiscontro] = 1;
      localStorage.setItem(LS_RISCONTRI_CHIUSI, JSON.stringify(chiusi));
      renderOggi();
    }));
    const bPesata = document.getElementById("btn-pesata-oggi");
    if (bPesata) bPesata.addEventListener("click", apriPesataPaziente);
  }

  function renderTimelineHTML(giorno, orari, opts) {
    opts = opts || {};
    const fatti = opts.fatti || {};
    // Vista Oggi: il primo pasto non ancora segnato è "attuale" (in evidenza),
    // gli altri sono righe compatte che si aprono con un tocco.
    const attuale = opts.checkable ? MEAL_KEYS.find((k) => !window.statistiche.statoPasto(fatti, k)) : null;
    const ICONA_STATO = {
      fatto: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
      diverso: '<span aria-hidden="true">↺</span>', parziale: '<span aria-hidden="true">½</span>', saltato: '<span aria-hidden="true">✕</span>',
    };
    return MEAL_KEYS.map((key) => {
      const meta = MEAL_META[key];
      const stato = window.statistiche.statoPasto(fatti, key);
      const isDone = stato === "fatto";
      const sost = trovaSostituzioneMeal(giorno[key]);
      const modo = !opts.checkable ? "" : key === attuale ? "meal--attuale" : stato ? "meal--chiusa" : "meal--compatta";
      const compatto = modo === "meal--chiusa" || modo === "meal--compatta";
      // resta aperto se l'utente l'ha aperto, o se c'è un consiglio AI in arrivo o da leggere
      const aperto = compatto && (PASTI_APERTI.has(key) || (stato && riscontroPastoHTML(key, stato) !== ""));
      const testaContenuto = `
            <span class="meal__stato meal__stato--${stato || "vuoto"}" aria-hidden="true">${stato ? ICONA_STATO[stato] || "" : ""}</span>
            <span class="meal__label">${meta.label}</span>
            <span class="meal__time">${orari[key] || ""}</span>`;
      return `
        <article class="meal ${meta.classe} ${modo} ${aperto ? "is-aperta" : ""} ${isDone ? "is-done" : ""} ${stato === "parziale" ? "is-parziale" : ""} ${stato === "saltato" ? "is-saltato" : ""} ${stato === "diverso" ? "is-diverso" : ""}">
          ${compatto
            ? `<button type="button" class="meal__head meal__apri" aria-expanded="${aperto}" data-meal-apri="${key}">${testaContenuto}</button>`
            : `<div class="meal__head">${testaContenuto}</div>`}
          <p class="meal__desc">${testoPastoHTML(giorno[key])}</p>
          ${opts.checkable ? `
            <div class="meal__azioni">
              ${stato === "parziale" || stato === "saltato" || stato === "diverso" ? `
                <button type="button" class="meal__check meal__check--${stato}" data-meal-altro="${key}" aria-pressed="true">
                  ${stato === "diverso" ? '<span aria-hidden="true">↺</span>' : stato === "parziale" ? `<svg class="icona-meta" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></svg>` : `<span aria-hidden="true">✕</span>`}
                  <span>${stato === "diverso" ? "Fatto diversamente" : stato === "parziale" ? "Fatto in parte" : "Saltato"}${fatti.note && fatti.note[key]
                    ? ` · ${escapeHTML(fatti.note[key].length > 48 ? fatti.note[key].slice(0, 46) + "…" : fatti.note[key])}`
                    : fatti.motivi && fatti.motivi[key] && window.statistiche.MOTIVI[fatti.motivi[key]] ? ` · ${escapeHTML(window.statistiche.MOTIVI[fatti.motivi[key]].toLowerCase())}` : ""}</span>
                </button>` : `
                <button type="button" class="meal__check" data-meal-check="${key}" aria-pressed="${isDone}">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12.5 9.5 18 20 6"/></svg>
                  <span>${isDone ? "Fatto" : modo === "meal--attuale" ? "Fatto" : "Segna come fatto"}</span>
                </button>`}
              <button type="button" class="meal__altro" data-meal-altro="${key}">${stato ? "Modifica" : modo === "meal--attuale" ? "Non come da piano" : "Non come da piano?"}</button>
            </div>
            ${riscontroPastoHTML(key, stato)}
          ` : ""}
          ${RUOLO === "paziente" && window.conversioni && window.conversioni.riconosci(giorno[key], RESE_AI).length ? `
            <button type="button" class="meal__cotto" data-cotto="${escapeHTML(giorno[key])}" data-cotto-pasto="${key}">${premiumLimitato() ? "🔒" : "⚖️"} Peso da cotto</button>` : ""}
          ${sost ? `
            <details class="meal__sostituzioni">
              <summary>Sostituisci (${escapeHTML(sost.nome)})</summary>
              <ul>${sost.alternative.map((o) => `<li>${escapeHTML(o)}</li>`).join("")}</ul>
              <p class="meal__sostituzioni-nota">Alternative equivalenti indicate dal tuo nutrizionista.</p>
            </details>
          ` : ""}
        </article>
      `;
    }).join("");
  }

  /**
   * Cerca, nella tabella sostituzioni del piano, un gruppo la cui opzione
   * compare (per nome) nel testo del pasto — restituisce il gruppo e fino a
   * 3 alternative diverse da quella già presente. Le opzioni e l'equivalenza
   * nutrizionale sono quelle scritte dal professionista, non generate qui.
   */
  function trovaSostituzioneMeal(testoPasto) {
    const sostituzioni = (PIANO_ATTIVO && PIANO_ATTIVO.sostituzioni) || [];
    if (!sostituzioni.length || !testoPasto) return null;
    const testoLower = testoPasto.toLowerCase();
    for (const gruppo of sostituzioni) {
      const opzioneCorrispondente = gruppo.opzioni.find((o) => {
        const base = o.replace(/\s*\d.*$/, "").trim().toLowerCase();
        return base && testoLower.includes(base);
      });
      if (opzioneCorrispondente) {
        const alternative = gruppo.opzioni.filter((o) => o !== opzioneCorrispondente).slice(0, 3);
        if (alternative.length) return { nome: gruppo.nome, alternative };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Spunta "pasto effettuato" — sincronizzata su Firestore per paziente/giorno
  // ---------------------------------------------------------------------
  function chiaveData(date) {
    const d = date || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function collegaAscoltoPastiOggi() {
    if (unsubPastiOggi) unsubPastiOggi();
    const dateKey = chiaveData(new Date());
    collegaRiscontriOggi(dateKey);
    unsubPastiOggi = window.cloud.ascoltaPastiFattiCloud(UID, dateKey, (stato) => {
      PASTI_FATTI_OGGI = stato || {};
      if (currentView === "oggi") renderOggi();
    });
    if (unsubAttivitaOggi) unsubAttivitaOggi();
    unsubAttivitaOggi = window.cloud.ascoltaAttivita ? window.cloud.ascoltaAttivita(UID, dateKey, (dati) => {
      ATTIVITA_OGGI = dati || {};
      if (currentView === "oggi") renderOggi();
    }) : null;
  }

  // ---------------------------------------------------------------------
  // Allenamenti del giorno (fase 0: inseriti a mano)
  // ---------------------------------------------------------------------
  const TIPI_ALLENAMENTO = ["Corsa", "Camminata veloce", "Bici", "Palestra / pesi", "Nuoto", "Sport di squadra", "Yoga / pilates", "Altro"];
  const INTENSITA = [["leggera", "Leggera"], ["moderata", "Moderata"], ["intensa", "Intensa"]];

  /** Sintesi degli allenamenti di un periodo: { n, minuti, giorni, perTipo, perIntensita } */
  function sintesiAllenamenti(perGiorno, daGiorno) {
    const out = { n: 0, minuti: 0, giorni: 0, perTipo: {}, perIntensita: {} };
    Object.keys(perGiorno || {}).filter((g) => !daGiorno || g >= daGiorno).forEach((g) => {
      const lista = Array.isArray(perGiorno[g].allenamenti) ? perGiorno[g].allenamenti : [];
      if (lista.length) out.giorni++;
      lista.forEach((a) => {
        out.n++; out.minuti += Number(a.durata) || 0;
        out.perTipo[a.tipo || "Altro"] = (out.perTipo[a.tipo || "Altro"] || 0) + 1;
        if (a.intensita) out.perIntensita[a.intensita] = (out.perIntensita[a.intensita] || 0) + 1;
      });
    });
    return out;
  }

  function testoSintesiAllenamenti(x) {
    if (!x.n) return null;
    const ore = Math.round((x.minuti / 60) * 10) / 10;
    const tipi = Object.keys(x.perTipo).sort((a, b) => x.perTipo[b] - x.perTipo[a]).slice(0, 3).map((t) => `${t.toLowerCase()} ${x.perTipo[t]}`).join(", ");
    const intens = ["intensa", "moderata", "leggera"].filter((k) => x.perIntensita[k]).map((k) => `${x.perIntensita[k]} ${k === "intensa" ? "intensi" : k === "moderata" ? "moderati" : "leggeri"}`).join(", ");
    return {
      riga: `${x.n} ${x.n === 1 ? "allenamento" : "allenamenti"} in ${x.giorni} ${x.giorni === 1 ? "giorno" : "giorni"}, circa ${String(ore).replace(".", ",")} ore`,
      dettaglio: [tipi, intens].filter(Boolean).join(" · "),
    };
  }

  /** "Bici" oppure "Bici indoor" (rulli, tapis roulant, virtuale). */
  function nomeAllenamento(a) { return `${a.tipo || "Allenamento"}${a.indoor ? " indoor" : ""}`; }

  function descriviAllenamento(a) {
    return [nomeAllenamento(a), a.durata ? `${a.durata} min` : "", a.distanzaKm ? `${String(a.distanzaKm).replace(".", ",")} km` : "",
      a.intensita || "", a.ora ? `alle ${a.ora}` : ""].filter(Boolean).join(" · ");
  }

  function numeroIt(n) { return Number(n).toLocaleString("it-IT"); }

  const FONTI_INTENSITA = { potenza: "calcolata dalla potenza", zone: "calcolata dalle zone di frequenza cardiaca", fc: "calcolata dalla frequenza cardiaca media" };

  /** Righe di dati di un allenamento importato (anteprima e dettaglio). */
  function righeAllenamentoHTML(a) {
    const righe = [];
    if (a.durata) righe.push(["Durata", `${a.durata} min`]);
    if (a.distanzaKm) righe.push(["Distanza", `${String(a.distanzaKm).replace(".", ",")} km`]);
    if (a.dislivelloM) righe.push(["Dislivello", `${numeroIt(a.dislivelloM)} m`]);
    if (a.fcMedia) righe.push(["Frequenza cardiaca", `media ${a.fcMedia}${a.fcMax ? ` · max ${a.fcMax}` : ""} bpm`]);
    if (a.potenzaMedia) righe.push(["Potenza", `media ${a.potenzaMedia} W${a.potenzaNormalizzata ? ` · normalizzata ${a.potenzaNormalizzata} W` : ""}`]);
    if (a.kcal) righe.push(["Calorie", `${numeroIt(a.kcal)} kcal · stima del dispositivo`]);
    let zone = "";
    if (Array.isArray(a.zoneFC)) {
      const tot = a.zoneFC.reduce((x, y) => x + y, 0) || 1;
      zone = `<div class="zone-fc" role="img" aria-label="Minuti nelle zone: ${a.zoneFC.map((m, i) => `Z${i + 1} ${m}`).join(", ")}">
          ${a.zoneFC.map((m, i) => m ? `<span class="zone-fc__z zone-fc__z--${i + 1}" style="flex:${m / tot}">${m / tot >= 0.09 ? `Z${i + 1} · ${m}′` : ""}</span>` : "").join("")}
        </div>
        <p class="stat-nota">Minuti nelle zone di frequenza cardiaca (calcolate dalla FC ${a.zoneBase === "soglia" ? "di soglia" : "massima"} indicata in Impostazioni).</p>`;
    }
    const indici = [];
    if (a.lavoroKJ) indici.push(["Lavoro", `${numeroIt(a.lavoroKJ)} kJ`, "Energia prodotta sui pedali: in bici è circa pari alle kcal spese."]);
    if (a.kcalOra) indici.push(["Calorie all'ora", `${numeroIt(a.kcalOra)} kcal/h`, "Stima del dispositivo, divisa per la durata."]);
    if (a.fattoreIntensita) indici.push(["Fattore di intensità", String(a.fattoreIntensita).replace(".", ","), "Potenza normalizzata rispetto alla FTP: sotto 0,75 uscita facile, oltre 0,90 impegnativa."]);
    if (a.tss) indici.push(["Carico (TSS)", String(a.tss), "Un'ora alla soglia vale 100."]);
    if (a.derivaCardiaca != null) indici.push(["Deriva cardiaca", `${String(a.derivaCardiaca).replace(".", ",")}%`, a.derivaCardiaca < 5 ? "Sotto il 5%: sforzo aerobico stabile per tutta l'uscita." : "Oltre il 5%: nella seconda metà la frequenza è salita a parità di potenza (fatica, caldo, poca energia o liquidi)."]);
    const blocco = indici.length ? `<p class="impost-etichetta" style="margin-top:12px;">Indici</p><div class="allenamento-dati">${indici.map(([k, v, h]) => `<p class="stat-riga"><span>${k}</span><strong>${escapeHTML(v)}</strong></p><p class="stat-nota allenamento-indice-nota">${escapeHTML(h)}</p>`).join("")}</div>` : "";
    return `<div class="allenamento-dati">${righe.map(([k, v]) => `<p class="stat-riga"><span>${k}</span><strong>${escapeHTML(v)}</strong></p>`).join("")}</div>${zone}${blocco}`;
  }

  /** Android: file condiviso da un'altra app ("Condividi con Il mio Piano"), messo da parte dal service worker. */
  /** App Android: il file arriva dal plugin nativo FileCondiviso (base64), non dalla cache del service worker. */
  let ascoltoFileNativo = false;
  async function prendiFileCondivisoNativo() {
    const P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FileCondiviso;
    if (!P) return;
    if (!ascoltoFileNativo) {
      ascoltoFileNativo = true;
      P.addListener("fileCondiviso", () => prendiFileCondivisoNativo());
    }
    try {
      const r = await P.prendi();
      if (!r || !r.dati) return;
      const bin = atob(r.dati);
      const byte = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) byte[i] = bin.charCodeAt(i);
      apriImportaAllenamento(new File([byte], r.nome || "allenamento.fit"));
    } catch (e) { mostraToast("Non riesco ad aprire il file condiviso"); }
  }

  async function controllaAllenamentoCondiviso() {
    if (RUOLO === "paziente" && window.allenamentoFile && window.cloud.nativo) { prendiFileCondivisoNativo(); return; }
    if (RUOLO !== "paziente" || !window.allenamentoFile || !("caches" in window)) return;
    const parametri = new URLSearchParams(location.search);
    if (!parametri.has("importa-allenamento")) return;
    parametri.delete("importa-allenamento");
    history.replaceState(null, "", location.pathname + (parametri.toString() ? "?" + parametri : "") + location.hash);
    try {
      const cache = await caches.open("pnut-condivisi");
      const r = await cache.match("/condiviso/allenamento");
      if (!r) { mostraToast("Il file condiviso non è arrivato: riprova"); return; }
      const nome = decodeURIComponent(r.headers.get("x-nome") || "allenamento.fit");
      const file = new File([await r.blob()], nome);
      await cache.delete("/condiviso/allenamento");
      apriImportaAllenamento(file);
    } catch (e) { mostraToast("Non riesco ad aprire il file condiviso"); }
  }

  /** Toglie un allenamento da un giorno (oggi o uno dei giorni passati). */
  async function eliminaAllenamento(giorno, id) {
    const oggi = chiaveData(new Date());
    const attuali = giorno === oggi ? (ATTIVITA_OGGI.allenamenti || [])
      : (((await window.cloud.leggiAttivitaPeriodo(UID, giorno))[giorno] || {}).allenamenti || []);
    await window.cloud.salvaAttivita(UID, giorno, { allenamenti: attuali.filter((x) => x.id !== id) });
  }

  function apriDettaglioAllenamento(id, giorno, dati) {
    const oggiK = chiaveData(new Date());
    giorno = giorno || oggiK;
    const a = dati || (ATTIVITA_OGGI.allenamenti || []).find((x) => x.id === id);
    if (!a) return;
    apriSheet(`
      <h2 class="sheet__titolo">${escapeHTML(nomeAllenamento(a))}${giorno !== oggiK ? ` · ${escapeHTML(dataLunga(giorno))}` : ""}${a.ora ? ` · alle ${escapeHTML(a.ora)}` : ""}</h2>
      ${a.fonte === "file" ? righeAllenamentoHTML(a) : `<p class="sheet__nota">${escapeHTML(descriviAllenamento(a))}</p>`}
      ${a.intensita ? `<p class="stat-riga"><span>Intensità</span><strong>${escapeHTML(a.intensita)}${a.intensitaFonte && FONTI_INTENSITA[a.intensitaFonte] ? ` · ${FONTI_INTENSITA[a.intensitaFonte]}` : ""}</strong></p>` : ""}
      <p class="sheet__nota">Le calorie sono quelle stimate dal tuo dispositivo: non cambiano le quantità del piano. Se il piano va adattato agli allenamenti, lo decide il tuo nutrizionista.</p>
      <button type="button" class="btn btn--ghost btn--pericolo" id="btn-elimina-allenamento">Elimina questo allenamento</button>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Chiudi</button>`);
    const el = document.getElementById("btn-elimina-allenamento");
    el.addEventListener("click", async () => {
      if (el.dataset.conferma !== "1") { el.dataset.conferma = "1"; el.textContent = "Tocca di nuovo per eliminare"; return; }
      el.disabled = true;
      try {
        await eliminaAllenamento(giorno, a.id);
        chiudiSheet();
        mostraToast("Allenamento eliminato");
      } catch (e) { el.disabled = false; mostraToast(msgErroreScrittura(e, "Non eliminato: controlla la connessione"), 4000); }
    });
  }

  /** Allenamenti degli ultimi 7 giorni, per rivederli, eliminarli o reimportarli. */
  async function apriAllenamentiRecenti() {
    apriSheet(`<h2 class="sheet__titolo">Ultimi 7 giorni</h2><p class="sheet__nota">Carico gli allenamenti…</p>`);
    const da = chiaveData(new Date(Date.now() - 7 * 86400000));
    let perGiorno = {};
    try { perGiorno = await window.cloud.leggiAttivitaPeriodo(UID, da); } catch (e) { /* elenco vuoto */ }
    const voci = [];
    Object.keys(perGiorno).sort().reverse().forEach((g) => (perGiorno[g].allenamenti || []).forEach((a) => voci.push({ g, a })));
    apriSheet(`
      <h2 class="sheet__titolo">Ultimi 7 giorni</h2>
      <p class="sheet__nota">Tocca un allenamento per vederne i dati o eliminarlo. Per aggiornare i dati di un file già importato, importalo di nuovo.</p>
      ${voci.length ? `<ul class="stat-note-pasti">${voci.map(({ g, a }, i) => `<li><button type="button" class="stat-nota-pasto allenamento-prof" data-recente="${i}">
          <span class="stat-nota-pasto__testa">${escapeHTML(dataLunga(g).replace(/^./, (c) => c.toUpperCase()))}</span>
          <span>${escapeHTML(descriviAllenamento(a))}${a.fonte === "file" ? " · da file" : " · segnato a mano"}</span></button></li>`).join("")}</ul>`
        : `<p class="sheet__nota">Nessun allenamento negli ultimi 7 giorni.</p>`}
      <button type="button" class="btn btn--ghost" data-chiudi-sheet style="margin-top:12px;">Chiudi</button>`);
    document.querySelectorAll("[data-recente]").forEach((b) => b.addEventListener("click", () => {
      const v = voci[Number(b.dataset.recente)];
      apriDettaglioAllenamento(v.a.id, v.g, v.a);
    }));
  }

  const ERRORI_FILE = {
    "formato-non-supportato": "Questo file non è un allenamento: scegli un file .fit, .tcx o .gpx.",
    "file-troppo-grande": "Il file è troppo grande (oltre 25 MB).",
    "lettore-fit": "Non riesco a leggere i file FIT in questo momento: controlla la connessione e riprova.",
  };

  /** Legge il file, mostra l'anteprima e salva il riepilogo nel giorno dell'allenamento. */
  async function apriImportaAllenamento(file) {
    apriSheet(`<h2 class="sheet__titolo">Allenamento dal file</h2><p class="sheet__nota">Sto leggendo il file…</p>`);
    let r;
    try {
      r = window.allenamentoFile.riepilogo(await window.allenamentoFile.leggiFile(file), PARAMETRI_ALLENAMENTO);
    } catch (e) {
      apriSheet(`<h2 class="sheet__titolo">Allenamento dal file</h2>
        <p class="sheet__nota">${escapeHTML(ERRORI_FILE[e && e.message] || "Non riesco a leggere questo file. Esporta l'allenamento dall'app o dal sito della piattaforma in formato FIT, TCX o GPX e riprova.")}</p>
        <button type="button" class="btn btn--ghost" data-chiudi-sheet>Chiudi</button>`);
      return;
    }
    const oggi = chiaveData(new Date());
    const limite = chiaveData(new Date(Date.now() - 7 * 86400000));
    if (!r.durata || r.durata < 3) {
      apriSheet(`<h2 class="sheet__titolo">Allenamento dal file</h2><p class="sheet__nota">Il file non contiene un allenamento con una durata valida.</p><button type="button" class="btn btn--ghost" data-chiudi-sheet>Chiudi</button>`);
      return;
    }
    if (r.giorno > oggi || r.giorno < limite) {
      apriSheet(`<h2 class="sheet__titolo">Allenamento dal file</h2><p class="sheet__nota">L'allenamento è del ${escapeHTML(dataLunga(r.giorno))}: puoi importare solo quelli degli ultimi 7 giorni.</p><button type="button" class="btn btn--ghost" data-chiudi-sheet>Chiudi</button>`);
      return;
    }
    const haParametri = PARAMETRI_ALLENAMENTO.fcMax || PARAMETRI_ALLENAMENTO.fcSoglia || PARAMETRI_ALLENAMENTO.ftp;
    let intensita = r.intensita || "moderata";
    // allenamenti già presenti quel giorno: lo stesso file importato prima, o uno dello stesso tipo segnato a mano
    let esistenti = [];
    try {
      esistenti = r.giorno === oggi ? (ATTIVITA_OGGI.allenamenti || [])
        : (((await window.cloud.leggiAttivitaPeriodo(UID, r.giorno))[r.giorno] || {}).allenamenti || []);
    } catch (e) { esistenti = []; }
    const giaImportato = esistenti.find((x) => x.fonte === "file" && x.ora === r.ora && Math.abs((x.durata || 0) - r.durata) <= 1);
    const aMano = giaImportato ? null : esistenti.find((x) => x.fonte !== "file" && x.tipo === r.tipo);
    apriSheet(`
      <h2 class="sheet__titolo">Allenamento dal file</h2>
      <p class="sheet__nota">${r.giorno === oggi ? "Oggi" : escapeHTML(dataLunga(r.giorno).replace(/^./, (c) => c.toUpperCase()))}, alle ${escapeHTML(r.ora)} · file ${escapeHTML(r.formato)}</p>
      <label class="editor-campo"><span>Attività</span>
        <select id="imp-tipo">${TIPI_ALLENAMENTO.map((t) => `<option${t === r.tipo ? " selected" : ""}>${t}</option>`).join("")}</select></label>
      <label class="check-riga"><input type="checkbox" id="imp-indoor"${r.indoor ? " checked" : ""}> <span>Al chiuso (rulli, tapis roulant, piscina)</span></label>
      ${righeAllenamentoHTML(r)}
      <p class="impost-etichetta">Intensità</p>
      <div class="segmento" id="imp-intensita">${INTENSITA.map(([id, nome]) => `<button type="button" class="segmento__voce" data-intensita="${id}" aria-pressed="${id === intensita}">${nome}</button>`).join("")}</div>
      <p class="stat-nota">${r.intensitaFonte ? `Proposta ${FONTI_INTENSITA[r.intensitaFonte]}${r.intensitaFonte === "potenza" ? ` (IF ${String(r.intensitaValore).replace(".", ",")})` : ""}: puoi cambiarla.` : haParametri ? "Il file non ha i dati per calcolarla: scegli tu." : "Scegli tu, oppure indica in Impostazioni → Allenamenti la tua frequenza cardiaca o la FTP per calcolarla dal file."}</p>
      ${giaImportato ? `<p class="avviso-doppione">Questo allenamento è già stato importato: salvando lo aggiorni con i dati e gli indici di adesso.</p>` : ""}
      ${aMano ? `<label class="check-riga avviso-doppione"><input type="checkbox" id="imp-sostituisci" checked> <span>Sostituisce quello segnato a mano: ${escapeHTML(descriviAllenamento(aMano))}</span></label>` : ""}
      <p class="sheet__nota">Il file non viene conservato: salviamo solo questi numeri, senza il percorso.</p>
      <button type="button" class="btn" id="btn-salva-importato" style="margin-top:12px;">${giaImportato ? "Aggiorna" : "Salva"}</button>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>`);
    document.querySelectorAll("#imp-intensita [data-intensita]").forEach((b) => b.addEventListener("click", () => {
      intensita = b.dataset.intensita;
      document.querySelectorAll("#imp-intensita [data-intensita]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    }));
    document.getElementById("btn-salva-importato").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const nuovo = Object.assign({}, r, {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        tipo: document.getElementById("imp-tipo").value,
        intensita,
      });
      if (document.getElementById("imp-indoor").checked) nuovo.indoor = true; else delete nuovo.indoor;
      if (intensita !== r.intensita) { delete nuovo.intensitaFonte; delete nuovo.intensitaValore; }
      delete nuovo.giorno;
      try {
        const attuali = r.giorno === oggi ? (ATTIVITA_OGGI.allenamenti || [])
          : (((await window.cloud.leggiAttivitaPeriodo(UID, r.giorno))[r.giorno] || {}).allenamenti || []);
        const sostituisci = document.getElementById("imp-sostituisci");
        const via = new Set([giaImportato && giaImportato.id, aMano && sostituisci && sostituisci.checked && aMano.id].filter(Boolean));
        const lista = attuali.filter((x) => !via.has(x.id)).concat(nuovo).slice(-6);
        await window.cloud.salvaAttivita(UID, r.giorno, { allenamenti: lista });
        chiudiSheet();
        const quando = r.giorno === oggi ? "" : ` nel ${dataLunga(r.giorno)}`;
        mostraToast(giaImportato ? `Allenamento aggiornato${quando}` : `Allenamento importato${quando}`);
      } catch (err) {
        btn.disabled = false;
        mostraToast(msgErroreScrittura(err, "Non salvato: controlla la connessione"), 4000);
      }
    });
  }

  function allenamentiOggiHTML() {
    if (RUOLO !== "paziente") return "";
    const lista = Array.isArray(ATTIVITA_OGGI.allenamenti) ? ATTIVITA_OGGI.allenamenti : [];
    return `
      <div class="allenamenti-oggi">
        ${lista.map((a) => `<span class="allenamento-chip">
            <button type="button" class="allenamento-chip__apri" data-dettaglio-allenamento="${escapeHTML(a.id)}" aria-label="Dettagli: ${escapeHTML(descriviAllenamento(a))}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 4a1.5 1.5 0 1 0 0-.01"/><path d="m7 21 3-6 3 2v5"/><path d="m5 12 3-3 4 1 3 3 3 1"/></svg>
            ${escapeHTML(descriviAllenamento(a))}${a.fonte === "file" ? ` <span class="allenamento-chip__file" aria-hidden="true">· dati</span>` : ""}</button>
            <button type="button" class="allenamento-chip__via" data-togli-allenamento="${escapeHTML(a.id)}" aria-label="Togli ${escapeHTML(a.tipo || "allenamento")}">✕</button>
          </span>`).join("")}
        <button type="button" class="allenamento-aggiungi" id="btn-aggiungi-allenamento">
          <span class="allenamento-aggiungi__icona" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span>
          ${lista.length ? "Altro allenamento" : "Oggi mi alleno"}
        </button>
      </div>`;
  }

  function collegaAllenamentiOggi() {
    const agg = document.getElementById("btn-aggiungi-allenamento");
    if (agg) agg.addEventListener("click", apriNuovoAllenamento);
    document.querySelectorAll("[data-dettaglio-allenamento]").forEach((b) => b.addEventListener("click", () => apriDettaglioAllenamento(b.dataset.dettaglioAllenamento)));
    document.querySelectorAll("[data-togli-allenamento]").forEach((b) => b.addEventListener("click", async () => {
      const lista = (ATTIVITA_OGGI.allenamenti || []).filter((a) => a.id !== b.dataset.togliAllenamento);
      try { await window.cloud.salvaAttivita(UID, chiaveData(new Date()), { allenamenti: lista }); }
      catch (e) { mostraToast(msgErroreScrittura(e, "Non salvato: controlla la connessione"), 4000); }
    }));
  }

  function apriNuovoAllenamento() {
    apriSheet(`
      <h2 class="sheet__titolo">Allenamento di oggi</h2>
      <p class="sheet__nota">Serve a te e al tuo nutrizionista per leggere il piano insieme all'attività. Non cambia le quantità del piano.</p>
      ${window.allenamentoFile ? `<label class="btn btn--ghost allenamento-file-btn">
        <input type="file" id="all-file" accept=".fit,.tcx,.gpx,.FIT,.TCX,.GPX" hidden>
        Importa da file (FIT, TCX o GPX)</label>
      <p class="stat-nota">Il file dell'allenamento esportato da Garmin, Wahoo, Bryton, Strava, TrainingPeaks… Oppure inseriscilo a mano:</p>` : ""}
      <label class="editor-campo"><span>Attività</span>
        <select id="all-tipo">${TIPI_ALLENAMENTO.map((t) => `<option>${t}</option>`).join("")}</select></label>
      <label class="check-riga"><input type="checkbox" id="all-indoor"> <span>Al chiuso (rulli, tapis roulant, piscina)</span></label>
      <div class="ric-griglia">
        <label class="editor-campo"><span>Durata (minuti)</span><input type="number" id="all-durata" inputmode="numeric" min="5" max="600" step="5" value="45"></label>
        <label class="editor-campo"><span>Orario (facoltativo)</span><input type="time" id="all-ora"></label>
      </div>
      <p class="impost-etichetta">Intensità</p>
      <div class="segmento" id="all-intensita">${INTENSITA.map(([id, nome]) => `<button type="button" class="segmento__voce" data-intensita="${id}" aria-pressed="${id === "moderata"}">${nome}</button>`).join("")}</div>
      <button type="button" class="btn" id="btn-salva-allenamento" style="margin-top:16px;">Salva</button>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
      <p class="registro-link"><button type="button" class="link-btn" id="btn-allenamenti-recenti">Allenamenti degli ultimi 7 giorni</button></p>`);
    document.getElementById("btn-allenamenti-recenti").addEventListener("click", apriAllenamentiRecenti);
    const inFile = document.getElementById("all-file");
    if (inFile) inFile.addEventListener("change", () => { if (inFile.files && inFile.files[0]) apriImportaAllenamento(inFile.files[0]); });
    let intensita = "moderata";
    document.querySelectorAll("#all-intensita [data-intensita]").forEach((b) => b.addEventListener("click", () => {
      intensita = b.dataset.intensita;
      document.querySelectorAll("#all-intensita [data-intensita]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    }));
    document.getElementById("btn-salva-allenamento").addEventListener("click", async () => {
      const durata = Math.round(Number(document.getElementById("all-durata").value));
      if (!durata || durata < 5 || durata > 600) { mostraToast("Indica una durata tra 5 e 600 minuti"); return; }
      const nuovo = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        tipo: document.getElementById("all-tipo").value,
        durata, intensita,
        ora: document.getElementById("all-ora").value || "",
        fonte: "manuale",
      };
      if (document.getElementById("all-indoor").checked) nuovo.indoor = true;
      const lista = (Array.isArray(ATTIVITA_OGGI.allenamenti) ? ATTIVITA_OGGI.allenamenti : []).concat(nuovo).slice(-6);
      try {
        await window.cloud.salvaAttivita(UID, chiaveData(new Date()), { allenamenti: lista });
        chiudiSheet();
        mostraToast("Allenamento salvato");
      } catch (e) { mostraToast(msgErroreScrittura(e, "Non salvato: controlla la connessione"), 4000); }
    });
  }

  /** Salva lo stato di un pasto di oggi: true (fatto), "diverso", "parziale", "saltato" oppure null (non segnato). */
  async function salvaStatoPasto(key, valore, motivo, nota) {
    const dateKey = chiaveData(new Date());
    const nuovoStato = Object.assign({}, PASTI_FATTI_OGGI);
    const motivi = Object.assign({}, nuovoStato.motivi || {});
    const note = Object.assign({}, nuovoStato.note || {});
    const conDettagli = valore === "diverso" || valore === "parziale" || valore === "saltato";
    if (valore === null) delete nuovoStato[key]; else nuovoStato[key] = valore;
    if (motivo && conDettagli) motivi[key] = motivo; else delete motivi[key];
    const testo = String(nota || "").trim().slice(0, window.statistiche.MAX_NOTA);
    if (testo && conDettagli) note[key] = testo; else delete note[key];
    if (Object.keys(motivi).length) nuovoStato.motivi = motivi; else delete nuovoStato.motivi;
    if (Object.keys(note).length) nuovoStato.note = note; else delete nuovoStato.note;
    try {
      await window.cloud.salvaPastiFattiCloud(UID, dateKey, nuovoStato);
      if (conDettagli) chiediRiscontro(key);
      else delete RISCONTRI.perPasto[key];
      // L'ascolto in tempo reale aggiorna la UI da solo.
    } catch (e) {
      mostraToast("Impossibile salvare: controlla la connessione");
    }
  }
  const DETTATURA_DISPONIBILE = typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  // ---------------------------------------------------------------------
  // Riscontro AI sui pasti non come da piano
  // ---------------------------------------------------------------------
  const RISCONTRI = { data: null, perPasto: {}, unsub: null };
  // Dettatura vocale della nota: riconoscimento del sistema del telefono (Google o Apple)
  const LS_RISCONTRI_CHIUSI = "pnut:riscontri-chiusi";
  const ETICHETTE_IMPATTO = { irrilevante: "Variazione irrilevante", nessuno: "Variazione irrilevante", lieve: "Impatto lieve", moderato: "Impatto moderato", rilevante: "Impatto rilevante" };

  function riscontroAttivo() {
    const m = PIANO_ATTIVO && PIANO_ATTIVO.feedbackAI && PIANO_ATTIVO.feedbackAI.modo;
    return m !== "spento";
  }

  function collegaRiscontriOggi(dateKey) {
    if (RISCONTRI.data === dateKey && RISCONTRI.unsub) return;
    if (RISCONTRI.unsub) RISCONTRI.unsub();
    RISCONTRI.data = dateKey; RISCONTRI.perPasto = {};
    if (!window.cloud.ascoltaRiscontriOggi) return;
    RISCONTRI.unsub = window.cloud.ascoltaRiscontriOggi(UID, dateKey, (lista) => {
      lista.forEach((r) => { if (!RISCONTRI.perPasto[r.pasto] || !RISCONTRI.perPasto[r.pasto].attesa) RISCONTRI.perPasto[r.pasto] = r; });
      if (currentView === "oggi") renderOggi();
    });
  }

  function riscontriChiusi() {
    try { return JSON.parse(localStorage.getItem(LS_RISCONTRI_CHIUSI) || "{}"); } catch (e) { return {}; }
  }

  async function chiediRiscontro(key) {
    if (!riscontroAttivo() || !CONSENSO_AI || !window.cloud.valutaVariazione) return;
    if (premiumLimitato()) {
      RISCONTRI.perPasto[key] = { bloccato: true };
      if (currentView === "oggi") renderOggi();
      return;
    }
    RISCONTRI.perPasto[key] = { attesa: true };
    const chiusi = riscontriChiusi(); delete chiusi[`${chiaveData(new Date())}_${key}`];
    localStorage.setItem(LS_RISCONTRI_CHIUSI, JSON.stringify(chiusi));
    if (currentView === "oggi") renderOggi();
    try {
      const r = await window.cloud.valutaVariazione(key);
      if (r && r.spento) delete RISCONTRI.perPasto[key];
      else RISCONTRI.perPasto[key] = r;
    } catch (err) {
      if (/premium-richiesto/.test(String(err && err.message))) { RISCONTRI.perPasto[key] = { bloccato: true }; aggiornaPremium(); }
      else RISCONTRI.perPasto[key] = { errore: /limite/.test(String(err && err.message)) ? "Per oggi i riscontri sono finiti: riparti dal piano al prossimo pasto." : "Riscontro non disponibile in questo momento." };
    }
    if (currentView === "oggi") renderOggi();
  }

  function riscontroPastoHTML(key, stato) {
    if (!stato || stato === "fatto" || !riscontroAttivo()) return "";
    const r = RISCONTRI.perPasto[key];
    if (!r) return "";
    const idChiuso = `${RISCONTRI.data}_${key}`;
    if (riscontriChiusi()[idChiuso]) return "";
    if (r.bloccato) return `<div class="riscontro riscontro--bloccato">
        <div class="riscontro__testa"><strong>💡 C'è un consiglio per riequilibrare la giornata</strong>
          <button type="button" class="riscontro__chiudi" data-chiudi-riscontro="${escapeHTML(idChiuso)}" aria-label="Chiudi">✕</button></div>
        <p class="riscontro__testo">Con Premium vedi l'impatto di questo pasto e come sistemare i prossimi.</p>
        <button type="button" class="btn btn--ghost" data-premium>Scopri Premium</button>
      </div>`;
    if (r.attesa) return `<div class="riscontro riscontro--attesa"><span class="import-attesa"></span> Sto valutando come riequilibrare la giornata…</div>`;
    if (r.errore) return `<div class="riscontro"><p class="riscontro__testo">${escapeHTML(r.errore)}</p></div>`;
    if (r.stato && r.stato !== stato) return ""; // il pasto è stato cambiato dopo il riscontro
    if (r.impatto === "irrilevante" || r.impatto === "nessuno") {
      return `
      <div class="riscontro riscontro--irrilevante">
        <div class="riscontro__testa">
          <strong>✅ ${escapeHTML(ETICHETTE_IMPATTO.irrilevante)}</strong>
          <button type="button" class="riscontro__chiudi" data-chiudi-riscontro="${escapeHTML(idChiuso)}" aria-label="Chiudi">✕</button>
        </div>
        ${r.stima ? `<p class="riscontro__testo">${escapeHTML(r.stima)}</p>` : ""}
        <p class="riscontro__messaggio">${escapeHTML(r.messaggio || "Va benissimo così: continua con il piano.")}</p>
        ${AVVERTENZA_AI_PASTI}
      </div>`;
    }
    return `
      <div class="riscontro riscontro--${escapeHTML(r.impatto || "lieve")}">
        <div class="riscontro__testa">
          <strong>💡 Come riequilibrare la giornata</strong>
          <button type="button" class="riscontro__chiudi" data-chiudi-riscontro="${escapeHTML(idChiuso)}" aria-label="Chiudi">✕</button>
        </div>
        <p class="riscontro__impatto"><span>${escapeHTML(ETICHETTE_IMPATTO[r.impatto] || "Impatto lieve")}</span>${r.stima ? ` · ${escapeHTML(r.stima)}` : ""}</p>
        ${r.spiegazione ? `<p class="riscontro__testo">${escapeHTML(r.spiegazione)}</p>` : ""}
        ${(r.suggerimenti || []).length ? `<ul class="riscontro__suggerimenti">${r.suggerimenti.map((x) => `<li><strong>${escapeHTML(MEAL_META[x.pasto] ? MEAL_META[x.pasto].label : x.pasto)}:</strong> ${escapeHTML(x.testo)}</li>`).join("")}</ul>` : ""}
        <p class="riscontro__messaggio">${escapeHTML(r.messaggio || "")}</p>
        ${r.frequente ? `<p class="riscontro__frequente">Negli ultimi giorni i pasti non come da piano sono stati diversi: può essere utile parlarne con il tuo nutrizionista.</p>` : ""}
        ${AVVERTENZA_AI_PASTI}
      </div>`;
  }


  // Avvertenza sotto ogni riscontro AI: ben visibile, come indicato dalla
  // consulenza legale. Testo provvisorio, da far validare.
  const AVVERTENZA_AI_PASTI = `<p class="riscontro__avvertenza"><strong>✨ Generato con intelligenza artificiale</strong> sulla base del tuo piano e di quello che hai segnato. È un'indicazione di massima e approssimata: non è una prescrizione né un parere professionale. Per ogni verifica rivolgiti al tuo nutrizionista o a un professionista abilitato.</p>`;

  function onToggleMealCheck(key) {
    const giaFatto = window.statistiche.statoPasto(PASTI_FATTI_OGGI, key) === "fatto";
    salvaStatoPasto(key, giaFatto ? null : true, null, null);
  }

  /** Scheda per dire com'è andato un pasto: fatto, in parte o saltato, con un motivo facoltativo. */
  function apriStatoPasto(key) {
    const S = window.statistiche;
    const attuale = S.statoPasto(PASTI_FATTI_OGGI, key);
    const motivoAttuale = (PASTI_FATTI_OGGI.motivi || {})[key] || null;
    let scelta = attuale || null;
    let motivo = motivoAttuale;
    let nota = (PASTI_FATTI_OGGI.note || {})[key] || "";
    const nomePasto = MEAL_META[key].label;
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">${escapeHTML(nomePasto)} di oggi</h2>
      <p class="sheet__nota">Rispondi con sincerità: aiuta il tuo nutrizionista a capire cosa funziona e cosa adattare nel piano.</p>
      <div class="stato-pasto" role="radiogroup" aria-label="Com'è andato il pasto">
        <button type="button" class="stato-pasto__opzione" data-scelta="fatto" role="radio">✓ <span>Fatto come da piano</span></button>
        <button type="button" class="stato-pasto__opzione" data-scelta="diverso" role="radio">↺ <span>Fatto diversamente dal piano</span></button>
        <button type="button" class="stato-pasto__opzione" data-scelta="parziale" role="radio"><svg class="icona-meta" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></svg> <span>Fatto in parte</span></button>
        <button type="button" class="stato-pasto__opzione" data-scelta="saltato" role="radio">✕ <span>Saltato</span></button>
      </div>
      <div id="stato-pasto-motivi" class="stato-pasto__motivi"></div>
      <button type="button" class="btn" id="stato-pasto-salva">Salva</button>
      ${attuale ? `<button type="button" class="btn btn--ghost" id="stato-pasto-togli">Togli la segnatura</button>` : ""}
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
    `);
    let dettatura = null;
    const fermaDettatura = () => { if (dettatura) { try { dettatura.stop(); } catch (e) { /* già ferma */ } dettatura = null; } };
    const aggiorna = () => {
      fermaDettatura();
      overlay.querySelectorAll("[data-scelta]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.scelta === scelta)));
      const box = overlay.querySelector("#stato-pasto-motivi");
      const elenco = scelta === "diverso" ? S.MOTIVI_DIVERSO : scelta === "parziale" ? S.MOTIVI_PARZIALE : scelta === "saltato" ? S.MOTIVI_SALTATO : [];
      if (!elenco.includes(motivo)) motivo = null;
      const campoNota = box.querySelector("#stato-pasto-nota");
      if (campoNota) nota = campoNota.value;
      box.innerHTML = elenco.length ? `
        <p class="stato-pasto__domanda">Com'è andata? <span>(facoltativo)</span></p>
        <div class="ricette-filtri">${elenco.map((m) => `<button type="button" class="chip-filtro" data-motivo="${m}" aria-pressed="${motivo === m}">${escapeHTML(S.MOTIVI[m])}</button>`).join("")}</div>
        <label class="editor-campo stato-pasto__nota">Vuoi aggiungere un dettaglio? <span>(facoltativo)</span>
          <textarea id="stato-pasto-nota" rows="2" maxlength="${S.MAX_NOTA}" placeholder="${escapeHTML(S.SUGGERIMENTI_NOTA[motivo] || (scelta === "diverso" ? "Cosa hai mangiato al posto del pasto previsto?" : "Es. riso al posto della pasta, ho lasciato metà del secondo…"))}">${escapeHTML(nota)}</textarea>
          <span class="stato-pasto__sotto">${DETTATURA_DISPONIBILE ? `<button type="button" class="btn-detta" id="stato-pasto-detta" aria-label="Detta la nota a voce">🎤 Detta</button>` : ""}<small id="stato-pasto-conta">${nota.length}/${S.MAX_NOTA}</small></span>
          <small class="stato-pasto__avviso">Scrivi solo cosa hai mangiato e perché: niente nomi, telefoni o indirizzi.${CONSENSO_AI ? " La nota può essere letta dall'intelligenza artificiale per il riscontro." : ""}</small>
        </label>` : "";
      box.querySelectorAll("[data-motivo]").forEach((b) => b.addEventListener("click", () => {
        motivo = motivo === b.dataset.motivo ? null : b.dataset.motivo;
        aggiorna();
      }));
      const nuovoCampo = box.querySelector("#stato-pasto-nota");
      if (nuovoCampo) nuovoCampo.addEventListener("input", () => {
        nota = nuovoCampo.value;
        box.querySelector("#stato-pasto-conta").textContent = `${nota.length}/${S.MAX_NOTA}`;
      });
      const bDetta = box.querySelector("#stato-pasto-detta");
      if (bDetta && nuovoCampo) bDetta.addEventListener("click", () => {
        if (dettatura) { fermaDettatura(); return; }
        const base = nuovoCampo.value.trim();
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        const rec = new SR();
        rec.lang = "it-IT"; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
        dettatura = rec;
        bDetta.classList.add("is-ascolto"); bDetta.textContent = "⏹ Ti ascolto… tocca per fermare";
        rec.onresult = (ev) => {
          let detto = "";
          for (let i = 0; i < ev.results.length; i++) detto += ev.results[i][0].transcript;
          detto = detto.trim();
          if (detto) detto = detto.charAt(0).toUpperCase() + detto.slice(1);
          nuovoCampo.value = ((base ? base + " " : "") + detto).slice(0, S.MAX_NOTA);
          nota = nuovoCampo.value;
          box.querySelector("#stato-pasto-conta").textContent = `${nota.length}/${S.MAX_NOTA}`;
        };
        rec.onerror = (ev) => {
          const e = ev && ev.error;
          mostraToast(e === "not-allowed" || e === "service-not-allowed" ? "Consenti l'uso del microfono, oppure usa il microfono della tastiera"
            : e === "no-speech" ? "Non ho sentito nulla: riprova"
            : e === "network" ? "La dettatura richiede la connessione a internet"
            : "Dettatura non disponibile: puoi usare il microfono della tastiera", 4500);
        };
        rec.onend = () => { dettatura = null; bDetta.classList.remove("is-ascolto"); bDetta.textContent = "🎤 Detta"; };
        try { rec.start(); } catch (e) { dettatura = null; bDetta.classList.remove("is-ascolto"); bDetta.textContent = "🎤 Detta"; }
      });
      overlay.querySelector("#stato-pasto-salva").disabled = !scelta;
    };
    overlay.querySelectorAll("[data-scelta]").forEach((b) => b.addEventListener("click", () => { scelta = b.dataset.scelta; aggiorna(); }));
    overlay.querySelector("#stato-pasto-salva").addEventListener("click", () => {
      fermaDettatura();
      chiudiSheet();
      const campo = overlay.querySelector("#stato-pasto-nota");
      salvaStatoPasto(key, scelta === "fatto" ? true : scelta, motivo, campo ? campo.value : "");
    });
    const togli = overlay.querySelector("#stato-pasto-togli");
    if (togli) togli.addEventListener("click", () => { chiudiSheet(); salvaStatoPasto(key, null, null, null); });
    aggiorna();
  }

  function renderCoccolaHTML(giorno) {
    if (!giorno.coccola) return "";
    return `
      <div class="coccola">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 21s-7.5-4.6-10-9.2C.5 8 2.2 4 6 4c2.1 0 3.6 1.2 6 3.6C14.4 5.2 15.9 4 18 4c3.8 0 5.5 4 4 7.8-2.5 4.6-10 9.2-10 9.2z"/></svg>
        <span>${escapeHTML(giorno.coccola)}</span>
      </div>
    `;
  }

  function renderNormeHTML() {
    const norme = (PIANO_ATTIVO && PIANO_ATTIVO.normeGenerali) || [];
    if (!norme.length) return "";
    return `
      <details class="norme">
        <summary>Regole generali del piano</summary>
        <ul>${norme.map((n) => `<li>${escapeHTML(n)}</li>`).join("")}</ul>
      </details>
    `;
  }

  // ---------------------------------------------------------------------
  // Vista "Settimana"
  // ---------------------------------------------------------------------
  function renderSettimana() {
    if (pianoAutonomoVuoto() || pianoInCompilazione()) { mostraBenvenutoAutonomo(); return; }
    if (!PIANO_ATTIVO) {
      root.innerHTML = `<div class="empty">Il tuo professionista non ha ancora assegnato un piano a questo account.</div>`;
      return;
    }

    const oggi = new Date();
    const { settimana: settimanaCorrente, giornoIndex: oggiIndex } = window.weekLogic.calcolaSettimanaGiorno(oggi, CONFIG, PIANO_ATTIVO);
    const settimanaMostrata = settimanaAnteprima || settimanaCorrente;
    const giorni = PIANO_ATTIVO.settimane[settimanaMostrata];
    const orari = orariEffettivi();

    if (!giorni) {
      root.innerHTML = `<div class="empty">La settimana ${settimanaMostrata} non è presente nel piano caricato.</div>`;
      return;
    }

    if (typeof renderSettimana.giornoSelezionato !== "number") {
      renderSettimana.giornoSelezionato = settimanaAnteprima ? 0 : oggiIndex;
    }
    const sel = renderSettimana.giornoSelezionato;
    const giorno = giorni[sel];

    const opzioniSettimana = [1, 2, 3, 4, 5]
      .filter((n) => Array.isArray(PIANO_ATTIVO.settimane[n]))
      .map((n) => `<option value="${n}" ${n === settimanaMostrata ? "selected" : ""}>Settimana ${n}${n === settimanaCorrente ? " (attuale)" : ""}</option>`)
      .join("");

    root.innerHTML = `
      <section class="hero" style="border-bottom:none; margin-bottom:8px; padding-bottom:6px;">
        <div class="hero__eyebrow"><span class="dot"></span> Sfoglia il piano</div>
        <div class="hero__meta" style="margin-top:10px;">
          <select id="sel-settimana" aria-label="Settimana">${opzioniSettimana}</select>
        </div>
      </section>
      <div class="day-pills" id="day-pills">
        ${giorni.map((g, i) => `<button class="day-pill ${i === sel ? "is-active" : ""}" data-i="${i}">${g.giorno.slice(0, 3)}</button>`).join("")}
      </div>
      ${giorno.kcal != null ? `<div class="hero__meta" style="margin:-8px 0 16px;"><span class="pill pill--kcal">${giorno.kcal} kcal circa</span></div>` : ""}
      <div class="timeline">${renderTimelineHTML(giorno, orari)}</div>
      ${renderCoccolaHTML(giorno)}
    `;

    document.getElementById("sel-settimana").addEventListener("change", (e) => {
      const v = Number(e.target.value);
      settimanaAnteprima = v === settimanaCorrente ? null : v;
      renderSettimana.giornoSelezionato = 0;
      renderSettimana();
    });
    document.querySelectorAll(".day-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        renderSettimana.giornoSelezionato = Number(btn.dataset.i);
        renderSettimana();
      });
    });

    const pillAttiva = document.querySelector(".day-pill.is-active");
    if (pillAttiva && typeof pillAttiva.scrollIntoView === "function") pillAttiva.scrollIntoView({ inline: "center", block: "nearest" });
  }

  // ---------------------------------------------------------------------
  // Vista "Spesa" — lista della spesa intelligente generata dal piano
  // ---------------------------------------------------------------------
  // Il riconoscimento degli alimenti (merge di singolari/plurali, varianti,
  // quantità, categorie e icone) vive in js/alimenti.js. Qui c'è solo
  // l'interfaccia: vista a lista o a blocchi, spunte sincronizzate su
  // Firestore (una lista per settimana di calendario) e correzioni del
  // paziente (nome, categoria, articoli nascosti).
  const LS_VISTA_SPESA = "pnut:spesa-vista"; // "lista" | "blocchi"
  const CAMPI_SPESA = MEAL_KEYS.concat(["coccola"]);
  const MESI_BREVI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
  const SPESA = {
    offset: 0,            // 0 = questa settimana, 1 = prossima, …
    docId: null,          // data del lunedì, es. "2026-09-28"
    unsub: null,
    unsubPref: null,
    dati: { spuntate: [], extra: [], prep: [], scelte: {} },
    pref: { categoria: {}, nome: {}, nascosti: [] },
    contesto: null,       // { giorni, etichetta } della settimana mostrata
    voci: [],             // ultime voci disegnate (servono a opzioni e copia)
  };

  function vistaSpesa() {
    return localStorage.getItem(LS_VISTA_SPESA) === "blocchi" ? "blocchi" : "lista";
  }

  function scollegaSpesa() {
    if (SPESA.unsub) { SPESA.unsub(); SPESA.unsub = null; }
    if (SPESA.unsubPref) { SPESA.unsubPref(); SPESA.unsubPref = null; }
    SPESA.docId = null;
    SPESA.offset = 0;
    SPESA.dati = { spuntate: [], extra: [], prep: [], scelte: {} };
    SPESA.pref = { categoria: {}, nome: {}, nascosti: [] };
  }

  /** Le prossime 4 settimane di calendario, ciascuna con la sua settimana del piano. */
  function settimaneSpesa() {
    const lunedi = window.weekLogic.lunediDellaSettimana(new Date());
    return [0, 1, 2, 3].map((k) => {
      const inizio = new Date(lunedi);
      inizio.setDate(inizio.getDate() + 7 * k);
      const fine = new Date(inizio);
      fine.setDate(fine.getDate() + 6);
      const settimana = PIANO_ATTIVO ? window.weekLogic.calcolaSettimanaGiorno(inizio, CONFIG, PIANO_ATTIVO).settimana : null;
      const intervallo = inizio.getMonth() === fine.getMonth()
        ? `${inizio.getDate()}–${fine.getDate()} ${MESI_BREVI[fine.getMonth()]}`
        : `${inizio.getDate()} ${MESI_BREVI[inizio.getMonth()]} – ${fine.getDate()} ${MESI_BREVI[fine.getMonth()]}`;
      const quando = ["Questa settimana", "Prossima settimana", "Tra 2 settimane", "Tra 3 settimane"][k];
      return { k, settimana, docId: chiaveData(inizio), intervallo, etichetta: `${quando}, ${intervallo}${settimana ? ` (settimana ${settimana})` : ""}` };
    });
  }

  function collegaAscoltoSpesa(docId) {
    if (!SPESA.unsubPref) {
      SPESA.unsubPref = window.cloud.ascoltaSpesa(UID, "preferenze", (d) => {
        SPESA.pref = { categoria: d.categoria || {}, nome: d.nome || {}, nascosti: d.nascosti || [] };
        ridisegnaSpesaSeVisibile();
      });
    }
    const destinazione = destinazioneSpesa();
    if (SPESA.docId === docId && SPESA.destinazione === destinazione && SPESA.unsub) return;
    if (SPESA.unsub) SPESA.unsub();
    SPESA.docId = docId;
    SPESA.destinazione = destinazione;
    SPESA.dati = { spuntate: [], extra: [], prep: [], scelte: {} };
    SPESA.unsub = window.cloud.ascoltaSpesa(destinazione, docId, (d) => {
      if (SPESA.docId !== docId || SPESA.destinazione !== destinazione) return;
      SPESA.dati = { spuntate: d.spuntate || [], extra: d.extra || [], prep: d.prep || [], scelte: d.scelte || {}, piani: d.piani || {} };
      ridisegnaSpesaSeVisibile();
    });
  }

  function ridisegnaSpesaSeVisibile() {
    if (currentView !== "spesa") return;
    if (document.getElementById("spesa-contenuto")) disegnaContenutoSpesa();
    else if (document.getElementById("prep-contenuto")) disegnaMealPrep();
  }

  /** Voci da mostrare: piano + articoli aggiunti a mano, con le correzioni del paziente applicate. */
  const LS_TEMPI_SPESA = "pnut:spesa-tempi"; // "1" | "2"
  const TEMPI_SPESA = [
    { id: "t1", titolo: "Spesa 1", per: "per lunedì, martedì e mercoledì", giorni: [0, 1, 2] },
    { id: "t2", titolo: "Spesa 2", per: "per giovedì, venerdì, sabato e domenica", giorni: [3, 4, 5, 6] },
  ];
  function tempiSpesa() { return !spesaLimitata() && localStorage.getItem(LS_TEMPI_SPESA) === "2" ? 2 : 1; }
  /** Versione gratuita del paziente: lista solo per oggi, senza meal prep né condivisione. */
  function spesaLimitata() { return premiumLimitato() && !LISTA.dati; }

  /**
   * Voci della settimana: piano (con quantità e giorni) + scelte fatte tra le
   * alternative + articoli aggiunti a mano, con le correzioni del paziente.
   * Le alternative non ancora scelte restano voci "a scelta".
   */
  function calcolaVociSpesa() {
    const A = window.alimenti;
    const mappa = new Map();
    const scelte = SPESA.dati.scelte || {};
    // Fonti: il proprio piano + gli alimenti pubblicati dagli altri membri della lista di casa
    const fonti = [];
    const vecchie = [];
    SPESA.versioniVecchie = vecchie;
    if (PIANO_ATTIVO) fonti.push({ uid: UID, voci: A.listaDaSettimana(SPESA.contesto.giorni, CAMPI_SPESA) });
    if (LISTA.id) {
      Object.entries(SPESA.dati.piani || {}).forEach(([uid, p]) => {
        if (uid !== UID && LISTA.dati && (LISTA.dati.membri || []).includes(uid) && Array.isArray(p.voci)) {
          fonti.push({ uid, voci: p.voci });
          if ((p.versione || 0) < A.VERSIONE_MOTORE) vecchie.push(nomeMembro(uid));
        }
      });
    }
    const piuFonti = fonti.length > 1;
    const aggiungi = (v, uid) => {
      const con = Object.assign({}, v, { daPiano: true, testiExtra: [], perMembro: { [uid]: v.tot || {} } });
      if (!mappa.has(v.chiave)) { mappa.set(v.chiave, con); return; }
      const prima = mappa.get(v.chiave);
      const unita = A.unisciVoci(prima, con);
      unita.perMembro = Object.assign({}, prima.perMembro, { [uid]: A.unisciVoci({ tot: (prima.perMembro || {})[uid] || {}, giorni: {} }, { tot: v.tot || {}, giorni: {} }).tot });
      unita.sceltaDa = prima.sceltaDa || v.sceltaDa;
      unita.numAlternative = prima.numAlternative || v.numAlternative;
      mappa.set(v.chiave, unita);
    };
    fonti.forEach(({ uid, voci }) => {
      voci.forEach((v) => {
        if (!v.alternativa) { aggiungi(v, uid); return; }
        // alternative: ognuno sceglie tra le proprie
        const chiave = LISTA.id ? `${uid}|${v.chiave}` : v.chiave;
        const opz = scelte[chiave] && v.opzioni.find((o) => o.chiave === scelte[chiave]);
        if (opz && opz.piatto) {
          (opz.voci || []).forEach((iv) => aggiungi(Object.assign({}, iv, { sceltaDa: chiave, numAlternative: v.opzioni.length, piattoScelto: opz.nome }), uid));
          return;
        }
        if (opz) { aggiungi(Object.assign({}, opz, { sceltaDa: chiave, numAlternative: v.opzioni.length }), uid); return; }
        mappa.set(chiave, Object.assign({}, v, {
          chiave, daPiano: true, testiExtra: [],
          nome: piuFonti ? `${v.nome} (${nomeMembro(uid)})` : v.nome,
        }));
      });
    });
    SPESA.dati.extra.forEach((testo) => {
      A.classificaArticolo(testo).forEach((v) => {
        if (!mappa.has(v.chiave)) mappa.set(v.chiave, Object.assign({}, v, { daPiano: false, testiExtra: [], extra: true }));
        mappa.get(v.chiave).testiExtra.push(testo);
      });
    });
    const nascosti = new Set(SPESA.pref.nascosti);
    return Array.from(mappa.values()).map((v) => Object.assign(v, {
      nomeOriginale: v.nome,
      catOriginale: v.cat,
      nome: SPESA.pref.nome[v.chiave] || v.nome,
      cat: v.alternativa ? "scelta" : (SPESA.pref.categoria[v.chiave] || v.cat),
      nascosto: nascosti.has(v.chiave) && v.daPiano,
    }));
  }

  /** Voci con lo stato della spunta (chiave con prefisso per la spesa in due tempi). */
  function conSpunta(voci, prefisso) {
    const spuntate = new Set(SPESA.dati.spuntate);
    return voci.map((v) => Object.assign({}, v, { chiaveSpunta: prefisso + v.chiave, spuntata: spuntate.has(prefisso + v.chiave) }));
  }

  // ---------------------------------------------------------------------
  // Meal prep (dentro la scheda Spesa, sulla stessa settimana)
  // ---------------------------------------------------------------------
  // Il calcolo sta in js/mealprep.js; qui c'è la vista con le due sessioni,
  // la checklist (salvata nello stesso documento della lista della spesa di
  // quella settimana) e la guida alla conservazione.
  const LS_MODO_SPESA = "pnut:spesa-modo"; // "lista" | "prep"

  function mealPrepAttivo() {
    if (RUOLO === "familiare" || !PIANO_ATTIVO) return false;
    return !(PIANO_ATTIVO && PIANO_ATTIVO.mealPrep && PIANO_ATTIVO.mealPrep.attivo === false);
  }

  function modoSpesa() {
    return !spesaLimitata() && mealPrepAttivo() && localStorage.getItem(LS_MODO_SPESA) === "prep" ? "prep" : "lista";
  }

  function interruttoreModoHTML(modo) {
    if (!mealPrepAttivo()) return "";
    if (spesaLimitata()) {
      // versione gratuita: il meal prep si vede ma apre il pannello Premium
      return `
      <div class="spesa-modo" role="tablist" aria-label="Sezione">
        <button type="button" role="tab" aria-selected="true">🛒 Lista della spesa</button>
        <button type="button" role="tab" aria-selected="false" data-premium>🔒 Meal prep</button>
      </div>`;
    }
    return `
      <div class="spesa-modo" role="tablist" aria-label="Sezione">
        <button type="button" role="tab" data-modo="lista" aria-selected="${modo === "lista"}">🛒 Lista della spesa</button>
        <button type="button" role="tab" data-modo="prep" aria-selected="${modo === "prep"}">🥡 Meal prep</button>
      </div>`;
  }

  function collegaInterruttoreModo() {
    root.querySelectorAll("[data-modo]").forEach((b) => b.addEventListener("click", () => {
      localStorage.setItem(LS_MODO_SPESA, b.dataset.modo);
      renderSpesa();
    }));
  }

  function renderMealPrep(settimane, sel) {
    root.innerHTML = `
      ${interruttoreModoHTML("prep")}
      <section class="hero" style="border-bottom:none; margin-bottom:8px; padding-bottom:6px;">
        <div class="hero__eyebrow"><span class="dot"></span> Meal prep</div>
        <div class="spesa-testata">
          <select id="sel-settimana-spesa" aria-label="Settimana">
            ${settimane.map((s) => `<option value="${s.k}" ${s.k === sel.k ? "selected" : ""}>${escapeHTML(s.etichetta)}</option>`).join("")}
          </select>
        </div>
      </section>
      <p class="hint" style="margin:0 0 12px;">Prepara in anticipo quello che si presta: con due sessioni, una la domenica e una il mercoledì sera, hai i pasti pronti per tutta la settimana. Quantità e giorni vengono dal tuo piano.</p>
      <div id="prep-contenuto"></div>
    `;
    collegaInterruttoreModo();
    document.getElementById("sel-settimana-spesa").addEventListener("change", (e) => {
      SPESA.offset = Number(e.target.value) || 0;
      renderSpesa();
    });
    const contenuto = document.getElementById("prep-contenuto");
    contenuto.addEventListener("change", (e) => {
      const chk = e.target.closest("[data-prep]");
      if (chk) spuntaVocePrep(prefissoPrep() + chk.dataset.prep, chk.checked);
    });
    disegnaMealPrep();
  }

  function disegnaMealPrep() {
    const box = document.getElementById("prep-contenuto");
    if (!box || !SPESA.contesto) return;
    const M = window.mealPrep;
    const proprie = {};
    Object.entries(SPESA.dati.scelte || {}).forEach(([k, v]) => {
      if (!LISTA.id) proprie[k] = v;
      else if (k.startsWith(UID + "|")) proprie[k.slice(UID.length + 1)] = v;
    });
    const r = M.calcola(SPESA.contesto.giorni, proprie);
    const fatti = new Set((SPESA.dati.prep || []).filter((k) => !LISTA.id || k.startsWith(UID + ":")).map((k) => (LISTA.id ? k.slice(UID.length + 1) : k)));
    const tutte = r.sessioni.flatMap((s) => s.gruppi.flatMap((g) => g.voci));
    const completate = tutte.filter((v) => fatti.has(v.chiave)).length;
    const nota = PIANO_ATTIVO && PIANO_ATTIVO.mealPrep && PIANO_ATTIVO.mealPrep.note;

    // Date delle due sessioni: la domenica prima e il mercoledì della settimana scelta
    const lunedi = window.statistiche.daChiave(SPESA.docId);
    const dataSessione = (delta) => {
      const d = new Date(lunedi); d.setDate(d.getDate() + delta);
      return d.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
    };
    const titoli = {
      s1: { quando: dataSessione(-1), per: "per lunedì, martedì e mercoledì", extra: " (più uova sode e porzioni per tutta la settimana)" },
      s2: { quando: dataSessione(2) + ", la sera", per: "per giovedì, venerdì, sabato e domenica", extra: "" },
    };

    box.innerHTML = `
      ${nota ? `<div class="prep-nota"><strong>Dal tuo nutrizionista</strong><p>${escapeHTML(nota)}</p></div>` : ""}
      ${r.vuoto ? `<div class="empty">In questa settimana del piano non ci sono alimenti da preparare in anticipo.</div>` : `
        <p class="spesa-riepilogo">${completate === tutte.length ? "Tutto pronto per la settimana. Ottimo lavoro!" : `${completate} di ${tutte.length} preparazioni fatte`}</p>
        ${r.sessioni.filter((s) => s.totale).map((s) => `
          <section class="prep-sessione">
            <h3 class="prep-sessione__titolo">${s.id === "s1" ? "Sessione 1" : "Sessione 2"} · ${escapeHTML(titoli[s.id].quando.charAt(0).toUpperCase() + titoli[s.id].quando.slice(1))}</h3>
            <p class="prep-sessione__per">${titoli[s.id].per}${titoli[s.id].extra}</p>
            ${s.gruppi.map((g) => `
              <div class="prep-gruppo">
                <p class="prep-gruppo__titolo"><span aria-hidden="true">${g.icona}</span> ${escapeHTML(g.titolo)} <span class="prep-gruppo__conserva">${escapeHTML(g.conservazione)}</span></p>
                <p class="prep-gruppo__consiglio">${escapeHTML(g.consiglio)}</p>
                ${g.avvisoRiso ? `<p class="prep-gruppo__avviso">⚠️ ${escapeHTML(g.avvisoRiso)}</p>` : ""}
                <ul class="spesa-lista">
                  ${g.voci.map((v) => `
                    <li class="spesa-riga ${fatti.has(v.chiave) ? "is-spuntata" : ""}">
                      <label>
                        <input type="checkbox" data-prep="${escapeHTML(v.chiave)}" ${fatti.has(v.chiave) ? "checked" : ""}>
                        <span class="spesa-riga__icona" aria-hidden="true">${v.icona}</span>
                        <span class="prep-voce">
                          <span class="spesa-riga__nome">${escapeHTML(v.nome)}${v.alternative.length ? ` <em>(oppure ${escapeHTML(v.alternative.join(", ").toLowerCase())})</em>` : ""}</span>
                          <span class="prep-voce__quantita">${escapeHTML(M.testoQuantita(v))}</span>
                        </span>
                      </label>
                    </li>`).join("")}
                </ul>
              </div>`).join("")}
          </section>`).join("")}
        <p class="stat-nota" style="margin:10px 2px 0;">Le quantità sono quelle scritte nel piano, sommate per tutti i giorni della sessione: se il piano indica il peso a crudo, cuoci quella quantità.</p>
      `}
      <details class="ric-dettagli prep-guida">
        <summary>Conservare in sicurezza</summary>
        ${M.GUIDA.map(([t, d]) => `<p class="prep-guida__voce"><strong>${escapeHTML(t)}</strong>${escapeHTML(d)}</p>`).join("")}
        <p class="stat-nota" style="margin:8px 0 12px;">${escapeHTML(M.FONTI)}</p>
      </details>
    `;
  }

  function prefissoPrep() { return LISTA.id ? UID + ":" : ""; }

  async function spuntaVocePrep(chiave, fatto) {
    const set = new Set(SPESA.dati.prep || []);
    if (fatto) set.add(chiave); else set.delete(chiave);
    SPESA.dati.prep = Array.from(set);
    disegnaMealPrep();
    try { await window.cloud.spuntaPrep(destinazioneSpesa(), SPESA.docId, chiave, fatto); }
    catch (e) { mostraToast("Spunta non salvata: controlla la connessione"); }
  }

  function renderSpesa() {
    if (pianoAutonomoVuoto() || pianoInCompilazione()) { mostraBenvenutoAutonomo(); return; }
    if (!PIANO_ATTIVO && RUOLO !== "familiare") {
      root.innerHTML = `<div class="empty">Il tuo professionista non ha ancora assegnato un piano a questo account.</div>`;
      return;
    }
    const settimane = settimaneSpesa();
    const limitata = spesaLimitata();
    const sel = limitata ? settimane[0] : (settimane[SPESA.offset] || settimane[0]);
    let giorni = PIANO_ATTIVO ? PIANO_ATTIVO.settimane[sel.settimana] : [];
    if (!giorni) {
      root.innerHTML = `<div class="empty">La settimana ${sel.settimana} non è presente nel piano caricato.</div>`;
      return;
    }
    if (limitata) {
      // versione gratuita: solo gli alimenti dei pasti di oggi
      const oggi = window.weekLogic.menuDelGiorno(new Date(), CONFIG, PIANO_ATTIVO).giorno;
      giorni = oggi ? [oggi] : [];
      SPESA.contesto = { giorni, etichetta: "oggi" };
      collegaAscoltoSpesa(chiaveData(new Date()));
    } else {
      SPESA.contesto = { giorni, etichetta: sel.intervallo };
      collegaAscoltoSpesa(sel.docId);
    }
    root.dataset.modo = modoSpesa();
    if (modoSpesa() === "prep") { renderMealPrep(settimane, sel); return; }
    const vista = vistaSpesa();

    root.innerHTML = `
      ${interruttoreModoHTML("lista")}
      <section class="hero" style="border-bottom:none; margin-bottom:8px; padding-bottom:6px;">
        <div class="spesa-intestazione">
          <div class="hero__eyebrow"><span class="dot"></span> ${LISTA.dati ? escapeHTML(LISTA.dati.nome || "Lista di casa") : "Lista della spesa"}</div>
          <button type="button" class="btn-casa ${LISTA.dati ? "is-attiva" : ""}" id="btn-lista-casa-spesa" ${limitata ? "hidden" : ""}>👥 ${LISTA.dati ? `${(LISTA.dati.membri || []).length} in lista` : "Condividi"}</button>
        </div>
        ${limitata ? `<p class="spesa-oggi">Gli alimenti per i pasti di oggi</p>${bloccoPremiumHTML("Lista di tutta la settimana, in due spese e condivisibile")}` : ""}
        <div class="spesa-testata" ${limitata ? "hidden" : ""}>
          <select id="sel-settimana-spesa" aria-label="Settimana">
            ${settimane.map((s) => `<option value="${s.k}" ${s.k === sel.k ? "selected" : ""}>${escapeHTML(s.etichetta)}</option>`).join("")}
          </select>
          <div class="spesa-vista" role="group" aria-label="Aspetto della lista">
            <button type="button" data-vista="lista" aria-pressed="${vista === "lista"}" title="Vista a lista">☰ Lista</button>
            <button type="button" data-vista="blocchi" aria-pressed="${vista === "blocchi"}" title="Vista a blocchi">▦ Blocchi</button>
          </div>
          <div class="spesa-vista" role="group" aria-label="Quante spese">
            <button type="button" data-tempi="1" aria-pressed="${tempiSpesa() === 1}" title="Una spesa per tutta la settimana">Una spesa</button>
            <button type="button" data-tempi="2" aria-pressed="${tempiSpesa() === 2}" title="Due spese: lunedì–mercoledì e giovedì–domenica">Due spese</button>
          </div>
        </div>
      </section>
      <p class="hint" style="margin:0 0 12px;">${LISTA.dati ? "Lista condivisa: gli alimenti dei piani dei membri, sommati, più quello che aggiunge ciascuno." : "Un articolo per alimento, ricavato dai pasti della settimana."} ${vista === "blocchi"
        ? "Tocca un riquadro quando lo metti nel carrello; tienilo premuto per cambiarne nome o categoria."
        : "Spunta un articolo quando lo metti nel carrello; tocca ⋯ per cambiarne nome o categoria."}</p>

      <div id="spesa-contenuto" class="spesa-contenuto--${vista}"></div>

      <div class="import-actions" style="margin-top:18px;">
        <div class="editor-campo" style="flex-direction:row; gap:8px; align-items:stretch;">
          <input type="text" id="input-spesa-extra" placeholder="Mi serve anche…" autocomplete="off" style="flex:1;">
          <button type="button" class="btn" id="btn-aggiungi-spesa" style="width:auto; padding:0 16px;">Aggiungi</button>
        </div>
        <button type="button" class="btn btn--ghost" id="btn-copia-spesa">Copia gli articoli da prendere</button>
        <div id="spesa-azioni-extra"></div>
      </div>
    `;

    document.getElementById("sel-settimana-spesa").addEventListener("change", (e) => {
      SPESA.offset = Number(e.target.value) || 0;
      renderSpesa();
    });
    collegaInterruttoreModo();

    document.getElementById("btn-lista-casa-spesa").addEventListener("click", apriListaCasa);
    root.querySelectorAll("[data-tempi]").forEach((b) => b.addEventListener("click", () => {
      localStorage.setItem(LS_TEMPI_SPESA, b.dataset.tempi);
      renderSpesa();
    }));
    root.querySelectorAll("[data-vista]").forEach((b) => b.addEventListener("click", () => {
      localStorage.setItem(LS_VISTA_SPESA, b.dataset.vista);
      renderSpesa();
    }));

    const aggiungi = async () => {
      const input = document.getElementById("input-spesa-extra");
      const testo = input.value.trim().slice(0, 80);
      if (!testo) return;
      input.value = "";
      const voci = window.alimenti.classificaArticolo(testo);
      const giaPresente = voci.length && voci.every((v) => SPESA.voci.some((x) => x.chiave === v.chiave && !x.nascosto));
      if (giaPresente) {
        mostraToast(`${voci.map((v) => SPESA.pref.nome[v.chiave] || v.nome).join(", ")}: già in lista`);
        return;
      }
      SPESA.dati.extra = SPESA.dati.extra.concat([testo]);
      disegnaContenutoSpesa();
      try { await window.cloud.aggiungiArticoloSpesa(destinazioneSpesa(), SPESA.docId, testo); }
      catch (e) { mostraToast("Articolo non salvato: controlla la connessione"); }
    };
    document.getElementById("btn-aggiungi-spesa").addEventListener("click", aggiungi);
    document.getElementById("input-spesa-extra").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); aggiungi(); }
    });

    document.getElementById("btn-copia-spesa").addEventListener("click", copiaListaSpesa);
    collegaEventiContenutoSpesa(document.getElementById("spesa-contenuto"));
    disegnaContenutoSpesa();
  }

  function sezioniCategorieHTML(voci, vista) {
    return window.alimenti.CATEGORIE.map((cat) => {
      const qui = voci.filter((v) => v.cat === cat.id).sort((a, b) => a.nome.localeCompare(b.nome, "it"));
      if (!qui.length) return "";
      const mancanti = qui.filter((v) => !v.spuntata).length;
      const corpo = vista === "blocchi"
        ? `<div class="spesa-blocchi">${qui.map(bloccoSpesaHTML).join("")}</div>`
        : `<ul class="spesa-lista">${qui.map(rigaSpesaHTML).join("")}</ul>`;
      return `
        <section class="spesa-cat ${mancanti === 0 ? "is-completa" : ""}">
          <h3 class="spesa-cat__titolo"><span aria-hidden="true">${cat.icona}</span> ${escapeHTML(cat.nome)}
            <span class="spesa-cat__conta">${mancanti === 0 ? "✓" : mancanti}</span></h3>
          ${corpo}
        </section>`;
    }).join("");
  }

  function disegnaContenutoSpesa() {
    const box = document.getElementById("spesa-contenuto");
    if (!box || !SPESA.contesto) return;
    const A = window.alimenti;
    const vista = vistaSpesa();
    const tempi = tempiSpesa();
    const voci = calcolaVociSpesa();
    SPESA.voci = voci;
    const visibili = voci.filter((v) => !v.nascosto);
    const daScegliere = visibili.filter((v) => v.alternativa);
    const dispensa = conSpunta(visibili.filter((v) => !v.alternativa && v.dispensa), "");
    const normali = visibili.filter((v) => !v.alternativa && !v.dispensa);

    // Blocchi da mostrare: una spesa sola, oppure due (ciascuna con i suoi giorni)
    let blocchiSpesa;
    if (tempi === 2) {
      blocchiSpesa = TEMPI_SPESA.map((t, n) => ({
        tempo: t,
        voci: conSpunta(normali.map((v) => (v.daPiano ? A.restringiGiorni(v, t.giorni) : (n === 0 ? v : null))).filter(Boolean), t.id + ":"),
      }));
    } else {
      blocchiSpesa = [{ tempo: null, voci: conSpunta(normali, "") }];
    }
    SPESA.righe = blocchiSpesa.flatMap((b) => b.voci).concat(dispensa);
    const tutte = SPESA.righe;
    const daPrendere = tutte.filter((v) => !v.spuntata).length;

    if (!tutte.length && !daScegliere.length) {
      box.innerHTML = `<div class="empty" style="padding:28px 12px;">${RUOLO === "familiare" && !LISTA.id
        ? "Entra nella lista di casa con il codice che hai ricevuto (pulsante 👥 in alto), oppure scrivi qui sotto quello che ti serve."
        : "Nessun alimento trovato nei pasti di questa settimana. Scrivi qui sotto quello che ti serve."}</div>`;
    } else {
      box.innerHTML = `
        ${(SPESA.versioniVecchie || []).length ? `<div class="nota-versione">⚠️ Gli alimenti di <strong>${escapeHTML(SPESA.versioniVecchie.join(", "))}</strong> vengono da una versione precedente dell'app e potrebbero essere letti male. ${SPESA.versioniVecchie.length === 1 ? "Chiedi di aprire" : "Chiedete di aprire"} l'app sul proprio telefono: si aggiornano da soli.</div>` : ""}
        <p class="spesa-riepilogo">${daPrendere === 0 && !daScegliere.length ? "Hai preso tutto. Buona settimana!" : `${daPrendere} ${daPrendere === 1 ? "articolo" : "articoli"} da prendere su ${tutte.length}`}</p>
        ${daScegliere.length ? `
          <section class="spesa-cat spesa-cat--scelta">
            <h3 class="spesa-cat__titolo"><span aria-hidden="true">🔀</span> Scegli tu <span class="spesa-cat__conta">${daScegliere.length}</span></h3>
            <button type="button" class="btn btn--ghost btn-scegli-per-me" id="btn-scegli-per-me">✨ Scegli per me</button>
            <p class="spesa-cat__nota">Il piano ti lascia scegliere tra più alimenti o piatti: tocca <strong>Scegli</strong> e in lista finirà solo quello che preferisci.</p>
            <ul class="spesa-lista">${daScegliere.sort((a, b) => a.nome.localeCompare(b.nome, "it")).map(rigaSceltaHTML).join("")}</ul>
          </section>` : ""}
        ${blocchiSpesa.map((b) => b.tempo ? `
          <section class="spesa-tempo">
            <h3 class="spesa-tempo__titolo">${b.tempo.titolo} <span>${b.tempo.per}</span></h3>
            ${b.voci.length ? sezioniCategorieHTML(b.voci, vista) : `<p class="spesa-cat__nota">Niente da comprare per questi giorni.</p>`}
          </section>` : sezioniCategorieHTML(b.voci, vista)).join("")}
        ${dispensa.length ? `
          <section class="spesa-cat spesa-cat--dispensa">
            <h3 class="spesa-cat__titolo"><span aria-hidden="true">🫙</span> Da controllare in dispensa <span class="spesa-cat__conta">${dispensa.filter((v) => !v.spuntata).length || "✓"}</span></h3>
            <p class="spesa-cat__nota">Di solito ci sono già in casa: spunta se li hai o se li compri.</p>
            ${vista === "blocchi" ? `<div class="spesa-blocchi">${dispensa.map(bloccoSpesaHTML).join("")}</div>` : `<ul class="spesa-lista">${dispensa.map(rigaSpesaHTML).join("")}</ul>`}
          </section>` : ""}
        ${Object.keys(SPESA.dati.scelte || {}).length ? `<button type="button" class="link-btn" id="btn-annulla-scelte" style="margin-top:8px;">Rimetti tutto da scegliere</button>` : ""}
        <p class="stat-nota" style="margin:12px 2px 0;">Le quantità sono quelle del piano (di solito peso netto): per frutta e verdura considera lo scarto. Le confezioni sono indicative: i formati cambiano tra marche e negozi.</p>`;
      const perMe = document.getElementById("btn-scegli-per-me");
      if (perMe) perMe.addEventListener("click", scegliPerMe);
      const annScelte = document.getElementById("btn-annulla-scelte");
      if (annScelte) annScelte.addEventListener("click", annullaScelte);
    }

    // Azioni in fondo: riporta tutto da prendere, articoli nascosti
    const extraBox = document.getElementById("spesa-azioni-extra");
    if (extraBox) {
      const numSpuntate = (SPESA.righe || []).filter((v) => v.spuntata).length;
      const numNascosti = SPESA.pref.nascosti.length;
      extraBox.innerHTML = `
        ${numSpuntate ? `<button type="button" class="btn btn--ghost" id="btn-azzera-spesa">Rimetti tutto da prendere</button>` : ""}
        ${numNascosti ? `<button type="button" class="link-btn" id="btn-nascosti-spesa">${numNascosti} ${numNascosti === 1 ? "articolo nascosto" : "articoli nascosti"}: mostra</button>` : ""}`;
      const az = document.getElementById("btn-azzera-spesa");
      if (az) az.addEventListener("click", async () => {
        SPESA.dati.spuntate = [];
        disegnaContenutoSpesa();
        try { await window.cloud.azzeraSpunteSpesa(destinazioneSpesa(), SPESA.docId); } catch (e) { mostraToast("Modifica non salvata: controlla la connessione"); }
      });
      const na = document.getElementById("btn-nascosti-spesa");
      if (na) na.addEventListener("click", apriNascostiSpesa);
    }
  }

  function quantitaVoceHTML(v) {
    const A = window.alimenti;
    const q = A.formattaQuantita(v.tot);
    if (!q) return "";
    const c = A.confezioniNecessarie(v);
    return `<span class="spesa-riga__qta">${escapeHTML(q)}${c ? `<small>${escapeHTML(c.testo)}</small>` : ""}</span>`;
  }

  function dettaglioVoceHTML(v) {
    const A = window.alimenti;
    const giorni = v.giorni && Object.keys(v.giorni).length ? A.testoGiorni(v) : "";
    const membri = LISTA.id && v.perMembro && Object.keys(v.perMembro).length > 1 && tempiSpesa() === 1
      ? " · " + Object.entries(v.perMembro).map(([uid, t]) => `${nomeMembro(uid)} ${A.formattaQuantita(t)}`.trim()).join(", ") : "";
    const scelta = v.sceltaDa ? ` · <button type="button" class="link-inline link-inline--piccolo" data-scegli="${escapeHTML(v.sceltaDa)}">${v.piattoScelto ? `per ${escapeHTML(v.piattoScelto.toLowerCase())}` : `scelto tra ${v.numAlternative}`}: cambia</button>` : "";
    return giorni || scelta || membri ? `<span class="spesa-riga__giorni">${escapeHTML(giorni + membri)}${scelta}</span>` : "";
  }

  function rigaSpesaHTML(v) {
    return `
      <li class="spesa-riga ${v.spuntata ? "is-spuntata" : ""}">
        <label>
          <input type="checkbox" data-spunta="${escapeHTML(v.chiaveSpunta || v.chiave)}" ${v.spuntata ? "checked" : ""}>
          <span class="spesa-riga__icona" aria-hidden="true">${v.icona}</span>
          <span class="spesa-riga__testo">
            <span class="spesa-riga__nome">${escapeHTML(v.nome)}</span>
            ${dettaglioVoceHTML(v)}
          </span>
        </label>
        ${quantitaVoceHTML(v)}
        <button type="button" class="spesa-opzioni" data-opzioni="${escapeHTML(v.chiave)}" aria-label="Opzioni per ${escapeHTML(v.nome)}">⋯</button>
      </li>`;
  }

  function rigaSceltaHTML(v) {
    const A = window.alimenti;
    const q = A.formattaQuantita(v.tot);
    const opzioni = v.opzioni.map((o) => o.nome.toLowerCase()).join(v.piatti ? " · " : ", ");
    return `
      <li class="spesa-riga spesa-riga--scelta">
        <span class="spesa-riga__icona" aria-hidden="true">${v.piatti ? "🍽️" : "🔀"}</span>
        <span class="spesa-riga__testo">
          <span class="spesa-riga__nome">${escapeHTML(v.nome)}${q ? ` · ${escapeHTML(q)}` : ""}</span>
          <span class="spesa-riga__giorni">${escapeHTML(opzioni)} · ${escapeHTML(Object.keys(v.giorni || {}).map(Number).sort((x, y) => x - y).map((i) => A.GIORNI_BREVI[i]).join(", "))}</span>
        </span>
        <button type="button" class="btn btn-scegli" data-scegli="${escapeHTML(v.chiave)}">Scegli</button>
      </li>`;
  }

  function bloccoSpesaHTML(v) {
    const q = window.alimenti.formattaQuantita(v.tot);
    return `
      <button type="button" class="spesa-blocco ${v.spuntata ? "is-spuntata" : ""}" data-blocco="${escapeHTML(v.chiaveSpunta || v.chiave)}" data-chiave="${escapeHTML(v.chiave)}" aria-pressed="${v.spuntata}">
        <span class="spesa-blocco__icona" aria-hidden="true">${v.icona}</span>
        <span class="spesa-blocco__nome">${escapeHTML(v.nome)}</span>
        ${q ? `<span class="spesa-blocco__qta">${escapeHTML(q)}</span>` : ""}
      </button>`;
  }

  /**
   * "Scegli per me": per ogni scelta aperta prende l'opzione che usa più
   * alimenti già in lista (così si compra meno roba diversa); a parità, la
   * prima proposta dal piano.
   */
  async function scegliPerMe() {
    const voci = SPESA.voci || [];
    const inLista = new Set(voci.filter((v) => !v.alternativa && !v.nascosto).map((v) => v.chiave));
    const nuove = {};
    voci.filter((v) => v.alternativa && !v.nascosto).forEach((alt) => {
      let migliore = alt.opzioni[0], punti = -1;
      alt.opzioni.forEach((o) => {
        const chiavi = o.piatto ? (o.voci || []).map((iv) => iv.chiave) : [o.chiave];
        const p = chiavi.filter((k) => inLista.has(k)).length / Math.max(1, chiavi.length);
        if (p > punti) { punti = p; migliore = o; }
      });
      nuove[alt.chiave] = migliore.chiave;
    });
    if (!Object.keys(nuove).length) return;
    SPESA.dati.scelte = Object.assign({}, SPESA.dati.scelte || {}, nuove);
    disegnaContenutoSpesa();
    mostraToast(`Fatte ${Object.keys(nuove).length} scelte: puoi cambiarle da ogni articolo`, 3500);
    try { await window.cloud.impostaSceltaSpesa(destinazioneSpesa(), SPESA.docId, nuove); }
    catch (e) { mostraToast("Scelte non salvate: controlla la connessione"); }
  }

  async function annullaScelte() {
    const vecchie = SPESA.dati.scelte || {};
    const via = {};
    // tutte le scelte della settimana (nella lista di casa valgono per tutti i membri)
    Object.keys(vecchie).forEach((k) => { via[k] = null; });
    SPESA.dati.scelte = {};
    disegnaContenutoSpesa();
    try { await window.cloud.impostaSceltaSpesa(destinazioneSpesa(), SPESA.docId, via); }
    catch (e) { mostraToast("Non riuscito: controlla la connessione"); }
  }

  /** Scheda per scegliere tra le alternative del piano (o cambiare la scelta). */
  function apriSceltaAlternativa(chiaveAlt) {
    const A = window.alimenti;
    const alt = (SPESA.voci || []).find((v) => v.chiave === chiaveAlt && v.alternativa)
      || A.listaDaSettimana(SPESA.contesto.giorni, CAMPI_SPESA).find((v) => v.chiave === chiaveAlt);
    if (!alt) return;
    const attuale = (SPESA.dati.scelte || {})[chiaveAlt] || null;
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">${escapeHTML(alt.nome)}</h2>
      <p class="sheet__nota">${alt.piatti ? "Il piano propone più piatti: scegli quello che cucinerai e in lista finiranno i suoi ingredienti. La scelta vale anche per il meal prep." : "Il piano ti lascia scegliere: in lista finirà solo quello che preferisci, con le quantità e i giorni giusti."} Puoi cambiare idea quando vuoi.</p>
      <div class="stato-pasto">
        ${alt.opzioni.map((o) => `
          <button type="button" class="stato-pasto__opzione scelta-opzione" data-opzione="${escapeHTML(o.chiave)}" aria-checked="${o.chiave === attuale}">
            <span aria-hidden="true">${o.icona}</span>
            <span class="scelta-opzione__testo"><span>${escapeHTML(o.nome)}</span><small>${escapeHTML(o.piatto
              ? "In lista: " + (o.voci || []).map((iv) => `${iv.nome.toLowerCase()}${A.formattaQuantita(iv.tot) ? " " + A.formattaQuantita(iv.tot) : ""}`).join(", ")
              : [A.formattaQuantita(o.tot), A.testoGiorni(o)].filter(Boolean).join(" · "))}</small></span>
          </button>`).join("")}
      </div>
      ${attuale ? `<button type="button" class="btn btn--ghost" id="scelta-annulla">Torna a "da scegliere"</button>` : ""}
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
    `);
    const salva = async (valore) => {
      const scelte = Object.assign({}, SPESA.dati.scelte || {});
      if (valore) scelte[chiaveAlt] = valore; else delete scelte[chiaveAlt];
      SPESA.dati.scelte = scelte;
      chiudiSheet();
      disegnaContenutoSpesa();
      try { await window.cloud.scegliAlternativaSpesa(destinazioneSpesa(), SPESA.docId, chiaveAlt, valore); }
      catch (e) { mostraToast("Scelta non salvata: controlla la connessione"); }
    };
    overlay.querySelectorAll("[data-opzione]").forEach((b) => b.addEventListener("click", () => salva(b.dataset.opzione)));
    const ann = overlay.querySelector("#scelta-annulla");
    if (ann) ann.addEventListener("click", () => salva(null));
  }

  async function spuntaVoceSpesa(chiave, spuntata) {
    const set = new Set(SPESA.dati.spuntate);
    if (spuntata) set.add(chiave); else set.delete(chiave);
    SPESA.dati.spuntate = Array.from(set);
    disegnaContenutoSpesa();
    try { await window.cloud.spuntaSpesa(destinazioneSpesa(), SPESA.docId, chiave, spuntata); }
    catch (e) { mostraToast("Spunta non salvata: controlla la connessione"); }
  }

  /** Eventi delegati sul contenitore: sopravvivono ai ridisegni della lista. */
  function collegaEventiContenutoSpesa(box) {
    let timer = null, pressioneLunga = false, xy = null;

    box.addEventListener("change", (e) => {
      const chk = e.target.closest("[data-spunta]");
      if (chk) spuntaVoceSpesa(chk.dataset.spunta, chk.checked);
    });

    box.addEventListener("click", (e) => {
      const sc = e.target.closest("[data-scegli]");
      if (sc) { e.preventDefault(); apriSceltaAlternativa(sc.dataset.scegli); return; }
      const opz = e.target.closest("[data-opzioni]");
      if (opz) { apriOpzioniSpesa(opz.dataset.opzioni); return; }
      const blocco = e.target.closest("[data-blocco]");
      if (blocco) {
        if (pressioneLunga) { pressioneLunga = false; return; }
        spuntaVoceSpesa(blocco.dataset.blocco, blocco.getAttribute("aria-pressed") !== "true");
      }
    });

    // Pressione lunga sui blocchi → opzioni
    const annulla = () => { clearTimeout(timer); timer = null; };
    box.addEventListener("pointerdown", (e) => {
      const blocco = e.target.closest("[data-blocco]");
      if (!blocco) return;
      pressioneLunga = false;
      xy = [e.clientX, e.clientY];
      annulla();
      timer = setTimeout(() => {
        pressioneLunga = true;
        if (navigator.vibrate) navigator.vibrate(15);
        apriOpzioniSpesa(blocco.dataset.chiave || blocco.dataset.blocco);
      }, 550);
    });
    box.addEventListener("pointermove", (e) => {
      if (timer && xy && Math.hypot(e.clientX - xy[0], e.clientY - xy[1]) > 10) annulla();
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => box.addEventListener(ev, annulla));
    box.addEventListener("contextmenu", (e) => {
      const blocco = e.target.closest("[data-blocco]");
      if (!blocco) return;
      e.preventDefault();
      if (!pressioneLunga) { annulla(); pressioneLunga = true; apriOpzioniSpesa(blocco.dataset.chiave || blocco.dataset.blocco); }
    });
  }

  function apriOpzioniSpesa(chiave) {
    const v = SPESA.voci.find((x) => x.chiave === chiave);
    if (!v) return;
    const modificata = v.nome !== v.nomeOriginale || v.cat !== v.catOriginale;
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">${v.icona} ${escapeHTML(v.nome)}</h2>
      <label class="editor-campo">Nome in lista
        <input type="text" id="opz-spesa-nome" value="${escapeHTML(v.nome)}" maxlength="60">
      </label>
      <label class="editor-campo" style="margin-top:12px;">Categoria
        <select id="opz-spesa-cat">
          ${window.alimenti.CATEGORIE.map((c) => `<option value="${c.id}" ${c.id === v.cat ? "selected" : ""}>${c.icona} ${escapeHTML(c.nome)}</option>`).join("")}
        </select>
      </label>
      <p class="sheet__nota">La modifica vale anche per le prossime settimane.</p>
      <button type="button" class="btn" id="opz-spesa-salva">Salva</button>
      ${modificata ? `<button type="button" class="btn btn--ghost" id="opz-spesa-ripristina">Ripristina nome e categoria originali</button>` : ""}
      ${v.daPiano
        ? `<button type="button" class="btn btn--ghost" id="opz-spesa-nascondi">Non mostrarlo più nella lista</button>`
        : `<button type="button" class="btn btn--ghost" id="opz-spesa-elimina">Elimina articolo</button>`}
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
    `);

    const salva = async (nome, cat) => {
      const nuovoNome = nome && nome !== v.nomeOriginale ? nome : null;
      const nuovaCat = cat && cat !== v.catOriginale ? cat : null;
      if (nuovoNome) SPESA.pref.nome[chiave] = nuovoNome; else delete SPESA.pref.nome[chiave];
      if (nuovaCat) SPESA.pref.categoria[chiave] = nuovaCat; else delete SPESA.pref.categoria[chiave];
      chiudiSheet();
      disegnaContenutoSpesa();
      try {
        await window.cloud.salvaPreferenzaSpesa(UID, "nome", chiave, nuovoNome);
        await window.cloud.salvaPreferenzaSpesa(UID, "categoria", chiave, nuovaCat);
      } catch (e) { mostraToast("Modifica non salvata: controlla la connessione"); }
    };

    overlay.querySelector("#opz-spesa-salva").addEventListener("click", () => {
      salva(overlay.querySelector("#opz-spesa-nome").value.trim(), overlay.querySelector("#opz-spesa-cat").value);
    });
    const rip = overlay.querySelector("#opz-spesa-ripristina");
    if (rip) rip.addEventListener("click", () => salva(null, null));

    const nasc = overlay.querySelector("#opz-spesa-nascondi");
    if (nasc) nasc.addEventListener("click", async () => {
      SPESA.pref.nascosti = SPESA.pref.nascosti.concat([chiave]);
      if (!SPESA.pref.nome[chiave]) SPESA.pref.nome[chiave] = v.nome; // serve a mostrarlo tra i nascosti
      chiudiSheet();
      disegnaContenutoSpesa();
      mostraToast(`${v.nome} non comparirà più nella lista`);
      try {
        await window.cloud.salvaPreferenzaSpesa(UID, "nascosti", chiave, true);
        await window.cloud.salvaPreferenzaSpesa(UID, "nome", chiave, SPESA.pref.nome[chiave]);
      } catch (e) { mostraToast("Modifica non salvata: controlla la connessione"); }
    });

    const elim = overlay.querySelector("#opz-spesa-elimina");
    if (elim) elim.addEventListener("click", async () => {
      const testi = v.testiExtra.slice();
      SPESA.dati.extra = SPESA.dati.extra.filter((t) => !testi.includes(t));
      chiudiSheet();
      disegnaContenutoSpesa();
      try { for (const t of testi) await window.cloud.rimuoviArticoloSpesa(destinazioneSpesa(), SPESA.docId, t); }
      catch (e) { mostraToast("Modifica non salvata: controlla la connessione"); }
    });
  }

  function nomeVoceNascosta(chiave) {
    const inLista = SPESA.voci.find((x) => x.chiave === chiave);
    if (inLista) return { nome: inLista.nome, icona: inLista.icona };
    const cat = window.alimenti.voceDaChiave(chiave);
    const nome = SPESA.pref.nome[chiave] || (cat ? cat.nome : chiave.slice(2).replace(/-/g, " "));
    return { nome, icona: cat ? cat.icona : "🛒" };
  }

  function apriNascostiSpesa() {
    const elenco = SPESA.pref.nascosti.map((k) => Object.assign({ chiave: k }, nomeVoceNascosta(k)));
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">Articoli nascosti</h2>
      <p class="sheet__nota">Non compaiono nella lista anche se sono nei pasti del piano.</p>
      <ul class="spesa-lista" style="margin-bottom:14px;">
        ${elenco.map((x) => `
          <li class="spesa-riga">
            <span class="spesa-riga__icona" aria-hidden="true">${x.icona}</span>
            <span class="spesa-riga__nome" style="flex:1;">${escapeHTML(x.nome)}</span>
            <button type="button" class="link-btn" data-ripristina="${escapeHTML(x.chiave)}">Rimetti in lista</button>
          </li>`).join("")}
      </ul>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Chiudi</button>
    `);
    overlay.querySelectorAll("[data-ripristina]").forEach((b) => b.addEventListener("click", async () => {
      const k = b.dataset.ripristina;
      SPESA.pref.nascosti = SPESA.pref.nascosti.filter((x) => x !== k);
      b.closest("li").remove();
      disegnaContenutoSpesa();
      if (!SPESA.pref.nascosti.length) chiudiSheet();
      try { await window.cloud.salvaPreferenzaSpesa(UID, "nascosti", k, false); }
      catch (e) { mostraToast("Modifica non salvata: controlla la connessione"); }
    }));
  }

  async function copiaListaSpesa() {
    const A = window.alimenti;
    const righe = (SPESA.righe || []).filter((v) => !v.spuntata);
    const scelte = (SPESA.voci || []).filter((v) => v.alternativa && !v.nascosto);
    if (!righe.length && !scelte.length) { mostraToast("Non c'è niente da prendere"); return; }
    const riga = (v) => {
      const q = A.formattaQuantita(v.tot);
      const g = v.giorni && Object.keys(v.giorni).length > 1 ? ` (${A.testoGiorni(v)})` : "";
      const c = A.confezioniNecessarie(v);
      return `- ${v.nome}${q ? " " + q : ""}${c ? ` [${c.testo}]` : ""}${g}`;
    };
    const perCategorie = (voci) => A.CATEGORIE.map((cat) => {
      const qui = voci.filter((v) => v.cat === cat.id && !v.dispensa).sort((a, b) => a.nome.localeCompare(b.nome, "it"));
      return qui.length ? `${cat.nome}\n` + qui.map(riga).join("\n") : "";
    }).filter(Boolean).join("\n\n");
    const parti = [];
    if (scelte.length) parti.push("Da scegliere\n" + scelte.map((v) => `- ${v.nome}${A.formattaQuantita(v.tot) ? " " + A.formattaQuantita(v.tot) : ""}: ${v.opzioni.map((o) => o.nome.toLowerCase()).join(" / ")}`).join("\n"));
    if (tempiSpesa() === 2) {
      TEMPI_SPESA.forEach((t) => {
        const qui = righe.filter((v) => v.chiaveSpunta && v.chiaveSpunta.startsWith(t.id + ":"));
        if (qui.length) parti.push(`${t.titolo.toUpperCase()} (${t.per})\n\n` + perCategorie(qui));
      });
    } else {
      parti.push(perCategorie(righe));
    }
    const disp = righe.filter((v) => v.dispensa);
    if (disp.length) parti.push("Da controllare in dispensa\n" + disp.map(riga).join("\n"));
    const testo = `Lista della spesa (${SPESA.contesto.etichetta})\n\n` + parti.filter(Boolean).join("\n\n");
    try {
      await navigator.clipboard.writeText(testo);
      mostraToast("Lista copiata negli appunti");
    } catch (e) {
      mostraToast("Impossibile copiare automaticamente su questo browser");
    }
  }


  // ---------------------------------------------------------------------
  // Vista "Impostazioni" (paziente) — solo consultazione, niente modifiche al piano
  // ---------------------------------------------------------------------
  function renderImpostazioni() {
    if (RUOLO === "familiare") { renderImpostazioniFamiliare(); return; }
    const p = (PIANO_ATTIVO && PIANO_ATTIVO.paziente) || {};
    const orari = orariEffettivi();
    const attive = notificheAttive();
    const permesso = window.cloud.nativo ? (PERMESSO_NATIVO || "default") : ("Notification" in window) ? Notification.permission : "unsupported";
    if (window.cloud.nativo) aggiornaPermessoNativo();

    root.innerHTML = `
      ${AUTONOMO ? `
      <section class="settings-section">
        <h2>Premium</h2>
        <p class="hint">${!PREMIUM.noto ? (PREMIUM.errore ? `Stato non verificato (${escapeHTML(PREMIUM.errore)}).` : "Verifica in corso…")
          : PREMIUM.attivo ? (PREMIUM.origine === "nutrizionista" ? "Incluso perché sei seguito dal tuo nutrizionista." : giorniProvaRimasti() != null ? `Prova gratuita: ${giorniProvaRimasti() === 1 ? "oggi è l'ultimo giorno" : `ancora ${giorniProvaRimasti()} giorni`}.` : "Abbonamento attivo.")
          : "Stai usando la versione gratuita."}</p>
        ${!PREMIUM.noto && PREMIUM.errore ? `<button type="button" class="btn btn--ghost" id="btn-verifica-premium" style="margin-bottom:8px;">Verifica di nuovo</button>` : ""}
        <button type="button" class="btn btn--ghost" data-premium>Cosa include Premium</button>
        <p class="stat-nota" style="margin-top:8px;">Accesso come ${escapeHTML((window.cloud.utenteCorrente && window.cloud.utenteCorrente() && window.cloud.utenteCorrente().email) || "—")}</p>
      </section>` : ""}
      ${gestisceIlPiano() ? `
      <section class="settings-section">
        <h2>Il mio piano</h2>
        <p class="hint">Correggi un pasto, copia una settimana o carica il nuovo piano quando il nutrizionista te lo cambia.</p>
        <button type="button" class="btn" data-mio-piano="modifica">Gestisci il mio piano</button>
      </section>` : ""}
      ${riepilogoVisitaSezioneHTML()}
      ${calcolatoreSezioneHTML()}
      ${parametriAllenamentoSezioneHTML()}
      ${privacyPazienteSezioneHTML()}
      ${AUTONOMO ? nutrizionistaSezioneHTML() : ""}
      <section class="settings-section">
        <h2>Promemoria pasti</h2>
        <p class="hint">Un avviso sul telefono prima di ogni pasto, con il menu del momento — anche ad app chiusa.</p>
        ${serveGuidaIOS() ? `
          <div class="avviso-ios">
            <p>Su iPhone i promemoria arrivano solo se l'app è installata sulla schermata Home.</p>
            <button type="button" class="btn btn--ghost" data-apri-guida-ios>Come installarla</button>
          </div>` : ""}
        <div class="field-row">
          <div>
            <div class="field-row__label">Attiva promemoria</div>
            <div class="status-line"><span class="status-dot ${permesso === "granted" && attive ? "ok" : permesso === "denied" ? "off" : ""}"></span>${statoNotificheTesto(permesso, attive)}</div>
          </div>
          <label class="switch">
            <input type="checkbox" id="chk-notifiche" ${attive ? "checked" : ""} ${permesso === "denied" ? "disabled" : ""}>
            <span class="track"></span><span class="thumb"></span>
          </label>
        </div>
        <div class="field-row">
          <span class="field-row__label">Anticipo promemoria</span>
          <select id="sel-anticipo">
            ${ANTICIPI_VALIDI.map((n) => `<option value="${n}" ${n === anticipoMinutiEffettivo() ? "selected" : ""}>${n} minuti prima</option>`).join("")}
          </select>
        </div>
        ${MEAL_KEYS.map((key) => `
          <div class="field-row">
            <span class="field-row__label">${MEAL_META[key].label}</span>
            <input type="time" data-key="${key}" class="input-orario" value="${orari[key]}">
          </div>
        `).join("")}
      </section>

      <section class="settings-section">
        <h2>Spesa condivisa</h2>
        <p class="hint">${LISTA.dati ? `Fai parte di <strong>${escapeHTML(LISTA.dati.nome || "una lista di casa")}</strong>: la lista della spesa è condivisa con ${(LISTA.dati.membri || []).length - 1} ${(LISTA.dati.membri || []).length === 2 ? "altra persona" : "altre persone"}.` : "Fai la spesa insieme a chi vive con te: una sola lista, aggiornata in tempo reale su ogni telefono."}</p>
        <button type="button" class="btn btn--ghost" id="btn-lista-casa-imp">${LISTA.dati ? "Gestisci la lista di casa" : "Condividi la lista della spesa"}</button>
      </section>

      ${aspettoSezioneHTML()}

      ${gestisceIlPiano() ? (progressiPazienteHTML() ? `
      <section class="settings-section">
        <h2>Il tuo andamento</h2>
        ${progressiPazienteHTML()}
      </section>` : "") : `
      <section class="settings-section">
        <h2>Il mio piano</h2>
        ${appuntamentoPazienteHTML()}
        ${progressiPazienteHTML()}
        ${PIANO_ATTIVO ? `
          <div class="card-info">
            <dl>
              <dt>Paziente</dt><dd>${escapeHTML(p.nome || "—")}</dd>
              <dt>Obiettivo</dt><dd>${escapeHTML(p.obiettivo || "—")}</dd>
              <dt>Target giornaliero</dt><dd>${p.targetKcal != null ? "~" + p.targetKcal + " kcal" : "—"}</dd>
            </dl>
          </div>
          ${renderContattoNutrizionistaHTML()}
        ` : `<p class="hint">Nessun piano assegnato ancora.</p>`}
        <p class="hint" style="margin-top:14px;">Pasti, regole generali e dati del piano vengono aggiornati dal tuo professionista e si sincronizzano automaticamente qui — da questa app si possono solo consultare.</p>
      </section>`}
      ${eliminaAccountSezioneHTML()}
    `;
    collegaPulsantiMioPiano(root, "impostazioni");
    collegaSezioneNutrizionista();
    collegaEliminaAccount();
    collegaRiepilogoVisita();
    const calc = document.getElementById("btn-calcolatore-cotto");
    if (calc) calc.addEventListener("click", apriCalcolatoreCotto);
    collegaParametriAllenamento();
    collegaPrivacyPaziente();
    const verificaPremium = document.getElementById("btn-verifica-premium");
    if (verificaPremium) verificaPremium.addEventListener("click", () => { TENTATIVI_PREMIUM = 0; aggiornaPremium(true); });

    document.getElementById("chk-notifiche").addEventListener("change", onToggleNotificheDettaglio);
    root.querySelectorAll("[data-apri-guida-ios]").forEach((b) => b.addEventListener("click", apriGuidaIOS));
    collegaContattoNutrizionista();
    collegaAppuntamentoPaziente();
    document.getElementById("sel-anticipo").addEventListener("change", (e) => {
      localStorage.setItem(LS_KEYS.anticipo, e.target.value);
      if (notificheAttive()) {
        pianificaNotificheOggi();
        sincronizzaPreferenzeNotifichePush().catch(() => {});
      }
      mostraToast("Anticipo aggiornato");
    });
    document.getElementById("btn-lista-casa-imp").addEventListener("click", apriListaCasa);
    collegaProgressiPaziente();
    collegaAspetto(renderImpostazioni);
    document.querySelectorAll(".input-orario").forEach((inp) => {
      inp.addEventListener("change", () => {
        const override = JSON.parse(localStorage.getItem(LS_KEYS.orari) || "{}");
        override[inp.dataset.key] = inp.value;
        localStorage.setItem(LS_KEYS.orari, JSON.stringify(override));
        if (notificheAttive()) {
          pianificaNotificheOggi();
          sincronizzaPreferenzeNotifichePush().catch(() => {});
        }
        mostraToast("Orario aggiornato");
      });
    });
  }

  function statoNotificheTesto(permesso, attive) {
    if (window.cloud.nativo && permesso === "denied") return "Bloccate: Impostazioni del telefono → App → Il mio Piano → Notifiche";
    if (permesso === "unsupported") {
      if (eIOS() && !eStandalone()) return "Prima installa l'app sulla schermata Home";
      if (eIOS() && !iosSupportaPush()) return "Serve iOS 16.4 o successivo";
      return "Non supportate su questo browser";
    }
    if (permesso === "denied") {
      return eIOS()
        ? "Bloccate: su iPhone vai in Impostazioni → Notifiche → Il mio Piano"
        : "Bloccate nelle impostazioni del browser/telefono";
    }
    if (attive && permesso === "granted") return "Attivi su questo dispositivo";
    return "Disattivati";
  }

  /**
   * Il menu a tendina usa valori in italiano ("chiaro"/"scuro"), ma il CSS
   * (per convenzione più comune) controlla l'attributo in inglese
   * (data-theme="light"/"dark") — questa mappa li fa incontrare.
   */
  function applyTema(v) {
    if (window.temaApp) { window.temaApp.imposta({ aspetto: ["chiaro", "scuro"].includes(v) ? v : "sistema" }); return; }
    const mappa = { chiaro: "light", scuro: "dark" };
    if (v === "sistema" || !mappa[v]) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", mappa[v]);
  }

  /** Cambia l'aspetto dell'app e lo salva nel profilo (vale su tutti i dispositivi). */
  function cambiaAspetto(parziale) {
    if (!window.temaApp) return;
    const a = window.temaApp.imposta(parziale);
    if (UID && window.cloud.salvaAspetto) window.cloud.salvaAspetto(UID, a).catch(() => {});
  }

  function aspettoSezioneHTML() {
    if (!window.temaApp) return "";
    const T = window.temaApp, a = T.get();
    const seg = (chiave, voci) => voci.map(([id, nome]) =>
      `<button type="button" class="segmento__voce" data-aspetto="${chiave}" data-valore="${id}" aria-pressed="${a[chiave] === id}">${nome}</button>`).join("");
    return `
      <section class="settings-section" id="sezione-aspetto">
        <h2>Aspetto dell'app</h2>
        <p class="impost-etichetta">Stile</p>
        <div class="scelta-stili">
          ${T.STILI.map((st) => `<button type="button" class="scelta-stile scelta-stile--${st.id}" data-aspetto="stile" data-valore="${st.id}" aria-pressed="${a.stile === st.id}"><span class="scelta-stile__aa" aria-hidden="true">Aa</span><span>${st.nome}</span></button>`).join("")}
        </div>
        <p class="impost-etichetta">Colore <span class="impost-etichetta__valore">${escapeHTML((T.COLORI.find((c) => c.id === a.colore) || T.COLORI[0]).nome)}</span></p>
        <div class="scelta-colori">
          ${T.COLORI.map((c) => `<button type="button" class="scelta-colore" data-aspetto="colore" data-valore="${c.id}" aria-pressed="${a.colore === c.id}" aria-label="${c.nome}" style="--campione-chiaro: ${c.chiaro}; --campione-scuro: ${c.scuro};"></button>`).join("")}
        </div>
        <div class="scelta-doppia">
          <div>
            <p class="impost-etichetta">Aspetto</p>
            <div class="segmento">${seg("aspetto", [["chiaro", "Chiaro"], ["scuro", "Scuro"], ["sistema", "Auto"]])}</div>
          </div>
          <div>
            <p class="impost-etichetta">Testo</p>
            <div class="segmento">${seg("testo", [["normale", "Normale"], ["grande", "Grande"]])}</div>
          </div>
        </div>
      </section>`;
  }

  function collegaAspetto(ridisegna) {
    document.querySelectorAll("#sezione-aspetto [data-aspetto]").forEach((b) => b.addEventListener("click", () => {
      cambiaAspetto({ [b.dataset.aspetto]: b.dataset.valore });
      const y = window.scrollY;
      ridisegna();
      window.scrollTo(0, y);
    }));
  }

  // ---------------------------------------------------------------------
  // Notifiche
  // ---------------------------------------------------------------------
  function notificheAttive() {
    return localStorage.getItem(LS_KEYS.notifiche) === "1";
  }

  async function onToggleNotificheRapido() {
    if (notificheAttive()) {
      await disattivaNotifiche();
      return;
    }
    await attivaNotifiche();
  }

  async function onToggleNotificheDettaglio(e) {
    if (e.target.checked) {
      const ok = await attivaNotifiche();
      if (!ok) render();
    } else {
      await disattivaNotifiche();
    }
  }

  async function disattivaNotifiche() {
    localStorage.setItem(LS_KEYS.notifiche, "0");
    aggiornaIconaCampanella();
    mostraToast("Promemoria disattivati");
    if (currentView === "impostazioni") render();
    try {
      await window.cloud.salvaPreferenzeNotifiche(UID, { notificheAttive: false });
    } catch (e) {
      // La disattivazione locale ha comunque effetto; la sincronizzazione
      // col server (per le notifiche push) si aggiornerà al prossimo tentativo.
    }
  }

  // App Android: stato del permesso delle notifiche native ("granted", "denied", "prompt")
  let PERMESSO_NATIVO = null;
  async function aggiornaPermessoNativo() {
    const p = await window.cloud.permessoNotificheNativo();
    const nuovo = p === "prompt" || p === "prompt-with-rationale" ? "default" : p;
    if (nuovo !== PERMESSO_NATIVO) { PERMESSO_NATIVO = nuovo; if (currentView === "impostazioni") render(); }
  }

  /** App Android: i promemoria arrivano solo dal server (notifiche native), non ci sono promemoria locali. */
  async function attivaNotificheNative() {
    let token = null;
    try {
      token = await window.cloud.registraTokenPush(UID);
    } catch (e) {
      console.warn("Registrazione delle notifiche native non riuscita:", e);
      mostraToast("Non riesco ad attivare i promemoria: controlla la connessione e riprova", 4500);
      return false;
    }
    await aggiornaPermessoNativo();
    if (!token) {
      mostraToast("Permesso non concesso: puoi attivarlo nelle impostazioni del telefono, alla voce App → Il mio Piano → Notifiche", 6000);
      return false;
    }
    localStorage.setItem(LS_KEYS.notifiche, "1");
    localStorage.setItem(LS_KEYS.pushOk, "1");
    aggiornaIconaCampanella();
    mostraToast("Promemoria attivati");
    if (currentView === "impostazioni") render();
    try {
      const override = JSON.parse(localStorage.getItem(LS_KEYS.orari) || "null");
      await window.cloud.salvaPreferenzeNotifiche(UID, { notificheAttive: true, orariOverride: override || null, anticipoMinuti: anticipoMinutiEffettivo() });
    } catch (e) { console.warn("Preferenze dei promemoria non salvate:", e); }
    return true;
  }

  async function attivaNotifiche() {
    if (window.cloud.nativo) return attivaNotificheNative();
    if (!("Notification" in window) || (eIOS() && !eStandalone())) {
      if (eIOS()) apriGuidaIOS();
      else mostraToast("Questo browser non supporta le notifiche");
      return false;
    }
    let permesso = Notification.permission;
    if (permesso === "default") permesso = await Notification.requestPermission();
    if (permesso !== "granted") {
      mostraToast("Permesso non concesso");
      return false;
    }
    localStorage.setItem(LS_KEYS.notifiche, "1");
    pianificaNotificheOggi();
    aggiornaIconaCampanella();
    mostraToast("Promemoria attivati");
    if (currentView === "impostazioni") render();

    // Promemoria veri anche ad app chiusa (se il progetto è configurato per
    // il push): il fallimento qui non compromette i promemoria "locali"
    // appena attivati sopra, che restano comunque il piano B.
    try {
      await sincronizzaPreferenzeNotifichePush();
    } catch (e) {
      console.warn("Notifiche push non attivate su questo dispositivo:", e);
    }
    return true;
  }

  /** Registra il token del dispositivo e invia al server orari/anticipo correnti, per le notifiche ad app chiusa. */
  async function sincronizzaPreferenzeNotifichePush() {
    if (!window.cloud.pushSupportato) { localStorage.removeItem(LS_KEYS.pushOk); return; }
    let token = null;
    try {
      token = await window.cloud.registraTokenPush(UID);
    } catch (e) {
      localStorage.removeItem(LS_KEYS.pushOk);
      throw e;
    }
    if (token) localStorage.setItem(LS_KEYS.pushOk, "1");
    else localStorage.removeItem(LS_KEYS.pushOk);
    const override = JSON.parse(localStorage.getItem(LS_KEYS.orari) || "null");
    await window.cloud.salvaPreferenzeNotifiche(UID, {
      notificheAttive: true,
      orariOverride: override || null,
      anticipoMinuti: anticipoMinutiEffettivo(),
    });
  }

  function aggiornaIconaCampanella() {
    const btn = document.getElementById("btn-notifiche");
    if (btn) btn.classList.toggle("is-on", notificheAttive());
  }

  let timersProgrammati = [];
  function pianificaNotificheOggi() {
    timersProgrammati.forEach((t) => clearTimeout(t));
    timersProgrammati = [];
    if (window.cloud.nativo) return; // nell'app Android i promemoria arrivano solo come notifiche native

    const oggi = new Date();
    const { giorno } = window.weekLogic.menuDelGiorno(oggi, CONFIG, PIANO_ATTIVO);
    if (!giorno) return;
    const orari = orariEffettivi();
    const anticipo = anticipoMinutiEffettivo();

    MEAL_KEYS.forEach((key) => {
      const orario = orari[key];
      if (!orario) return;
      const [h, m] = orario.split(":").map(Number);
      const quando = new Date(oggi);
      quando.setHours(h, m, 0, 0);
      quando.setMinutes(quando.getMinutes() - anticipo);
      const attesa = quando.getTime() - Date.now();
      if (attesa <= 0) return;
      const id = setTimeout(() => {
        // pasto già segnato (fatto, in parte o saltato): niente promemoria
        if (PASTI_FATTI_OGGI && PASTI_FATTI_OGGI[key]) return;
        mostraNotifica(`${MEAL_META[key].label} tra ${anticipo} minuti`, giorno[key]);
      }, attesa);
      timersProgrammati.push(id);
    });
  }

  function mostraNotifica(titolo, corpo) {
    // Lo stesso tag usato dalla Cloud Function: se promemoria locale e push
    // arrivano insieme, il secondo sostituisce il primo invece di duplicarlo.
    const opts = { body: corpo, icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: "pasto-" + titolo };
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then((reg) => reg.showNotification(titolo, opts)).catch(() => {
        try { new Notification(titolo, opts); } catch (e) {}
      });
    } else {
      try { new Notification(titolo, opts); } catch (e) {}
    }
  }

  /** Vero se questo dispositivo riceve i promemoria direttamente dal server (push). */
  function pushAttivoSuDispositivo() {
    return localStorage.getItem(LS_KEYS.pushOk) === "1";
  }

  function mostraPromemoriaPerso() {
    // Con il push attivo il promemoria è già arrivato dal server: riproporlo
    // alla riapertura dell'app sarebbe un doppione.
    if (pushAttivoSuDispositivo()) return;
    const oggiStr = new Date().toDateString();
    const ultimo = JSON.parse(localStorage.getItem(LS_KEYS.ultimoCheck) || "{}");
    if (ultimo.giorno !== oggiStr) {
      localStorage.setItem(LS_KEYS.ultimoCheck, JSON.stringify({ giorno: oggiStr, mostrati: [] }));
    }
    const stato = JSON.parse(localStorage.getItem(LS_KEYS.ultimoCheck) || '{"mostrati":[]}');
    const mostrati = new Set(stato.mostrati || []);

    const oggi = new Date();
    const { giorno } = window.weekLogic.menuDelGiorno(oggi, CONFIG, PIANO_ATTIVO);
    if (!giorno) return;
    const orari = orariEffettivi();
    const GRAZIA_MIN = 90;

    MEAL_KEYS.forEach((key) => {
      if (mostrati.has(key)) return;
      const [h, m] = (orari[key] || "").split(":").map(Number);
      if (Number.isNaN(h)) return;
      const orarioPasto = new Date(oggi);
      orarioPasto.setHours(h, m, 0, 0);
      const minutiTrascorsi = (Date.now() - orarioPasto.getTime()) / 60000;
      if (minutiTrascorsi >= 0 && minutiTrascorsi <= GRAZIA_MIN) {
        mostraNotifica(MEAL_META[key].label, giorno[key]);
        mostrati.add(key);
      }
    });
    localStorage.setItem(LS_KEYS.ultimoCheck, JSON.stringify({ giorno: oggiStr, mostrati: Array.from(mostrati) }));
  }

  // ---------------------------------------------------------------------
  // iPhone / iPad: rilevamento e guida all'installazione
  // ---------------------------------------------------------------------
  function eIOS() {
    // Gli iPad recenti si presentano come "Mac": li riconosciamo dal touch.
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function eStandalone() {
    return window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }

  /** Le notifiche web su iPhone esistono da iOS 16.4 in poi. */
  function iosSupportaPush() {
    const m = navigator.userAgent.match(/OS (\d+)_(\d+)/);
    if (!m) return true; // versione non leggibile (es. iPad in modalità desktop): proviamo comunque
    const maggiore = Number(m[1]), minore = Number(m[2]);
    return maggiore > 16 || (maggiore === 16 && minore >= 4);
  }

  /** Vero su iPhone/iPad quando l'app è aperta da Safari invece che dall'icona sulla Home. */
  function serveGuidaIOS() {
    return eIOS() && !eStandalone();
  }

  // ---------------------------------------------------------------------
  // Passaggio al nuovo indirizzo app.ilmiopiano.it
  // ---------------------------------------------------------------------
  // Per il browser il nuovo indirizzo è un'app diversa: le notifiche vanno
  // riattivate. Al PRIMO accesso di un paziente dal nuovo indirizzo si
  // scollegano i dispositivi registrati dal vecchio (altrimenti, dopo la
  // riattivazione, arriverebbero promemoria doppi) e si mostra un invito a
  // riattivare i promemoria. I dispositivi che si registrano dopo non
  // vengono più toccati.
  const DOMINIO_APP = "app.ilmiopiano.it";

  // Una volta per sessione, se su questo telefono i promemoria sono attivi:
  // il server conferma il telefono su questo account e lo toglie da ogni altro
  // account (es. un paziente di prova usato prima sullo stesso telefono).
  let dispositivoRinnovato = false;
  function rinnovaDispositivoNotifiche(u) {
    if (dispositivoRinnovato || !u || !u.notificheAttive || !notificheAttive()) return;
    if (window.cloud.nativo) {
      // App Android: rinnova il token senza chiedere di nuovo il permesso
      dispositivoRinnovato = true;
      window.cloud.registraTokenPush(UID, { chiediPermesso: false }).catch((e) => console.warn("Rinnovo del dispositivo per i promemoria non riuscito:", e));
      return;
    }
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (u.dominioNotifiche !== location.hostname) return; // prima la migrazione al nuovo indirizzo
    dispositivoRinnovato = true;
    window.cloud.registraTokenPush(UID).catch((e) => console.warn("Rinnovo del dispositivo per i promemoria non riuscito:", e));
  }

  function migraDominioSeServe(u) {
    if (location.hostname !== DOMINIO_APP || !u || u.dominioNotifiche === DOMINIO_APP) return;
    const avevaNotifiche = !!u.notificheAttive || (Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0);
    window.cloud.azzeraDispositiviNotifiche(UID, DOMINIO_APP).then(() => {
      if (avevaNotifiche) {
        localStorage.setItem(LS_KEYS.invitoRiattivaNotifiche, "1");
        if (currentView === "oggi") render();
      }
    }).catch((e) => console.warn("Migrazione notifiche al nuovo indirizzo non riuscita:", e));
  }

  function renderBannerRiattivaHTML() {
    if (localStorage.getItem(LS_KEYS.invitoRiattivaNotifiche) !== "1") return "";
    if (notificheAttive()) { localStorage.removeItem(LS_KEYS.invitoRiattivaNotifiche); return ""; }
    return `
      <div class="banner-ios" id="banner-riattiva">
        <div class="banner-ios__testo">
          <strong>L'app ha un nuovo indirizzo</strong>
          <span>Riattiva i promemoria dei pasti su questo dispositivo.</span>
        </div>
        <button type="button" class="banner-ios__azione" id="btn-riattiva-notifiche">Riattiva</button>
        <button type="button" class="banner-ios__chiudi" id="btn-chiudi-riattiva" aria-label="Nascondi">×</button>
      </div>`;
  }

  function collegaBannerRiattiva() {
    const btn = document.getElementById("btn-riattiva-notifiche");
    if (btn) btn.addEventListener("click", async () => {
      const ok = await attivaNotifiche();
      if (ok) { localStorage.removeItem(LS_KEYS.invitoRiattivaNotifiche); render(); }
    });
    const chiudi = document.getElementById("btn-chiudi-riattiva");
    if (chiudi) chiudi.addEventListener("click", () => {
      localStorage.removeItem(LS_KEYS.invitoRiattivaNotifiche);
      const b = document.getElementById("banner-riattiva");
      if (b) b.remove();
    });
  }

  function renderBannerIosHTML() {
    if (!serveGuidaIOS() || localStorage.getItem(LS_KEYS.bannerIosChiuso) === "1") return "";
    return `
      <div class="banner-ios" id="banner-ios">
        <div class="banner-ios__testo">
          <strong>Installa l'app sull'iPhone</strong>
          <span>Così ricevi i promemoria dei pasti anche ad app chiusa.</span>
        </div>
        <button type="button" class="banner-ios__azione" data-apri-guida-ios>Come fare</button>
        <button type="button" class="banner-ios__chiudi" id="btn-chiudi-banner-ios" aria-label="Nascondi">×</button>
      </div>`;
  }

  function collegaBannerIos() {
    root.querySelectorAll("[data-apri-guida-ios]").forEach((b) => b.addEventListener("click", apriGuidaIOS));
    const chiudi = document.getElementById("btn-chiudi-banner-ios");
    if (chiudi) chiudi.addEventListener("click", () => {
      localStorage.setItem(LS_KEYS.bannerIosChiuso, "1");
      const b = document.getElementById("banner-ios");
      if (b) b.remove();
    });
  }

  function apriGuidaIOS() {
    const iconaCondividi = `<svg class="guida-ios__icona" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>`;
    const versioneVecchia = !iosSupportaPush();
    apriSheet(`
      <h2 class="sheet__titolo">Promemoria su iPhone</h2>
      ${versioneVecchia ? `
        <p class="sheet__nota sheet__nota--attenzione">Questo iPhone ha una versione di iOS precedente alla 16.4, che non supporta le notifiche delle app web. Aggiornalo da Impostazioni → Generali → Aggiornamento software, poi segui i passaggi qui sotto.</p>` : ""}
      <ol class="guida-ios">
        <li>Apri questa pagina in <strong>Safari</strong>.</li>
        <li>Tocca <strong>Condividi</strong> ${iconaCondividi} nella barra in basso (o in alto su iPad).</li>
        <li>Scorri e scegli <strong>Aggiungi alla schermata Home</strong>, poi <strong>Aggiungi</strong>.</li>
        <li>Chiudi Safari e apri <strong>Il mio Piano</strong> dall'icona sulla Home. Ti verrà chiesto di accedere di nuovo: è normale, l'app installata è separata da Safari.</li>
        <li>Vai su <strong>Impostazioni</strong>, attiva <strong>Promemoria pasti</strong> e tocca <strong>Consenti</strong>.</li>
      </ol>
      <button type="button" class="btn" data-chiudi-sheet>Ho capito</button>
    `);
  }

  // ---------------------------------------------------------------------
  // Pannello a scomparsa dal basso ("sheet"), riutilizzabile
  // ---------------------------------------------------------------------
  function apriSheet(html) {
    chiudiSheet();
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.id = "sheet-overlay";
    overlay.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.closest("[data-chiudi-sheet]")) chiudiSheet();
    });
    document.body.appendChild(overlay);
    const primo = overlay.querySelector("a, button");
    if (primo) primo.focus({ preventScroll: true });
    return overlay;
  }

  function chiudiSheet() {
    const o = document.getElementById("sheet-overlay");
    if (o) o.remove();
  }

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") chiudiSheet(); });

  // ---------------------------------------------------------------------
  // Contatto del nutrizionista (lato paziente)
  // ---------------------------------------------------------------------
  /**
   * Trasforma un numero scritto in qualunque modo ("+39 333 123 4567",
   * "0039 333...", "333 1234567") nel formato richiesto da WhatsApp: solo
   * cifre, con prefisso internazionale. Senza prefisso si assume l'Italia.
   */
  function numeroPerWhatsApp(numero) {
    let cifre = String(numero || "").trim();
    const internazionale = cifre.startsWith("+") || cifre.startsWith("00");
    cifre = cifre.replace(/\D/g, "");
    if (cifre.startsWith("00")) cifre = cifre.slice(2);
    if (!internazionale && !cifre.startsWith("39")) cifre = "39" + cifre;
    return cifre.length >= 8 ? cifre : "";
  }

  function numeroPerChiamata(numero) {
    const s = String(numero || "").trim();
    return s.replace(/(?!^\+)[^\d]/g, "");
  }

  /** Dati di contatto del nutrizionista visti dal paziente (dal piano, con ripiego sul vecchio campo di testo). */
  function contattiNutrizionistaCorrenti() {
    const c = (PIANO_ATTIVO && PIANO_ATTIVO.contattiNutrizionista) || {};
    const nomeVecchio = (PIANO_ATTIVO && PIANO_ATTIVO.paziente && PIANO_ATTIVO.paziente.nutrizionista) || "";
    return {
      nome: c.nome || nomeVecchio,
      qualifica: c.qualifica || "",
      studio: c.studio || "",
      note: c.note || "",
      email: c.email || "",
      telefono: c.telefono || "",
      whatsapp: c.whatsapp !== false && !!c.telefono,
    };
  }

  function renderContattoNutrizionistaHTML() {
    if (!PIANO_ATTIVO) return "";
    const c = contattiNutrizionistaCorrenti();
    if (!c.nome && !c.email && !c.telefono) return "";
    const haCanali = !!(c.email || c.telefono);
    const iniziali = (c.nome || "?").replace(/^(dott\.?ssa|dott\.?|dr\.?)\s+/i, "").split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join("");
    return `
      <section class="contatto-nutri">
        <div class="contatto-nutri__testa">
          <span class="contatto-nutri__avatar" aria-hidden="true">${escapeHTML(iniziali)}</span>
          <div>
            <span class="contatto-nutri__etichetta">Il tuo nutrizionista</span>
            <strong class="contatto-nutri__nome">${escapeHTML(c.nome || "—")}</strong>
            ${c.qualifica ? `<span class="contatto-nutri__qualifica">${escapeHTML(c.qualifica)}</span>` : ""}
          </div>
        </div>
        ${c.studio ? `<p class="contatto-nutri__riga">${escapeHTML(c.studio)}</p>` : ""}
        ${c.note ? `<p class="contatto-nutri__riga contatto-nutri__riga--nota">${escapeHTML(c.note)}</p>` : ""}
        ${haCanali ? `<button type="button" class="btn" data-contatta-nutrizionista>Contatta</button>` : ""}
      </section>`;
  }

  function collegaContattoNutrizionista() {
    root.querySelectorAll("[data-contatta-nutrizionista]").forEach((b) => b.addEventListener("click", apriSceltaContatto));
  }

  function apriSceltaContatto() {
    const c = contattiNutrizionistaCorrenti();
    const nomePaziente = (PIANO_ATTIVO && PIANO_ATTIVO.paziente && PIANO_ATTIVO.paziente.nome) || "";
    const saluto = `Buongiorno${c.nome ? " " + c.nome : ""}, sono ${nomePaziente || "un suo paziente"}. Le scrivo dall'app Il mio Piano: `;
    const azioni = [];

    if (c.telefono && c.whatsapp) {
      const n = numeroPerWhatsApp(c.telefono);
      if (n) azioni.push(`<a class="azione-contatto azione-contatto--whatsapp" href="https://wa.me/${n}?text=${encodeURIComponent(saluto)}" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.1.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .1-1.2c0-.1-.2-.2-.4-.3Z"/></svg>
        <span><strong>WhatsApp</strong><small>${escapeHTML(c.telefono)}</small></span></a>`);
    }
    if (c.email) {
      const oggetto = "Domanda sul mio piano nutrizionale";
      azioni.push(`<a class="azione-contatto" href="mailto:${encodeURIComponent(c.email).replace(/%40/g, "@")}?subject=${encodeURIComponent(oggetto)}&body=${encodeURIComponent(saluto)}">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>
        <span><strong>Email</strong><small>${escapeHTML(c.email)}</small></span></a>`);
    }
    if (c.telefono) {
      azioni.push(`<a class="azione-contatto" href="tel:${escapeHTML(numeroPerChiamata(c.telefono))}">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/></svg>
        <span><strong>Chiama</strong><small>${escapeHTML(c.telefono)}</small></span></a>`);
    }

    apriSheet(`
      <h2 class="sheet__titolo">Contatta ${escapeHTML(c.nome || "il tuo nutrizionista")}</h2>
      <div class="azioni-contatto">${azioni.join("")}</div>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
    `);
  }

  // ---------------------------------------------------------------------
  // Vista "Ricette" (lato paziente)
  // ---------------------------------------------------------------------
  // Ricette pubblicate dal professionista (per tutti i suoi pazienti o solo
  // per alcuni), lette in tempo reale. Dalla ricetta il paziente può
  // stampare/salvare in PDF, aprire l'allegato e mandare gli ingredienti
  // nella lista della spesa.
  const LS_RICETTE_VISTE = "pnut:ricette-viste-fino-a";
  const RIC = {
    elenco: [], unsub: null, profUid: null, pronte: false,
    aperta: null, filtroTesto: "", filtroEtichetta: "",
    vistePrima: Number(localStorage.getItem(LS_RICETTE_VISTE) || 0),
  };

  function scollegaRicette() {
    if (RIC.unsub) { RIC.unsub(); RIC.unsub = null; }
    RIC.elenco = []; RIC.profUid = null; RIC.pronte = false; RIC.aperta = null;
    RIC.filtroTesto = ""; RIC.filtroEtichetta = "";
  }

  function millisDi(t) {
    const d = dataDaTimestamp(t);
    return d ? d.getTime() : 0;
  }

  /** Avvia l'ascolto delle ricette appena si conosce il professionista del paziente. */
  function collegaRicettePaziente() {
    const prof = PIANO_ATTIVO && PIANO_ATTIVO.professionistaUid;
    if (!prof || RIC.profUid === prof) return;
    if (RIC.unsub) RIC.unsub();
    RIC.profUid = prof;
    RIC.unsub = window.cloud.ascoltaRicettePaziente(prof, UID, (lista) => {
      RIC.elenco = lista.sort((a, b) => millisDi(b.creato || b.aggiornato) - millisDi(a.creato || a.aggiornato));
      RIC.pronte = true;
      aggiornaPallinoRicette();
      if (currentView === "ricette") renderRicette();
    });
  }

  function ricettaNuova(r) {
    return millisDi(r.creato || r.aggiornato) > RIC.vistePrima;
  }

  function aggiornaPallinoRicette() {
    const tab = document.querySelector('.tabbar__btn[data-view="ricette"]');
    if (tab) tab.classList.toggle("ha-novita", currentView !== "ricette" && RIC.elenco.some(ricettaNuova));
  }

  function metaRicettaHTML(r) {
    const pezzi = [];
    if (r.tempoMin) pezzi.push(`⏱ ${r.tempoMin} min`);
    if (r.porzioni) pezzi.push(`🍽 ${r.porzioni} ${Number(r.porzioni) === 1 ? "porzione" : "porzioni"}`);
    if (r.kcal) pezzi.push(`${r.kcal} kcal a porzione`);
    return pezzi.map((p) => `<span class="pill">${escapeHTML(p)}</span>`).join("");
  }

  function renderRicette() {
    aggiornaPallinoRicette();
    if (RIC.aperta) {
      const r = RIC.elenco.find((x) => x.id === RIC.aperta);
      if (r) { renderRicettaPaziente(r); return; }
      RIC.aperta = null;
    }
    // Dalla prossima apertura dell'app, queste ricette non sono più "nuove".
    localStorage.setItem(LS_RICETTE_VISTE, String(Date.now()));

    if (!PIANO_ATTIVO || !PIANO_ATTIVO.professionistaUid) {
      root.innerHTML = `<section class="benvenuto-autonomo">
        <h2>Le ricette del tuo nutrizionista</h2>
        <p>Qui compaiono le ricette che il tuo nutrizionista prepara per te, con ingredienti e procedimento.</p>
        <p class="hint">Se il tuo nutrizionista usa Il mio Piano, chiedigli il suo codice studio: quando ti colleghi, le sue ricette arrivano qui.</p>
        ${AUTONOMO ? `<button type="button" class="btn btn--ghost" id="btn-ricette-codice">Inserisci il codice studio</button>` : ""}
      </section>`;
      const vai = document.getElementById("btn-ricette-codice");
      if (vai) vai.addEventListener("click", () => {
        attivaTab("impostazioni"); render();
        setTimeout(() => { const el = document.getElementById("sezione-nutrizionista"); if (el) el.scrollIntoView({ behavior: "smooth" }); }, 50);
      });
      return;
    }
    if (!RIC.pronte) {
      root.innerHTML = `<div class="empty">Caricamento delle ricette…</div>`;
      return;
    }
    const etichette = Array.from(new Set(RIC.elenco.flatMap((r) => r.etichette || []))).sort((a, b) => a.localeCompare(b, "it"));
    const testo = RIC.filtroTesto.trim().toLowerCase();
    const filtrate = RIC.elenco.filter((r) => {
      if (RIC.filtroEtichetta && !(r.etichette || []).includes(RIC.filtroEtichetta)) return false;
      if (!testo) return true;
      return [r.titolo, (r.ingredienti || []).join(" "), (r.etichette || []).join(" ")].join(" ").toLowerCase().includes(testo);
    });

    root.innerHTML = `
      <section class="hero" style="border-bottom:none; margin-bottom:8px; padding-bottom:6px;">
        <div class="hero__eyebrow"><span class="dot"></span> Ricette dal tuo nutrizionista</div>
      </section>
      ${RIC.elenco.length === 0 ? `<div class="empty">Qui troverai le ricette che il tuo nutrizionista preparerà per te.</div>` : `
        <input type="search" id="cerca-ricette" class="ricette-cerca" placeholder="Cerca per nome o ingrediente" value="${escapeHTML(RIC.filtroTesto)}" aria-label="Cerca ricette">
        ${etichette.length ? `<div class="ricette-filtri" role="group" aria-label="Filtra per etichetta">
          <button type="button" class="chip-filtro" data-etichetta="" aria-pressed="${!RIC.filtroEtichetta}">Tutte</button>
          ${etichette.map((e) => `<button type="button" class="chip-filtro" data-etichetta="${escapeHTML(e)}" aria-pressed="${RIC.filtroEtichetta === e}">${escapeHTML(e)}</button>`).join("")}
        </div>` : ""}
        <div class="ricette-griglia">
          ${filtrate.length ? filtrate.map((r) => `
            <button type="button" class="ricetta-card" data-ricetta="${r.id}">
              <span class="ricetta-card__foto ${r.foto && r.foto.auto ? "is-pagina" : ""}" ${r.foto && r.foto.url ? `style="background-image:url('${escapeHTML(r.foto.url)}')"` : ""}>${r.foto && r.foto.url ? "" : `<span aria-hidden="true">${r.allegato ? "📄" : "🍲"}</span>`}</span>
              <span class="ricetta-card__corpo">
                ${ricettaNuova(r) ? `<span class="ricetta-card__nuova">Nuova</span>` : ""}
                <span class="ricetta-card__titolo">${escapeHTML(r.titolo || "Ricetta")}</span>
                <span class="ricetta-card__meta">${[r.tempoMin ? r.tempoMin + " min" : "", r.kcal ? r.kcal + " kcal" : "", (r.etichette || []).slice(0, 2).join(", ")].filter(Boolean).map(escapeHTML).join(" · ")}</span>
              </span>
            </button>`).join("") : `<div class="empty">Nessuna ricetta corrisponde alla ricerca.</div>`}
        </div>
      `}
    `;

    const cerca = document.getElementById("cerca-ricette");
    if (cerca) cerca.addEventListener("input", () => {
      RIC.filtroTesto = cerca.value;
      const pos = cerca.selectionStart;
      renderRicette();
      const nuovo = document.getElementById("cerca-ricette");
      nuovo.focus(); nuovo.setSelectionRange(pos, pos);
    });
    root.querySelectorAll("[data-etichetta]").forEach((b) => b.addEventListener("click", () => {
      RIC.filtroEtichetta = b.dataset.etichetta; renderRicette();
    }));
    root.querySelectorAll("[data-ricetta]").forEach((b) => b.addEventListener("click", () => {
      RIC.aperta = b.dataset.ricetta; renderRicette(); window.scrollTo(0, 0);
    }));
  }

  /** Contenuto della ricetta (usato sia a schermo sia per la stampa). */
  function corpoRicettaHTML(r, perStampa) {
    const macro = [["Proteine", r.proteine], ["Carboidrati", r.carboidrati], ["Grassi", r.grassi]].filter((m) => m[1] != null && m[1] !== "");
    return `
      ${r.foto && r.foto.url && !(perStampa && r.foto.auto) ? `<img class="ricetta__foto ${r.foto.auto ? "ricetta__foto--pagina" : ""}" src="${escapeHTML(r.foto.url)}" alt="${r.foto.auto ? "Anteprima della prima pagina della ricetta" : ""}">` : ""}
      <h2 class="ricetta__titolo">${escapeHTML(r.titolo || "Ricetta")}</h2>
      <div class="ricetta__meta">${metaRicettaHTML(r)}</div>
      ${macro.length ? `<p class="ricetta__macro">A porzione: ${macro.map((m) => `${m[0].toLowerCase()} ${escapeHTML(m[1])} g`).join(", ")}</p>` : ""}
      ${(r.etichette || []).length && !perStampa ? `<p class="ricetta__etichette">${r.etichette.map((e) => `<span>${escapeHTML(e)}</span>`).join("")}</p>` : ""}
      ${(r.ingredienti || []).length ? `
        <h3 class="ricetta__sezione">Ingredienti</h3>
        <ul class="ricetta__ingredienti">${r.ingredienti.map((i) => `<li>${escapeHTML(i)}</li>`).join("")}</ul>` : ""}
      ${(r.procedimento || []).length ? `
        <h3 class="ricetta__sezione">Procedimento</h3>
        <ol class="ricetta__passi">${r.procedimento.map((p) => `<li>${escapeHTML(p)}</li>`).join("")}</ol>` : ""}
      ${r.note ? `<h3 class="ricetta__sezione">Note</h3><p class="ricetta__note">${escapeHTML(r.note)}</p>` : ""}
    `;
  }

  function renderRicettaPaziente(r) {
    const haContenuto = (r.ingredienti || []).length || (r.procedimento || []).length;
    root.innerHTML = `
      <button type="button" class="link-btn link-btn--sinistra" id="btn-torna-ricette">← Tutte le ricette</button>
      <article class="ricetta">${corpoRicettaHTML(r, false)}</article>
      <div class="ricetta__azioni">
        ${r.allegato && r.allegato.url ? `<a class="btn" href="${escapeHTML(r.allegato.url)}" target="_blank" rel="noopener">${haContenuto ? (r.allegato.tipo === "application/pdf" ? "Apri la scheda in PDF" : "Apri la scheda della ricetta") : "Apri la ricetta"}</a>` : ""}
        ${(r.ingredienti || []).length ? `<button type="button" class="btn ${r.allegato ? "btn--ghost" : ""}" id="btn-ricetta-spesa">Aggiungi gli ingredienti alla spesa</button>` : ""}
        ${haContenuto ? `<button type="button" class="btn btn--ghost" id="btn-ricetta-stampa">Stampa o salva in PDF</button>` : ""}
      </div>
    `;
    document.getElementById("btn-torna-ricette").addEventListener("click", () => { RIC.aperta = null; renderRicette(); });
    const spesa = document.getElementById("btn-ricetta-spesa");
    if (spesa) spesa.addEventListener("click", () => apriAggiuntaSpesa(r));
    const stampa = document.getElementById("btn-ricetta-stampa");
    if (stampa) stampa.addEventListener("click", () => stampaRicetta(r));
  }

  function apriAggiuntaSpesa(r) {
    const settimane = settimaneSpesa().slice(0, 2);
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">Aggiungi alla spesa</h2>
      <p class="sheet__nota">Gli ingredienti di "${escapeHTML(r.titolo || "questa ricetta")}" finiscono nella lista della settimana che scegli. Quelli che ci sono già non vengono ripetuti.</p>
      ${settimane.map((s) => `<button type="button" class="btn ${s.k === 0 ? "" : "btn--ghost"}" data-sett="${s.k}">${s.k === 0 ? "Questa settimana" : "Prossima settimana"} (${escapeHTML(s.intervallo)})</button>`).join("")}
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
    `);
    overlay.querySelectorAll("[data-sett]").forEach((b) => b.addEventListener("click", async () => {
      const s = settimane[Number(b.dataset.sett)];
      const testi = (r.ingredienti || []).map((t) => t.trim().slice(0, 80)).filter(Boolean);
      chiudiSheet();
      try {
        await window.cloud.aggiungiArticoliSpesa(destinazioneSpesa(), s.docId, testi);
        mostraToast(`Ingredienti aggiunti alla spesa di ${s.k === 0 ? "questa settimana" : "la prossima settimana"}`);
      } catch (e) {
        mostraToast("Non aggiunti: controlla la connessione");
      }
    }));
  }

  function stampaRicetta(r) {
    let area = document.getElementById("area-stampa");
    if (!area) {
      area = document.createElement("div");
      area.id = "area-stampa";
      document.body.appendChild(area);
    }
    const autore = (r.autoreNome || (PIANO_ATTIVO && PIANO_ATTIVO.paziente && PIANO_ATTIVO.paziente.nutrizionista) || "").trim();
    area.innerHTML = `<article class="ricetta ricetta--stampa">${corpoRicettaHTML(r, true)}
      <p class="ricetta__piede">${autore ? `Ricetta di ${escapeHTML(autore)} · ` : ""}Il mio Piano</p></article>`;
    const img = area.querySelector("img");
    const vai = () => window.print();
    if (img && !img.complete) { img.onload = vai; img.onerror = vai; } else vai();
  }

  // ---------------------------------------------------------------------
  // Appuntamenti (parti comuni a paziente e professionista)
  // ---------------------------------------------------------------------
  // L'appuntamento fissato sta nel piano: { data "YYYY-MM-DD", ora "HH:MM",
  // durataMin, modalita "studio" | "online", luogo (indirizzo o link), note }.
  const GIORNI_RICHIESTA = [["lun", "Lunedì"], ["mar", "Martedì"], ["mer", "Mercoledì"], ["gio", "Giovedì"], ["ven", "Venerdì"], ["sab", "Sabato"]];
  const FASCE_RICHIESTA = [["mattina", "Mattina"], ["pomeriggio", "Pomeriggio"], ["sera", "Sera"]];
  const MODALITA_APPUNTAMENTO = { studio: "In studio", online: "Online", indifferente: "Indifferente" };

  function appuntamentoDi(piano) {
    const a = piano && piano.appuntamento;
    return a && /^\d{4}-\d{2}-\d{2}$/.test(a.data || "") ? a : null;
  }

  function giorniAppuntamento(a) {
    return window.statistiche.differenzaGiorni(window.statistiche.daChiave(a.data), new Date());
  }

  function appuntamentoFuturo(piano) {
    const a = appuntamentoDi(piano);
    return a && giorniAppuntamento(a) >= 0 ? a : null;
  }

  function testoQuandoAppuntamento(a) {
    const d = window.statistiche.daChiave(a.data);
    const giorno = d.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    return giorno.charAt(0).toUpperCase() + giorno.slice(1) + (a.ora ? ` alle ${a.ora}` : "");
  }

  function testoRelativoAppuntamento(a) {
    const n = giorniAppuntamento(a);
    return n === 0 ? "oggi" : n === 1 ? "domani" : n > 1 ? `tra ${n} giorni` : `${-n} giorni fa`;
  }

  function eLink(testo) {
    return /^https?:\/\/\S+$/i.test(String(testo || "").trim());
  }

  function luogoAppuntamentoHTML(a) {
    if (!a.luogo) return "";
    const l = a.luogo.trim();
    return eLink(l)
      ? `<a href="${escapeHTML(l)}" target="_blank" rel="noopener" class="link-inline">Collegati alla visita online ↗</a>`
      : escapeHTML(l);
  }

  function orariAppuntamento(a) {
    const [h, m] = (a.ora || "09:00").split(":").map(Number);
    const inizio = window.statistiche.daChiave(a.data);
    inizio.setHours(h || 0, m || 0, 0, 0);
    const fine = new Date(inizio.getTime() + (Number(a.durataMin) || 60) * 60000);
    const fmt = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}00`;
    return { inizio: fmt(inizio), fine: fmt(fine) };
  }

  function titoloAppuntamento(nutrizionista) {
    return nutrizionista ? `Visita con ${nutrizionista}` : "Visita dal nutrizionista";
  }

  function linkGoogleCalendar(a, titolo) {
    const o = orariAppuntamento(a);
    const par = new URLSearchParams({
      action: "TEMPLATE", text: titolo, dates: `${o.inizio}/${o.fine}`, ctz: "Europe/Rome",
      details: [MODALITA_APPUNTAMENTO[a.modalita] || "", a.note || ""].filter(Boolean).join("\n"),
      location: a.luogo || "",
    });
    return "https://calendar.google.com/calendar/render?" + par.toString();
  }

  function scaricaIcsAppuntamento(a, titolo) {
    const o = orariAppuntamento(a);
    const esc = (t) => String(t || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
    const adesso = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const righe = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Il mio Piano//IT", "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      `UID:${a.data}-${(a.ora || "").replace(":", "")}-${Math.random().toString(36).slice(2)}@ilmiopiano.it`,
      `DTSTAMP:${adesso}`, `DTSTART:${o.inizio}`, `DTEND:${o.fine}`,
      `SUMMARY:${esc(titolo)}`,
      a.luogo ? `LOCATION:${esc(a.luogo)}` : "",
      `DESCRIPTION:${esc([MODALITA_APPUNTAMENTO[a.modalita] || "", a.note || ""].filter(Boolean).join("\n"))}`,
      "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY", `DESCRIPTION:${esc(titolo)}`, "END:VALARM",
      "END:VEVENT", "END:VCALENDAR",
    ].filter(Boolean);
    const blob = new Blob([righe.join("\r\n")], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "appuntamento.ics";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function preferenzeRichiestaTesto(r) {
    const giorni = (r.giorni || []).map((g) => (GIORNI_RICHIESTA.find((x) => x[0] === g) || [0, g])[1]).join(", ");
    const fasce = (r.fasce || []).map((f) => (FASCE_RICHIESTA.find((x) => x[0] === f) || [0, f])[1].toLowerCase()).join(", ");
    const parti = [];
    if (giorni) parti.push(giorni);
    if (fasce) parti.push(fasce);
    if (r.modalita && r.modalita !== "indifferente") parti.push(MODALITA_APPUNTAMENTO[r.modalita].toLowerCase());
    return parti.join(" · ") || "Nessuna preferenza indicata";
  }

  // ---------------------------------------------------------------------
  // Appuntamenti (lato paziente)
  // ---------------------------------------------------------------------
  const APP_PAZ = { richieste: [], unsub: null };

  function collegaRichiestePaziente() {
    if (APP_PAZ.unsub) return;
    APP_PAZ.unsub = window.cloud.ascoltaRichiestePaziente(UID, (lista) => {
      APP_PAZ.richieste = lista;
      if (currentView === "impostazioni") render();
    });
  }

  function scollegaRichiestePaziente() {
    if (APP_PAZ.unsub) { APP_PAZ.unsub(); APP_PAZ.unsub = null; }
    APP_PAZ.richieste = [];
  }

  function nomeNutrizionista() {
    const c = (PIANO_ATTIVO && PIANO_ATTIVO.contattiNutrizionista) || {};
    return c.nome || (PIANO_ATTIVO && PIANO_ATTIVO.paziente && PIANO_ATTIVO.paziente.nutrizionista) || "";
  }

  function appuntamentoPazienteHTML() {
    if (!PIANO_ATTIVO) return "";
    const a = appuntamentoFuturo(PIANO_ATTIVO);
    const richiesta = APP_PAZ.richieste[0] || null;
    const puoRichiedere = !!PIANO_ATTIVO.professionistaUid;
    const quandoRichiesta = richiesta && dataDaTimestamp(richiesta.creata);
    return `
      <div class="appuntamento ${a ? "has-data" : ""}">
        <p class="appuntamento__eyebrow">📅 ${a ? "Il tuo prossimo appuntamento" : "Appuntamenti"}</p>
        ${a ? `
          <p class="appuntamento__quando">${escapeHTML(testoQuandoAppuntamento(a))}</p>
          <p class="appuntamento__dettaglio"><span class="pill">${escapeHTML(testoRelativoAppuntamento(a))}</span> ${escapeHTML(MODALITA_APPUNTAMENTO[a.modalita] || "")}${a.durataMin ? ` · ${a.durataMin} minuti` : ""}</p>
          ${a.luogo ? `<p class="appuntamento__dettaglio">${luogoAppuntamentoHTML(a)}</p>` : ""}
          ${a.note ? `<p class="appuntamento__note">${escapeHTML(a.note)}</p>` : ""}
          <button type="button" class="btn btn--ghost" id="btn-app-calendario">Aggiungi al calendario</button>
        ` : `<p class="appuntamento__dettaglio">Nessun appuntamento in programma.</p>`}
        ${richiesta ? `
          <p class="appuntamento__richiesta">Richiesta inviata${quandoRichiesta ? ` il ${quandoRichiesta.toLocaleDateString("it-IT", { day: "numeric", month: "long" })}` : ""}: in attesa di conferma dal tuo nutrizionista.</p>
          <button type="button" class="link-btn" id="btn-app-ritira">Ritira la richiesta</button>
        ` : puoRichiedere ? `<button type="button" class="btn ${a ? "btn--ghost" : ""}" id="btn-app-richiedi">${a ? "Chiedi di spostarlo o un altro appuntamento" : "Richiedi un appuntamento"}</button>` : ""}
      </div>`;
  }

  function collegaAppuntamentoPaziente() {
    const a = appuntamentoFuturo(PIANO_ATTIVO);
    const cal = document.getElementById("btn-app-calendario");
    if (cal && a) cal.addEventListener("click", () => {
      const titolo = titoloAppuntamento(nomeNutrizionista());
      const overlay = apriSheet(`
        <h2 class="sheet__titolo">Aggiungi al calendario</h2>
        <p class="sheet__nota">${escapeHTML(testoQuandoAppuntamento(a))}</p>
        <button type="button" class="btn" id="cal-ics">Calendario del telefono (iPhone, Outlook)</button>
        <a class="btn btn--ghost" href="${escapeHTML(linkGoogleCalendar(a, titolo))}" target="_blank" rel="noopener" style="text-decoration:none;">Google Calendar</a>
        <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
      `);
      overlay.querySelector("#cal-ics").addEventListener("click", () => { scaricaIcsAppuntamento(a, titolo); chiudiSheet(); });
    });
    const rit = document.getElementById("btn-app-ritira");
    if (rit) rit.addEventListener("click", async () => {
      const r = APP_PAZ.richieste[0];
      if (!r) return;
      rit.disabled = true;
      try { await window.cloud.eliminaRichiestaAppuntamento(r.id); mostraToast("Richiesta ritirata"); }
      catch (e) { rit.disabled = false; mostraToast("Non riuscito: controlla la connessione"); }
    });
    const ric = document.getElementById("btn-app-richiedi");
    if (ric) ric.addEventListener("click", apriRichiestaAppuntamento);
  }

  function apriRichiestaAppuntamento() {
    const scelti = { giorni: new Set(), fasce: new Set(), modalita: "indifferente" };
    const chip = (tipo, [val, et]) => `<button type="button" class="chip-filtro" data-${tipo}="${val}" aria-pressed="false">${et}</button>`;
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">Richiedi un appuntamento</h2>
      <p class="sheet__nota">Indica quando ti farebbe comodo: il tuo nutrizionista ti proporrà data e ora. Tutto facoltativo.</p>
      <p class="stato-pasto__domanda">Giorni preferiti</p>
      <div class="ricette-filtri">${GIORNI_RICHIESTA.map((g) => chip("giorno", g)).join("")}</div>
      <p class="stato-pasto__domanda">Momento della giornata</p>
      <div class="ricette-filtri">${FASCE_RICHIESTA.map((f) => chip("fascia", f)).join("")}</div>
      <p class="stato-pasto__domanda">Modalità</p>
      <div class="ricette-filtri">${Object.entries(MODALITA_APPUNTAMENTO).map(([v, e]) => `<button type="button" class="chip-filtro" data-modalita="${v}" aria-pressed="${v === "indifferente"}">${e}</button>`).join("")}</div>
      <label class="editor-campo" style="margin-top:12px;">Messaggio
        <textarea id="richiesta-messaggio" rows="3" maxlength="1000" placeholder="Es. vorrei rivedere la cena del weekend"></textarea>
      </label>
      <button type="button" class="btn" id="richiesta-invia" style="margin-top:12px;">Invia la richiesta</button>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
    `);
    const toggle = (set, b, attr) => b.addEventListener("click", () => {
      const v = b.getAttribute(attr);
      if (set.has(v)) set.delete(v); else set.add(v);
      b.setAttribute("aria-pressed", String(set.has(v)));
    });
    overlay.querySelectorAll("[data-giorno]").forEach((b) => toggle(scelti.giorni, b, "data-giorno"));
    overlay.querySelectorAll("[data-fascia]").forEach((b) => toggle(scelti.fasce, b, "data-fascia"));
    overlay.querySelectorAll("[data-modalita]").forEach((b) => b.addEventListener("click", () => {
      scelti.modalita = b.dataset.modalita;
      overlay.querySelectorAll("[data-modalita]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    }));
    overlay.querySelector("#richiesta-invia").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await window.cloud.inviaRichiestaAppuntamento({
          pazienteUid: UID,
          professionistaUid: PIANO_ATTIVO.professionistaUid,
          pianoId: PIANO_ATTIVO.id,
          pazienteNome: (PIANO_ATTIVO.pazienteNome || (PIANO_ATTIVO.paziente && PIANO_ATTIVO.paziente.nome) || "").slice(0, 120),
          giorni: GIORNI_RICHIESTA.map((g) => g[0]).filter((g) => scelti.giorni.has(g)),
          fasce: FASCE_RICHIESTA.map((f) => f[0]).filter((f) => scelti.fasce.has(f)),
          modalita: scelti.modalita,
          messaggio: overlay.querySelector("#richiesta-messaggio").value.trim().slice(0, 1000),
        });
        chiudiSheet();
        mostraToast("Richiesta inviata al tuo nutrizionista", 3500);
      } catch (err) {
        btn.disabled = false;
        mostraToast("Richiesta non inviata: controlla la connessione");
      }
    });
  }

  /** Promemoria nella schermata Oggi quando l'appuntamento è oggi, domani o dopodomani. */
  function renderAvvisoAppuntamentoHTML() {
    const a = appuntamentoFuturo(PIANO_ATTIVO);
    if (!a || giorniAppuntamento(a) > 2) return "";
    return `
      <div class="banner-ios banner-appuntamento">
        <div class="banner-ios__testo">
          <strong>📅 Appuntamento ${escapeHTML(testoRelativoAppuntamento(a))}${a.ora ? ` alle ${escapeHTML(a.ora)}` : ""}</strong>
          <span>${escapeHTML(MODALITA_APPUNTAMENTO[a.modalita] || "")}${a.note ? ` · ${escapeHTML(a.note)}` : ""}</span>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Lista di casa (spesa condivisa con familiari o con un altro paziente)
  // ---------------------------------------------------------------------
  // Membri e inviti li gestisce il server (Cloud Functions). Ogni paziente
  // membro pubblica nella lista solo gli alimenti del suo piano (quantità e
  // giorni); spunte, articoli aggiunti e scelte sono di tutti.
  const LISTA = { id: null, dati: null, unsub: null, nomeUtente: "", inCorso: {} };

  function destinazioneSpesa() {
    return LISTA.id ? "lista:" + LISTA.id : UID;
  }

  function scollegaListaCasa() {
    if (LISTA.unsub) { LISTA.unsub(); LISTA.unsub = null; }
    LISTA.id = null; LISTA.dati = null;
  }

  function collegaListaCasa(listaId) {
    if (LISTA.unsub) { LISTA.unsub(); LISTA.unsub = null; }
    LISTA.id = listaId || null;
    LISTA.dati = null;
    if (!listaId) return;
    LISTA.unsub = window.cloud.ascoltaListaCasa(listaId, (dati) => {
      if (!dati || !(dati.membri || []).includes(UID)) {
        // Lista sciolta o membro rimosso: si torna alla lista personale
        const eraMembro = !!LISTA.dati;
        scollegaListaCasa();
        if (eraMembro) mostraToast("Non fai più parte della lista di casa", 3500);
      } else {
        LISTA.dati = dati;
        pubblicaPianoInLista();
      }
      if (currentView === "spesa") renderSpesa();
      if (currentView === "impostazioni") render();
    });
  }

  function nomeMembro(uid) {
    if (uid === UID) return "tu";
    return (LISTA.dati && LISTA.dati.nomiMembri && LISTA.dati.nomiMembri[uid]) || "un membro";
  }

  /** Pubblica gli alimenti del proprio piano nelle prossime settimane della lista (solo se cambiati). */
  function pubblicaPianoInLista() {
    if (!LISTA.id || !PIANO_ATTIVO || RUOLO !== "paziente") return;
    settimaneSpesa().forEach((s) => {
      const giorni = PIANO_ATTIVO.settimane[s.settimana];
      if (!giorni) return;
      const voci = JSON.parse(JSON.stringify(window.alimenti.listaDaSettimana(giorni, CAMPI_SPESA)));
      const impronta = window.alimenti.VERSIONE_MOTORE + ":" + JSON.stringify(voci);
      const chiave = `pnut:pubblicato:${LISTA.id}:${s.docId}`;
      // niente doppioni: né se è già pubblicato, né se la stessa pubblicazione è in corso
      if (localStorage.getItem(chiave) === impronta || LISTA.inCorso[chiave] === impronta) return;
      LISTA.inCorso[chiave] = impronta;
      window.cloud.pubblicaPianoInLista(LISTA.id, s.docId, UID, LISTA.nomeUtente || "Membro", voci, window.alimenti.VERSIONE_MOTORE)
        .then(() => localStorage.setItem(chiave, impronta))
        .catch((e) => console.warn("Pubblicazione nella lista di casa non riuscita:", e))
        .finally(() => { if (LISTA.inCorso[chiave] === impronta) delete LISTA.inCorso[chiave]; });
    });
  }

  function erroreLista(e) {
    const m = String((e && e.message) || "");
    if (m === "codice-non-valido") return "Codice non valido o scaduto: chiedine uno nuovo a chi ti ha invitato.";
    if (m === "gia-in-lista") return "Fai già parte di una lista di casa: esci da quella prima di entrare in un'altra.";
    if (m === "lista-piena") return "Questa lista ha già il numero massimo di membri (6).";
    if (e && /permission/.test(String(e.code))) return m || "Operazione non consentita.";
    return "Non riuscito: controlla la connessione e riprova.";
  }

  function linkInvito(codice) {
    return `${location.origin}${location.pathname.replace(/index\.html$/, "")}?invito=${codice}`;
  }

  /** Testo del consenso per i pazienti: cosa vedranno gli altri membri. */
  function consensoPazienteHTML() {
    if (RUOLO !== "paziente") return "";
    return `<label class="ric-scelta consenso-lista"><input type="checkbox" id="lista-consenso"> <span>Acconsento che gli altri membri della lista vedano gli alimenti del mio piano, con quantità e giorni (non vedranno il piano completo, gli orari né altri miei dati).</span></label>`;
  }

  function apriListaCasa() {
    if (!LISTA.id) { apriIngressoListaCasa(""); return; }
    const d = LISTA.dati || {};
    const proprietario = d.proprietario === UID;
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">👥 ${escapeHTML(d.nome || "Lista di casa")}</h2>
      <p class="sheet__nota">Una sola lista per tutti: spunte, articoli aggiunti e scelte si vedono in tempo reale su ogni telefono.${RUOLO === "paziente" ? " Gli alimenti del tuo piano compaiono sommati a quelli degli altri." : ""}</p>
      <ul class="spesa-lista" style="margin-bottom:12px;">
        ${(d.membri || []).map((uid) => `
          <li class="spesa-riga">
            <span class="spesa-riga__icona" aria-hidden="true">${uid === d.proprietario ? "⭐" : "👤"}</span>
            <span class="spesa-riga__nome" style="flex:1;">${escapeHTML(uid === UID ? `${LISTA.nomeUtente || "Tu"} (tu)` : nomeMembro(uid))}</span>
            ${proprietario && uid !== UID ? `<button type="button" class="link-btn" style="width:auto;padding:0 6px;" data-rimuovi-membro="${escapeHTML(uid)}">Togli</button>` : ""}
          </li>`).join("")}
      </ul>
      ${(d.membri || []).length < 6 ? `
        <p class="stato-pasto__domanda">Invita qualcuno</p>
        <p class="sheet__nota" style="margin-top:0;">Codice <strong class="codice-invito">${escapeHTML(d.codiceInvito || "—")}</strong>, valido 14 giorni. Chi lo riceve apre il link, accede (o si registra come familiare) e conferma.</p>
        <button type="button" class="btn" id="lista-invita-wa">Invia l'invito con WhatsApp</button>
        <button type="button" class="btn btn--ghost" id="lista-copia">Copia il link di invito</button>
        <button type="button" class="link-btn" id="lista-nuovo-codice">Crea un nuovo codice (quello vecchio smette di funzionare)</button>` : `<p class="sheet__nota">La lista ha già 6 membri, il massimo.</p>`}
      <button type="button" class="btn btn--ghost" id="lista-esci" style="margin-top:10px;">Esci dalla lista</button>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Chiudi</button>
    `);
    const testoInvito = () => `Ciao! Facciamo la spesa insieme con Il mio Piano: apri questo link ed entra nella nostra lista di casa (codice ${LISTA.dati.codiceInvito}).\n${linkInvito(LISTA.dati.codiceInvito)}`;
    const wa = overlay.querySelector("#lista-invita-wa");
    if (wa) wa.addEventListener("click", () => window.open("https://wa.me/?text=" + encodeURIComponent(testoInvito()), "_blank", "noopener"));
    const cp = overlay.querySelector("#lista-copia");
    if (cp) cp.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(linkInvito(LISTA.dati.codiceInvito)); mostraToast("Link copiato"); }
      catch (e) { mostraToast("Copia non riuscita"); }
    });
    const nc = overlay.querySelector("#lista-nuovo-codice");
    if (nc) nc.addEventListener("click", async () => {
      nc.disabled = true;
      try { await window.cloud.chiamaFunzioneLista("nuovoInvitoLista"); mostraToast("Nuovo codice creato"); chiudiSheet(); }
      catch (e) { nc.disabled = false; mostraToast(erroreLista(e), 4000); }
    });
    overlay.querySelectorAll("[data-rimuovi-membro]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try { await window.cloud.chiamaFunzioneLista("rimuoviMembroLista", { uid: b.dataset.rimuoviMembro }); mostraToast("Membro tolto dalla lista"); chiudiSheet(); }
      catch (e) { b.disabled = false; mostraToast(erroreLista(e), 4000); }
    }));
    overlay.querySelector("#lista-esci").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await window.cloud.chiamaFunzioneLista("esciDaLista");
        chiudiSheet();
        scollegaListaCasa();
        mostraToast("Sei uscito dalla lista di casa: torni alla tua lista personale", 3500);
        render();
      } catch (err) { btn.disabled = false; mostraToast(erroreLista(err), 4000); }
    });
  }

  /** Crea una lista oppure entra con un codice (anche arrivato da un link di invito). */
  function apriIngressoListaCasa(codiceIniziale) {
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">👥 Spesa condivisa</h2>
      <p class="sheet__nota">Una lista della spesa unica con chi vive con te: spunte, articoli aggiunti e scelte si vedono in tempo reale su ogni telefono. ${RUOLO === "paziente" ? "Se anche l'altra persona ha un piano, gli alimenti si sommano." : ""}</p>
      ${consensoPazienteHTML()}
      <p class="stato-pasto__domanda">${codiceIniziale ? "Hai ricevuto un invito" : "Hai un codice di invito?"}</p>
      <div class="editor-campo" style="flex-direction:row; gap:8px; align-items:stretch;">
        <input type="text" id="lista-codice" maxlength="12" placeholder="Es. K7M2QX9P" value="${escapeHTML(codiceIniziale || "")}" style="flex:1; text-transform:uppercase;" autocomplete="off">
        <button type="button" class="btn" id="lista-entra" style="width:auto; padding:0 16px;">Entra</button>
      </div>
      ${codiceIniziale ? "" : `
        <p class="stato-pasto__domanda" style="margin-top:14px;">Oppure crea tu la lista e invita gli altri</p>
        <button type="button" class="btn btn--ghost" id="lista-crea">Crea la lista di casa</button>`}
      <p id="lista-errore" class="auth-error" hidden></p>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
    `);
    const errore = (msg) => { const el = overlay.querySelector("#lista-errore"); el.textContent = msg; el.hidden = false; };
    const consensoOk = () => {
      const c = overlay.querySelector("#lista-consenso");
      if (c && !c.checked) { errore("Per condividere la lista serve il tuo consenso qui sopra."); return false; }
      return true;
    };
    const dopo = (listaId, messaggio) => {
      sessionStorage.removeItem(LS_INVITO);
      chiudiSheet();
      collegaListaCasa(listaId);
      mostraToast(messaggio, 3500);
      currentView = "spesa";
      document.querySelectorAll(".tabbar__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.view === "spesa"));
      render();
    };
    overlay.querySelector("#lista-entra").addEventListener("click", async (e) => {
      const codice = overlay.querySelector("#lista-codice").value.trim();
      if (!codice) { errore("Scrivi il codice di invito."); return; }
      if (!consensoOk()) return;
      e.currentTarget.disabled = true;
      try {
        const r = await window.cloud.chiamaFunzioneLista("entraInLista", { codice });
        dopo(r.listaId, r.nome ? `Sei entrato in "${r.nome}"` : "Sei nella lista di casa");
      } catch (err) { e.currentTarget.disabled = false; errore(erroreLista(err)); }
    });
    const crea = overlay.querySelector("#lista-crea");
    if (crea) crea.addEventListener("click", async () => {
      if (!consensoOk()) return;
      crea.disabled = true;
      try {
        const r = await window.cloud.chiamaFunzioneLista("creaListaCasa");
        dopo(r.listaId, "Lista di casa creata: ora invita chi fa la spesa con te");
        setTimeout(apriListaCasa, 600);
      } catch (err) { crea.disabled = false; errore(erroreLista(err)); }
    });
  }

  /** Invito ricevuto con un link: dopo l'accesso chiede conferma. */
  function gestisciInvitoInSospeso() {
    const codice = sessionStorage.getItem(LS_INVITO);
    if (!codice) return;
    if (RUOLO === "professionista") { sessionStorage.removeItem(LS_INVITO); return; }
    if (LISTA.id) { sessionStorage.removeItem(LS_INVITO); mostraToast("Fai già parte di una lista di casa", 3500); return; }
    setTimeout(() => apriIngressoListaCasa(codice), 500);
  }

  // ---------------------------------------------------------------------
  // Account familiare: solo la spesa condivisa
  // ---------------------------------------------------------------------
  async function avviaFamiliare(utenteDati) {
    mostraSchermata("paziente");
    mostraInformativaPrimoAccesso(utenteDati, "familiare");
    document.body.classList.add("ruolo-familiare");
    if (!window.temaApp) applyTema(localStorage.getItem(LS_KEYS.tema) || "sistema");
    CONFIG = await caricaConfig();
    aggiornaEyebrowData();
    registraServiceWorker();
    collegaTabbar();
    PIANO_ATTIVO = null;
    LISTA.nomeUtente = String(utenteDati.nome || "").trim().split(/\s+/)[0];
    collegaListaCasa(utenteDati.listaCasa || null);
    currentView = "spesa";
    document.querySelectorAll(".tabbar__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.view === "spesa"));
    render();
    gestisciInvitoInSospeso();
  }

  function renderImpostazioniFamiliare() {
    const d = LISTA.dati;
    root.innerHTML = `
      <section class="settings-section">
        <h2>Spesa condivisa</h2>
        ${d ? `<p class="hint">Fai parte di <strong>${escapeHTML(d.nome || "una lista di casa")}</strong> con ${(d.membri || []).length - 1} ${(d.membri || []).length === 2 ? "altra persona" : "altre persone"}.</p>`
          : `<p class="hint">Non fai ancora parte di una lista di casa: entra con il codice che hai ricevuto, oppure creane una.</p>`}
        <button type="button" class="btn" id="btn-lista-casa">${d ? "Gestisci la lista di casa" : "Entra o crea una lista"}</button>
      </section>
      ${aspettoSezioneHTML()}
      ${eliminaAccountSezioneHTML()}
      <p class="hint">Account familiare: vedi solo la lista della spesa condivisa. Il piano nutrizionale resta privato di chi lo segue.</p>
    `;
    document.getElementById("btn-lista-casa").addEventListener("click", apriListaCasa);
    collegaAspetto(renderImpostazioniFamiliare);
    collegaEliminaAccount();
  }

  // ---------------------------------------------------------------------
  // Peso e misure
  // ---------------------------------------------------------------------
  // /piani/{id}/misure/{mid}: { data "AAAA-MM-GG", peso, vita, fianchi,
  // grasso (%), muscolo (kg), fonte "studio" | "casa" }. Le note del
  // controllo stanno a parte (/piani/{id}/noteMisure/{mid}) e le vede solo il
  // professionista. Cosa vede il paziente lo decide il professionista, per
  // ciascun paziente: piano.corpo.visibilita = "nascosto" | "controlli" | "casa".
  const VISIBILITA_PESO = {
    nascosto: "Nascosto al paziente",
    controlli: "Vede le misure dei controlli",
    casa: "Vede le misure e può aggiungere le pesate a casa",
  };
  const LS_GIORNO_PESATA = "pnut:giorno-pesata";
  const MISURE = { pianoId: null, lista: [], note: {}, unsub: null, unsubNote: null };

  function visibilitaPeso(piano) {
    // il paziente che gestisce da solo il piano registra sempre peso e misure a casa
    if (piano && piano.gestore === "paziente") return "casa";
    const v = piano && piano.corpo && piano.corpo.visibilita;
    return VISIBILITA_PESO[v] ? v : "controlli";
  }
  const numIt = (n, dec = 1) => String(Math.round(n * Math.pow(10, dec)) / Math.pow(10, dec)).replace(".", ",");
  const kg1 = (n) => (Math.round(n * 10) / 10).toFixed(1).replace(".", ",");
  const fmtKg = (n) => (n == null ? "—" : `${kg1(n)} kg`);
  const fmtVariazione = (n) => (n == null ? "—" : `${n > 0.049 ? "+" : n < -0.049 ? "−" : "±"}${numIt(Math.abs(n))} kg`);
  const dataBreve = (k) => { const d = window.statistiche.daChiave(k); return `${d.getDate()}/${d.getMonth() + 1}/${String(d.getFullYear()).slice(2)}`; };

  function collegaMisure(pianoId, dopo) {
    if (MISURE.pianoId === pianoId && MISURE.unsub) return;
    scollegaMisure();
    if (!pianoId) return;
    MISURE.pianoId = pianoId;
    MISURE.unsub = window.cloud.ascoltaMisure(pianoId, (lista) => { MISURE.lista = lista; if (dopo) dopo(); });
    if (RUOLO === "professionista") {
      MISURE.unsubNote = window.cloud.ascoltaNoteMisure(pianoId, (note) => { MISURE.note = note; if (dopo) dopo(); });
    }
  }
  function scollegaMisure() {
    if (MISURE.unsub) MISURE.unsub();
    if (MISURE.unsubNote) MISURE.unsubNote();
    Object.assign(MISURE, { pianoId: null, lista: [], note: {}, unsub: null, unsubNote: null });
  }

  /** Istante di inserimento (le scritture appena fatte, non ancora confermate, sono le più recenti). */
  function momentoMisura(m) {
    const t = m && m.aggiornata;
    if (!t) return Number.MAX_SAFE_INTEGER;
    return typeof t.toMillis === "function" ? t.toMillis() : Number(t.seconds || 0) * 1000;
  }
  /** Ordine cronologico: per data e, nello stesso giorno, per momento di inserimento. */
  function ordineMisure(a, b) {
    if (a.data !== b.data) return a.data < b.data ? -1 : 1;
    return momentoMisura(a) - momentoMisura(b);
  }

  function riepilogoPeso(misure, corpo) {
    const conPeso = misure.filter((m) => typeof m.peso === "number").sort(ordineMisure);
    if (!conPeso.length) return null;
    const primo = conPeso[0];
    const ultimo = conPeso[conPeso.length - 1];
    const studio = conPeso.filter((m) => m.fonte !== "casa");
    const h = corpo && Number(corpo.altezzaCm);
    return {
      primo, ultimo, conPeso,
      variazioneInizio: conPeso.length > 1 ? ultimo.peso - primo.peso : null,
      variazioneControllo: studio.length >= 2 ? studio[studio.length - 1].peso - studio[studio.length - 2].peso : null,
      bmi: h ? ultimo.peso / Math.pow(h / 100, 2) : null,
      obiettivo: corpo && Number(corpo.pesoObiettivo) ? Number(corpo.pesoObiettivo) : null,
    };
  }

  /**
   * Grafico del peso nel tempo (punti pieni: controlli in studio, vuoti:
   * pesate a casa). Con "settimane" aggiunge sotto le barre dell'aderenza
   * settimanale, sulla stessa linea del tempo.
   */
  function graficoPesoSVG(misure, settimane) {
    const S = window.statistiche;
    const punti = misure.filter((m) => typeof m.peso === "number").slice().sort(ordineMisure)
      .map((m) => ({ t: S.daChiave(m.data).getTime(), peso: m.peso, casa: m.fonte === "casa" }));
    if (!punti.length) return "";
    const oggi = new Date(); oggi.setHours(0, 0, 0, 0);
    const G = 86400000;
    let t0 = punti[0].t, t1 = Math.max(oggi.getTime(), punti[punti.length - 1].t);
    const barre = (settimane || []).filter((s) => s.valore != null);
    if (barre.length) t0 = Math.min(t0, S.daChiave(barre[0].lunedi).getTime());
    t0 = Math.max(t0, t1 - 182 * G); // al massimo sei mesi
    if (t1 - t0 < 21 * G) t0 = t1 - 21 * G;
    const W = 640, H = barre.length ? 250 : 200, sx = 54, dx = 16, top = 18, bassoPeso = barre.length ? 152 : 164;
    const x = (t) => sx + ((t - t0) / (t1 - t0)) * (W - sx - dx);
    const visibili = punti.filter((p) => p.t >= t0);
    const pesi = visibili.map((p) => p.peso);
    let pMin = Math.min(...pesi), pMax = Math.max(...pesi);
    if (pMax - pMin < 2) { const c = (pMax + pMin) / 2; pMin = c - 1; pMax = c + 1; }
    const pad = (pMax - pMin) * 0.15;
    pMin -= pad; pMax += pad;
    const y = (p) => top + (1 - (p - pMin) / (pMax - pMin)) * (bassoPeso - top);
    const linea = visibili.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.peso).toFixed(1)}`).join(" ");
    const griglia = [pMax - pad, (pMax + pMin) / 2, pMin + pad].map((v) => `
      <line class="gp-griglia" x1="${sx}" x2="${W - dx}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
      <text class="gp-asse" x="${sx - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${numIt(v)}</text>`).join("");
    const larghezzaSett = ((7 * G) / (t1 - t0)) * (W - sx - dx);
    const barreSVG = barre.filter((s) => S.daChiave(s.lunedi).getTime() >= t0 - 7 * G).map((s) => {
      const xs = x(S.daChiave(s.lunedi).getTime());
      const h = Math.max(2, s.valore * 60);
      const larg = Math.min(larghezzaSett - 3, W - dx - xs - 1);
      if (larg < 2) return "";
      return `<rect class="gp-barra" x="${(xs + 1).toFixed(1)}" y="${(H - 22 - h).toFixed(1)}" width="${larg.toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>Aderenza ${Math.round(s.valore * 100)}%</title></rect>`;
    }).join("");
    const etichette = [t0, (t0 + t1) / 2, t1].map((t, i) => {
      const d = new Date(t);
      return `<text class="gp-asse" x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="${["start", "middle", "end"][i]}">${d.getDate()}/${d.getMonth() + 1}</text>`;
    }).join("");
    const pallini = visibili.map((p) => `<circle class="gp-punto ${p.casa ? "gp-punto--casa" : ""}" cx="${x(p.t).toFixed(1)}" cy="${y(p.peso).toFixed(1)}" r="${p.casa ? 3.6 : 4.6}"><title>${numIt(p.peso)} kg${p.casa ? " (a casa)" : ""}</title></circle>`).join("");
    return `
      <svg class="grafico-peso" viewBox="0 0 ${W} ${H}" role="img" aria-label="Andamento del peso${barre.length ? " e aderenza settimanale" : ""}">
        ${griglia}
        ${barre.length ? `<text class="gp-asse" x="${sx - 6}" y="${H - 26}" text-anchor="end">%</text>${barreSVG}` : ""}
        <path class="gp-linea" d="${linea}"/>
        ${pallini}
        ${etichette}
      </svg>`;
  }

  // ---- Professionista: analisi AI dell'andamento (in cima alla scheda) ----
  const ETICHETTE_ANALISI = { verde: "In linea con il piano", giallo: "Da tenere d'occhio", rosso: "Da contattare" };

  function analisiAttesaHTML() {
    return `
      <div class="analisi-ai__testa"><span class="analisi-ai__icona" aria-hidden="true">✨</span><div><h2>Analisi AI dell'andamento</h2><p>Sto leggendo i dati degli ultimi 30 giorni…</p></div></div>
      <div class="analisi-ai__attesa"><span></span><span></span><span></span></div>`;
  }

  /** Impronta dei dati: se non cambia, l'analisi salvata è ancora valida. */
  function improntaDati(obj) {
    const t = JSON.stringify(obj);
    let h = 5381;
    for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
    return "v1-" + h.toString(36) + "-" + t.length;
  }

  async function datiPerAnalisi(piano, r) {
    const S = window.statistiche;
    const lbl = (k) => (MEAL_META[k] ? MEAL_META[k].label : k);
    const motivo = (m) => (m && S.MOTIVI[m]) || null;
    const im = r.imprevisti || {};
    const grp = (g) => g ? { totale: g.totale, motivi: Object.fromEntries(Object.entries(g.motivi || {}).map(([k, v]) => [motivo(k) || k, v])), perPasto: Object.fromEntries(Object.entries(g.perPasto || {}).map(([k, v]) => [lbl(k), v])) } : null;
    let riscontri = [], misure = [];
    try { riscontri = await window.cloud.leggiRiscontriPaziente(piano.pazienteUid, 80); } catch (e) { /* facoltativi */ }
    try { misure = await window.cloud.leggiMisure(piano.id); } catch (e) { /* facoltative */ }
    const limite = S.chiave(new Date(Date.now() - 30 * 86400000));
    riscontri = riscontri.filter((x) => x.data && x.data >= limite);
    const conteggio = { irrilevante: 0, lieve: 0, moderato: 0, rilevante: 0 };
    riscontri.forEach((x) => { const k = x.impatto === "nessuno" ? "irrilevante" : x.impatto; if (k in conteggio) conteggio[k]++; });
    const rp = riepilogoPeso(misure, piano.corpo);
    return {
      pianoIniziato: r.pianoIniziato, giorniValutati30: r.giorniValutati30,
      aderenza7giorni: r.aderenza7 == null ? null : Math.round(r.aderenza7 * 100),
      aderenza30giorni: r.aderenza30 == null ? null : Math.round(r.aderenza30 * 100),
      aderenzaFeriali: r.feriali == null ? null : Math.round(r.feriali * 100),
      aderenzaWeekend: r.weekend == null ? null : Math.round(r.weekend * 100),
      giorniDiFilaRispettati: r.serie, record: r.record,
      statoCalcolatoDallApp: ETICHETTE_STATO[r.stato] || r.stato, segnaliDellApp: r.motivi,
      aderenzaPerSettimana: (r.settimane || []).map((x) => ({ settimanaDal: x.lunedi, aderenza: x.valore == null ? null : Math.round(x.valore * 100) })),
      pastiUltimi30giorni: (r.perPasto || []).map((x) => ({ pasto: lbl(x.pasto), ...x.conta })),
      pastiNonComeDaPiano: { fattiDiversamente: grp(im.diverso), fattiInParte: grp(im.parziale), saltati: grp(im.saltato) },
      noteDelPaziente: (im.note || []).map((n) => ({ giorno: n.giorno, pasto: lbl(n.pasto), stato: n.stato, motivo: motivo(n.motivo), nota: n.nota })),
      riscontriAI: { attivo: !(piano.feedbackAI && piano.feedbackAI.modo === "spento"), conteggioImpatti30giorni: conteggio, ultimi: riscontri.slice(0, 10).map((x) => ({ giorno: x.data, pasto: lbl(x.pasto), impatto: x.impatto, stima: x.stima })) },
      peso: rp ? { ultimoKg: rp.ultimo.peso, ultimoIl: rp.ultimo.data, variazioneDallInizioKg: rp.variazioneInizio == null ? null : Math.round(rp.variazioneInizio * 10) / 10, variazioneUltimoControlloKg: rp.variazioneControllo == null ? null : Math.round(rp.variazioneControllo * 10) / 10, obiettivoKg: rp.obiettivo, misurazioni: rp.conPeso.length } : null,
      usoApp: { ultimaInterazione: r.ultimaInterazione, giorniInattivo: r.giorniInattivo, promemoria: r.notifiche },
      prossimoControllo: r.prossimoControllo ? { traGiorni: r.prossimoControllo.traGiorni } : null,
      obiettivo: piano.obiettivo || (piano.paziente && piano.paziente.obiettivo) || null,
    };
  }

  async function avviaAnalisiAndamento(piano, r, forza) {
    const box = document.getElementById("analisi-ai");
    if (!box || !window.cloud.analizzaAndamento) return;
    const ancoraQui = () => pazienteSelezionatoId === piano.id && document.getElementById("analisi-ai") === box;
    box.innerHTML = analisiAttesaHTML();
    try {
      const dati = await datiPerAnalisi(piano, r);
      const impronta = improntaDati(dati);
      let analisi = null;
      if (!forza) {
        try { analisi = await window.cloud.leggiAnalisiAndamento(piano.id); } catch (e) { analisi = null; }
        if (analisi && (analisi.impronta !== impronta || Date.now() - (analisi.creata || 0) > 7 * 86400000)) analisi = null;
      }
      if (!analisi) analisi = await window.cloud.analizzaAndamento(piano.id, dati, impronta);
      if (ancoraQui()) mostraAnalisiAndamento(box, piano, r, analisi);
    } catch (err) {
      if (!ancoraQui()) return;
      const m = String((err && err.message) || "");
      box.innerHTML = `
        <div class="analisi-ai__testa"><span class="analisi-ai__icona" aria-hidden="true">✨</span><div><h2>Analisi AI dell'andamento</h2>
        <p>${m === "limite-giornaliero" ? "Per oggi le analisi disponibili sono esaurite." : m === "licenza-non-attiva" ? "Serve una licenza attiva." : "Analisi non disponibile in questo momento."}</p></div></div>
        <button type="button" class="btn btn--ghost" id="analisi-riprova">Riprova</button>`;
      const b = document.getElementById("analisi-riprova");
      if (b) b.addEventListener("click", () => avviaAnalisiAndamento(piano, r, true));
    }
  }

  function mostraAnalisiAndamento(box, piano, r, a) {
    const d = new Date(a.creata || Date.now());
    const quando = `${d.getDate()}/${d.getMonth() + 1} alle ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    box.className = `analisi-ai analisi-ai--${a.valutazione}`;
    box.innerHTML = `
      <div class="analisi-ai__testa">
        <span class="analisi-ai__icona" aria-hidden="true">✨</span>
        <div>
          <p class="analisi-ai__etichetta">Analisi AI dell'andamento</p>
          <span class="analisi-ai__semaforo analisi-ai__semaforo--${a.valutazione}"><span></span>${ETICHETTE_ANALISI[a.valutazione] || ""}</span>
          <h2>${escapeHTML(a.titolo || "")}</h2>
        </div>
      </div>
      <p class="analisi-ai__sintesi">${escapeHTML(a.sintesi || "")}</p>
      ${a.impattoScostamenti ? `<p class="analisi-ai__impatto"><strong>Scostamenti:</strong> ${escapeHTML(a.impattoScostamenti)}</p>` : ""}
      <div class="analisi-ai__colonne">
        ${a.puntiAttenzione && a.puntiAttenzione.length ? `<div><h3>Punti di attenzione</h3><ul>${a.puntiAttenzione.map((x) => `<li>${escapeHTML(x)}</li>`).join("")}</ul></div>` : ""}
        ${a.puntiForza && a.puntiForza.length ? `<div><h3>Cosa va bene</h3><ul>${a.puntiForza.map((x) => `<li>${escapeHTML(x)}</li>`).join("")}</ul></div>` : ""}
      </div>
      <div class="analisi-ai__azione"><strong>${a.contattare ? "📞 Azione suggerita" : "✓ Azione suggerita"}</strong><span>${escapeHTML(a.azione || "")}</span></div>
      ${a.messaggio ? `<button type="button" class="btn" id="analisi-usa-messaggio">Usa la bozza di messaggio proposta</button>` : ""}
      <p class="analisi-ai__piede">✨ Generata con intelligenza artificiale il ${quando}, dai dati degli ultimi 30 giorni. È un supporto: la valutazione clinica resta tua. <button type="button" class="link-btn" id="analisi-rigenera">Rigenera</button></p>`;
    const usa = document.getElementById("analisi-usa-messaggio");
    if (usa) usa.addEventListener("click", () => {
      const campo = document.getElementById("testo-incoraggiamento");
      if (!campo) return;
      campo.value = a.messaggio;
      campo.scrollIntoView({ behavior: "smooth", block: "center" });
      campo.focus();
      mostraToast("Bozza inserita: rivedila prima di inviarla");
    });
    document.getElementById("analisi-rigenera").addEventListener("click", () => avviaAnalisiAndamento(piano, r, true));
  }

  /** Scheda completa di un allenamento importato, vista dal professionista. */
  function apriAllenamentoProf(a, piano) {
    const nome = (piano.pazienteNome || "Paziente").split(" ")[0];
    const d = window.statistiche.daChiave(a.giorno);
    const giorno = d.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
    apriSheet(`
      <h2 class="sheet__titolo">${escapeHTML(nomeAllenamento(a))} di ${escapeHTML(nome)}</h2>
      <p class="sheet__nota">${escapeHTML(giorno.replace(/^./, (c) => c.toUpperCase()))}${a.ora ? `, alle ${escapeHTML(a.ora)}` : ""} · ${a.fonte === "file" ? `importato da file ${escapeHTML(a.formato || "")}` : "segnato a mano dal paziente"}</p>
      ${a.fonte === "file" ? righeAllenamentoHTML(a) : `<p class="stat-riga"><span>Durata</span><strong>${a.durata} min</strong></p>`}
      ${a.intensita ? `<p class="stat-riga"><span>Intensità</span><strong>${escapeHTML(a.intensita)}${a.intensitaFonte && FONTI_INTENSITA[a.intensitaFonte] ? ` · ${FONTI_INTENSITA[a.intensitaFonte]}` : " · scelta dal paziente"}</strong></p>` : ""}
      <p class="sheet__nota">Zone e indici dipendono dai valori di FC e FTP che il paziente ha indicato nelle sue Impostazioni. Le calorie sono la stima del suo dispositivo.</p>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Chiudi</button>`);
  }

  async function caricaAttivitaProf(piano) {
    const box = document.getElementById("sezione-attivita");
    if (!box || !piano.pazienteUid || !window.cloud.leggiAttivitaPeriodo) return;
    try {
      const da = chiaveData(new Date(Date.now() - 29 * 86400000));
      const perGiorno = await window.cloud.leggiAttivitaPeriodo(piano.pazienteUid, da);
      const t = testoSintesiAllenamenti(sintesiAllenamenti(perGiorno, da));
      if (!t || pazienteSelezionatoId !== piano.id) return;
      // allenamenti importati da file: totali e ultimi 8 con i dati
      const tutti = [];
      Object.keys(perGiorno).sort().reverse().forEach((g) => (perGiorno[g].allenamenti || []).forEach((a) => tutti.push(Object.assign({ giorno: g }, a))));
      const daFile = tutti.filter((a) => a.fonte === "file");
      const tot = daFile.reduce((x, a) => ({ km: x.km + (Number(a.distanzaKm) || 0), dplus: x.dplus + (Number(a.dislivelloM) || 0), kcal: x.kcal + (Number(a.kcal) || 0) }), { km: 0, dplus: 0, kcal: 0 });
      const rigaFile = daFile.length ? [`${daFile.length} da file`, tot.km ? `${numeroIt(Math.round(tot.km))} km` : "", tot.dplus ? `${numeroIt(tot.dplus)} m di dislivello` : "", tot.kcal ? `${numeroIt(tot.kcal)} kcal stimate dai dispositivi` : ""].filter(Boolean).join(" · ") : "";
      const elenco = tutti.slice(0, 10).map((a) => {
        const d = window.statistiche.daChiave(a.giorno);
        const zone = Array.isArray(a.zoneFC) ? (() => { const tt = a.zoneFC.reduce((x, y) => x + y, 0) || 1; return `Z1-Z2 ${Math.round(((a.zoneFC[0] + a.zoneFC[1]) / tt) * 100)}%`; })() : "";
        const dati = a.fonte !== "file" ? "Segnato a mano dal paziente" : [a.distanzaKm ? `${String(a.distanzaKm).replace(".", ",")} km` : "", a.dislivelloM ? `D+ ${a.dislivelloM} m` : "", a.fcMedia ? `FC ${a.fcMedia}` : "", a.potenzaNormalizzata || a.potenzaMedia ? `${a.potenzaNormalizzata || a.potenzaMedia} W` : "", zone, a.kcal ? `${numeroIt(a.kcal)} kcal disp.` : ""].filter(Boolean).join(" · ");
        return `<li><button type="button" class="stat-nota-pasto allenamento-prof" data-allenamento-prof="${escapeHTML(a.giorno + "|" + a.id)}"><span class="stat-nota-pasto__testa">${d.getDate()}/${d.getMonth() + 1} · ${escapeHTML(nomeAllenamento(a))} · ${a.durata} min${a.intensita ? ` · ${escapeHTML(a.intensita)}` : ""}</span><span>${escapeHTML(dati)}</span><span class="allenamento-prof__apri" aria-hidden="true">Apri ›</span></button></li>`;
      }).join("");
      box.innerHTML = `<h2>Allenamenti</h2><p class="hint">Ultimi 30 giorni, segnati dal paziente o importati dai file dei suoi dispositivi.</p>
        <p class="stat-riga"><span>Totale</span><strong>${escapeHTML(t.riga)}</strong></p>
        ${t.dettaglio ? `<p class="stat-nota">${escapeHTML(t.dettaglio)}</p>` : ""}
        ${rigaFile ? `<p class="stat-nota">${escapeHTML(rigaFile)}</p>` : ""}
        ${tutti.length ? `<ul class="stat-note-pasti">${elenco}</ul>${tutti.length > 10 ? `<p class="stat-nota">Gli ultimi 10 di ${tutti.length}: l'elenco completo è nel report per il preparatore.</p>` : ""}` : ""}`;
      box.querySelectorAll("[data-allenamento-prof]").forEach((b) => b.addEventListener("click", () => {
        const a = tutti.find((x) => x.giorno + "|" + x.id === b.dataset.allenamentoProf);
        if (a) apriAllenamentoProf(a, piano);
      }));
      box.hidden = false;
    } catch (e) { /* sezione facoltativa */ }
  }

  // ---- Professionista: consigli AI dati al paziente ----
  // Nella scheda Andamento solo i numeri; l'elenco completo è nel registro.
  async function leggiRiscontri30(piano) {
    const tutti = await window.cloud.leggiRiscontriPaziente(piano.pazienteUid, 80);
    const limite = chiaveData(new Date(Date.now() - 29 * 86400000));
    return tutti.filter((r) => r.data && r.data >= limite);
  }

  function sintesiRiscontri(lista) {
    const ORDINE = ["irrilevante", "lieve", "moderato", "rilevante"];
    const NOMI = { irrilevante: ["irrilevante", "irrilevanti"], lieve: ["lieve", "lievi"], moderato: ["moderato", "moderati"], rilevante: ["rilevante", "rilevanti"] };
    const conteggio = { irrilevante: 0, lieve: 0, moderato: 0, rilevante: 0 };
    lista.forEach((r) => { const k = r.impatto === "nessuno" ? "irrilevante" : r.impatto; if (k in conteggio) conteggio[k]++; });
    return ORDINE.filter((k) => conteggio[k]).map((k) => `${conteggio[k]} ${NOMI[k][conteggio[k] === 1 ? 0 : 1]}`).join(", ");
  }

  function rigaRiscontroHTML(r) {
    const STATI = { diverso: "fatto diversamente", parziale: "in parte", saltato: "saltato" };
    const d = window.statistiche.daChiave(r.data);
    return `<li class="stat-nota-pasto"><span class="stat-nota-pasto__testa">${d.getDate()}/${d.getMonth() + 1} · ${escapeHTML(MEAL_META[r.pasto] ? MEAL_META[r.pasto].label : r.pasto)} · ${STATI[r.stato] || ""} · impatto ${escapeHTML(r.impatto || "")}${r.frequente ? " · ⚠️ scostamenti frequenti" : ""}</span>
        <span>${escapeHTML(r.stima || "")}</span>
        ${(r.suggerimenti || []).map((x) => `<span>→ ${escapeHTML(MEAL_META[x.pasto] ? MEAL_META[x.pasto].label : x.pasto)}: ${escapeHTML(x.testo)}</span>`).join("")}</li>`;
  }

  async function caricaRiscontriProf(piano) {
    const riga = document.getElementById("riga-consigli-ai");
    if (!riga || !piano.pazienteUid || !window.cloud.leggiRiscontriPaziente) return;
    try {
      const lista = await leggiRiscontri30(piano);
      if (!lista.length || pazienteSelezionatoId !== piano.id) return;
      riga.innerHTML = `<span>Consigli AI dati al paziente</span><strong>${lista.length}: ${escapeHTML(sintesiRiscontri(lista))}</strong>`;
      riga.hidden = false;
    } catch (e) { /* riga facoltativa */ }
  }

  /** Registro dettagliato: note del paziente e consigli AI degli ultimi 30 giorni. */
  function renderRegistroPaziente(id) {
    const piano = PAZIENTI_PROF.find((p) => p.id === id);
    const x = STAT.risultati[id];
    if (!piano || !x || x.errore) { renderStatistiche(); return; }
    vistaProfCorrente = "registro"; segnaVistaProf("statPaziente");
    pazienteSelezionatoId = id;
    const nome = (piano.pazienteNome || "Paziente").split(" ")[0];
    const note = ((x.r.imprevisti && x.r.imprevisti.note) || []).map(notaPazienteHTML).join("");
    profRoot.innerHTML = `
      <div class="nav-riga">${navLink("btn-torna-stat-paziente", "andamento", `Andamento di ${escapeHTML(nome)}`, true)}</div>
      <section class="settings-section">
        <h2>Registro dettagliato</h2>
        <p class="hint">Ultimi 30 giorni, oggi compreso. Da consultare quando serve, ad esempio prima di una visita.</p>
      </section>
      <section class="settings-section">
        <h2>Cosa ha scritto il paziente</h2>
        ${note ? `<ul class="stat-note-pasti">${note}</ul>` : `<p class="stat-nota">Nessuna nota scritta.</p>`}
      </section>
      <section class="settings-section" id="registro-consigli">
        <h2>Consigli AI dati al paziente</h2>
        <p class="stat-nota">Caricamento…</p>
      </section>`;
    window.scrollTo(0, 0);
    document.getElementById("btn-torna-stat-paziente").addEventListener("click", () => renderStatistichePaziente(id));
    const box = document.getElementById("registro-consigli");
    if (!piano.pazienteUid || !window.cloud.leggiRiscontriPaziente) { box.querySelector(".stat-nota").textContent = "Nessun consiglio."; return; }
    leggiRiscontri30(piano).then((lista) => {
      if (vistaProfCorrente !== "registro" || pazienteSelezionatoId !== id) return;
      box.innerHTML = `<h2>Consigli AI dati al paziente</h2>${lista.length
        ? `<p class="stat-riga"><span>${lista.length === 1 ? "1 consiglio" : `${lista.length} consigli`}</span><strong>${escapeHTML(sintesiRiscontri(lista))}</strong></p><ul class="stat-note-pasti" style="margin-top:10px;">${lista.map(rigaRiscontroHTML).join("")}</ul>`
        : `<p class="stat-nota">Nessun consiglio negli ultimi 30 giorni.</p>`}`;
    }).catch(() => { box.querySelector(".stat-nota").textContent = "Registro dei consigli non disponibile in questo momento."; });
  }

  // ---- Professionista: sezione nella scheda di andamento ----
  function sezionePesoProfHTML(piano) {
    return `<section class="settings-section sezione-peso" id="sezione-peso">${contenutoPesoProfHTML(piano)}</section>`;
  }

  function contenutoPesoProfHTML(piano) {
    const misure = MISURE.pianoId === piano.id ? MISURE.lista : [];
    const r = riepilogoPeso(misure, piano.corpo);
    const x = STAT.risultati[piano.id];
    const settimane = x && x.r ? x.r.settimane : [];
    const a = piano.appuntamento;
    const oggiK = oggiISO();
    const daRegistrare = a && a.data && a.data <= oggiK && !misure.some((m) => m.data === a.data && m.fonte !== "casa") ? a.data : null;
    const righe = misure.slice().sort((p, q) => ordineMisure(q, p)).map((m) => `
      <tr>
        <td>${dataBreve(m.data)}${m.fonte === "casa" ? ' <span class="etichetta-casa">a casa</span>' : ""}</td>
        <td><strong>${m.peso != null ? kg1(m.peso) : "—"}</strong></td>
        <td>${m.vita != null ? numIt(m.vita) : "—"}</td>
        <td>${m.fianchi != null ? numIt(m.fianchi) : "—"}</td>
        <td>${m.grasso != null ? numIt(m.grasso) + "%" : "—"}</td>
        <td>${m.muscolo != null ? numIt(m.muscolo) : "—"}</td>
        <td><button type="button" class="link-btn" style="width:auto;padding:0;" data-misura="${escapeHTML(m.id)}">${MISURE.note[m.id] ? "📝 " : ""}Modifica</button></td>
      </tr>`).join("");
    return `
      <h2>Peso e misure</h2>
      ${daRegistrare ? `<div class="avviso-misure"><span>📏 Registra le misure del controllo del <strong>${dataBreve(daRegistrare)}</strong></span><button type="button" class="btn" data-nuova-misura="${daRegistrare}">Registra</button></div>` : ""}
      ${r ? `
        <div class="stat-riquadri stat-riquadri--peso">
          <div class="stat-riquadro"><strong>${fmtKg(r.ultimo.peso)}</strong><span>Ultimo peso (${dataBreve(r.ultimo.data)}${r.ultimo.fonte === "casa" ? ", a casa" : ""})</span></div>
          <div class="stat-riquadro"><strong>${fmtVariazione(r.variazioneInizio)}</strong><span>Dall'inizio (${dataBreve(r.primo.data)})</span></div>
          <div class="stat-riquadro"><strong>${fmtVariazione(r.variazioneControllo)}</strong><span>Dall'ultimo controllo</span></div>
          <div class="stat-riquadro"><strong>${r.bmi ? numIt(r.bmi) : "—"}</strong><span>${r.bmi ? "BMI (indicativo)" : "BMI: inserisci l'altezza"}${r.obiettivo ? ` · obiettivo ${fmtKg(r.obiettivo)}` : ""}</span></div>
        </div>
        ${graficoPesoSVG(misure, settimane)}
        <p class="gp-legenda"><span class="gp-l-punto"></span> controllo in studio <span class="gp-l-punto gp-l-punto--casa"></span> pesata a casa <span class="gp-l-barra"></span> aderenza della settimana</p>
        <div class="tabella-scorre"><table class="tabella-misure">
          <thead><tr><th>Data</th><th>Peso kg</th><th>Vita cm</th><th>Fianchi cm</th><th>Grasso</th><th>Muscolo kg</th><th></th></tr></thead>
          <tbody>${righe}</tbody>
        </table></div>` : `<p class="hint">Nessuna misura registrata: inserisci peso e circonferenze al prossimo controllo.</p>`}
      <button type="button" class="btn ${r ? "btn--ghost" : ""}" data-nuova-misura="${oggiK}" style="margin-top:12px;">Registra misure</button>
      <p class="stat-nota" style="margin-top:8px;">Il paziente: ${escapeHTML(VISIBILITA_PESO[visibilitaPeso(piano)].toLowerCase())}. Lo cambi in "Dati paziente", nel piano.</p>`;
  }

  function collegaSezionePesoProf(piano) {
    const box = document.getElementById("sezione-peso");
    if (!box) return;
    box.addEventListener("click", (e) => {
      const nuova = e.target.closest("[data-nuova-misura]");
      if (nuova) { apriMisura(piano, null, nuova.dataset.nuovaMisura); return; }
      const mod = e.target.closest("[data-misura]");
      if (mod) apriMisura(piano, MISURE.lista.find((m) => m.id === mod.dataset.misura));
    });
    collegaMisure(piano.id, () => {
      const b = document.getElementById("sezione-peso");
      if (b && pazienteSelezionatoId === piano.id) b.innerHTML = contenutoPesoProfHTML(piano);
    });
  }

  function apriMisura(piano, misura, dataProposta) {
    const m = misura || { data: dataProposta || oggiISO(), fonte: "studio" };
    const nota = misura ? (MISURE.note[misura.id] || "") : "";
    const casa = m.fonte === "casa";
    const campo = (id, label, valore, passo, suffisso) => `
      <label class="editor-campo"><span>${label}</span>
        <input type="number" inputmode="decimal" id="${id}" step="${passo}" min="0" value="${valore != null ? valore : ""}" placeholder="${suffisso}"></label>`;
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">${misura ? "Modifica misure" : "Registra misure"}</h2>
      ${casa ? `<p class="sheet__nota">Pesata registrata dal paziente a casa.</p>` : ""}
      <div class="editor-pasti">
        <label class="editor-campo"><span>Data</span><input type="date" id="mis-data" value="${escapeHTML(m.data)}" max="${oggiISO()}"></label>
        <div class="ric-griglia">
          ${campo("mis-peso", "Peso (kg)", m.peso, "0.1", "es. 72,4")}
          ${casa ? "" : campo("mis-vita", "Vita (cm)", m.vita, "0.5", "facoltativo")}
          ${casa ? "" : campo("mis-fianchi", "Fianchi (cm)", m.fianchi, "0.5", "facoltativo")}
          ${casa ? "" : campo("mis-grasso", "Massa grassa (%)", m.grasso, "0.1", "facoltativo")}
          ${casa ? "" : campo("mis-muscolo", "Massa muscolare (kg)", m.muscolo, "0.1", "facoltativo")}
        </div>
        ${casa ? "" : `<label class="editor-campo"><span>Nota del controllo (la vedi solo tu)</span><textarea id="mis-nota" rows="3" maxlength="1000">${escapeHTML(nota)}</textarea></label>`}
      </div>
      <p class="auth-error" id="mis-errore" hidden></p>
      <button type="button" class="btn" id="mis-salva">Salva</button>
      ${misura ? `<button type="button" class="btn btn--ghost" id="mis-elimina">Elimina queste misure</button>` : ""}
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
    `);
    const num = (id) => {
      const el = overlay.querySelector("#" + id);
      if (!el || el.value === "") return null;
      const n = Number(String(el.value).replace(",", "."));
      return Number.isFinite(n) ? n : NaN;
    };
    overlay.querySelector("#mis-salva").addEventListener("click", async (e) => {
      const dati = {
        data: overlay.querySelector("#mis-data").value,
        peso: num("mis-peso"), fonte: m.fonte || "studio",
      };
      if (!casa) Object.assign(dati, { vita: num("mis-vita"), fianchi: num("mis-fianchi"), grasso: num("mis-grasso"), muscolo: num("mis-muscolo") });
      Object.keys(dati).forEach((k) => { if (dati[k] === null) delete dati[k]; });
      const err = overlay.querySelector("#mis-errore");
      const errore = (t) => { err.textContent = t; err.hidden = false; };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dati.data || "")) return errore("Scegli la data.");
      if (!(dati.peso >= 20 && dati.peso <= 400)) return errore("Scrivi un peso valido, in kg (es. 72,4).");
      if ([dati.vita, dati.fianchi, dati.grasso, dati.muscolo].some((v) => Number.isNaN(v))) return errore("Controlla i numeri inseriti.");
      e.currentTarget.disabled = true;
      try {
        const id = await window.cloud.salvaMisura(piano.id, misura ? misura.id : null, dati);
        if (!casa) {
          const testo = (overlay.querySelector("#mis-nota").value || "").trim();
          if (testo || nota) await window.cloud.salvaNotaMisura(piano.id, id, testo);
        }
        chiudiSheet();
        mostraToast("Misure salvate");
      } catch (errS) {
        e.currentTarget.disabled = false;
        errore(msgErroreScrittura(errS, "Non salvato: controlla la connessione"));
      }
    });
    const el = overlay.querySelector("#mis-elimina");
    if (el) el.addEventListener("click", async () => {
      el.disabled = true;
      try {
        await window.cloud.eliminaMisura(piano.id, misura.id);
        if (nota) await window.cloud.salvaNotaMisura(piano.id, misura.id, "");
        chiudiSheet();
        mostraToast("Misure eliminate");
      } catch (errE) { el.disabled = false; mostraToast("Non riuscito: controlla la connessione"); }
    });
  }

  // ---- Paziente: "I miei progressi" e pesata a casa ----
  function collegaMisurePaziente() {
    if (!PIANO_ATTIVO || visibilitaPeso(PIANO_ATTIVO) === "nascosto") { scollegaMisure(); return; }
    collegaMisure(PIANO_ATTIVO.id, () => {
      if (currentView === "impostazioni" || currentView === "oggi") render();
    });
  }

  function ultimaPesataCasa() {
    return MISURE.lista.filter((m) => m.fonte === "casa").sort((a, b) => ordineMisure(b, a))[0] || null;
  }
  function puoPesarsi() {
    const u = ultimaPesataCasa();
    if (!u) return { si: true };
    const oggi = new Date(); oggi.setHours(0, 0, 0, 0);
    const giorni = Math.round((oggi - window.statistiche.daChiave(u.data)) / 86400000);
    return giorni >= 6 ? { si: true } : { si: false, traGiorni: 6 - giorni };
  }

  function progressiPazienteHTML() {
    if (!PIANO_ATTIVO) return "";
    const vis = visibilitaPeso(PIANO_ATTIVO);
    if (vis === "nascosto") return "";
    const r = riepilogoPeso(MISURE.lista, PIANO_ATTIVO.corpo);
    const puo = puoPesarsi();
    const giorno = localStorage.getItem(LS_GIORNO_PESATA) || "";
    const GIORNI = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
    return `
      <div class="progressi">
        <h3 class="stat-sottotitolo">I miei progressi</h3>
        ${r ? `
          <p class="progressi__riga"><strong>${fmtKg(r.ultimo.peso)}</strong> <span>al ${dataBreve(r.ultimo.data)}${r.variazioneInizio != null && !premiumLimitato() ? ` · ${fmtVariazione(r.variazioneInizio)} dall'inizio` : ""}</span></p>
          ${premiumLimitato() ? bloccoPremiumHTML("Grafico e andamento dall'inizio") : graficoPesoSVG(MISURE.lista)}
          ${vis === "casa" ? `<p class="gp-legenda"><span class="gp-l-punto"></span> controllo in studio <span class="gp-l-punto gp-l-punto--casa"></span> a casa</p>` : ""}`
          : `<p class="hint">Qui vedrai l'andamento delle misure registrate ai controlli.</p>`}
        ${vis === "casa" ? `
          <button type="button" class="btn btn--ghost" id="btn-pesata" ${puo.si ? "" : "disabled"}>${puo.si ? "⚖️ Aggiungi la pesata" : `Prossima pesata tra ${puo.traGiorni} ${puo.traGiorni === 1 ? "giorno" : "giorni"}`}</button>
          <div class="field-row">
            <div><div class="field-row__label">Giorno della pesata</div><div class="field-row__sub">Una volta a settimana basta: al mattino, a digiuno.</div></div>
            <select id="sel-giorno-pesata">
              <option value="">Nessuno</option>
              ${[1, 2, 3, 4, 5, 6, 0].map((g) => `<option value="${g}" ${String(g) === giorno ? "selected" : ""}>${GIORNI[g].charAt(0).toUpperCase() + GIORNI[g].slice(1)}</option>`).join("")}
            </select>
          </div>` : ""}
      </div>`;
  }

  function collegaProgressiPaziente() {
    const b = document.getElementById("btn-pesata");
    if (b) b.addEventListener("click", apriPesataPaziente);
    const s = document.getElementById("sel-giorno-pesata");
    if (s) s.addEventListener("change", () => { if (s.value) localStorage.setItem(LS_GIORNO_PESATA, s.value); else localStorage.removeItem(LS_GIORNO_PESATA); });
  }

  /** In Oggi, nel giorno scelto, se la pesata della settimana non c'è ancora. */
  function avvisoPesataHTML() {
    if (!PIANO_ATTIVO || visibilitaPeso(PIANO_ATTIVO) !== "casa") return "";
    const g = localStorage.getItem(LS_GIORNO_PESATA);
    if (g === null || Number(g) !== new Date().getDay() || !puoPesarsi().si) return "";
    return `
      <div class="banner-ios banner-pesata">
        <div class="banner-ios__testo"><strong>⚖️ Oggi è il giorno della pesata</strong><span>Al mattino, a digiuno, prima di colazione.</span></div>
        <button type="button" class="btn" id="btn-pesata-oggi" style="width:auto;padding:8px 14px;">Aggiungi</button>
      </div>`;
  }

  function apriPesataPaziente() {
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">⚖️ La pesata di oggi</h2>
      <p class="sheet__nota">Al mattino, a digiuno, prima di colazione: così le pesate si possono confrontare. Il tuo nutrizionista la vedrà nella tua scheda.</p>
      <label class="editor-campo"><span>Peso (kg)</span><input type="number" inputmode="decimal" id="pesata-peso" step="0.1" min="20" max="400" placeholder="es. 72,4"></label>
      <p class="auth-error" id="pesata-errore" hidden></p>
      <button type="button" class="btn" id="pesata-salva">Salva</button>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
    `);
    overlay.querySelector("#pesata-salva").addEventListener("click", async (e) => {
      const n = Number(String(overlay.querySelector("#pesata-peso").value).replace(",", "."));
      const err = overlay.querySelector("#pesata-errore");
      if (!(n >= 20 && n <= 400)) { err.textContent = "Scrivi il peso in kg, per esempio 72,4."; err.hidden = false; return; }
      e.currentTarget.disabled = true;
      try {
        await window.cloud.salvaMisura(PIANO_ATTIVO.id, null, { data: oggiISO(), peso: Math.round(n * 10) / 10, fonte: "casa" });
        chiudiSheet();
        mostraToast("Pesata salvata");
      } catch (errS) {
        e.currentTarget.disabled = false;
        err.textContent = "Non salvata: controlla la connessione."; err.hidden = false;
      }
    });
  }

  // ---------------------------------------------------------------------
  // Importazione di un piano da PDF con l'AI (professionista)
  // ---------------------------------------------------------------------
  // 1) il professionista sceglie il PDF e le pagine con il piano;
  // 2) nome e cognome del paziente (e altre parole indicate) vengono
  //    tolti dal testo e coperti nelle immagini, nel browser;
  // 3) solo quelle pagine vanno alla Cloud Function importaPianoAI;
  // 4) il risultato si rivede e si corregge prima di salvarlo.
  const IMPORTA = { piano: null, pdf: null, nomeFile: "", pagine: [], termini: [], inviate: null, risultato: null, inCorso: false };
  const RE_PAGINA_PASTI = /colazione|pranzo|cena|spuntino|merenda|giorno\s+[a-g]\b|luned|marted|mercoled|gioved|venerd|pasto\s*\d|snack/i;
  const RE_DATI_PERSONALI = /\bpeso\b|altezza|\bbmi\b|\bimc\b|circonferenz|bioimped|massa grassa|grasso\s*%|massa muscolare|\bet[aà]\b|data di nascita|antropometr|plicometr|appuntamento/gi;
  function contaDatiPersonali(testo) { return new Set((String(testo).match(RE_DATI_PERSONALI) || []).map((x) => x.toLowerCase())).size; }
  const CAMPI_IMPORTAZIONE = [["colazione", "Colazione"], ["spuntinoMattina", "Spuntino di metà mattina"], ["pranzo", "Pranzo"], ["spuntinoPomeriggio", "Spuntino del pomeriggio"], ["cena", "Cena"], ["coccola", "Coccola (facoltativa)"]];
  const VUOTI_IMPORTAZIONE = { colazione: "Nessuna colazione", spuntinoMattina: "Nessuno spuntino", pranzo: "Pasto libero", spuntinoPomeriggio: "Nessuno spuntino", cena: "Pasto libero" };

  /**
   * Contesto dell'importazione: la stessa procedura serve al professionista
   * (pannello, piano di un suo paziente) e al paziente autonomo (la sua app,
   * il suo piano, anche da foto delle pagine).
   */
  function contestoImportProfessionista(piano) {
    return {
      paziente: false,
      radice: () => profRoot,
      titolo: (t) => { segnaVistaProf("importaAI"); document.getElementById("prof-header-titolo").textContent = t; },
      indietroIcona: "piano", indietroTesto: "Piano del paziente",
      indietro: () => apriEditorPaziente(piano.id),
      pianoCorrente: () => PAZIENTI_PROF.find((p) => p.id === piano.id) || piano,
      salvaTesto: "Salva nel piano del paziente",
      conferma: (p) => `Sostituire il piano attuale di ${p.pazienteNome || "questo paziente"} con quello importato?`,
      toastOk: "Piano importato e sincronizzato con il paziente",
      dopoSalvataggio: () => apriEditorPaziente(piano.id),
    };
  }

  function radiceImport() { return IMPORTA.ctx.radice(); }

  function avviaImportazioneAI(piano, ctx) {
    if (IMPORTA.pdf) { try { IMPORTA.pdf.destroy(); } catch (e) { /* già chiuso */ } }
    Object.assign(IMPORTA, { piano, ctx: ctx || contestoImportProfessionista(piano), pdf: null, nomeFile: "", pagine: [], inviate: null, risultato: null, inCorso: false,
      termini: String(piano.pazienteNome || "").split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2) });
    renderImportazioneAI();
  }

  function testataImportazioneHTML(passo) {
    const passi = ["Documento e pagine", "Controllo dell'invio", "Revisione"];
    return `
      <div class="nav-riga">${navLink("btn-import-indietro", IMPORTA.ctx.indietroIcona, IMPORTA.ctx.indietroTesto, true)}</div>
      <ol class="import-passi">${passi.map((t, i) => `<li class="${i + 1 === passo ? "is-attivo" : i + 1 < passo ? "is-fatto" : ""}">${i + 1}. ${t}</li>`).join("")}</ol>`;
  }

  function collegaIndietroImportazione() {
    document.getElementById("btn-import-indietro").addEventListener("click", () => IMPORTA.ctx.indietro());
  }

  // ---- passo 1: PDF, pagine, parole da nascondere ----
  function renderImportazioneAI() {
    const piano = IMPORTA.piano;
    const paz = IMPORTA.ctx.paziente;
    IMPORTA.ctx.titolo("Importa il piano da un PDF");
    const sel = IMPORTA.pagine.filter((p) => p.sel).length;
    const daFoto = IMPORTA.pagine.length && IMPORTA.pagine[0].foto;
    radiceImport().innerHTML = `
      ${testataImportazioneHTML(1)}
      <section class="settings-section">
        <h2>${paz ? "Il tuo piano" : `Il piano di ${escapeHTML(piano.pazienteNome || "questo paziente")}`}</h2>
        <p class="hint">${paz
          ? "Carica il PDF che ti ha dato il tuo nutrizionista, oppure fotografa le pagine del piano stampato: l'intelligenza artificiale lo legge e lo converte nel formato dell'app. Prima di salvare potrai rivedere e correggere tutto."
          : "Carica il PDF che consegni di solito al paziente: l'intelligenza artificiale lo legge e lo converte nel formato dell'app. Prima di salvare potrai rivedere e correggere tutto. Il piano attuale verrà sostituito solo quando confermi."}</p>
        <label class="btn ${IMPORTA.pdf ? "btn--ghost" : ""}" for="import-file">${IMPORTA.pdf ? `📄 ${escapeHTML(IMPORTA.nomeFile)} · cambia file` : "📄 Scegli il PDF del piano"}</label>
        <input type="file" id="import-file" accept="application/pdf,.pdf" hidden>
        ${paz ? `
        <label class="btn btn--ghost" for="import-foto" style="margin-top:8px;">${daFoto ? "📷 Aggiungi altre foto" : "📷 Fotografa le pagine o scegli le foto"}</label>
        <input type="file" id="import-foto" accept="image/*" multiple hidden>` : ""}
        <p class="stat-nota" style="margin-top:6px;">${paz ? "Foto: una per pagina, dritta e ben illuminata. " : "Un file Word? Aprilo e salvalo come PDF. "}Al massimo ${12} pagine per volta.</p>
      </section>
      ${IMPORTA.pagine.length ? `
      <section class="settings-section">
        <h2>Quali pagine contengono il piano?</h2>
        <p class="hint">${daFoto ? "Tocca una foto per toglierla dall'invio." : `Ho già selezionato quelle con i pasti. Le pagine segnate <strong>⚠️ dati ${paz ? "personali" : "del paziente"}</strong> contengono misure o dati personali: se ti servono (per esempio hanno anche delle indicazioni sul piano), selezionale e al passo successivo copri la zona con i dati.`} <strong>Le pagine non selezionate non escono dal tuo ${paz ? "telefono" : "computer"}.</strong></p>
        <div class="import-pagine">
          ${IMPORTA.pagine.map((p, i) => `
            <button type="button" class="import-pagina ${p.sel ? "is-sel" : ""}" data-pagina="${i}" aria-pressed="${p.sel}">
              <img src="${p.miniatura}" alt="Pagina ${i + 1}">
              <span>${p.foto ? "Foto" : "Pagina"} ${i + 1}${p.senzaTesto && !p.foto ? " · scansione" : ""}</span>
              ${p.personali ? '<span class="import-pagina__avviso">⚠️ dati del paziente</span>' : ""}
            </button>`).join("")}
        </div>
        <p class="stat-nota">${sel} ${sel === 1 ? "pagina selezionata" : "pagine selezionate"}.</p>
      </section>
      <section class="settings-section">
        <h2>Cosa nascondere</h2>
        <p class="hint">${daFoto ? "Nelle foto il testo non si legge in automatico: al passo successivo copri a mano il tuo nome e gli altri dati personali con \"Copri una zona\"." : `Queste parole vengono tolte dal testo e coperte nelle immagini prima dell'invio. Ci sono già ${paz ? "il tuo nome" : "nome e cognome del paziente"}: aggiungi, separandoli con una virgola, altri dati che compaiono nelle pagine scelte.`}</p>
        <label class="editor-campo"><span>Parole da nascondere</span>
          <input type="text" id="import-termini" value="${escapeHTML(IMPORTA.termini.join(", "))}" placeholder="Nome, Cognome, …"></label>
        <label class="editor-campo" style="margin-top:10px;"><span>Indicazioni per la lettura (facoltative)</span>
          <textarea id="import-note" rows="2" maxlength="500" placeholder="${paz ? "Es. la colonna di sinistra è il pranzo; il giorno A è il lunedì" : "Es. il paziente si allena martedì e giovedì; la colonna di sinistra è il pranzo"}"></textarea></label>
        <button type="button" class="btn" id="import-prepara" style="margin-top:12px;" ${sel ? "" : "disabled"}>Prepara l'invio (${sel} ${sel === 1 ? "pagina" : "pagine"})</button>
      </section>` : ""}
    `;
    collegaIndietroImportazione();
    document.getElementById("import-file").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) caricaPdfImportazione(f);
    });
    const inputFoto = document.getElementById("import-foto");
    if (inputFoto) inputFoto.addEventListener("change", (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      if (files.length) caricaFotoImportazione(files);
    });
    radiceImport().querySelectorAll("[data-pagina]").forEach((b) => b.addEventListener("click", () => {
      const p = IMPORTA.pagine[Number(b.dataset.pagina)];
      p.sel = !p.sel;
      if (IMPORTA.pagine.filter((x) => x.sel).length > 12) { p.sel = false; mostraToast("Al massimo 12 pagine per volta"); }
      leggiTerminiImportazione();
      renderImportazioneAI();
    }));
    const prep = document.getElementById("import-prepara");
    if (prep) prep.addEventListener("click", () => { leggiTerminiImportazione(); IMPORTA.note = document.getElementById("import-note").value.trim(); preparaInvioImportazione(); });
  }

  function leggiTerminiImportazione() {
    const el = document.getElementById("import-termini");
    if (el) IMPORTA.termini = el.value.split(",").map((t) => t.trim()).filter((t) => t.length >= 2);
  }

  async function caricaPdfImportazione(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { mostraToast("Scegli un file PDF"); return; }
    if (file.size > 30 * 1024 * 1024) { mostraToast("Il PDF è troppo grande (massimo 30 MB)"); return; }
    mostraToast("Apro il PDF…");
    try {
      const pdfjs = await caricaPdfJs();
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
      if (IMPORTA.pdf) { try { IMPORTA.pdf.destroy(); } catch (e) { /* già chiuso */ } }
      IMPORTA.pdf = doc; IMPORTA.nomeFile = file.name; IMPORTA.pagine = []; IMPORTA.inviate = null;
      const n = Math.min(doc.numPages, 30);
      for (let i = 1; i <= n; i++) {
        const pagina = await doc.getPage(i);
        const testo = (await pagina.getTextContent()).items.map((it) => it.str).join(" ");
        const vp = pagina.getViewport({ scale: 1 });
        const scala = 220 / vp.width;
        const canvas = document.createElement("canvas");
        const v2 = pagina.getViewport({ scale: scala });
        canvas.width = Math.round(v2.width); canvas.height = Math.round(v2.height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await pagina.render({ canvasContext: ctx, viewport: v2 }).promise;
        const personali = contaDatiPersonali(testo) >= 2;
        IMPORTA.pagine.push({ n: i, testo, senzaTesto: testo.replace(/\s/g, "").length < 20, personali, sel: RE_PAGINA_PASTI.test(testo) && !personali, zone: [], miniatura: canvas.toDataURL("image/jpeg", 0.7) });
      }
      if (IMPORTA.pagine.filter((p) => p.sel).length > 12) IMPORTA.pagine.forEach((p, i) => { if (i >= 12) p.sel = false; });
      if (doc.numPages > 30) mostraToast("Mostro solo le prime 30 pagine", 3500);
      renderImportazioneAI();
    } catch (err) {
      console.warn(err);
      mostraToast("Non riesco ad aprire questo PDF: prova a salvarlo di nuovo come PDF", 4500);
    }
  }

  /** Legge un'immagine e la ridimensiona: { grande (per l'invio), miniatura }. */
  function leggiFotoPagina(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const disegna = (larghezza, qualita) => {
          const scala = Math.min(1, larghezza / img.naturalWidth);
          const c = document.createElement("canvas");
          c.width = Math.round(img.naturalWidth * scala); c.height = Math.round(img.naturalHeight * scala);
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          return c.toDataURL("image/jpeg", qualita);
        };
        const out = { grande: disegna(1400, 0.75), miniatura: disegna(220, 0.7) };
        URL.revokeObjectURL(url);
        resolve(out);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("immagine-non-leggibile")); };
      img.src = url;
    });
  }

  async function caricaFotoImportazione(files) {
    const immagini = files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|heic|webp)$/i.test(f.name));
    if (!immagini.length) { mostraToast("Scegli delle foto"); return; }
    // si passa dal PDF alle foto: si riparte da zero
    if (IMPORTA.pdf) { try { IMPORTA.pdf.destroy(); } catch (e) { /* già chiuso */ } IMPORTA.pdf = null; IMPORTA.nomeFile = ""; IMPORTA.pagine = []; }
    mostraToast("Preparo le foto…");
    try {
      for (const f of immagini) {
        if (IMPORTA.pagine.length >= 12) { mostraToast("Al massimo 12 pagine per volta"); break; }
        const { grande, miniatura } = await leggiFotoPagina(f);
        IMPORTA.pagine.push({ n: IMPORTA.pagine.length + 1, foto: grande, testo: "", senzaTesto: true, personali: false, sel: true, zone: [], miniatura });
      }
      IMPORTA.inviate = null;
      renderImportazioneAI();
    } catch (err) {
      console.warn(err);
      mostraToast("Non riesco a leggere una delle foto: prova a scattarla di nuovo", 4500);
    }
  }

  function escapeRegExp(t) { return String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  /** Testo e immagine di una pagina con le parole da nascondere tolte e coperte. */
  function dentroZona(x, y, zone) {
    return zone.some((z) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h);
  }

  /** Foto di una pagina con le zone scelte coperte. */
  function fotoOscurata(pagina, zone) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        ctx.fillStyle = "#1e2b21";
        zone.forEach((z) => ctx.fillRect(z.x * c.width, z.y * c.height, z.w * c.width, z.h * c.height));
        resolve({ testo: "", immagine: c.toDataURL("image/jpeg", 0.75), coperte: 0 });
      };
      img.onerror = () => reject(new Error("immagine-non-leggibile"));
      img.src = pagina.foto;
    });
  }

  async function paginaOscurata(numero, zone) {
    zone = zone || [];
    const daFoto = IMPORTA.pagine.find((p) => p.n === numero);
    if (daFoto && daFoto.foto) return fotoOscurata(daFoto, zone);
    const pdfjs = await caricaPdfJs();
    const pagina = await IMPORTA.pdf.getPage(numero);
    const contenuto = await pagina.getTextContent();
    const termini = IMPORTA.termini.map((t) => t.toLowerCase());
    const re = termini.length ? new RegExp(termini.map(escapeRegExp).join("|"), "gi") : null;
    const base0 = pagina.getViewport({ scale: 1 });
    const nellaZona = (it) => {
      if (!zone.length) return false;
      const t = pdfjs.Util.transform(base0.transform, it.transform);
      const cx = (t[4] + (it.width || 0) / 2) / base0.width;
      const cy = (t[5] - Math.hypot(t[2], t[3]) / 2) / base0.height;
      return dentroZona(cx, cy, zone);
    };
    const righe = [];
    let riga = "";
    contenuto.items.forEach((it) => {
      if (!nellaZona(it)) riga += it.str;
      if (it.hasEOL) { righe.push(riga); riga = ""; } else riga += " ";
    });
    if (riga.trim()) righe.push(riga);
    let testo = righe.map((r) => r.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
    if (re) testo = testo.replace(re, "[paziente]");
    const base = pagina.getViewport({ scale: 1 });
    const vp = pagina.getViewport({ scale: Math.min(2.2, 1400 / base.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pagina.render({ canvasContext: ctx, viewport: vp }).promise;
    let coperte = 0;
    ctx.fillStyle = "#1e2b21";
    zone.forEach((z) => ctx.fillRect(z.x * canvas.width, z.y * canvas.height, z.w * canvas.width, z.h * canvas.height));
    if (re) {
      contenuto.items.forEach((it) => {
        if (!it.str || !termini.some((t) => it.str.toLowerCase().includes(t))) return;
        const tx = pdfjs.Util.transform(vp.transform, it.transform);
        const h = Math.hypot(tx[2], tx[3]);
        const w = (it.width || 0) * vp.scale;
        ctx.fillStyle = "#1e2b21";
        ctx.fillRect(tx[4] - 2, tx[5] - h * 1.05, Math.max(w, h * 2) + 4, h * 1.35);
        coperte++;
      });
    }
    return { testo, immagine: canvas.toDataURL("image/jpeg", 0.72), coperte };
  }

  // ---- passo 2: cosa viene inviato ----
  async function preparaInvioImportazione() {
    const scelte = IMPORTA.pagine.filter((p) => p.sel);
    mostraToast("Preparo le pagine…");
    try {
      IMPORTA.inviate = [];
      for (const p of scelte) IMPORTA.inviate.push(Object.assign({ n: p.n, senzaTesto: p.senzaTesto, personali: p.personali }, await paginaOscurata(p.n, p.zone)));
    } catch (err) {
      console.warn(err);
      mostraToast("Non riesco a preparare le pagine: riprova", 4000);
      return;
    }
    renderInvioImportazione();
  }

  function renderInvioImportazione() {
    const scansioni = IMPORTA.inviate.filter((p) => p.senzaTesto).length;
    radiceImport().innerHTML = `
      ${testataImportazioneHTML(2)}
      <section class="settings-section">
        <h2>Ecco cosa viene inviato</h2>
        <p class="hint">Le parole da nascondere sono coperte da un riquadro scuro${IMPORTA.inviate.some((p) => p.coperte) ? "" : " (in queste pagine non ne ho trovate)"}. Controlla le pagine: se vedi ancora dati del paziente, torna indietro e aggiungili tra le parole da nascondere, oppure togli la pagina.</p>
        ${IMPORTA.inviate.some((p) => (IMPORTA.pagine.find((x) => x.n === p.n) || {}).foto)
          ? `<div class="nota-versione">📷 Nelle foto il nome non si copre da solo: se una foto mostra il tuo nome o altri dati personali, tocca <strong>Copri una zona</strong> e trascina il dito sopra quella parte.</div>`
          : scansioni ? `<div class="nota-versione">⚠️ ${scansioni === 1 ? "Una pagina è una scansione" : `${scansioni} pagine sono scansioni`}: il testo non è leggibile dal computer, quindi il nome non si può coprire in automatico. Se contengono dati ${IMPORTA.ctx.paziente ? "personali" : "del paziente"}, togli quelle pagine.</div>` : ""}
        <div class="import-anteprime">
          ${IMPORTA.inviate.map((p, i) => {
            const zone = (IMPORTA.pagine.find((x) => x.n === p.n) || {}).zone || [];
            return `<figure class="${p.personali && !zone.length ? "is-attenzione" : ""}"><img src="${p.immagine}" alt="Pagina ${p.n}">
              <figcaption>${(IMPORTA.pagine.find((x) => x.n === p.n) || {}).foto ? "Foto" : "Pagina"} ${p.n}${p.coperte ? ` · ${p.coperte} ${p.coperte === 1 ? "parola coperta" : "parole coperte"}` : ""}${zone.length ? ` · ${zone.length} ${zone.length === 1 ? "zona coperta" : "zone coperte"}` : ""}${p.personali && !zone.length ? " · ⚠️ contiene dati del paziente" : ""}</figcaption>
              <button type="button" class="btn btn--ghost import-copri" data-copri="${i}">▭ Copri una zona</button></figure>`;
          }).join("")}
        </div>
        <label class="ric-scelta consenso-ai">
          <input type="checkbox" id="import-consenso">
          <span>${IMPORTA.ctx.paziente
            ? `Acconsento all'invio di queste pagine ad <strong>Anthropic PBC (Stati Uniti)</strong>, il fornitore di intelligenza artificiale che usiamo, al solo scopo di leggere il piano e convertirlo per l'app. Ho controllato che siano coperti il mio nome e gli altri miei dati personali (per esempio codice fiscale, indirizzo, telefono, data di nascita, peso e misure). Le pagine non vengono usate per addestrare modelli e noi non le conserviamo dopo la lettura.`
            : `Confermo di aver coperto i dati identificativi del paziente e di averlo informato, come titolare del trattamento, che il suo piano viene letto dall'intelligenza artificiale di <strong>Anthropic PBC (Stati Uniti)</strong>, fornitore di Bulli e Pupe S.r.l. Le pagine non vengono usate per addestrare modelli e non vengono conservate dopo la lettura.`}
          <a href="${URL_INFORMATIVA}" target="_blank" rel="noopener" class="link-inline">Informativa ↗</a></span>
        </label>
        <p class="stat-nota">La lettura richiede di solito uno o due minuti.</p>
        <div class="import-azioni">
          <button type="button" class="btn btn--ghost" id="import-torna">Torna alle pagine</button>
          <button type="button" class="btn" id="import-invia" disabled>✨ Leggi il piano</button>
        </div>
      </section>`;
    collegaIndietroImportazione();
    document.getElementById("import-torna").addEventListener("click", renderImportazioneAI);
    radiceImport().querySelectorAll("[data-copri]").forEach((b) => b.addEventListener("click", () => apriCopriZona(Number(b.dataset.copri))));
    const consenso = document.getElementById("import-consenso");
    const invia = document.getElementById("import-invia");
    consenso.addEventListener("change", () => { invia.disabled = !consenso.checked; });
    invia.addEventListener("click", inviaImportazione);
  }

  /** Il professionista traccia rettangoli sulla pagina: quelle zone non vengono inviate. */
  function apriCopriZona(indice) {
    const inviata = IMPORTA.inviate[indice];
    const pagina = IMPORTA.pagine.find((x) => x.n === inviata.n);
    const zone = pagina.zone.map((z) => Object.assign({}, z));
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">Copri una zona · pagina ${inviata.n}</h2>
      <p class="sheet__nota">Trascina con il mouse o con il dito sopra la parte da nascondere, per esempio la tabella con peso e misure. Puoi tracciare più zone.</p>
      <div class="copri-area"><img src="${inviata.immagine}" alt=""><canvas></canvas></div>
      <div class="import-azioni" style="margin-top:10px;">
        <button type="button" class="btn btn--ghost" id="copri-annulla-ultima">Togli l'ultima zona</button>
        <button type="button" class="btn" id="copri-applica">Applica</button>
      </div>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
    `);
    overlay.querySelector(".sheet").classList.add("sheet--larga");
    const area = overlay.querySelector(".copri-area");
    const canvas = area.querySelector("canvas");
    const img = area.querySelector("img");
    let inizio = null, corrente = null;
    const disegna = () => {
      canvas.width = img.clientWidth; canvas.height = img.clientHeight;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(30,43,33,0.97)";
      zone.concat(corrente ? [corrente] : []).forEach((z) => ctx.fillRect(z.x * canvas.width, z.y * canvas.height, z.w * canvas.width, z.h * canvas.height));
    };
    const punto = (e) => {
      const r = canvas.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return { x: Math.min(1, Math.max(0, (t.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (t.clientY - r.top) / r.height)) };
    };
    const giu = (e) => { e.preventDefault(); inizio = punto(e); corrente = null; };
    const muovi = (e) => {
      if (!inizio) return;
      e.preventDefault();
      const p = punto(e);
      corrente = { x: Math.min(inizio.x, p.x), y: Math.min(inizio.y, p.y), w: Math.abs(p.x - inizio.x), h: Math.abs(p.y - inizio.y) };
      disegna();
    };
    const su = () => { if (corrente && corrente.w > 0.01 && corrente.h > 0.005) zone.push(corrente); inizio = null; corrente = null; disegna(); };
    canvas.addEventListener("mousedown", giu); canvas.addEventListener("mousemove", muovi); window.addEventListener("mouseup", su);
    canvas.addEventListener("touchstart", giu, { passive: false }); canvas.addEventListener("touchmove", muovi, { passive: false }); canvas.addEventListener("touchend", su);
    if (img.complete) disegna(); else img.addEventListener("load", disegna);
    overlay.querySelector("#copri-annulla-ultima").addEventListener("click", () => { zone.pop(); disegna(); });
    overlay.querySelector("#copri-applica").addEventListener("click", async () => {
      window.removeEventListener("mouseup", su);
      pagina.zone = zone;
      chiudiSheet();
      try {
        Object.assign(inviata, await paginaOscurata(inviata.n, zone));
        renderInvioImportazione();
      } catch (err) { mostraToast("Non riesco ad applicare la zona: riprova"); }
    });
  }

  function erroreImportazione(err) {
    const m = String((err && err.message) || "");
    const c = String((err && err.code) || "");
    if (m === "limite-mensile") return "Hai raggiunto le importazioni disponibili per questo mese. Scrivici a info@ilmiopiano.it se te ne servono altre.";
    if (m === "licenza-non-attiva") return "La tua licenza non è attiva: rinnovala per usare l'importazione.";
    if (m === "premium-richiesto") return "La lettura del piano con l'AI fa parte di Premium: la prova gratuita è terminata.";
    if (m === "piano-del-nutrizionista") return "Il tuo piano lo gestisce il tuo nutrizionista: è lui a poterlo aggiornare.";
    if (m === "consenso-mancante") return "Per leggere il piano serve la conferma qui sopra.";
    if (m === "troppe-pagine") return "Troppe pagine: scegline al massimo 12.";
    if (m === "nessun-pasto-trovato") return "Non ho trovato pasti in queste pagine: controlla di aver scelto quelle con il piano.";
    if (/deadline|timeout/i.test(c + m)) return "La lettura ha richiesto troppo tempo: prova con meno pagine.";
    if (m === "servizio-ai-non-disponibile") return "Il servizio di lettura non risponde in questo momento: riprova tra qualche minuto.";
    return "Lettura non riuscita: controlla la connessione e riprova.";
  }

  async function inviaImportazione() {
    if (IMPORTA.inCorso) return;
    IMPORTA.inCorso = true;
    const btn = document.getElementById("import-invia");
    btn.disabled = true;
    const inizio = Date.now();
    const fasi = [[0, "Leggo le pagine"], [15, "Riconosco giornate e pasti"], [40, "Ricostruisco la settimana"], [70, "Ultimi controlli"]];
    const aggiornaAttesa = () => {
      const sec = Math.round((Date.now() - inizio) / 1000);
      const fase = fasi.filter(([t]) => sec >= t).pop()[1];
      btn.innerHTML = `<span class="import-attesa"></span> ${fase}… ${sec} s`;
    };
    aggiornaAttesa();
    const timer = setInterval(aggiornaAttesa, 1000);
    btn.insertAdjacentHTML("afterend", '<p class="stat-nota" id="import-attesa-nota" style="margin-top:8px;">Di solito serve circa un minuto: non chiudere l\'app e non bloccare il telefono.</p>');
    try {
      const r = await window.cloud.importaPianoAI({
        pagine: IMPORTA.inviate.map((p) => ({ testo: p.testo, immagine: p.immagine.split(",")[1] })),
        note: IMPORTA.note || "",
        consenso: !!(document.getElementById("import-consenso") || {}).checked,
      });
      IMPORTA.risultato = r.piano;
      IMPORTA.rimaste = r.rimaste;
      renderRevisioneImportazione();
    } catch (err) {
      console.warn(err);
      btn.disabled = false;
      btn.textContent = "✨ Leggi il piano";
      mostraToast(erroreImportazione(err), 6000);
    } finally {
      clearInterval(timer);
      const nota = document.getElementById("import-attesa-nota");
      if (nota) nota.remove();
      IMPORTA.inCorso = false;
    }
  }

  // ---- passo 3: revisione ----
  function renderRevisioneImportazione() {
    const r = IMPORTA.risultato;
    const GG = window.weekLogic.GIORNI;
    radiceImport().innerHTML = `
      ${testataImportazioneHTML(3)}
      <section class="settings-section">
        <h2>Controlla il piano letto</h2>
        <p class="hint">Rivedi e correggi quello che serve: nulla è ancora salvato. Quando è tutto a posto, salvalo nel ${IMPORTA.ctx.paziente ? "tuo piano" : "piano del paziente"}.</p>
        ${r.domande.length ? `<div class="import-domande"><strong>Da decidere</strong><ul>${r.domande.map((d) => `<li>${escapeHTML(d)}</li>`).join("")}</ul></div>` : ""}
        ${r.avvisi.length ? `<div class="nota-versione"><strong>Cosa ho interpretato</strong><ul>${r.avvisi.map((a) => `<li>${escapeHTML(a)}</li>`).join("")}</ul></div>` : ""}
      </section>
      <section class="settings-section">
        <h2>La settimana</h2>
        <p class="hint">Per ogni giorno, la giornata del piano da seguire. Puoi cambiarla qui.</p>
        ${r.settimane.map((sett, s) => `
          ${r.settimane.length > 1 ? `<p class="stat-sottotitolo">Settimana ${s + 1}</p>` : ""}
          <div class="import-settimana">
            ${sett.map((nome, g) => `
              <label><span>${GG[g].slice(0, 3)}</span>
                <select data-sett="${s}" data-giorno="${g}">${r.giornate.map((gi) => `<option ${gi.nome === nome ? "selected" : ""}>${escapeHTML(gi.nome)}</option>`).join("")}</select>
              </label>`).join("")}
          </div>`).join("")}
      </section>
      <section class="settings-section">
        <h2>Le giornate (${r.giornate.length})</h2>
        ${r.giornate.map((gi, i) => `
          <details class="import-giornata" ${i === 0 ? "open" : ""}>
            <summary>${escapeHTML(gi.nome)}${gi.kcal ? ` · ${gi.kcal} kcal` : ""}</summary>
            ${CAMPI_IMPORTAZIONE.map(([k, etichetta]) => `
              <label class="editor-campo"><span>${etichetta}</span>
                <textarea rows="${Math.min(8, Math.max(2, String(gi[k] || "").split("\n").length + 1))}" data-giornata="${i}" data-campo="${k}">${escapeHTML(gi[k] || "")}</textarea></label>`).join("")}
            <label class="editor-campo"><span>Calorie della giornata (facoltative)</span>
              <input type="number" min="0" max="9999" data-giornata="${i}" data-campo="kcal" value="${gi.kcal || ""}"></label>
          </details>`).join("")}
      </section>
      <section class="settings-section">
        <h2>Quando inizia</h2>
        ${sceltaInizioHTML(lunediCorrenteISO(), 1, r.settimane.map((_, i) => i + 1))}
        ${pianoHaPasti(IMPORTA.ctx.pianoCorrente()) ? `
        <label class="check-riga" style="margin-top:10px;"><input type="checkbox" id="inizio-programma" checked> <span>Se la data è futura, tieni il piano attuale fino ad allora e passa a questo da quel giorno</span></label>` : ""}
      </section>
      <section class="settings-section">
        <h2>Regole generali</h2>
        <textarea id="import-regole" rows="${Math.min(12, r.normeGenerali.length + 2)}" style="width:100%;">${escapeHTML(r.normeGenerali.join("\n"))}</textarea>
        <p class="stat-nota">Una regola per riga.</p>
      </section>
      <section class="settings-section">
        <h2>Sostituzioni</h2>
        ${r.sostituzioni.some((g) => g.calcolata) ? `<p class="hint">⚠️ Alcuni gruppi sono <strong>calcolati</strong> dai coefficienti del documento: verifica le grammature.</p>` : ""}
        <textarea id="import-sostituzioni" rows="${Math.min(10, r.sostituzioni.length + 2)}" style="width:100%;" placeholder="Nome gruppo: opzione 1, opzione 2">${escapeHTML(r.sostituzioni.map((g) => `${g.nome}: ${g.opzioni.join(", ")}`).join("\n"))}</textarea>
        <p class="stat-nota">Un gruppo per riga: nome, due punti, alimenti equivalenti separati da virgole.</p>
      </section>
      <section class="settings-section">
        <p class="hint">${IMPORTA.ctx.paziente ? "Salvando, il tuo piano attuale viene sostituito. Peso e misure restano come sono." : `Salvando, il piano attuale di ${escapeHTML(IMPORTA.piano.pazienteNome || "questo paziente")} viene sostituito. Obiettivo, dati, appuntamenti e misure restano come sono.`}</p>
        <div class="import-azioni">
          <button type="button" class="btn btn--ghost" id="import-annulla">Annulla</button>
          <button type="button" class="btn" id="import-salva">${IMPORTA.ctx.salvaTesto}</button>
        </div>
        ${typeof IMPORTA.rimaste === "number" ? `<p class="stat-nota" style="margin-top:8px;">Importazioni ancora disponibili questo mese: ${IMPORTA.rimaste}.</p>` : ""}
      </section>`;
    collegaIndietroImportazione();
    // le caselle si allungano secondo il testo, anche quando si apre una giornata
    const adatta = (el) => { el.style.height = "auto"; el.style.height = (el.scrollHeight + 2) + "px"; };
    const adattaTutte = () => radiceImport().querySelectorAll(".import-giornata[open] textarea, #import-regole, #import-sostituzioni").forEach(adatta);
    adattaTutte();
    radiceImport().querySelectorAll(".import-giornata").forEach((d) => d.addEventListener("toggle", adattaTutte));
    radiceImport().querySelectorAll("textarea").forEach((el) => el.addEventListener("input", () => adatta(el)));
    radiceImport().querySelectorAll("[data-giornata]").forEach((el) => el.addEventListener("input", () => {
      const gi = r.giornate[Number(el.dataset.giornata)];
      gi[el.dataset.campo] = el.dataset.campo === "kcal" ? (Number(el.value) || null) : el.value;
    }));
    radiceImport().querySelectorAll("[data-sett]").forEach((el) => el.addEventListener("change", () => {
      r.settimane[Number(el.dataset.sett)][Number(el.dataset.giorno)] = el.value;
    }));
    document.getElementById("import-annulla").addEventListener("click", () => IMPORTA.ctx.indietro());
    document.getElementById("import-salva").addEventListener("click", salvaImportazione);
  }

  async function salvaImportazione() {
    const r = IMPORTA.risultato;
    const piano = IMPORTA.ctx.pianoCorrente();
    const GG = window.weekLogic.GIORNI;
    const perNome = new Map(r.giornate.map((g) => [g.nome, g]));
    const nuovo = JSON.parse(JSON.stringify(piano));
    nuovo.settimane = {};
    r.settimane.forEach((sett, s) => {
      nuovo.settimane[String(s + 1)] = sett.map((nome, g) => {
        const gi = perNome.get(nome) || r.giornate[0];
        const giorno = { giorno: GG[g] };
        CAMPI_IMPORTAZIONE.forEach(([k]) => { giorno[k] = String(gi[k] || "").trim() || VUOTI_IMPORTAZIONE[k] || ""; });
        giorno.kcal = gi.kcal || null;
        return giorno;
      });
    });
    nuovo.normeGenerali = document.getElementById("import-regole").value.split("\n").map((x) => x.trim()).filter(Boolean);
    const errori = [];
    nuovo.sostituzioni = document.getElementById("import-sostituzioni").value.split("\n").map((x) => x.trim()).filter(Boolean).map((riga) => {
      const i = riga.indexOf(":");
      const opzioni = i > 0 ? riga.slice(i + 1).split(",").map((o) => o.trim()).filter(Boolean) : [];
      if (i <= 0 || opzioni.length < 2) { errori.push(riga); return null; }
      return { nome: riga.slice(0, i).trim(), opzioni };
    }).filter(Boolean);
    if (errori.length) { mostraToast("Sostituzioni: riga non valida (serve \"Nome: opzione1, opzione2\"): " + errori[0], 5000); return; }
    const esito = validaPiano(nuovo);
    if (!esito.ok) { mostraToast("Non salvato — " + esito.errori[0], 5000); return; }
    const inizio = leggiSceltaInizio();
    if (!inizio.dataInizio) { mostraToast("Indica la data di inizio del piano", 4000); return; }
    if (!confermaSettimanaPartenza(inizio, 1)) return;
    const programma = !!(document.getElementById("inizio-programma") || {}).checked && inizio.dataInizio > oggiISO();
    const domanda = programma ? null : IMPORTA.ctx.conferma(piano);
    if (domanda && !window.confirm(domanda)) return;
    const btn = document.getElementById("import-salva");
    btn.disabled = true;
    try {
      if (programma) {
        // piano successivo programmato: quello attuale resta in uso fino alla data
        const prossimo = { settimane: esito.piano.settimane, normeGenerali: esito.piano.normeGenerali, sostituzioni: esito.piano.sostituzioni,
          dataInizio: inizio.dataInizio, settimanaIniziale: inizio.settimanaIniziale, caricato: Date.now() };
        await window.cloud.salvaPiano(piano.id, { prossimo });
        if (IMPORTA.ctx.paziente) PIANO_ATTIVO.prossimo = prossimo;
        mostraToast(`Nuovo piano programmato: parte ${dataLunga(inizio.dataInizio)}`, 4000);
      } else {
        const campi = Object.assign({}, esito.piano, inizio, IMPORTA.ctx.extra ? IMPORTA.ctx.extra(piano) : {}, { prossimo: null });
        await window.cloud.salvaPiano(piano.id, campi);
        if (IMPORTA.ctx.paziente) Object.assign(PIANO_ATTIVO, campi);
        mostraToast(IMPORTA.ctx.toastOk, 3500);
      }
      if (IMPORTA.pdf) { try { IMPORTA.pdf.destroy(); } catch (e) { /* già chiuso */ } }
      IMPORTA.pdf = null; IMPORTA.inviate = null; IMPORTA.pagine = [];
      IMPORTA.ctx.dopoSalvataggio();
    } catch (err) {
      btn.disabled = false;
      mostraToast(msgErroreScrittura(err, "Salvataggio non riuscito: controlla la connessione"), 4500);
    }
  }

  // =======================================================================
  // LATO PROFESSIONISTA
  // =======================================================================
  function avviaProfessionista(utenteDati) {
    mostraSchermata("professionista");
    if (!window.temaApp) applyTema(localStorage.getItem(LS_KEYS.tema) || "sistema");
    registraServiceWorker();
    vistaProfCorrente = "lista"; segnaVistaProf("lista");
    pazienteSelezionatoId = null;
    PROFILO_PROF = utenteDati || {};
    caricaConfig().then((c) => { CONFIG = c; if (vistaProfCorrente === "lista") renderListaPazienti(); });
    if (unsubProfilo) unsubProfilo();
    unsubProfilo = window.cloud.ascoltaUtente(UID, (dati) => {
      if (!dati) return;
      PROFILO_PROF = dati;
      if (vistaProfCorrente === "lista") renderListaPazienti();
    });

    collegaRichiesteProfessionista();
    let primaLista = true;
    unsubPazienti = window.cloud.ascoltaPazientiProfessionista(UID, (pazienti) => {
      PAZIENTI_PROF = pazienti;
      if (primaLista) { primaLista = false; if (pazienti.length) aggiornaStatisticheInBackground(false); }
      if (vistaProfCorrente === "statistiche") {
        renderStatistiche();
      } else if (vistaProfCorrente === "richieste") {
        renderRichiesteAppuntamento();
      } else if (vistaProfCorrente === "lista") {
        renderListaPazienti();
      } else if (vistaProfCorrente === "editor" && pazienteSelezionatoId) {
        const aggiornato = pazienti.find((p) => p.id === pazienteSelezionatoId);
        if (aggiornato) {
          PIANO_ATTIVO_PROF = aggiornato;
          renderEditorProfessionista();
        } else {
          // Il paziente non esiste più (eliminato, anche da un altro dispositivo).
          renderListaPazienti();
        }
      }
    });

    renderListaPazienti();
  }

  // ---------------------------------------------------------------------
  // Licenza del professionista (scritta dal server dopo il pagamento Stripe)
  // ---------------------------------------------------------------------
  const ETICHETTA_PORTALE = "Cambia piano o gestisci abbonamento";
  const NOMI_PIANO = { prova: "Prova gratuita", base: "Base", studio: "Studio", oltre: "Su misura" };

  function statoLicenza() {
    const l = PROFILO_PROF.licenza || null;
    const usati = PAZIENTI_PROF.length;
    if (!l) return { attiva: false, nome: "Nessuna licenza", usati, max: 0, scadenza: null, motivo: "assente" };
    const scad = l.scadenza && typeof l.scadenza.toDate === "function" ? l.scadenza.toDate()
      : (l.scadenza ? new Date(l.scadenza) : null);
    const scaduta = scad && scad.getTime() < Date.now();
    const attiva = l.stato === "attiva" && !scaduta;
    const max = Number(l.maxPazienti) || 0;
    const fine = l.fineAbbonamento && typeof l.fineAbbonamento.toDate === "function" ? l.fineAbbonamento.toDate() : null;
    return {
      disdetto: !!l.disdetto, fine,
      attiva, nome: NOMI_PIANO[l.piano] || l.piano || "—", piano: l.piano,
      usati, max, scadenza: scad, pieno: usati >= max,
      motivo: attiva ? (usati >= max ? "pieno" : "ok") : "scaduta",
    };
  }

  function formattaDataIt(d) {
    if (!d) return "";
    if (typeof d === "string") { const [a, m, g] = d.split("-").map(Number); d = new Date(a, m - 1, g); }
    return d.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }

  function oggiISO() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  /** Messaggio chiaro quando una scrittura viene rifiutata per licenza non attiva. */
  function msgErroreScrittura(e, fallback) {
    if (e && (e.code === "permission-denied" || e.code === "firestore/permission-denied")) {
      return "Non salvato: la tua licenza non è attiva. Rinnovala da \"I tuoi pazienti\".";
    }
    return fallback;
  }

  function renderBoxLicenzaHTML() {
    const st = statoLicenza();
    // Chi ha un abbonamento Stripe attivo cambia piano SOLO dal portale clienti:
    // ricomprare dal sito creerebbe un secondo abbonamento con doppio addebito.
    const haAbbonamento = !!(PROFILO_PROF.licenza && PROFILO_PROF.licenza.stripeCustomerId);
    const abbonamentoInCorso = haAbbonamento && st.attiva;
    const acquista = (!abbonamentoInCorso && CONFIG.linkAcquisto)
      ? `<a class="btn btn--ghost" href="${escapeHTML(CONFIG.linkAcquisto)}" target="_blank" rel="noopener">${st.piano === "prova" || !st.attiva ? "Scegli un abbonamento" : "Cambia piano"}</a>` : "";
    const portale = abbonamentoInCorso
      ? `<button type="button" class="btn btn--ghost" id="btn-portale-clienti">${ETICHETTA_PORTALE}</button>`
      : (haAbbonamento ? `<button type="button" class="link-btn" id="btn-portale-clienti">Fatture e dati di pagamento</button>` : "");
    let testo;
    if (st.motivo === "assente") testo = "Il tuo account non ha una licenza attiva: puoi consultare i piani ma non crearne o modificarli.";
    else if (!st.attiva) testo = `La tua licenza ${st.nome} è scaduta${st.scadenza ? " il " + st.scadenza.toLocaleDateString("it-IT") : ""}. I tuoi pazienti continuano a vedere il loro piano, ma per modificarlo o aggiungere pazienti serve un abbonamento attivo.`;
    else if (st.pieno) testo = `Hai raggiunto il limite del piano ${st.nome} (${st.max} pazienti). Per aggiungerne altri passa a un piano superiore o elimina un paziente che non segui più.`;
    else if (st.disdetto) testo = `${st.usati} di ${st.max} pazienti · abbonamento disdetto: attivo fino al ${(st.fine || st.scadenza).toLocaleDateString("it-IT")}. Puoi riattivarlo da "${ETICHETTA_PORTALE}".`;
    else testo = `${st.usati} di ${st.max} pazienti${st.scadenza ? " · " + (st.piano === "prova" ? "prova valida fino al " : "rinnovo il ") + st.scadenza.toLocaleDateString("it-IT") : ""}`;
    const classe = (!st.attiva || st.pieno) ? "licenza licenza--avviso" : "licenza";
    return `<section class="${classe}">
        <div class="licenza__testa"><span class="licenza__etichetta">La tua licenza</span><strong>${escapeHTML(st.nome)}</strong></div>
        <p class="licenza__testo">${escapeHTML(testo)}</p>
        ${(acquista || portale) ? `<div class="licenza__azioni">${acquista}${portale}</div>` : ""}
      </section>`;
  }

  /** Porta il professionista al portale Stripe già autenticato (nessuna email da attendere). */
  async function apriPortaleClienti(e) {
    const btn = e && e.currentTarget;
    if (btn) { btn.disabled = true; btn.textContent = "Apertura in corso…"; }
    try {
      const ritorno = location.origin + location.pathname;
      const url = await window.cloud.apriPortaleClienti(ritorno);
      location.href = url;
    } catch (err) {
      console.error("Portale clienti:", err);
      if (CONFIG.linkPortaleClienti) {
        mostraToast("Apertura diretta non riuscita: ti porto alla pagina di accesso del portale.", 4000);
        setTimeout(() => window.open(CONFIG.linkPortaleClienti, "_blank", "noopener"), 800);
      } else {
        mostraToast("Impossibile aprire il portale: controlla la connessione e riprova.", 4000);
      }
      if (btn) { btn.disabled = false; btn.textContent = ETICHETTA_PORTALE; }
    }
  }

  function renderListaPazienti() {
    vistaProfCorrente = "lista"; segnaVistaProf("lista");
    pazienteSelezionatoId = null;
    document.getElementById("prof-header-titolo").textContent = "I tuoi pazienti";

    const contattiMancanti = !(PROFILO_PROF.contatti && (PROFILO_PROF.contatti.email || PROFILO_PROF.contatti.telefono));
    profRoot.innerHTML = `
      ${renderBoxLicenzaHTML()}
      <button type="button" class="btn" id="btn-nuovo-paziente" style="margin-bottom:10px;" ${(statoLicenza().attiva && !statoLicenza().pieno) ? "" : "disabled"}>+ Nuovo paziente</button>
      ${richiesteAttive().length ? `<button type="button" class="avviso-richieste" id="btn-richieste">📅 ${richiesteAttive().length === 1 ? "1 richiesta di appuntamento" : richiesteAttive().length + " richieste di appuntamento"} <span>Apri ›</span></button>` : ""}
      ${PAZIENTI_PROF.length ? `<button type="button" class="btn btn--ghost" id="btn-statistiche" style="margin-bottom:10px;">Andamento dei pazienti</button>` : ""}
      <button type="button" class="btn btn--ghost" id="btn-ricettario" style="margin-bottom:10px;">Ricettario</button>
      <button type="button" class="btn btn--ghost" id="btn-profilo-prof" style="margin-bottom:10px;">I miei dati di contatto</button>
      <button type="button" class="btn btn--ghost" id="btn-aspetto-prof" style="margin-bottom:16px;">Aspetto dell'app</button>
      ${contattiMancanti ? `<p class="hint avviso-profilo">Aggiungi email e telefono in "I miei dati di contatto": i tuoi pazienti vedranno il pulsante Contatta.</p>` : ""}
      ${PAZIENTI_PROF.length === 0 ? `
        <div class="empty">Non hai ancora pazienti. Creane uno con il pulsante qui sopra.</div>
      ` : `
        <div class="lista-pazienti">
          ${PAZIENTI_PROF.map((p) => `
            <button type="button" class="paziente-card" data-id="${p.id}">
              <span class="paziente-card__nome">${escapeHTML(p.pazienteNome || "—")}</span>
              <span class="paziente-card__email">${escapeHTML(p.pazienteEmail || "")}</span>
              ${p.paziente && p.paziente.obiettivo ? `<span class="paziente-card__obiettivo">${escapeHTML(p.paziente.obiettivo)}</span>` : ""}
              ${badgeStatoHTML(p.id)}
              ${APP_PRO.richieste.some((r) => r.pazienteUid === p.pazienteUid) ? `<span class="richiesta-badge">📅 Chiede un appuntamento</span>` : ""}
              ${appuntamentoFuturo(p) ? `<span class="paziente-card__email">Appuntamento: ${escapeHTML(testoQuandoAppuntamento(appuntamentoFuturo(p)))}</span>` : ""}
            </button>
          `).join("")}
        </div>
      `}
    `;

    document.getElementById("btn-nuovo-paziente").addEventListener("click", renderFormNuovoPaziente);
    const btnPortale = document.getElementById("btn-portale-clienti");
    if (btnPortale) btnPortale.addEventListener("click", apriPortaleClienti);
    document.getElementById("btn-profilo-prof").addEventListener("click", renderProfiloProfessionista);
    document.getElementById("btn-aspetto-prof").addEventListener("click", renderAspettoProfessionista);
    document.getElementById("btn-ricettario").addEventListener("click", renderRicettario);
    const btnRich = document.getElementById("btn-richieste");
    if (btnRich) btnRich.addEventListener("click", renderRichiesteAppuntamento);
    const btnStat = document.getElementById("btn-statistiche");
    if (btnStat) btnStat.addEventListener("click", renderStatistiche);
    document.querySelectorAll(".paziente-card").forEach((btn) => {
      btn.addEventListener("click", () => apriEditorPaziente(btn.dataset.id));
    });
  }

  // ---------------------------------------------------------------------
  // Statistiche dei pazienti (lato professionista)
  // ---------------------------------------------------------------------
  // I calcoli stanno in js/statistiche.js; qui c'è la lettura da Firestore
  // (con una piccola cache: le statistiche non cambiano di minuto in minuto)
  // e l'interfaccia: panoramica di tutti i pazienti e scheda del singolo.
  const STAT = { risultati: {}, caricato: null, inCorso: null, errorePermessi: false };
  const STAT_VALIDITA_MS = 10 * 60 * 1000;
  const ETICHETTE_STATO = {
    rosso: "Da ricontattare",
    giallo: "Da seguire",
    verde: "In linea",
    attesa: "Piano non iniziato",
  };

  function azzeraStatistiche() {
    STAT.risultati = {}; STAT.caricato = null; STAT.inCorso = null; STAT.errorePermessi = false;
  }

  function perc(v) { return v == null ? "—" : Math.round(v * 100) + "%"; }

  function quandoRelativo(chiaveGiorno) {
    if (!chiaveGiorno) return "mai";
    const n = window.statistiche.differenzaGiorni(new Date(), window.statistiche.daChiave(chiaveGiorno));
    if (n <= 0) return "oggi";
    if (n === 1) return "ieri";
    return `${n} giorni fa`;
  }

  function dataDaTimestamp(t) {
    if (!t) return null;
    if (typeof t.toDate === "function") return t.toDate();
    const d = new Date(t);
    return isNaN(d) ? null : d;
  }

  /** Legge (o riusa dalla cache) i dati di tutti i pazienti e calcola le statistiche. */
  function caricaStatistiche(forza) {
    const fresche = STAT.caricato && (Date.now() - STAT.caricato < STAT_VALIDITA_MS);
    const tuttiPresenti = PAZIENTI_PROF.every((p) => STAT.risultati[p.id]);
    if (!forza && fresche && tuttiPresenti) return Promise.resolve();
    if (STAT.inCorso) return STAT.inCorso;
    const S = window.statistiche;
    const daGiorno = S.primoGiornoStorico(new Date());
    STAT.errorePermessi = false;
    STAT.inCorso = Promise.all(PAZIENTI_PROF.filter((p) => p.pazienteUid).map(async (p) => {
      try {
        const { utente, spunte } = await window.cloud.leggiDatiStatistiche(p.pazienteUid, daGiorno);
        const u = utente || {};
        const creato = dataDaTimestamp(u.creato);
        const inizioPiano = p.dataInizio || CONFIG.startDate || null;
        const inizioCreazione = creato ? S.chiave(creato) : null;
        const inizio = [inizioPiano, inizioCreazione].filter(Boolean).sort().pop() || null;
        STAT.risultati[p.id] = {
          r: S.calcola({
            spunte, inizio,
            ultimoAccesso: dataDaTimestamp(u.ultimoAccesso),
            notificheAttive: !!u.notificheAttive,
            dispositiviNotifiche: Array.isArray(u.fcmTokens) ? u.fcmTokens.length : 0,
            prossimaVisita: (p.appuntamento && p.appuntamento.data) || p.prossimaVisita || null,
          }),
          accessoRilevato: !!u.ultimoAccesso,
        };
      } catch (e) {
        console.error("Statistiche paziente", p.id, e);
        const permessi = !!(e && (e.code === "permission-denied" || e.code === "firestore/permission-denied"));
        if (permessi) STAT.errorePermessi = true;
        STAT.risultati[p.id] = { errore: true, permessi };
      }
    })).then(() => {
      STAT.caricato = Date.now();
    }).finally(() => {
      STAT.inCorso = null;
    });
    return STAT.inCorso;
  }

  /** Aggiorna la vista corrente quando le statistiche sono pronte. */
  function aggiornaStatisticheInBackground(forza) {
    caricaStatistiche(forza).then(() => {
      if (vistaProfCorrente === "lista") renderListaPazienti();
      else if (vistaProfCorrente === "statistiche") renderStatistiche();
      else if (vistaProfCorrente === "statPaziente" && pazienteSelezionatoId) renderStatistichePaziente(pazienteSelezionatoId);
    });
  }

  function badgeStatoHTML(pianoId) {
    const x = STAT.risultati[pianoId];
    if (!x || x.errore) return "";
    const r = x.r;
    const testo = r.stato === "attesa" ? ETICHETTE_STATO.attesa
      : `${ETICHETTE_STATO[r.stato]} · 7 giorni ${perc(r.aderenza7)}`;
    return `<span class="stato-badge stato-badge--${r.stato}"><span class="stato-punto" aria-hidden="true"></span>${escapeHTML(testo)}</span>`;
  }

  function testoNotifiche(n) {
    return n === "attive" ? "Promemoria attivi" : n === "disattivate" ? "Promemoria disattivati" : "Promemoria senza dispositivo";
  }

  function renderStatistiche() {
    vistaProfCorrente = "statistiche"; segnaVistaProf("statistiche");
    pazienteSelezionatoId = null;
    document.getElementById("prof-header-titolo").textContent = "Andamento dei pazienti";

    const pronti = PAZIENTI_PROF.filter((p) => STAT.risultati[p.id] && !STAT.risultati[p.id].errore);
    const conteggi = { rosso: 0, giallo: 0, verde: 0, attesa: 0 };
    pronti.forEach((p) => { conteggi[STAT.risultati[p.id].r.stato]++; });
    const valutabili = pronti.map((p) => STAT.risultati[p.id].r.aderenza7).filter((v) => v != null);
    const media7 = valutabili.length ? valutabili.reduce((a, b) => a + b, 0) / valutabili.length : null;

    const ordinati = PAZIENTI_PROF.slice().sort((a, b) => {
      const ra = STAT.risultati[a.id], rb = STAT.risultati[b.id];
      const oa = ra && ra.r ? window.statistiche.ORDINE_STATO[ra.r.stato] : 9;
      const ob = rb && rb.r ? window.statistiche.ORDINE_STATO[rb.r.stato] : 9;
      if (oa !== ob) return oa - ob;
      const va = ra && ra.r && ra.r.aderenza7 != null ? ra.r.aderenza7 : 2;
      const vb = rb && rb.r && rb.r.aderenza7 != null ? rb.r.aderenza7 : 2;
      return va - vb;
    });

    const inCaricamento = !!STAT.inCorso || (!STAT.caricato && PAZIENTI_PROF.length > 0);
    const aggiornato = STAT.caricato ? new Date(STAT.caricato).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : null;

    profRoot.innerHTML = `
      <div class="nav-riga">${navLink("btn-torna-lista", "pazienti", "I tuoi pazienti", true)}</div>
      ${(() => {
        const n = PAZIENTI_PROF.filter((p) => STAT.risultati[p.id] && STAT.risultati[p.id].errore).length;
        return n ? `<p class="hint avviso-profilo">${n === 1 ? "I dati di un paziente non sono leggibili" : `I dati di ${n} pazienti non sono leggibili`}: trovi i dettagli nella sua scheda qui sotto.</p>` : "";
      })()}
      ${PAZIENTI_PROF.length === 0 ? `<div class="empty">Quando avrai dei pazienti, qui vedrai come seguono il piano.</div>` : `
        <section class="stat-sintesi">
          <div class="stat-sintesi__num"><strong>${perc(media7)}</strong><span>aderenza media negli ultimi 7 giorni</span></div>
          <div class="stat-sintesi__stati">
            <span class="stato-badge stato-badge--rosso"><span class="stato-punto"></span>${conteggi.rosso} da ricontattare</span>
            <span class="stato-badge stato-badge--giallo"><span class="stato-punto"></span>${conteggi.giallo} da seguire</span>
            <span class="stato-badge stato-badge--verde"><span class="stato-punto"></span>${conteggi.verde} in linea</span>
            ${conteggi.attesa ? `<span class="stato-badge stato-badge--attesa"><span class="stato-punto"></span>${conteggi.attesa} non iniziati</span>` : ""}
          </div>
        </section>
        <div class="stat-aggiorna">
          <span>${inCaricamento ? "Caricamento in corso…" : aggiornato ? `Aggiornate alle ${aggiornato}` : ""}</span>
          <button type="button" class="link-btn" id="btn-aggiorna-stat" ${inCaricamento ? "disabled" : ""}>Aggiorna</button>
        </div>
        <div class="lista-pazienti">
          ${ordinati.map((p) => {
            const x = STAT.risultati[p.id];
            if (!x) return `<div class="stat-card"><span class="paziente-card__nome">${escapeHTML(p.pazienteNome || "—")}</span><span class="stat-card__piede">Caricamento…</span></div>`;
            if (x.errore) return `<div class="stat-card stat-card--illeggibile">
                <span class="paziente-card__nome">${escapeHTML(p.pazienteNome || "—")}</span>
                <span class="stat-card__motivo">${x.permessi
                  ? "Il profilo di questo paziente non risulta più collegato a te: l'account potrebbe essere stato eliminato o scollegato. Se non ti serve più, puoi rimuovere il piano."
                  : "Dati non disponibili in questo momento: riprova con Aggiorna."}</span>
                ${x.permessi ? `<button type="button" class="link-btn link-btn--sinistra" data-rimuovi-piano="${escapeHTML(p.id)}">Rimuovi questo piano</button>` : ""}
              </div>`;
            const r = x.r;
            return `
              <button type="button" class="stat-card stat-card--${r.stato}" data-stat-id="${p.id}">
                <span class="stat-card__testa">
                  <span class="paziente-card__nome">${escapeHTML(p.pazienteNome || "—")}</span>
                  <span class="stato-badge stato-badge--${r.stato}"><span class="stato-punto"></span>${ETICHETTE_STATO[r.stato]}</span>
                </span>
                ${r.motivi.length && r.stato !== "verde" ? `<span class="stat-card__motivo">${escapeHTML(r.motivi[0])}</span>` : ""}
                <span class="stat-card__numeri">
                  <span><strong>${perc(r.aderenza7)}</strong> 7 giorni</span>
                  <span><strong>${perc(r.aderenza30)}</strong> 30 giorni</span>
                  <span><strong>${r.serie}</strong> ${r.serie === 1 ? "giorno" : "giorni"} di fila</span>
                </span>
                <span class="stat-card__piede">Ultima attività: ${quandoRelativo(r.ultimaInterazione)} · ${testoNotifiche(r.notifiche)}</span>
              </button>`;
          }).join("")}
        </div>
        <p class="stat-nota">L'aderenza si calcola sui giorni già conclusi: un pasto fatto vale 1 punto, uno fatto in parte 0,5, uno saltato o non segnato 0. Una giornata è rispettata con almeno ${window.statistiche.SOGLIA_GIORNO_OK} punti su 5. Il paziente è da ricontattare se non apre l'app e non segna pasti da più di ${window.statistiche.GIORNI_ALLARME} giorni.</p>
      `}
    `;

    document.getElementById("btn-torna-lista").addEventListener("click", renderListaPazienti);
    const agg = document.getElementById("btn-aggiorna-stat");
    if (agg) agg.addEventListener("click", () => { aggiornaStatisticheInBackground(true); renderStatistiche(); });
    profRoot.querySelectorAll("[data-stat-id]").forEach((b) => b.addEventListener("click", () => renderStatistichePaziente(b.dataset.statId)));
    profRoot.querySelectorAll("[data-rimuovi-piano]").forEach((b) => b.addEventListener("click", () => {
      PIANO_ATTIVO_PROF = PAZIENTI_PROF.find((p) => p.id === b.dataset.rimuoviPiano) || null;
      apriConfermaEliminazione();
    }));
    if (!STAT.caricato && !STAT.inCorso && PAZIENTI_PROF.length) aggiornaStatisticheInBackground(false);
  }

  function messaggioIncoraggiamento(piano, r) {
    const nome = (piano.pazienteNome || "").trim().split(/\s+/)[0] || "";
    const saluto = nome ? `Ciao ${nome}` : "Ciao";
    if (r.stato === "rosso") return `${saluto}, come stai? Ho visto che negli ultimi giorni non hai usato l'app del piano: va tutto bene? Se qualcosa non funziona o vuoi rivedere il piano insieme, scrivimi pure.`;
    if (r.stato === "giallo") return `${saluto}, come procede con il piano? Se qualche pasto ti crea difficoltà possiamo trovare insieme un'alternativa. Ricordati di segnare i pasti nell'app: mi aiuta a seguirti meglio.`;
    if (r.serie >= 3) return `${saluto}, complimenti: stai seguendo il piano con costanza da ${r.serie} giorni di fila! Continua così.`;
    return `${saluto}, come va con il piano? Ricordati di segnare i pasti nell'app: mi aiuta a seguirti meglio.`;
  }

  function barraHTML(etichetta, valore, nota) {
    return `
      <div class="stat-barra">
        <span class="stat-barra__etichetta">${escapeHTML(etichetta)}</span>
        <span class="stat-barra__traccia"><span class="stat-barra__riempimento" style="width:${valore == null ? 0 : Math.round(valore * 100)}%"></span></span>
        <span class="stat-barra__valore">${nota != null ? escapeHTML(nota) : perc(valore)}</span>
      </div>`;
  }

  /** Barra di un pasto divisa in fatto / in parte / saltato / non segnato; il numero è il punteggio. */
  function barraPastoHTML(etichetta, p) {
    const q = p.quote;
    const tratto = (cls, v) => v ? `<span class="stat-quota stat-quota--${cls}" style="width:${(v * 100).toFixed(1)}%"></span>` : "";
    return `
      <div class="stat-barra" title="${p.conta.fatto} fatti, ${p.conta.diverso || 0} diversi, ${p.conta.parziale} in parte, ${p.conta.saltato} saltati, ${p.conta.nonSegnato} non segnati">
        <span class="stat-barra__etichetta">${escapeHTML(etichetta)}</span>
        <span class="stat-barra__traccia stat-barra__traccia--quote">${q ? tratto("fatto", q.fatto) + tratto("diverso", q.diverso) + tratto("parziale", q.parziale) + tratto("saltato", q.saltato) : ""}</span>
        <span class="stat-barra__valore">${perc(p.valore)}</span>
      </div>`;
  }

  /** Una nota scritta dal paziente su un pasto non come da piano (registro dettagliato). */
  function notaPazienteHTML(n) {
    const S = window.statistiche;
    const GIORNI_SETT = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
    const d = S.daChiave(n.giorno);
    const quando = `${GIORNI_SETT[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
    return `<li class="stat-nota-pasto"><span class="stat-nota-pasto__testa">${quando} · ${escapeHTML(MEAL_META[n.pasto].label)} · ${n.stato === "diverso" ? "fatto diversamente" : n.stato === "parziale" ? "in parte" : "saltato"}${n.motivo ? ` · ${escapeHTML(S.MOTIVI[n.motivo].toLowerCase())}` : ""}</span><span>“${escapeHTML(n.nota)}”</span></li>`;
  }

  /** Riepilogo dei pasti fatti in parte o saltati, con i motivi indicati dal paziente. */
  function imprevistiHTML(r) {
    const S = window.statistiche;
    const im = r.imprevisti;
    if (!im || (!(im.diverso && im.diverso.totale) && !im.parziale.totale && !im.saltato.totale)) return "";
    const riga = (gruppo, titolo) => {
      if (!gruppo.totale) return "";
      const pasti = Object.entries(gruppo.perPasto).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${MEAL_META[k].label.toLowerCase()} ${n}`).join(", ");
      const motivi = Object.entries(gruppo.motivi).sort((a, b) => b[1] - a[1])
        .map(([m, n]) => `${escapeHTML(S.MOTIVI[m])} (${n})`).join(", ");
      return `
        <div class="stat-imprevisto">
          <p class="stat-riga"><span>${titolo}</span><strong>${gruppo.totale}</strong></p>
          <p class="stat-nota" style="margin:4px 0 0;">Quali: ${escapeHTML(pasti)}.${motivi ? ` Motivi indicati: ${motivi}.` : ""}</p>
        </div>`;
    };
    return `
      <section class="settings-section">
        <h2>Pasti non come da piano (30 giorni, oggi compreso)</h2>
        ${im.diverso ? riga(im.diverso, "Fatti diversamente") : ""}
        ${riga(im.parziale, "Fatti in parte")}
        ${riga(im.saltato, "Saltati")}
        <p class="stat-riga" id="riga-consigli-ai" hidden></p>
      </section>`;
  }

  function renderStatistichePaziente(id) {
    const piano = PAZIENTI_PROF.find((p) => p.id === id);
    const x = STAT.risultati[id];
    if (!piano || !x || x.errore) { renderStatistiche(); return; }
    vistaProfCorrente = "statPaziente"; segnaVistaProf("statPaziente");
    pazienteSelezionatoId = id;
    const r = x.r;
    document.getElementById("prof-header-titolo").textContent = piano.pazienteNome || "Paziente";

    const GIORNI_BREVI = ["L", "M", "M", "G", "V", "S", "D"];
    const livello = (f) => f == null ? "vuoto" : f >= 4 ? "alto" : f >= 2 ? "medio" : f > 0 ? "basso" : "zero";
    const pc = r.prossimoControllo;
    const testoControllo = !pc ? "Non impostato"
      : pc.traGiorni > 1 ? `Tra ${pc.traGiorni} giorni` : pc.traGiorni === 1 ? "Domani" : pc.traGiorni === 0 ? "Oggi"
      : `Passato da ${-pc.traGiorni} ${pc.traGiorni === -1 ? "giorno" : "giorni"}`;
    const messaggio = messaggioIncoraggiamento(piano, r);

    profRoot.innerHTML = `
      <div class="nav-riga">${navLink("btn-torna-stat", "andamento", "Andamento dei pazienti", true)}${navLink("btn-piano-da-stat-su", "piano", "Piano del paziente", false)}</div>

      <section class="analisi-ai" id="analisi-ai" aria-live="polite">${analisiAttesaHTML()}</section>

      <section class="stat-testata stat-card--${r.stato}">
        <span class="stato-badge stato-badge--${r.stato}"><span class="stato-punto"></span>${ETICHETTE_STATO[r.stato]}</span>
        ${r.motivi.length ? `<ul class="stat-motivi">${r.motivi.map((m) => `<li>${escapeHTML(m)}</li>`).join("")}</ul>` : `<p class="stat-motivi">Segue il piano con regolarità e ha i promemoria attivi.</p>`}
      </section>

      <div class="stat-riquadri">
        <div class="stat-riquadro"><strong>${perc(r.aderenza7)}</strong><span>Aderenza 7 giorni</span></div>
        <div class="stat-riquadro"><strong>${perc(r.aderenza30)}</strong><span>Aderenza 30 giorni</span></div>
        <div class="stat-riquadro"><strong>${r.serie}</strong><span>Giorni di fila rispettati (record ${r.record})</span></div>
        <div class="stat-riquadro"><strong>${String(r.fattiOggi).replace(".", ",")}/5</strong><span>Punti di oggi (fatto 1, in parte 0,5)</span></div>
      </div>

      <section class="settings-section">
        <h2>Ultime 4 settimane</h2>
        <div class="stat-calendario" role="img" aria-label="Pasti segnati giorno per giorno nelle ultime 4 settimane">
          ${GIORNI_BREVI.map((g) => `<span class="stat-calendario__intestazione">${g}</span>`).join("")}
          ${r.calendario.map((c) => `<span class="stat-giorno stat-giorno--${livello(c.fatti)} ${c.oggi ? "is-oggi" : ""}" title="${c.chiave}: ${c.fatti == null ? "non valutato" : String(c.fatti).replace(".", ",") + " punti su 5"}">${c.giorno}</span>`).join("")}
        </div>
        <p class="stat-legenda">
          <span class="stat-giorno stat-giorno--alto"></span> 4–5 punti
          <span class="stat-giorno stat-giorno--medio"></span> 2–3,5
          <span class="stat-giorno stat-giorno--basso"></span> meno di 2
          <span class="stat-giorno stat-giorno--zero"></span> nessuno
        </p>
      </section>

      ${sezionePesoProfHTML(piano)}

      <section class="settings-section">
        <h2>Andamento settimanale</h2>
        <div class="stat-colonne">
          ${r.settimane.map((s) => {
            const d = window.statistiche.daChiave(s.lunedi);
            return `<div class="stat-colonna ${s.inCorso ? "is-corrente" : ""}" title="Settimana dal ${d.toLocaleDateString("it-IT")}: ${perc(s.valore)}">
              <span class="stat-colonna__valore">${s.valore == null ? "" : Math.round(s.valore * 100)}</span>
              <span class="stat-colonna__barra"><span style="height:${s.valore == null ? 0 : Math.max(3, Math.round(s.valore * 100))}%"></span></span>
              <span class="stat-colonna__etichetta">${d.getDate()}/${d.getMonth() + 1}</span>
            </div>`;
          }).join("")}
        </div>
        <p class="stat-nota" style="margin-top:8px;">Percentuale di pasti segnati per settimana, dal lunedì indicato. L'ultima colonna è la settimana in corso.</p>
      </section>

      <section class="settings-section">
        <h2>Pasti negli ultimi 30 giorni</h2>
        ${r.perPasto.map((p) => barraPastoHTML(MEAL_META[p.pasto].label, p)).join("")}
        <p class="stat-legenda stat-legenda--barre">
          <span class="stat-quota stat-quota--fatto"></span> fatto
          <span class="stat-quota stat-quota--diverso"></span> diversamente
          <span class="stat-quota stat-quota--parziale"></span> in parte
          <span class="stat-quota stat-quota--saltato"></span> saltato
          <span class="stat-quota stat-quota--vuoto"></span> non segnato
        </p>
        <div style="height:10px;"></div>
        ${barraHTML("Dal lunedì al venerdì", r.feriali)}
        ${barraHTML("Sabato e domenica", r.weekend)}
      </section>

      ${imprevistiHTML(r)}
      <section class="settings-section" id="sezione-attivita" hidden></section>

      <section class="settings-section">
        <h2>Uso dell'app</h2>
        <p class="stat-riga"><span>Ultima attività</span><strong>${quandoRelativo(r.ultimaInterazione)}</strong></p>
        <p class="stat-riga"><span>Ultimo pasto segnato</span><strong>${quandoRelativo(r.ultimaSpunta)}</strong></p>
        <p class="stat-riga"><span>Promemoria</span><strong>${testoNotifiche(r.notifiche)}</strong></p>
        ${x.accessoRilevato ? "" : `<p class="stat-nota" style="margin-top:8px;">Le aperture dell'app vengono registrate da questo aggiornamento: finché il paziente non riapre l'app, l'ultima attività si basa sui pasti segnati.</p>`}
      </section>

      <section class="settings-section">
        <h2>Prossimo controllo</h2>
        ${appuntamentoDi(piano) ? `
          <p class="stat-riga"><span>${escapeHTML(testoQuandoAppuntamento(appuntamentoDi(piano)))}</span><strong>${testoControllo}</strong></p>
          <p class="stat-nota" style="margin:6px 0 0;">${escapeHTML(MODALITA_APPUNTAMENTO[appuntamentoDi(piano).modalita] || "")}${appuntamentoDi(piano).luogo ? " · " + escapeHTML(appuntamentoDi(piano).luogo) : ""}${appuntamentoDi(piano).note ? " · " + escapeHTML(appuntamentoDi(piano).note) : ""}</p>
        ` : `<p class="stat-riga"><span>${pc ? formattaDataIt(pc.data) : "Nessun appuntamento"}</span><strong>${testoControllo}</strong></p>`}
        <button type="button" class="btn btn--ghost" id="btn-fissa-appuntamento" style="margin-top:10px;">${appuntamentoDi(piano) ? "Modifica l'appuntamento" : "Fissa un appuntamento"}</button>
      </section>

      <section class="settings-section">
        <h2>Scrivi a ${escapeHTML((piano.pazienteNome || "il paziente").split(" ")[0])}</h2>
        <label class="editor-campo">Messaggio (puoi modificarlo)
          <textarea id="testo-incoraggiamento" rows="4">${escapeHTML(messaggio)}</textarea>
        </label>
        <div class="stat-azioni">
          <button type="button" class="btn" id="btn-msg-whatsapp">Invia con WhatsApp</button>
          ${piano.pazienteEmail ? `<button type="button" class="btn btn--ghost" id="btn-msg-email">Invia per email</button>` : ""}
        </div>
      </section>

      <button type="button" class="btn btn--ghost" id="btn-apri-piano-da-stat">Apri il piano di ${escapeHTML((piano.pazienteNome || "questo paziente").split(" ")[0])}</button>
      <section class="settings-section">
        <h2>Report per il preparatore</h2>
        <p class="hint">Un PDF con aderenza al piano, peso e carico di allenamento settimana per settimana, da inviare al preparatore di ${escapeHTML((piano.pazienteNome || "questo paziente").split(" ")[0])}. Note e consigli AI restano esclusi.</p>
        <button type="button" class="btn btn--ghost" id="btn-report-preparatore">Prepara il report</button>
      </section>
      <p class="registro-link"><button type="button" class="link-btn" id="btn-registro-dettagliato">Registro dettagliato (note e consigli AI)</button></p>
    `;

    document.getElementById("btn-torna-stat").addEventListener("click", renderStatistiche);
    document.getElementById("btn-apri-piano-da-stat").addEventListener("click", () => apriEditorPaziente(id));
    document.getElementById("btn-registro-dettagliato").addEventListener("click", () => renderRegistroPaziente(id));
    document.getElementById("btn-report-preparatore").addEventListener("click", () => apriReportPreparatore(piano));
    caricaAttivitaProf(piano);
    document.getElementById("btn-piano-da-stat-su").addEventListener("click", () => apriEditorPaziente(id));
    collegaSezionePesoProf(piano);
    caricaRiscontriProf(piano);
    avviaAnalisiAndamento(piano, r);
    const testo = () => document.getElementById("testo-incoraggiamento").value.trim();
    document.getElementById("btn-msg-whatsapp").addEventListener("click", () => {
      window.open("https://wa.me/?text=" + encodeURIComponent(testo()), "_blank", "noopener");
    });
    const btnEmail = document.getElementById("btn-msg-email");
    if (btnEmail) btnEmail.addEventListener("click", () => {
      location.href = `mailto:${encodeURIComponent(piano.pazienteEmail)}?subject=${encodeURIComponent("Il tuo piano nutrizionale")}&body=${encodeURIComponent(testo())}`;
    });
    document.getElementById("btn-fissa-appuntamento").addEventListener("click", () => apriFissaAppuntamento(piano, null));
  }

  // ---------------------------------------------------------------------
  // Appuntamenti (lato professionista)
  // ---------------------------------------------------------------------
  const APP_PRO = { richieste: [], unsub: null };

  function collegaRichiesteProfessionista() {
    if (APP_PRO.unsub) return;
    APP_PRO.unsub = window.cloud.ascoltaRichiesteProfessionista(UID, (lista) => {
      APP_PRO.richieste = lista.sort((a, b) => ((dataDaTimestamp(a.creata) || 0) - (dataDaTimestamp(b.creata) || 0)));
      if (vistaProfCorrente === "lista") renderListaPazienti();
      else if (vistaProfCorrente === "richieste") renderRichiesteAppuntamento();
    });
  }

  function scollegaRichiesteProfessionista() {
    if (APP_PRO.unsub) { APP_PRO.unsub(); APP_PRO.unsub = null; }
    APP_PRO.richieste = [];
  }

  /** Richieste in attesa dei pazienti ancora presenti (le altre sono residui di pazienti eliminati). */
  function richiesteAttive() {
    return APP_PRO.richieste.filter((r) => PAZIENTI_PROF.some((p) => p.pazienteUid === r.pazienteUid));
  }

  function renderRichiesteAppuntamento() {
    vistaProfCorrente = "richieste"; segnaVistaProf("richieste");
    pazienteSelezionatoId = null;
    document.getElementById("prof-header-titolo").textContent = "Richieste di appuntamento";
    const elenco = richiesteAttive();
    profRoot.innerHTML = `
      <div class="nav-riga">${navLink("btn-torna-lista", "pazienti", "I tuoi pazienti", true)}</div>
      ${elenco.length ? `<div class="lista-pazienti">${elenco.map((r) => {
        const quando = dataDaTimestamp(r.creata);
        return `
          <div class="richiesta-card">
            <p class="richiesta-card__testa"><strong>${escapeHTML(r.pazienteNome || "Paziente")}</strong>
              <span>${quando ? quando.toLocaleDateString("it-IT", { day: "numeric", month: "long" }) : ""}</span></p>
            <p class="richiesta-card__preferenze">${escapeHTML(preferenzeRichiestaTesto(r))}</p>
            ${r.messaggio ? `<p class="richiesta-card__messaggio">“${escapeHTML(r.messaggio)}”</p>` : ""}
            <div class="richiesta-card__azioni">
              <button type="button" class="btn" data-fissa-richiesta="${r.id}">Fissa l'appuntamento</button>
              <button type="button" class="link-btn" data-archivia-richiesta="${r.id}">Segna come gestita</button>
            </div>
          </div>`;
      }).join("")}</div>` : `<div class="empty">Nessuna richiesta in attesa.</div>`}
    `;
    document.getElementById("btn-torna-lista").addEventListener("click", renderListaPazienti);
    profRoot.querySelectorAll("[data-fissa-richiesta]").forEach((b) => b.addEventListener("click", () => {
      const r = APP_PRO.richieste.find((x) => x.id === b.dataset.fissaRichiesta);
      const piano = r && PAZIENTI_PROF.find((p) => p.pazienteUid === r.pazienteUid);
      if (piano) apriFissaAppuntamento(piano, r);
    }));
    profRoot.querySelectorAll("[data-archivia-richiesta]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try { await window.cloud.eliminaRichiestaAppuntamento(b.dataset.archiviaRichiesta); mostraToast("Richiesta archiviata"); }
      catch (e) { b.disabled = false; mostraToast("Non riuscito: controlla la connessione"); }
    }));
  }

  /** Scheda per fissare (o modificare) l'appuntamento di un paziente, eventualmente in risposta a una richiesta. */
  function apriFissaAppuntamento(piano, richiesta) {
    const a = appuntamentoDi(piano) || {};
    const modalita = a.modalita || (richiesta && richiesta.modalita === "online" ? "online" : "studio");
    const contatti = PROFILO_PROF.contatti || {};
    const primoNome = (piano.pazienteNome || "il paziente").split(" ")[0];
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">${appuntamentoDi(piano) ? "Modifica l'appuntamento" : "Fissa un appuntamento"}</h2>
      <p class="sheet__nota">Per ${escapeHTML(piano.pazienteNome || "il paziente")}${richiesta ? ` · preferenze: ${escapeHTML(preferenzeRichiestaTesto(richiesta))}` : ""}</p>
      ${richiesta && richiesta.messaggio ? `<p class="richiesta-card__messaggio" style="margin-top:0;">“${escapeHTML(richiesta.messaggio)}”</p>` : ""}
      <div class="ric-griglia" style="grid-template-columns: 1fr 1fr;">
        <label class="editor-campo" style="grid-column: 1 / -1;">Data<input type="date" id="app-data" value="${escapeHTML(a.data || "")}"></label>
        <label class="editor-campo">Ora<input type="time" id="app-ora" value="${escapeHTML(a.ora || "")}"></label>
        <label class="editor-campo">Durata
          <select id="app-durata">${[30, 45, 60, 90].map((m) => `<option value="${m}" ${(Number(a.durataMin) || 60) === m ? "selected" : ""}>${m} min</option>`).join("")}</select>
        </label>
      </div>
      <div class="ricette-filtri" style="margin-top:12px;" role="radiogroup" aria-label="Modalità">
        <button type="button" class="chip-filtro" data-app-modalita="studio" aria-pressed="${modalita === "studio"}">In studio</button>
        <button type="button" class="chip-filtro" data-app-modalita="online" aria-pressed="${modalita === "online"}">Online</button>
      </div>
      <label class="editor-campo" style="margin-top:4px;"><span id="app-luogo-etichetta">${modalita === "online" ? "Link della videochiamata" : "Indirizzo dello studio"}</span>
        <input type="text" id="app-luogo" maxlength="300" value="${escapeHTML(a.luogo || (modalita === "studio" ? (contatti.studio || "") : ""))}" placeholder="${modalita === "online" ? "https://meet.google.com/…" : "Via…, città"}">
      </label>
      <label class="editor-campo" style="margin-top:10px;">Note per il paziente (facoltative)
        <textarea id="app-note" rows="2" maxlength="500" placeholder="Es. porta le ultime analisi del sangue">${escapeHTML(a.note || "")}</textarea>
      </label>
      <p id="app-errore" class="auth-error" hidden></p>
      <button type="button" class="btn" id="app-salva" style="margin-top:12px;">Salva l'appuntamento</button>
      ${appuntamentoDi(piano) ? `<button type="button" class="btn btn--ghost" id="app-rimuovi">Rimuovi l'appuntamento</button>` : ""}
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
    `);
    let mod = modalita;
    overlay.querySelectorAll("[data-app-modalita]").forEach((b) => b.addEventListener("click", () => {
      const precedente = mod;
      mod = b.dataset.appModalita;
      overlay.querySelectorAll("[data-app-modalita]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      overlay.querySelector("#app-luogo-etichetta").textContent = mod === "online" ? "Link della videochiamata" : "Indirizzo dello studio";
      const luogo = overlay.querySelector("#app-luogo");
      luogo.placeholder = mod === "online" ? "https://meet.google.com/…" : "Via…, città";
      if (precedente !== mod && (luogo.value === (contatti.studio || "") || eLink(luogo.value))) luogo.value = mod === "studio" ? (contatti.studio || "") : "";
    }));

    const salva = async (valore) => {
      const errEl = overlay.querySelector("#app-errore");
      try {
        await window.cloud.salvaPiano(piano.id, { appuntamento: valore, prossimaVisita: valore ? valore.data : null });
        if (richiesta) await window.cloud.eliminaRichiestaAppuntamento(richiesta.id).catch(() => {});
        piano.appuntamento = valore; piano.prossimaVisita = valore ? valore.data : null;
        if (STAT.risultati[piano.id] && STAT.risultati[piano.id].r) {
          STAT.risultati[piano.id].r.prossimoControllo = valore
            ? { data: valore.data, traGiorni: window.statistiche.differenzaGiorni(window.statistiche.daChiave(valore.data), new Date()) } : null;
        }
        return true;
      } catch (e) {
        errEl.textContent = msgErroreScrittura(e, "Non salvato: controlla la connessione e riprova.");
        errEl.hidden = false;
        return false;
      }
    };

    overlay.querySelector("#app-salva").addEventListener("click", async (e) => {
      const data = overlay.querySelector("#app-data").value;
      const ora = overlay.querySelector("#app-ora").value;
      const errEl = overlay.querySelector("#app-errore");
      if (!data || !ora) { errEl.textContent = "Indica data e ora dell'appuntamento."; errEl.hidden = false; return; }
      e.currentTarget.disabled = true;
      const valore = {
        data, ora,
        durataMin: Number(overlay.querySelector("#app-durata").value) || 60,
        modalita: mod,
        luogo: overlay.querySelector("#app-luogo").value.trim().slice(0, 300),
        note: overlay.querySelector("#app-note").value.trim().slice(0, 500),
      };
      if (!(await salva(valore))) { e.currentTarget.disabled = false; return; }
      // Conferma con la possibilità di avvisare subito il paziente
      const testo = `Ciao ${primoNome}, ti confermo il nostro appuntamento: ${testoQuandoAppuntamento(valore).toLowerCase()} (${MODALITA_APPUNTAMENTO[valore.modalita].toLowerCase()}${valore.luogo ? ", " + valore.luogo : ""}).${valore.note ? " " + valore.note.replace(/[.!?]?$/, (x) => x || ".") : ""} Lo trovi anche nell'app, in Impostazioni.`;
      const conferma = apriSheet(`
        <h2 class="sheet__titolo">✓ Appuntamento salvato</h2>
        <p class="sheet__nota">${escapeHTML(primoNome)} lo vede già nell'app. Vuoi avvisarlo anche con un messaggio?</p>
        <button type="button" class="btn" id="app-avvisa-wa">Avvisa con WhatsApp</button>
        ${piano.pazienteEmail ? `<button type="button" class="btn btn--ghost" id="app-avvisa-email">Avvisa per email</button>` : ""}
        <button type="button" class="btn btn--ghost" data-chiudi-sheet>Fatto</button>
      `);
      conferma.querySelector("#app-avvisa-wa").addEventListener("click", () => window.open("https://wa.me/?text=" + encodeURIComponent(testo), "_blank", "noopener"));
      const em = conferma.querySelector("#app-avvisa-email");
      if (em) em.addEventListener("click", () => {
        location.href = `mailto:${encodeURIComponent(piano.pazienteEmail)}?subject=${encodeURIComponent("Il tuo appuntamento")}&body=${encodeURIComponent(testo)}`;
      });
      ridisegnaVistaProfessionista();
    });
    const rim = overlay.querySelector("#app-rimuovi");
    if (rim) rim.addEventListener("click", async () => {
      rim.disabled = true;
      if (await salva(null)) { chiudiSheet(); mostraToast("Appuntamento rimosso"); ridisegnaVistaProfessionista(); }
      else rim.disabled = false;
    });
  }

  function ridisegnaVistaProfessionista() {
    if (vistaProfCorrente === "statPaziente" && pazienteSelezionatoId) renderStatistichePaziente(pazienteSelezionatoId);
    else if (vistaProfCorrente === "richieste") renderRichiesteAppuntamento();
    else if (vistaProfCorrente === "lista") renderListaPazienti();
  }

  // ---------------------------------------------------------------------
  // Ricettario (lato professionista)
  // ---------------------------------------------------------------------
  // Strada principale: caricare le schede già pronte (PDF o foto), anche
  // molte insieme; l'app ricava da sola titolo e anteprima. In alternativa
  // si può scrivere la ricetta nell'app, con ingredienti che il paziente può
  // mandare nella lista della spesa.
  const ETICHETTE_RICETTE = ["Colazione", "Spuntino", "Pranzo", "Cena", "Vegetariana", "Vegana", "Senza glutine", "Senza lattosio", "Meal prep", "Veloce", "Dolce"];
  const MAX_ALLEGATO = 10 * 1024 * 1024;
  const MAX_FILE_INSIEME = 20;
  // Servizio gratuito suggerito per ridurre i PDF troppo pesanti.
  // Nessun rimando a servizi online di compressione: i PDF possono contenere
  // dati personali. Si suggerisce di ridurli con il programma che li ha creati.
  const CONSIGLIO_PDF_PESANTE = "Riducilo dal programma con cui l'hai creato, per esempio salvandolo o esportandolo come PDF con dimensioni ridotte o qualità standard";
  const RICPRO = { elenco: [], unsub: null, pronto: false, bozza: null, gruppo: null };

  function scollegaRicettario() {
    if (RICPRO.unsub) { RICPRO.unsub(); RICPRO.unsub = null; }
    RICPRO.elenco = []; RICPRO.pronto = false; RICPRO.bozza = null; RICPRO.gruppo = null;
  }

  function collegaRicettario() {
    if (RICPRO.unsub) return;
    RICPRO.unsub = window.cloud.ascoltaRicetteProfessionista(UID, (lista) => {
      RICPRO.elenco = lista.sort((a, b) => (a.titolo || "").localeCompare(b.titolo || "", "it"));
      RICPRO.pronto = true;
      if (vistaProfCorrente === "ricettario") renderRicettario();
    });
  }

  function destinatariTesto(r) {
    if (r.visibilita !== "selezionati") return "Tutti i pazienti";
    const nomi = (r.destinatari || []).map((uid) => {
      const p = PAZIENTI_PROF.find((x) => x.pazienteUid === uid);
      return p ? (p.pazienteNome || "").split(" ")[0] : null;
    }).filter(Boolean);
    if (!nomi.length) return "Nessun paziente";
    return nomi.length <= 3 ? nomi.join(", ") : `${nomi.length} pazienti`;
  }

  // ---- pdf.js: legge i PDF per ricavarne l'anteprima della prima pagina ----
  // La libreria è ospitata insieme all'app (js/vendor/pdfjs) e viene caricata
  // solo quando il professionista sceglie un PDF. isEvalSupported: false
  // chiude la falla CVE-2024-4367 delle versioni 3.x.
  let pdfJsPromessa = null;
  function caricaPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfJsPromessa) {
      pdfJsPromessa = new Promise((ok, ko) => {
        const s = document.createElement("script");
        s.src = "js/vendor/pdfjs/pdf.min.js";
        s.onload = () => {
          if (!window.pdfjsLib) { ko(new Error("pdfjs")); return; }
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = "js/vendor/pdfjs/pdf.worker.min.js";
          ok(window.pdfjsLib);
        };
        s.onerror = () => { pdfJsPromessa = null; ko(new Error("pdfjs-non-trovato")); };
        document.head.appendChild(s);
      });
    }
    return pdfJsPromessa;
  }

  /** Immagine JPEG della prima pagina di un PDF (larga circa 900 pixel). */
  async function anteprimaPdf(file) {
    const pdfjs = await caricaPdfJs();
    const dati = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data: dati, isEvalSupported: false }).promise;
    try {
      const pagina = await doc.getPage(1);
      const base = pagina.getViewport({ scale: 1 });
      const vp = pagina.getViewport({ scale: Math.min(3, 900 / base.width) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pagina.render({ canvasContext: ctx, viewport: vp }).promise;
      return await new Promise((ok, ko) => canvas.toBlob((b) => (b ? ok(b) : ko(new Error("conversione"))), "image/jpeg", 0.8));
    } finally {
      doc.destroy();
    }
  }

  function titoloDaNomeFile(nome) {
    let t = String(nome || "").replace(/\.[^.]+$/, "").replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
    if (t && t === t.toUpperCase()) t = t.toLowerCase();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Ricetta";
  }

  /**
   * Prepara un file scelto dal professionista: allegato da caricare e
   * anteprima (prima pagina del PDF, oppure la foto stessa ridotta).
   */
  async function preparaFileRicetta(file) {
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      if (file.size > MAX_ALLEGATO) throw new Error("troppo-grande");
      let foto = null;
      try {
        const blob = await anteprimaPdf(file);
        foto = { blob, nome: "anteprima.jpg", anteprima: URL.createObjectURL(blob), auto: true };
      } catch (e) {
        console.warn("Anteprima PDF non disponibile:", e);
      }
      return { allegato: { blob: file, nome: file.name, tipo: "application/pdf" }, foto };
    }
    if (file.type.startsWith("image/")) {
      const grande = await comprimiImmagine(file, 2200, 0.85);
      const piccola = await comprimiImmagine(file, 1200, 0.8);
      return {
        allegato: { blob: grande, nome: file.name.replace(/\.[^.]+$/, "") + ".jpg", tipo: "image/jpeg" },
        foto: { blob: piccola, nome: "anteprima.jpg", anteprima: URL.createObjectURL(piccola), auto: true },
      };
    }
    throw new Error("formato");
  }

  function messaggioErroreFile(e) {
    const m = e && e.message;
    if (m === "troppo-grande") return "Supera i 10 MB";
    if (m === "formato") return "Formato non supportato: usa PDF o foto";
    return "File non leggibile";
  }

  // ---- Elenco del ricettario ----
  function renderRicettario() {
    vistaProfCorrente = "ricettario"; segnaVistaProf("ricettario");
    pazienteSelezionatoId = null;
    RICPRO.bozza = null;
    document.getElementById("prof-header-titolo").textContent = "Ricettario";
    collegaRicettario();
    const puoScrivere = statoLicenza().attiva;

    profRoot.innerHTML = `
      <div class="nav-riga">${navLink("btn-torna-lista", "pazienti", "I tuoi pazienti", true)}</div>
      <label class="btn ric-carica ${puoScrivere ? "" : "is-disabilitato"}">Carica ricette in PDF o foto
        <input type="file" id="ric-file-multipli" accept="application/pdf,image/*" multiple hidden ${puoScrivere ? "" : "disabled"}>
      </label>
      <p class="stat-nota" style="margin:6px 2px 10px;">Puoi sceglierne più di una insieme: titolo e anteprima li ricava l'app dai file. Massimo 10 MB per file: se un PDF è più pesante, riducilo dal programma con cui l'hai creato.</p>
      <button type="button" class="btn btn--ghost" id="btn-nuova-ricetta" style="margin-bottom:16px;" ${puoScrivere ? "" : "disabled"}>Scrivi una ricetta nell'app</button>
      ${!puoScrivere ? `<p class="stat-nota" style="margin:-6px 2px 14px;">Per aggiungere o modificare ricette serve una licenza attiva.</p>` : ""}
      ${!RICPRO.pronto ? `<div class="empty">Caricamento…</div>`
        : RICPRO.elenco.length === 0 ? `<div class="empty">Qui raccogli le ricette da proporre ai tuoi pazienti.</div>`
        : `<div class="lista-pazienti">
            ${RICPRO.elenco.map((r) => `
              <button type="button" class="ricetta-riga" data-ricetta-pro="${r.id}">
                <span class="ricetta-riga__foto ${r.foto && r.foto.auto ? "is-pagina" : ""}" ${r.foto && r.foto.url ? `style="background-image:url('${escapeHTML(r.foto.url)}')"` : ""}>${r.foto && r.foto.url ? "" : (r.allegato ? "📄" : "🍲")}</span>
                <span class="ricetta-riga__testo">
                  <span class="paziente-card__nome">${escapeHTML(r.titolo || "Senza titolo")}</span>
                  <span class="paziente-card__email">${escapeHTML(destinatariTesto(r))}${(r.etichette || []).length ? " · " + escapeHTML(r.etichette.slice(0, 3).join(", ")) : ""}</span>
                </span>
              </button>`).join("")}
          </div>`}
    `;
    document.getElementById("btn-torna-lista").addEventListener("click", renderListaPazienti);
    document.getElementById("btn-nuova-ricetta").addEventListener("click", () => apriEditorRicetta(null));
    document.getElementById("ric-file-multipli").addEventListener("change", (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      if (files.length) avviaCaricamentoMultiplo(files);
    });
    profRoot.querySelectorAll("[data-ricetta-pro]").forEach((b) => b.addEventListener("click", () => apriEditorRicetta(b.dataset.ricettaPro)));
  }

  // ---- Caricamento di più schede insieme ----
  function avviaCaricamentoMultiplo(files) {
    if (!RICPRO.gruppo) {
      RICPRO.gruppo = { voci: [], etichette: [], altre: "", visibilita: "tutti", destinatari: [], inCorso: false };
    }
    const g = RICPRO.gruppo;
    const spazio = MAX_FILE_INSIEME - g.voci.length;
    if (files.length > spazio) mostraToast(`Puoi caricare al massimo ${MAX_FILE_INSIEME} file per volta`, 3500);
    files.slice(0, Math.max(0, spazio)).forEach((file) => {
      const voce = { chiave: Math.random().toString(36).slice(2), file, titolo: titoloDaNomeFile(file.name), stato: "preparazione", prep: null, errore: "" };
      g.voci.push(voce);
      preparaFileRicetta(file)
        .then((prep) => { voce.prep = prep; voce.stato = "pronto"; })
        .catch((e) => { voce.stato = "errore"; voce.errore = messaggioErroreFile(e); voce.codice = e && e.message; })
        .finally(() => aggiornaVoceGruppo(voce));
    });
    renderCaricamentoMultiplo();
  }

  function statoVoceHTML(v) {
    if (v.stato === "preparazione") return "Preparazione dell'anteprima…";
    if (v.stato === "pronto") return v.file.type === "application/pdf" || /\.pdf$/i.test(v.file.name) ? `PDF · ${dimensioneFile(v.file.size)}` : "Foto";
    if (v.stato === "caricamento") return `Caricamento… ${Math.round((v.progresso || 0) * 100)}%`;
    if (v.stato === "fatto") return "✓ Pubblicata";
    if (v.codice === "troppo-grande") {
      return `<span style="color:var(--stato-rosso)">Supera i 10 MB.</span> ${CONSIGLIO_PDF_PESANTE}.
        <label class="link-inline">poi scegli il file compresso<input type="file" data-sostituisci-voce="${v.chiave}" accept="application/pdf" hidden></label>`;
    }
    return `<span style="color:var(--stato-rosso)">${escapeHTML(v.errore || "Errore")}</span>`;
  }

  /** Sostituisce il file di una voce (es. con la versione compressa), tenendo il titolo. */
  function sostituisciFileVoce(chiave, file) {
    const g = RICPRO.gruppo;
    const v = g && g.voci.find((x) => x.chiave === chiave);
    if (!v || !file) return;
    v.file = file; v.stato = "preparazione"; v.prep = null; v.errore = ""; v.codice = null;
    aggiornaVoceGruppo(v);
    preparaFileRicetta(file)
      .then((prep) => { v.prep = prep; v.stato = "pronto"; })
      .catch((e) => { v.stato = "errore"; v.errore = messaggioErroreFile(e); v.codice = e && e.message; })
      .finally(() => aggiornaVoceGruppo(v));
  }

  function dimensioneFile(byte) {
    return byte >= 1048576 ? (byte / 1048576).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(byte / 1024)) + " KB";
  }

  function aggiornaVoceGruppo(v) {
    const riga = document.querySelector(`[data-voce="${v.chiave}"]`);
    if (!riga) return;
    const mini = riga.querySelector(".ric-voce__mini");
    const foto = v.prep && v.prep.foto;
    mini.style.backgroundImage = foto ? `url('${foto.anteprima}')` : "";
    mini.textContent = foto ? "" : (v.stato === "errore" ? "⚠️" : "📄");
    riga.querySelector(".ric-voce__stato").innerHTML = statoVoceHTML(v);
    riga.classList.toggle("is-fatta", v.stato === "fatto");
    aggiornaPulsantePubblica();
  }

  function aggiornaPulsantePubblica() {
    const btn = document.getElementById("ric-pubblica-gruppo");
    if (!btn || !RICPRO.gruppo) return;
    const g = RICPRO.gruppo;
    const pronte = g.voci.filter((v) => v.stato === "pronto").length;
    const inPreparazione = g.voci.some((v) => v.stato === "preparazione");
    btn.disabled = g.inCorso || inPreparazione || pronte === 0;
    btn.textContent = g.inCorso ? "Pubblicazione in corso…"
      : inPreparazione ? "Preparazione dei file…"
      : pronte === 1 ? "Pubblica 1 ricetta" : `Pubblica ${pronte} ricette`;
  }

  function sceltaDestinatariHTML(prefisso, visibilita, selezionati) {
    return `
      <label class="ric-scelta"><input type="radio" name="${prefisso}-visibilita" value="tutti" ${visibilita === "selezionati" ? "" : "checked"}> Tutti i miei pazienti, anche quelli futuri</label>
      <label class="ric-scelta"><input type="radio" name="${prefisso}-visibilita" value="selezionati" ${visibilita === "selezionati" ? "checked" : ""}> Solo i pazienti che scelgo</label>
      <div id="${prefisso}-destinatari" class="ric-destinatari" ${visibilita === "selezionati" ? "" : "hidden"}>
        ${PAZIENTI_PROF.filter((p) => p.pazienteUid).map((p) => `
          <label class="ric-scelta"><input type="checkbox" value="${escapeHTML(p.pazienteUid)}" ${selezionati.has(p.pazienteUid) ? "checked" : ""}> ${escapeHTML(p.pazienteNome || p.pazienteEmail || "Paziente")}</label>`).join("") || `<p class="stat-nota">Non hai ancora pazienti.</p>`}
      </div>`;
  }

  function sceltaEtichetteHTML(prefisso, scelte, altre) {
    return `
      <div class="ricette-filtri">
        ${ETICHETTE_RICETTE.map((e) => `<button type="button" class="chip-filtro" data-${prefisso}-etichetta="${escapeHTML(e)}" aria-pressed="${scelte.includes(e)}">${escapeHTML(e)}</button>`).join("")}
      </div>
      <label class="editor-campo" style="margin-top:10px;">Altre etichette, separate da virgola
        <input type="text" id="${prefisso}-altre-etichette" maxlength="120" value="${escapeHTML(altre)}" placeholder="Es. Estiva, Proteica">
      </label>`;
  }

  function leggiEtichette(prefisso) {
    const scelte = Array.from(profRoot.querySelectorAll(`[data-${prefisso}-etichetta]`))
      .filter((x) => x.getAttribute("aria-pressed") === "true").map((x) => x.getAttribute(`data-${prefisso}-etichetta`));
    const altre = document.getElementById(`${prefisso}-altre-etichette`).value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8);
    return Array.from(new Set(scelte.concat(altre)));
  }

  function leggiDestinatari(prefisso) {
    const visibilita = profRoot.querySelector(`input[name="${prefisso}-visibilita"]:checked`).value;
    const destinatari = visibilita === "selezionati"
      ? Array.from(profRoot.querySelectorAll(`#${prefisso}-destinatari input:checked`)).map((x) => x.value) : [];
    return { visibilita, destinatari };
  }

  function collegaSceltePrefisso(prefisso) {
    profRoot.querySelectorAll(`[data-${prefisso}-etichetta]`).forEach((x) => x.addEventListener("click", () => {
      x.setAttribute("aria-pressed", x.getAttribute("aria-pressed") === "true" ? "false" : "true");
    }));
    profRoot.querySelectorAll(`input[name="${prefisso}-visibilita"]`).forEach((x) => x.addEventListener("change", () => {
      document.getElementById(`${prefisso}-destinatari`).hidden = profRoot.querySelector(`input[name="${prefisso}-visibilita"]:checked`).value !== "selezionati";
    }));
  }

  function renderCaricamentoMultiplo() {
    vistaProfCorrente = "ricetteMultiple"; segnaVistaProf("ricetteMultiple");
    const g = RICPRO.gruppo;
    document.getElementById("prof-header-titolo").textContent = "Carica ricette";
    const scelteEt = g.etichette.filter((e) => ETICHETTE_RICETTE.includes(e));

    profRoot.innerHTML = `
      <div class="nav-riga">${navLink("btn-annulla-gruppo", "ricettario", "Ricettario", true)}</div>
      <section class="settings-section">
        <h2>${g.voci.length === 1 ? "1 ricetta" : g.voci.length + " ricette"}</h2>
        <p class="stat-nota" style="margin:0 0 10px;">Controlla i titoli: li ho ricavati dai nomi dei file.</p>
        <div class="ric-voci">
          ${g.voci.map((v) => `
            <div class="ric-voce ${v.stato === "fatto" ? "is-fatta" : ""}" data-voce="${v.chiave}">
              <span class="ric-voce__mini" ${v.prep && v.prep.foto ? `style="background-image:url('${v.prep.foto.anteprima}')"` : ""}>${v.prep && v.prep.foto ? "" : (v.stato === "errore" ? "⚠️" : "📄")}</span>
              <span class="ric-voce__testo">
                <input type="text" class="ric-voce__titolo" data-titolo-voce="${v.chiave}" value="${escapeHTML(v.titolo)}" maxlength="90" aria-label="Titolo della ricetta" ${g.inCorso || v.stato === "fatto" ? "disabled" : ""}>
                <span class="ric-voce__stato">${statoVoceHTML(v)}</span>
              </span>
              ${g.inCorso || v.stato === "fatto" ? "" : `<button type="button" class="ric-voce__togli" data-togli-voce="${v.chiave}" aria-label="Togli ${escapeHTML(v.titolo)}">✕</button>`}
            </div>`).join("")}
        </div>
        ${g.voci.length < MAX_FILE_INSIEME && !g.inCorso ? `<label class="btn btn--ghost ric-file" style="margin-top:10px;">Aggiungi altri file<input type="file" id="ric-altri-file" accept="application/pdf,image/*" multiple hidden></label>` : ""}
      </section>

      <section class="settings-section">
        <h2>Etichette per tutte</h2>
        ${sceltaEtichetteHTML("grp", scelteEt, g.altre)}
      </section>

      <section class="settings-section">
        <h2>Chi le vede</h2>
        ${sceltaDestinatariHTML("grp", g.visibilita, new Set(g.destinatari))}
      </section>

      <p id="grp-stato" class="stat-nota" role="status" style="margin:0 0 10px;"></p>
      <button type="button" class="btn" id="ric-pubblica-gruppo"></button>
    `;
    aggiornaPulsantePubblica();
    collegaSceltePrefisso("grp");

    const ricordaComuni = () => {
      g.etichette = leggiEtichette("grp");
      g.altre = document.getElementById("grp-altre-etichette").value;
      const d = leggiDestinatari("grp");
      g.visibilita = d.visibilita; g.destinatari = d.destinatari;
    };
    document.getElementById("btn-annulla-gruppo").addEventListener("click", () => {
      if (g.inCorso) return;
      RICPRO.gruppo = null;
      renderRicettario();
    });
    profRoot.querySelector(".ric-voci").addEventListener("change", (e) => {
      const inp = e.target.closest("[data-sostituisci-voce]");
      if (inp && inp.files && inp.files[0]) sostituisciFileVoce(inp.dataset.sostituisciVoce, inp.files[0]);
    });
    profRoot.querySelectorAll("[data-titolo-voce]").forEach((inp) => inp.addEventListener("input", () => {
      const v = g.voci.find((x) => x.chiave === inp.dataset.titoloVoce);
      if (v) v.titolo = inp.value;
    }));
    profRoot.querySelectorAll("[data-togli-voce]").forEach((b) => b.addEventListener("click", () => {
      ricordaComuni();
      g.voci = g.voci.filter((x) => x.chiave !== b.dataset.togliVoce);
      if (!g.voci.length) { RICPRO.gruppo = null; renderRicettario(); return; }
      renderCaricamentoMultiplo();
    }));
    const altri = document.getElementById("ric-altri-file");
    if (altri) altri.addEventListener("change", (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      ricordaComuni();
      avviaCaricamentoMultiplo(files);
    });
    document.getElementById("ric-pubblica-gruppo").addEventListener("click", () => {
      ricordaComuni();
      pubblicaGruppo();
    });
  }

  async function pubblicaGruppo() {
    const g = RICPRO.gruppo;
    const stato = document.getElementById("grp-stato");
    if (g.visibilita === "selezionati" && !g.destinatari.length) {
      stato.textContent = "Scegli almeno un paziente, oppure rendi le ricette visibili a tutti.";
      stato.style.color = "var(--stato-rosso)";
      return;
    }
    const daPubblicare = g.voci.filter((v) => v.stato === "pronto");
    g.inCorso = true;
    renderCaricamentoMultiplo();
    const autoreNome = (PROFILO_PROF.contatti && PROFILO_PROF.contatti.nome) || PROFILO_PROF.nome || "";
    let riuscite = 0;
    for (const v of daPubblicare) {
      v.stato = "caricamento"; v.progresso = 0; aggiornaVoceGruppo(v);
      const id = window.cloud.nuovoIdRicetta();
      try {
        let foto = null;
        if (v.prep.foto) {
          const f = await window.cloud.caricaFileRicetta(UID, id, v.prep.foto.nome, v.prep.foto.blob, "image/jpeg",
            (x) => { v.progresso = x * 0.2; aggiornaVoceGruppo(v); });
          foto = Object.assign(f, { auto: true });
        }
        const a = await window.cloud.caricaFileRicetta(UID, id, v.prep.allegato.nome, v.prep.allegato.blob, v.prep.allegato.tipo,
          (x) => { v.progresso = 0.2 + x * 0.8; aggiornaVoceGruppo(v); });
        await window.cloud.salvaRicetta(id, {
          titolo: (v.titolo || "").trim() || titoloDaNomeFile(v.file.name),
          porzioni: null, tempoMin: null, kcal: null, proteine: null, carboidrati: null, grassi: null,
          etichette: g.etichette, ingredienti: [], procedimento: [], note: "",
          visibilita: g.visibilita, destinatari: g.destinatari,
          professionistaUid: UID, autoreNome,
          foto, allegato: Object.assign(a, { nome: v.prep.allegato.nome, tipo: v.prep.allegato.tipo }),
        }, true);
        v.stato = "fatto"; riuscite++;
      } catch (e) {
        console.error("Pubblicazione ricetta:", e);
        v.stato = "errore";
        v.errore = /permission|unauthorized/i.test((e && (e.code || e.message)) || "")
          ? "Non pubblicata: licenza o regole non valide" : "Non pubblicata: riprova";
        v.prep && (v.stato = "errore");
      }
      aggiornaVoceGruppo(v);
    }
    g.inCorso = false;
    const errori = g.voci.filter((v) => v.stato === "errore" && v.prep).length;
    if (!errori) {
      mostraToast(riuscite === 1 ? "Ricetta pubblicata" : `${riuscite} ricette pubblicate`);
      RICPRO.gruppo = null;
      renderRicettario();
    } else {
      // Le non riuscite tornano "pronte" per un nuovo tentativo.
      g.voci.forEach((v) => { if (v.stato === "errore" && v.prep) { v.stato = "pronto"; } });
      renderCaricamentoMultiplo();
      const s = document.getElementById("grp-stato");
      s.textContent = `${riuscite} pubblicate, ${errori} non riuscite: controlla la connessione e tocca di nuovo Pubblica.`;
      s.style.color = "var(--stato-rosso)";
    }
  }

  // ---- Editor di una singola ricetta ----
  function apriEditorRicetta(id) {
    const esistente = id ? RICPRO.elenco.find((r) => r.id === id) : null;
    RICPRO.bozza = {
      id: esistente ? esistente.id : window.cloud.nuovoIdRicetta(),
      nuova: !esistente,
      originale: esistente || null,
      datiIniziali: esistente || null,
      foto: esistente && esistente.foto ? esistente.foto : null,
      allegato: esistente && esistente.allegato ? esistente.allegato : null,
      fotoNuova: null,       // { blob, nome, anteprima, auto }
      allegatoNuovo: null,   // { blob, nome, tipo }
      dettagliAperti: !esistente || !esistente.allegato || !!((esistente.ingredienti || []).length || (esistente.procedimento || []).length),
    };
    renderEditorRicetta();
    window.scrollTo(0, 0);
  }

  function renderEditorRicetta() {
    vistaProfCorrente = "ricettaEditor"; segnaVistaProf("ricettaEditor");
    const b = RICPRO.bozza;
    const r = b.originale || {};
    document.getElementById("prof-header-titolo").textContent = b.nuova ? "Nuova ricetta" : "Modifica ricetta";
    const etichette = r.etichette || [];
    const altre = etichette.filter((e) => !ETICHETTE_RICETTE.includes(e));
    const fotoCorrente = b.fotoNuova || b.foto;
    const anteprimaFoto = b.fotoNuova ? b.fotoNuova.anteprima : (b.foto ? b.foto.url : null);
    const fotoAuto = !!(fotoCorrente && fotoCorrente.auto);
    const allegatoNome = b.allegatoNuovo ? b.allegatoNuovo.nome : (b.allegato ? b.allegato.nome : null);

    profRoot.innerHTML = `
      <div class="nav-riga">${navLink("btn-torna-ricettario", "ricettario", "Ricettario", true)}</div>

      <section class="settings-section">
        <label class="editor-campo">Titolo
          <input type="text" id="ric-titolo" maxlength="90" value="${escapeHTML(r.titolo || "")}" placeholder="Es. Vellutata di zucca e ceci">
        </label>
      </section>

      <section class="settings-section">
        <h2>Scheda della ricetta (PDF o foto)</h2>
        <div class="ric-foto">
          <div class="ric-foto__anteprima ${fotoAuto ? "is-pagina" : ""}" ${anteprimaFoto ? `style="background-image:url('${escapeHTML(anteprimaFoto)}')"` : ""}>${anteprimaFoto ? "" : `<span>${allegatoNome ? "📄" : "Nessun file"}</span>`}</div>
          <div class="ric-foto__azioni">
            ${allegatoNome ? `<span class="stat-nota" style="margin:0;">📎 ${escapeHTML(allegatoNome)}</span>` : ""}
            <label class="btn btn--ghost ric-file">${allegatoNome ? "Sostituisci il file" : "Scegli PDF o foto"}<input type="file" id="ric-allegato-file" accept="application/pdf,image/*" hidden></label>
            ${allegatoNome ? `<button type="button" class="link-btn" id="ric-allegato-togli">Togli il file</button>` : ""}
          </div>
        </div>
        <p id="ric-allegato-stato" class="stat-nota" role="status" style="margin-top:8px;">Massimo 10 MB (se è più pesante, riducilo dal programma con cui l'hai creato). L'anteprima si ricava dalla prima pagina.</p>
      </section>

      <section class="settings-section">
        <h2>Etichette</h2>
        ${sceltaEtichetteHTML("ric", etichette, altre.join(", "))}
      </section>

      <section class="settings-section">
        <h2>Chi la vede</h2>
        ${sceltaDestinatariHTML("ric", r.visibilita, new Set(r.destinatari || []))}
      </section>

      <details class="ric-dettagli" id="ric-dettagli" ${b.dettagliAperti ? "open" : ""}>
        <summary>Aggiungi dettagli (facoltativo)</summary>
        <p class="stat-nota" style="margin:4px 0 16px;">Se scrivi gli ingredienti, il paziente può mandarli nella lista della spesa con un tocco. Se hai caricato un PDF, qui puoi lasciare tutto vuoto.</p>

        <section class="settings-section">
          <h2>Foto del piatto</h2>
          <div class="ric-foto">
            <div class="ric-foto__anteprima" ${anteprimaFoto && !fotoAuto ? `style="background-image:url('${escapeHTML(anteprimaFoto)}')"` : ""}>${anteprimaFoto && !fotoAuto ? "" : "<span>Usa l'anteprima del file</span>"}</div>
            <div class="ric-foto__azioni">
              <label class="btn btn--ghost ric-file">${anteprimaFoto && !fotoAuto ? "Cambia foto" : "Scegli una foto"}<input type="file" id="ric-foto-file" accept="image/*" hidden></label>
              ${anteprimaFoto && !fotoAuto ? `<button type="button" class="link-btn" id="ric-foto-togli">Togli la foto</button>` : ""}
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h2>Dati per porzione</h2>
          <div class="ric-griglia">
            <label class="editor-campo">Porzioni<input type="number" id="ric-porzioni" min="1" max="50" inputmode="numeric" value="${escapeHTML(r.porzioni || "")}"></label>
            <label class="editor-campo">Tempo (minuti)<input type="number" id="ric-tempo" min="1" max="1440" inputmode="numeric" value="${escapeHTML(r.tempoMin || "")}"></label>
            <label class="editor-campo">Kcal<input type="number" id="ric-kcal" min="0" max="5000" inputmode="numeric" value="${escapeHTML(r.kcal || "")}"></label>
            <label class="editor-campo">Proteine (g)<input type="number" id="ric-proteine" min="0" step="0.1" inputmode="decimal" value="${escapeHTML(r.proteine != null ? r.proteine : "")}"></label>
            <label class="editor-campo">Carboidrati (g)<input type="number" id="ric-carboidrati" min="0" step="0.1" inputmode="decimal" value="${escapeHTML(r.carboidrati != null ? r.carboidrati : "")}"></label>
            <label class="editor-campo">Grassi (g)<input type="number" id="ric-grassi" min="0" step="0.1" inputmode="decimal" value="${escapeHTML(r.grassi != null ? r.grassi : "")}"></label>
          </div>
        </section>

        <section class="settings-section">
          <h2>Ingredienti</h2>
          <label class="editor-campo">Uno per riga, con le quantità
            <textarea id="ric-ingredienti" rows="6" placeholder="400 g di zucca&#10;200 g di ceci cotti&#10;1 cipolla">${escapeHTML((r.ingredienti || []).join("\n"))}</textarea>
          </label>
        </section>

        <section class="settings-section">
          <h2>Procedimento</h2>
          <label class="editor-campo">Un passaggio per riga
            <textarea id="ric-procedimento" rows="6" placeholder="Taglia la zucca a cubetti e rosolala con la cipolla.&#10;Aggiungi i ceci e cuoci 20 minuti.">${escapeHTML((r.procedimento || []).join("\n"))}</textarea>
          </label>
          <label class="editor-campo" style="margin-top:10px;">Note
            <textarea id="ric-note" rows="3" maxlength="1000" placeholder="Conservazione, varianti, consigli">${escapeHTML(r.note || "")}</textarea>
          </label>
        </section>
      </details>

      <p id="ric-stato" class="stat-nota" role="status" style="margin:16px 0 10px;"></p>
      <button type="button" class="btn" id="ric-salva">${b.nuova ? "Pubblica la ricetta" : "Salva le modifiche"}</button>
      ${b.nuova ? "" : `<button type="button" class="btn btn--ghost" id="ric-elimina" style="margin-top:10px;">Elimina la ricetta</button>`}
    `;
    collegaSceltePrefisso("ric");

    const leggiModulo = () => {
      const num = (id, dec) => {
        const v = document.getElementById(id).value.trim().replace(",", ".");
        if (v === "") return null;
        const n = dec ? Math.round(Number(v) * 10) / 10 : Math.round(Number(v));
        return isFinite(n) && n >= 0 ? n : null;
      };
      const righe = (id) => document.getElementById(id).value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 80);
      return Object.assign({
        titolo: document.getElementById("ric-titolo").value.trim(),
        porzioni: num("ric-porzioni"), tempoMin: num("ric-tempo"), kcal: num("ric-kcal"),
        proteine: num("ric-proteine", true), carboidrati: num("ric-carboidrati", true), grassi: num("ric-grassi", true),
        etichette: leggiEtichette("ric"),
        ingredienti: righe("ric-ingredienti"),
        procedimento: righe("ric-procedimento"),
        note: document.getElementById("ric-note").value.trim().slice(0, 1000),
      }, leggiDestinatari("ric"));
    };
    // Conserva quanto scritto quando la pagina viene ridisegnata (es. dopo aver scelto un file)
    const ricordaModulo = () => {
      b.originale = Object.assign({}, b.originale || {}, leggiModulo());
      b.dettagliAperti = document.getElementById("ric-dettagli").open;
    };

    document.getElementById("btn-torna-ricettario").addEventListener("click", () => { RICPRO.bozza = null; renderRicettario(); });

    document.getElementById("ric-allegato-file").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      ricordaModulo();
      const stato = document.getElementById("ric-allegato-stato");
      stato.textContent = "Preparazione dell'anteprima…";
      try {
        const prep = await preparaFileRicetta(file);
        b.allegatoNuovo = prep.allegato;
        // L'anteprima del file sostituisce solo un'anteprima automatica, mai una foto scelta a mano.
        const fotoManuale = (b.fotoNuova && !b.fotoNuova.auto) || (!b.fotoNuova && b.foto && !b.foto.auto);
        if (!fotoManuale) { b.fotoNuova = prep.foto; if (!prep.foto) b.foto = null; }
        if (!document.getElementById("ric-titolo").value.trim()) b.originale.titolo = titoloDaNomeFile(file.name);
        renderEditorRicetta();
      } catch (err) {
        stato.innerHTML = err && err.message === "troppo-grande"
          ? `<span style="color:var(--stato-rosso)">Il PDF supera i 10 MB.</span> ${CONSIGLIO_PDF_PESANTE}, poi sceglilo di nuovo con "Scegli PDF o foto".`
          : `<span style="color:var(--stato-rosso)">${escapeHTML(messaggioErroreFile(err))}</span>`;
      }
    });
    const togliAll = document.getElementById("ric-allegato-togli");
    if (togliAll) togliAll.addEventListener("click", () => {
      ricordaModulo();
      b.allegatoNuovo = null; b.allegato = null;
      if (b.fotoNuova && b.fotoNuova.auto) b.fotoNuova = null;
      if (b.foto && b.foto.auto) b.foto = null;
      renderEditorRicetta();
    });

    document.getElementById("ric-foto-file").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      ricordaModulo();
      try {
        const blob = await comprimiImmagine(file, 1600, 0.82);
        b.fotoNuova = { blob, nome: "foto.jpg", anteprima: URL.createObjectURL(blob), auto: false };
        renderEditorRicetta();
      } catch (err) {
        mostraToast("Non riesco a leggere questa immagine: prova con una foto JPG o PNG", 4000);
      }
    });
    const togliFoto = document.getElementById("ric-foto-togli");
    if (togliFoto) togliFoto.addEventListener("click", async () => {
      ricordaModulo();
      b.fotoNuova = null; b.foto = null;
      // Se c'è un PDF, si torna alla sua anteprima automatica
      const pdf = b.allegatoNuovo ? b.allegatoNuovo.blob : null;
      if (pdf && b.allegatoNuovo.tipo === "application/pdf") {
        try { const blob = await anteprimaPdf(pdf); b.fotoNuova = { blob, nome: "anteprima.jpg", anteprima: URL.createObjectURL(blob), auto: true }; } catch (err) { /* nessuna anteprima */ }
      }
      renderEditorRicetta();
    });

    document.getElementById("ric-salva").addEventListener("click", () => salvaRicettaDaEditor(leggiModulo()));
    const elimina = document.getElementById("ric-elimina");
    if (elimina) elimina.addEventListener("click", confermaEliminaRicetta);
  }

  async function salvaRicettaDaEditor(dati) {
    const b = RICPRO.bozza;
    const iniziale = b.datiIniziali || {};
    const stato = document.getElementById("ric-stato");
    const btn = document.getElementById("ric-salva");
    const errore = (msg) => { stato.textContent = msg; stato.style.color = "var(--stato-rosso)"; stato.scrollIntoView({ block: "center" }); };
    if (!dati.titolo) return errore("Scrivi il titolo della ricetta.");
    const haAllegato = !!(b.allegatoNuovo || b.allegato);
    if (!dati.ingredienti.length && !dati.procedimento.length && !haAllegato) {
      return errore("Carica il PDF o la foto della ricetta, oppure scrivi ingredienti e procedimento nei dettagli.");
    }
    if (dati.visibilita === "selezionati" && !dati.destinatari.length) return errore("Scegli almeno un paziente, oppure rendi la ricetta visibile a tutti.");

    btn.disabled = true;
    stato.style.color = "";
    const vecchi = [];
    try {
      if (b.fotoNuova) {
        stato.textContent = "Caricamento dell'immagine…";
        const f = await window.cloud.caricaFileRicetta(UID, b.id, b.fotoNuova.nome, b.fotoNuova.blob, "image/jpeg",
          (x) => { stato.textContent = `Caricamento dell'immagine… ${Math.round(x * 100)}%`; });
        if (iniziale.foto && iniziale.foto.path) vecchi.push(iniziale.foto.path);
        b.foto = Object.assign(f, { auto: !!b.fotoNuova.auto }); b.fotoNuova = null;
      } else if (!b.foto && iniziale.foto && iniziale.foto.path) {
        vecchi.push(iniziale.foto.path);
      }
      if (b.allegatoNuovo) {
        stato.textContent = "Caricamento del file…";
        const a = await window.cloud.caricaFileRicetta(UID, b.id, b.allegatoNuovo.nome, b.allegatoNuovo.blob, b.allegatoNuovo.tipo,
          (x) => { stato.textContent = `Caricamento del file… ${Math.round(x * 100)}%`; });
        if (iniziale.allegato && iniziale.allegato.path) vecchi.push(iniziale.allegato.path);
        b.allegato = Object.assign(a, { nome: b.allegatoNuovo.nome, tipo: b.allegatoNuovo.tipo });
        b.allegatoNuovo = null;
      } else if (!b.allegato && iniziale.allegato && iniziale.allegato.path) {
        vecchi.push(iniziale.allegato.path);
      }

      stato.textContent = "Salvataggio…";
      const autoreNome = (PROFILO_PROF.contatti && PROFILO_PROF.contatti.nome) || PROFILO_PROF.nome || "";
      await window.cloud.salvaRicetta(b.id, Object.assign({}, dati, {
        professionistaUid: UID,
        autoreNome,
        foto: b.foto || null,
        allegato: b.allegato || null,
      }), b.nuova);
      for (const p of vecchi) await window.cloud.eliminaFileRicetta(p);
      mostraToast(b.nuova ? "Ricetta pubblicata" : "Ricetta aggiornata");
      RICPRO.bozza = null;
      renderRicettario();
    } catch (e) {
      console.error("Salvataggio ricetta:", e);
      btn.disabled = false;
      const codice = e && (e.code || e.message || "");
      errore(/permission|unauthorized/i.test(codice)
        ? "Non salvata: controlla che la licenza sia attiva e che le regole di Firestore e di Storage siano pubblicate."
        : /storage-non-disponibile/.test(codice) ? "Non salvata: il caricamento dei file non è disponibile. Ricarica la pagina e riprova."
        : "Non salvata: controlla la connessione e riprova.");
    }
  }

  function confermaEliminaRicetta() {
    const b = RICPRO.bozza;
    const r = b.datiIniziali;
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">Eliminare "${escapeHTML(r.titolo || "questa ricetta")}"?</h2>
      <p class="sheet__nota sheet__nota--attenzione">La ricetta e i suoi file vengono cancellati per sempre e spariscono anche dall'app dei pazienti.</p>
      <button type="button" class="btn" id="conferma-elimina-ricetta">Elimina</button>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
    `);
    overlay.querySelector("#conferma-elimina-ricetta").addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      const percorsi = [r.foto && r.foto.path, r.allegato && r.allegato.path].filter(Boolean);
      try {
        await window.cloud.eliminaRicetta(r.id, percorsi);
        chiudiSheet();
        mostraToast("Ricetta eliminata");
        RICPRO.bozza = null;
        renderRicettario();
      } catch (err) {
        chiudiSheet();
        mostraToast("Non eliminata: controlla la connessione");
      }
    });
  }

  /** Ridimensiona e ricomprime un'immagine in JPEG (toglie anche i dati EXIF, come la posizione GPS). */
  function comprimiImmagine(file, maxLato, qualita) {
    return new Promise((ok, ko) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scala = Math.min(1, maxLato / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scala)), h = Math.max(1, Math.round(img.naturalHeight * scala));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => blob ? ok(blob) : ko(new Error("conversione")), "image/jpeg", qualita);
      };
      img.onerror = () => { URL.revokeObjectURL(url); ko(new Error("immagine-non-leggibile")); };
      img.src = url;
    });
  }

  function apriEditorPaziente(id) {
    pazienteSelezionatoId = id;
    PIANO_ATTIVO_PROF = PAZIENTI_PROF.find((p) => p.id === id);
    EDITOR_PROF.settSel = null;
    EDITOR_PROF.giornoSel = null;
    renderEditorProfessionista();
  }

  function renderEditorProfessionista() {
    vistaProfCorrente = "editor"; segnaVistaProf("editor");
    const piano = PIANO_ATTIVO_PROF;
    if (!piano) { renderListaPazienti(); return; }

    document.getElementById("prof-header-titolo").textContent = piano.pazienteNome || "Paziente";

    const disponibili = [1, 2, 3, 4, 5].filter((n) => Array.isArray(piano.settimane[n]));
    if (typeof EDITOR_PROF.settSel !== "number" || !disponibili.includes(EDITOR_PROF.settSel)) {
      EDITOR_PROF.settSel = disponibili[0] || 1;
    }
    if (typeof EDITOR_PROF.giornoSel !== "number") EDITOR_PROF.giornoSel = 0;

    const pz = piano.paziente || {};

    profRoot.innerHTML = `
      <div class="nav-riga editor-navigazione">
        ${navLink("btn-torna-lista", "pazienti", "I tuoi pazienti", true)}
        ${navLink("btn-andamento-paziente", "andamento", "Andamento", false)}
      </div>

      <section class="settings-section">
        <h2>Dati paziente</h2>
        <div class="card-info">
          <dl>
            <dt>Email di accesso</dt><dd>${escapeHTML(piano.pazienteEmail || "—")}</dd>
          </dl>
        </div>
        <p class="hint" style="margin-top:8px;">L'email di accesso serve per il login e non si modifica da qui.</p>
        <div class="editor-pasti" id="editor-dati-form" style="margin-top:14px;">
          <label class="editor-campo"><span>Nome paziente</span><input type="text" data-campo="nome" value="${escapeHTML(pz.nome || piano.pazienteNome || "")}"></label>
          <label class="editor-campo"><span>Obiettivo</span><input type="text" data-campo="obiettivo" value="${escapeHTML(pz.obiettivo || "")}"></label>
          <label class="editor-campo"><span>Target giornaliero (kcal)</span><input type="number" data-campo="targetKcal" value="${pz.targetKcal != null ? pz.targetKcal : ""}"></label>
          <label class="editor-campo"><span>Nutrizionista (usato solo se non hai compilato "I miei dati di contatto")</span><input type="text" data-campo="nutrizionista" value="${escapeHTML(pz.nutrizionista || "")}"></label>
        </div>
        <div class="ric-griglia" style="margin-top:10px;">
          <label class="editor-campo"><span>Altezza (cm)</span><input type="number" inputmode="decimal" id="editor-altezza" min="100" max="230" step="1" value="${piano.corpo && piano.corpo.altezzaCm ? piano.corpo.altezzaCm : ""}" placeholder="per il BMI"></label>
          <label class="editor-campo"><span>Peso obiettivo (kg)</span><input type="number" inputmode="decimal" id="editor-peso-obiettivo" min="20" max="400" step="0.1" value="${piano.corpo && piano.corpo.pesoObiettivo ? piano.corpo.pesoObiettivo : ""}" placeholder="facoltativo"></label>
        </div>
        <label class="editor-campo" style="margin-top:10px;"><span>Peso e misure nell'app del paziente</span>
          <select id="editor-visibilita-peso">
            ${Object.entries(VISIBILITA_PESO).map(([k, t]) => `<option value="${k}" ${visibilitaPeso(piano) === k ? "selected" : ""}>${escapeHTML(t)}</option>`).join("")}
          </select></label>
        <p class="hint">Per alcuni pazienti vedere spesso il peso non aiuta: scegli tu, caso per caso. Il peso e le misure si registrano nella scheda "Andamento".</p>
        <div style="margin-top:10px;">${sceltaInizioHTML(piano.dataInizio, piano.settimanaIniziale, disponibili.length ? disponibili : [1])}</div>
        ${piano.dataInizio ? "" : `<p class="hint">Se lasci vuota la data vale il calendario generale dell'app.</p>`}
        <button type="button" class="btn" id="btn-salva-dati-paziente" style="margin-top:14px;">Salva dati paziente</button>
      </section>

      <section class="settings-section">
        <h2>Regole generali del piano</h2>
        <p class="hint">Una regola per riga — compaiono nella vista "Oggi" del paziente, sotto "Regole generali del piano". Lascia il campo vuoto se non vuoi mostrarne nessuna.</p>
        <textarea id="editor-norme" rows="6" style="width:100%; box-sizing:border-box; font-family:var(--font-body); font-size:14.5px; color:var(--ink); border:1px solid var(--border); border-radius:var(--radius-s); padding:10px 12px; resize:vertical;">${(piano.normeGenerali || []).map(escapeHTML).join("\n")}</textarea>
        <button type="button" class="btn" id="btn-salva-norme" style="margin-top:10px;">Salva regole</button>
      </section>

      <section class="settings-section">
        <h2>Sostituzioni pasto</h2>
        <p class="hint">Gruppi di alimenti che consideri equivalenti (per calorie, macronutrienti e tipologia) — decisione clinica tua, l'app non la genera da sola. Un gruppo per riga, così: <code class="inline">Nome gruppo: opzione 1, opzione 2, opzione 3</code>. Quando il testo di un pasto del paziente contiene il nome di un'opzione, compare un pulsante "Sostituisci" con le altre opzioni dello stesso gruppo.</p>
        <textarea id="editor-sostituzioni" rows="6" style="width:100%; box-sizing:border-box; font-family:var(--font-body); font-size:14.5px; color:var(--ink); border:1px solid var(--border); border-radius:var(--radius-s); padding:10px 12px; resize:vertical;" placeholder="Fonti proteiche magre: Pollo 150g, Tacchino 150g, Merluzzo 200g, Albume 200g">${(piano.sostituzioni || []).map((g) => escapeHTML(g.nome + ": " + g.opzioni.join(", "))).join("\n")}</textarea>
        <button type="button" class="btn" id="btn-salva-sostituzioni" style="margin-top:10px;">Salva sostituzioni</button>
      </section>

      ${renderEditorPastoHTML(piano, EDITOR_PROF.settSel, EDITOR_PROF.giornoSel, disponibili)}

      ${renderCopiaSettimanaHTML(disponibili)}

      <section class="settings-section">
        <h2>Riscontro AI sui pasti non come da piano</h2>
        <p class="hint">Quando il paziente segna un pasto come fatto diversamente, in parte o saltato, l'app gli mostra sotto il pasto una breve scheda <strong>"Come riequilibrare la giornata"</strong>: l'impatto stimato e, se lo consenti, uno o due piccoli aggiustamenti sui pasti rimasti di oggi.</p>
        <details class="ric-dettagli">
          <summary>Come funziona e cosa non fa mai</summary>
          <ul class="spiegazione-ai">
            <li><strong>Usa solo il tuo piano</strong>: i suggerimenti riguardano alimenti già presenti nei pasti del giorno, nelle tue sostituzioni o nelle indicazioni che scrivi qui sotto. Non cambia il piano e non introduce alimenti nuovi.</li>
            <li><strong>Limiti fissi, sempre</strong>: mai digiuni, mai pasti saltati, mai tagli oltre circa un quarto di un pasto, mai attività fisica o altri comportamenti per "compensare". Il messaggio di fondo è sempre: si riparte dal piano al pasto successivo.</li>
            <li><strong>Stime indicative</strong>: l'impatto (irrilevante, lieve, moderato, rilevante) e i valori sono approssimati e dichiarati come tali al paziente. Gli scambi equivalenti, come mela al posto dei frutti di bosco o mandorle al posto delle noci, o le tue sostituzioni approvate, risultano <strong>irrilevanti</strong>: il paziente vede solo una conferma che va bene così.</li>
            <li><strong>Scostamenti frequenti</strong>: se nell'ultima settimana sono molti, il paziente viene invitato a parlarne con te.</li>
            <li><strong>Privacy</strong>: all'AI arrivano solo i testi dei pasti, lo stato, il motivo e la nota del paziente, in forma pseudonimizzata (senza nome né altri dati identificativi). Il paziente ne è informato al primo accesso all'app.</li>
            <li><strong>Trasparenza</strong>: nella scheda "Andamento" vedi gli ultimi riscontri dati al paziente.</li>
            <li><strong>Quando spegnerlo</strong>: per pazienti con un rapporto difficile con il cibo o per i quali un riscontro su ogni scostamento non è indicato.</li>
          </ul>
        </details>
        <label class="editor-campo" style="margin-top:10px;"><span>Per questo paziente</span>
          <select id="feedback-modo">
            <option value="suggerimenti" ${!piano.feedbackAI || !piano.feedbackAI.modo || piano.feedbackAI.modo === "suggerimenti" ? "selected" : ""}>Attivo: riscontro e piccoli aggiustamenti</option>
            <option value="riscontro" ${piano.feedbackAI && piano.feedbackAI.modo === "riscontro" ? "selected" : ""}>Solo riscontro, senza aggiustamenti</option>
            <option value="spento" ${piano.feedbackAI && piano.feedbackAI.modo === "spento" ? "selected" : ""}>Spento</option>
          </select></label>
        <label class="editor-campo" style="margin-top:8px;">Le tue indicazioni per questi casi (facoltative)
          <textarea id="feedback-indicazioni" rows="3" maxlength="600" placeholder="Es. per recuperare proteine usa yogurt greco o legumi; dopo un dolce nessuna compensazione, torna al piano">${escapeHTML((piano.feedbackAI && piano.feedbackAI.indicazioni) || "")}</textarea></label>
        <button type="button" class="btn" id="btn-salva-feedback" style="margin-top:10px;">Salva riscontro AI</button>
      </section>

      <section class="settings-section">
        <h2>Macronutrienti nella scheda Oggi</h2>
        <p class="hint">Con Premium il paziente vede nella scheda Oggi carboidrati, proteine e grassi <strong>previsti dal piano</strong> per la giornata, che si riempiono man mano che segna i pasti. Sono stime calcolate con l'AI sui testi dei pasti e proporzionate alle calorie che indichi per il giorno. Per i pasti fatti diversamente usa la stima del riscontro.</p>
        <p class="hint">Il riferimento resta sempre il tuo piano: l'app non calcola un fabbisogno e non tiene conto delle calorie "bruciate" con gli allenamenti. Nascondi il riquadro ai pazienti per cui vedere i numeri non è indicato.</p>
        <label class="ric-scelta"><input type="checkbox" id="macro-visibile" ${!(piano.macro && piano.macro.visibile === false) ? "checked" : ""}> Mostra i macronutrienti a questo paziente</label>
        <button type="button" class="btn" id="btn-salva-macro" style="margin-top:10px;">Salva macronutrienti</button>
      </section>

      <section class="settings-section">
        <h2>Meal prep</h2>
        <p class="hint">Nella scheda Spesa il paziente trova le sessioni di preparazione anticipata calcolate dal piano. Qui puoi aggiungere indicazioni tue o nascondere la sezione.</p>
        <label class="ric-scelta"><input type="checkbox" id="prep-attivo" ${!(piano.mealPrep && piano.mealPrep.attivo === false) ? "checked" : ""}> Mostra la sezione Meal prep a questo paziente</label>
        <label class="editor-campo" style="margin-top:8px;">Indicazioni per il paziente (facoltative)
          <textarea id="prep-note" rows="3" maxlength="600" placeholder="Es. il pesce preparalo fresco il giorno stesso; per le verdure va bene il forno">${escapeHTML((piano.mealPrep && piano.mealPrep.note) || "")}</textarea>
        </label>
        <button type="button" class="btn" id="btn-salva-prep" style="margin-top:10px;">Salva meal prep</button>
      </section>

      <section class="settings-section">
        <h2>Importa / sostituisci l'intero piano</h2>
        <p class="hint">Hai già il piano in PDF? Caricalo: l'intelligenza artificiale lo legge e lo converte, tu lo rivedi e confermi. Niente da riscrivere a mano.</p>
        ${avvisoProgrammatoHTML(piano, true)}
        <button type="button" class="btn" id="btn-importa-ai" style="margin-bottom:12px;">✨ Importa da un PDF</button>
        <p class="hint">Oppure carica un file .json, nello stesso formato scaricabile qui come modello.</p>
        <div class="import-actions">
          <button type="button" class="btn btn--ghost" id="btn-esporta-piano-prof">Scarica questo piano come modello (.json)</button>
          <label class="btn" for="input-importa-piano-prof">Importa piano da file…</label>
          <input type="file" id="input-importa-piano-prof" accept="application/json,.json" hidden>
        </div>
      </section>

      <section class="settings-section zona-elimina">
        <h2>Elimina paziente</h2>
        <p class="hint">Cancella per sempre l'account di accesso di ${escapeHTML(piano.pazienteNome || "questo paziente")}, il suo piano e lo storico dei pasti. Non si può annullare: se ti serve, scarica prima il piano come modello qui sopra.</p>
        <button type="button" class="btn btn--pericolo" id="btn-elimina-paziente">Elimina paziente</button>
      </section>
    `;

    document.getElementById("btn-torna-lista").addEventListener("click", renderListaPazienti);
    document.getElementById("btn-andamento-paziente").addEventListener("click", () => {
      const id = piano.id;
      caricaStatistiche(false).then(() => renderStatistichePaziente(id));
    });
    document.getElementById("btn-salva-dati-paziente").addEventListener("click", salvaDatiPazienteProfessionista);
    document.getElementById("btn-salva-norme").addEventListener("click", salvaNormeGeneraliProfessionista);
    document.getElementById("btn-salva-sostituzioni").addEventListener("click", salvaSostituzioniProfessionista);
    document.getElementById("btn-salva-feedback").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const feedbackAI = { modo: document.getElementById("feedback-modo").value, indicazioni: document.getElementById("feedback-indicazioni").value.trim().slice(0, 600) };
      btn.disabled = true;
      try {
        await window.cloud.salvaPiano(piano.id, { feedbackAI });
        piano.feedbackAI = feedbackAI;
        mostraToast("Riscontro AI salvato");
      } catch (err) {
        mostraToast(msgErroreScrittura(err, "Non salvato: controlla la connessione"));
      } finally { btn.disabled = false; }
    });
    document.getElementById("btn-salva-macro").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const macro = { visibile: document.getElementById("macro-visibile").checked };
      btn.disabled = true;
      try {
        await window.cloud.salvaPiano(piano.id, { macro });
        piano.macro = macro;
        mostraToast(macro.visibile ? "Macronutrienti visibili al paziente" : "Macronutrienti nascosti al paziente");
      } catch (err) {
        mostraToast(msgErroreScrittura(err, "Non salvato: controlla la connessione"));
      } finally { btn.disabled = false; }
    });
    document.getElementById("btn-salva-prep").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const mealPrep = { attivo: document.getElementById("prep-attivo").checked, note: document.getElementById("prep-note").value.trim().slice(0, 600) };
      btn.disabled = true;
      try {
        await window.cloud.salvaPiano(piano.id, { mealPrep });
        piano.mealPrep = mealPrep;
        mostraToast("Meal prep salvato");
      } catch (err) {
        mostraToast(msgErroreScrittura(err, "Non salvato: controlla la connessione"));
      } finally { btn.disabled = false; }
    });
    collegaEditorPastoProfessionista();
    collegaCopiaSettimana();
    document.getElementById("btn-esporta-piano-prof").addEventListener("click", () => esportaPiano(piano));
    document.getElementById("input-importa-piano-prof").addEventListener("change", onFileImportPianoProf);
    document.getElementById("btn-importa-ai").addEventListener("click", () => avviaImportazioneAI(piano));
    collegaAnnullaProgrammato(piano, () => apriEditorPaziente(piano.id));
    document.getElementById("btn-elimina-paziente").addEventListener("click", apriConfermaEliminazione);
  }

  /** Markup dell'editor "Modifica un pasto": generico, lavora su un piano/settimana/giorno passati esplicitamente. */
  function renderEditorPastoHTML(piano, settSel, giornoSel, disponibili) {
    const giornoEdit = (piano.settimane[settSel] && piano.settimane[settSel][giornoSel]) || {};
    return `
      <section class="settings-section">
        <h2>Modifica un pasto</h2>
        <p class="hint">${RUOLO === "paziente" ? "Scegli settimana e giorno, scrivi o correggi i pasti e salva." : "Scegli settimana e giorno, cambia il testo dei pasti e salva: si sincronizza subito con l'app del paziente."}</p>
        <div class="field-row">
          <span class="field-row__label">Settimana</span>
          <select id="sel-edit-settimana">
            ${disponibili.map((n) => `<option value="${n}" ${n === settSel ? "selected" : ""}>Settimana ${n}</option>`).join("")}
          </select>
        </div>
        <div class="field-row">
          <span class="field-row__label">Giorno</span>
          <select id="sel-edit-giorno">
            ${window.weekLogic.GIORNI.map((g, i) => `<option value="${i}" ${i === giornoSel ? "selected" : ""}>${g}</option>`).join("")}
          </select>
        </div>
        <div class="editor-pasti" id="editor-pasti-form">
          ${MEAL_KEYS.map((key) => `
            <label class="editor-campo">
              <span>${MEAL_META[key].label}</span>
              <textarea data-campo="${key}" rows="2" placeholder="${key.startsWith("spuntino") ? "Es. Frutta 150g (vuoto = nessuno spuntino)" : ""}">${escapeHTML(giornoEdit[key] === DA_COMPILARE ? "" : (giornoEdit[key] || ""))}</textarea>
            </label>
          `).join("")}
          <label class="editor-campo">
            <span>Coccola (facoltativa)</span>
            <input type="text" data-campo="coccola" value="${escapeHTML(giornoEdit.coccola || "")}">
          </label>
          <label class="editor-campo">
            <span>Kcal totali (facoltativo)</span>
            <input type="number" data-campo="kcal" value="${giornoEdit.kcal != null ? giornoEdit.kcal : ""}">
          </label>
        </div>
        <button type="button" class="btn" id="btn-salva-pasto" style="margin-top:14px;">Salva questo giorno</button>
      </section>
    `;
  }

  function collegaEditorPastoProfessionista() {
    document.getElementById("sel-edit-settimana").addEventListener("change", (e) => {
      EDITOR_PROF.settSel = Number(e.target.value);
      EDITOR_PROF.giornoSel = 0;
      renderEditorProfessionista();
    });
    document.getElementById("sel-edit-giorno").addEventListener("change", (e) => {
      EDITOR_PROF.giornoSel = Number(e.target.value);
      renderEditorProfessionista();
    });
    document.getElementById("btn-salva-pasto").addEventListener("click", salvaPastoModificatoProfessionista);
  }

  async function salvaPastoModificatoProfessionista() {
    const piano = PIANO_ATTIVO_PROF;
    const { settSel, giornoSel } = EDITOR_PROF;

    const campi = {};
    document.querySelectorAll("#editor-pasti-form [data-campo]").forEach((el) => {
      campi[el.dataset.campo] = el.value;
    });

    const vuoti = MEAL_KEYS.filter((k) => !campi[k] || !campi[k].trim());
    if (vuoti.length) {
      mostraToast("Compila tutti i pasti prima di salvare — manca: " + vuoti.map((k) => MEAL_META[k].label).join(", "), 4200);
      return;
    }

    const pianoModificato = JSON.parse(JSON.stringify(piano));
    const giornoObj = pianoModificato.settimane[settSel][giornoSel];
    MEAL_KEYS.forEach((k) => { giornoObj[k] = campi[k].trim(); });
    giornoObj.coccola = (campi.coccola || "").trim();
    const kcalNum = Number(campi.kcal);
    giornoObj.kcal = (campi.kcal !== "" && !Number.isNaN(kcalNum)) ? kcalNum : null;

    const risultato = validaPiano(pianoModificato);
    if (!risultato.ok) {
      mostraToast("Non salvato — " + risultato.errori[0], 4200);
      return;
    }

    const btn = document.getElementById("btn-salva-pasto");
    btn.disabled = true;
    btn.textContent = "Salvataggio…";
    try {
      await window.cloud.salvaPiano(piano.id, risultato.piano);
      mostraToast("Pasto salvato e sincronizzato col paziente");
    } catch (e) {
      mostraToast(msgErroreScrittura(e, "Salvataggio non riuscito: controlla la connessione"), 4000);
    } finally {
      btn.disabled = false;
      btn.textContent = "Salva questo giorno";
    }
  }

  /** Salva le "Regole generali del piano" (una per riga nella textarea) — passa comunque dal validatore per restare nel formato coerente. */
  async function salvaNormeGeneraliProfessionista() {
    const piano = PIANO_ATTIVO_PROF;
    const testo = document.getElementById("editor-norme").value;
    const norme = testo.split("\n").map((r) => r.trim()).filter((r) => r.length > 0);

    const pianoModificato = JSON.parse(JSON.stringify(piano));
    pianoModificato.normeGenerali = norme;

    const risultato = validaPiano(pianoModificato);
    if (!risultato.ok) {
      mostraToast("Non salvato — " + risultato.errori[0], 4200);
      return;
    }

    const btn = document.getElementById("btn-salva-norme");
    btn.disabled = true;
    btn.textContent = "Salvataggio…";
    try {
      await window.cloud.salvaPiano(piano.id, risultato.piano);
      mostraToast("Regole salvate e sincronizzate col paziente");
    } catch (e) {
      mostraToast(msgErroreScrittura(e, "Salvataggio non riuscito: controlla la connessione"), 4000);
    } finally {
      btn.disabled = false;
      btn.textContent = "Salva regole";
    }
  }

  /** Interpreta "Nome gruppo: opzione1, opzione2" per riga e salva la tabella sostituzioni. */
  async function salvaSostituzioniProfessionista() {
    const piano = PIANO_ATTIVO_PROF;
    const testo = document.getElementById("editor-sostituzioni").value;
    const righe = testo.split("\n").map((r) => r.trim()).filter((r) => r.length > 0);

    const gruppiConErrori = [];
    const sostituzioni = righe.map((riga) => {
      const idx = riga.indexOf(":");
      if (idx === -1) { gruppiConErrori.push(riga); return null; }
      const nome = riga.slice(0, idx).trim();
      const opzioni = riga.slice(idx + 1).split(",").map((o) => o.trim()).filter(Boolean);
      if (!nome || opzioni.length < 2) { gruppiConErrori.push(riga); return null; }
      return { nome, opzioni };
    }).filter(Boolean);

    if (gruppiConErrori.length) {
      mostraToast("Non salvato — riga non valida (serve \"Nome: opzione1, opzione2\", almeno 2 opzioni): " + gruppiConErrori[0], 5000);
      return;
    }

    const pianoModificato = JSON.parse(JSON.stringify(piano));
    pianoModificato.sostituzioni = sostituzioni;

    const risultato = validaPiano(pianoModificato);
    if (!risultato.ok) {
      mostraToast("Non salvato — " + risultato.errori[0], 4200);
      return;
    }

    const btn = document.getElementById("btn-salva-sostituzioni");
    btn.disabled = true;
    btn.textContent = "Salvataggio…";
    try {
      await window.cloud.salvaPiano(piano.id, risultato.piano);
      mostraToast("Sostituzioni salvate e sincronizzate col paziente");
    } catch (e) {
      mostraToast(msgErroreScrittura(e, "Salvataggio non riuscito: controlla la connessione"), 4000);
    } finally {
      btn.disabled = false;
      btn.textContent = "Salva sostituzioni";
    }
  }

  /** Salva nome/obiettivo/target kcal/nutrizionista — passa dal validatore e aggiorna anche il nome mostrato nella lista pazienti. */
  async function salvaDatiPazienteProfessionista() {
    const piano = PIANO_ATTIVO_PROF;
    const campi = {};
    document.querySelectorAll("#editor-dati-form [data-campo]").forEach((el) => {
      campi[el.dataset.campo] = el.value;
    });

    const pianoModificato = JSON.parse(JSON.stringify(piano));
    pianoModificato.paziente = pianoModificato.paziente || {};
    pianoModificato.paziente.nome = campi.nome.trim();
    pianoModificato.paziente.obiettivo = campi.obiettivo.trim();
    const targetNum = Number(campi.targetKcal);
    pianoModificato.paziente.targetKcal = (campi.targetKcal !== "" && !Number.isNaN(targetNum)) ? targetNum : null;
    pianoModificato.paziente.nutrizionista = campi.nutrizionista.trim();

    const risultato = validaPiano(pianoModificato);
    if (!risultato.ok) {
      mostraToast("Non salvato — " + risultato.errori[0], 4200);
      return;
    }

    const nuovoPazienteNome = campi.nome.trim() || piano.pazienteNome;
    const btn = document.getElementById("btn-salva-dati-paziente");
    btn.disabled = true;
    btn.textContent = "Salvataggio…";
    try {
      // pazienteNome è il nome "mostrato" nella lista pazienti: è un campo
      // separato dal contenuto del piano validato, lo aggiungiamo qui.
      const extra = { pazienteNome: nuovoPazienteNome };
      const inizio = leggiSceltaInizio();
      if (inizio.dataInizio && !confermaSettimanaPartenza(inizio, piano.settimanaIniziale)) return;
      if (inizio.dataInizio) Object.assign(extra, inizio);
      const altezza = Number((document.getElementById("editor-altezza") || {}).value);
      const obiettivo = Number(String((document.getElementById("editor-peso-obiettivo") || {}).value || "").replace(",", "."));
      extra.corpo = {
        altezzaCm: altezza >= 100 && altezza <= 230 ? altezza : null,
        pesoObiettivo: obiettivo >= 20 && obiettivo <= 400 ? obiettivo : null,
        visibilita: (document.getElementById("editor-visibilita-peso") || {}).value || "controlli",
      };
      await window.cloud.salvaPiano(piano.id, Object.assign({}, risultato.piano, extra));
      mostraToast("Dati paziente salvati e sincronizzati");
    } catch (e) {
      mostraToast(msgErroreScrittura(e, "Salvataggio non riuscito: controlla la connessione"), 4000);
    } finally {
      btn.disabled = false;
      btn.textContent = "Salva dati paziente";
    }
  }

  // ---------------------------------------------------------------------
  // Copia di una settimana su altre settimane
  // ---------------------------------------------------------------------
  function renderCopiaSettimanaHTML(disponibili, settSel) {
    const sel = typeof settSel === "number" ? settSel : EDITOR_PROF.settSel;
    const origine = disponibili.includes(sel) ? sel : disponibili[0];
    return `
      <section class="settings-section">
        <h2>Copia una settimana</h2>
        <p class="hint">Se più settimane sono uguali, compilane una e copiala nelle altre. Poi puoi ritoccare i singoli giorni da "Modifica un pasto".</p>
        <div class="field-row">
          <span class="field-row__label">Copia la</span>
          <select id="sel-copia-origine">
            ${disponibili.map((n) => `<option value="${n}" ${n === origine ? "selected" : ""}>Settimana ${n}</option>`).join("")}
          </select>
        </div>
        <div class="copia-dest" id="copia-dest">
          <span class="copia-dest__label">nelle settimane</span>
          <div class="copia-dest__scelte">
            ${[1, 2, 3, 4, 5].map((n) => `
              <label class="chip-check ${n === origine ? "is-disabled" : ""}">
                <input type="checkbox" value="${n}" ${n === origine ? "disabled" : ""}>
                <span>${n}${disponibili.includes(n) ? "" : "<small>nuova</small>"}</span>
              </label>`).join("")}
          </div>
        </div>
        <button type="button" class="btn" id="btn-copia-settimana" style="margin-top:14px;">Copia settimana</button>
      </section>
    `;
  }

  function collegaCopiaSettimana(pianoCopia, dopoCopia) {
    const sel = document.getElementById("sel-copia-origine");
    if (!sel) return;
    sel.addEventListener("change", () => {
      const origine = Number(sel.value);
      document.querySelectorAll("#copia-dest input[type=checkbox]").forEach((cb) => {
        const n = Number(cb.value);
        cb.disabled = n === origine;
        if (n === origine) cb.checked = false;
        cb.closest(".chip-check").classList.toggle("is-disabled", n === origine);
      });
    });
    document.getElementById("btn-copia-settimana").addEventListener("click", () => copiaSettimanaProfessionista(pianoCopia, dopoCopia));
  }

  async function copiaSettimanaProfessionista(pianoParam, dopoCopia) {
    const piano = pianoParam || PIANO_ATTIVO_PROF;
    const origine = Number(document.getElementById("sel-copia-origine").value);
    const destinazioni = Array.from(document.querySelectorAll("#copia-dest input[type=checkbox]:checked"))
      .map((cb) => Number(cb.value))
      .filter((n) => n !== origine);

    if (!destinazioni.length) {
      mostraToast("Scegli almeno una settimana in cui copiare");
      return;
    }
    const sorgente = piano.settimane[origine];
    if (!Array.isArray(sorgente) || sorgente.length !== 7) {
      mostraToast("La settimana " + origine + " non è completa: non si può copiare", 4000);
      return;
    }

    const daSovrascrivere = destinazioni.filter((n) => Array.isArray(piano.settimane[n]));
    if (daSovrascrivere.length) {
      const frase = daSovrascrivere.length === 1
        ? `La settimana ${daSovrascrivere[0]} verrà sostituita`
        : `Le settimane ${daSovrascrivere.join(", ")} verranno sostituite`;
      const ok = window.confirm(`${frase} dalla settimana ${origine}. Continuare?`);
      if (!ok) return;
    }

    const pianoModificato = JSON.parse(JSON.stringify(piano));
    destinazioni.forEach((n) => {
      pianoModificato.settimane[n] = JSON.parse(JSON.stringify(sorgente));
    });

    const risultato = validaPiano(pianoModificato);
    if (!risultato.ok) {
      mostraToast("Non copiato — " + risultato.errori[0], 4200);
      return;
    }

    const btn = document.getElementById("btn-copia-settimana");
    btn.disabled = true;
    btn.textContent = "Copia in corso…";
    try {
      await window.cloud.salvaPiano(piano.id, risultato.piano);
      const elenco = destinazioni.sort((a, b) => a - b).join(", ");
      mostraToast(`Settimana ${origine} copiata in: ${elenco}`);
      if (dopoCopia) dopoCopia(risultato.piano);
    } catch (e) {
      mostraToast(msgErroreScrittura(e, "Copia non riuscita: controlla la connessione"), 4000);
    } finally {
      btn.disabled = false;
      btn.textContent = "Copia settimana";
    }
  }

  // ---------------------------------------------------------------------
  // Profilo e dati di contatto del professionista
  // ---------------------------------------------------------------------
  /** Pagina dedicata alla personalizzazione del pannello (stile, colore, chiaro/scuro, testo). */
  function renderAspettoProfessionista() {
    vistaProfCorrente = "aspetto"; segnaVistaProf("profilo");
    pazienteSelezionatoId = null;
    document.getElementById("prof-header-titolo").textContent = "Aspetto dell'app";
    profRoot.innerHTML = `
      <div class="nav-riga">${navLink("btn-torna-lista", "pazienti", "I tuoi pazienti", true)}</div>
      <p class="hint" style="margin: 0 0 12px;">Scegli come vedere il pannello: le scelte valgono su tutti i dispositivi con cui entri. I tuoi pazienti scelgono il loro aspetto nella loro app.</p>
      ${aspettoSezioneHTML()}
    `;
    document.getElementById("btn-torna-lista").addEventListener("click", renderListaPazienti);
    collegaAspetto(renderAspettoProfessionista);
  }

  function renderProfiloProfessionista() {
    vistaProfCorrente = "profilo"; segnaVistaProf("profilo");
    pazienteSelezionatoId = null;
    document.getElementById("prof-header-titolo").textContent = "I miei dati di contatto";
    const c = PROFILO_PROF.contatti || {};
    const nome = c.nome || PROFILO_PROF.nome || "";
    const whatsapp = c.whatsapp !== false;

    profRoot.innerHTML = `
      <div class="nav-riga">${navLink("btn-torna-lista", "pazienti", "I tuoi pazienti", true)}</div>
      <section class="settings-section">
        <h2>Come ti vedono i pazienti</h2>
        <p class="hint">Questi dati compaiono nell'app di tutti i tuoi pazienti, con il pulsante Contatta. Quando li salvi si aggiornano ovunque.</p>
        <div class="editor-pasti" id="form-profilo">
          <label class="editor-campo"><span>Nome e cognome</span><input type="text" data-campo="nome" value="${escapeHTML(nome)}" placeholder="Dott.ssa Maria Rossi" autocomplete="name"></label>
          <label class="editor-campo"><span>Qualifica</span><input type="text" data-campo="qualifica" value="${escapeHTML(c.qualifica || "")}" placeholder="Biologa nutrizionista"></label>
          <label class="editor-campo"><span>Studio e indirizzo</span><input type="text" data-campo="studio" value="${escapeHTML(c.studio || "")}" placeholder="Studio Nutrizione, Via Roma 10, Milano"></label>
          <label class="editor-campo"><span>Email</span><input type="email" data-campo="email" value="${escapeHTML(c.email || "")}" autocomplete="email" inputmode="email"></label>
          <label class="editor-campo"><span>Telefono (con prefisso, es. +39 333 1234567)</span><input type="tel" data-campo="telefono" value="${escapeHTML(c.telefono || "")}" autocomplete="tel" inputmode="tel"></label>
          <label class="check-riga"><input type="checkbox" data-campo="whatsapp" ${whatsapp ? "checked" : ""}> <span>Uso WhatsApp su questo numero</span></label>
          <label class="editor-campo"><span>Nota per i pazienti (facoltativa)</span><input type="text" data-campo="note" value="${escapeHTML(c.note || "")}" placeholder="Rispondo dal lunedì al venerdì, 9–18"></label>
        </div>
        <button type="button" class="btn" id="btn-salva-profilo" style="margin-top:16px;">Salva dati di contatto</button>
      </section>
      ${codiceStudioSezioneHTML()}
    `;
    document.getElementById("btn-torna-lista").addEventListener("click", renderListaPazienti);
    document.getElementById("btn-salva-profilo").addEventListener("click", salvaProfiloProfessionista);
    caricaCodiceStudio();
  }

  // ---- Codice studio: i pazienti che usano già l'app si collegano con questo ----
  function codiceStudioSezioneHTML() {
    return `
      <section class="settings-section" id="sezione-codice-studio">
        <h2>Il tuo codice studio</h2>
        <p class="hint">Se un paziente usa già Il mio Piano per conto suo, dagli questo codice: lo inserisce nelle sue Impostazioni e compare tra i tuoi pazienti con il piano e l'andamento che ha già. Da quel momento il piano lo gestisci tu e il paziente ha Premium incluso.</p>
        <p class="codice-studio" id="codice-studio-valore">…</p>
        <div class="import-azioni">
          <button type="button" class="btn btn--ghost" id="btn-copia-codice" disabled>Copia il codice</button>
          <button type="button" class="btn btn--ghost" id="btn-condividi-codice" disabled>Invia al paziente</button>
        </div>
      </section>`;
  }

  async function caricaCodiceStudio() {
    const box = document.getElementById("codice-studio-valore");
    if (!box || !window.cloud.chiamaFunzione) return;
    try {
      const r = await window.cloud.chiamaFunzione("codiceStudio");
      if (!document.getElementById("codice-studio-valore")) return;
      box.textContent = r.codice;
      const testo = `Per collegare la tua app Il mio Piano al mio studio apri Impostazioni → Il tuo nutrizionista e inserisci il codice ${r.codice}`;
      const copia = document.getElementById("btn-copia-codice");
      const condividi = document.getElementById("btn-condividi-codice");
      copia.disabled = false; condividi.disabled = false;
      copia.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(r.codice); mostraToast("Codice copiato"); }
        catch (e) { mostraToast(`Il codice è ${r.codice}`); }
      });
      condividi.addEventListener("click", async () => {
        if (navigator.share) { try { await navigator.share({ text: testo }); } catch (e) { /* annullato */ } return; }
        try { await navigator.clipboard.writeText(testo); mostraToast("Messaggio copiato: incollalo dove vuoi"); }
        catch (e) { mostraToast(testo, 6000); }
      });
    } catch (e) {
      box.textContent = "Non disponibile in questo momento: riprova più tardi.";
    }
  }

  async function salvaProfiloProfessionista() {
    const campi = {};
    document.querySelectorAll("#form-profilo [data-campo]").forEach((el) => {
      campi[el.dataset.campo] = el.type === "checkbox" ? el.checked : el.value.trim();
    });
    if (!campi.nome) {
      mostraToast("Inserisci almeno nome e cognome");
      return;
    }
    if (campi.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(campi.email)) {
      mostraToast("L'email non sembra corretta: controllala", 3500);
      return;
    }
    if (campi.telefono && numeroPerChiamata(campi.telefono).replace("+", "").length < 8) {
      mostraToast("Il numero di telefono sembra incompleto", 3500);
      return;
    }
    const contatti = {
      nome: campi.nome,
      qualifica: campi.qualifica,
      studio: campi.studio,
      email: campi.email,
      telefono: campi.telefono,
      whatsapp: !!campi.whatsapp,
      note: campi.note,
    };

    const btn = document.getElementById("btn-salva-profilo");
    btn.disabled = true;
    btn.textContent = "Salvataggio…";
    try {
      const n = await window.cloud.salvaProfiloProfessionista(UID, contatti);
      PROFILO_PROF = Object.assign({}, PROFILO_PROF, { contatti, nome: contatti.nome });
      mostraToast(n === 1 ? "Dati salvati e aggiornati per 1 paziente" : `Dati salvati e aggiornati per ${n} pazienti`);
    } catch (e) {
      mostraToast(msgErroreScrittura(e, "Salvataggio non riuscito: controlla la connessione"), 4000);
    } finally {
      btn.disabled = false;
      btn.textContent = "Salva dati di contatto";
    }
  }

  // ---------------------------------------------------------------------
  // Eliminazione di un paziente
  // ---------------------------------------------------------------------
  const PAROLA_CONFERMA = "elimina";

  function apriConfermaEliminazione() {
    const piano = PIANO_ATTIVO_PROF;
    if (!piano) return;
    const nome = piano.pazienteNome || "questo paziente";
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">Eliminare ${escapeHTML(nome)}?</h2>
      <p class="sheet__nota sheet__nota--attenzione">Verranno cancellati per sempre: l'account di accesso (${escapeHTML(piano.pazienteEmail || "email non indicata")}), il piano nutrizionale, le spunte dei pasti e i promemoria. Il paziente non potrà più entrare nell'app.</p>
      <label class="editor-campo">
        <span>Per confermare scrivi <strong>${PAROLA_CONFERMA}</strong></span>
        <input type="text" id="input-conferma-elimina" autocomplete="off" autocapitalize="off" spellcheck="false">
      </label>
      <p class="auth-error" id="errore-elimina" hidden></p>
      <button type="button" class="btn btn--pericolo" id="btn-conferma-elimina" disabled>Elimina definitivamente</button>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Annulla</button>
    `);
    const input = overlay.querySelector("#input-conferma-elimina");
    const btn = overlay.querySelector("#btn-conferma-elimina");
    input.addEventListener("input", () => {
      btn.disabled = input.value.trim().toLowerCase() !== PAROLA_CONFERMA;
    });
    btn.addEventListener("click", () => eseguiEliminazionePaziente(piano, btn));
    input.focus();
  }

  async function eseguiEliminazionePaziente(piano, btn) {
    const errEl = document.getElementById("errore-elimina");
    errEl.hidden = true;
    btn.disabled = true;
    btn.textContent = "Eliminazione in corso…";
    // Blocca anche "Annulla" mentre il server lavora, per non lasciare dubbi sull'esito.
    document.querySelectorAll("#sheet-overlay [data-chiudi-sheet]").forEach((b) => (b.disabled = true));
    try {
      // Prima le eventuali richieste di appuntamento del paziente, poi il resto.
      if (piano.pazienteUid) await window.cloud.eliminaRichiesteDelPaziente(UID, piano.pazienteUid).catch(() => {});
      const esito = await window.cloud.eliminaPaziente(piano.id);
      chiudiSheet();
      mostraToast(esito && esito.scollegato
        ? `${piano.pazienteNome || "Paziente"} scollegato: si era iscritto da solo, quindi mantiene il suo account e il suo piano`
        : `${piano.pazienteNome || "Paziente"} eliminato`, esito && esito.scollegato ? 5000 : 2500);
      renderListaPazienti();
    } catch (e) {
      errEl.textContent = traduciErroreEliminazione(e);
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = "Elimina definitivamente";
      document.querySelectorAll("#sheet-overlay [data-chiudi-sheet]").forEach((b) => (b.disabled = false));
    }
  }

  function traduciErroreEliminazione(e) {
    const codice = String((e && e.code) || "").replace(/^functions\//, "");
    if (codice === "permission-denied") return (e && e.message) || "Non hai i permessi per eliminare questo paziente.";
    if (codice === "not-found" && e.message && /eliminato/.test(e.message)) return e.message;
    if (codice === "unavailable" || codice === "deadline-exceeded") return "Connessione assente o lenta: riprova tra poco.";
    if (codice === "unauthenticated") return "Sessione scaduta: esci e accedi di nuovo.";
    // "not-found"/"internal" senza messaggio nostro = funzione non ancora pubblicata sul server.
    return "Eliminazione non riuscita. Se è la prima volta, la funzione sul server va ancora pubblicata (firebase deploy --only functions). Dettaglio: " + (codice || "sconosciuto");
  }

  // ---------------------------------------------------------------------
  // Nuovo paziente
  // ---------------------------------------------------------------------
  function renderFormNuovoPaziente() {
    vistaProfCorrente = "nuovo"; segnaVistaProf("nuovo");
    document.getElementById("prof-header-titolo").textContent = "Nuovo paziente";
    const passwordGenerata = generaPasswordProvvisoria();

    profRoot.innerHTML = `
      <div class="nav-riga">${navLink("btn-torna-lista", "pazienti", "I tuoi pazienti", true)}</div>
      <section class="settings-section">
        <h2>Crea un nuovo paziente</h2>
        <p class="hint">Viene creato subito l'accesso del paziente e un piano di partenza (schema di esempio a 5 settimane) che potrai modificare pasto per pasto qui dentro. Comunica tu stesso email e password provvisoria al paziente.</p>
        <p class="stat-nota">Il paziente usa già l'app per conto suo? Non crearlo di nuovo: dagli il tuo <button type="button" class="link-btn link-btn--inline" id="btn-vai-codice-studio">codice studio</button>.</p>
        <label class="editor-campo"><span>Nome e cognome paziente</span><input type="text" id="np-nome" required></label>
        <label class="editor-campo"><span>Email di accesso</span><input type="email" id="np-email" required></label>
        <label class="editor-campo"><span>Password provvisoria</span><input type="text" id="np-password" value="${passwordGenerata}"></label>
        <label class="editor-campo"><span>Data di inizio del piano</span><input type="date" id="np-inizio" value="${oggiISO()}"></label>
        <div class="ric-griglia">
          <label class="editor-campo"><span>Altezza (cm)</span><input type="number" inputmode="decimal" id="np-altezza" min="100" max="230" step="1" placeholder="facoltativo"></label>
          <label class="editor-campo"><span>Peso di oggi (kg)</span><input type="number" inputmode="decimal" id="np-peso" min="20" max="400" step="0.1" placeholder="facoltativo"></label>
        </div>
        <p class="hint">La settimana che contiene questa data è la Settimana 1 del piano; poi le settimane si alternano in ordine.</p>
        <p class="auth-error" id="np-error" hidden></p>
        <button type="button" class="btn" id="btn-crea-paziente" style="margin-top:14px;">Crea paziente</button>
      </section>
    `;

    document.getElementById("btn-torna-lista").addEventListener("click", renderListaPazienti);
    document.getElementById("btn-vai-codice-studio").addEventListener("click", () => {
      renderProfiloProfessionista();
      setTimeout(() => { const el = document.getElementById("sezione-codice-studio"); if (el) el.scrollIntoView({ behavior: "smooth" }); }, 50);
    });
    document.getElementById("btn-crea-paziente").addEventListener("click", onCreaPaziente);
  }

  /** Dopo la creazione: le credenziali da comunicare al paziente, pronte da copiare o inviare. */
  function mostraCredenzialiPaziente(nome, email, password) {
    const indirizzo = location.origin + location.pathname.replace(/index\.html$/, "");
    const primoNome = nome.split(" ")[0];
    const testo = `Ciao ${primoNome}, ecco l'accesso all'app del tuo piano nutrizionale.\n\n` +
      `Apri: ${indirizzo}\nEmail: ${email}\nPassword provvisoria: ${password}\n\n` +
      `Al primo accesso ti consiglio di cambiare la password e di attivare i promemoria dei pasti.`;
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">✓ Paziente creato</h2>
      <p class="sheet__nota">Comunica a ${escapeHTML(primoNome)} questi dati per il primo accesso.</p>
      <div class="credenziali">
        <p><span>Indirizzo</span><strong>${escapeHTML(indirizzo)}</strong></p>
        <p><span>Email</span><strong>${escapeHTML(email)}</strong></p>
        <p><span>Password provvisoria</span><strong class="credenziali__password">${escapeHTML(password)}</strong></p>
      </div>
      <button type="button" class="btn" id="btn-cred-whatsapp">Invia con WhatsApp</button>
      <button type="button" class="btn btn--ghost" id="btn-cred-copia">Copia le credenziali</button>
      <button type="button" class="btn btn--ghost" data-chiudi-sheet>Fatto</button>
    `);
    overlay.querySelector("#btn-cred-whatsapp").addEventListener("click", () => {
      window.open("https://wa.me/?text=" + encodeURIComponent(testo), "_blank", "noopener");
    });
    overlay.querySelector("#btn-cred-copia").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(testo); mostraToast("Credenziali copiate", 3000); }
      catch (e) { mostraToast("Copia non riuscita: seleziona il testo a mano", 3500); }
    });
  }

  /** Messaggi chiari per gli errori della funzione server creaPaziente. */
  function traduciErroreCreazionePaziente(e) {
    const codice = String((e && e.code) || "").replace(/^functions\//, "");
    const messaggio = String((e && e.message) || "");
    if (messaggio === "email-gia-usata") return "Esiste già un account con questa email: usane un'altra oppure chiedi al paziente con quale email si è registrato.";
    if (messaggio === "licenza-non-attiva") return "La tua licenza non è attiva: attiva un abbonamento per creare nuovi pazienti.";
    if (messaggio.startsWith("limite-raggiunto")) return `Hai raggiunto il limite del tuo piano (${messaggio.split(":")[1] || statoLicenza().max} pazienti). Per aggiungerne altri passa a un piano superiore.`;
    if (codice === "invalid-argument" || codice === "permission-denied") return messaggio;
    if (codice === "unavailable" || codice === "deadline-exceeded") return "Connessione assente o lenta: riprova tra poco.";
    return "Non è stato possibile creare il paziente. Riprova tra poco.";
  }

  function generaPasswordProvvisoria() {
    const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    let out = "";
    for (let i = 0; i < 10; i++) out += alfabeto[Math.floor(Math.random() * alfabeto.length)];
    return out;
  }

  async function onCreaPaziente() {
    const nome = document.getElementById("np-nome").value.trim();
    const email = document.getElementById("np-email").value.trim();
    const password = document.getElementById("np-password").value;
    const errEl = document.getElementById("np-error");
    errEl.hidden = true;

    if (!nome || !email || password.length < 6) {
      mostraErroreIn("np-error", "Compila nome, email e una password di almeno 6 caratteri.");
      return;
    }

    const st = statoLicenza();
    if (!st.attiva) { mostraErroreIn("np-error", "La tua licenza non è attiva: attiva un abbonamento per creare nuovi pazienti."); return; }
    if (st.pieno) { mostraErroreIn("np-error", `Hai raggiunto il limite del tuo piano (${st.max} pazienti).`); return; }
    const dataInizio = (document.getElementById("np-inizio") || {}).value || oggiISO();

    const btn = document.getElementById("btn-crea-paziente");
    btn.disabled = true;
    btn.textContent = "Creazione in corso…";

    try {
      const pianoBase = JSON.parse(JSON.stringify(PIANO_TEMPLATE));
      pianoBase.paziente.nome = nome;
      const contatti = PROFILO_PROF.contatti || null;
      pianoBase.paziente.nutrizionista = (contatti && contatti.nome) || PROFILO_PROF.nome || "";
      if (contatti) pianoBase.contattiNutrizionista = contatti;
      pianoBase.dataInizio = dataInizio;
      const creato = await window.cloud.creaPaziente({ email, password, nome, piano: pianoBase });
      // Altezza e primo peso: si registrano subito dopo, nel piano appena creato
      const altezza = Number((document.getElementById("np-altezza") || {}).value);
      const peso = Number(String((document.getElementById("np-peso") || {}).value || "").replace(",", "."));
      if (creato && creato.pianoId) {
        try {
          await window.cloud.salvaPiano(creato.pianoId, { corpo: { altezzaCm: altezza >= 100 && altezza <= 230 ? altezza : null, pesoObiettivo: null, visibilita: "controlli" } });
          if (peso >= 20 && peso <= 400) await window.cloud.salvaMisura(creato.pianoId, null, { data: oggiISO(), peso: Math.round(peso * 10) / 10, fonte: "studio" });
        } catch (errMis) { console.warn("Misure iniziali non salvate:", errMis); }
      }
      renderListaPazienti();
      mostraCredenzialiPaziente(nome, email, password);
    } catch (e) {
      mostraErroreIn("np-error", traduciErroreCreazionePaziente(e));
      btn.disabled = false;
      btn.textContent = "Crea paziente";
    }
  }

  // ---------------------------------------------------------------------
  // Import / export piano (professionista)
  // ---------------------------------------------------------------------
  function esportaPiano(piano) {
    const blob = new Blob([JSON.stringify(piano, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "piano-nutrizionale.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    mostraToast("Modello scaricato");
  }

  function onFileImportPianoProf(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!/\.json$/i.test(file.name) && file.type && file.type !== "application/json") {
      mostraToast("Il file deve essere in formato .json");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => mostraToast("Impossibile leggere il file");
    reader.onload = async () => {
      let json;
      try {
        json = JSON.parse(String(reader.result));
      } catch (err) {
        mostraToast("Il file non è un JSON valido: controlla la formattazione.", 5000);
        return;
      }
      const risultato = validaPiano(json);
      if (!risultato.ok) {
        const primi = risultato.errori.slice(0, 4);
        const extra = risultato.errori.length > 4 ? ` (+${risultato.errori.length - 4} altri problemi)` : "";
        mostraToast("File non importato — " + primi.join(" · ") + extra, 6500);
        return;
      }
      try {
        await window.cloud.salvaPiano(PIANO_ATTIVO_PROF.id, risultato.piano);
        mostraToast("Piano importato e sincronizzato col paziente");
      } catch (err) {
        mostraToast(msgErroreScrittura(err, "Salvataggio non riuscito: controlla la connessione"), 4000);
      }
    };
    reader.readAsText(file);
  }

  /**
   * Convalida un oggetto piano (importato o modificato) e lo normalizza nel
   * formato standard. Usata sia dall'editor pasto sia dall'import file.
   * Ritorna { ok:true, piano } oppure { ok:false, errori:[...] }.
   */
  function validaPiano(input) {
    const errori = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, errori: ["il file deve contenere un oggetto JSON"] };
    }
    if (!input.settimane || typeof input.settimane !== "object" || Array.isArray(input.settimane)) {
      return { ok: false, errori: ["manca la sezione 'settimane'"] };
    }

    const chiaviTrovate = Object.keys(input.settimane).filter((k) => ["1", "2", "3", "4", "5"].includes(String(k)));
    if (!chiaviTrovate.length) {
      return { ok: false, errori: ["nessuna settimana valida (1-5) dentro 'settimane'"] };
    }

    const settimaneValide = {};
    chiaviTrovate.forEach((chiave) => {
      const giorni = input.settimane[chiave];
      if (!Array.isArray(giorni) || giorni.length !== 7) {
        errori.push(`Settimana ${chiave}: servono 7 giorni (trovati ${Array.isArray(giorni) ? giorni.length : 0})`);
        return;
      }
      const giorniValidati = [];
      giorni.forEach((giornoObj, i) => {
        const nomeGiorno = window.weekLogic.GIORNI[i];
        if (!giornoObj || typeof giornoObj !== "object") {
          errori.push(`Sett. ${chiave}, ${nomeGiorno}: giorno non valido`);
          return;
        }
        const out = { giorno: nomeGiorno };
        let giornoOk = true;
        MEAL_KEYS.forEach((key) => {
          const v = giornoObj[key];
          if (typeof v !== "string" || !v.trim()) {
            errori.push(`Sett. ${chiave}, ${nomeGiorno}: manca '${MEAL_META[key].label}'`);
            giornoOk = false;
          } else {
            out[key] = v.trim();
          }
        });
        out.kcal = (typeof giornoObj.kcal === "number" && isFinite(giornoObj.kcal)) ? giornoObj.kcal : null;
        out.coccola = (typeof giornoObj.coccola === "string" && giornoObj.coccola.trim()) ? giornoObj.coccola.trim() : "";
        if (giornoOk) giorniValidati.push(out);
      });
      if (giorniValidati.length === 7) settimaneValide[chiave] = giorniValidati;
    });

    if (errori.length) return { ok: false, errori };

    const pazienteIn = (input.paziente && typeof input.paziente === "object") ? input.paziente : {};
    const orariDefaultIn = (input.orariDefault && typeof input.orariDefault === "object") ? input.orariDefault : {};

    const piano = {
      paziente: {
        nome: typeof pazienteIn.nome === "string" ? pazienteIn.nome : "",
        eta: typeof pazienteIn.eta === "number" ? pazienteIn.eta : null,
        pesoKg: typeof pazienteIn.pesoKg === "number" ? pazienteIn.pesoKg : null,
        altezzaM: typeof pazienteIn.altezzaM === "number" ? pazienteIn.altezzaM : null,
        targetKcal: typeof pazienteIn.targetKcal === "number" ? pazienteIn.targetKcal : null,
        obiettivo: typeof pazienteIn.obiettivo === "string" ? pazienteIn.obiettivo : "",
        nutrizionista: typeof pazienteIn.nutrizionista === "string" ? pazienteIn.nutrizionista : "",
      },
      orariDefault: Object.assign({}, PIANO_TEMPLATE.orariDefault, orariDefaultIn),
      normeGenerali: Array.isArray(input.normeGenerali) ? input.normeGenerali.filter((n) => typeof n === "string" && n.trim()) : [],
      sostituzioni: normalizzaSostituzioni(input.sostituzioni),
      settimane: settimaneValide,
    };

    return { ok: true, piano };
  }

  /** Normalizza la tabella delle sostituzioni pasto: array di {nome, opzioni:[...]}, scartando gruppi senza nome o con meno di 2 opzioni. */
  function normalizzaSostituzioni(input) {
    if (!Array.isArray(input)) return [];
    return input
      .map((g) => {
        if (!g || typeof g !== "object") return null;
        const nome = typeof g.nome === "string" ? g.nome.trim() : "";
        const opzioni = Array.isArray(g.opzioni) ? g.opzioni.filter((o) => typeof o === "string" && o.trim()).map((o) => o.trim()) : [];
        if (!nome || opzioni.length < 2) return null;
        return { nome, opzioni };
      })
      .filter(Boolean);
  }

  // ---------------------------------------------------------------------
  // Service worker & utilità comuni
  // ---------------------------------------------------------------------
  /**
   * Service worker e aggiornamenti. Un'app installata, riaperta dalle app
   * recenti, spesso riprende senza ricaricarsi: per questo, quando si torna
   * sull'app (e ogni 30 minuti) si chiede al browser di controllare se c'è
   * una versione nuova. Quando la nuova versione prende il controllo compare
   * la barra "È disponibile una nuova versione · Aggiorna": niente
   * ricariche automatiche, per non perdere quello che si sta scrivendo.
   */
  let swRegistrato = false;
  function registraServiceWorker() {
    if (!("serviceWorker" in navigator) || swRegistrato) return;
    swRegistrato = true;
    const avevaVersione = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("service-worker.js").then((reg) => {
      const controlla = () => { reg.update().catch(() => {}); };
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") controlla(); });
      setInterval(controlla, 30 * 60 * 1000);
    }).catch(() => {});
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // al primo avvio il service worker prende il controllo: non è un aggiornamento
      if (avevaVersione) mostraAvvisoAggiornamento();
    });
  }

  function mostraAvvisoAggiornamento() {
    if (document.getElementById("avviso-aggiornamento")) return;
    const barra = document.createElement("div");
    barra.id = "avviso-aggiornamento";
    barra.className = "avviso-aggiornamento";
    barra.setAttribute("role", "status");
    barra.innerHTML = '<span>È disponibile una nuova versione dell\'app</span><button type="button" class="btn">Aggiorna</button>';
    barra.querySelector("button").addEventListener("click", () => window.location.reload());
    document.body.appendChild(barra);
  }

  function mostraToast(msg, durataMs) {
    const tpl = document.getElementById("tpl-toast");
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.textContent = msg;
    document.body.appendChild(node);
    setTimeout(() => node.remove(), durataMs || 2600);
  }

  function escapeHTML(str) {
    const div = document.createElement("div");
    div.textContent = String(str == null ? "" : str);
    return div.innerHTML;
  }
})();
