

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

    document.getElementById("btn-mostra-signup").addEventListener("click", () => {
      document.getElementById("blocco-signup-professionista").hidden = true;
      document.getElementById("form-login").hidden = true;
      document.getElementById("form-signup").hidden = false;
    });
    document.getElementById("btn-annulla-signup").addEventListener("click", () => {
      document.getElementById("form-signup").hidden = true;
      document.getElementById("form-login").hidden = false;
      document.getElementById("blocco-signup-professionista").hidden = false;
    });

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

    setInterval(() => {
      const oggi = new Date().toDateString();
      if (oggi !== ultimoGiornoRenderizzato) {
        ultimoGiornoRenderizzato = oggi;
        collegaAscoltoPastiOggi();
        render();
        if (notificheAttive()) pianificaNotificheOggi();
      }
    }, 60 * 1000);
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
    const { settimana, giornoNome, giorno } = window.weekLogic.menuDelGiorno(oggi, CONFIG, PIANO_ATTIVO);
    const orari = orariEffettivi();

    if (!giorno) {
      root.innerHTML = `<div class="empty">Nessun dato disponibile per oggi nel piano caricato.</div>`;
      return;
    }

    const fatti = PASTI_FATTI_OGGI;
    const numFatti = MEAL_KEYS.filter((k) => fatti[k]).length;

    root.innerHTML = `
      <section class="hero">
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
    `;

    root.querySelectorAll("[data-meal-check]").forEach((btn) => {
      btn.addEventListener("click", () => onToggleMealCheck(btn.dataset.mealCheck));
    });
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
    const { settimana: settimanaCorrente, giornoIndex: oggiIndex } = window.weekLogic.calcolaSettimanaGiorno(oggi, CONFIG);
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
  // Vista "Spesa" — lista della spesa generata dai pasti della settimana
  // ---------------------------------------------------------------------
  let spesaSettimanaSelezionata = null; // null = usa la settimana corrente calcolata

  /**
   * Divide il testo di un pasto sul separatore " + ", MA senza spezzare un "+"
   * che si trova dentro una parentesi (es. "Omelette (1 uovo + 150g albumi)"
   * deve restare un unico segmento da scomporre poi al suo interno).
   */
  function dividiRispettandoParentesi(testo) {
    const segmenti = [];
    let corrente = "";
    let profondita = 0;
    for (let i = 0; i < testo.length; i++) {
      const ch = testo[i];
      if (ch === "(") profondita++;
      if (ch === ")") profondita = Math.max(0, profondita - 1);
      if (ch === "+" && profondita === 0 && testo[i - 1] === " " && testo[i + 1] === " ") {
        segmenti.push(corrente.trim());
        corrente = "";
      } else {
        corrente += ch;
      }
    }
    if (corrente.trim()) segmenti.push(corrente.trim());
    return segmenti;
  }

  /** Estrae una o più voci {nome, quantita, unita} da UN segmento (senza "+" fuori parentesi). */
  function estraiVociSegmento(testoSegmento) {
    const out = [];
    const matchParen = testoSegmento.match(/\(([^)]*)\)/);
    const base = testoSegmento.replace(/\([^)]*\)/g, "").trim();
    const parenContenuto = matchParen ? matchParen[1].trim() : "";

    const parenSembraIngredienti = parenContenuto
      && (parenContenuto.includes(",") || parenContenuto.includes("+") || /\d/.test(parenContenuto))
      && !/^(no |senza )/i.test(parenContenuto)
      && parenContenuto.length < 80;

    if (parenSembraIngredienti && (parenContenuto.includes(",") || parenContenuto.includes("+"))) {
      // Il nome del piatto (es. "Omelette", "Risotto alla robiola") non è di per
      // sé un ingrediente da comprare: contano i componenti tra parentesi.
      parenContenuto.split(/,|\+/).forEach((p) => out.push(...parseVoceSingola(p.trim())));
    } else if (base) {
      out.push(...parseVoceSingola(base));
    } else if (parenContenuto) {
      out.push(...parseVoceSingola(parenContenuto));
    }
    return out;
  }

  function parseVoceSingola(testo) {
    testo = testo.trim();
    if (!testo) return [];
    if (/^(NO |SENZA )/i.test(testo)) return []; // note come "NO PANE"

    // "3 fette biscottate integrali" / "1 uovo"
    let m = testo.match(/^(\d+)\s+(.+)$/);
    if (m) return [{ nome: capitalizzaVoce(m[2].trim()), quantita: Number(m[1]), unita: "pz" }];

    // "Pollo alla griglia 220g" / "Latte p.s. 200ml"
    m = testo.match(/^(.*?)\s+(\d+(?:[.,]\d+)?)\s*(g|kg|ml|l)\b\.?\s*$/i);
    if (m) return [{ nome: capitalizzaVoce(m[1].trim()), quantita: Number(m[2].replace(",", ".")), unita: m[3].toLowerCase() }];

    // "150g albumi" (quantità prima del nome)
    m = testo.match(/^(\d+(?:[.,]\d+)?)\s*(g|kg|ml|l)\s+(.+)$/i);
    if (m) return [{ nome: capitalizzaVoce(m[3].trim()), quantita: Number(m[1].replace(",", ".")), unita: m[2].toLowerCase() }];

    return [{ nome: capitalizzaVoce(testo), quantita: null, unita: null }];
  }

  function capitalizzaVoce(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function estraiVociDaPasto(testoPasto) {
    return dividiRispettandoParentesi(testoPasto).flatMap(estraiVociSegmento);
  }

  /** Aggrega gli ingredienti di tutti i pasti dei 7 giorni di una settimana, sommando le quantità con la stessa unità. */
  function aggregaIngredientiSettimana(giorni) {
    const mappa = new Map();
    giorni.forEach((g) => {
      MEAL_KEYS.forEach((k) => {
        estraiVociDaPasto(g[k] || "").forEach((v) => {
          const chiave = v.nome.toLowerCase() + "|" + (v.unita || "");
          if (!mappa.has(chiave)) {
            mappa.set(chiave, { nome: v.nome, quantita: v.quantita, unita: v.unita, occorrenze: 1 });
          } else {
            const voce = mappa.get(chiave);
            voce.occorrenze += 1;
            if (v.quantita != null && voce.quantita != null) voce.quantita += v.quantita;
            else if (v.quantita != null) voce.quantita = v.quantita;
          }
        });
      });
    });
    return Array.from(mappa.values()).sort((a, b) => a.nome.localeCompare(b.nome, "it"));
  }

  function chiaveSpunteSpesa(settimana) { return "pnut:spesa-spuntate:" + settimana; }
  function chiaveExtraSpesa(settimana) { return "pnut:spesa-extra:" + settimana; }

  function renderSpesa() {
    if (!PIANO_ATTIVO) {
      root.innerHTML = `<div class="empty">Il tuo professionista non ha ancora assegnato un piano a questo account.</div>`;
      return;
    }
    const oggi = new Date();
    const { settimana: settimanaCorrente } = window.weekLogic.calcolaSettimanaGiorno(oggi, CONFIG);
    const settimanaMostrata = spesaSettimanaSelezionata || settimanaCorrente;
    const giorni = PIANO_ATTIVO.settimane[settimanaMostrata];

    if (!giorni) {
      root.innerHTML = `<div class="empty">La settimana ${settimanaMostrata} non è presente nel piano caricato.</div>`;
      return;
    }

    const opzioniSettimana = [1, 2, 3, 4, 5]
      .filter((n) => Array.isArray(PIANO_ATTIVO.settimane[n]))
      .map((n) => `<option value="${n}" ${n === settimanaMostrata ? "selected" : ""}>Settimana ${n}${n === settimanaCorrente ? " (attuale)" : ""}</option>`)
      .join("");

    const voci = aggregaIngredientiSettimana(giorni);
    const spuntate = JSON.parse(localStorage.getItem(chiaveSpunteSpesa(settimanaMostrata)) || "[]");
    const extra = JSON.parse(localStorage.getItem(chiaveExtraSpesa(settimanaMostrata)) || "[]");
    const spuntateSet = new Set(spuntate);

    function rigaHTML(testo, chiaveSpunta, extra) {
      const isSpuntata = spuntateSet.has(chiaveSpunta);
      return `
        <li class="spesa-riga ${isSpuntata ? "is-spuntata" : ""}">
          <label>
            <input type="checkbox" data-spunta="${escapeHTML(chiaveSpunta)}" ${isSpuntata ? "checked" : ""}>
            <span>${escapeHTML(testo)}</span>
          </label>
          ${extra ? `<button type="button" class="spesa-rimuovi" data-rimuovi-extra="${escapeHTML(chiaveSpunta)}" aria-label="Rimuovi">✕</button>` : ""}
        </li>
      `;
    }

    root.innerHTML = `
      <section class="hero" style="border-bottom:none; margin-bottom:8px; padding-bottom:6px;">
        <div class="hero__eyebrow"><span class="dot"></span> Lista della spesa</div>
        <div class="hero__meta" style="margin-top:10px;">
          <select id="sel-settimana-spesa" aria-label="Settimana">${opzioniSettimana}</select>
        </div>
      </section>
      <p class="hint" style="margin:0 0 14px;">Generata automaticamente dai pasti della settimana — il testo libero dei menu non sempre si presta a un'estrazione perfetta, controllala prima di uscire a fare la spesa.</p>

      <ul class="spesa-lista" id="spesa-lista">
        ${voci.map((v) => {
          const testo = v.quantita != null ? `${v.nome} — ${arrotondaQuantita(v.quantita)}${v.unita}` : `${v.nome}${v.occorrenze > 1 ? " ×" + v.occorrenze : ""}`;
          return rigaHTML(testo, "auto:" + v.nome.toLowerCase() + "|" + (v.unita || ""), false);
        }).join("")}
        ${extra.map((testo) => rigaHTML(testo, "extra:" + testo.toLowerCase(), true)).join("")}
      </ul>

      <div class="import-actions" style="margin-top:16px;">
        <div class="editor-campo" style="flex-direction:row; gap:8px; align-items:stretch;">
          <input type="text" id="input-spesa-extra" placeholder="Aggiungi un articolo…" style="flex:1;">
          <button type="button" class="btn" id="btn-aggiungi-spesa" style="width:auto; padding:0 16px;">Aggiungi</button>
        </div>
        <button type="button" class="btn btn--ghost" id="btn-copia-spesa">Copia lista negli appunti</button>
      </div>
    `;

    document.getElementById("sel-settimana-spesa").addEventListener("change", (e) => {
      const v = Number(e.target.value);
      spesaSettimanaSelezionata = v === settimanaCorrente ? null : v;
      renderSpesa();
    });

    root.querySelectorAll("[data-spunta]").forEach((chk) => {
      chk.addEventListener("change", () => {
        const chiave = chk.dataset.spunta;
        const stato = new Set(JSON.parse(localStorage.getItem(chiaveSpunteSpesa(settimanaMostrata)) || "[]"));
        if (chk.checked) stato.add(chiave); else stato.delete(chiave);
        localStorage.setItem(chiaveSpunteSpesa(settimanaMostrata), JSON.stringify(Array.from(stato)));
        chk.closest(".spesa-riga").classList.toggle("is-spuntata", chk.checked);
      });
    });

    root.querySelectorAll("[data-rimuovi-extra]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const testoDaRimuovere = btn.dataset.rimuoviExtra.slice("extra:".length);
        const listaExtra = JSON.parse(localStorage.getItem(chiaveExtraSpesa(settimanaMostrata)) || "[]");
        const nuovaLista = listaExtra.filter((t) => t.toLowerCase() !== testoDaRimuovere);
        localStorage.setItem(chiaveExtraSpesa(settimanaMostrata), JSON.stringify(nuovaLista));
        renderSpesa();
      });
    });

    document.getElementById("btn-aggiungi-spesa").addEventListener("click", () => {
      const input = document.getElementById("input-spesa-extra");
      const testo = input.value.trim();
      if (!testo) return;
      const listaExtra = JSON.parse(localStorage.getItem(chiaveExtraSpesa(settimanaMostrata)) || "[]");
      listaExtra.push(testo);
      localStorage.setItem(chiaveExtraSpesa(settimanaMostrata), JSON.stringify(listaExtra));
      renderSpesa();
    });
    document.getElementById("input-spesa-extra").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); document.getElementById("btn-aggiungi-spesa").click(); }
    });

    document.getElementById("btn-copia-spesa").addEventListener("click", async () => {
      const righe = voci.map((v) => v.quantita != null ? `- ${v.nome} — ${arrotondaQuantita(v.quantita)}${v.unita}` : `- ${v.nome}${v.occorrenze > 1 ? " ×" + v.occorrenze : ""}`)
        .concat(extra.map((t) => `- ${t}`));
      const testoCompleto = `Lista della spesa — Settimana ${settimanaMostrata}\n\n` + righe.join("\n");
      try {
        await navigator.clipboard.writeText(testoCompleto);
        mostraToast("Lista copiata negli appunti");
      } catch (e) {
        mostraToast("Impossibile copiare automaticamente su questo browser");
      }
    });
  }

  function arrotondaQuantita(n) {
    return Number.isInteger(n) ? n : Math.round(n * 10) / 10;
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
        <p class="hint">Un avviso sul telefono quando è il momento di mangiare, con il menu del momento. Funziona mentre l'app è aperta o recentemente usata; per il funzionamento anche ad app chiusa vedi il file README del progetto.</p>
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
              <dt>Nutrizionista</dt><dd>${escapeHTML(p.nutrizionista || "—")}</dd>
            </dl>
          </div>
        ` : `<p class="hint">Nessun piano assegnato ancora.</p>`}
        <p class="hint" style="margin-top:14px;">Pasti, regole generali e dati del piano vengono aggiornati dal tuo professionista e si sincronizzano automaticamente qui — da questa app si possono solo consultare.</p>
      </section>
    `;

    document.getElementById("chk-notifiche").addEventListener("change", onToggleNotificheDettaglio);
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
    if (permesso === "unsupported") return "Non supportate su questo browser";
    if (permesso === "denied") return "Bloccate nelle impostazioni del browser/telefono";
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
    if (!("Notification" in window)) {
      mostraToast("Il browser non supporta le notifiche");
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
    if (!window.cloud.pushSupportato) return;
    await window.cloud.registraTokenPush(UID);
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
    const opts = { body: corpo, icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: "pasto-" + titolo };
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then((reg) => reg.showNotification(titolo, opts)).catch(() => {
        try { new Notification(titolo, opts); } catch (e) {}
      });
    } else {
      try { new Notification(titolo, opts); } catch (e) {}
    }
  }

  function mostraPromemoriaPerso() {
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

  // =======================================================================
  // LATO PROFESSIONISTA
  // =======================================================================
  function avviaProfessionista(utenteDati) {
    mostraSchermata("professionista");
    applyTema(localStorage.getItem(LS_KEYS.tema) || "sistema");
    registraServiceWorker();
    vistaProfCorrente = "lista";
    pazienteSelezionatoId = null;

    unsubPazienti = window.cloud.ascoltaPazientiProfessionista(UID, (pazienti) => {
      PAZIENTI_PROF = pazienti;
      if (vistaProfCorrente === "lista") {
        renderListaPazienti();
      } else if (vistaProfCorrente === "editor" && pazienteSelezionatoId) {
        const aggiornato = pazienti.find((p) => p.id === pazienteSelezionatoId);
        if (aggiornato) {
          PIANO_ATTIVO_PROF = aggiornato;
          renderEditorProfessionista();
        }
      }
    });

    renderListaPazienti();
  }

  function renderListaPazienti() {
    vistaProfCorrente = "lista";
    pazienteSelezionatoId = null;
    document.getElementById("prof-header-titolo").textContent = "I tuoi pazienti";

    profRoot.innerHTML = `
      <button type="button" class="btn" id="btn-nuovo-paziente" style="margin-bottom:16px;">+ Nuovo paziente</button>
      ${PAZIENTI_PROF.length === 0 ? `
        <div class="empty">Non hai ancora pazienti. Creane uno con il pulsante qui sopra.</div>
      ` : `
        <div class="lista-pazienti">
          ${PAZIENTI_PROF.map((p) => `
            <button type="button" class="paziente-card" data-id="${p.id}">
              <span class="paziente-card__nome">${escapeHTML(p.pazienteNome || "—")}</span>
              <span class="paziente-card__email">${escapeHTML(p.pazienteEmail || "")}</span>
              ${p.paziente && p.paziente.obiettivo ? `<span class="paziente-card__obiettivo">${escapeHTML(p.paziente.obiettivo)}</span>` : ""}
            </button>
          `).join("")}
        </div>
      `}
    `;

    document.getElementById("btn-nuovo-paziente").addEventListener("click", renderFormNuovoPaziente);
    document.querySelectorAll(".paziente-card").forEach((btn) => {
      btn.addEventListener("click", () => apriEditorPaziente(btn.dataset.id));
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
      <button type="button" class="link-btn" id="btn-torna-lista" style="margin-bottom:10px;">← I tuoi pazienti</button>

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
          <label class="editor-campo"><span>Nutrizionista</span><input type="text" data-campo="nutrizionista" value="${escapeHTML(pz.nutrizionista || "")}"></label>
        </div>
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

      <section class="settings-section">
        <h2>Importa / sostituisci l'intero piano</h2>
        <p class="hint">Per un piano tutto nuovo dalla nutrizionista, puoi caricare un file .json in un colpo solo, nello stesso formato scaricabile qui come modello.</p>
        <div class="import-actions">
          <button type="button" class="btn btn--ghost" id="btn-esporta-piano-prof">Scarica questo piano come modello (.json)</button>
          <label class="btn" for="input-importa-piano-prof">Importa piano da file…</label>
          <input type="file" id="input-importa-piano-prof" accept="application/json,.json" hidden>
        </div>
      </section>
    `;

    document.getElementById("btn-torna-lista").addEventListener("click", renderListaPazienti);
    document.getElementById("btn-salva-dati-paziente").addEventListener("click", salvaDatiPazienteProfessionista);
    document.getElementById("btn-salva-norme").addEventListener("click", salvaNormeGeneraliProfessionista);
    document.getElementById("btn-salva-sostituzioni").addEventListener("click", salvaSostituzioniProfessionista);
    collegaEditorPastoProfessionista();
    document.getElementById("btn-esporta-piano-prof").addEventListener("click", () => esportaPiano(piano));
    document.getElementById("input-importa-piano-prof").addEventListener("change", onFileImportPianoProf);
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
      mostraToast("Salvataggio non riuscito: controlla la connessione", 4000);
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
      mostraToast("Salvataggio non riuscito: controlla la connessione", 4000);
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
      mostraToast("Salvataggio non riuscito: controlla la connessione", 4000);
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
      await window.cloud.salvaPiano(piano.id, Object.assign({}, risultato.piano, { pazienteNome: nuovoPazienteNome }));
      mostraToast("Dati paziente salvati e sincronizzati");
    } catch (e) {
      mostraToast("Salvataggio non riuscito: controlla la connessione", 4000);
    } finally {
      btn.disabled = false;
      btn.textContent = "Salva dati paziente";
    }
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

    const btn = document.getElementById("btn-crea-paziente");
    btn.disabled = true;
    btn.textContent = "Creazione in corso…";

    try {
      const nuovoUid = await window.cloud.creaPaziente({ email, password, nome, professionistaUid: UID });
      const pianoBase = JSON.parse(JSON.stringify(PIANO_TEMPLATE));
      pianoBase.paziente.nome = nome;
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
        mostraToast("Salvataggio non riuscito: controlla la connessione", 4000);
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
