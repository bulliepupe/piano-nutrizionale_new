/**
 * conversioni.js
 * Conversione tra peso a crudo e peso a cotto.
 *
 * Fonte dei fattori di resa: LARN – Livelli di Assunzione di Riferimento di
 * Nutrienti ed energia per la popolazione italiana, V revisione (SINU 2024),
 * tabelle "Conversione della porzione peso crudo/cotto" pubblicate da ATS
 * Brescia. Fattore = peso cotto / peso crudo, a parità di alimento al netto
 * degli scarti. Sono valori medi: la resa reale dipende da tempo di
 * cottura, taglio e quantità di acqua o condimento.
 *
 * Solo funzioni "pure", doppio export (window / module.exports).
 */
(function () {
  "use strict";

  const BOLLITURA = "bollito";
  // Voce: { id, nome, metodi: { metodo: fattore }, parole: regex }
  const TABELLA = [
    { id: "pastaLunga", nome: "Pasta lunga (spaghetti, linguine…)", metodi: { [BOLLITURA]: 2.10 },
      parole: /\b(spaghett\w*|linguin\w*|bucatin\w*|fettuccin\w*|tagliatell\w*|bavett\w*|vermicell\w*|pappardell\w*|tagliolin\w*|pasta lunga)\b/ },
    { id: "pastaRipiena", nome: "Pasta ripiena (ravioli, tortellini)", metodi: { [BOLLITURA]: 1.40 },
      parole: /\b(raviol\w*|tortellin\w*|tortellon\w*|agnolott\w*|cappellett\w*|pasta ripiena)\b/ },
    { id: "gnocchi", nome: "Gnocchi di patate", metodi: { [BOLLITURA]: 1.06 }, parole: /\bgnocch\w*\b/ },
    { id: "pastaCorta", nome: "Pasta corta (penne, fusilli…)", metodi: { [BOLLITURA]: 1.88 },
      parole: /\b(pasta|penne|pennette|fusill\w*|rigaton\w*|farfall\w*|maccheron\w*|sedanin\w*|mezze maniche|orecchiett\w*|elich\w*|tortiglion\w*|conchigli\w*|ditalin\w*|caserecce|trofie|paccheri)\b/ },
    { id: "risoParboiled", nome: "Riso parboiled", metodi: { [BOLLITURA]: 2.36 }, parole: /\bparboiled\b/ },
    { id: "riso", nome: "Riso", metodi: { [BOLLITURA]: 2.60 }, parole: /\b(riso|basmati|arborio|carnaroli)\b/ },
    { id: "orzo", nome: "Orzo perlato", metodi: { [BOLLITURA]: 2.67 }, parole: /\borzo\b/ },
    { id: "farro", nome: "Farro perlato", metodi: { [BOLLITURA]: 2.28 }, parole: /\bfarro\b/ },
    { id: "quinoa", nome: "Quinoa", metodi: { [BOLLITURA]: 3.12 }, parole: /\bquinoa\b/ },
    { id: "couscous", nome: "Cous cous", metodi: { [BOLLITURA]: 2.25 }, parole: /\b(cous ?cous|cuscus)\b/ },
    { id: "polenta", nome: "Farina di mais (polenta)", metodi: { [BOLLITURA]: 4.85 }, parole: /\b(polenta|farina di mais)\b/ },
    { id: "patate", nome: "Patate", metodi: { [BOLLITURA]: 0.94 }, parole: /\bpatat[ae]\b/ },
    { id: "legumiSecchi", nome: "Legumi secchi", metodi: { [BOLLITURA]: 2.70 }, parole: null },
    { id: "legumiFreschi", nome: "Legumi freschi, surgelati o reidratati", metodi: { [BOLLITURA]: 0.88 }, parole: null },
    { id: "pesce", nome: "Pesce", metodi: { [BOLLITURA]: 0.84, "al vapore": 0.84, "in padella con olio": 0.64, "arrosto o al forno": 0.72 },
      parole: /\b(pesce|merluzz\w*|nasell\w*|orat\w*|branzin\w*|spigol\w*|salmone|sogliol\w*|platess\w*|trot\w*|pesce spada|palombo|baccal[aà]|sgombr\w*|alici|acciugh\w*|dentice|cernia|halibut|rombo|tonno fresco)\b/ },
    { id: "carneBianca", nome: "Carne bianca (pollo, tacchino…)", metodi: { [BOLLITURA]: 0.83, "al vapore": 0.62, "in padella con olio": 0.84, "arrosto o al forno": 0.78 },
      parole: /\b(pollo|tacchino|coniglio|petto di pollo|fesa di tacchino|sovracosci\w*|carne bianca)\b/ },
    { id: "carneRossa", nome: "Carne rossa (manzo, vitello…)", metodi: { [BOLLITURA]: 0.64, "al vapore": 0.63, "in padella con olio": 0.79, "arrosto o al forno": 0.80 },
      parole: /\b(manzo|vitell\w*|maiale|bovin\w*|carne rossa|hamburger|bistecc\w*|lonza|filetto|cavallo|agnello|macinat\w*|fesa di vitello|tagliata)\b/ },
  ];

  const LEGUMI = /\b(legumi|lenticchi\w*|ceci|fagiol\w*|piselli|fave|cicerch\w*|edamame|soia)\b/;
  // testi che non sono alimenti da cuocere (es. "prosciutto cotto", "tonno al naturale")
  const ESCLUSI = /\b(prosciutto|tonno al naturale|tonno sott'olio|in scatola gi[aà] cott\w*|crackers?|gallette|grissini|pane|farina integrale)\b/;

  function normalizza(t) {
    return String(t || "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ");
  }

  function voce(id) { return TABELLA.find((v) => v.id === id) || null; }

  /** Voce della tabella per un tratto di testo (o null). Per i legumi decide tra secchi e cotti. */
  function riconosciVoce(tratto) {
    const t = normalizza(tratto);
    if (ESCLUSI.test(t) && !/\b(pasta|riso)\b/.test(t)) return null;
    if (/\bpasta di (legumi|lenticchi\w*|ceci|piselli)\b/.test(t)) return voce("pastaCorta");
    if (LEGUMI.test(t)) {
      if (/\bsecch\w*\b/.test(t)) return voce("legumiSecchi");
      if (/\b(lessat\w*|cott\w*|scatola|surgelat\w*|fresch\w*|reidratat\w*|vasetto|lattina)\b/.test(t)) return voce("legumiFreschi");
      return { ambiguo: true, voci: [voce("legumiSecchi"), voce("legumiFreschi")] };
    }
    for (const v of TABELLA) if (v.parole && v.parole.test(t)) return v;
    return null;
  }

  /**
   * Alimenti riconosciuti nel testo di un pasto, con il peso indicato.
   * Es. "Pasta integrale 80g + Merluzzo 150 g e zucchine" →
   *   [{ testo: "Pasta integrale 80g", grammi: 80, voci: [pastaCorta] },
   *    { testo: "Merluzzo 150 g", grammi: 150, voci: [pesce] }]
   * Si considerano solo i tratti con un peso in grammi.
   */
  function riconosci(testoPasto) {
    const tratti = String(testoPasto || "").split(/\s*(?:\+|,|;|\be\b|\boppure\b|\/|\n)\s*/i).filter(Boolean);
    const risultati = [];
    tratti.forEach((tratto) => {
      const m = normalizza(tratto).match(/(\d+(?:[.,]\d+)?)\s*(?:g|gr|grammi)\b/);
      if (!m) return;
      const grammi = Number(m[1].replace(",", "."));
      if (!grammi || grammi > 2000) return;
      const r = riconosciVoce(tratto);
      if (!r) return;
      risultati.push({ testo: tratto.trim(), grammi, voci: r.ambiguo ? r.voci : [r], ambiguo: !!r.ambiguo });
    });
    return risultati;
  }

  function arrotonda(g) { return g >= 100 ? Math.round(g / 5) * 5 : Math.round(g); }
  function daCrudoACotto(grammi, fattore) { return arrotonda(grammi * fattore); }
  function daCottoACrudo(grammi, fattore) { return arrotonda(grammi / fattore); }

  const FONTE = "LARN 2024 (SINU)";
  const api = { TABELLA, FONTE, riconosci, riconosciVoce, daCrudoACotto, daCottoACrudo, voce };
  if (typeof window !== "undefined") window.conversioni = api;
  if (typeof module !== "undefined") module.exports = api;
})();
