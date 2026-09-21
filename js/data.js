/**
 * data.js
 * Dati del piano nutrizionale personalizzato.
 * Estratti dai PDF forniti da Dott.ssa Chiara Liguori — Nutrizione Sportiva & Dimagrimento.
 *
 * Per aggiornare il piano (nuove settimane, sostituzioni, variazioni del nutrizionista):
 * modifica semplicemente questo file. Ogni settimana è un array di 7 giorni,
 * da Lunedì a Domenica, con lo stesso schema di campi.
 */

const PIANO = {
  paziente: {
    nome: "Alessandro Castrovinci",
    eta: 56,
    pesoKg: 68.5,
    altezzaM: 1.65,
    targetKcal: 1500,
    obiettivo: "Ricomposizione Corporea",
    nutrizionista: "Dott.ssa Chiara Liguori — Nutrizione Sportiva & Dimagrimento",
  },

  // Orari indicativi dei pasti, usati per le notifiche e per ordinare la vista "Oggi".
  // Personalizzabili dall'utente nella schermata Impostazioni (sovrascrivono questi default).
  orariDefault: {
    colazione: "08:00",
    spuntinoMattina: "10:30",
    pranzo: "13:00",
    spuntinoPomeriggio: "16:30",
    cena: "20:00",
  },

  normeGenerali: [
    "Olio EVO: max 2 cucchiai al giorno (24g totali), sempre a crudo su verdure o pietanze.",
    "Idratazione: almeno 2 – 2.5 litri di acqua naturale al giorno.",
    "Sale & spezie: max 1 cucchiaino al giorno (6g). Preferire erbe aromatiche, limone, aceto di mele.",
    "Cottura: preferire vapore, piastra, forno o griglia. Evitare fritture e soffritti.",
    "Pasto libero: concentrato nel sabato sera (il pranzo del sabato resta salutare e bilanciato).",
    "Pre-workout: sostituire lo spuntino prima dell'allenamento con 50g pane integrale + 20g marmellata con zucchero.",
  ],

  // 5 settimane cicliche. La "Settimana 5" si applica solo nei mesi indicati dal nutrizionista
  // (vedi impostazioni → "Mesi con 5ª settimana"), altrimenti il ciclo ruota 1→2→3→4.
  settimane: {
    1: [
      { giorno: "Lunedì", colazione: "Latte p.s. 200ml + Fiocchi d'avena 35g (Porridge) + Caffè s.z.", spuntinoMattina: "Mela/Pera 250g", pranzo: "Risotto alla robiola (Riso 70g, Robiola 25g, Grana 5g) + Frittatina (1 uovo) + Zucchine 150g + Olio EVO 12g", spuntinoPomeriggio: "Crackers integrali 30g", cena: "Pollo alla griglia 220g + Pane integrale 50g + Insalata mista + Olio EVO 12g", coccola: "1 quadretto cioccolato fondente 90% (10g)", kcal: 1502 },
      { giorno: "Martedì", colazione: "Kefir 200ml + 3 fette biscottate integrali + Marmellata s.z. 15g", spuntinoMattina: "Arancia/Kiwi 250g", pranzo: "Pasta e lenticchie (Pasta 50g, lenticchie cotte 100g) + Carote al vapore 150g + Olio EVO 12g", spuntinoPomeriggio: "Noci 20g", cena: "Salmone al forno 160g + Zucchine/melanzane grigliate + Olio EVO 12g (NO PANE)", coccola: "1 bicchiere vino rosso (100ml)", kcal: 1483 },
      { giorno: "Mercoledì", colazione: "Albume 100g + 1 uovo strapazzato + Pane integrale 40g + Tè s.z.", spuntinoMattina: "Frutti di bosco 250g", pranzo: "Passato di verdure con orzo 60g + Bocconcini di tacchino 120g + Pomodorini e mais + Olio EVO 12g", spuntinoPomeriggio: "Mela 250g", cena: "Tagliata di manzo magro 220g + Rucola e pomodorini + Olio EVO 12g (NO PANE)", coccola: "Tisana + 1 cucchiaino miele (10g)", kcal: 1441 },
      { giorno: "Giovedì", colazione: "Latte p.s. 200ml + Pane integrale 50g + Marmellata s.z. 15g", spuntinoMattina: "Pesca/Albicocche 250g", pranzo: "Pasta al sugo (Pasta 70g) + Parmigiano a scaglie 15g + Erbette rosolate + Olio EVO 12g", spuntinoPomeriggio: "Crackers integrali 30g", cena: "Omelette (1 uovo + 150g albumi) + Pane integrale 50g + Insalata + Olio EVO 12g", coccola: "1 quadretto cioccolato fondente 90% (10g)", kcal: 1459 },
      { giorno: "Venerdì", colazione: "Kefir 200ml + Fiocchi d'avena 35g + Caffè s.z.", spuntinoMattina: "Pera 250g", pranzo: "Pasta al pesto (Pasta 70g, pesto 15g) + Merluzzo gratinato 120g + Fagiolini + Olio EVO 12g", spuntinoPomeriggio: "Mandorle 20g", cena: "Orata al forno 250g + Pane integrale 50g + Finocchi in insalata + Olio EVO 12g", coccola: "1 bicchiere vino bianco/rosso (100ml)", kcal: 1506 },
      { giorno: "Sabato", colazione: "Pancakes (Avena 35g + Albume 110g) + Miele 10g + Caffè s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Petto di tacchino 180g + Pane integrale 50g + Verdure grigliate + Olio EVO 12g", spuntinoPomeriggio: "Frutta fresca 150g", cena: "Pasto libero gestito — pizza o cena a scelta fuori casa (gestione consapevole)", coccola: "Incluso nel pasto libero", kcal: 1462 },
      { giorno: "Domenica", colazione: "Latte p.s. 200ml + 3 fette biscottate + Marmellata s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Branzino al vapore 280g + Pane integrale 50g + Verdure cotte + Olio EVO 12g", spuntinoPomeriggio: "Frutta fresca 250g", cena: "Burger vegetariano di soia 120g + Pane integrale 50g + Insalata mista + Olio EVO 12g", coccola: "2 noci sgusciate (10g)", kcal: 1444 },
    ],
    2: [
      { giorno: "Lunedì", colazione: "Kefir 200ml + Fiocchi d'avena 35g + Caffè s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Risotto alle zucchine (Riso 70g, Grana 10g) + Uova strapazzate (1 uovo) + Finocchi + Olio EVO 12g", spuntinoPomeriggio: "Crackers integrali 30g", cena: "Petto di tacchino ai ferri 220g + Pane integrale 50g + Zucchine + Olio EVO 12g", coccola: "1 quadretto cioccolato fondente 90% (10g)", kcal: 1497 },
      { giorno: "Martedì", colazione: "Latte p.s. 200ml + 3 fette biscottate + Marmellata s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Pasta e cannellini (Pasta 50g, cannellini cotti 100g) + Fagiolini al vapore + Olio EVO 12g", spuntinoPomeriggio: "Nocciole 20g", cena: "Trancio di tonno grigliato 170g + Insalata mista + Olio EVO 12g (NO PANE)", coccola: "Tisana + 1 cucchiaino miele (10g)", kcal: 1442 },
      { giorno: "Mercoledì", colazione: "Toast con Pane int. 50g + Albume strapazzato 100g + Caffè s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Pasta con ragù di vitellone magro (Pasta 70g, macinato vitellone 60g) + Carote + Olio EVO 12g", spuntinoPomeriggio: "Mela 250g", cena: "Roastbeef magro 220g + Rucola e pomodorini + Olio EVO 12g (NO PANE)", coccola: "1 bicchiere vino rosso (100ml)", kcal: 1472 },
      { giorno: "Giovedì", colazione: "Kefir 200ml + Pane integrale 50g + Marmellata s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Pasta integrale con Olio EVO 12g (Pasta 70g) + Stracchino 80g + Zucchine trifolate", spuntinoPomeriggio: "Crackers integrali 30g", cena: "Frittata al forno (1 uovo + 150g albumi + spinaci) + Pane int. 50g + Olio EVO 12g", coccola: "1 quadretto cioccolato fondente 90% (10g)", kcal: 1462 },
      { giorno: "Venerdì", colazione: "Porridge con Latte p.s. 200ml + Avena 35g", spuntinoMattina: "Frutta fresca 250g", pranzo: "Riso con piselli e carote (Riso 60g, piselli 60g) + Nasello al forno 130g + Pomodori + Olio EVO 12g", spuntinoPomeriggio: "Mandorle 20g", cena: "Spigola al cartoccio 260g + Pane integrale 50g + Verdure al vapore + Olio EVO 12g", coccola: "1 mela cotta con cannella", kcal: 1473 },
      { giorno: "Sabato", colazione: "Omelette dolce (Albume 120g + Avena 30g) + Miele 10g", spuntinoMattina: "Frutta fresca 250g", pranzo: "Bocconcini di pollo alle erbe 180g + Pane integrale 50g + Radicchio ai ferri + Olio EVO 12g", spuntinoPomeriggio: "Frutta fresca 150g", cena: "Pasto libero gestito — pizza o pasto libero a scelta fuori casa (gestione consapevole)", coccola: "Incluso nel pasto libero", kcal: 1497 },
      { giorno: "Domenica", colazione: "Kefir 200ml + 3 fette biscottate + Marmellata s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Platessa alla piastra 280g + Pane integrale 50g + Fagiolini + Olio EVO 12g", spuntinoPomeriggio: "Frutta fresca 250g", cena: "Hummus di ceci 150g (o ceci 200g) + Pane integrale 50g + Carote/cetrioli + Olio EVO 12g", coccola: "5 mandorle sgusciate (10g)", kcal: 1422 },
    ],
    3: [
      { giorno: "Lunedì", colazione: "Latte p.s. 200ml + Avena 35g (Porridge) + Caffè s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Risotto allo zafferano (Riso 70g, Parmigiano 10g) + Frittatina (1 uovo) + Zucchine + Olio EVO 12g", spuntinoPomeriggio: "Crackers integrali 30g", cena: "Pollo al curry leggero 220g + Pane integrale 50g + Verdure saltate + Olio EVO 12g", coccola: "1 quadretto cioccolato fondente 90% (10g)", kcal: 1497 },
      { giorno: "Martedì", colazione: "Kefir 200ml + 3 fette biscottate + Marmellata s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Riso e piselli (Riso 60g, piselli 80g, Parmigiano 10g) + Finocchi in insalata + Olio EVO 12g", spuntinoPomeriggio: "Noci 20g", cena: "Pesce spada alla griglia 160g + Melanzane grigliate + Olio EVO 12g (NO PANE)", coccola: "1 bicchiere vino rosso (100ml)", kcal: 1473 },
      { giorno: "Mercoledì", colazione: "Albume strapazzato 120g + Pane integrale 50g + Caffè s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Cous-cous vegetariano (cous-cous 60g) + Bocconcini di pollo 120g + Carote + Olio EVO 12g", spuntinoPomeriggio: "Pera 250g", cena: "Bistecca di manzo magra 200g + Broccoli al vapore + Olio EVO 12g (NO PANE)", coccola: "Tisana + 1 cucchiaino miele (10g)", kcal: 1426 },
      { giorno: "Giovedì", colazione: "Latte p.s. 200ml + Pane integrale 50g + Marmellata s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Pasta pesto di zucchine (Pasta 70g, pesto 30g) + Robiola 50g + Macedonia di verdure + Olio EVO 12g", spuntinoPomeriggio: "Crackers integrali 30g", cena: "2 uova in camicia su crema di pomodoro + Pane int. 50g + Olio EVO 12g", coccola: "1 quadretto cioccolato fondente 90% (10g)", kcal: 1474 },
      { giorno: "Venerdì", colazione: "Kefir 200ml + Avena 35g + Caffè s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Tortellini di magro con olio EVO 12g (tortellini 70g) + Merluzzo agli aromi 130g + Fagiolini", spuntinoPomeriggio: "Mandorle 20g", cena: "Orata alla piastra 250g + Pane integrale 50g + Zucchine trifolate + Olio EVO 12g", coccola: "1 bicchiere vino bianco (100ml)", kcal: 1501 },
      { giorno: "Sabato", colazione: "Pancake avena & albume + Miele 10g", spuntinoMattina: "Frutta fresca 250g", pranzo: "Platessa alla piastra 280g (o tagliata di tacchino 180g) + Pane integrale 50g + Insalata verde + Olio EVO 12g", spuntinoPomeriggio: "Frutta fresca 150g", cena: "Pasto libero gestito — pizza o pasto libero a scelta fuori casa (gestione consapevole)", coccola: "Incluso nel pasto libero", kcal: 1502 },
      { giorno: "Domenica", colazione: "Latte p.s. 200ml + 3 fette biscottate + Marmellata s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Merluzzo in umido con pomodorini 300g + Pane integrale 50g + Fagiolini al vapore + Olio EVO 12g", spuntinoPomeriggio: "Frutta fresca 250g", cena: "Seitan o tofu alla piastra 110g + Pane integrale 50g + Spinaci/verdure miste + Olio EVO 12g", coccola: "15g Parmigiano a scaglie", kcal: 1435 },
    ],
    4: [
      { giorno: "Lunedì", colazione: "Kefir 200ml + Pane int. 50g con marmellata s.z. 15g + Caffè s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Risotto alla parmigiana (Riso 70g, Parmigiano 15g) + Uova strapazzate(2 uova) + Spinaci 100g + Olio EVO 12g", spuntinoPomeriggio: "Crackers integrali 30g", cena: "Carne bianca (Pollo/Tacchino 250g) + Pane int. 50g + Verdure al vapore 100g + Olio EVO 12g", coccola: "2 quadretti cioccolato fondente 90% (10g)", kcal: 1485 },
      { giorno: "Martedì", colazione: "Latte p.s. 200ml + Fiocchi d'avena 35g + Caffè s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Pasta e ceci (Pasta 60g, ceci secchi 40g / cotti 100g) + Pomodorini in insalata 100g + Olio EVO 12g", spuntinoPomeriggio: "Nocciole 20g", cena: "Pesce grasso (Pesce spada 150g o Salmone fresco 150g) + Zucchine 100g + Olio EVO 12g (NO PANE)", coccola: "1 bicchiere vino rosso/bianco (100ml)", kcal: 1470 },
      { giorno: "Mercoledì", colazione: "1 Uovo + 100g Albume + Pane int. 50g con marmellata s.z", spuntinoMattina: "Frutta fresca 250g", pranzo: "Ditalini e piselli (Ditalini 60g, piselli 50g) + Bocconcini di tacchino 150g + Fagiolini 100g + Olio EVO 12g", spuntinoPomeriggio: "Kiwi 250g", cena: "Carne rossa magra (Tagliata di manzo 250g) + Radicchio alla piastra + Olio EVO 12g (NO PANE)", coccola: "2 quadretti cioccolato fondente 90% (10g)", kcal: 1485 },
      { giorno: "Giovedì", colazione: "Kefir 200ml + 3 Fette biscottate int. con marmellata s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Pasta int. al ragù di verdure (Pasta 70g) + Mozzarella 100g + Carote grattugiate 100g + Olio EVO 12g", spuntinoPomeriggio: "Crackers integrali 30g", cena: "Uova (1 uovo intero + 200g albumi) + Pane int. 50g + Bietole al vapore + Olio EVO 12g", coccola: "1 Tisana rilassante con 1 cucchiaino miele (5g)", kcal: 1460 },
      { giorno: "Venerdì", colazione: "Latte p.s. 200ml + Riso soffiato 30g + Caffè s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Pasta all'olio e parmigiano (Pasta 70g, parmigiano 15g) + Orata al forno 200g + Zucchine trifolate 100g + Olio EVO 12g", spuntinoPomeriggio: "Mandorle 20g", cena: "Pesce magro (Branzino o Orata al forno 250g) + Pane int. 50g + Insalata mista + Olio EVO 12g", coccola: "2 quadretti cioccolato fondente 90% (10g)", kcal: 1480 },
      { giorno: "Sabato", colazione: "Kefir 200ml + Pane int. 50g con marmellata s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Fesa di tacchino piastrata 250g (o pesce magro) + Pane int. 50g + Insalata 100g + Olio EVO 12g", spuntinoPomeriggio: "Frutta secca 20g", cena: "Pasto libero gestito — pizza o pasto libero a scelta fuori casa (gestione consapevole)", coccola: "Incluso nel pasto libero", kcal: 1500 },
      { giorno: "Domenica", colazione: "Latte p.s. 200ml + Fiocchi d'avena 35g", spuntinoMattina: "Frutta fresca 250g", pranzo: "Pesce magro (Orata o Trota al forno 300g) + Pane int. 50g + Pomodori in insalata 100g + Olio EVO 12g", spuntinoPomeriggio: "Frutta fresca 250g", cena: "Prodotto vegetariano (Hamburger veg 120g / Tofu 125g / Lenticchie 200g) + Pane int. 50g + Zucchine + Olio EVO 12g", coccola: "3 noci sgusciate (10g)", kcal: 1440 },
    ],
    5: [
      { giorno: "Lunedì", colazione: "Kefir 200ml + Pane int. 50g con marmellata s.z. 15g + Caffè s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Riso alla cantonese (Riso 70g, piselli 30g, 1 uovo, prosciutto cotto 20g) + Finocchi in insalata 100g + Olio EVO 12g", spuntinoPomeriggio: "Crackers integrali 30g", cena: "Carne bianca — pollo/tacchino 250g + Pane int. 50g + Verdure al vapore 100g + Olio EVO 12g", coccola: "2 quadretti cioccolato fondente ≥90% (10g)", kcal: 1490 },
      { giorno: "Martedì", colazione: "Latte p.s. 200ml + Fiocchi d'avena 35g + Caffè s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Pasta e lenticchie (Pasta 60g, lenticchie secche 40g/cotte 100g) + Spinaci al vapore 100g + Olio EVO 12g", spuntinoPomeriggio: "Frutta secca 20g (noci/mandorle)", cena: "Pesce grasso — salmone o tonno fresco 150g + Zucchine trifolate 100g + Olio EVO 12g (NO PANE)", coccola: "1 bicchiere vino rosso/bianco (100ml)", kcal: 1460 },
      { giorno: "Mercoledì", colazione: "1 uovo + 100g albume + Pane int. 50g con marmellata s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Vellutata di carote con ditalini (ditalini 60g) + Vitello agli aromi 150g + Zucchine 100g + Olio EVO 12g", spuntinoPomeriggio: "Pera/Mela 250g", cena: "Carne rossa magra — bovino/manzo/roastbeef 250g + Radicchio alla piastra + Olio EVO 12g (NO PANE)", coccola: "2 quadretti cioccolato fondente ≥90% (10g)", kcal: 1475 },
      { giorno: "Giovedì", colazione: "Kefir 200ml + 3 fette biscottate int. con marmellata s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Gnocchetti sardi timo e zafferano (gnocchetti 70g) + Ricotta magra 100g + Carote al vapore + Olio EVO 12g", spuntinoPomeriggio: "Crackers integrali 30g", cena: "Uova (1 uovo intero + 200g albumi) + Pane int. 50g + Bietole al vapore + Olio EVO 12g", coccola: "1 tisana rilassante con 1 cucchiaino miele (5g)", kcal: 1455 },
      { giorno: "Venerdì", colazione: "Latte p.s. 200ml + Riso soffiato 30g + Caffè s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Tortino di patate e fagiolini (patate 150g, fagiolini 100g, parmigiano 15g) + Nasello croccante 200g + Verdure + Olio EVO 12g", spuntinoPomeriggio: "Mandorle 20g", cena: "Pesce magro — orata o branzino al forno 250g + Pane int. 50g + Insalata mista + Olio EVO 12g", coccola: "2 quadretti cioccolato fondente ≥90% (10g)", kcal: 1480 },
      { giorno: "Sabato", colazione: "Kefir 200ml + Pane int. 50g con marmellata s.z.", spuntinoMattina: "Frutta fresca 250g", pranzo: "Pranzo salutare: merluzzo o platessa alla piastra 300g + Pane int. 50g + Insalata mista 100g + Olio EVO 12g", spuntinoPomeriggio: "Frutta secca 20g", cena: "Pasto libero gestito — pizza o pasto libero a scelta fuori casa (gestione consapevole)", coccola: "Incluso nel pasto libero", kcal: 1500 },
      { giorno: "Domenica", colazione: "Latte p.s. 200ml + Fiocchi d'avena 35g", spuntinoMattina: "Frutta fresca 250g", pranzo: "Pesce magro — branzino o orata 300g + Pane int. 50g + Pomodori in insalata 100g + Olio EVO 12g", spuntinoPomeriggio: "Frutta fresca 250g", cena: "Prodotto vegetariano — hamburger veg 120g / tofu 125g / lenticchie 200g + Pane int. 50g + Zucchine + Olio EVO 12g", coccola: "3 noci sgusciate (10g)", kcal: 1435 },
    ],
  },
};

// In ambiente browser esponiamo l'oggetto globalmente.
if (typeof window !== "undefined") window.PIANO = PIANO;
// In ambiente Node (usato dallo script delle notifiche in GitHub Actions) lo esportiamo come modulo.
if (typeof module !== "undefined") module.exports = PIANO;
