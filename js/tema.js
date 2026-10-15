/**
 * tema.js — aspetto dell'app scelto dall'utente.
 *
 * Quattro scelte indipendenti, applicate come attributi su <html> e lette
 * dal CSS (css/style.css, sezione "Temi"):
 *   data-stile   classico | vivace | essenziale   (caratteri, forme, scheda Oggi)
 *   data-colore  salvia | oceano | agrume | lavanda | ciliegia | grafite
 *   data-theme   light | dark  (assente = segue il sistema)
 *   data-testo   grande        (assente = normale)
 *
 * Si carica nel <head>, prima del CSS: così la pagina nasce già con i colori
 * giusti. Le scelte stanno in questo dispositivo (localStorage) e, per chi ha
 * un account, anche nel profilo (campo "aspetto"), così valgono ovunque.
 */
(function () {
  "use strict";

  const LS = "pnut:aspetto";
  const LS_TEMA_VECCHIO = "pnut:tema"; // chiaro | scuro | sistema (versioni precedenti)

  const STILI = [
    { id: "classico", nome: "Classico" },
    { id: "vivace", nome: "Vivace" },
    { id: "essenziale", nome: "Essenziale" },
  ];
  const COLORI = [
    { id: "salvia", nome: "Salvia", chiaro: "#2F5D46", scuro: "#8FD9B0" },
    { id: "oceano", nome: "Oceano", chiaro: "#2B5C8A", scuro: "#8EC1F0" },
    { id: "agrume", nome: "Agrume", chiaro: "#B8461A", scuro: "#FF9A62" },
    { id: "lavanda", nome: "Lavanda", chiaro: "#5E50A0", scuro: "#C1B6F2" },
    { id: "ciliegia", nome: "Ciliegia", chiaro: "#9E2F4A", scuro: "#F2A0B5" },
    { id: "grafite", nome: "Grafite", chiaro: "#3B4048", scuro: "#C9CED6" },
  ];
  const ASPETTI = ["chiaro", "scuro", "sistema"];
  const PREDEFINITO = { stile: "classico", colore: "salvia", aspetto: "sistema", testo: "normale" };

  function valido(a) {
    const out = Object.assign({}, PREDEFINITO);
    if (a && STILI.some((s) => s.id === a.stile)) out.stile = a.stile;
    if (a && COLORI.some((c) => c.id === a.colore)) out.colore = a.colore;
    if (a && ASPETTI.includes(a.aspetto)) out.aspetto = a.aspetto;
    if (a && (a.testo === "grande" || a.testo === "normale")) out.testo = a.testo;
    return out;
  }

  function leggi() {
    let a = null;
    try { a = JSON.parse(localStorage.getItem(LS) || "null"); } catch (e) { a = null; }
    if (!a) {
      // prima volta con questa versione: si conserva il chiaro/scuro scelto prima
      let vecchio = null;
      try { vecchio = localStorage.getItem(LS_TEMA_VECCHIO); } catch (e) { vecchio = null; }
      a = { aspetto: ASPETTI.includes(vecchio) ? vecchio : "sistema" };
    }
    return valido(a);
  }

  function scuroAttivo(a) {
    if (a.aspetto === "scuro") return true;
    if (a.aspetto === "chiaro") return false;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function applica(a) {
    const r = document.documentElement;
    r.setAttribute("data-stile", a.stile);
    r.setAttribute("data-colore", a.colore);
    if (a.aspetto === "chiaro") r.setAttribute("data-theme", "light");
    else if (a.aspetto === "scuro") r.setAttribute("data-theme", "dark");
    else r.removeAttribute("data-theme");
    if (a.testo === "grande") r.setAttribute("data-testo", "grande");
    else r.removeAttribute("data-testo");
    // colore della barra del browser/telefono
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", scuroAttivo(a) ? "#111614" : (COLORI.find((c) => c.id === a.colore) || COLORI[0]).chiaro);
  }

  let corrente = leggi();
  applica(corrente);
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const cambio = () => { if (corrente.aspetto === "sistema") applica(corrente); };
    if (mq.addEventListener) mq.addEventListener("change", cambio); else if (mq.addListener) mq.addListener(cambio);
  }

  window.temaApp = {
    STILI, COLORI, PREDEFINITO,
    get() { return Object.assign({}, corrente); },
    /** Cambia una o più scelte; ritorna l'aspetto completo da salvare nel profilo. */
    imposta(parziale) {
      corrente = valido(Object.assign({}, corrente, parziale));
      try {
        localStorage.setItem(LS, JSON.stringify(corrente));
        localStorage.setItem(LS_TEMA_VECCHIO, corrente.aspetto);
      } catch (e) { /* memoria piena o disattivata: vale per questa sessione */ }
      applica(corrente);
      return Object.assign({}, corrente);
    },
    /** Dal profilo (altro dispositivo): sostituisce le scelte locali. */
    daProfilo(a) {
      if (!a || typeof a !== "object") return;
      const nuovo = valido(a);
      if (JSON.stringify(nuovo) === JSON.stringify(corrente)) return;
      this.imposta(nuovo);
    },
    scuroAttivo() { return scuroAttivo(corrente); },
  };
})();
