
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
/**
 * Settimane effettivamente presenti nel piano (1-5), in ordine.
 */
function settimaneDisponibili(piano) {
  const s = (piano && piano.settimane) || {};
  return [1, 2, 3, 4, 5].filter((n) => Array.isArray(s[n]) || Array.isArray(s[String(n)]));
}

/**
 * Data di inizio del piano del SINGOLO paziente (campo piano.dataInizio,
 * formato "YYYY-MM-DD", impostato dal professionista). Se presente, il ciclo
 * parte da lì: la settimana di quella data è la "Settimana 1" e poi si ruota
 * su tutte le settimane compilate nel piano (1→2→…→N→1). Se manca (piani
 * creati prima di questa versione) si usa la regola generale di config.json.
 */
function settimanaDaDataInizio(lunedi, piano) {
  const disp = settimaneDisponibili(piano);
  if (!disp.length) return { settimana: 1, pianoIniziato: true };
  const [a, m, g] = String(piano.dataInizio).split("-").map(Number);
  const lunediStart = lunediDellaSettimana(new Date(a, m - 1, g));
  const msPerSettimana = 7 * 24 * 60 * 60 * 1000;
  const trascorse = Math.round((lunedi.getTime() - lunediStart.getTime()) / msPerSettimana);
  if (trascorse < 0) return { settimana: disp[0], pianoIniziato: false };
  return { settimana: disp[trascorse % disp.length], pianoIniziato: true };
}

function calcolaSettimanaGiorno(date, config, piano) {
  const d = new Date(date);
  const giornoIndex = (d.getDay() + 6) % 7;
  const giornoNome = GIORNI[giornoIndex];
  const lunedi = lunediDellaSettimana(d);

  let settimana;
  let pianoIniziato = true;

  if (piano && typeof piano.dataInizio === "string" && /^\d{4}-\d{2}-\d{2}$/.test(piano.dataInizio)) {
    const r = settimanaDaDataInizio(lunedi, piano);
    settimana = r.settimana;
    pianoIniziato = r.pianoIniziato;
  } else if (config.overrideWeek) {
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

  return { settimana, giornoIndex, giornoNome, pianoIniziato };
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
  const { settimana, giornoIndex, giornoNome, pianoIniziato } = calcolaSettimanaGiorno(date, config, piano);
  const settimane = (piano && piano.settimane) || {};
  let settimanaDati = settimane[settimana] || settimane[((settimana - 1) % 4) + 1];
  if (!settimanaDati) {
    const chiaviDisponibili = Object.keys(settimane);
    if (chiaviDisponibili.length) settimanaDati = settimane[chiaviDisponibili[0]];
  }
  const giorno = (settimanaDati && settimanaDati[giornoIndex]) || null;
  return { settimana, giornoNome, giorno, pianoIniziato };
}

const api = { GIORNI, calcolaSettimanaGiorno, menuDelGiorno, lunediDellaSettimana, settimaneDisponibili };
if (typeof window !== "undefined") window.weekLogic = api;
if (typeof module !== "undefined") module.exports = api;
