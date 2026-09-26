/**
 * mealprep.js
 * Dal piano di una settimana (7 giorni, da lunedì a domenica) ricava cosa si
 * può preparare in anticipo e lo divide in due sessioni:
 *  - sessione 1, la domenica, per lunedì, martedì e mercoledì;
 *  - sessione 2, il mercoledì sera, per giovedì, venerdì, sabato e domenica.
 * Uova sode e porzioni di frutta secca si preparano tutte nella sessione 1.
 *
 * Due sessioni perché i cibi cotti vanno consumati entro 3-4 giorni (USDA
 * Food Safety and Inspection Service). Il riso cotto fa eccezione: al
 * massimo 24 ore in frigo (Food Standards Agency, Regno Unito), quindi per
 * i giorni successivi va congelato in porzioni.
 *
 * Usa il catalogo di alimenti.js per riconoscere gli alimenti e legge le
 * quantità scritte nel piano ("Pollo 220g", "Riso 70g", "2 uova").
 * Doppio export (window / module.exports), come gli altri moduli.
 */
(function () {
  "use strict";

  const A = typeof window !== "undefined" && window.alimenti ? window.alimenti : require("./alimenti.js");

  const TIPI = {
    cereali: {
      titolo: "Cereali e pasta", icona: "🍚", conservazione: "Frigo 3–4 giorni",
      consiglio: "Cuoci tutto insieme, scola al dente, raffredda in fretta allargando su un piatto e dividi nei contenitori.",
    },
    riso: {
      titolo: "Cereali e pasta", icona: "🍚", conservazione: "Frigo max 24 ore, poi freezer",
      consiglio: "Il riso cotto va messo in frigo entro un'ora e consumato entro 24 ore: le porzioni per i giorni successivi congelale subito e scongelale in frigo la sera prima.",
    },
    legumi: {
      titolo: "Legumi", icona: "🫘", conservazione: "Frigo 3–4 giorni",
      consiglio: "Se sono secchi, mettili in ammollo la sera prima e cuocili tutti insieme; quelli in scatola basta sciacquarli.",
    },
    proteine: {
      titolo: "Carne, pesce e proteine vegetali", icona: "🍗", conservazione: "Frigo 3–4 giorni",
      consiglio: "Cuoci alla piastra, al forno o al vapore con poco condimento e metti ogni porzione in un contenitore a parte.",
    },
    uova: {
      titolo: "Uova", icona: "🥚", conservazione: "Frigo 7 giorni (sode, col guscio)",
      consiglio: "Se nel piano sono sode, rassodale 9–10 minuti, raffreddale in acqua fredda e conservale con il guscio. Frittate e uova strapazzate meglio prepararle al momento.",
    },
    verdureCotte: {
      titolo: "Verdure da cuocere", icona: "🥦", conservazione: "Frigo 3–4 giorni",
      consiglio: "Grigliale, arrostiscile o cuocile al vapore; l'olio aggiungilo solo quando le mangi.",
    },
    verdureCrude: {
      titolo: "Verdure da lavare e tagliare", icona: "🥬", conservazione: "Frigo 3–4 giorni",
      consiglio: "Lava, asciuga bene e conserva in un contenitore con un foglio di carta da cucina; condisci solo al momento.",
    },
    porzionare: {
      titolo: "Da porzionare", icona: "🥜", conservazione: "Dispensa",
      consiglio: "Dividi in piccoli contenitori o sacchetti, uno per ogni giorno in cui è previsto.",
    },
  };
  const ORDINE_TIPI = ["proteine", "legumi", "cereali", "riso", "verdureCotte", "verdureCrude", "uova", "porzionare"];

  const PER_NOME = {};
  const assegna = (tipo, nomi) => nomi.split("|").forEach((n) => { PER_NOME[n] = tipo; });
  assegna("cereali", "Pasta|Pasta integrale|Pasta di legumi|Farro|Orzo|Quinoa|Cous cous|Bulgur|Miglio|Grano saraceno");
  assegna("riso", "Riso|Riso integrale");
  assegna("legumi", "Lenticchie|Ceci|Fagioli|Fagioli cannellini|Fave|Legumi misti");
  assegna("proteine", "Pollo|Tacchino|Manzo|Roastbeef|Macinato magro|Vitello|Maiale|Coniglio|Agnello|Carne|" +
    "Pesce|Salmone|Tonno fresco|Pesce spada|Merluzzo|Nasello|Orata|Branzino|Platessa|Sogliola|Trota|Sgombro|Rombo|Dentice|" +
    "Gamberi|Calamari|Polpo|Tofu|Seitan|Tempeh|Burger vegetali");
  assegna("uova", "Uova");
  assegna("verdureCotte", "Broccoli|Cavolfiore|Cavolini di Bruxelles|Cime di rapa|Fagiolini|Asparagi|Carciofi|Funghi|Zucca|Patate|Patate dolci|Bietole|Piselli");
  assegna("verdureCrude", "Insalata|Rucola|Valeriana|Pomodorini|Pomodori|Cetrioli|Sedano|Ravanelli|Germogli");
  assegna("porzionare", "Frutta secca|Noci|Mandorle|Nocciole|Pistacchi|Anacardi|Semi oleosi");
  // Verdure che possono essere crude o cotte: decide il testo del pasto.
  const AMBIVALENTI = { Zucchine: "verdureCotte", Melanzane: "verdureCotte", Peperoni: "verdureCotte", Spinaci: "verdureCotte",
    Cavoli: "verdureCotte", "Verdure di stagione": "verdureCotte", Carote: "verdureCrude", Finocchi: "verdureCrude", Radicchio: "verdureCrude" };
  const RE_COTTO = /grigl|vapore|forno|less[aeiot]|bollit|saltat|cott[aeio]|piastr|ferri|arrost|trifolat|stufat|ripassat|umido|brasat|rosolat|gratinat|vellutat|passato|crema di|zuppa|minestr|sugo|rag[uù]|cartoccio|padella/i;
  const RE_CRUDO = /crud|insalat|grattugiat|julienne|pinzimonio|a crudo/i;

  const GIORNI_BREVI = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
  const CAMPI = ["colazione", "spuntinoMattina", "pranzo", "spuntinoPomeriggio", "cena"];

  function pezziDelPasto(testo) {
    const pezzi = [];
    let corrente = "", prof = 0;
    for (const ch of String(testo || "")) {
      if (ch === "(") prof++;
      if (ch === ")") prof = Math.max(0, prof - 1);
      if (ch === "+" && prof === 0) { pezzi.push(corrente); corrente = ""; } else corrente += ch;
    }
    pezzi.push(corrente);
    return pezzi.map((p) => p.trim()).filter(Boolean);
  }

  function tipoDi(voce, testoPezzo) {
    if (AMBIVALENTI[voce.nome]) {
      if (RE_COTTO.test(testoPezzo)) return "verdureCotte";
      if (RE_CRUDO.test(testoPezzo)) return "verdureCrude";
      return AMBIVALENTI[voce.nome];
    }
    return PER_NOME[voce.nome] || null;
  }

  /**
   * Quantità dentro un pezzo di pasto: grammi per alimento ("Riso 70g") e
   * numero di uova ("2 uova"). Si guarda ogni frammento separato da virgole,
   * parentesi o "con": se contiene UN solo alimento e UN numero di grammi,
   * quei grammi sono suoi.
   */
  function quantitaNelPezzo(pezzo, vociPezzo) {
    const q = {};
    const frammenti = pezzo.split(/[,()/;]|\bcon\b|\be\b|\bo\b/i).map((f) => f.trim()).filter(Boolean);
    frammenti.forEach((f) => {
      const vf = A.vociDaPasto(f);
      if (vf.length !== 1) return;
      // collega la voce del frammento a quella del pezzo (anche variante/base)
      const catF = A.voceDaChiave(vf[0].chiave);
      const target = vociPezzo.find((v) => v.chiave === vf[0].chiave)
        || vociPezzo.find((v) => { const c = A.voceDaChiave(v.chiave); return c && catF && (c.base === catF.nome || catF.base === c.nome); });
      if (!target || q[target.chiave]) return;
      const uova = f.match(/(\d+)\s*(uov[oa]|album[ei])/i);
      const grammi = f.match(/(\d+(?:[.,]\d+)?)\s*(g|gr|grammi|ml)\b/i);
      if (target.nome === "Uova" && uova) q[target.chiave] = { unita: Number(uova[1]) };
      else if (grammi) q[target.chiave] = { grammi: Number(grammi[1].replace(",", ".")) };
    });
    return q;
  }

  /**
   * @param giorni  i 7 giorni della settimana del piano (lunedì → domenica)
   * @returns { sessioni: [{ id, perGiorni, gruppi: [{ tipo, titolo, icona, voci }] }], vuoto }
   */
  function calcola(giorni) {
    const perSessione = { s1: new Map(), s2: new Map() };
    (giorni || []).slice(0, 7).forEach((g, indice) => {
      if (!g) return;
      CAMPI.forEach((campo) => {
        const testo = g[campo];
        if (!testo || /pasto libero/i.test(testo)) return;
        pezziDelPasto(testo).forEach((pezzo) => {
          const voci = A.vociDaPasto(pezzo);
          const quantita = quantitaNelPezzo(pezzo, voci);
          // Alternative ("Pollo/Tacchino", "branzino o orata", "seitan o tofu"):
          // tra alimenti dello stesso tipo nello stesso pezzo si prepara solo
          // il primo, segnalando gli altri come alternativa.
          const alternativo = /\/|\s(o|oppure)\s/i.test(pezzo);
          const primiPerTipo = {};
          voci.forEach((v) => {
            const tipo = tipoDi(v, pezzo);
            if (!tipo) return;
            // le uova si preparano in anticipo solo se sono sode
            if (tipo === "uova" && !/\bsod[eoia]|rassodat/i.test(pezzo)) return;
            if (alternativo && primiPerTipo[tipo]) { primiPerTipo[tipo].alternative.add(v.nome); return; }
            // uova sode e porzioni di frutta secca: tutto nella prima sessione
            const sessione = tipo === "uova" || tipo === "porzionare" || indice <= 2 ? "s1" : "s2";
            const mappa = perSessione[sessione];
            const chiave = `${sessione}:${tipo}:${v.chiave}`;
            if (!mappa.has(chiave)) {
              mappa.set(chiave, { chiave, nome: v.nome, icona: v.icona, tipo, porzioni: 0, grammi: 0, unita: 0, senzaQuantita: 0, giorni: new Set() });
            }
            const voce = mappa.get(chiave);
            if (!voce.alternative) voce.alternative = new Set();
            primiPerTipo[tipo] = voce;
            voce.porzioni++;
            voce.giorni.add(indice);
            const qv = quantita[v.chiave];
            if (qv && qv.grammi) voce.grammi += qv.grammi;
            else if (qv && qv.unita) voce.unita += qv.unita;
            else voce.senzaQuantita++;
          });
        });
      });
    });

    const sessioni = ["s1", "s2"].map((id) => {
      const voci = Array.from(perSessione[id].values()).map((v) => Object.assign(v, {
        giorni: Array.from(v.giorni).sort(),
        giorniTesto: Array.from(v.giorni).sort().map((i) => GIORNI_BREVI[i]).join(", "),
        alternative: Array.from(v.alternative || []).filter((n) => n !== v.nome),
      }));
      const gruppi = ORDINE_TIPI
        .map((tipo) => ({ tipo, ...TIPI[tipo], voci: voci.filter((v) => v.tipo === tipo).sort((a, b) => a.nome.localeCompare(b.nome, "it")) }))
        .filter((g) => g.voci.length);
      // "riso" confluisce nel gruppo dei cereali, ma conserva il suo avviso
      const cereali = gruppi.find((g) => g.tipo === "cereali");
      const riso = gruppi.find((g) => g.tipo === "riso");
      if (cereali && riso) { cereali.voci = cereali.voci.concat(riso.voci); cereali.avvisoRiso = riso.consiglio; gruppi.splice(gruppi.indexOf(riso), 1); }
      else if (riso) { riso.avvisoRiso = riso.consiglio; riso.consiglio = TIPI.cereali.consiglio; }
      return { id, perGiorni: id === "s1" ? [0, 1, 2] : [3, 4, 5, 6], gruppi, totale: voci.length };
    });
    return { sessioni, vuoto: sessioni.every((s) => !s.totale) };
  }

  /** "3 porzioni · 660 g in totale · lun, mer, gio" */
  function testoQuantita(v) {
    const parti = [`${v.porzioni} ${v.porzioni === 1 ? "porzione" : "porzioni"}`];
    if (v.unita && !v.grammi) parti.push(`${v.unita} ${v.unita === 1 ? "uovo" : "uova"}`);
    else if (v.grammi && !v.senzaQuantita) parti.push(`${Math.round(v.grammi)} g in totale`);
    else if (v.grammi) parti.push(`almeno ${Math.round(v.grammi)} g`);
    parti.push(v.giorniTesto);
    return parti.join(" · ");
  }

  const GUIDA = [
    ["Raffredda in fretta", "Metti in frigo i cibi cotti entro 2 ore dalla cottura (il riso entro 1 ora). Per raffreddarli prima, dividili in contenitori bassi."],
    ["Frigo freddo e contenitori chiusi", "Il frigo deve stare a 4 °C o meno. Usa contenitori ermetici, uno per porzione, e scrivi la data di preparazione."],
    ["Entro 3–4 giorni, oppure in freezer", "I cibi cotti si consumano entro 3–4 giorni; quello che serve dopo va congelato subito. Il riso cotto, al massimo 24 ore in frigo."],
    ["Riscalda bene, una volta sola", "Riscalda finché è ben caldo anche al centro (74 °C). Il riso si riscalda una volta sola. Scongela in frigo, non sul piano di lavoro."],
    ["Cosa non preparare in anticipo", "Insalate già condite, fritture e impanati, frutta che annerisce una volta tagliata (mele, pere, banane), pesce crudo."],
  ];
  const FONTI = "Fonti: USDA Food Safety and Inspection Service; Food Standards Agency (Regno Unito).";

  const api = { calcola, testoQuantita, TIPI, GUIDA, FONTI, GIORNI_BREVI };
  if (typeof window !== "undefined") window.mealPrep = api;
  if (typeof module !== "undefined") module.exports = api;
})();
