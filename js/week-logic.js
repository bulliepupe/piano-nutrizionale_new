/**
 * week-logic.js
 * Calcola quale "settimana" (1-5) e quale "giorno" del piano nutrizionale
 * si applicano a una data specifica.
 *
 * Usato sia dall'app (nel browser) sia dallo script Node che invia le notifiche
 * tramite GitHub Actions — per questo è scritto senza dipendenze e con un
 * doppio export (window / module.exports), come data.js.
 */

const GIORNI = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"];

/** Restituisce la mezzanotte del lunedì della settimana contenente `date`. */
function lunediDellaSettimana(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const offset = (d.getDay() + 6) % 7; // 0 = lunedì
  d.setDate(d.getDate() - offset);
  return d;
}

/** Restituisce l'indice 1-5 del lunedì all'interno del mese (1° lunedì, 2° lunedì, ...). */
function ordinaleLunediNelMese(lunedi) {
  const anno = lunedi.getFullYear();
  const mese = lunedi.getMonth();
  let cursore = new Date(anno, mese, 1);
  while (cursore.getDay() !== 1) cursore.setDate(cursore.getDate() + 1);
  let count = 0;
  while (cursore <= lunedi) {
    count++;
    cursore.setDate(cursore.getDate() + 7);
  }
  return count;
}

/**
 * Determina settimana (1-5) e giorno (0-6, Lunedì=0) per una data, secondo config:
 *  - config.overrideWeek: se impostato (1-5), forza sempre quella settimana.
 *  - config.week5Months: mesi "YYYY-MM" in cui si applica la 5ª settimana,
 *    solo quando quel lunedì è il 5° lunedì del mese.
 *  - altrimenti il piano ruota ciclicamente 1→2→3→4 a partire da config.startDate
 *    (il lunedì della "Settimana 1" di riferimento).
 */
function calcolaSettimanaGiorno(date, config) {
  const d = new Date(date);
  const giornoIndex = (d.getDay() + 6) % 7;
  const giornoNome = GIORNI[giornoIndex];
  const lunedi = lunediDellaSettimana(d);

  let settimana;

  if (config.overrideWeek) {
    settimana = config.overrideWeek;
  } else {
    const meseChiave = `${lunedi.getFullYear()}-${String(lunedi.getMonth() + 1).padStart(2, "0")}`;
    const eMese5 = Array.isArray(config.week5Months) && config.week5Months.includes(meseChiave);
    const eQuintoLunedi = ordinaleLunediNelMese(lunedi) === 5;

    if (eMese5 && eQuintoLunedi) {
      settimana = 5;
    } else {
      const lunediStart = lunediDellaSettimana(new Date(config.startDate));
      const msPerSettimana = 7 * 24 * 60 * 60 * 1000;
      const settimaneTrascorse = Math.round((lunedi.getTime() - lunediStart.getTime()) / msPerSettimana);
      settimana = (((settimaneTrascorse % 4) + 4) % 4) + 1;
    }
  }

  return { settimana, giornoIndex, giornoNome };
}

/**
 * Recupera il menu del giorno per una data, dato il piano completo e la config.
 * Difensivo verso piani incompleti (es. importati dall'utente con solo alcune
 * settimane compilate): prova la settimana calcolata, poi il fallback 1-4,
 * poi la prima settimana disponibile; se non trova nulla restituisce
 * `giorno: null` invece di lanciare un errore, così la UI può mostrare
 * un messaggio invece di rompersi.
 */
function menuDelGiorno(date, config, piano) {
  const { settimana, giornoIndex, giornoNome } = calcolaSettimanaGiorno(date, config);
  const settimane = (piano && piano.settimane) || {};
  let settimanaDati = settimane[settimana] || settimane[((settimana - 1) % 4) + 1];
  if (!settimanaDati) {
    const chiaviDisponibili = Object.keys(settimane);
    if (chiaviDisponibili.length) settimanaDati = settimane[chiaviDisponibili[0]];
  }
  const giorno = (settimanaDati && settimanaDati[giornoIndex]) || null;
  return { settimana, giornoNome, giorno };
}

const api = { GIORNI, calcolaSettimanaGiorno, menuDelGiorno, lunediDellaSettimana };
if (typeof window !== "undefined") window.weekLogic = api;
if (typeof module !== "undefined") module.exports = api;
