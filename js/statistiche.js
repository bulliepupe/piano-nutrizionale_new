/**
 * statistiche.js
 * Calcoli dell'andamento di un paziente per il pannello del professionista.
 * Solo funzioni "pure" (nessun accesso a Firestore): ricevono le spunte dei
 * pasti già lette e restituiscono i numeri da mostrare. Così sono facili da
 * verificare e da riusare.
 *
 * Definizioni usate in tutta l'app (spiegate anche all'utente):
 *  - aderenza = pasti segnati come fatti / pasti previsti, contando solo i
 *    giorni già conclusi (oggi escluso, perché la giornata è in corso) e solo
 *    dal giorno in cui il piano è iniziato;
 *  - giornata rispettata = almeno 4 pasti su 5 segnati come fatti;
 *  - inattivo = nessuna apertura dell'app e nessuna spunta da più di 2 giorni.
 *
 * Doppio export (window / module.exports), come gli altri moduli.
 */
(function () {
  "use strict";

  const PASTI = ["colazione", "spuntinoMattina", "pranzo", "spuntinoPomeriggio", "cena"];
  const SOGLIA_GIORNO_OK = 4;       // pasti su 5 per considerare la giornata rispettata
  const GIORNI_ALLARME = 2;         // oltre questi giorni senza interazioni → allarme abbandono
  const SOGLIA_ADERENZA_BASSA = 0.7;
  const GIORNI_STORICO = 56;        // 8 settimane

  function mezzanotte(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function chiave(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function daChiave(s) { const [a, m, g] = String(s).split("-").map(Number); return new Date(a, m - 1, g); }
  function aggiungiGiorni(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function differenzaGiorni(a, b) { return Math.round((mezzanotte(a) - mezzanotte(b)) / 86400000); }
  function lunedi(d) { const x = mezzanotte(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function fattiNelGiorno(stato) { return stato ? PASTI.filter((k) => stato[k] === true).length : 0; }

  /** Primo giorno da cui ha senso chiedere le spunte (per la lettura da Firestore). */
  function primoGiornoStorico(oggi) {
    return chiave(aggiungiGiorni(mezzanotte(oggi || new Date()), -GIORNI_STORICO));
  }

  /**
   * @param {object} p
   *  - spunte: { "2026-09-21": {colazione:true, ...}, ... }
   *  - inizio: "YYYY-MM-DD" — primo giorno valutabile (inizio piano / creazione paziente)
   *  - oggi: Date (facoltativo, per i test)
   *  - ultimoAccesso: Date | null
   *  - notificheAttive: boolean, dispositiviNotifiche: number
   *  - prossimaVisita: "YYYY-MM-DD" | null
   */
  function calcola(p) {
    const oggi = mezzanotte(p.oggi || new Date());
    const ieri = aggiungiGiorni(oggi, -1);
    const spunte = p.spunte || {};
    const inizio = p.inizio ? mezzanotte(daChiave(p.inizio)) : aggiungiGiorni(oggi, -GIORNI_STORICO);
    const pianoIniziato = inizio <= oggi;

    // Giorni conclusi e valutabili (dal più vecchio a ieri), al massimo 8 settimane
    const giorni = [];
    for (let i = GIORNI_STORICO; i >= 1; i--) {
      const d = aggiungiGiorni(oggi, -i);
      if (d < inizio) continue;
      const fatti = fattiNelGiorno(spunte[chiave(d)]);
      giorni.push({ data: d, chiave: chiave(d), fatti, weekend: d.getDay() === 0 || d.getDay() === 6 });
    }

    const ultimi = (n) => giorni.filter((g) => differenzaGiorni(oggi, g.data) <= n);
    const aderenza = (lista) => lista.length ? lista.reduce((s, g) => s + g.fatti, 0) / (lista.length * PASTI.length) : null;

    const g7 = ultimi(7), g30 = ultimi(30);
    const perPasto = PASTI.map((k) => ({
      pasto: k,
      valore: g30.length ? g30.filter((g) => spunte[g.chiave] && spunte[g.chiave][k] === true).length / g30.length : null,
    }));

    // Andamento per settimana di calendario (8 settimane, l'ultima è quella in corso)
    const lunediCorrente = lunedi(oggi);
    const settimane = [];
    for (let w = 7; w >= 0; w--) {
      const da = aggiungiGiorni(lunediCorrente, -7 * w);
      const a = aggiungiGiorni(da, 6);
      const qui = giorni.filter((g) => g.data >= da && g.data <= a);
      settimane.push({ lunedi: chiave(da), valore: aderenza(qui), giorni: qui.length, inCorso: w === 0 });
    }

    // Serie di giornate rispettate (fino a ieri; oggi si aggiunge se già raggiunta la soglia)
    const fattiOggi = fattiNelGiorno(spunte[chiave(oggi)]);
    let serie = 0;
    for (let i = giorni.length - 1; i >= 0 && giorni[i].fatti >= SOGLIA_GIORNO_OK; i--) serie++;
    if (pianoIniziato && fattiOggi >= SOGLIA_GIORNO_OK) serie++;
    let record = 0, corrente = 0;
    giorni.forEach((g) => { corrente = g.fatti >= SOGLIA_GIORNO_OK ? corrente + 1 : 0; record = Math.max(record, corrente); });
    record = Math.max(record, serie);

    // Calendario delle ultime 4 settimane (per la mappa a quadretti)
    const calendario = [];
    const partenza = aggiungiGiorni(lunediCorrente, -21);
    for (let i = 0; i < 28; i++) {
      const d = aggiungiGiorni(partenza, i);
      const futuro = d > oggi;
      const primaInizio = d < inizio;
      calendario.push({
        chiave: chiave(d), giorno: d.getDate(),
        fatti: futuro || primaInizio ? null : fattiNelGiorno(spunte[chiave(d)]),
        oggi: +d === +oggi, futuro, primaInizio,
      });
    }

    // Ultima interazione: apertura dell'app o spunta, la più recente
    const giorniConSpunte = Object.keys(spunte).filter((k) => fattiNelGiorno(spunte[k]) > 0).sort();
    const ultimaSpunta = giorniConSpunte.length ? daChiave(giorniConSpunte[giorniConSpunte.length - 1]) : null;
    const candidati = [ultimaSpunta, p.ultimoAccesso || null].filter(Boolean).map(mezzanotte);
    const ultimaInterazione = candidati.length ? new Date(Math.max.apply(null, candidati)) : null;
    const riferimento = ultimaInterazione || (pianoIniziato ? inizio : null);
    const giorniInattivo = riferimento ? Math.max(0, differenzaGiorni(oggi, riferimento)) : null;

    const notifiche = p.notificheAttive
      ? (p.dispositiviNotifiche > 0 ? "attive" : "senza-dispositivo")
      : "disattivate";

    let prossimoControllo = null;
    if (p.prossimaVisita && /^\d{4}-\d{2}-\d{2}$/.test(p.prossimaVisita)) {
      prossimoControllo = { data: p.prossimaVisita, traGiorni: differenzaGiorni(daChiave(p.prossimaVisita), oggi) };
    }

    // Semaforo
    const a7 = aderenza(g7);
    const motivi = [];
    let stato;
    if (!pianoIniziato) {
      stato = "attesa";
      motivi.push("Il piano non è ancora iniziato");
    } else {
      if (giorniInattivo != null && giorniInattivo > GIORNI_ALLARME) {
        motivi.push(ultimaInterazione
          ? `Nessuna attività da ${giorniInattivo} giorni`
          : `Non ha ancora usato l'app (piano iniziato da ${giorniInattivo} giorni)`);
      }
      if (a7 != null && g7.length >= 3 && a7 < SOGLIA_ADERENZA_BASSA) motivi.push(`Aderenza della settimana al ${Math.round(a7 * 100)}%`);
      if (notifiche !== "attive") motivi.push(notifiche === "disattivate" ? "Promemoria disattivati" : "Promemoria attivati ma nessun dispositivo registrato");
      const inattivo = giorniInattivo != null && giorniInattivo > GIORNI_ALLARME;
      stato = inattivo ? "rosso" : motivi.length ? "giallo" : "verde";
    }

    return {
      stato, motivi, pianoIniziato,
      aderenza7: a7, aderenza30: aderenza(g30), giorniValutati30: g30.length,
      perPasto,
      feriali: aderenza(g30.filter((g) => !g.weekend)),
      weekend: aderenza(g30.filter((g) => g.weekend)),
      settimane, calendario,
      serie, record, fattiOggi,
      ultimaSpunta: ultimaSpunta ? chiave(ultimaSpunta) : null,
      ultimaInterazione: ultimaInterazione ? chiave(ultimaInterazione) : null,
      giorniInattivo,
      notifiche,
      prossimoControllo,
    };
  }

  const ORDINE_STATO = { rosso: 0, giallo: 1, verde: 2, attesa: 3 };

  const api = {
    PASTI, SOGLIA_GIORNO_OK, GIORNI_ALLARME, SOGLIA_ADERENZA_BASSA, GIORNI_STORICO, ORDINE_STATO,
    calcola, primoGiornoStorico, chiave, daChiave, differenzaGiorni,
  };
  if (typeof window !== "undefined") window.statistiche = api;
  if (typeof module !== "undefined") module.exports = api;
})();
