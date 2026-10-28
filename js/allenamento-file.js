/**
 * allenamento-file.js
 * Importazione di un allenamento da file: FIT (Garmin, Wahoo, Bryton, Strava
 * "Esporta originale"), TCX (Garmin Connect, TrainingPeaks), GPX (Strava e altri).
 *
 * Il file si legge sul telefono e NON si conserva: si salva solo il riepilogo
 * (durata, distanza, dislivello, calorie stimate dal dispositivo, frequenza
 * cardiaca, potenza, minuti nelle zone). Il percorso GPS viene scartato.
 *
 * Le funzioni di calcolo sono "pure" e girano anche in Node (test/allenamento-file.test.js).
 * Per i FIT serve js/vendor/fit-parser.min.js (fit-file-parser, licenza MIT), caricato solo al bisogno.
 */
(function () {
  "use strict";

  const TIPI = {
    cycling: "Bici", e_biking: "Bici", biking: "Bici", bike: "Bici", ciclismo: "Bici", ride: "Bici", virtualride: "Bici",
    running: "Corsa", run: "Corsa", trail_running: "Corsa", corsa: "Corsa",
    walking: "Camminata veloce", walk: "Camminata veloce", hiking: "Camminata veloce", hike: "Camminata veloce",
    swimming: "Nuoto", swim: "Nuoto",
    training: "Palestra / pesi", fitness_equipment: "Palestra / pesi", strength_training: "Palestra / pesi", weighttraining: "Palestra / pesi",
    yoga: "Yoga / pilates", pilates: "Yoga / pilates",
    soccer: "Sport di squadra", basketball: "Sport di squadra", volleyball: "Sport di squadra",
  };

  function tipoDa(sport) {
    const k = String(sport || "").toLowerCase().replace(/[\s-]+/g, "_");
    if (TIPI[k]) return TIPI[k];
    if (/bik|cycl|ride/.test(k)) return "Bici";
    if (/run/.test(k)) return "Corsa";
    if (/walk|hik/.test(k)) return "Camminata veloce";
    if (/swim/.test(k)) return "Nuoto";
    return "Altro";
  }

  function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

  /** Allenamento al chiuso: sottotipo del dispositivo (rulli, tapis roulant, virtuale) oppure nessuna posizione GPS. */
  const INDOOR = /indoor|virtual|spin|treadmill|trainer|tapis/i;
  function eIndoor(sport, sottotipo, haPosizione) {
    if (INDOOR.test(String(sottotipo || "")) || INDOOR.test(String(sport || ""))) return true;
    return haPosizione === false;
  }

  // ---------------------------------------------------------------------
  // Formato comune: { formato, sport, inizio (ms), durataSec, distanzaM, dislivelloM,
  //   kcal, fcMedia, fcMax, potenzaMedia, potenzaNormalizzata, campioni: [{t, fc, w}] }
  // ---------------------------------------------------------------------

  /** Dall'oggetto restituito da fit-file-parser (mode "list", lengthUnit "m"). */
  function daFit(data) {
    const sessioni = (data && data.sessions) || [];
    if (!sessioni.length) throw new Error("nessuna-sessione");
    const s = sessioni[0];
    const inizio = new Date(s.start_time || s.timestamp).getTime();
    const somma = (k) => sessioni.reduce((t, x) => t + (num(x[k]) || 0), 0);
    const campioni = ((data && data.records) || []).map((r) => ({
      t: (new Date(r.timestamp).getTime() - inizio) / 1000,
      fc: num(r.heart_rate), w: num(r.power),
    })).filter((c) => Number.isFinite(c.t));
    const records = (data && data.records) || [];
    const haPosizione = records.some((r) => r.position_lat != null);
    return {
      formato: "FIT",
      sport: s.sport,
      indoor: eIndoor(s.sport, s.sub_sport, records.length ? haPosizione : null),
      inizio,
      durataSec: somma("total_timer_time") || somma("total_elapsed_time"),
      distanzaM: somma("total_distance"),
      dislivelloM: somma("total_ascent") || null,
      kcal: somma("total_calories") || null,
      fcMedia: num(s.avg_heart_rate),
      fcMax: num(s.max_heart_rate),
      potenzaMedia: num(s.avg_power),
      potenzaNormalizzata: num(s.normalized_power),
      campioni,
    };
  }

  function tag(xml, nome) {
    const m = xml.match(new RegExp("<(?:\\w+:)?" + nome + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?" + nome + ">", "i"));
    return m ? m[1].trim() : null;
  }
  function tutti(xml, nome) {
    return xml.match(new RegExp("<(?:\\w+:)?" + nome + "[\\s>][\\s\\S]*?</(?:\\w+:)?" + nome + ">", "gi")) || [];
  }

  function dislivelloDa(quote) {
    // salita con soglia di 3 m, per non sommare il rumore dell'altimetro
    let salita = 0, base = null;
    quote.forEach((q) => {
      if (q == null) return;
      if (base == null) { base = q; return; }
      if (q - base >= 3) { salita += q - base; base = q; } else if (q < base) base = q;
    });
    return salita ? Math.round(salita) : null;
  }

  function mediaMax(campioni, k) {
    const v = campioni.map((c) => c[k]).filter((x) => x != null && x > 0);
    if (!v.length) return [null, null];
    return [Math.round(v.reduce((a, b) => a + b, 0) / v.length), Math.max.apply(null, v)];
  }

  /** TCX (testo XML). */
  function daTcx(xml) {
    const att = tutti(xml, "Activity")[0] || xml;
    const sportM = att.match(/<(?:\w+:)?Activity[^>]*Sport="([^"]+)"/i);
    const giri = tutti(att, "Lap");
    if (!giri.length) throw new Error("nessun-giro");
    const inizioM = att.match(/<(?:\w+:)?Lap[^>]*StartTime="([^"]+)"/i);
    const inizio = new Date(inizioM ? inizioM[1] : tag(att, "Id")).getTime();
    let durata = 0, dist = 0, kcal = 0;
    giri.forEach((g) => {
      durata += num(tag(g, "TotalTimeSeconds")) || 0;
      dist += num(tag(g, "DistanceMeters")) || 0;
      kcal += num(tag(g, "Calories")) || 0;
    });
    const punti = tutti(att, "Trackpoint");
    const campioni = punti.map((p) => {
      const hr = tag(p, "HeartRateBpm");
      return {
        t: (new Date(tag(p, "Time")).getTime() - inizio) / 1000,
        fc: hr ? num(tag(hr, "Value")) : null,
        w: num(tag(p, "Watts")),
        q: num(tag(p, "AltitudeMeters")),
      };
    }).filter((c) => Number.isFinite(c.t));
    const [fcMediaC, fcMaxC] = mediaMax(campioni, "fc");
    const [wMedia] = mediaMax(campioni, "w");
    const fcMediaGiro = giri.map((g) => { const b = tag(g, "AverageHeartRateBpm"); return b ? num(tag(b, "Value")) : null; }).filter(Boolean);
    const fcMaxGiro = giri.map((g) => { const b = tag(g, "MaximumHeartRateBpm"); return b ? num(tag(b, "Value")) : null; }).filter(Boolean);
    return {
      formato: "TCX",
      sport: sportM ? sportM[1] : "",
      indoor: eIndoor(sportM ? sportM[1] : "", "", punti.length ? /<(?:\w+:)?Position[\s>]/i.test(att) : null),
      inizio,
      durataSec: durata,
      distanzaM: dist,
      dislivelloM: dislivelloDa(campioni.map((c) => c.q)),
      kcal: kcal || null,
      // i valori del giro sono quelli calcolati dal dispositivo: hanno la precedenza
      fcMedia: fcMediaGiro.length ? Math.round(fcMediaGiro.reduce((a, b) => a + b, 0) / fcMediaGiro.length) : fcMediaC,
      fcMax: Math.max(fcMaxC || 0, fcMaxGiro.length ? Math.max.apply(null, fcMaxGiro) : 0) || null,
      potenzaMedia: wMedia,
      potenzaNormalizzata: null,
      campioni,
    };
  }

  function distanzaM(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** GPX (testo XML). Di solito senza calorie: la durata esclude le pause oltre 60 secondi. */
  function daGpx(xml) {
    const punti = xml.match(/<trkpt[\s\S]*?(?:<\/trkpt>|\/>)/gi) || [];
    if (punti.length < 2) throw new Error("nessun-punto");
    const pp = punti.map((p) => {
      const lat = p.match(/lat="([^"]+)"/i), lon = p.match(/lon="([^"]+)"/i);
      return {
        lat: lat ? Number(lat[1]) : null, lon: lon ? Number(lon[1]) : null,
        ms: new Date(tag(p, "time")).getTime(),
        q: num(tag(p, "ele")), fc: num(tag(p, "hr")), w: num(tag(p, "power")),
      };
    }).filter((x) => Number.isFinite(x.ms));
    if (pp.length < 2) throw new Error("nessun-punto");
    const inizio = pp[0].ms;
    let dist = 0, durata = 0;
    for (let i = 1; i < pp.length; i++) {
      if (pp[i].lat != null && pp[i - 1].lat != null) dist += distanzaM(pp[i - 1], pp[i]);
      const dt = (pp[i].ms - pp[i - 1].ms) / 1000;
      if (dt > 0 && dt <= 60) durata += dt;
    }
    const campioni = pp.map((x) => ({ t: (x.ms - inizio) / 1000, fc: x.fc, w: x.w }));
    const [fcMedia, fcMax] = mediaMax(campioni, "fc");
    const [wMedia] = mediaMax(campioni, "w");
    const tipoM = xml.match(/<trk>[\s\S]*?<type>([^<]+)<\/type>/i);
    return {
      formato: "GPX",
      sport: tipoM ? tipoM[1] : "",
      indoor: eIndoor(tipoM ? tipoM[1] : "", "", pp.some((x) => x.lat != null)),
      inizio,
      durataSec: durata,
      distanzaM: dist,
      dislivelloM: dislivelloDa(pp.map((x) => x.q)),
      kcal: null,
      fcMedia, fcMax,
      potenzaMedia: wMedia,
      potenzaNormalizzata: null,
      campioni,
    };
  }

  // ---------------------------------------------------------------------
  // Zone e intensità
  // ---------------------------------------------------------------------

  /**
   * Limiti delle 5 zone di frequenza cardiaca (bpm, limite inferiore di Z2…Z5).
   * Con la FC di soglia: 81 / 90 / 94 / 100 % (zone di Friel); con la FC massima: 60 / 70 / 80 / 90 %.
   */
  function limitiZone(parametri) {
    parametri = parametri || {};
    const soglia = num(parametri.fcSoglia), max = num(parametri.fcMax);
    if (soglia && soglia >= 100 && soglia <= 220) return { base: "soglia", limiti: [0.81, 0.90, 0.94, 1.00].map((p) => Math.round(soglia * p)) };
    if (max && max >= 120 && max <= 230) return { base: "massima", limiti: [0.60, 0.70, 0.80, 0.90].map((p) => Math.round(max * p)) };
    return null;
  }

  /** Minuti in ciascuna zona Z1…Z5, pesando ogni campione per il tempo fino al successivo (al massimo 10 s). */
  function minutiInZone(campioni, limiti) {
    const sec = [0, 0, 0, 0, 0];
    for (let i = 0; i < campioni.length - 1; i++) {
      const fc = campioni[i].fc;
      if (!fc) continue;
      const dt = Math.min(10, Math.max(0, campioni[i + 1].t - campioni[i].t));
      let z = 0;
      while (z < 4 && fc >= limiti[z]) z++;
      sec[z] += dt;
    }
    const tot = sec.reduce((a, b) => a + b, 0);
    if (tot < 120) return null;
    return sec.map((s) => Math.round(s / 60));
  }

  /**
   * Intensità misurata: con la potenza e la FTP (fattore di intensità), altrimenti
   * con il tempo nelle zone di frequenza cardiaca, altrimenti con la FC media.
   * Restituisce { intensita, fonte, valore } oppure null.
   */
  function intensitaMisurata(r, parametri) {
    parametri = parametri || {};
    const ftp = num(parametri.ftp);
    const w = r.potenzaNormalizzata || r.potenzaMedia;
    if (ftp && ftp >= 80 && w) {
      const fi = w / ftp;
      return { intensita: fi < 0.75 ? "leggera" : fi <= 0.9 ? "moderata" : "intensa", fonte: "potenza", valore: Math.round(fi * 100) / 100 };
    }
    if (r.zoneFC) {
      const tot = r.zoneFC.reduce((a, b) => a + b, 0) || 1;
      const bassa = (r.zoneFC[0] + r.zoneFC[1]) / tot, alta = (r.zoneFC[3] + r.zoneFC[4]) / tot;
      return { intensita: alta >= 0.2 ? "intensa" : bassa >= 0.75 ? "leggera" : "moderata", fonte: "zone", valore: null };
    }
    const max = num(parametri.fcMax);
    if (max && r.fcMedia) {
      const p = r.fcMedia / max;
      return { intensita: p < 0.7 ? "leggera" : p < 0.8 ? "moderata" : "intensa", fonte: "fc", valore: Math.round(p * 100) };
    }
    return null;
  }

  function dueCifre(n) { return String(n).padStart(2, "0"); }

  /** Campioni con passo regolare di circa 1 s? (serve per la potenza normalizzata) */
  function passoMedio(campioni) {
    if (campioni.length < 60) return null;
    return (campioni[campioni.length - 1].t - campioni[0].t) / (campioni.length - 1);
  }

  /** Potenza normalizzata: media mobile su 30 s, quarta potenza, media, radice quarta. */
  function potenzaNormalizzata(campioni) {
    const passo = passoMedio(campioni);
    if (!passo || passo > 2.5) return null;
    const w = campioni.map((c) => (c.w > 0 ? c.w : 0));
    if (!w.some((x) => x > 0)) return null;
    const fin = Math.max(1, Math.round(30 / passo));
    if (w.length < fin * 2) return null;
    let somma = 0, acc = 0, n = 0;
    for (let i = 0; i < w.length; i++) {
      somma += w[i];
      if (i >= fin) somma -= w[i - fin];
      if (i >= fin - 1) { acc += Math.pow(somma / fin, 4); n++; }
    }
    return n ? Math.round(Math.pow(acc / n, 0.25)) : null;
  }

  /**
   * Deriva cardiaca (Pa:HR): quanto peggiora il rapporto potenza / frequenza
   * cardiaca tra la prima e la seconda metà, in %. Solo con potenza e FC, oltre 20 minuti.
   * Sotto il 5% l'uscita è considerata aerobicamente stabile.
   */
  function derivaCardiaca(campioni) {
    const v = campioni.filter((c) => c.fc > 0 && c.w != null);
    if (v.length < 120) return null;
    const durata = v[v.length - 1].t - v[0].t;
    if (durata < 1200) return null;
    const meta = v[0].t + durata / 2;
    const media = (arr, k) => arr.reduce((t, c) => t + (c[k] || 0), 0) / arr.length;
    const a = v.filter((c) => c.t < meta), b = v.filter((c) => c.t >= meta);
    const fcA = media(a, "fc"), fcB = media(b, "fc"), wA = media(a, "w"), wB = media(b, "w");
    if (!fcA || !fcB || wA <= 0) return null;
    const rA = wA / fcA, rB = wB / fcB;
    return Math.round(((rA - rB) / rA) * 1000) / 10;
  }

  /**
   * Riepilogo da salvare (niente campioni né percorso).
   * parametri: { fcMax, fcSoglia, ftp } dalle Impostazioni del paziente.
   */
  function riepilogo(d, parametri) {
    const inizio = new Date(d.inizio);
    const durata = Math.round((d.durataSec || 0) / 60);
    const r = {
      tipo: tipoDa(d.sport),
      durata,
      giorno: `${inizio.getFullYear()}-${dueCifre(inizio.getMonth() + 1)}-${dueCifre(inizio.getDate())}`,
      ora: `${dueCifre(inizio.getHours())}:${dueCifre(inizio.getMinutes())}`,
      fonte: "file",
      formato: d.formato,
    };
    if (d.indoor) r.indoor = true;
    if (d.distanzaM > 50) r.distanzaKm = Math.round(d.distanzaM / 100) / 10;
    if (d.dislivelloM > 0) r.dislivelloM = Math.round(d.dislivelloM);
    if (d.kcal > 0) r.kcal = Math.round(d.kcal);
    if (d.fcMedia > 0) r.fcMedia = Math.round(d.fcMedia);
    if (d.fcMax > 0) r.fcMax = Math.round(d.fcMax);
    if (d.potenzaMedia > 0) r.potenzaMedia = Math.round(d.potenzaMedia);
    const np = d.potenzaNormalizzata > 0 ? d.potenzaNormalizzata : (d.potenzaMedia > 0 ? potenzaNormalizzata(d.campioni || []) : null);
    if (np > 0) r.potenzaNormalizzata = Math.round(np);
    // indici di carico, calcolati qui perché il dettaglio dell'allenamento non si conserva
    if (r.potenzaMedia && d.durataSec) r.lavoroKJ = Math.round((r.potenzaMedia * d.durataSec) / 1000);
    if (r.kcal && durata >= 10) r.kcalOra = Math.round(r.kcal / (durata / 60));
    const ftp = num((parametri || {}).ftp);
    if (ftp && ftp >= 80 && (r.potenzaNormalizzata || r.potenzaMedia) && d.durataSec) {
      const w = r.potenzaNormalizzata || r.potenzaMedia;
      const fi = w / ftp;
      r.fattoreIntensita = Math.round(fi * 100) / 100;
      r.tss = Math.round(((d.durataSec * w * fi) / (ftp * 3600)) * 100);
    }
    const deriva = derivaCardiaca(d.campioni || []);
    if (deriva != null) r.derivaCardiaca = deriva;
    const zone = limitiZone(parametri);
    if (zone) {
      const m = minutiInZone(d.campioni || [], zone.limiti);
      if (m) { r.zoneFC = m; r.zoneBase = zone.base; }
    }
    const mis = intensitaMisurata(r, parametri);
    if (mis) { r.intensita = mis.intensita; r.intensitaFonte = mis.fonte; if (mis.valore != null) r.intensitaValore = mis.valore; }
    return r;
  }

  // ---------------------------------------------------------------------
  // Solo browser: lettura del file scelto dall'utente
  // ---------------------------------------------------------------------
  let caricamentoFit = null;
  function caricaLettoreFit() {
    if (typeof window === "undefined") return Promise.reject(new Error("solo-browser"));
    if (window.FitParser) return Promise.resolve(window.FitParser);
    if (!caricamentoFit) {
      caricamentoFit = new Promise((ok, ko) => {
        const s = document.createElement("script");
        s.src = "js/vendor/fit-parser.min.js";
        s.onload = () => (window.FitParser ? ok(window.FitParser) : ko(new Error("lettore-fit")));
        s.onerror = () => { caricamentoFit = null; ko(new Error("lettore-fit")); };
        document.head.appendChild(s);
      });
    }
    return caricamentoFit;
  }

  function leggiFit(buffer) {
    return caricaLettoreFit().then((FitParser) => new Promise((ok, ko) => {
      const p = new FitParser({ force: true, mode: "list", speedUnit: "km/h", lengthUnit: "m" });
      p.parse(buffer, (err, data) => (err ? ko(new Error("fit-illeggibile")) : ok(data)));
    }));
  }

  function eFit(buffer) {
    const b = new Uint8Array(buffer.slice(0, 12));
    return b.length >= 12 && b[8] === 0x2e && b[9] === 0x46 && b[10] === 0x49 && b[11] === 0x54;
  }

  /** Legge un File (input type=file) e restituisce il formato comune. */
  async function leggiFile(file) {
    if (!file) throw new Error("nessun-file");
    if (file.size > 25 * 1024 * 1024) throw new Error("file-troppo-grande");
    const nome = String(file.name || "").toLowerCase();
    const buffer = await file.arrayBuffer();
    // FIT riconosciuto anche senza estensione (file condivisi da altre app): ".FIT" ai byte 8-11 dell'intestazione
    if (nome.endsWith(".fit") || eFit(buffer)) return daFit(await leggiFit(buffer));
    const testo = await file.text();
    if (nome.endsWith(".tcx") || /<TrainingCenterDatabase/i.test(testo)) return daTcx(testo);
    if (nome.endsWith(".gpx") || /<gpx[\s>]/i.test(testo)) return daGpx(testo);
    throw new Error("formato-non-supportato");
  }


  // ---------------------------------------------------------------------
  // Health Connect (app Android): sessioni di allenamento (tipo, inizio, fine)
  // e calorie del periodo, attive o, se mancano, totali (Strava scrive solo
  // queste). Distanza e frequenza non si leggono (permessi READ_EXERCISE,
  // READ_ACTIVE_CALORIES_BURNED e READ_TOTAL_CALORIES_BURNED soltanto).
  // ---------------------------------------------------------------------
  const TIPI_HC = {
    running: ["Corsa"], runningTreadmill: ["Corsa", true],
    walking: ["Camminata veloce"], hiking: ["Camminata veloce"], wheelchair: ["Altro"],
    cycling: ["Bici"], bikingStationary: ["Bici", true],
    swimmingPool: ["Nuoto", true], swimmingOpenWater: ["Nuoto"],
    strengthTraining: ["Palestra / pesi"], weightlifting: ["Palestra / pesi"], calisthenics: ["Palestra / pesi"],
    crossTraining: ["Palestra / pesi"], bootCamp: ["Palestra / pesi"], exerciseClass: ["Palestra / pesi"],
    elliptical: ["Palestra / pesi", true], rowingMachine: ["Palestra / pesi", true], stairClimbingMachine: ["Palestra / pesi", true],
    yoga: ["Yoga / pilates"], pilates: ["Yoga / pilates"], stretching: ["Yoga / pilates"],
    soccer: ["Sport di squadra"], basketball: ["Sport di squadra"], volleyball: ["Sport di squadra"], handball: ["Sport di squadra"],
    rugby: ["Sport di squadra"], waterPolo: ["Sport di squadra"], americanFootball: ["Sport di squadra"], australianFootball: ["Sport di squadra"],
    baseball: ["Sport di squadra"], softball: ["Sport di squadra"], cricket: ["Sport di squadra"], iceHockey: ["Sport di squadra"], rollerHockey: ["Sport di squadra"],
  };

  /**
   * Calorie attive di un allenamento dai campioni di Health Connect
   * ({ value, sourceName }). Per non sommare due volte le stesse calorie scritte
   * da app diverse (orologio e telefono) si usa una sola fonte: quella
   * dell'allenamento se presente, altrimenti la fonte con il totale più alto.
   */
  function kcalDaCampioni(campioni, fonteAllenamento) {
    const perFonte = {};
    (campioni || []).forEach((c) => {
      const v = Number(c && c.value);
      if (!(v > 0)) return;
      const f = String((c && c.sourceName) || "");
      perFonte[f] = (perFonte[f] || 0) + v;
    });
    const fonti = Object.keys(perFonte);
    if (!fonti.length) return null;
    const scelta = fonteAllenamento && perFonte[fonteAllenamento] != null ? fonteAllenamento
      : fonti.sort((a, b) => perFonte[b] - perFonte[a])[0];
    const kcal = Math.round(perFonte[scelta]);
    return kcal >= 1 ? kcal : null;
  }

  /**
   * Calorie totali di un allenamento: solo i campioni registrati DENTRO la
   * sessione (un minuto di tolleranza), per non contare un totale giornaliero
   * o di altre ore. Poi come le calorie attive: una sola fonte.
   */
  function kcalTotaliDaCampioni(campioni, w) {
    const ini = Date.parse(w && w.startDate), fine = Date.parse(w && w.endDate);
    if (isNaN(ini) || isNaN(fine)) return null;
    const dentro = (campioni || []).filter((c) => {
      const a = Date.parse(c && c.startDate), b = Date.parse(c && c.endDate);
      return !isNaN(a) && !isNaN(b) && a >= ini - 60000 && b <= fine + 60000;
    });
    return kcalDaCampioni(dentro, w.sourceName);
  }

  /**
   * Sessione di Health Connect ({ workoutType, duration (s), startDate, endDate, sourceName })
   * nel formato degli allenamenti dell'app. null se la durata è sotto i 3 minuti.
   */
  function daHealthConnect(w) {
    if (!w || !w.startDate) return null;
    const inizio = new Date(w.startDate);
    if (isNaN(inizio.getTime())) return null;
    const durata = Math.round((Number(w.duration) || 0) / 60);
    if (durata < 3) return null;
    const [tipo, indoor] = TIPI_HC[w.workoutType] || ["Altro"];
    const dueCifre = (n) => String(n).padStart(2, "0");
    const out = {
      tipo, durata,
      giorno: `${inizio.getFullYear()}-${dueCifre(inizio.getMonth() + 1)}-${dueCifre(inizio.getDate())}`,
      ora: `${dueCifre(inizio.getHours())}:${dueCifre(inizio.getMinutes())}`,
      fonte: "healthconnect",
      hcId: `${inizio.getTime()}_${String(w.sourceName || "").slice(0, 80)}`,
    };
    if (indoor) out.indoor = true;
    if (w.sourceName) out.origine = String(w.sourceName).slice(0, 80);
    const kcal = Math.round(Number(w.totalEnergyBurned) || 0);
    if (kcal > 0 && kcal < 10000) out.kcal = kcal;
    return out;
  }

  const api = { daHealthConnect, kcalDaCampioni, kcalTotaliDaCampioni, tipoDa, daFit, daTcx, daGpx, limitiZone, minutiInZone, intensitaMisurata, potenzaNormalizzata, derivaCardiaca, riepilogo, leggiFile, eFit };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.allenamentoFile = api;
})();
