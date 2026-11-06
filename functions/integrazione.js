/**
 * Integrazione (integratori): logica condivisa tra app e server.
 * Due elenchi: quello prescritto dal nutrizionista (piani/{id}.integrazione)
 * e quello del paziente (users/{uid}.integrazione). Ogni voce:
 * { id, nome, quantita, orari: ["HH:MM"], giorni: [1..7] (vuoto = tutti), note }.
 * Le assunzioni segnate stanno in pastiFatti/{giorno}.integratori, per chiave
 * "n_<id>_<HHMM>" (nutrizionista) o "m_<id>_<HHMM>" (paziente).
 * Solo integratori, mai farmaci: l'app non suggerisce prodotti né dosi.
 * Lo stesso file è copiato in functions/integrazione.js (va tenuto identico).
 */
(function (radice) {
  const MAX_VOCI = 15;
  const MAX_ORARI = 4;
  const RE_ORARIO = /^([01]\d|2[0-3]):[0-5]\d$/;
  const GIORNI_BREVI = ["L", "M", "M", "G", "V", "S", "D"];
  const GIORNI_NOMI = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"];

  function testo(x, n) { return String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, n); }

  /** Voce ripulita; senza id valido resta senza id (e viene scartata dall'elenco). */
  function pulisciVoce(v) {
    v = v || {};
    const orari = Array.from(new Set((Array.isArray(v.orari) ? v.orari : []).map(String).filter((o) => RE_ORARIO.test(o)))).sort().slice(0, MAX_ORARI);
    const giorni = Array.from(new Set((Array.isArray(v.giorni) ? v.giorni : []).map(Number).filter((g) => Number.isInteger(g) && g >= 1 && g <= 7))).sort((a, b) => a - b);
    return {
      id: testo(v.id, 24).replace(/[^A-Za-z0-9-]/g, ""),
      nome: testo(v.nome, 60),
      quantita: testo(v.quantita, 60),
      orari,
      giorni: giorni.length === 7 ? [] : giorni,
      note: testo(v.note, 120),
    };
  }

  function pulisciLista(lista) {
    return (Array.isArray(lista) ? lista : []).map(pulisciVoce).filter((v) => v.id && v.nome && v.orari.length).slice(0, MAX_VOCI);
  }

  function nuovoId() { return "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /** 1 = lunedì … 7 = domenica. */
  function giornoSettimana(data) { const g = data.getDay(); return g === 0 ? 7 : g; }

  function chiave(fonte, id, orario) { return (fonte === "nutrizionista" ? "n_" : "m_") + id + "_" + orario.replace(":", ""); }

  /** Assunzioni previste in una data, in ordine di orario. */
  function vociDelGiorno(prescritti, miei, data) {
    const gs = giornoSettimana(data);
    const out = [];
    [["nutrizionista", prescritti], ["mio", miei]].forEach(([fonte, lista]) => {
      pulisciLista(lista).forEach((v) => {
        if (v.giorni.length && !v.giorni.includes(gs)) return;
        v.orari.forEach((orario) => out.push({ fonte, id: v.id, nome: v.nome, quantita: v.quantita, note: v.note, orario, chiave: chiave(fonte, v.id, orario) }));
      });
    });
    return out.sort((a, b) => a.orario.localeCompare(b.orario) || a.nome.localeCompare(b.nome));
  }

  /** Testo dei giorni: "tutti i giorni" oppure "L M V". */
  function giorniTesto(giorni) {
    const g = Array.isArray(giorni) ? giorni : [];
    if (!g.length) return "tutti i giorni";
    if (g.length === 1) return (g[0] === 7 ? "la " : "il ") + GIORNI_NOMI[g[0] - 1];
    return g.map((x) => GIORNI_BREVI[x - 1]).join(" ");
  }

  /**
   * Aderenza negli ultimi n giorni (oggi escluso se escludiOggi): per ogni voce,
   * assunzioni previste e segnate. spunte: { "AAAA-MM-GG": { integratori: {...} } }.
   */
  function aderenza(prescritti, miei, spunte, oggi, n, escludiOggi) {
    const per = {};
    for (let i = escludiOggi ? 1 : 0; i < n + (escludiOggi ? 1 : 0); i++) {
      const d = new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate() - i);
      const k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      const segnate = (spunte && spunte[k] && spunte[k].integratori) || {};
      vociDelGiorno(prescritti, miei, d).forEach((x) => {
        const id = (x.fonte === "nutrizionista" ? "n_" : "m_") + x.id;
        if (!per[id]) per[id] = { fonte: x.fonte, nome: x.nome, quantita: x.quantita, previste: 0, segnate: 0 };
        per[id].previste++;
        if (segnate[x.chiave]) per[id].segnate++;
      });
    }
    return Object.values(per);
  }

  const api = { MAX_VOCI, MAX_ORARI, pulisciVoce, pulisciLista, nuovoId, giornoSettimana, chiave, vociDelGiorno, giorniTesto, aderenza, GIORNI_BREVI, GIORNI_NOMI };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else radice.integrazione = api;
})(typeof window !== "undefined" ? window : this);
