/**
 * report-preparatore.js
 * Numeri del "Report per il preparatore": il nutrizionista sceglie un periodo
 * e ottiene, settimana per settimana, aderenza al piano, peso e carico di
 * allenamento, da condividere (in PDF) con il preparatore del paziente.
 *
 * Solo funzioni "pure": ricevono i dati già letti dal cloud. Doppio export.
 * Si appoggia a statistiche.js per il valore dei pasti (fatto 1, diverso/in parte 0,5).
 */
(function () {
  "use strict";

  const S = (typeof window !== "undefined" && window.statistiche) || (typeof require !== "undefined" ? require("./statistiche.js") : null);

  function mezzanotte(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function chiave(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  function daChiave(k) { const [a, m, g] = String(k).split("-").map(Number); return new Date(a, m - 1, g); }
  function piuGiorni(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function lunedi(d) { const x = mezzanotte(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }

  /** Periodi proposti: giorni all'indietro da oggi (compreso). */
  const PERIODI = [["7", "Ultima settimana", 7], ["30", "Ultimo mese", 30], ["90", "Ultimi 3 mesi", 90], ["180", "Ultimi 6 mesi", 180]];

  function valoreGiorno(stato) {
    return S.PASTI.reduce((t, k) => {
      const st = S.statoPasto(stato, k);
      return t + (st === "fatto" ? 1 : st === "diverso" || st === "parziale" ? 0.5 : 0);
    }, 0);
  }

  /**
   * @param {object} p
   *  - da, a: "YYYY-MM-DD" (compresi)
   *  - oggi: Date (facoltativo, per i test)
   *  - inizioPiano: "YYYY-MM-DD" | null — prima non si valuta l'aderenza
   *  - spunte: { giorno: stato dei pasti }
   *  - misure: [{ data, peso, vita, fianchi }]
   *  - attivita: { giorno: { allenamenti: [...] } }
   */
  function calcola(p) {
    const oggi = mezzanotte(p.oggi || new Date());
    const da = mezzanotte(daChiave(p.da)), a = mezzanotte(daChiave(p.a));
    const inizio = p.inizioPiano ? mezzanotte(daChiave(p.inizioPiano)) : null;
    const spunte = p.spunte || {};

    // --- aderenza: giorni conclusi (oggi escluso) dentro il periodo e dopo l'inizio del piano
    const giorni = [];
    for (let d = new Date(da); d <= a; d = piuGiorni(d, 1)) {
      if (d >= oggi || (inizio && d < inizio)) continue;
      giorni.push({ chiave: chiave(d), data: new Date(d), punti: valoreGiorno(spunte[chiave(d)]) });
    }
    const conta = { fatto: 0, diverso: 0, parziale: 0, saltato: 0, nonSegnato: 0 };
    giorni.forEach((g) => S.PASTI.forEach((k) => { conta[S.statoPasto(spunte[g.chiave], k) || "nonSegnato"]++; }));
    const aderenza = (lista) => (lista.length ? lista.reduce((t, g) => t + g.punti, 0) / (lista.length * S.PASTI.length) : null);

    // --- allenamenti del periodo (oggi compreso)
    const allenamenti = [];
    Object.keys(p.attivita || {}).sort().forEach((k) => {
      if (k < p.da || k > p.a) return;
      (p.attivita[k].allenamenti || []).forEach((x) => allenamenti.push(Object.assign({ giorno: k }, x)));
    });
    const somma = (lista) => {
      const t = { n: lista.length, minuti: 0, km: 0, dplus: 0, kj: 0, tss: 0, kcal: 0, conTss: 0, zone: [0, 0, 0, 0, 0], conZone: 0, perIntensita: { leggera: 0, moderata: 0, intensa: 0 } };
      lista.forEach((x) => {
        t.minuti += Number(x.durata) || 0;
        t.km += Number(x.distanzaKm) || 0;
        t.dplus += Number(x.dislivelloM) || 0;
        t.kj += Number(x.lavoroKJ) || 0;
        t.kcal += Number(x.kcal) || 0;
        if (x.tss) { t.tss += Number(x.tss) || 0; t.conTss++; }
        if (Array.isArray(x.zoneFC) && x.zoneFC.length === 5) { x.zoneFC.forEach((m, i) => { t.zone[i] += Number(m) || 0; }); t.conZone++; }
        if (t.perIntensita[x.intensita] != null) t.perIntensita[x.intensita]++;
      });
      t.km = Math.round(t.km * 10) / 10;
      return t;
    };

    // --- settimane di calendario che toccano il periodo
    const settimane = [];
    for (let l = lunedi(da); l <= a; l = piuGiorni(l, 7)) {
      const fine = piuGiorni(l, 6);
      const kDa = chiave(l), kA = chiave(fine);
      const g = giorni.filter((x) => x.chiave >= kDa && x.chiave <= kA);
      settimane.push({
        lunedi: kDa,
        aderenza: aderenza(g), giorniValutati: g.length,
        allenamenti: somma(allenamenti.filter((x) => x.giorno >= kDa && x.giorno <= kA && x.giorno >= p.da && x.giorno <= p.a)),
        parziale: l < da || fine > a,
      });
    }

    // --- peso e misure del periodo
    const misure = (p.misure || []).filter((m) => m && m.data >= p.da && m.data <= p.a && Number(m.peso) > 0)
      .slice().sort((x, y) => (x.data < y.data ? -1 : x.data > y.data ? 1 : 0));
    const peso = misure.length ? {
      primo: misure[0], ultimo: misure[misure.length - 1],
      variazione: misure.length > 1 ? Math.round((misure[misure.length - 1].peso - misure[0].peso) * 10) / 10 : null,
      serie: misure.map((m) => ({ data: m.data, peso: Number(m.peso) })),
    } : null;

    return {
      da: p.da, a: p.a,
      aderenza: aderenza(giorni), giorniValutati: giorni.length, conta,
      settimane,
      allenamenti: { totale: somma(allenamenti), elenco: allenamenti },
      peso, misure,
    };
  }

  const api = { PERIODI, calcola, chiave, daChiave, lunedi };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.reportPreparatore = api;
})();
