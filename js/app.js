



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
  let PASTI_FATTI_OGGI = {};
  let unsubPiano = null;
  let unsubPastiOggi = null;

  // ---- stato lato professionista ----
  let PAZIENTI_PROF = [];
  let unsubPazienti = null;
  let vistaProfCorrente = "lista"; // "lista" | "editor" | "nuovo"
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
  init();

  function init() {
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
    if (RUOLO === "professionista") {
      avviaProfessionista(utenteDati);
    } else {
      avviaPaziente();
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
    if (unsubPastiOggi) { unsubPastiOggi(); unsubPastiOggi = null; }
    scollegaSpesa();
    azzeraStatistiche();
    scollegaRicette();
    scollegaRicettario();
    if (unsubPazienti) { unsubPazienti(); unsubPazienti = null; }
    pazienteSelezionatoId = null;
    vistaProfCorrente = "lista";
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
      document.getElementById("form-login").hidden = attiva;
      document.getElementById("btn-password-dimenticata").hidden = attiva;
      document.getElementById("form-signup").hidden = !attiva;
      document.getElementById("auth-sub").textContent = attiva ? SUB_REGISTRAZIONE : SUB_ACCESSO;
    }
    document.getElementById("btn-mostra-signup").addEventListener("click", () => modalitaRegistrazione(true));
    document.getElementById("btn-annulla-signup").addEventListener("click", () => modalitaRegistrazione(false));

    // Link legali presi da config.json (così si cambiano in un posto solo)
    caricaConfig().then((c) => {
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
      "permission-denied": "Permesso negato da Firestore: controlla di aver pubblicato le regole di sicurezza corrette nella console Firebase.",
    };
    return (code && mappa[code]) || "Si è verificato un errore imprevisto. Riprova.";
  }

  // =======================================================================
  // LATO PAZIENTE
  // =======================================================================
  async function avviaPaziente() {
    mostraSchermata("paziente");
    applyTema(localStorage.getItem(LS_KEYS.tema) || "sistema");
    CONFIG = await caricaConfig();
    aggiornaEyebrowData();
    registraServiceWorker();
    collegaTabbar();

    // Piano in tempo reale: si aggiorna da solo se il professionista lo modifica,
    // anche da un altro dispositivo — questo è il "cloud sync" richiesto.
    unsubPiano = window.cloud.ascoltaPianoPaziente(UID, (piano) => {
      PIANO_ATTIVO = piano;
      if (piano) collegaRicettePaziente();
      if (currentView === "oggi" || currentView === "settimana" || currentView === "impostazioni") render();
    });
    collegaAscoltoPastiOggi();

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

  function render() {
    if (currentView === "oggi") renderOggi();
    else if (currentView === "settimana") renderSettimana();
    else if (currentView === "spesa") renderSpesa();
    else if (currentView === "ricette") renderRicette();
    else renderImpostazioni();
  }

  function aggiornaEyebrowData() {
    const oggi = new Date();
    dataOggiEl.textContent = oggi.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
  }

  // ---------------------------------------------------------------------
  // Vista "Oggi"
  // ---------------------------------------------------------------------
  function renderOggi() {
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
    const numFatti = MEAL_KEYS.filter((k) => fatti[k]).length;

    root.innerHTML = `
      ${renderBannerIosHTML()}
      ${avvisoInizio}
      <section class="hero">
        <div class="hero__foto" role="img" aria-label="Piatto con verdure fresche, cereali e agrumi"></div>
        <div class="hero__eyebrow"><span class="dot"></span> Settimana ${settimana} del piano</div>
        <h2 class="hero__title">${giornoNome}</h2>
        <div class="hero__meta">
          <span class="pill pill--kcal">${giorno.kcal != null ? giorno.kcal + " kcal circa" : "kcal n/d"}</span>
          <span class="pill">${escapeHTML(PIANO_ATTIVO.paziente.obiettivo || "")}</span>
          <span class="pill pill--progress ${numFatti === MEAL_KEYS.length ? "is-complete" : ""}">${numFatti}/${MEAL_KEYS.length} pasti fatti</span>
        </div>
      </section>
      <div class="timeline">${renderTimelineHTML(giorno, orari, { checkable: true, fatti })}</div>
      ${renderCoccolaHTML(giorno)}
      ${renderNormeHTML()}
      ${renderContattoNutrizionistaHTML()}
    `;

    root.querySelectorAll("[data-meal-check]").forEach((btn) => {
      btn.addEventListener("click", () => onToggleMealCheck(btn.dataset.mealCheck));
    });
    collegaBannerIos();
    collegaContattoNutrizionista();
  }

  function renderTimelineHTML(giorno, orari, opts) {
    opts = opts || {};
    const fatti = opts.fatti || {};
    return MEAL_KEYS.map((key) => {
      const meta = MEAL_META[key];
      const isDone = !!fatti[key];
      const sost = trovaSostituzioneMeal(giorno[key]);
      return `
        <article class="meal ${meta.classe} ${isDone ? "is-done" : ""}">
          <div class="meal__head">
            <span class="meal__label">${meta.label}</span>
            <span class="meal__time">${orari[key] || ""}</span>
          </div>
          <p class="meal__desc">${escapeHTML(giorno[key])}</p>
          ${opts.checkable ? `
            <button type="button" class="meal__check" data-meal-check="${key}" aria-pressed="${isDone}">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12.5 9.5 18 20 6"/></svg>
              <span>${isDone ? "Fatto" : "Segna come fatto"}</span>
            </button>
          ` : ""}
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
    unsubPastiOggi = window.cloud.ascoltaPastiFattiCloud(UID, dateKey, (stato) => {
      PASTI_FATTI_OGGI = stato || {};
      if (currentView === "oggi") renderOggi();
    });
  }

  async function onToggleMealCheck(key) {
    const dateKey = chiaveData(new Date());
    const nuovoStato = Object.assign({}, PASTI_FATTI_OGGI);
    nuovoStato[key] = !nuovoStato[key];
    try {
      await window.cloud.salvaPastiFattiCloud(UID, dateKey, nuovoStato);
      // L'ascolto in tempo reale aggiorna la UI da solo.
    } catch (e) {
      mostraToast("Impossibile salvare: controlla la connessione");
    }
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
      <div class="hero__meta" style="margin:-8px 0 16px;">
        <span class="pill pill--kcal">${giorno.kcal != null ? giorno.kcal + " kcal circa" : "kcal n/d"}</span>
      </div>
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
    dati: { spuntate: [], extra: [] },
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
    SPESA.dati = { spuntate: [], extra: [] };
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
      const { settimana } = window.weekLogic.calcolaSettimanaGiorno(inizio, CONFIG, PIANO_ATTIVO);
      const intervallo = inizio.getMonth() === fine.getMonth()
        ? `${inizio.getDate()}–${fine.getDate()} ${MESI_BREVI[fine.getMonth()]}`
        : `${inizio.getDate()} ${MESI_BREVI[inizio.getMonth()]} – ${fine.getDate()} ${MESI_BREVI[fine.getMonth()]}`;
      const quando = ["Questa settimana", "Prossima settimana", "Tra 2 settimane", "Tra 3 settimane"][k];
      return { k, settimana, docId: chiaveData(inizio), intervallo, etichetta: `${quando}, ${intervallo} (settimana ${settimana})` };
    });
  }

  function collegaAscoltoSpesa(docId) {
    if (!SPESA.unsubPref) {
      SPESA.unsubPref = window.cloud.ascoltaSpesa(UID, "preferenze", (d) => {
        SPESA.pref = { categoria: d.categoria || {}, nome: d.nome || {}, nascosti: d.nascosti || [] };
        ridisegnaSpesaSeVisibile();
      });
    }
    if (SPESA.docId === docId && SPESA.unsub) return;
    if (SPESA.unsub) SPESA.unsub();
    SPESA.docId = docId;
    SPESA.dati = { spuntate: [], extra: [] };
    SPESA.unsub = window.cloud.ascoltaSpesa(UID, docId, (d) => {
      if (SPESA.docId !== docId) return;
      SPESA.dati = { spuntate: d.spuntate || [], extra: d.extra || [] };
      ridisegnaSpesaSeVisibile();
    });
  }

  function ridisegnaSpesaSeVisibile() {
    if (currentView === "spesa" && document.getElementById("spesa-contenuto")) disegnaContenutoSpesa();
  }

  /** Voci da mostrare: piano + articoli aggiunti a mano, con le correzioni del paziente applicate. */
  function calcolaVociSpesa() {
    const mappa = new Map();
    window.alimenti.listaDaSettimana(SPESA.contesto.giorni, CAMPI_SPESA).forEach((v) => {
      mappa.set(v.chiave, Object.assign({}, v, { daPiano: true, testiExtra: [] }));
    });
    SPESA.dati.extra.forEach((testo) => {
      window.alimenti.classificaArticolo(testo).forEach((v) => {
        if (!mappa.has(v.chiave)) mappa.set(v.chiave, Object.assign({}, v, { daPiano: false, testiExtra: [] }));
        mappa.get(v.chiave).testiExtra.push(testo);
      });
    });
    const nascosti = new Set(SPESA.pref.nascosti);
    const spuntate = new Set(SPESA.dati.spuntate);
    return Array.from(mappa.values()).map((v) => Object.assign(v, {
      nomeOriginale: v.nome,
      catOriginale: v.cat,
      nome: SPESA.pref.nome[v.chiave] || v.nome,
      cat: SPESA.pref.categoria[v.chiave] || v.cat,
      nascosto: nascosti.has(v.chiave) && v.daPiano,
      spuntata: spuntate.has(v.chiave),
    }));
  }

  function renderSpesa() {
    if (!PIANO_ATTIVO) {
      root.innerHTML = `<div class="empty">Il tuo professionista non ha ancora assegnato un piano a questo account.</div>`;
      return;
    }
    const settimane = settimaneSpesa();
    const sel = settimane[SPESA.offset] || settimane[0];
    const giorni = PIANO_ATTIVO.settimane[sel.settimana];
    if (!giorni) {
      root.innerHTML = `<div class="empty">La settimana ${sel.settimana} non è presente nel piano caricato.</div>`;
      return;
    }
    SPESA.contesto = { giorni, etichetta: sel.intervallo };
    collegaAscoltoSpesa(sel.docId);
    const vista = vistaSpesa();

    root.innerHTML = `
      <section class="hero" style="border-bottom:none; margin-bottom:8px; padding-bottom:6px;">
        <div class="hero__eyebrow"><span class="dot"></span> Lista della spesa</div>
        <div class="spesa-testata">
          <select id="sel-settimana-spesa" aria-label="Settimana">
            ${settimane.map((s) => `<option value="${s.k}" ${s.k === sel.k ? "selected" : ""}>${escapeHTML(s.etichetta)}</option>`).join("")}
          </select>
          <div class="spesa-vista" role="group" aria-label="Aspetto della lista">
            <button type="button" data-vista="lista" aria-pressed="${vista === "lista"}" title="Vista a lista">☰ Lista</button>
            <button type="button" data-vista="blocchi" aria-pressed="${vista === "blocchi"}" title="Vista a blocchi">▦ Blocchi</button>
          </div>
        </div>
      </section>
      <p class="hint" style="margin:0 0 12px;">Un articolo per alimento, ricavato dai pasti della settimana. ${vista === "blocchi"
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
      try { await window.cloud.aggiungiArticoloSpesa(UID, SPESA.docId, testo); }
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

  function disegnaContenutoSpesa() {
    const box = document.getElementById("spesa-contenuto");
    if (!box || !SPESA.contesto) return;
    const vista = vistaSpesa();
    const voci = calcolaVociSpesa();
    SPESA.voci = voci;
    const visibili = voci.filter((v) => !v.nascosto);
    const daPrendere = visibili.filter((v) => !v.spuntata).length;

    if (!visibili.length) {
      box.innerHTML = `<div class="empty" style="padding:28px 12px;">Nessun alimento trovato nei pasti di questa settimana. Scrivi qui sotto quello che ti serve.</div>`;
    } else {
      const sezioni = window.alimenti.CATEGORIE.map((cat) => {
        const qui = visibili.filter((v) => v.cat === cat.id).sort((a, b) => a.nome.localeCompare(b.nome, "it"));
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
      box.innerHTML = `
        <p class="spesa-riepilogo">${daPrendere === 0 ? "Hai preso tutto. Buona settimana!" : `${daPrendere} ${daPrendere === 1 ? "articolo" : "articoli"} da prendere su ${visibili.length}`}</p>
        ${sezioni}`;
    }

    // Azioni in fondo: riporta tutto da prendere, articoli nascosti
    const extraBox = document.getElementById("spesa-azioni-extra");
    if (extraBox) {
      const numSpuntate = visibili.filter((v) => v.spuntata).length;
      const numNascosti = SPESA.pref.nascosti.length;
      extraBox.innerHTML = `
        ${numSpuntate ? `<button type="button" class="btn btn--ghost" id="btn-azzera-spesa">Rimetti tutto da prendere</button>` : ""}
        ${numNascosti ? `<button type="button" class="link-btn" id="btn-nascosti-spesa">${numNascosti} ${numNascosti === 1 ? "articolo nascosto" : "articoli nascosti"}: mostra</button>` : ""}`;
      const az = document.getElementById("btn-azzera-spesa");
      if (az) az.addEventListener("click", async () => {
        SPESA.dati.spuntate = [];
        disegnaContenutoSpesa();
        try { await window.cloud.azzeraSpunteSpesa(UID, SPESA.docId); } catch (e) { mostraToast("Modifica non salvata: controlla la connessione"); }
      });
      const na = document.getElementById("btn-nascosti-spesa");
      if (na) na.addEventListener("click", apriNascostiSpesa);
    }
  }

  function rigaSpesaHTML(v) {
    return `
      <li class="spesa-riga ${v.spuntata ? "is-spuntata" : ""}">
        <label>
          <input type="checkbox" data-spunta="${escapeHTML(v.chiave)}" ${v.spuntata ? "checked" : ""}>
          <span class="spesa-riga__icona" aria-hidden="true">${v.icona}</span>
          <span class="spesa-riga__nome">${escapeHTML(v.nome)}</span>
        </label>
        <button type="button" class="spesa-opzioni" data-opzioni="${escapeHTML(v.chiave)}" aria-label="Opzioni per ${escapeHTML(v.nome)}">⋯</button>
      </li>`;
  }

  function bloccoSpesaHTML(v) {
    return `
      <button type="button" class="spesa-blocco ${v.spuntata ? "is-spuntata" : ""}" data-blocco="${escapeHTML(v.chiave)}" aria-pressed="${v.spuntata}">
        <span class="spesa-blocco__icona" aria-hidden="true">${v.icona}</span>
        <span class="spesa-blocco__nome">${escapeHTML(v.nome)}</span>
      </button>`;
  }

  async function spuntaVoceSpesa(chiave, spuntata) {
    const set = new Set(SPESA.dati.spuntate);
    if (spuntata) set.add(chiave); else set.delete(chiave);
    SPESA.dati.spuntate = Array.from(set);
    disegnaContenutoSpesa();
    try { await window.cloud.spuntaSpesa(UID, SPESA.docId, chiave, spuntata); }
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
        apriOpzioniSpesa(blocco.dataset.blocco);
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
      if (!pressioneLunga) { annulla(); pressioneLunga = true; apriOpzioniSpesa(blocco.dataset.blocco); }
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
      try { for (const t of testi) await window.cloud.rimuoviArticoloSpesa(UID, SPESA.docId, t); }
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
    const daPrendere = SPESA.voci.filter((v) => !v.nascosto && !v.spuntata);
    if (!daPrendere.length) { mostraToast("Non c'è niente da prendere"); return; }
    const blocchi = window.alimenti.CATEGORIE.map((cat) => {
      const qui = daPrendere.filter((v) => v.cat === cat.id).sort((a, b) => a.nome.localeCompare(b.nome, "it"));
      return qui.length ? `${cat.nome}\n` + qui.map((v) => `- ${v.nome}`).join("\n") : "";
    }).filter(Boolean);
    const testo = `Lista della spesa (${SPESA.contesto.etichetta})\n\n` + blocchi.join("\n\n");
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
    const p = (PIANO_ATTIVO && PIANO_ATTIVO.paziente) || {};
    const orari = orariEffettivi();
    const attive = notificheAttive();
    const permesso = ("Notification" in window) ? Notification.permission : "unsupported";

    root.innerHTML = `
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
        <h2>Aspetto</h2>
        <div class="field-row">
          <span class="field-row__label">Tema</span>
          <select id="sel-tema">
            <option value="sistema">Segue il sistema</option>
            <option value="chiaro">Chiaro</option>
            <option value="scuro">Scuro</option>
          </select>
        </div>
      </section>

      <section class="settings-section">
        <h2>Il mio piano</h2>
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
      </section>
    `;

    document.getElementById("chk-notifiche").addEventListener("change", onToggleNotificheDettaglio);
    root.querySelectorAll("[data-apri-guida-ios]").forEach((b) => b.addEventListener("click", apriGuidaIOS));
    collegaContattoNutrizionista();
    document.getElementById("sel-anticipo").addEventListener("change", (e) => {
      localStorage.setItem(LS_KEYS.anticipo, e.target.value);
      if (notificheAttive()) {
        pianificaNotificheOggi();
        sincronizzaPreferenzeNotifichePush().catch(() => {});
      }
      mostraToast("Anticipo aggiornato");
    });
    document.getElementById("sel-tema").value = localStorage.getItem(LS_KEYS.tema) || "sistema";
    document.getElementById("sel-tema").addEventListener("change", (e) => {
      localStorage.setItem(LS_KEYS.tema, e.target.value);
      applyTema(e.target.value);
    });
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
    const mappa = { chiaro: "light", scuro: "dark" };
    if (v === "sistema" || !mappa[v]) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", mappa[v]);
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

  async function attivaNotifiche() {
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
              <span class="ricetta-card__foto" ${r.foto && r.foto.url ? `style="background-image:url('${escapeHTML(r.foto.url)}')"` : ""}>${r.foto && r.foto.url ? "" : `<span aria-hidden="true">${r.allegato ? "📄" : "🍲"}</span>`}</span>
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
      ${r.foto && r.foto.url ? `<img class="ricetta__foto" src="${escapeHTML(r.foto.url)}" alt="">` : ""}
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
        ${r.allegato && r.allegato.url ? `<a class="btn" href="${escapeHTML(r.allegato.url)}" target="_blank" rel="noopener">${r.allegato.tipo === "application/pdf" ? "Apri la scheda in PDF" : "Apri la scheda della ricetta"}</a>` : ""}
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
        await window.cloud.aggiungiArticoliSpesa(UID, s.docId, testi);
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

  // =======================================================================
  // LATO PROFESSIONISTA
  // =======================================================================
  function avviaProfessionista(utenteDati) {
    mostraSchermata("professionista");
    applyTema(localStorage.getItem(LS_KEYS.tema) || "sistema");
    registraServiceWorker();
    vistaProfCorrente = "lista";
    pazienteSelezionatoId = null;
    PROFILO_PROF = utenteDati || {};
    caricaConfig().then((c) => { CONFIG = c; if (vistaProfCorrente === "lista") renderListaPazienti(); });
    if (unsubProfilo) unsubProfilo();
    unsubProfilo = window.cloud.ascoltaUtente(UID, (dati) => {
      if (!dati) return;
      PROFILO_PROF = dati;
      if (vistaProfCorrente === "lista") renderListaPazienti();
    });

    let primaLista = true;
    unsubPazienti = window.cloud.ascoltaPazientiProfessionista(UID, (pazienti) => {
      PAZIENTI_PROF = pazienti;
      if (primaLista) { primaLista = false; if (pazienti.length) aggiornaStatisticheInBackground(false); }
      if (vistaProfCorrente === "statistiche") {
        renderStatistiche();
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
    vistaProfCorrente = "lista";
    pazienteSelezionatoId = null;
    document.getElementById("prof-header-titolo").textContent = "I tuoi pazienti";

    const contattiMancanti = !(PROFILO_PROF.contatti && (PROFILO_PROF.contatti.email || PROFILO_PROF.contatti.telefono));
    profRoot.innerHTML = `
      ${renderBoxLicenzaHTML()}
      <button type="button" class="btn" id="btn-nuovo-paziente" style="margin-bottom:10px;" ${(statoLicenza().attiva && !statoLicenza().pieno) ? "" : "disabled"}>+ Nuovo paziente</button>
      ${PAZIENTI_PROF.length ? `<button type="button" class="btn btn--ghost" id="btn-statistiche" style="margin-bottom:10px;">Andamento dei pazienti</button>` : ""}
      <button type="button" class="btn btn--ghost" id="btn-ricettario" style="margin-bottom:10px;">Ricettario</button>
      <button type="button" class="btn btn--ghost" id="btn-profilo-prof" style="margin-bottom:16px;">I miei dati di contatto</button>
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
            </button>
          `).join("")}
        </div>
      `}
    `;

    document.getElementById("btn-nuovo-paziente").addEventListener("click", renderFormNuovoPaziente);
    const btnPortale = document.getElementById("btn-portale-clienti");
    if (btnPortale) btnPortale.addEventListener("click", apriPortaleClienti);
    document.getElementById("btn-profilo-prof").addEventListener("click", renderProfiloProfessionista);
    document.getElementById("btn-ricettario").addEventListener("click", renderRicettario);
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
            prossimaVisita: p.prossimaVisita || null,
          }),
          accessoRilevato: !!u.ultimoAccesso,
        };
      } catch (e) {
        console.error("Statistiche paziente", p.id, e);
        if (e && (e.code === "permission-denied" || e.code === "firestore/permission-denied")) STAT.errorePermessi = true;
        STAT.risultati[p.id] = { errore: true };
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
    vistaProfCorrente = "statistiche";
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
      <button type="button" class="link-btn" id="btn-torna-lista" style="margin-bottom:10px;">← I tuoi pazienti</button>
      ${STAT.errorePermessi ? `<p class="hint avviso-profilo">Non riesco a leggere le spunte dei pazienti: probabilmente le nuove regole di Firestore non sono ancora state pubblicate.</p>` : ""}
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
            if (x.errore) return `<div class="stat-card"><span class="paziente-card__nome">${escapeHTML(p.pazienteNome || "—")}</span><span class="stat-card__piede">Dati non disponibili</span></div>`;
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
        <p class="stat-nota">L'aderenza è la quota di pasti segnati come fatti sui giorni già conclusi. Una giornata è rispettata con almeno ${window.statistiche.SOGLIA_GIORNO_OK} pasti su 5. Il paziente è da ricontattare se non apre l'app e non segna pasti da più di ${window.statistiche.GIORNI_ALLARME} giorni.</p>
      `}
    `;

    document.getElementById("btn-torna-lista").addEventListener("click", renderListaPazienti);
    const agg = document.getElementById("btn-aggiorna-stat");
    if (agg) agg.addEventListener("click", () => { aggiornaStatisticheInBackground(true); renderStatistiche(); });
    profRoot.querySelectorAll("[data-stat-id]").forEach((b) => b.addEventListener("click", () => renderStatistichePaziente(b.dataset.statId)));
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

  function renderStatistichePaziente(id) {
    const piano = PAZIENTI_PROF.find((p) => p.id === id);
    const x = STAT.risultati[id];
    if (!piano || !x || x.errore) { renderStatistiche(); return; }
    vistaProfCorrente = "statPaziente";
    pazienteSelezionatoId = id;
    const r = x.r;
    document.getElementById("prof-header-titolo").textContent = piano.pazienteNome || "Paziente";

    const GIORNI_BREVI = ["L", "M", "M", "G", "V", "S", "D"];
    const livello = (f) => f == null ? "vuoto" : f >= 4 ? "alto" : f >= 2 ? "medio" : f >= 1 ? "basso" : "zero";
    const pc = r.prossimoControllo;
    const testoControllo = !pc ? "Non impostato"
      : pc.traGiorni > 1 ? `Tra ${pc.traGiorni} giorni` : pc.traGiorni === 1 ? "Domani" : pc.traGiorni === 0 ? "Oggi"
      : `Passato da ${-pc.traGiorni} ${pc.traGiorni === -1 ? "giorno" : "giorni"}`;
    const messaggio = messaggioIncoraggiamento(piano, r);

    profRoot.innerHTML = `
      <button type="button" class="link-btn" id="btn-torna-stat" style="margin-bottom:10px;">← Andamento dei pazienti</button>

      <section class="stat-testata stat-card--${r.stato}">
        <span class="stato-badge stato-badge--${r.stato}"><span class="stato-punto"></span>${ETICHETTE_STATO[r.stato]}</span>
        ${r.motivi.length ? `<ul class="stat-motivi">${r.motivi.map((m) => `<li>${escapeHTML(m)}</li>`).join("")}</ul>` : `<p class="stat-motivi">Segue il piano con regolarità e ha i promemoria attivi.</p>`}
      </section>

      <div class="stat-riquadri">
        <div class="stat-riquadro"><strong>${perc(r.aderenza7)}</strong><span>Aderenza 7 giorni</span></div>
        <div class="stat-riquadro"><strong>${perc(r.aderenza30)}</strong><span>Aderenza 30 giorni</span></div>
        <div class="stat-riquadro"><strong>${r.serie}</strong><span>Giorni di fila rispettati (record ${r.record})</span></div>
        <div class="stat-riquadro"><strong>${r.fattiOggi}/5</strong><span>Pasti segnati oggi</span></div>
      </div>

      <section class="settings-section">
        <h2>Ultime 4 settimane</h2>
        <div class="stat-calendario" role="img" aria-label="Pasti segnati giorno per giorno nelle ultime 4 settimane">
          ${GIORNI_BREVI.map((g) => `<span class="stat-calendario__intestazione">${g}</span>`).join("")}
          ${r.calendario.map((c) => `<span class="stat-giorno stat-giorno--${livello(c.fatti)} ${c.oggi ? "is-oggi" : ""}" title="${c.chiave}: ${c.fatti == null ? "non valutato" : c.fatti + "/5 pasti"}">${c.giorno}</span>`).join("")}
        </div>
        <p class="stat-legenda">
          <span class="stat-giorno stat-giorno--alto"></span> 4–5 pasti
          <span class="stat-giorno stat-giorno--medio"></span> 2–3
          <span class="stat-giorno stat-giorno--basso"></span> 1
          <span class="stat-giorno stat-giorno--zero"></span> nessuno
        </p>
      </section>

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
        ${r.perPasto.map((p) => barraHTML(MEAL_META[p.pasto].label, p.valore)).join("")}
        <div style="height:10px;"></div>
        ${barraHTML("Dal lunedì al venerdì", r.feriali)}
        ${barraHTML("Sabato e domenica", r.weekend)}
      </section>

      <section class="settings-section">
        <h2>Uso dell'app</h2>
        <p class="stat-riga"><span>Ultima attività</span><strong>${quandoRelativo(r.ultimaInterazione)}</strong></p>
        <p class="stat-riga"><span>Ultimo pasto segnato</span><strong>${quandoRelativo(r.ultimaSpunta)}</strong></p>
        <p class="stat-riga"><span>Promemoria</span><strong>${testoNotifiche(r.notifiche)}</strong></p>
        ${x.accessoRilevato ? "" : `<p class="stat-nota" style="margin-top:8px;">Le aperture dell'app vengono registrate da questo aggiornamento: finché il paziente non riapre l'app, l'ultima attività si basa sui pasti segnati.</p>`}
      </section>

      <section class="settings-section">
        <h2>Prossimo controllo</h2>
        <p class="stat-riga"><span>${pc ? formattaDataIt(pc.data) : "Nessuna data"}</span><strong>${testoControllo}</strong></p>
        <div class="editor-campo" style="flex-direction:row; gap:8px; align-items:stretch; margin-top:8px;">
          <input type="date" id="input-prossima-visita" value="${pc ? pc.data : ""}" style="flex:1;" aria-label="Data del prossimo controllo">
          <button type="button" class="btn" id="btn-salva-visita" style="width:auto; padding:0 16px;">Salva</button>
        </div>
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
    `;

    document.getElementById("btn-torna-stat").addEventListener("click", renderStatistiche);
    document.getElementById("btn-apri-piano-da-stat").addEventListener("click", () => apriEditorPaziente(id));
    const testo = () => document.getElementById("testo-incoraggiamento").value.trim();
    document.getElementById("btn-msg-whatsapp").addEventListener("click", () => {
      window.open("https://wa.me/?text=" + encodeURIComponent(testo()), "_blank", "noopener");
    });
    const btnEmail = document.getElementById("btn-msg-email");
    if (btnEmail) btnEmail.addEventListener("click", () => {
      location.href = `mailto:${encodeURIComponent(piano.pazienteEmail)}?subject=${encodeURIComponent("Il tuo piano nutrizionale")}&body=${encodeURIComponent(testo())}`;
    });
    document.getElementById("btn-salva-visita").addEventListener("click", async (e) => {
      const valore = document.getElementById("input-prossima-visita").value || null;
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await window.cloud.salvaPiano(id, { prossimaVisita: valore });
        piano.prossimaVisita = valore;
        STAT.risultati[id].r.prossimoControllo = valore
          ? { data: valore, traGiorni: window.statistiche.differenzaGiorni(window.statistiche.daChiave(valore), new Date()) }
          : null;
        mostraToast(valore ? "Prossimo controllo salvato" : "Data del controllo rimossa");
        renderStatistichePaziente(id);
      } catch (err) {
        btn.disabled = false;
        mostraToast(msgErroreScrittura(err, "Data non salvata: controlla la connessione"));
      }
    });
  }

  // ---------------------------------------------------------------------
  // Ricettario (lato professionista)
  // ---------------------------------------------------------------------
  const ETICHETTE_RICETTE = ["Colazione", "Spuntino", "Pranzo", "Cena", "Vegetariana", "Vegana", "Senza glutine", "Senza lattosio", "Meal prep", "Veloce", "Dolce"];
  const MAX_ALLEGATO = 10 * 1024 * 1024;
  const RICPRO = { elenco: [], unsub: null, pronto: false, bozza: null };

  function scollegaRicettario() {
    if (RICPRO.unsub) { RICPRO.unsub(); RICPRO.unsub = null; }
    RICPRO.elenco = []; RICPRO.pronto = false; RICPRO.bozza = null;
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

  function renderRicettario() {
    vistaProfCorrente = "ricettario";
    pazienteSelezionatoId = null;
    document.getElementById("prof-header-titolo").textContent = "Ricettario";
    collegaRicettario();
    const puoScrivere = statoLicenza().attiva;

    profRoot.innerHTML = `
      <button type="button" class="link-btn" id="btn-torna-lista" style="margin-bottom:10px;">← I tuoi pazienti</button>
      <button type="button" class="btn" id="btn-nuova-ricetta" style="margin-bottom:16px;" ${puoScrivere ? "" : "disabled"}>+ Nuova ricetta</button>
      ${!puoScrivere ? `<p class="stat-nota" style="margin:-6px 2px 14px;">Per aggiungere o modificare ricette serve una licenza attiva.</p>` : ""}
      ${!RICPRO.pronto ? `<div class="empty">Caricamento…</div>`
        : RICPRO.elenco.length === 0 ? `<div class="empty">Qui raccogli le ricette da proporre ai tuoi pazienti: scritte direttamente nell'app oppure come PDF o foto di una scheda che hai già.</div>`
        : `<div class="lista-pazienti">
            ${RICPRO.elenco.map((r) => `
              <button type="button" class="ricetta-riga" data-ricetta-pro="${r.id}">
                <span class="ricetta-riga__foto" ${r.foto && r.foto.url ? `style="background-image:url('${escapeHTML(r.foto.url)}')"` : ""}>${r.foto && r.foto.url ? "" : (r.allegato ? "📄" : "🍲")}</span>
                <span class="ricetta-riga__testo">
                  <span class="paziente-card__nome">${escapeHTML(r.titolo || "Senza titolo")}</span>
                  <span class="paziente-card__email">${escapeHTML(destinatariTesto(r))}${(r.etichette || []).length ? " · " + escapeHTML(r.etichette.slice(0, 3).join(", ")) : ""}</span>
                </span>
              </button>`).join("")}
          </div>`}
    `;
    document.getElementById("btn-torna-lista").addEventListener("click", renderListaPazienti);
    document.getElementById("btn-nuova-ricetta").addEventListener("click", () => apriEditorRicetta(null));
    profRoot.querySelectorAll("[data-ricetta-pro]").forEach((b) => b.addEventListener("click", () => apriEditorRicetta(b.dataset.ricettaPro)));
  }

  function apriEditorRicetta(id) {
    const esistente = id ? RICPRO.elenco.find((r) => r.id === id) : null;
    RICPRO.bozza = {
      id: esistente ? esistente.id : window.cloud.nuovoIdRicetta(),
      nuova: !esistente,
      originale: esistente || null,
      foto: esistente && esistente.foto ? esistente.foto : null,
      allegato: esistente && esistente.allegato ? esistente.allegato : null,
      fotoNuova: null,       // { blob, nome, anteprima }
      allegatoNuovo: null,   // { blob, nome, tipo }
    };
    renderEditorRicetta();
    window.scrollTo(0, 0);
  }

  function renderEditorRicetta() {
    vistaProfCorrente = "ricettaEditor";
    const b = RICPRO.bozza;
    const r = b.originale || {};
    document.getElementById("prof-header-titolo").textContent = b.nuova ? "Nuova ricetta" : "Modifica ricetta";
    const etichette = r.etichette || [];
    const altre = etichette.filter((e) => !ETICHETTE_RICETTE.includes(e));
    const selezionati = new Set(r.destinatari || []);
    const perSelezionati = r.visibilita === "selezionati";
    const anteprimaFoto = b.fotoNuova ? b.fotoNuova.anteprima : (b.foto ? b.foto.url : null);
    const allegatoNome = b.allegatoNuovo ? b.allegatoNuovo.nome : (b.allegato ? b.allegato.nome : null);

    profRoot.innerHTML = `
      <button type="button" class="link-btn" id="btn-torna-ricettario" style="margin-bottom:10px;">← Ricettario</button>

      <section class="settings-section">
        <label class="editor-campo">Titolo
          <input type="text" id="ric-titolo" maxlength="90" value="${escapeHTML(r.titolo || "")}" placeholder="Es. Vellutata di zucca e ceci">
        </label>
      </section>

      <section class="settings-section">
        <h2>Foto</h2>
        <div class="ric-foto">
          <div class="ric-foto__anteprima" ${anteprimaFoto ? `style="background-image:url('${escapeHTML(anteprimaFoto)}')"` : ""}>${anteprimaFoto ? "" : "<span>Nessuna foto</span>"}</div>
          <div class="ric-foto__azioni">
            <label class="btn btn--ghost ric-file">${anteprimaFoto ? "Cambia foto" : "Scegli una foto"}<input type="file" id="ric-foto-file" accept="image/*" hidden></label>
            ${anteprimaFoto ? `<button type="button" class="link-btn" id="ric-foto-togli">Togli la foto</button>` : ""}
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h2>Dati</h2>
        <div class="ric-griglia">
          <label class="editor-campo">Porzioni<input type="number" id="ric-porzioni" min="1" max="50" inputmode="numeric" value="${escapeHTML(r.porzioni || "")}"></label>
          <label class="editor-campo">Tempo (minuti)<input type="number" id="ric-tempo" min="1" max="1440" inputmode="numeric" value="${escapeHTML(r.tempoMin || "")}"></label>
          <label class="editor-campo">Kcal a porzione<input type="number" id="ric-kcal" min="0" max="5000" inputmode="numeric" value="${escapeHTML(r.kcal || "")}"></label>
          <label class="editor-campo">Proteine (g)<input type="number" id="ric-proteine" min="0" step="0.1" inputmode="decimal" value="${escapeHTML(r.proteine != null ? r.proteine : "")}"></label>
          <label class="editor-campo">Carboidrati (g)<input type="number" id="ric-carboidrati" min="0" step="0.1" inputmode="decimal" value="${escapeHTML(r.carboidrati != null ? r.carboidrati : "")}"></label>
          <label class="editor-campo">Grassi (g)<input type="number" id="ric-grassi" min="0" step="0.1" inputmode="decimal" value="${escapeHTML(r.grassi != null ? r.grassi : "")}"></label>
        </div>
        <p class="stat-nota" style="margin-top:8px;">Tutti facoltativi. Kcal e macronutrienti si riferiscono a una porzione.</p>
      </section>

      <section class="settings-section">
        <h2>Etichette</h2>
        <div class="ricette-filtri" id="ric-etichette">
          ${ETICHETTE_RICETTE.map((e) => `<button type="button" class="chip-filtro" data-etichetta-ric="${escapeHTML(e)}" aria-pressed="${etichette.includes(e)}">${escapeHTML(e)}</button>`).join("")}
        </div>
        <label class="editor-campo" style="margin-top:10px;">Altre etichette, separate da virgola
          <input type="text" id="ric-altre-etichette" maxlength="120" value="${escapeHTML(altre.join(", "))}" placeholder="Es. Estiva, Proteica">
        </label>
      </section>

      <section class="settings-section">
        <h2>Ingredienti</h2>
        <label class="editor-campo">Uno per riga, con le quantità
          <textarea id="ric-ingredienti" rows="7" placeholder="400 g di zucca&#10;200 g di ceci cotti&#10;1 cipolla&#10;1 cucchiaio di olio extravergine">${escapeHTML((r.ingredienti || []).join("\n"))}</textarea>
        </label>
        <p class="stat-nota" style="margin-top:6px;">Il paziente potrà mandarli nella lista della spesa con un tocco: l'app riconosce gli alimenti e toglie le quantità.</p>
      </section>

      <section class="settings-section">
        <h2>Procedimento</h2>
        <label class="editor-campo">Un passaggio per riga
          <textarea id="ric-procedimento" rows="7" placeholder="Taglia la zucca a cubetti e rosolala con la cipolla.&#10;Aggiungi i ceci e copri con acqua calda.&#10;Cuoci 20 minuti e frulla.">${escapeHTML((r.procedimento || []).join("\n"))}</textarea>
        </label>
        <label class="editor-campo" style="margin-top:10px;">Note (facoltative)
          <textarea id="ric-note" rows="3" maxlength="1000" placeholder="Conservazione, varianti, consigli">${escapeHTML(r.note || "")}</textarea>
        </label>
      </section>

      <section class="settings-section">
        <h2>Scheda allegata</h2>
        <p class="stat-nota" style="margin:0 0 10px;">Se hai già la ricetta in PDF o in foto, allegala qui: puoi anche lasciare vuoti ingredienti e procedimento. Massimo 10 MB.</p>
        ${allegatoNome ? `<p class="stat-riga"><span>📎 ${escapeHTML(allegatoNome)}</span><button type="button" class="link-btn" id="ric-allegato-togli" style="width:auto; padding:0;">Togli</button></p>` : ""}
        <label class="btn btn--ghost ric-file" style="margin-top:8px;">${allegatoNome ? "Sostituisci l'allegato" : "Allega PDF o foto"}<input type="file" id="ric-allegato-file" accept="application/pdf,image/*" hidden></label>
      </section>

      <section class="settings-section">
        <h2>Chi la vede</h2>
        <label class="ric-scelta"><input type="radio" name="ric-visibilita" value="tutti" ${perSelezionati ? "" : "checked"}> Tutti i miei pazienti, anche quelli futuri</label>
        <label class="ric-scelta"><input type="radio" name="ric-visibilita" value="selezionati" ${perSelezionati ? "checked" : ""}> Solo i pazienti che scelgo</label>
        <div id="ric-destinatari" class="ric-destinatari" ${perSelezionati ? "" : "hidden"}>
          ${PAZIENTI_PROF.filter((p) => p.pazienteUid).map((p) => `
            <label class="ric-scelta"><input type="checkbox" value="${escapeHTML(p.pazienteUid)}" ${selezionati.has(p.pazienteUid) ? "checked" : ""}> ${escapeHTML(p.pazienteNome || p.pazienteEmail || "Paziente")}</label>`).join("") || `<p class="stat-nota">Non hai ancora pazienti.</p>`}
        </div>
      </section>

      <p id="ric-stato" class="stat-nota" role="status" style="margin:0 0 10px;"></p>
      <button type="button" class="btn" id="ric-salva">${b.nuova ? "Pubblica la ricetta" : "Salva le modifiche"}</button>
      ${b.nuova ? "" : `<button type="button" class="btn btn--ghost" id="ric-elimina" style="margin-top:10px;">Elimina la ricetta</button>`}
    `;

    const leggiModulo = () => {
      const num = (id, dec) => {
        const v = document.getElementById(id).value.trim().replace(",", ".");
        if (v === "") return null;
        const n = dec ? Math.round(Number(v) * 10) / 10 : Math.round(Number(v));
        return isFinite(n) && n >= 0 ? n : null;
      };
      const righe = (id) => document.getElementById(id).value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 80);
      const scelte = Array.from(profRoot.querySelectorAll("[data-etichetta-ric]")).filter((x) => x.getAttribute("aria-pressed") === "true").map((x) => x.dataset.etichettaRic);
      const altreEt = document.getElementById("ric-altre-etichette").value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8);
      const visibilita = profRoot.querySelector('input[name="ric-visibilita"]:checked').value;
      const destinatari = visibilita === "selezionati"
        ? Array.from(profRoot.querySelectorAll("#ric-destinatari input:checked")).map((x) => x.value) : [];
      return {
        titolo: document.getElementById("ric-titolo").value.trim(),
        porzioni: num("ric-porzioni"), tempoMin: num("ric-tempo"), kcal: num("ric-kcal"),
        proteine: num("ric-proteine", true), carboidrati: num("ric-carboidrati", true), grassi: num("ric-grassi", true),
        etichette: Array.from(new Set(scelte.concat(altreEt))),
        ingredienti: righe("ric-ingredienti"),
        procedimento: righe("ric-procedimento"),
        note: document.getElementById("ric-note").value.trim().slice(0, 1000),
        visibilita, destinatari,
      };
    };
    // Conserva quanto scritto quando la pagina viene ridisegnata (es. dopo aver scelto una foto)
    const ricordaModulo = () => { b.originale = Object.assign({}, b.originale || {}, leggiModulo()); };

    document.getElementById("btn-torna-ricettario").addEventListener("click", () => { RICPRO.bozza = null; renderRicettario(); });
    profRoot.querySelectorAll("[data-etichetta-ric]").forEach((x) => x.addEventListener("click", () => {
      x.setAttribute("aria-pressed", x.getAttribute("aria-pressed") === "true" ? "false" : "true");
    }));
    profRoot.querySelectorAll('input[name="ric-visibilita"]').forEach((x) => x.addEventListener("change", () => {
      document.getElementById("ric-destinatari").hidden = profRoot.querySelector('input[name="ric-visibilita"]:checked').value !== "selezionati";
    }));

    document.getElementById("ric-foto-file").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      ricordaModulo();
      try {
        const blob = await comprimiImmagine(file, 1600, 0.82);
        b.fotoNuova = { blob, nome: "foto.jpg", anteprima: URL.createObjectURL(blob) };
        renderEditorRicetta();
      } catch (err) {
        mostraToast("Non riesco a leggere questa immagine: prova con una foto JPG o PNG", 4000);
      }
    });
    const togliFoto = document.getElementById("ric-foto-togli");
    if (togliFoto) togliFoto.addEventListener("click", () => { ricordaModulo(); b.fotoNuova = null; b.foto = null; renderEditorRicetta(); });

    document.getElementById("ric-allegato-file").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      ricordaModulo();
      try {
        if (file.type === "application/pdf") {
          if (file.size > MAX_ALLEGATO) { mostraToast("Il PDF supera i 10 MB: riducilo e riprova", 4000); return; }
          b.allegatoNuovo = { blob: file, nome: file.name, tipo: "application/pdf" };
        } else if (file.type.startsWith("image/")) {
          const blob = await comprimiImmagine(file, 2200, 0.85);
          b.allegatoNuovo = { blob, nome: file.name.replace(/\.[^.]+$/, "") + ".jpg", tipo: "image/jpeg" };
        } else {
          mostraToast("Puoi allegare solo PDF o immagini", 3500); return;
        }
        renderEditorRicetta();
      } catch (err) {
        mostraToast("Non riesco a leggere questo file: prova con un PDF o una foto JPG", 4000);
      }
    });
    const togliAll = document.getElementById("ric-allegato-togli");
    if (togliAll) togliAll.addEventListener("click", () => { ricordaModulo(); b.allegatoNuovo = null; b.allegato = null; renderEditorRicetta(); });

    document.getElementById("ric-salva").addEventListener("click", () => salvaRicettaDaEditor(leggiModulo()));
    const elimina = document.getElementById("ric-elimina");
    if (elimina) elimina.addEventListener("click", confermaEliminaRicetta);
  }

  async function salvaRicettaDaEditor(dati) {
    const b = RICPRO.bozza;
    const stato = document.getElementById("ric-stato");
    const btn = document.getElementById("ric-salva");
    const errore = (msg) => { stato.textContent = msg; stato.style.color = "var(--stato-rosso)"; stato.scrollIntoView({ block: "center" }); };
    if (!dati.titolo) return errore("Scrivi il titolo della ricetta.");
    const haAllegato = !!(b.allegatoNuovo || b.allegato);
    if (!dati.ingredienti.length && !dati.procedimento.length && !haAllegato) {
      return errore("Inserisci ingredienti e procedimento, oppure allega la scheda della ricetta.");
    }
    if (dati.visibilita === "selezionati" && !dati.destinatari.length) return errore("Scegli almeno un paziente, oppure rendi la ricetta visibile a tutti.");

    btn.disabled = true;
    stato.style.color = "";
    const vecchi = [];
    try {
      if (b.fotoNuova) {
        stato.textContent = "Caricamento della foto…";
        const f = await window.cloud.caricaFileRicetta(UID, b.id, b.fotoNuova.nome, b.fotoNuova.blob, "image/jpeg",
          (x) => { stato.textContent = `Caricamento della foto… ${Math.round(x * 100)}%`; });
        if (b.originale && b.originale.foto && b.originale.foto.path) vecchi.push(b.originale.foto.path);
        b.foto = f; b.fotoNuova = null;
      } else if (!b.foto && b.originale && b.originale.foto && b.originale.foto.path) {
        vecchi.push(b.originale.foto.path);
      }
      if (b.allegatoNuovo) {
        stato.textContent = "Caricamento dell'allegato…";
        const a = await window.cloud.caricaFileRicetta(UID, b.id, b.allegatoNuovo.nome, b.allegatoNuovo.blob, b.allegatoNuovo.tipo,
          (x) => { stato.textContent = `Caricamento dell'allegato… ${Math.round(x * 100)}%`; });
        if (b.originale && b.originale.allegato && b.originale.allegato.path) vecchi.push(b.originale.allegato.path);
        b.allegato = Object.assign(a, { nome: b.allegatoNuovo.nome, tipo: b.allegatoNuovo.tipo });
        b.allegatoNuovo = null;
      } else if (!b.allegato && b.originale && b.originale.allegato && b.originale.allegato.path) {
        vecchi.push(b.originale.allegato.path);
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
    const r = b.originale;
    const overlay = apriSheet(`
      <h2 class="sheet__titolo">Eliminare "${escapeHTML(r.titolo || "questa ricetta")}"?</h2>
      <p class="sheet__nota sheet__nota--attenzione">La ricetta, la foto e l'allegato vengono cancellati per sempre e spariscono anche dall'app dei pazienti.</p>
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
    vistaProfCorrente = "editor";
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
      <div class="editor-navigazione">
        <button type="button" class="link-btn" id="btn-torna-lista">← I tuoi pazienti</button>
        <button type="button" class="link-btn" id="btn-andamento-paziente">Andamento</button>
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
        <label class="editor-campo" style="margin-top:10px;"><span>Data di inizio del piano</span><input type="date" id="editor-data-inizio" value="${escapeHTML(piano.dataInizio || "")}"></label>
        <p class="hint">La settimana di questa data è la Settimana 1; poi il ciclo passa alle settimane successive compilate e ricomincia. ${piano.dataInizio ? "" : "Se la lasci vuota vale il calendario generale dell'app."}</p>
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
        <h2>Importa / sostituisci l'intero piano</h2>
        <p class="hint">Per un piano tutto nuovo dalla nutrizionista, puoi caricare un file .json in un colpo solo, nello stesso formato scaricabile qui come modello.</p>
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
    collegaEditorPastoProfessionista();
    collegaCopiaSettimana();
    document.getElementById("btn-esporta-piano-prof").addEventListener("click", () => esportaPiano(piano));
    document.getElementById("input-importa-piano-prof").addEventListener("change", onFileImportPianoProf);
    document.getElementById("btn-elimina-paziente").addEventListener("click", apriConfermaEliminazione);
  }

  /** Markup dell'editor "Modifica un pasto": generico, lavora su un piano/settimana/giorno passati esplicitamente. */
  function renderEditorPastoHTML(piano, settSel, giornoSel, disponibili) {
    const giornoEdit = (piano.settimane[settSel] && piano.settimane[settSel][giornoSel]) || {};
    return `
      <section class="settings-section">
        <h2>Modifica un pasto</h2>
        <p class="hint">Scegli settimana e giorno, cambia il testo dei pasti e salva: si sincronizza subito con l'app del paziente.</p>
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
              <textarea data-campo="${key}" rows="2">${escapeHTML(giornoEdit[key] || "")}</textarea>
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
      const di = (document.getElementById("editor-data-inizio") || {}).value;
      if (di) extra.dataInizio = di;
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
  function renderCopiaSettimanaHTML(disponibili) {
    const origine = disponibili.includes(EDITOR_PROF.settSel) ? EDITOR_PROF.settSel : disponibili[0];
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

  function collegaCopiaSettimana() {
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
    document.getElementById("btn-copia-settimana").addEventListener("click", copiaSettimanaProfessionista);
  }

  async function copiaSettimanaProfessionista() {
    const piano = PIANO_ATTIVO_PROF;
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
  function renderProfiloProfessionista() {
    vistaProfCorrente = "profilo";
    pazienteSelezionatoId = null;
    document.getElementById("prof-header-titolo").textContent = "I miei dati di contatto";
    const c = PROFILO_PROF.contatti || {};
    const nome = c.nome || PROFILO_PROF.nome || "";
    const whatsapp = c.whatsapp !== false;

    profRoot.innerHTML = `
      <button type="button" class="link-btn" id="btn-torna-lista" style="margin-bottom:10px;">← I tuoi pazienti</button>
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
    `;
    document.getElementById("btn-torna-lista").addEventListener("click", renderListaPazienti);
    document.getElementById("btn-salva-profilo").addEventListener("click", salvaProfiloProfessionista);
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
      await window.cloud.eliminaPaziente(piano.id);
      chiudiSheet();
      mostraToast(`${piano.pazienteNome || "Paziente"} eliminato`);
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
    vistaProfCorrente = "nuovo";
    document.getElementById("prof-header-titolo").textContent = "Nuovo paziente";
    const passwordGenerata = generaPasswordProvvisoria();

    profRoot.innerHTML = `
      <button type="button" class="link-btn" id="btn-torna-lista" style="margin-bottom:10px;">← I tuoi pazienti</button>
      <section class="settings-section">
        <h2>Crea un nuovo paziente</h2>
        <p class="hint">Viene creato subito l'accesso del paziente e un piano di partenza (schema di esempio a 5 settimane) che potrai modificare pasto per pasto qui dentro. Comunica tu stesso email e password provvisoria al paziente.</p>
        <label class="editor-campo"><span>Nome e cognome paziente</span><input type="text" id="np-nome" required></label>
        <label class="editor-campo"><span>Email di accesso</span><input type="email" id="np-email" required></label>
        <label class="editor-campo"><span>Password provvisoria</span><input type="text" id="np-password" value="${passwordGenerata}"></label>
        <label class="editor-campo"><span>Data di inizio del piano</span><input type="date" id="np-inizio" value="${oggiISO()}"></label>
        <p class="hint">La settimana che contiene questa data è la Settimana 1 del piano; poi le settimane si alternano in ordine.</p>
        <p class="auth-error" id="np-error" hidden></p>
        <button type="button" class="btn" id="btn-crea-paziente" style="margin-top:14px;">Crea paziente</button>
      </section>
    `;

    document.getElementById("btn-torna-lista").addEventListener("click", renderListaPazienti);
    document.getElementById("btn-crea-paziente").addEventListener("click", onCreaPaziente);
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
      const nuovoUid = await window.cloud.creaPaziente({ email, password, nome, professionistaUid: UID });
      const pianoBase = JSON.parse(JSON.stringify(PIANO_TEMPLATE));
      pianoBase.paziente.nome = nome;
      const contatti = PROFILO_PROF.contatti || null;
      pianoBase.paziente.nutrizionista = (contatti && contatti.nome) || PROFILO_PROF.nome || "";
      if (contatti) pianoBase.contattiNutrizionista = contatti;
      pianoBase.dataInizio = dataInizio;
      await window.cloud.creaPiano(pianoBase, UID, nuovoUid, nome, email);
      mostraToast("Paziente creato — comunicagli email e password");
      renderListaPazienti();
    } catch (e) {
      mostraErroreIn("np-error", traduciErroreAuth(e));
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
  function registraServiceWorker() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    }
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
