/**
 * alimenti.js
 * Catalogo degli alimenti e "motore" che trasforma il testo libero dei pasti
 * in una lista della spesa pulita: una voce per alimento, al plurale, senza
 * quantità, divisa per categorie di negozio (sul modello di Bring!).
 *
 * Come funziona, in breve:
 *  1. il testo di un pasto viene normalizzato (minuscole, niente accenti,
 *     abbreviazioni espanse: "p.s." → parzialmente scremato, "int." →
 *     integrale, "s.z." → senza zuccheri);
 *  2. ogni parola viene ridotta alla sua "radice" (zucchina/zucchine →
 *     zucchin), così singolare e plurale coincidono;
 *  3. il testo viene scandito cercando le voci del catalogo, prima le più
 *     lunghe ("prosciutto crudo" prima di "prosciutto", "pesce spada" prima
 *     di "pesce"): tutto ciò che non è un alimento (metodi di cottura, nomi
 *     dei piatti, quantità) viene semplicemente ignorato;
 *  4. le voci generiche ("frutta fresca", "verdure", "carne bianca") vengono
 *     scartate se nello stesso pezzo di pasto c'è già un alimento preciso
 *     della stessa categoria; una variante ("pasta integrale") prevale sulla
 *     voce base ("pasta") nello stesso pezzo;
 *  5. se un pezzo di pasto non contiene nessun alimento noto, il testo
 *     ripulito finisce comunque in lista, nella categoria "Altro".
 *
 * Per aggiungere un alimento basta una riga nel CATALOGO qui sotto.
 * Doppio export (window / module.exports), come data.js e week-logic.js.
 */
(function () {
  "use strict";

  // Ordine = percorso tipico tra gli scaffali (come le categorie di Bring!).
  const CATEGORIE = [
    { id: "frutta-verdura", nome: "Frutta & Verdura", icona: "🥦" },
    { id: "panetteria", nome: "Panetteria", icona: "🍞" },
    { id: "latte-formaggi", nome: "Latte & Formaggi", icona: "🧀" },
    { id: "carne-pesce", nome: "Carne & Pesce", icona: "🥩" },
    { id: "ingredienti-spezie", nome: "Ingredienti & Spezie", icona: "🧂" },
    { id: "pronti-surgelati", nome: "Piatti Pronti & Surgelati", icona: "🧊" },
    { id: "pasta-riso-cereali", nome: "Pasta, Riso & Cereali", icona: "🍝" },
    { id: "snack-dolci", nome: "Snack & Dolci", icona: "🍫" },
    { id: "bevande", nome: "Bevande", icona: "🥤" },
    { id: "casa", nome: "Casa", icona: "🏠" },
    { id: "bellezza-igiene", nome: "Bellezza & Igiene", icona: "🧴" },
    { id: "animali", nome: "Animali", icona: "🐾" },
    { id: "altro", nome: "Altro", icona: "🛒" },
  ];

  // [nome in lista, categoria, icona, "chiavi separate da |", opzioni]
  // opzioni: { g: 1 } = voce generica; { b: "Nome base" } = variante di una voce base.
  // Le chiavi si scrivono in minuscolo; singolare/plurale vengono riconosciuti
  // da soli per le parole di almeno 5 lettere (per quelle corte scriverli entrambi).
  const FV = "frutta-verdura", PAN = "panetteria", LF = "latte-formaggi", CP = "carne-pesce",
    IS = "ingredienti-spezie", PS = "pronti-surgelati", PRC = "pasta-riso-cereali",
    SD = "snack-dolci", BEV = "bevande", CASA = "casa", BI = "bellezza-igiene", ANI = "animali";

  const CATALOGO = [
    // ---------- Frutta ----------
    ["Frutta fresca", FV, "🍇", "frutta|frutta fresca|frutta di stagione|frutto", { g: 1 }],
    ["Mele", FV, "🍎", "mela|mele|mela cotta"],
    ["Pere", FV, "🍐", "pera|pere"],
    ["Arance", FV, "🍊", "arancia|arance|spremuta"],
    ["Mandarini", FV, "🍊", "mandarino|mandarini|clementina|clementine"],
    ["Limoni", FV, "🍋", "limone|limoni|succo di limone"],
    ["Banane", FV, "🍌", "banana|banane"],
    ["Kiwi", FV, "🥝", "kiwi"],
    ["Pesche", FV, "🍑", "pesca|pesche|pesche noci|pescanoce"],
    ["Albicocche", FV, "🍑", "albicocca|albicocche"],
    ["Prugne", FV, "🫐", "prugna|prugne|susina|susine"],
    ["Frutti di bosco", FV, "🫐", "frutti di bosco|mirtilli|mirtillo|lamponi|lampone|more di rovo"],
    ["Fragole", FV, "🍓", "fragola|fragole"],
    ["Ciliegie", FV, "🍒", "ciliegia|ciliegie"],
    ["Uva", FV, "🍇", "uva"],
    ["Ananas", FV, "🍍", "ananas"],
    ["Melone", FV, "🍈", "melone|meloni"],
    ["Anguria", FV, "🍉", "anguria|cocomero"],
    ["Fichi", FV, "🍐", "fico|fichi"],
    ["Cachi", FV, "🍅", "caco|cachi|kaki"],
    ["Mango", FV, "🥭", "mango"],
    ["Melagrana", FV, "🍎", "melagrana|melograno"],
    ["Avocado", FV, "🥑", "avocado"],
    // ---------- Verdura ----------
    ["Verdure di stagione", FV, "🥗", "verdura|verdure|verdure miste|ortaggi|minestrone di verdure|passato di verdure|macedonia di verdure|ragu di verdure", { g: 1 }],
    ["Zucchine", FV, "🥒", "zucchina|zucchine|zucchino|zucchini"],
    ["Melanzane", FV, "🍆", "melanzana|melanzane"],
    ["Carote", FV, "🥕", "carota|carote"],
    ["Finocchi", FV, "🌿", "finocchio|finocchi"],
    ["Pomodori", FV, "🍅", "pomodoro|pomodori|pomodori ramati|cuore di bue"],
    ["Pomodorini", FV, "🍅", "pomodorino|pomodorini|pachino|datterini|ciliegini"],
    ["Insalata", FV, "🥬", "insalata|insalata mista|insalata verde|lattuga|iceberg|misticanza|gentilina|trocadero"],
    ["Rucola", FV, "🌿", "rucola"],
    ["Valeriana", FV, "🌿", "valeriana|songino"],
    ["Radicchio", FV, "🥬", "radicchio|trevisana|trevisano"],
    ["Spinaci", FV, "🥬", "spinacio|spinaci|spinacino|spinacini"],
    ["Bietole", FV, "🥬", "bietola|bietole|biete|erbette|coste"],
    ["Broccoli", FV, "🥦", "broccolo|broccoli"],
    ["Cavolfiore", FV, "🥦", "cavolfiore|cavolfiori"],
    ["Cavoli", FV, "🥬", "cavolo|cavoli|cavolo nero|cavolo cappuccio|verza|cappuccio"],
    ["Cavolini di Bruxelles", FV, "🥬", "cavolini|cavolini di bruxelles"],
    ["Cime di rapa", FV, "🥬", "cime di rapa|friarielli"],
    ["Peperoni", FV, "🫑", "peperone|peperoni"],
    ["Cetrioli", FV, "🥒", "cetriolo|cetrioli"],
    ["Fagiolini", FV, "🌱", "fagiolino|fagiolini|cornetti"],
    ["Asparagi", FV, "🌱", "asparago|asparagi"],
    ["Carciofi", FV, "🌱", "carciofo|carciofi"],
    ["Funghi", FV, "🍄", "fungo|funghi|champignon|porcini"],
    ["Zucca", FV, "🎃", "zucca|zucche"],
    ["Patate", FV, "🥔", "patata|patate"],
    ["Patate dolci", FV, "🍠", "patata dolce|patate dolci|patata americana|patate americane"],
    ["Cipolle", FV, "🧅", "cipolla|cipolle|cipollotto|cipollotti|scalogno"],
    ["Aglio", FV, "🧄", "aglio"],
    ["Sedano", FV, "🌿", "sedano|sedano rapa"],
    ["Porri", FV, "🌿", "porro|porri"],
    ["Ravanelli", FV, "🌱", "ravanello|ravanelli"],
    ["Germogli", FV, "🌱", "germogli|germogli di soia"],
    ["Erbe aromatiche", FV, "🌿", "erbe aromatiche|basilico|prezzemolo|rosmarino|salvia|timo|menta|erba cipollina|aneto|maggiorana"],
    ["Zenzero", FV, "🫚", "zenzero"],

    // ---------- Panetteria ----------
    ["Pane", PAN, "🍞", "pane|pagnotta|pane comune|pane casereccio|pane di semola|panino|panini"],
    ["Pane integrale", PAN, "🍞", "pane integrale|pane di segale|pane ai cereali|pane multicereali", { b: "Pane" }],
    ["Pane in cassetta", PAN, "🍞", "pane in cassetta|pancarre|pan carre|pane per toast"],
    ["Fette biscottate", PAN, "🥯", "fette biscottate|fetta biscottata"],
    ["Fette biscottate integrali", PAN, "🥯", "fette biscottate integrali|fetta biscottata integrale", { b: "Fette biscottate" }],
    ["Crackers", PAN, "🍘", "cracker|crackers"],
    ["Crackers integrali", PAN, "🍘", "cracker integrali|crackers integrali|cracker integrale", { b: "Crackers" }],
    ["Gallette", PAN, "🍘", "galletta|gallette|gallette di riso|gallette di mais"],
    ["Grissini", PAN, "🥖", "grissino|grissini"],
    ["Piadine", PAN, "🫓", "piadina|piadine|wrap|tortilla|tortillas"],
    ["Friselle", PAN, "🥖", "frisella|friselle"],

    // ---------- Latte & Formaggi (e uova) ----------
    ["Latte", LF, "🥛", "latte|latte intero"],
    ["Latte parzialmente scremato", LF, "🥛", "latte parzialmente scremato|latte ps", { b: "Latte" }],
    ["Latte scremato", LF, "🥛", "latte scremato", { b: "Latte" }],
    ["Latte senza lattosio", LF, "🥛", "latte senza lattosio|latte delattosato|latte zymil", { b: "Latte" }],
    ["Bevanda vegetale", LF, "🥛", "latte di soia|latte di mandorla|latte di avena|latte di riso|bevanda vegetale|bevanda di soia|bevanda di avena|bevanda di mandorla|bevanda di riso"],
    ["Kefir", LF, "🥛", "kefir"],
    ["Yogurt", LF, "🥛", "yogurt|yoghurt|yogurt bianco|yogurt magro|yogurt naturale"],
    ["Yogurt greco", LF, "🥛", "yogurt greco|skyr", { b: "Yogurt" }],
    ["Uova", LF, "🥚", "uovo|uova|tuorlo|tuorli"],
    ["Albumi", LF, "🥚", "albume|albumi|albume d uovo"],
    ["Parmigiano", LF, "🧀", "parmigiano|parmigiano reggiano|parmigiana"],
    ["Grana Padano", LF, "🧀", "grana|grana padano"],
    ["Pecorino", LF, "🧀", "pecorino"],
    ["Mozzarella", LF, "🧀", "mozzarella|mozzarelle|fiordilatte|fior di latte|bocconcini di mozzarella"],
    ["Ricotta", LF, "🧀", "ricotta|ricotta magra"],
    ["Robiola", LF, "🧀", "robiola"],
    ["Stracchino", LF, "🧀", "stracchino|crescenza"],
    ["Fiocchi di latte", LF, "🧀", "fiocchi di latte|cottage cheese|cottage"],
    ["Feta", LF, "🧀", "feta"],
    ["Scamorza", LF, "🧀", "scamorza|provola"],
    ["Formaggio spalmabile", LF, "🧀", "formaggio spalmabile|philadelphia|quark"],
    ["Formaggi", LF, "🧀", "formaggio|formaggi|formaggio stagionato|formaggio fresco|emmental|asiago|fontina|caciotta", { g: 1 }],
    ["Burro", LF, "🧈", "burro"],
    ["Panna", LF, "🥛", "panna|panna da cucina"],

    // ---------- Carne & Pesce (e salumi) ----------
    ["Carne", CP, "🥩", "carne|carne bianca|carne rossa|carne magra", { g: 1 }],
    ["Pollo", CP, "🍗", "pollo|petto di pollo|fusi di pollo|sovracosce|cosce di pollo"],
    ["Tacchino", CP, "🦃", "tacchino|fesa di tacchino|petto di tacchino"],
    ["Manzo", CP, "🥩", "manzo|bovino|vitellone|tagliata di manzo|bistecca|filetto di manzo|scamone|girello|fettine di manzo|carpaccio"],
    ["Roastbeef", CP, "🥩", "roastbeef|roast beef|rosbif"],
    ["Macinato magro", CP, "🥩", "macinato|carne macinata|macinato vitellone|ragu di vitellone|ragu di carne|ragu"],
    ["Vitello", CP, "🥩", "vitello|fesa di vitello|scaloppine"],
    ["Maiale", CP, "🥩", "maiale|lonza|arista|filetto di maiale"],
    ["Coniglio", CP, "🍗", "coniglio"],
    ["Agnello", CP, "🥩", "agnello"],
    ["Prosciutto crudo", CP, "🥓", "prosciutto crudo|prosciutto"],
    ["Prosciutto cotto", CP, "🥓", "prosciutto cotto"],
    ["Bresaola", CP, "🥓", "bresaola"],
    ["Fesa di tacchino affettata", CP, "🥓", "fesa di tacchino affettata|tacchino affettato|affettato di tacchino"],
    ["Speck", CP, "🥓", "speck"],
    ["Pesce", CP, "🐟", "pesce|pesce magro|pesce grasso|pesce azzurro|filetti di pesce", { g: 1 }],
    ["Salmone", CP, "🐟", "salmone|salmone fresco|trancio di salmone"],
    ["Salmone affumicato", CP, "🐟", "salmone affumicato"],
    ["Tonno fresco", CP, "🐟", "tonno|tonno fresco|trancio di tonno"],
    ["Pesce spada", CP, "🐟", "pesce spada|spada"],
    ["Merluzzo", CP, "🐟", "merluzzo|filetti di merluzzo|baccala|stoccafisso"],
    ["Nasello", CP, "🐟", "nasello"],
    ["Orata", CP, "🐟", "orata|orate"],
    ["Branzino", CP, "🐟", "branzino|branzini|spigola|spigole"],
    ["Platessa", CP, "🐟", "platessa"],
    ["Sogliola", CP, "🐟", "sogliola|sogliole"],
    ["Trota", CP, "🐟", "trota|trote"],
    ["Sgombro", CP, "🐟", "sgombro|sgombri"],
    ["Alici", CP, "🐟", "alice|alici|acciuga|acciughe|sardina|sardine"],
    ["Rombo", CP, "🐟", "rombo"],
    ["Dentice", CP, "🐟", "dentice"],
    ["Gamberi", CP, "🦐", "gambero|gamberi|gamberetti|mazzancolle"],
    ["Calamari", CP, "🦑", "calamaro|calamari|totani|seppia|seppie"],
    ["Polpo", CP, "🐙", "polpo|moscardini"],
    ["Cozze e vongole", CP, "🦪", "cozze|cozza|vongole|vongola|frutti di mare"],

    // ---------- Ingredienti & Spezie ----------
    ["Olio extravergine d'oliva", IS, "🫒", "olio|olio evo|olio extravergine|olio extravergine d oliva|olio d oliva|evo"],
    ["Aceto", IS, "🍶", "aceto|aceto di vino"],
    ["Aceto di mele", IS, "🍶", "aceto di mele"],
    ["Aceto balsamico", IS, "🍶", "aceto balsamico|balsamico|glassa balsamica"],
    ["Sale", IS, "🧂", "sale|sale iodato|sale fino|sale grosso"],
    ["Pepe", IS, "🧂", "pepe|pepe nero"],
    ["Spezie", IS, "🧂", "spezie|paprika|curcuma|noce moscata|peperoncino|cumino|chiodi di garofano|mix di spezie", { g: 1 }],
    ["Origano", IS, "🌿", "origano"],
    ["Curry", IS, "🍛", "curry"],
    ["Zafferano", IS, "🌼", "zafferano"],
    ["Cannella", IS, "🧂", "cannella"],
    ["Passata di pomodoro", IS, "🥫", "passata|passata di pomodoro|salsa di pomodoro|sugo|sugo di pomodoro|crema di pomodoro|polpa di pomodoro|pelati|pomodori pelati"],
    ["Pesto", IS, "🌿", "pesto|pesto alla genovese"],
    ["Tonno in scatola", IS, "🥫", "tonno in scatola|tonno al naturale|tonno sott olio|tonno in vetro"],
    ["Mais", IS, "🌽", "mais|granella di mais"],
    ["Olive", IS, "🫒", "oliva|olive"],
    ["Capperi", IS, "🫙", "cappero|capperi"],
    ["Senape", IS, "🫙", "senape"],
    ["Salsa di soia", IS, "🫙", "salsa di soia|soia sauce|tamari"],
    ["Dado vegetale", IS, "🥣", "dado|dado vegetale|brodo vegetale|brodo|granulare"],
    ["Farina", IS, "🌾", "farina|farina integrale|farina di avena|farina di riso|amido di mais|maizena"],
    ["Lievito", IS, "🌾", "lievito|lievito per dolci|lievito di birra"],
    ["Zucchero", IS, "🧂", "zucchero|zucchero di canna"],
    ["Dolcificante", IS, "🧂", "dolcificante|stevia|eritritolo"],
    ["Cacao amaro", IS, "🍫", "cacao|cacao amaro"],

    // ---------- Piatti Pronti & Surgelati ----------
    ["Piselli", PS, "🫛", "pisello|piselli|pisellini"],
    ["Verdure surgelate", PS, "🧊", "verdure surgelate|minestrone surgelato|misto surgelato"],
    ["Burger vegetali", PS, "🍔", "burger vegetariano|burger vegetale|burger veg|burger di soia|hamburger veg|hamburger vegetariano|hamburger vegetale|polpette vegetali"],
    ["Tofu", PS, "🧈", "tofu"],
    ["Seitan", PS, "🥩", "seitan"],
    ["Tempeh", PS, "🥩", "tempeh"],
    ["Hummus", PS, "🧆", "hummus"],
    ["Bastoncini di pesce", PS, "🐟", "bastoncini di pesce|bastoncini"],
    ["Pizza surgelata", PS, "🍕", "pizza surgelata"],

    // ---------- Pasta, Riso & Cereali (e legumi) ----------
    ["Pasta", PRC, "🍝", "pasta|spaghetti|penne|fusilli|rigatoni|farfalle|linguine|ditalini|ditali|mezze maniche|tagliatelle|orecchiette|gnocchetti sardi|gnocchetti|conchiglie|paccheri|trofie|pennette|mafalde|pastina|sedanini|tubetti"],
    ["Pasta integrale", PRC, "🍝", "pasta integrale|spaghetti integrali|penne integrali|fusilli integrali", { b: "Pasta" }],
    ["Pasta di legumi", PRC, "🍝", "pasta di legumi|pasta di lenticchie|pasta di ceci|pasta di piselli", { b: "Pasta" }],
    ["Tortellini", PRC, "🥟", "tortellini|tortelloni|ravioli|pasta ripiena|tortellini di magro"],
    ["Gnocchi di patate", PRC, "🥟", "gnocchi|gnocchi di patate"],
    ["Riso", PRC, "🍚", "riso|riso basmati|riso carnaroli|riso arborio|riso parboiled|riso venere|risotto|riso rosso"],
    ["Riso integrale", PRC, "🍚", "riso integrale", { b: "Riso" }],
    ["Riso soffiato", PRC, "🍚", "riso soffiato"],
    ["Cous cous", PRC, "🍚", "cous cous|couscous|cuscus"],
    ["Orzo", PRC, "🌾", "orzo|orzo perlato"],
    ["Farro", PRC, "🌾", "farro"],
    ["Quinoa", PRC, "🌾", "quinoa"],
    ["Grano saraceno", PRC, "🌾", "grano saraceno"],
    ["Bulgur", PRC, "🌾", "bulgur"],
    ["Miglio", PRC, "🌾", "miglio"],
    ["Polenta", PRC, "🌽", "polenta|farina di mais"],
    ["Fiocchi d'avena", PRC, "🌾", "fiocchi d avena|avena|porridge|fiocchi di avena"],
    ["Cereali per la colazione", PRC, "🥣", "cereali|corn flakes|muesli|granola|cereali integrali"],
    ["Lenticchie", PRC, "🫘", "lenticchia|lenticchie|lenticchie rosse|lenticchie decorticate"],
    ["Ceci", PRC, "🫘", "cece|ceci"],
    ["Fagioli", PRC, "🫘", "fagiolo|fagioli|fagioli borlotti|borlotti|fagioli neri"],
    ["Fagioli cannellini", PRC, "🫘", "cannellini|fagioli cannellini", { b: "Fagioli" }],
    ["Fave", PRC, "🫘", "fava|fave"],
    ["Edamame", PRC, "🫘", "edamame"],
    ["Legumi misti", PRC, "🫘", "legumi|legumi misti", { g: 1 }],

    // ---------- Snack & Dolci (e frutta secca) ----------
    ["Frutta secca", SD, "🌰", "frutta secca|frutta secca mista|frutta a guscio", { g: 1 }],
    ["Noci", SD, "🌰", "noce|noci|gherigli"],
    ["Mandorle", SD, "🌰", "mandorla|mandorle|granella di mandorle"],
    ["Nocciole", SD, "🌰", "nocciola|nocciole"],
    ["Pistacchi", SD, "🥜", "pistacchio|pistacchi"],
    ["Anacardi", SD, "🥜", "anacardo|anacardi"],
    ["Arachidi", SD, "🥜", "arachide|arachidi|noccioline"],
    ["Burro d'arachidi", SD, "🥜", "burro d arachidi|burro di arachidi|crema di arachidi|crema di frutta secca|crema di mandorle"],
    ["Semi oleosi", SD, "🌻", "semi|semi di chia|chia|semi di lino|semi di zucca|semi di girasole|semi misti|sesamo"],
    ["Frutta essiccata", SD, "🍑", "frutta essiccata|uvetta|datteri|dattero|albicocche secche|prugne secche|fichi secchi"],
    ["Cioccolato fondente", SD, "🍫", "cioccolato|cioccolato fondente|fondente|cioccolata"],
    ["Miele", SD, "🍯", "miele"],
    ["Marmellata", SD, "🍯", "marmellata|confettura|composta di frutta|marmellate"],
    ["Marmellata senza zuccheri", SD, "🍯", "marmellata sz|confettura sz|composta sz|marmellata extra sz", { b: "Marmellata" }],
    ["Biscotti", SD, "🍪", "biscotto|biscotti|frollini"],
    ["Barrette", SD, "🍫", "barretta|barrette|barretta proteica|barrette proteiche"],
    ["Popcorn", SD, "🍿", "popcorn|pop corn"],
    ["Patatine", SD, "🥔", "patatine|chips|patatine fritte"],
    ["Gelato", PS, "🍨", "gelato|gelati|ghiacciolo|ghiaccioli"],

    // ---------- Bevande ----------
    ["Acqua", BEV, "💧", "acqua|acqua naturale|acqua frizzante|acqua minerale"],
    ["Caffè", BEV, "☕", "caffe|caffe espresso|caffe d orzo|espresso|caffe americano"],
    ["Tè", BEV, "🍵", "te|the|te verde|te nero|the verde"],
    ["Tisane", BEV, "🫖", "tisana|tisane|infuso|infusi|camomilla"],
    ["Vino", BEV, "🍷", "vino|vino rosso|vino bianco|bollicine|prosecco"],
    ["Birra", BEV, "🍺", "birra|birre"],
    ["Succhi di frutta", BEV, "🧃", "succo|succhi|succo di frutta|centrifuga|estratto"],
    ["Bevanda proteica", BEV, "🥤", "proteine in polvere|whey|proteine whey|shake proteico|frullato proteico"],

    // ---------- Casa ----------
    ["Detersivo piatti", CASA, "🧽", "detersivo piatti|detersivo per piatti|pastiglie lavastoviglie|lavastoviglie"],
    ["Detersivo bucato", CASA, "🧺", "detersivo|detersivo lavatrice|ammorbidente"],
    ["Carta da cucina", CASA, "🧻", "carta da cucina|scottex|tovaglioli|tovaglioli di carta"],
    ["Pellicola e alluminio", CASA, "🧻", "pellicola|carta alluminio|alluminio|carta forno|carta da forno"],
    ["Sacchetti gelo", CASA, "🛍️", "sacchetti gelo|sacchetti freezer|sacchetti per alimenti|sacchetti"],
    ["Contenitori per alimenti", CASA, "🥡", "contenitori|contenitore|contenitori per alimenti|vaschette|schiscetta"],
    ["Spugne", CASA, "🧽", "spugna|spugne"],
    ["Sacchi spazzatura", CASA, "🗑️", "sacchi spazzatura|sacchetti spazzatura|sacchi immondizia"],
    ["Pulizia casa", CASA, "🧴", "sgrassatore|candeggina|anticalcare|detergente|detergente pavimenti"],

    // ---------- Bellezza & Igiene ----------
    ["Carta igienica", BI, "🧻", "carta igienica"],
    ["Dentifricio", BI, "🪥", "dentifricio|spazzolino|filo interdentale"],
    ["Sapone", BI, "🧼", "sapone|bagnoschiuma|docciaschiuma|sapone liquido"],
    ["Shampoo", BI, "🧴", "shampoo|balsamo per capelli"],
    ["Deodorante", BI, "🧴", "deodorante"],
    ["Crema", BI, "🧴", "crema viso|crema corpo|crema solare|crema mani"],
    ["Fazzoletti", BI, "🤧", "fazzoletti|fazzoletti di carta|kleenex"],

    // ---------- Animali ----------
    ["Cibo per cani", ANI, "🐕", "cibo per cani|crocchette per cani|scatolette per cani"],
    ["Cibo per gatti", ANI, "🐈", "cibo per gatti|crocchette per gatti|scatolette per gatti|crocchette|scatolette"],
    ["Lettiera", ANI, "🐾", "lettiera|sabbietta"],
  ];

  // Radici forzate per evitare collisioni tra parole con la stessa radice
  // (pesce ≠ pesca, pasto ≠ pasta, cotto ≠ cotta).
  const RADICI_FORZATE = {
    pesce: "pesce#", pesci: "pesce#",
    pasto: "pasto#", pasti: "pasto#",
    cotto: "cotto#", cotti: "cotto#", cotta: "cotta#", cotte: "cotta#",
    crudo: "crudo#", crudi: "crudo#", cruda: "cruda#", crude: "cruda#",
    greco: "greco#", greca: "greca#",
    semi: "semi#", seme: "semi#",
    spada: "spada#",
    tagliata: "tagliata#", tagliato: "tagliato#",
  };

  // Parole da scartare quando un pezzo di pasto NON contiene alimenti noti
  // e va in lista così com'è (categoria "Altro").
  const PAROLE_VUOTE = new Set((
    "g gr kg ml l cl mg porzione porzioni pz pezzo pezzi fetta fette cucchiaio cucchiai cucchiaino cucchiaini " +
    "bicchiere bicchieri tazza tazzina vasetto vasetti confezione quadretto quadretti manciata spicchio spicchi " +
    "al alla alle allo ai agli all con di da del della dei degli delle in su e o ed oppure per a il lo la i gli le un una uno " +
    "cotto cotti cotta cotte crudo cruda crudi crude grigliato grigliata grigliati grigliate griglia piastra ferri " +
    "vapore forno lessato lessata lessati lessate bollito bollita saltato saltata saltati saltate trifolato trifolate " +
    "rosolato rosolate gratinato gratinata cartoccio umido brasato stufato stufate arrosto arrostite ripassato ripassate " +
    "fresco fresca freschi fresche magro magra magri magre leggero leggera light sgusciato sgusciate sgusciati " +
    "a scaglie grattugiato grattugiata grattugiate tritato tritata sminuzzato scelta sua tua libera libero gestito gestione " +
    "consapevole incluso inclusa circa max massimo minimo q b qb sz sera pranzo cena colazione spuntino"
  ).split(" "));

  // ---------------------------------------------------------------------
  // Normalizzazione e radici
  // ---------------------------------------------------------------------
  function normalizza(testo) {
    let s = String(testo || "");
    // "NO PANE", "NO PASTA" scritti in maiuscolo nel menu: sono divieti, non acquisti.
    s = s.replace(/\bNO\s+[A-ZÀ-Ü][A-ZÀ-Ü' ]*\b/g, " ");
    s = s.toLowerCase().replace(/[’`´]/g, "'");
    s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    s = s
      .replace(/\bp\.\s?s\.?/g, " parzialmente scremato ")
      .replace(/\bs\.\s?z\.?/g, " sz ")
      .replace(/\bsenza\s+zuccher[oi](\s+aggiunt[oi])?/g, " sz ")
      .replace(/\bsenza\s+lattosio/g, " delattosato ")
      .replace(/\bint\b\.?/g, " integrale ")
      .replace(/\bintegral[ei]\b/g, " integrale ")
      .replace(/\bin insalata\b/g, " ")
      .replace(/\b(senza|no)\s+[a-z]+/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return s;
  }

  function radice(parola) {
    if (RADICI_FORZATE[parola]) return RADICI_FORZATE[parola];
    if (parola.length <= 4) return parola;
    let r = parola.replace(/[aeiou]+$/, "");
    if (/[cg]h$/.test(r)) r = r.slice(0, -1);
    return r.length < 4 ? parola : r;
  }

  function radici(testoNormalizzato) {
    return testoNormalizzato ? testoNormalizzato.split(" ").map(radice) : [];
  }

  function distanza(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    const m = a.length, n = b.length;
    let prec = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prec[j] + 1, cur[j - 1] + 1, prec[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prec = cur;
    }
    return prec[n];
  }

  // ---------------------------------------------------------------------
  // Indice del catalogo
  // ---------------------------------------------------------------------
  const VOCI = CATALOGO.map(([nome, cat, icona, chiavi, opz], i) => ({
    id: "c" + i,
    chiave: "c:" + normalizza(nome).replace(/ /g, "-"),
    nome, cat, icona,
    generica: !!(opz && opz.g),
    base: (opz && opz.b) || null,
    chiavi: chiavi.split("|").map((k) => radici(normalizza(k))).filter((k) => k.length),
  }));
  const VOCE_PER_NOME = new Map(VOCI.map((v) => [v.nome, v]));
  const VOCE_PER_CHIAVE = new Map(VOCI.map((v) => [v.chiave, v]));

  // indice: prima radice → [{voce, radici}] ordinati dalla chiave più lunga
  const INDICE = new Map();
  const CHIAVI_SINGOLE = []; // per la tolleranza agli errori di battitura
  VOCI.forEach((voce) => {
    voce.chiavi.forEach((k) => {
      if (!INDICE.has(k[0])) INDICE.set(k[0], []);
      INDICE.get(k[0]).push({ voce, radici: k });
      if (k.length === 1 && k[0].length >= 5 && !k[0].endsWith("#")) CHIAVI_SINGOLE.push({ voce, radice: k[0] });
    });
  });
  INDICE.forEach((lista) => lista.sort((a, b) => b.radici.length - a.radici.length));

  /** Trova le voci del catalogo presenti in un testo (già un singolo "pezzo" di pasto). */
  function trovaVoci(testo) {
    const norm = normalizza(testo);
    const r = radici(norm);
    const trovate = [];
    let i = 0;
    while (i < r.length) {
      const candidati = INDICE.get(r[i]) || [];
      let presa = null;
      for (const c of candidati) {
        if (c.radici.every((x, j) => r[i + j] === x)) { presa = c; break; }
      }
      if (presa) {
        trovate.push(presa.voce);
        i += presa.radici.length;
        continue;
      }
      // errori di battitura: "zuchine", "melanznae"… solo per parole lunghe
      if (r[i].length >= 5 && !PAROLE_VUOTE.has(norm.split(" ")[i])) {
        const simile = CHIAVI_SINGOLE.find((c) => distanza(c.radice, r[i]) <= 1);
        if (simile) trovate.push(simile.voce);
      }
      i++;
    }
    return trovate;
  }

  /** Pulisce il testo di un pezzo senza alimenti noti, per metterlo in lista così com'è. */
  function testoLibero(testo) {
    const parole = normalizza(testo).split(" ").filter((p) => p && !/^\d/.test(p) && !PAROLE_VUOTE.has(p));
    if (!parole.length || parole.length > 4) return null;
    // Usa le parole originali (con accenti) quando possibile
    const originale = String(testo).replace(/\([^)]*\)/g, " ").replace(/\d+([.,]\d+)?\s*(g|gr|kg|ml|l|cl)\b\.?/gi, " ")
      .replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim();
    const nome = originale && originale.split(" ").length <= 5 ? originale : parole.join(" ");
    return nome.charAt(0).toUpperCase() + nome.slice(1);
  }

  /** Divide un pasto sui "+" (fuori dalle parentesi): ogni pezzo è analizzato a sé. */
  function pezziDelPasto(testo) {
    const pezzi = [];
    let corrente = "", prof = 0;
    for (let i = 0; i < testo.length; i++) {
      const ch = testo[i];
      if (ch === "(") prof++;
      if (ch === ")") prof = Math.max(0, prof - 1);
      if (ch === "+" && prof === 0) { pezzi.push(corrente); corrente = ""; }
      else corrente += ch;
    }
    pezzi.push(corrente);
    return pezzi.map((p) => p.trim()).filter(Boolean);
  }

  /** Voci della lista (oggetti {chiave, nome, cat, icona}) ricavate da un singolo pezzo di testo. */
  function vociDaPezzo(pezzo) {
    // Parentesi che iniziano con "no"/"senza" sono indicazioni, non ingredienti
    const pulito = pezzo.replace(/\(\s*(no|senza)\b[^)]*\)/gi, " ");
    let voci = trovaVoci(pulito);
    if (voci.length) {
      // 1) le generiche cedono il posto alle voci precise della stessa categoria
      const catPrecise = new Set(voci.filter((v) => !v.generica).map((v) => v.cat));
      voci = voci.filter((v) => !(v.generica && catPrecise.has(v.cat)));
      // 2) una variante ("Pasta integrale") prevale sulla sua voce base ("Pasta")
      const basiCoperte = new Set(voci.map((v) => v.base).filter(Boolean));
      voci = voci.filter((v) => !basiCoperte.has(v.nome));
      const viste = new Set();
      return voci.filter((v) => !viste.has(v.chiave) && viste.add(v.chiave))
        .map((v) => ({ chiave: v.chiave, nome: v.nome, cat: v.cat, icona: v.icona }));
    }
    const libero = testoLibero(pulito);
    if (!libero) return [];
    return [{ chiave: "x:" + radici(normalizza(libero)).join("-"), nome: libero, cat: "altro", icona: "🛒" }];
  }

  /** Voci da un intero pasto (testo libero del menu). */
  function vociDaPasto(testoPasto) {
    const t = String(testoPasto || "");
    if (!t.trim() || /pasto libero/i.test(t)) return [];
    return pezziDelPasto(t).flatMap(vociDaPezzo);
  }

  /**
   * Lista della spesa di una settimana: una voce per alimento, senza
   * duplicati. `campi` = chiavi dei pasti da leggere in ogni giorno.
   */
  function listaDaSettimana(giorni, campi) {
    const mappa = new Map();
    (giorni || []).forEach((g) => {
      campi.forEach((k) => {
        vociDaPasto(g && g[k]).forEach((v) => {
          if (!mappa.has(v.chiave)) mappa.set(v.chiave, Object.assign({ occorrenze: 0 }, v));
          mappa.get(v.chiave).occorrenze++;
        });
      });
    });
    return Array.from(mappa.values());
  }

  /** Classifica un articolo scritto a mano dal paziente ("zucchine 500g", "detersivo"). */
  function classificaArticolo(testo) {
    const voci = vociDaPezzo(String(testo || ""));
    if (voci.length) return voci;
    const nome = String(testo || "").trim();
    if (!nome) return [];
    return [{ chiave: "x:" + radici(normalizza(nome)).join("-"), nome: nome.charAt(0).toUpperCase() + nome.slice(1), cat: "altro", icona: "🛒" }];
  }

  const api = {
    CATEGORIE,
    categoria: (id) => CATEGORIE.find((c) => c.id === id) || CATEGORIE[CATEGORIE.length - 1],
    voceDaChiave: (chiave) => VOCE_PER_CHIAVE.get(chiave) || null,
    voceDaNome: (nome) => VOCE_PER_NOME.get(nome) || null,
    vociDaPasto,
    listaDaSettimana,
    classificaArticolo,
    normalizza,
    _interni: { radice, trovaVoci, VOCI },
  };

  if (typeof window !== "undefined") window.alimenti = api;
  if (typeof module !== "undefined") module.exports = api;
})();
