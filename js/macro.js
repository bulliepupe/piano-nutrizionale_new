/**
 * macro.js
 * Macronutrienti dei pasti del piano: carboidrati, proteine e grassi in grammi.
 *
 * Le stime per pasto le calcola l'AI sul server (funzione stimaMacro), una
 * volta sola per testo di pasto, e finiscono nell'archivio /macroPasti/{chiave}.
 * Qui ci sono solo funzioni "pure", usate sia dall'app sia dal server:
 * il file esiste in due copie identiche, js/macro.js e functions/macro.js.
 *
 * Il riferimento resta il piano del nutrizionista: se il giorno ha le calorie
 * indicate (campo kcal), le stime dei pasti vengono proporzionate a quel totale.
 */
(function () {
  "use strict";

  const CAMPI_PASTO = ["colazione", "spuntinoMattina", "pranzo", "spuntinoPomeriggio", "cena", "coccola"];
  const KCAL = { carboidrati: 4, proteine: 4, grassi: 9, alcol: 7 };

  /** Testo del pasto in forma canonica: è quello su cui si calcola la chiave. */
  function normalizzaPasto(testo) {
    return String(testo || "").toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”]/g, "\"")
      .replace(/\s+/g, " ").trim().slice(0, 400);
  }

  /** Vero se il testo è un pasto da stimare (non vuoto, non "nessuno spuntino"). */
  function daStimare(testo) {
    const t = normalizzaPasto(testo);
    if (t.length < 3) return false;
    if (/^(nessun\w*|niente|-+|—|n\/?a)\b/.test(t) && t.length < 30) return false;
    if (/^incluso nel pasto libero/.test(t)) return false;
    return true;
  }

  function num(x, max) {
    const n = Number(x);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.round(n * 10) / 10, max);
  }

  /** Stima pulita e con le calorie ricalcolate: { carboidrati, proteine, grassi, alcol, kcal, libero, affidabilita }. */
  function pulisciStima(s) {
    s = s || {};
    if (s.libero) return { carboidrati: 0, proteine: 0, grassi: 0, alcol: 0, kcal: 0, libero: true, affidabilita: "bassa" };
    const out = {
      carboidrati: num(s.carboidrati, 400),
      proteine: num(s.proteine, 250),
      grassi: num(s.grassi, 200),
      alcol: num(s.alcol, 80),
      libero: false,
      affidabilita: ["alta", "media", "bassa"].includes(s.affidabilita) ? s.affidabilita : "media",
    };
    out.kcal = Math.round(out.carboidrati * KCAL.carboidrati + out.proteine * KCAL.proteine + out.grassi * KCAL.grassi + out.alcol * KCAL.alcol);
    return out;
  }

  /**
   * Macronutrienti di un giorno del piano.
   * giorno: il giorno del piano ({ colazione, pranzo, …, kcal });
   * stime: { campoPasto: stima pulita oppure null se non ancora disponibile }.
   * Restituisce { pasti: { campo: stima proporzionata }, totale, fattore, completo }.
   * Il fattore porta la somma delle calorie stimate al totale del nutrizionista,
   * entro limiti ragionevoli (0,7–1,3): oltre, la stima è troppo lontana e si lascia com'è.
   */
  function macroGiorno(giorno, stime) {
    giorno = giorno || {};
    stime = stime || {};
    const campi = CAMPI_PASTO.filter((c) => daStimare(giorno[c]));
    const presenti = campi.filter((c) => stime[c]);
    const completo = presenti.length === campi.length;
    const sommaKcal = presenti.reduce((t, c) => t + (stime[c].libero ? 0 : stime[c].kcal), 0);
    const haLibero = presenti.some((c) => stime[c].libero);
    let fattore = 1;
    const kcalPiano = Number(giorno.kcal);
    // si calibra solo con il giorno completo e senza pasto libero (il libero non ha calorie nel piano)
    if (completo && !haLibero && kcalPiano > 0 && sommaKcal > 0) {
      const f = kcalPiano / sommaKcal;
      if (f >= 0.7 && f <= 1.3) fattore = Math.round(f * 1000) / 1000;
    }
    const pasti = {};
    const totale = { carboidrati: 0, proteine: 0, grassi: 0, alcol: 0, kcal: 0 };
    presenti.forEach((c) => {
      const s = stime[c];
      const p = s.libero ? Object.assign({}, s) : {
        carboidrati: Math.round(s.carboidrati * fattore),
        proteine: Math.round(s.proteine * fattore),
        grassi: Math.round(s.grassi * fattore),
        alcol: Math.round(s.alcol * fattore),
        kcal: Math.round(s.kcal * fattore),
        libero: false,
        affidabilita: s.affidabilita,
      };
      pasti[c] = p;
      ["carboidrati", "proteine", "grassi", "alcol", "kcal"].forEach((k) => { totale[k] += p[k] || 0; });
    });
    return { pasti, totale, fattore, completo, haLibero };
  }

  /**
   * Quanto è stato "coperto" del giorno: somma dei pasti segnati.
   * stati: { campo: "fatto" | "diverso" | "parziale" | "saltato" }
   * effettivi: { campo: stima del pasto effettivo } per i pasti fatti diversamente (dal riscontro AI).
   * I pasti "fatti" contano come da piano; "parziale" vale metà del piano se non c'è una stima;
   * "saltato" vale zero; "diverso" usa la stima del riscontro se c'è, altrimenti il piano.
   */
  function macroAssunti(giornoMacro, stati, effettivi) {
    stati = stati || {};
    effettivi = effettivi || {};
    const tot = { carboidrati: 0, proteine: 0, grassi: 0, alcol: 0, kcal: 0 };
    Object.keys(giornoMacro.pasti || {}).forEach((c) => {
      const stato = stati[c];
      if (!stato || stato === "saltato") return;
      let v = giornoMacro.pasti[c];
      if (stato === "diverso" || stato === "parziale") {
        if (effettivi[c]) v = effettivi[c];
        else if (stato === "parziale") v = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "number" ? x / 2 : x]));
      }
      if (v.libero) return;
      Object.keys(tot).forEach((k) => { tot[k] += Number(v[k]) || 0; });
    });
    Object.keys(tot).forEach((k) => { tot[k] = Math.round(tot[k]); });
    return tot;
  }

  // ---------------------------------------------------------------------
  // Prodotti confezionati letti dall'etichetta (foto della tabella nutrizionale)
  // ---------------------------------------------------------------------
  // I valori per 100 g li legge l'AI dalla foto e il paziente li conferma;
  // i grammi mangiati li indica lui. Il calcolo lo fa l'app, non l'AI.
  const MAX_ETICHETTE = 6;
  const VOCI_ETICHETTA = { kcal: 950, carboidrati: 100, zuccheri: 100, proteine: 100, grassi: 100, fibre: 100, sale: 100 };

  /** Valori per 100 g (o 100 ml) ripuliti: numeri tra 0 e il massimo possibile. */
  function pulisciPer100(p) {
    p = p || {};
    const out = {};
    Object.keys(VOCI_ETICHETTA).forEach((k) => { out[k] = num(p[k], VOCI_ETICHETTA[k]); });
    if (out.zuccheri > out.carboidrati) out.zuccheri = out.carboidrati;
    return out;
  }

  /** Vero se le calorie della tabella tornano con i macronutrienti (tolleranza del 15% o 25 kcal). */
  function etichettaCoerente(p) {
    p = pulisciPer100(p);
    const calcolate = p.carboidrati * 4 + p.proteine * 4 + p.grassi * 9 + p.fibre * 2;
    if (!p.kcal && !calcolate) return false;
    return Math.abs(calcolate - p.kcal) <= Math.max(25, p.kcal * 0.15);
  }

  /** Prodotto ripulito: { nome, per100, grammi, unita }. */
  function pulisciVoceEtichetta(v) {
    v = v || {};
    return {
      nome: String(v.nome || "").replace(/\s+/g, " ").trim().slice(0, 60) || "Prodotto confezionato",
      per100: pulisciPer100(v.per100),
      grammi: num(v.grammi, 2000),
      unita: v.unita === "ml" ? "ml" : "g",
    };
  }

  /** Valori di quanto mangiato di un prodotto: per 100 g × grammi / 100. */
  function valoriVoceEtichetta(v) {
    v = pulisciVoceEtichetta(v);
    const f = v.grammi / 100;
    const r = (x) => Math.round(x * f * 10) / 10;
    return { kcal: Math.round(v.per100.kcal * f), carboidrati: r(v.per100.carboidrati), proteine: r(v.per100.proteine), grassi: r(v.per100.grassi) };
  }

  /** Somma dei prodotti con etichetta di un pasto, come stima pulita (affidabilità alta). */
  function macroDaEtichette(voci) {
    const tot = { carboidrati: 0, proteine: 0, grassi: 0, alcol: 0 };
    (Array.isArray(voci) ? voci : []).slice(0, MAX_ETICHETTE).forEach((v) => {
      const x = valoriVoceEtichetta(v);
      tot.carboidrati += x.carboidrati; tot.proteine += x.proteine; tot.grassi += x.grassi;
    });
    return pulisciStima(Object.assign(tot, { affidabilita: "alta" }));
  }

  /** Somma di due stime pulite (prodotti con etichetta + resto del pasto stimato dall'AI). */
  function sommaStime(a, b) {
    if (!b) return pulisciStima(a);
    if (!a) return pulisciStima(b);
    const restoVuoto = !(b.carboidrati || b.proteine || b.grassi || b.alcol);
    return pulisciStima({
      carboidrati: (a.carboidrati || 0) + (b.carboidrati || 0),
      proteine: (a.proteine || 0) + (b.proteine || 0),
      grassi: (a.grassi || 0) + (b.grassi || 0),
      alcol: (a.alcol || 0) + (b.alcol || 0),
      affidabilita: restoVuoto ? a.affidabilita : b.affidabilita === "bassa" ? "media" : (b.affidabilita || "media"),
    });
  }

  const api = {
    CAMPI_PASTO, normalizzaPasto, daStimare, pulisciStima, macroGiorno, macroAssunti,
    MAX_ETICHETTE, pulisciPer100, etichettaCoerente, pulisciVoceEtichetta, valoriVoceEtichetta, macroDaEtichette, sommaStime,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.macro = api;
})();
