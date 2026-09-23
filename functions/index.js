
/**
 * functions/index.js
 * Cloud Function programmata: ogni 5 minuti controlla tutti i piani attivi
 * e invia una notifica push (Firebase Cloud Messaging) ai pazienti che
 * hanno le notifiche attive e per cui è il momento del promemoria — anche
 * ad app completamente chiusa. Questo è il pezzo "server" che completa i
 * promemoria locali già gestiti da js/app.js.
 *
 * IMPORTANTE — valori duplicati da tenere allineati manualmente:
 *  - CONFIG_BASE e ORARI_DEFAULT qui sotto devono restare uguali a config.json
 *    nella cartella principale del sito. Se modifichi config.json, aggiorna
 *    anche questi due oggetti e ripubblica la funzione (`firebase deploy --only functions`).
 *  - week-logic.js qui dentro è una COPIA di js/week-logic.js (i Cloud
 *    Functions vengono pubblicate solo con i file dentro functions/, non
 *    possono "vedere" il resto del repository).
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const weekLogic = require("./week-logic.js");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// Regione europea: più vicina, e coerente con la posizione scelta per Firestore.
setGlobalOptions({ region: "europe-west1" });

const MEAL_KEYS = ["colazione", "spuntinoMattina", "pranzo", "spuntinoPomeriggio", "cena"];
const MEAL_LABELS = {
  colazione: "Colazione",
  spuntinoMattina: "Spuntino di metà mattina",
  pranzo: "Pranzo",
  spuntinoPomeriggio: "Spuntino pomeridiano",
  cena: "Cena",
};

// Stessi valori di config.json (vedi nota in cima al file).
const CONFIG_BASE = {
  startDate: "2026-09-14",
  week5Months: [],
  overrideWeek: null,
};
const ORARI_DEFAULT = {
  colazione: "08:00",
  spuntinoMattina: "10:30",
  pranzo: "13:00",
  spuntinoPomeriggio: "16:30",
  cena: "20:00",
};
const ANTICIPO_DEFAULT = 15;
const FINESTRA_MINUTI = 5; // stessa cadenza dello scheduler: un solo tick "vede" ogni pasto

function chiaveData(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/**
 * Il server (Cloud Functions) gira in UTC, non in ora italiana: senza questa
 * conversione, un pasto delle 16:30 verrebbe confrontato con le 16:30 UTC,
 * cioè le 18:30 in Italia (ora legale) — promemoria sistematicamente sfasati
 * di 1-2 ore. Questa funzione costruisce un Date i cui "getter locali"
 * (getHours, getDay, getDate, ecc.) restituiscono i valori dell'ora di Roma,
 * qualunque sia il fuso orario reale del server: tutto il resto del file può
 * quindi continuare a usare i normali getHours()/setHours() come se girasse
 * su un computer impostato sull'ora italiana.
 */
function oraItaliana(adesso) {
  const parti = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(adesso);
  const get = (tipo) => Number(parti.find((p) => p.type === tipo).value);
  return new Date(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

/**
 * Vero se "adesso" cade nella finestra [orario-anticipo, orario-anticipo+finestra)
 * per un pasto — cioè se è il momento di inviare il promemoria. Funzione pura,
 * testabile da sola senza bisogno di Firestore/FCM veri. Richiede che
 * `oraCorrente` sia già in ora italiana (vedi oraItaliana sopra).
 */
function pastoDaNotificareOra(oraCorrente, orarioPastoStr, anticipoMinuti, finestraMinuti) {
  if (!orarioPastoStr) return false;
  const parti = orarioPastoStr.split(":").map(Number);
  if (parti.length !== 2 || Number.isNaN(parti[0]) || Number.isNaN(parti[1])) return false;
  const orarioPasto = new Date(oraCorrente);
  orarioPasto.setHours(parti[0], parti[1], 0, 0);
  const momentoInvio = new Date(orarioPasto.getTime() - anticipoMinuti * 60000);
  const diffMinuti = (oraCorrente.getTime() - momentoInvio.getTime()) / 60000;
  return diffMinuti >= 0 && diffMinuti < finestraMinuti;
}

exports.controllaPromemoria = onSchedule(
  { schedule: "every 5 minutes", timeZone: "Europe/Rome" },
  async () => {
    const ora = oraItaliana(new Date());
    const dateKey = chiaveData(ora);

    const pianiSnap = await db.collection("piani").get();

    for (const pianoDoc of pianiSnap.docs) {
      const piano = pianoDoc.data();
      const pazienteUid = piano.pazienteUid;
      if (!pazienteUid) continue;

      const utenteRef = db.collection("users").doc(pazienteUid);
      const utenteDoc = await utenteRef.get();
      if (!utenteDoc.exists) continue;
      const utente = utenteDoc.data();

      if (!utente.notificheAttive) continue;
      const tokens = Array.isArray(utente.fcmTokens) ? utente.fcmTokens.filter(Boolean) : [];
      if (!tokens.length) continue;

      const { giorno } = weekLogic.menuDelGiorno(ora, CONFIG_BASE, piano);
      if (!giorno) continue;

      const orari = Object.assign({}, ORARI_DEFAULT, utente.orariOverride || {});
      const anticipo = typeof utente.anticipoMinuti === "number" ? utente.anticipoMinuti : ANTICIPO_DEFAULT;

      const trackingRef = db.collection("notificheInviate").doc(pazienteUid + "_" + dateKey);
      const trackingDoc = await trackingRef.get();
      const giaInviate = (trackingDoc.exists && trackingDoc.data().pasti) || [];

      for (const key of MEAL_KEYS) {
        if (giaInviate.includes(key)) continue;
        if (!pastoDaNotificareOra(ora, orari[key], anticipo, FINESTRA_MINUTI)) continue;

        const testo = giorno[key];
        if (!testo) continue;

        try {
          const risultato = await messaging.sendEachForMulticast({
            tokens,
            notification: {
              title: `${MEAL_LABELS[key]} tra ${anticipo} minuti`,
              body: testo,
            },
          });

          // Ripulisce eventuali token scaduti/disinstallati.
          const tokenDaRimuovere = [];
          risultato.responses.forEach((r, i) => {
            const codice = r.error && r.error.code;
            if (!r.success && (codice === "messaging/registration-token-not-registered" || codice === "messaging/invalid-registration-token")) {
              tokenDaRimuovere.push(tokens[i]);
            }
          });
          if (tokenDaRimuovere.length) {
            await utenteRef.update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokenDaRimuovere) });
          }
        } catch (e) {
          console.error("Errore invio notifica a", pazienteUid, key, e);
          continue; // non segna come inviato: ci riprova al prossimo tick
        }

        await trackingRef.set(
          { pasti: admin.firestore.FieldValue.arrayUnion(key), aggiornato: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
      }
    }
  }
);

// Esposta solo per i test automatici (Node), non usata da Firebase in produzione.
if (typeof module !== "undefined") {
  module.exports._test = { pastoDaNotificareOra, chiaveData, oraItaliana };
}
