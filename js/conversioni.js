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
    { id: "couscous", nome: "Cous cous", metodi: { [BOLLITURA]: 2.25 }, parole: /\b(cous[ -]?cous|cuscus)\b/ },
    { id: "polenta", nome: "Farina di mais (polenta)", metodi: { [BOLLITURA]: 4.85 }, parole: /\b(polenta|farina di mais)\b/ },
    { id: "patate", nome: "Patate", metodi: { [BOLLITURA]: 0.94 }, parole: /\bpatat[ae]\b/ },
    { id: "legumiSecchi", nome: "Legumi secchi", metodi: { [BOLLITURA]: 2.70 }, parole: null },
    { id: "legumiFreschi", nome: "Legumi freschi, surgelati o reidratati", metodi: { [BOLLITURA]: 0.88 }, parole: null },
    // Verdure: LARN 2024, "Verdura fresca o surgelata" (bollitura 200→174, padella con olio 200→106,
    // arrostimento o forno 200→130); cavoli e simili al vapore 200→192; verdure a foglia o a stelo al vapore 200→172
    { id: "verdureFoglia", nome: "Verdure a foglia o a stelo (spinaci, bietole…)", metodi: { "al vapore": 0.86, [BOLLITURA]: 0.87, "in padella con olio": 0.53, "al forno o grigliate": 0.65 },
      parole: /\b(spinac\w*|bietol\w*|biet[ae]|erbett\w*|coste|finocch\w*|asparag\w*|cicori\w*|catalogn\w*|scarol\w*|indivia|tarassaco|agretti|friariell\w*)\b/ },
    { id: "verdureCavoli", nome: "Cavoli e broccoli", metodi: { "al vapore": 0.96, [BOLLITURA]: 0.87, "in padella con olio": 0.53, "al forno o grigliate": 0.65 },
      parole: /\b(broccol\w*|cavol\w*|cavolfior\w*|verza|cavolini|cime di rapa|rape|cavolo nero|cavolo cappuccio|romanesco)\b/ },
    { id: "verdure", nome: "Verdure (zucchine, carote, peperoni…)", metodi: { [BOLLITURA]: 0.87, "in padella con olio": 0.53, "al forno o grigliate": 0.65 },
      parole: /\b(verdur\w*|ortagg\w*|zucchin\w*|carot\w*|melanzan\w*|peperon\w*|fagiolin\w*|zucca|cipoll\w*|carciof\w*|porr\w*|funghi|champignon|sedano|pomodor\w*|cornett\w*|minestrone|misto di verdure)\b/ },
    { id: "pesce", nome: "Pesce", metodi: { [BOLLITURA]: 0.84, "al vapore": 0.84, "in padella con olio": 0.64, "arrosto o al forno": 0.72 },
      parole: /\b(pesce|merluzz\w*|nasell\w*|orat\w*|branzin\w*|spigol\w*|salmone|sogliol\w*|platess\w*|trot\w*|pesce spada|palombo|baccal[aà]|sgombr\w*|alici|acciugh\w*|dentice|cernia|halibut|rombo|tonno fresco|trancio di tonno|tonno)\b/ },
    { id: "carneBianca", nome: "Carne bianca (pollo, tacchino…)", metodi: { [BOLLITURA]: 0.83, "al vapore": 0.62, "in padella con olio": 0.84, "arrosto o al forno": 0.78 },
      parole: /\b(pollo|tacchino|coniglio|petto di pollo|fesa di tacchino|sovracosci\w*|carne bianca)\b/ },
    { id: "carneRossa", nome: "Carne rossa (manzo, vitello…)", metodi: { [BOLLITURA]: 0.64, "al vapore": 0.63, "in padella con olio": 0.79, "arrosto o al forno": 0.80 },
      parole: /\b(manzo|vitell\w*|maiale|bovin\w*|carne rossa|hamburger|bistecc\w*|roast[ -]?beef|lonza|filetto|cavallo|agnello|macinat\w*|fesa di vitello|tagliata)\b/ },
  ];

  const LEGUMI = /\b(legumi|lenticchi\w*|ceci|fagiol\w*|cannellini|borlotti|piselli|fave|cicerch\w*|edamame|soia|azuki)\b/;
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

  // Alimenti che non si cuociono o non cambiano peso: non si chiede nemmeno la stima all'AI
  const NON_DA_STIMARE = /\b(olio|evo|miele|zucchero|marmellata|confettura|parmigiano|grana|pecorino|formagg\w*|mozzarell\w*|ricott\w*|robiola|stracchino|crescenza|fiocchi di latte|feta|quark|skyr|philadelphia|spalmabile|burrata|scamorza|provola|emmental|yogurt|latte|kefir|panna|burro|pane|crackers?|gallett\w*|grissini|fette biscottate|biscott\w*|cereali|muesli|granola|frutta|frutti di bosco|mel[ae]|per[ae]|banan\w*|arance?|mandarin\w*|clementin\w*|kiwi|fragol\w*|albicocc\w*|pesc[ae]|prugn\w*|susin\w*|cilieg\w*|uva|ananas|mango|melone|anguria|fich[io]|cachi|mirtill\w*|lamponi|more|datteri|noci|mandorl\w*|nocciol\w*|pistacch\w*|anacardi|semi|cioccolat\w*|cacao|caff[eè]|t[eè]|tisana|acqua|succo|bresaola|prosciutto|speck|affettat\w*|salmone affumicato|insalata|rucola|lattuga|valeriana|songino|cetriol\w*|ravanell\w*|olive|aceto|sale|spezie|limone|pomodorini|pesto|hummus|salsa|sugo|maionese|ketchup|senape|proteine in polvere|whey)\b/;

  // Parole da togliere dal nome (cotture, aggettivi): "albume strapazzato" e "albumi" diventano "albume"
  const QUALIFICHE = /\b(cott[oiae]|crud[oiae]|lessat[oiae]|bollit[oiae]|strapazzat[oiae]|grigliat[oiae]|arrost[oi]|al forno|alla piastra|alla griglia|in padella|al vapore|in umido|magr[oiae]|light|fresc[oiae]|freschi|surgelat[oiae]|scongelat[oiae]|integral[ei]|biologic[oiae]|bio|naturale|sgocciolat[oiae]|tritat[oiae]|a cubetti|a fette|trancio di|filett[oi] di|fett[ae] di|petto di|porzione di|tipo|circa)\b/g;
  const SINGOLARE = { albumi: "albume", uova: "uovo", tuorli: "tuorlo", gamberi: "gambero", calamari: "calamaro", funghi: "fungo", polpette: "polpetta", burger: "burger", hamburger: "hamburger" };

  /** Nome dell'alimento in un tratto, per l'archivio delle stime (minuscolo, senza pesi né parentesi). */
  function nomeAlimento(tratto) {
    let t = String(tratto || "");
    if (t.includes("(")) t = t.slice(t.lastIndexOf("(") + 1);
    t = normalizza(t).replace(/\d+(?:[.,]\d+)?\s*(?:g|gr|grammi|ml)\b/g, " ")
      .replace(/[()\[\]{}"“”.:;!?*]/g, " ").replace(/\b\d+\b/g, " ")
      .replace(QUALIFICHE, " ").replace(/\b(di|da|del|della|dei|delle|al|alla|allo|in|con)\s*$/g, " ")
      .replace(/\s+/g, " ").trim();
    t = t.split(" ").map((w) => SINGOLARE[w] || w).join(" ");
    // stesso alimento con nomi diversi: una sola voce nell'archivio
    if (/^(avena|fiocchi avena|fiocchi di avena|fiocchi d'avena)$/.test(t)) t = "fiocchi d'avena";
    return t.slice(0, 40);
  }

  function chiaveAlimento(nome) { return String(nome || "").replace(/[\/#?\[\]]/g, " ").replace(/\s+/g, "_").slice(0, 60); }

  /**
   * Alimenti riconosciuti nel testo di un pasto, con il peso indicato.
   * Es. "Pasta integrale 80g + Merluzzo 150 g e zucchine" →
   *   [{ testo: "Pasta integrale 80g", grammi: 80, voci: [pastaCorta] },
   *    { testo: "Merluzzo 150 g", grammi: 150, voci: [pesce] }]
   * Si considerano solo i tratti con un peso in grammi.
   */
  function trattiConPeso(testoPasto) {
    const tratti = String(testoPasto || "").split(/\s*(?:\+|,|;|\be\b|\bo\b|\bcon\b|\boppure\b|\/|\n)\s*/i).filter(Boolean);
    const out = [];
    tratti.forEach((tratto) => {
      const m = normalizza(tratto).match(/(\d+(?:[.,]\d+)?)\s*(?:g|gr|grammi)\b/);
      if (!m) return;
      const grammi = Number(m[1].replace(",", "."));
      if (!grammi || grammi > 2000) return;
      out.push({ tratto: tratto.replace(/^[^(]*\(/, (x) => (/\d\s*(g|gr|grammi)\b/i.test(x) ? x : "")).replace(/[()]/g, "").trim(), grammi });
    });
    return out;
  }

  /** Voce da una stima AI dell'archivio comune ({ nome, siCuoce, metodi }), oppure null. */
  function voceDaStima(stima, nome) {
    if (!stima || !stima.siCuoce || !stima.metodi || !Object.keys(stima.metodi).length) return null;
    return { id: "ai:" + nome, nome: stima.nome || nome, metodi: stima.metodi, stima: true };
  }

  /**
   * reseAI (facoltativo): archivio delle stime AI, { chiaveAlimento: { siCuoce, metodi, nome } }.
   */
  function riconosci(testoPasto, reseAI) {
    const risultati = [];
    trattiConPeso(testoPasto).forEach(({ tratto, grammi }) => {
      const r = riconosciVoce(tratto);
      if (r) { risultati.push({ testo: tratto, grammi, voci: r.ambiguo ? r.voci : [r], ambiguo: !!r.ambiguo }); return; }
      const nome = nomeAlimento(tratto);
      const v = reseAI && voceDaStima(reseAI[chiaveAlimento(nome)], nome);
      if (v) risultati.push({ testo: tratto, grammi, voci: [v], ambiguo: false, stima: true });
    });
    return risultati;
  }

  /** Nomi degli alimenti con un peso, fuori tabella e non ancora stimati: da chiedere all'AI. */
  function daStimare(testoPasto, reseAI) {
    const nomi = [];
    trattiConPeso(testoPasto).forEach(({ tratto }) => {
      if (riconosciVoce(tratto)) return;
      const t = normalizza(tratto);
      if (ESCLUSI.test(t) || NON_DA_STIMARE.test(t)) return;
      const nome = nomeAlimento(tratto);
      if (nome.length < 3 || /^(cott|crud|pasto|piatto|porzion|contorno|secondo|primo)/.test(nome) || (reseAI && reseAI[chiaveAlimento(nome)])) return;
      nomi.push(nome);
    });
    return nomi;
  }

  function arrotonda(g) { return g >= 100 ? Math.round(g / 5) * 5 : Math.round(g); }
  function daCrudoACotto(grammi, fattore) { return arrotonda(grammi * fattore); }
  function daCottoACrudo(grammi, fattore) { return arrotonda(grammi / fattore); }

  const FONTE = "LARN 2024 (SINU)";
  const api = { TABELLA, FONTE, riconosci, riconosciVoce, daStimare, nomeAlimento, chiaveAlimento, daCrudoACotto, daCottoACrudo, voce };
  if (typeof window !== "undefined") window.conversioni = api;
  if (typeof module !== "undefined") module.exports = api;
})();
