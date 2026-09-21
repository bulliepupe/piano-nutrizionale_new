/**
 * app.js — logica dell'interfaccia.
 * Nessuna dipendenza esterna, nessun passaggio di build: apri index.html
 * (idealmente servito via HTTPS/GitHub Pages) e funziona.
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

  const LS_KEYS = {
    notifiche: "pnut:notifiche-attive",
    orari: "pnut:orari-override",
    tema: "pnut:tema",
    ultimoCheck: "pnut:ultimo-check",
    pastiFatti: "pnut:pasti-fatti", // + ":YYYY-MM-DD" per ogni giorno
    pianoCustom: "pnut:piano-custom", // piano importato dall'utente, sostituisce js/data.js
  };

  // Piano "di fabbrica" da js/data.js — resta sempre disponibile come fallback
  // e come base per i campi non specificati in un piano importato.
  const PIANO_BASE = window.PIANO;
  let PIANO_ATTIVO = caricaPianoPersonalizzato() || PIANO_BASE;

  const DEFAULT_CONFIG = {
    startDate: "2026-09-14",
    week5Months: [],
    overrideWeek: null,
    orari: Object.assign({}, PIANO_ATTIVO.orariDefault),
  };

  let CONFIG = DEFAULT_CONFIG;
  let currentView = "oggi";
  let settimanaAnteprima = null; // per la vista Settimana: null = usa quella corrente calcolata

  const root = document.getElementById("view-root");
  const dataOggiEl = document.getElementById("data-oggi");

  // ---------------------------------------------------------------------
  // Avvio
  // ---------------------------------------------------------------------
  init();

  async function init() {
    applyTema(localStorage.getItem(LS_KEYS.tema) || "sistema");
    CONFIG = await caricaConfig();
    pulisciPastiVecchi();
    aggiornaEyebrowData();
    registraServiceWorker();
    collegaTabbar();
    render();

    if (notificheAttive()) {
      pianificaNotificheOggi();
      mostraPromemoriaPerso();
    }
    aggiornaIconaCampanella();

    // Se l'app resta aperta a cavallo della mezzanotte, ripianifica.
    setInterval(() => {
      const oggi = new Date().toDateString();
      if (oggi !== ultimoGiornoRenderizzato) {
        ultimoGiornoRenderizzato = oggi;
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
      // Fallback silenzioso: succede ad es. alla primissima apertura offline
      // prima che il service worker abbia messo in cache config.json.
      return DEFAULT_CONFIG;
    }
  }

  function orariEffettivi() {
    const override = JSON.parse(localStorage.getItem(LS_KEYS.orari) || "null");
    return Object.assign({}, CONFIG.orari, override || {});
  }

  // ---------------------------------------------------------------------
  // Navigazione
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
    else renderImpostazioni();
  }

  function aggiornaEyebrowData() {
    const oggi = new Date();
    const fmt = oggi.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
    dataOggiEl.textContent = fmt;
  }

  // ---------------------------------------------------------------------
  // Vista "Oggi"
  // ---------------------------------------------------------------------
  function renderOggi() {
    const oggi = new Date();
    const { settimana, giornoNome, giorno } = window.weekLogic.menuDelGiorno(oggi, CONFIG, PIANO_ATTIVO);
    const orari = orariEffettivi();

    if (!giorno) {
      root.innerHTML = `<div class="empty">Nessun dato disponibile per oggi nel piano caricato. Controlla il file importato in Impostazioni.</div>`;
      return;
    }

    const dateKey = chiaveData(oggi);
    const fatti = caricaPastiFatti(dateKey);
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
        </article>
      `;
    }).join("");
  }

  // ---------------------------------------------------------------------
  // Spunta "pasto effettuato" (per giorno, salvata sul dispositivo)
  // ---------------------------------------------------------------------
  function chiaveData(date) {
    const d = date || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function caricaPastiFatti(dateKey) {
    try {
      return JSON.parse(localStorage.getItem(LS_KEYS.pastiFatti + ":" + dateKey) || "{}");
    } catch (e) {
      return {};
    }
  }

  function salvaPastiFatti(dateKey, stato) {
    localStorage.setItem(LS_KEYS.pastiFatti + ":" + dateKey, JSON.stringify(stato));
  }

  function onToggleMealCheck(key) {
    const dateKey = chiaveData(new Date());
    const stato = caricaPastiFatti(dateKey);
    stato[key] = !stato[key];
    salvaPastiFatti(dateKey, stato);
    renderOggi();
  }

  /** Rimuove le spunte più vecchie di 21 giorni per non far crescere localStorage all'infinito. */
  function pulisciPastiVecchi() {
    const prefisso = LS_KEYS.pastiFatti + ":";
    const adesso = Date.now();
    Object.keys(localStorage).forEach((k) => {
      if (!k.startsWith(prefisso)) return;
      const d = new Date(k.slice(prefisso.length));
      if (isNaN(d.getTime())) return;
      if ((adesso - d.getTime()) / 86400000 > 21) localStorage.removeItem(k);
    });
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
    const norme = PIANO_ATTIVO.normeGenerali || [];
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
    if (pillAttiva) pillAttiva.scrollIntoView({ inline: "center", block: "nearest" });
  }

  // ---------------------------------------------------------------------
  // Vista "Impostazioni"
  // ---------------------------------------------------------------------
  function renderImpostazioni() {
    const p = PIANO_ATTIVO.paziente || {};
    const orari = orariEffettivi();
    const attive = notificheAttive();
    const permesso = ("Notification" in window) ? Notification.permission : "unsupported";
    const haCustom = !!localStorage.getItem(LS_KEYS.pianoCustom);

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
        <h2>Il piano</h2>
        <div class="card-info">
          <dl>
            <dt>Paziente</dt><dd>${escapeHTML(p.nome || "—")}</dd>
            <dt>Obiettivo</dt><dd>${escapeHTML(p.obiettivo || "—")}</dd>
            <dt>Target giornaliero</dt><dd>${p.targetKcal != null ? "~" + p.targetKcal + " kcal" : "—"}</dd>
            <dt>Nutrizionista</dt><dd>${escapeHTML(p.nutrizionista || "—")}</dd>
          </dl>
        </div>
        ${haCustom ? `<p class="hint" style="margin-top:10px;"><span class="status-dot ok" style="display:inline-block;margin-right:6px;"></span>Stai usando un piano importato manualmente.</p>` : ""}
        <p class="hint" style="margin-top:14px;">Il ciclo delle settimane e la regola della 5ª settimana si modificano nel file <code class="inline">config.json</code> del progetto — istruzioni nel README.</p>
      </section>

      <section class="settings-section">
        <h2>Importa / sostituisci il piano</h2>
        <p class="hint">Carica un file .json per personalizzare o sostituire il menu attuale. Scarica prima il modello: ha già il formato corretto, così eviti errori — modifica solo i testi dei pasti e ricaricalo.</p>
        <div class="import-actions">
          <button type="button" class="btn btn--ghost" id="btn-esporta-piano">Scarica il piano attuale come modello (.json)</button>
          <label class="btn" for="input-importa-piano">Importa piano da file…</label>
          <input type="file" id="input-importa-piano" accept="application/json,.json" hidden>
          ${haCustom ? `<button type="button" class="btn btn--ghost" id="btn-reset-piano">Ripristina il piano originale</button>` : ""}
        </div>
      </section>
    `;

    document.getElementById("chk-notifiche").addEventListener("change", onToggleNotificheDettaglio);
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
        if (notificheAttive()) pianificaNotificheOggi();
        mostraToast("Orario aggiornato");
      });
    });

    document.getElementById("btn-esporta-piano").addEventListener("click", esportaPianoAttuale);
    document.getElementById("input-importa-piano").addEventListener("change", onFileImportPiano);
    const btnReset = document.getElementById("btn-reset-piano");
    if (btnReset) {
      btnReset.addEventListener("click", () => {
        localStorage.removeItem(LS_KEYS.pianoCustom);
        PIANO_ATTIVO = PIANO_BASE;
        CONFIG.orari = Object.assign({}, PIANO_ATTIVO.orariDefault, CONFIG.orari && JSON.parse(localStorage.getItem(LS_KEYS.orari) || "null") || {});
        mostraToast("Ripristinato il piano originale");
        render();
      });
    }
  }

  // ---------------------------------------------------------------------
  // Importazione / esportazione del piano nutrizionale
  // ---------------------------------------------------------------------

  /** Legge ed eventualmente convalida il piano personalizzato salvato; scarta dati corrotti. */
  function caricaPianoPersonalizzato() {
    const raw = localStorage.getItem(LS_KEYS.pianoCustom);
    if (!raw) return null;
    try {
      const risultato = validaPiano(JSON.parse(raw));
      if (risultato.ok) return risultato.piano;
    } catch (e) { /* JSON corrotto, ignora */ }
    localStorage.removeItem(LS_KEYS.pianoCustom);
    return null;
  }

  function esportaPianoAttuale() {
    const blob = new Blob([JSON.stringify(PIANO_ATTIVO, null, 2)], { type: "application/json" });
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

  function onFileImportPiano(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // consente di ricaricare subito lo stesso file se corretto
    if (!file) return;
    if (!/\.json$/i.test(file.name) && file.type && file.type !== "application/json") {
      mostraToast("Il file deve essere in formato .json");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => mostraToast("Impossibile leggere il file");
    reader.onload = () => {
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
      localStorage.setItem(LS_KEYS.pianoCustom, JSON.stringify(risultato.piano));
      PIANO_ATTIVO = risultato.piano;
      mostraToast("Piano importato correttamente");
      render();
    };
    reader.readAsText(file);
  }

  /**
   * Convalida un oggetto piano importato dall'utente e lo normalizza nello
   * stesso formato di js/data.js, così il resto dell'app non deve sapere
   * se il piano attivo è quello di fabbrica o uno importato.
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
      orariDefault: Object.assign({}, PIANO_BASE.orariDefault, orariDefaultIn),
      normeGenerali: Array.isArray(input.normeGenerali) ? input.normeGenerali.filter((n) => typeof n === "string" && n.trim()) : [],
      settimane: settimaneValide,
    };

    return { ok: true, piano };
  }

  function statoNotificheTesto(permesso, attive) {
    if (permesso === "unsupported") return "Non supportate su questo browser";
    if (permesso === "denied") return "Bloccate nelle impostazioni del browser/telefono";
    if (attive && permesso === "granted") return "Attivi su questo dispositivo";
    return "Disattivati";
  }

  function applyTema(v) {
    if (v === "sistema") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", v);
  }

  // ---------------------------------------------------------------------
  // Notifiche
  // ---------------------------------------------------------------------
  function notificheAttive() {
    return localStorage.getItem(LS_KEYS.notifiche) === "1";
  }

  async function onToggleNotificheRapido() {
    if (notificheAttive()) {
      localStorage.setItem(LS_KEYS.notifiche, "0");
      aggiornaIconaCampanella();
      mostraToast("Promemoria disattivati");
      if (currentView === "impostazioni") render();
      return;
    }
    await attivaNotifiche();
  }

  async function onToggleNotificheDettaglio(e) {
    if (e.target.checked) {
      const ok = await attivaNotifiche();
      if (!ok) render();
    } else {
      localStorage.setItem(LS_KEYS.notifiche, "0");
      aggiornaIconaCampanella();
      mostraToast("Promemoria disattivati");
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
    return true;
  }

  function aggiornaIconaCampanella() {
    document.getElementById("btn-notifiche").classList.toggle("is-on", notificheAttive());
  }

  let timersProgrammati = [];
  function pianificaNotificheOggi() {
    timersProgrammati.forEach((t) => clearTimeout(t));
    timersProgrammati = [];

    const oggi = new Date();
    const { giorno } = window.weekLogic.menuDelGiorno(oggi, CONFIG, PIANO_ATTIVO);
    if (!giorno) return;
    const orari = orariEffettivi();

    MEAL_KEYS.forEach((key) => {
      const orario = orari[key];
      if (!orario) return;
      const [h, m] = orario.split(":").map(Number);
      const quando = new Date(oggi);
      quando.setHours(h, m, 0, 0);
      const attesa = quando.getTime() - Date.now();
      if (attesa <= 0) return; // già passato per oggi
      const id = setTimeout(() => {
        mostraNotifica(MEAL_META[key].label, giorno[key]);
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

  /** Se l'app viene riaperta poco dopo l'orario di un pasto (entro 90 minuti), mostra comunque il promemoria. */
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

  // ---------------------------------------------------------------------
  // Service worker & utilità
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
