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
    ["Pane in cassetta", PAN, "🍞", "pane in cassetta|pancarre|pan carre|pane per toast|pan bauletto|bauletto|pane bauletto"],
    ["Pane in cassetta integrale", PAN, "🍞", "pane in cassetta integrale|pancarre integrale|pan carre integrale|pan bauletto integrale|bauletto integrale|pane bauletto integrale", { b: "Pane in cassetta" }],
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
    ["Vitello", CP, "🥩", "vitello|fesa di vitello|scaloppine di vitello"],
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
    ["Calamari", CP, "🦑", "calamaro|calamari|totani"],
    ["Seppie", CP, "🦑", "seppia|seppie|seppioline"],
    ["Polpo", CP, "🐙", "polpo|moscardini"],
    ["Cozze e vongole", CP, "🦪", "cozze|cozza|vongole|vongola|frutti di mare"],

    // ---------- Ingredienti & Spezie ----------
    ["Olio extravergine d'oliva", IS, "🫒", "olio|olio evo|olio extravergine|olio extravergine d oliva|olio d oliva|olio di oliva|olio di oliva extravergine|olio extravergine di oliva|olio extra|olio extra vergine|olio extra vergine di oliva|evo"],
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
    ["Tonno al naturale", IS, "🥫", "tonno in scatola|tonno al naturale|scatoletta di tonno|scatolette di tonno|tonno in scatoletta|scatoletta di tonno al naturale"],
    ["Tonno sott'olio", IS, "🥫", "tonno sott olio|tonno sottolio|tonno in vetro|tonno sott olio in vetro|tonno all olio|tonno in olio"],
    ["Mais", IS, "🌽", "mais|granella di mais"],
    ["Olive", IS, "🫒", "oliva|olive|olive taggiasche"],
    ["Paté di olive", IS, "🫒", "pate di olive|pate d olive|crema di olive|pate olive"],
    ["Capperi", IS, "🫙", "cappero|capperi"],
    ["Senape", IS, "🫙", "senape"],
    ["Salsa di soia", IS, "🫙", "salsa di soia|soia sauce|tamari"],
    ["Dado vegetale", IS, "🥣", "dado|dado vegetale|brodo vegetale|brodo|granulare"],
    ["Farina", IS, "🌾", "farina|farina 00|farina integrale|amido di mais|maizena"],
    ["Farina di ceci", IS, "🌾", "farina di ceci|cecina|cecine|farinata|panelle|panella"],
    ["Farina d'avena", IS, "🌾", "farina di avena|farina d avena|avena in farina"],
    ["Farina di riso", IS, "🌾", "farina di riso"],
    ["Tahina", IS, "🫙", "tahina|tahini|crema di sesamo|salsa tahina"],
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
    ["Hummus", PS, "🧆", "hummus|hummus di ceci|hummus di lenticchie"],
    ["Bastoncini di pesce", PS, "🐟", "bastoncini di pesce|bastoncini"],
    ["Pizza surgelata", PS, "🍕", "pizza surgelata"],

    // ---------- Pasta, Riso & Cereali (e legumi) ----------
    ["Pasta", PRC, "🍝", "pasta|pasta di semola|spaghetti|penne|fusilli|rigatoni|farfalle|linguine|ditalini|ditali|mezze maniche|tagliatelle|orecchiette|gnocchetti sardi|gnocchetti|conchiglie|paccheri|trofie|pennette|mafalde|pastina|sedanini|tubetti"],
    ["Pasta integrale", PRC, "🍝", "pasta integrale|pasta di semola integrale|pasta semola integrale|pasta integrale di semola|spaghetti integrali|penne integrali|fusilli integrali", { b: "Pasta" }],
    ["Pasta di mais", PRC, "🍝", "pasta di mais|pasta di mais e riso|pasta di riso e mais|pasta senza glutine", { b: "Pasta" }],
    ["Pasta di quinoa", PRC, "🍝", "pasta di quinoa", { b: "Pasta" }],
    ["Pasta di legumi", PRC, "🍝", "pasta di legumi|pasta di lenticchie|pasta di ceci|pasta di piselli", { b: "Pasta" }],
    ["Tortellini", PRC, "🥟", "tortellini|tortelloni|ravioli|pasta ripiena|tortellini di magro"],
    ["Gnocchi di patate", PRC, "🥟", "gnocchi|gnocchi di patate"],
    ["Riso", PRC, "🍚", "riso|riso carnaroli|riso arborio|riso parboiled|risotto"],
    ["Riso basmati", PRC, "🍚", "riso basmati|basmati", { b: "Riso" }],
    ["Riso venere", PRC, "🍚", "riso venere|riso nero|venere", { b: "Riso" }],
    ["Riso rosso", PRC, "🍚", "riso rosso", { b: "Riso" }],
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
    ["Crema spalmabile", SD, "🍫", "crema spalmabile|crema novi|novi|nutella|crema di nocciole|crema gianduia|crema al cacao|crema spalmabile al cacao"],
    ["Miele", SD, "🍯", "miele"],
    ["Marmellata", SD, "🍯", "marmellata|confettura|composta di frutta|marmellate"],
    ["Marmellata senza zuccheri", SD, "🍯", "marmellata sz|confettura sz|composta sz|marmellata extra sz", { b: "Marmellata" }],
    ["Biscotti", SD, "🍪", "biscotto|biscotti|frollini"],
    ["Barrette", SD, "🍫", "barretta|barrette|barretta proteica|barrette proteiche"],
    ["Popcorn", SD, "🍿", "popcorn|pop corn"],
    ["Snack di legumi", SD, "🫘", "triangolini di legumi|snack di legumi|chips di legumi|sfogliette di legumi|crackers di legumi"],
    ["Cocco rapè", SD, "🥥", "cocco rape|cocco grattugiato|cocco disidratato|cocco essiccato"],
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
    ["Cibo per gatti", ANI, "🐈", "cibo per gatti|crocchette per gatti|scatolette per gatti"],
    ["Lettiera", ANI, "🐾", "lettiera|sabbietta"],
  ];

  // Forme di piatto: "insalata di seppie" sono seppie, "scaloppina di pollo" è pollo.
  const FORME_DI = new Set(["insalata", "scaloppina", "scaloppine", "anelli", "burger", "hamburger", "polpette", "polpetta",
    "crocchette", "medaglioni", "tortino", "sformato", "spiedini", "straccetti", "bocconcini", "filetti", "trancio", "carpaccio", "tartare"]);
  // Prodotti pronti di marca: si comprano così come sono
  const RE_MARCHE_PRONTI = /\b(frosta|findus|4 salti|quattro salti|valsoia|kioene|garden gourmet|beyond meat)\b/i;

  // Prodotti trasformati: "farina di X" è una farina, non X.
  const TRASFORMATI = {
    farina: { cat: "ingredienti-spezie", icona: "🌾" },
    succo: { cat: "bevande", icona: "🧃" },
    sciroppo: { cat: "ingredienti-spezie", icona: "🍯" },
  };

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
    s = s.replace(/\bdii\b/gi, "di").replace(/(\d)(porzion)/gi, "$1 $2");
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
      .replace(/\b(rigoni di asiago|mulino bianco|barilla|de cecco|granarolo|parmalat|yomo|muller|danone|fage|misura|galbusera)\b/g, " ")
      .replace(/\ball\W?acqua\b/g, " ")
      .replace(/\b(piccol[oaie]|grand[ei]|confezionat[oaie]|sgocciolat[oaie])\b/g, " ")
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
      // "farina di farro", "succo di mela": un prodotto diverso dall'ingrediente
      // (salvo voci del catalogo più lunghe, come "farina di ceci")
      const parole = norm.split(" ");
      if (FORME_DI.has(parole[i]) && (parole[i + 1] === "di" || parole[i + 1] === "d") && parole[i + 2] && (!presa || presa.radici.length === 1)) {
        i += 2;
        continue;
      }
      const trasformato = TRASFORMATI[parole[i]] && (parole[i + 1] === "di" || parole[i + 1] === "d") && parole[i + 2];
      if (presa && !(trasformato && presa.radici.length === 1)) {
        trovate.push(presa.voce);
        i += presa.radici.length;
        continue;
      }
      if (trasformato && (parole[i + 1] === "di" || parole[i + 1] === "d") && parole[i + 2]) {
        const t = TRASFORMATI[parole[i]];
        const nome = `${parole[i].charAt(0).toUpperCase() + parole[i].slice(1)} di ${parole[i + 2]}`;
        trovate.push({ chiave: "x:" + [r[i], "di", r[i + 2]].join("-"), nome, cat: t.cat, icona: t.icona, generica: false, base: null });
        i += 3;
        continue;
      }
      // errori di battitura: "zuchine", "melanznae"… solo per parole lunghe
      if (r[i].length >= 5 && !PAROLE_VUOTE.has(norm.split(" ")[i])) {
        const simile = CHIAVI_SINGOLE.find((c) => c.radice[0] === r[i][0] && distanza(c.radice, r[i]) <= 1);
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
    const nome = etichettaPiatto(String(testo)) || (originale && originale.split(" ").length <= 5 ? originale : parole.join(" "));
    return nome.charAt(0).toUpperCase() + nome.slice(1);
  }


  // ---------------------------------------------------------------------
  // Quantità e alternative
  // ---------------------------------------------------------------------
  const GIORNI_BREVI = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
  const RE_PESO = /(\d+(?:[.,]\d+)?)\s*(kg|grammi|grammo|gr|g|ml|cl|litri|litro|l)\b/i;
  const RE_PEZZI = /\b(\d+)\s+(?:[a-zàèéìòù']+\s+){0,2}?(uov[oa]|album[ei]|mel[ae]|per[ae]|banan[ae]|kiwi|arance|arancia|pesch[ae]|pesca|mandarin[oi]|clementin[ae]|fett[ae]|vasett[oi]|scatolett[ae]|cucchiai[no]?|cucchiain[oi]|bicchier[ei]|tazz[ae]|tazzin[ae]|panin[oi])\b/i;
  const UNITA_CONTATE = [
    [/^fett/, "fette"], [/^vasett/, "vasetti"], [/^scatolett/, "scatolette"], [/^cucchiain/, "cucchiaini"],
    [/^cucchiai/, "cucchiai"], [/^bicchier/, "bicchieri"], [/^tazzin/, "tazzine"], [/^tazz/, "tazze"],
  ];

  /** Quantità scritta in un frammento: { g }, { ml } oppure { pz, unita }. */
  function leggiQuantita(testo) {
    const t = String(testo || "");
    const p = t.match(RE_PESO);
    if (p) {
      const n = Number(p[1].replace(",", "."));
      const u = p[2].toLowerCase();
      if (u === "kg") return { g: n * 1000 };
      if (u === "ml") return { ml: n };
      if (u === "cl") return { ml: n * 10 };
      if (u === "l" || u === "litri" || u === "litro") return { ml: n * 1000 };
      return { g: n };
    }
    const c = t.match(RE_PEZZI);
    if (c) {
      const parola = c[2].toLowerCase();
      const unita = (UNITA_CONTATE.find(([re]) => re.test(parola)) || [null, "pz"])[1];
      return { pz: Number(c[1]), unita };
    }
    return null;
  }

  // Gruppi "nutrizionali" usati per riconoscere le alternative di un pasto
  const FRUTTA = new Set(["Frutta fresca", "Mele", "Pere", "Arance", "Mandarini", "Limoni", "Banane", "Kiwi", "Pesche", "Albicocche",
    "Prugne", "Frutti di bosco", "Fragole", "Ciliegie", "Uva", "Ananas", "Melone", "Anguria", "Fichi", "Cachi", "Mango", "Melagrana"]);
  const PROTEINE_EXTRA = new Set(["Lenticchie", "Ceci", "Fagioli", "Fagioli cannellini", "Fave", "Legumi misti", "Edamame", "Tofu", "Seitan",
    "Tempeh", "Burger vegetali", "Hummus", "Tonno al naturale", "Tonno sott'olio", "Uova", "Albumi", "Bastoncini di pesce"]);
  const ETICHETTE_GRUPPO = {
    carboidrato: "Carboidrato a scelta", proteina: "Proteina a scelta", latticino: "Latticino a scelta",
    frutta: "Frutta a scelta", verdura: "Verdura a scelta", fruttaSecca: "Frutta secca a scelta",
  };
  function gruppoDi(v) {
    if (v.cat === "carne-pesce" || PROTEINE_EXTRA.has(v.nome)) return "proteina";
    if (v.cat === "pasta-riso-cereali" || v.cat === "panetteria") return "carboidrato";
    if (v.cat === "latte-formaggi") return "latticino";
    if (v.cat === "frutta-verdura") return FRUTTA.has(v.nome) ? "frutta" : "verdura";
    if (["Frutta secca", "Noci", "Mandorle", "Nocciole", "Pistacchi", "Anacardi", "Arachidi", "Semi oleosi"].includes(v.nome)) return "fruttaSecca";
    return v.cat;
  }

  // Condimenti e scorte: di solito ci sono già in casa
  const DISPENSA = new Set(["Olio extravergine d'oliva", "Aceto", "Aceto di mele", "Aceto balsamico", "Sale", "Pepe", "Spezie", "Origano",
    "Curry", "Zafferano", "Cannella", "Dado vegetale", "Lievito", "Zucchero", "Dolcificante", "Cacao amaro", "Capperi", "Senape", "Salsa di soia"]);

  /** Collega una voce trovata in un frammento a quella del pezzo (anche tra variante e base). */
  function vocePezzoCorrispondente(v, vociPezzo) {
    const esatta = vociPezzo.find((p) => p.chiave === v.chiave);
    if (esatta) return esatta;
    return vociPezzo.find((p) => {
      const cp = VOCE_PER_CHIAVE.get(p.chiave);
      return cp && (cp.base === v.nome || v.base === cp.nome);
    }) || null;
  }

  /**
   * Analizza un pezzo di pasto: restituisce gli alimenti con la loro quantità
   * e, se il pezzo propone alternative ("riso o pasta o farro", "Pollo/Tacchino"),
   * raggruppa quelle dello stesso gruppo in un'unica voce "a scelta".
   * Elementi: { tipo: "voce", voce, qta } | { tipo: "alternativa", gruppo, opzioni: [{ voce, qta }] }
   */
  function analizzaPezzo(pezzoGrezzo) {
    const pezzo = String(pezzoGrezzo || "")
      .replace(/\(\s*(no|senza)\b[^)]*\)/gi, " ")
      .replace(/\(\s*(\d+(?:[.,]\d+)?)\s*(kg|grammi|gr|g|ml|cl|l)\s*\)/gi, " $1 $2 ");
    const voci = vociDaPezzo(pezzo);
    if (!voci.length) return [];
    // Quantità: ogni frammento con UN alimento e una quantità le lega tra loro
    const qta = {};
    const qtaGenerica = {};
    let ultima = null;
    pezzo.split(/[,;()\/+]|\s(?:o|oppure|e|ed|con)\s|\s[-–—]\s/i).map((f) => f.trim()).filter(Boolean).forEach((f) => {
      const q = leggiQuantita(f);
      const corrisp = [];
      trovaVoci(f).forEach((v) => {
        const p = vocePezzoCorrispondente(v, voci);
        if (p && !corrisp.includes(p)) corrisp.push(p);
      });
      if (!corrisp.length && q) {
        const generica = trovaVoci(f).find((v) => v.generica);
        if (generica && !qtaGenerica[generica.cat]) { qtaGenerica[generica.cat] = q; return; }
      }
      if (corrisp.length) {
        ultima = corrisp[0];
        if (q && !qta[ultima.chiave]) qta[ultima.chiave] = q;
      } else if (q && ultima && !qta[ultima.chiave]) {
        qta[ultima.chiave] = q;
      }
    });
    // un solo alimento nel pezzo: la quantità scritta è sua (anche per i prodotti di marca)
    if (voci.length === 1 && !qta[voci[0].chiave]) { const q = leggiQuantita(pezzo); if (q) qta[voci[0].chiave] = q; }
    // la quantità di una voce generica ("Frutta secca 20g") vale per gli alimenti precisi della stessa categoria
    voci.forEach((v) => { if (!qta[v.chiave] && qtaGenerica[v.cat]) qta[v.chiave] = qtaGenerica[v.cat]; });
    const alternativo = /\s(o|oppure)\s|\//i.test(pezzo);
    if (!alternativo) return voci.map((v) => ({ tipo: "voce", voce: v, qta: qta[v.chiave] || null }));
    const perGruppo = new Map();
    voci.forEach((v) => {
      const g = gruppoDi(v);
      if (!perGruppo.has(g)) perGruppo.set(g, []);
      perGruppo.get(g).push(v);
    });
    const out = [];
    perGruppo.forEach((lista, gruppo) => {
      if (lista.length < 2) { out.push({ tipo: "voce", voce: lista[0], qta: qta[lista[0].chiave] || null }); return; }
      // "Pollo/Tacchino 250g": la quantità vale per tutte le alternative
      const note = [...new Set(lista.map((v) => qta[v.chiave]).filter(Boolean).map((q) => JSON.stringify(q)))];
      const condivisa = note.length === 1 ? JSON.parse(note[0]) : null;
      out.push({ tipo: "alternativa", gruppo, opzioni: lista.map((v) => ({ voce: v, qta: qta[v.chiave] || condivisa })) });
    });
    return out;
  }

  function sommaQuantita(tot, q) {
    if (!q) return;
    if (q.g) tot.g = (tot.g || 0) + q.g;
    if (q.ml) tot.ml = (tot.ml || 0) + q.ml;
    if (q.pz) { tot.pz = tot.pz || {}; tot.pz[q.unita] = (tot.pz[q.unita] || 0) + q.pz; }
  }

  const SINGOLARI = { fette: "fetta", vasetti: "vasetto", scatolette: "scatoletta", cucchiai: "cucchiaio", cucchiaini: "cucchiaino", bicchieri: "bicchiere", tazze: "tazza", tazzine: "tazzina" };
  const numero = (n) => (Math.round(n * 10) / 10).toString().replace(".", ",");
  /** "500 g", "1,2 kg", "1,5 L", "4 pz", "2 fette" — combinate con " + " se servono più unità. */
  function formattaQuantita(tot) {
    if (!tot) return "";
    const parti = [];
    if (tot.g) parti.push(tot.g >= 1000 ? `${numero(tot.g / 1000)} kg` : `${Math.round(tot.g)} g`);
    if (tot.ml) parti.push(tot.ml >= 1000 ? `${numero(tot.ml / 1000)} L` : `${Math.round(tot.ml)} ml`);
    if (tot.pz) Object.entries(tot.pz).forEach(([u, n]) => parti.push(u === "pz" ? `${n} pz` : `${n} ${n === 1 ? (SINGOLARI[u] || u) : u}`));
    return parti.join(" + ");
  }

  function nuovoAccumulo(base) {
    return Object.assign(base, { occorrenze: 0, tot: {}, senza: 0, giorni: {} });
  }
  function accumula(acc, indice, q) {
    acc.occorrenze++;
    const g = acc.giorni[indice] || (acc.giorni[indice] = { tot: {}, senza: 0, n: 0 });
    g.n++;
    if (q) { sommaQuantita(acc.tot, q); sommaQuantita(g.tot, q); } else { acc.senza++; g.senza++; }
  }

  /** "lun 250 g · gio 250 g" (i giorni senza quantità compaiono senza numero). */
  function testoGiorni(acc) {
    return Object.keys(acc.giorni).map(Number).sort((a, b) => a - b).map((i) => {
      const g = acc.giorni[i];
      const q = formattaQuantita(g.tot);
      return q ? `${GIORNI_BREVI[i]} ${q}` : GIORNI_BREVI[i];
    }).join(" · ");
  }

  // ---------------------------------------------------------------------
  // Confezioni tipiche: "Latte 1,4 L → 2 confezioni da 1 L". Formati indicativi
  // dei supermercati italiani; frutta, verdura, carne e pesce si comprano a peso.
  // ---------------------------------------------------------------------
  const CONFEZIONI = {
    "Latte": [1000, "ml", "1 L"], "Latte parzialmente scremato": [1000, "ml", "1 L"], "Latte scremato": [1000, "ml", "1 L"],
    "Latte senza lattosio": [1000, "ml", "1 L"], "Bevanda vegetale": [1000, "ml", "1 L"], "Kefir": [500, "ml", "500 ml"],
    "Yogurt": [125, "g", "vasetto da 125 g"], "Yogurt greco": [150, "g", "vasetto da 150 g"],
    "Uova": [6, "pz", "conf. da 6"], "Albumi": [500, "g", "brick da 500 g"],
    "Mozzarella": [125, "g", "125 g"], "Ricotta": [250, "g", "250 g"], "Robiola": [100, "g", "100 g"], "Stracchino": [100, "g", "100 g"],
    "Fiocchi di latte": [200, "g", "200 g"], "Formaggio spalmabile": [150, "g", "150 g"], "Feta": [200, "g", "200 g"],
    "Parmigiano": [100, "g", "busta da 100 g"], "Grana Padano": [100, "g", "busta da 100 g"],
    "Prosciutto crudo": [80, "g", "vaschetta da 80 g"], "Prosciutto cotto": [100, "g", "vaschetta da 100 g"], "Bresaola": [80, "g", "vaschetta da 80 g"],
    "Fesa di tacchino affettata": [100, "g", "vaschetta da 100 g"], "Salmone affumicato": [100, "g", "100 g"],
    "Tonno al naturale": [80, "g", "scatoletta da 80 g"], "Tonno sott'olio": [80, "g", "scatoletta da 80 g"],
    "Pasta": [500, "g", "500 g"], "Pasta integrale": [500, "g", "500 g"], "Pasta di legumi": [250, "g", "250 g"],
    "Pasta di mais": [400, "g", "400 g"], "Pasta di quinoa": [250, "g", "250 g"],
    "Riso": [1000, "g", "1 kg"], "Riso basmati": [500, "g", "500 g"], "Riso venere": [500, "g", "500 g"], "Riso integrale": [1000, "g", "1 kg"],
    "Cous cous": [500, "g", "500 g"], "Orzo": [500, "g", "500 g"], "Farro": [500, "g", "500 g"], "Quinoa": [400, "g", "400 g"],
    "Fiocchi d'avena": [500, "g", "500 g"], "Cereali per la colazione": [375, "g", "375 g"],
    "Lenticchie": [500, "g", "500 g"], "Ceci": [500, "g", "500 g"], "Fagioli": [500, "g", "500 g"],
    "Farina": [1000, "g", "1 kg"], "Farina di ceci": [500, "g", "500 g"], "Farina d'avena": [500, "g", "500 g"],
    "Pane in cassetta": [400, "g", "400 g"], "Pane in cassetta integrale": [400, "g", "400 g"],
    "Fette biscottate": [36, "fette", "conf. da 36 fette"], "Fette biscottate integrali": [36, "fette", "conf. da 36 fette"],
    "Crackers": [500, "g", "500 g"], "Crackers integrali": [500, "g", "500 g"], "Gallette": [130, "g", "130 g"], "Piadine": [300, "g", "conf. da 3"],
    "Passata di pomodoro": [700, "g", "bottiglia da 700 g"], "Pesto": [190, "g", "vasetto da 190 g"], "Hummus": [200, "g", "200 g"],
    "Tofu": [200, "g", "200 g"], "Burger vegetali": [200, "g", "conf. da 2"],
    "Noci": [200, "g", "200 g"], "Mandorle": [200, "g", "200 g"], "Nocciole": [200, "g", "200 g"], "Frutta secca": [200, "g", "200 g"],
    "Cioccolato fondente": [100, "g", "tavoletta da 100 g"], "Crema spalmabile": [350, "g", "vasetto da 350 g"],
    "Marmellata": [330, "g", "vasetto da 330 g"], "Marmellata senza zuccheri": [250, "g", "vasetto da 250 g"], "Miele": [500, "g", "500 g"],
    "Vino": [750, "ml", "bottiglia 0,75 L"],
  };

  /** "2 × 1 L", "1 × confezione da 6": quante confezioni servono, oppure null. */
  function confezioniNecessarie(voce) {
    const c = voce && CONFEZIONI[voce.nome];
    const t = voce && voce.tot;
    if (!c || !t) return null;
    const [quanto, unita, etichetta] = c;
    const totale = unita === "g" ? t.g : unita === "ml" ? t.ml : t.pz && (t.pz[unita] || (unita === "pz" ? t.pz.pz : 0));
    if (!totale) return null;
    const n = Math.ceil(totale / quanto - 0.05); // tolleranza: 505 g → 1 confezione da 500 g
    return { n: Math.max(1, n), etichetta, testo: `${Math.max(1, n)} × ${etichetta}` };
  }

  /** Somma due voci dello stesso alimento (quantità e giorni). */
  function unisciVoci(a, b) {
    const out = Object.assign({}, a, { tot: {}, giorni: {}, occorrenze: (a.occorrenze || 0) + (b.occorrenze || 0), senza: (a.senza || 0) + (b.senza || 0) });
    const aggiungiTot = (dest, t) => {
      if (!t) return;
      if (t.g) sommaQuantita(dest, { g: t.g });
      if (t.ml) sommaQuantita(dest, { ml: t.ml });
      if (t.pz) Object.entries(t.pz).forEach(([u, n]) => sommaQuantita(dest, { pz: n, unita: u }));
    };
    [a, b].forEach((v) => {
      aggiungiTot(out.tot, v.tot);
      Object.entries(v.giorni || {}).forEach(([i, g]) => {
        const d = out.giorni[i] || (out.giorni[i] = { tot: {}, senza: 0, n: 0 });
        d.n += g.n; d.senza += g.senza;
        aggiungiTot(d.tot, g.tot);
      });
    });
    return out;
  }

  /** Copia di una voce ristretta ad alcuni giorni (per la spesa in due tempi); null se non serve in quei giorni. */
  function restringiGiorni(voce, indici) {
    const giorni = {};
    const tot = {};
    let occorrenze = 0, senza = 0;
    indici.forEach((i) => {
      const g = voce.giorni && voce.giorni[i];
      if (!g) return;
      giorni[i] = g; occorrenze += g.n; senza += g.senza;
      sommaQuantita(tot, g.tot.g ? { g: g.tot.g } : null);
      sommaQuantita(tot, g.tot.ml ? { ml: g.tot.ml } : null);
      if (g.tot.pz) Object.entries(g.tot.pz).forEach(([u, n]) => sommaQuantita(tot, { pz: n, unita: u }));
    });
    if (!occorrenze) return null;
    const copia = Object.assign({}, voce, { giorni, tot, occorrenze, senza });
    if (voce.opzioni) copia.opzioni = voce.opzioni.map((o) => restringiGiorni(o, indici)).filter(Boolean);
    if (voce.voci) copia.voci = voce.voci.map((v) => restringiGiorni(v, indici)).filter(Boolean);
    return copia;
  }


  // ---------------------------------------------------------------------
  // Lettura di un intero pasto: righe, "e"/"o", alternative tra piatti
  // ---------------------------------------------------------------------
  const RE_PASTO_LIBERO = /pasto libero|piatto a piacere|stai sognando|\bpizza\b/i;
  const ETICHETTE_PASTO = { colazione: "Colazione", spuntinoMattina: "Spuntino", pranzo: "Pranzo", spuntinoPomeriggio: "Merenda", cena: "Cena", coccola: "Coccola" };

  /** Nome leggibile di un piatto: "1 porzione di pollo alle mandorle (120 g)" → "Pollo alle mandorle". */
  function etichettaPiatto(testo) {
    let t = String(testo || "")
      .replace(/\([^)]*\)/g, " ")
      .replace(/\+.*$/, " ")
      .replace(/^\s*(o|oppure|e)\s+/i, "")
      .replace(/^\s*\d+(?:[.,/]\d+)?\s*(porzion[ei]|grammi|gr|g|ml|fett[ae]|vasett[oi]|pacchett[oi]|scatolett[ae]|cucchiai[no]?|cucchiain[oi])?\s*(di\s+|d')?/i, "")
      .replace(/^\s*(porzione|porzioni)\s+(di\s+)?/i, "")
      .replace(/\b\d+(?:[.,]\d+)?\s*(kg|grammi|gr|g|ml)\b/gi, " ")
      .replace(/^\s*(di|d')\s+/i, "")
      .replace(/\s+/g, " ").replace(/[.,;\s]+$/, "").trim();
    if (!t) return "";
    if (t === t.toUpperCase()) t = t.toLowerCase();
    t = t.charAt(0).toUpperCase() + t.slice(1);
    return t.length > 70 ? t.slice(0, 67) + "…" : t;
  }

  /** Divide un testo sulle "o"/"oppure" fuori dalle parentesi. */
  function dividiAlternativeInRiga(riga) {
    const parti = [];
    let corrente = "", prof = 0;
    const t = " " + riga + " ";
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === "(") prof++;
      if (ch === ")") prof = Math.max(0, prof - 1);
      if (prof === 0) {
        const m = t.slice(i).match(/^\s(o|oppure)\s/i);
        if (m && corrente.trim()) { parti.push(corrente); corrente = ""; i += m[0].length - 2; continue; }
      }
      corrente += ch;
    }
    parti.push(corrente);
    return parti.map((p) => p.trim()).filter(Boolean);
  }

  /**
   * Righe "logiche" di un pasto scritto su più righe: unisce le righe spezzate
   * (parentesi aperte, "+" o "di" in fondo), toglie istruzioni e righe vuote.
   * Ritorna gruppi: ogni gruppo è un elenco di alternative (1 = alimento/piatto fisso).
   */
  function gruppiDelPasto(testo) {
    const t = String(testo || "").replace(/\r/g, "")
      .replace(/\(\s*(\d+(?:[.,]\d+)?)\s*9\s*\)/g, "($1 g)")
      .replace(/\bdii\b/gi, "di").replace(/(\d)(porzion)/gi, "$1 $2");
    const multiriga = /\n/.test(t.trim());
    // Pasto su una riga sola (stile "Pollo 220g + Zucchine"): pezzi separati da "+"
    const righe = [];
    if (!multiriga) {
      pezziDelPasto(t).forEach((p) => righe.push(p));
    } else {
      let buf = "";
      t.split("\n").map((r) => r.trim()).forEach((r) => {
        if (!r || r === ".") return;
        buf = buf ? buf + " " + r : r;
        const aperte = (buf.match(/\(/g) || []).length - (buf.match(/\)/g) || []).length;
        if (aperte > 0 || /(\+|\bdi|\bcon|\bdel|\bdella|\bal|\balla)\s*$/i.test(buf)) return;
        righe.push(buf); buf = "";
      });
      if (buf) righe.push(buf);
    }
    const gruppi = [];
    let attuale = null, prossimoO = false;
    righe.forEach((r) => {
      const riga = r.trim();
      if (/^(e|ed|\+)$/i.test(riga)) { prossimoO = false; attuale = null; return; }
      if (/^(o|0|oppure)$/i.test(riga)) { prossimoO = true; return; }
      if (/^se\s/i.test(riga)) return; // istruzioni ("Se scegli questo riduci l'olio…")
      let testoRiga = riga;
      let conO = prossimoO;
      const inizioO = testoRiga.match(/^(o|0|oppure)\s+/i);
      if (inizioO) { conO = true; testoRiga = testoRiga.slice(inizioO[0].length); }
      testoRiga = testoRiga.replace(/^(e|ed)\s+/i, "");
      const opzioni = multiriga ? dividiAlternativeInRiga(testoRiga) : [testoRiga];
      if (conO && attuale) attuale.push(...opzioni);
      else { attuale = opzioni.slice(); gruppi.push(attuale); }
      prossimoO = false;
    });
    return gruppi;
  }

  /** Voci (con quantità) di un'opzione, anche composta ("polpette Frosta + olio"). */
  function vociOpzione(testo) {
    const out = [];
    pezziDelPasto(testo).forEach((p) => analizzaPezzo(p).forEach((el) => {
      if (el.tipo === "voce") out.push({ voce: el.voce, qta: el.qta, testo: p });
      else out.push({ voce: el.opzioni[0].voce, qta: el.opzioni[0].qta, testo: p, alternative: el.opzioni.slice(1).map((o) => o.voce.nome) });
    }));
    return out;
  }

  function chiaveOpzione(o) {
    return o.voci.length === 1 ? o.voci[0].voce.chiave : "p:" + radici(normalizza(o.etichetta)).join("-");
  }

  /** Chiave stabile di un gruppo di alternative (uguale nella spesa e nel meal prep). */
  function chiaveAlternativa(el) {
    return "alt:" + el.opzioni.map((o) => (o.voce ? o.voce.chiave : o.chiave)).sort().join("|");
  }

  /**
   * Analizza un pasto intero. Elementi:
   *  { tipo: "voce", voce, qta, testo }
   *  { tipo: "alternativa", gruppo, opzioni: [{ voce, qta, testo }] }            (alimenti singoli)
   *  { tipo: "alternativa", gruppo: "piatto", opzioni: [{ chiave, etichetta, testo, voci: [{ voce, qta, testo }] }] }
   */
  function analizzaPasto(testo) {
    const t = String(testo || "");
    if (!t.trim() || RE_PASTO_LIBERO.test(t)) return [];
    const out = [];
    gruppiDelPasto(t).forEach((gruppo) => {
      if (gruppo.length === 1) {
        pezziDelPasto(gruppo[0]).forEach((p) => analizzaPezzo(p).forEach((el) => out.push(Object.assign({ testo: p }, el))));
        return;
      }
      // Alternative: ogni opzione con le sue voci; opzioni identiche si fondono
      const viste = new Map();
      const opzioni = [];
      gruppo.map((testoOpz) => ({ testo: testoOpz, etichetta: etichettaPiatto(testoOpz), voci: vociOpzione(testoOpz) }))
        .filter((o) => o.voci.length)
        .forEach((o) => {
          const k = o.voci.map((v) => v.voce.chiave).sort().join("|");
          const gia = viste.get(k);
          // "hummus di ceci o hummus Noa (88 g)": stessa cosa, si tiene la quantità dove c'è
          if (gia) { o.voci.forEach((v, n) => { if (!gia.voci[n].qta && v.qta) gia.voci[n].qta = v.qta; }); return; }
          viste.set(k, o); opzioni.push(o);
        });
      if (!opzioni.length) return;
      if (opzioni.length === 1) { opzioni[0].voci.forEach((v) => out.push({ tipo: "voce", voce: v.voce, qta: v.qta, testo: v.testo })); return; }
      if (opzioni.every((o) => o.voci.length === 1)) {
        const singole = opzioni.map((o) => o.voci[0]);
        // Condimenti in alternativa ("olio o olive"): niente scelta, si prende il primo
        if (singole.every((v) => DISPENSA.has(v.voce.nome))) { out.push({ tipo: "voce", voce: singole[0].voce, qta: singole[0].qta, testo: singole[0].testo }); return; }
        const note = [...new Set(singole.map((v) => v.qta).filter(Boolean).map((q) => JSON.stringify(q)))];
        const condivisa = note.length === 1 ? JSON.parse(note[0]) : null;
        out.push({ tipo: "alternativa", gruppo: gruppoDi(singole[0].voce), opzioni: singole.map((v) => ({ voce: v.voce, qta: v.qta || condivisa, testo: v.testo })) });
        return;
      }
      out.push({ tipo: "alternativa", gruppo: "piatto", opzioni: opzioni.map((o) => Object.assign(o, { chiave: chiaveOpzione(o) })) });
    });
    return out;
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
    if (RE_MARCHE_PRONTI.test(pulito)) {
      const nome = etichettaPiatto(pulito);
      if (nome) return [{ chiave: "x:" + radici(normalizza(nome)).join("-"), nome, cat: "pronti-surgelati", icona: "🧊" }];
    }
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
    if (!t.trim() || RE_PASTO_LIBERO.test(t)) return [];
    if (!/\n/.test(t.trim())) return pezziDelPasto(t).flatMap(vociDaPezzo);
    const viste = new Set(), out = [];
    analizzaPasto(t).forEach((el) => {
      const voci = el.tipo === "voce" ? [el.voce] : el.gruppo === "piatto" ? el.opzioni.flatMap((o) => o.voci.map((v) => v.voce)) : el.opzioni.map((o) => o.voce);
      voci.forEach((v) => { if (!viste.has(v.chiave)) { viste.add(v.chiave); out.push({ chiave: v.chiave, nome: v.nome, cat: v.cat, icona: v.icona }); } });
    });
    return out;
  }

  /**
   * Lista della spesa di una settimana (giorni[0] = lunedì … giorni[6] = domenica).
   * Voci normali: { chiave, nome, cat, icona, dispensa, occorrenze, tot, senza, giorni }
   * dove tot è la quantità totale ({ g, ml, pz }) e giorni[i] quella del giorno i.
   * Voci "a scelta": { chiave: "alt:…", alternativa: true, gruppo, nome, cat: "scelta",
   * opzioni: [voci come sopra, ciascuna con le proprie quantità] }.
   */
  function listaDaSettimana(giorni, campi) {
    const voci = new Map();
    const alternative = new Map();
    const nuovaVoce = (v) => nuovoAccumulo({ chiave: v.chiave, nome: v.nome, cat: v.cat, icona: v.icona, dispensa: DISPENSA.has(v.nome) });
    (giorni || []).forEach((g, indice) => {
      campi.forEach((k) => {
        analizzaPasto(g && g[k]).forEach((el) => {
          if (el.tipo === "voce") {
            const v = el.voce;
            if (!voci.has(v.chiave)) voci.set(v.chiave, nuovaVoce(v));
            accumula(voci.get(v.chiave), indice, el.qta);
            return;
          }
          const chiave = chiaveAlternativa(el);
          const piatti = el.gruppo === "piatto";
          if (!alternative.has(chiave)) {
            const nomi = el.opzioni.map((o) => (piatti ? o.etichetta : o.voce.nome));
            alternative.set(chiave, nuovoAccumulo({
              chiave, alternativa: true, piatti, gruppo: el.gruppo, cat: "scelta", icona: piatti ? "🍽️" : "🔀",
              nome: piatti ? `${ETICHETTE_PASTO[k] || "Pasto"}: piatto a scelta`
                : nomi.length === 2 ? `${nomi[0]} o ${nomi[1].charAt(0).toLowerCase() + nomi[1].slice(1)}` : (ETICHETTE_GRUPPO[el.gruppo] || "Alimento a scelta"),
              opzioniMappa: new Map(),
            }));
          }
          const alt = alternative.get(chiave);
          if (piatti) {
            accumula(alt, indice, null);
            el.opzioni.forEach((o) => {
              if (!alt.opzioniMappa.has(o.chiave)) alt.opzioniMappa.set(o.chiave, nuovoAccumulo({ chiave: o.chiave, nome: o.etichetta, icona: "🍽️", piatto: true, vociMappa: new Map() }));
              const opz = alt.opzioniMappa.get(o.chiave);
              accumula(opz, indice, null);
              o.voci.forEach(({ voce, qta }) => {
                if (!opz.vociMappa.has(voce.chiave)) opz.vociMappa.set(voce.chiave, nuovaVoce(voce));
                accumula(opz.vociMappa.get(voce.chiave), indice, qta);
              });
            });
            return;
          }
          const q = el.opzioni.map((o) => JSON.stringify(o.qta));
          accumula(alt, indice, new Set(q).size === 1 && el.opzioni[0].qta ? el.opzioni[0].qta : null);
          el.opzioni.forEach((o) => {
            if (!alt.opzioniMappa.has(o.voce.chiave)) alt.opzioniMappa.set(o.voce.chiave, nuovaVoce(o.voce));
            accumula(alt.opzioniMappa.get(o.voce.chiave), indice, o.qta);
          });
        });
      });
    });
    const alt = Array.from(alternative.values()).map((a) => {
      a.opzioni = Array.from(a.opzioniMappa.values()).map((o) => {
        if (o.vociMappa) { o.voci = Array.from(o.vociMappa.values()); delete o.vociMappa; }
        return o;
      });
      delete a.opzioniMappa;
      return a;
    });
    return Array.from(voci.values()).concat(alt);
  }

  /** Classifica un articolo scritto a mano dal paziente ("zucchine 500g", "detersivo"). */
  function classificaArticolo(testo) {
    const voci = vociDaPezzo(String(testo || ""));
    if (voci.length) return voci;
    const nome = String(testo || "").trim();
    if (!nome) return [];
    return [{ chiave: "x:" + radici(normalizza(nome)).join("-"), nome: nome.charAt(0).toUpperCase() + nome.slice(1), cat: "altro", icona: "🛒" }];
  }

  // Versione del motore di lettura dei pasti: va aumentata a ogni modifica che
  // cambia il risultato. Nella lista di casa serve a riconoscere gli alimenti
  // pubblicati da un'app non ancora aggiornata.
  const VERSIONE_MOTORE = 5;

  const api = {
    CATEGORIE,
    categoria: (id) => CATEGORIE.find((c) => c.id === id) || CATEGORIE[CATEGORIE.length - 1],
    voceDaChiave: (chiave) => VOCE_PER_CHIAVE.get(chiave) || null,
    voceDaNome: (nome) => VOCE_PER_NOME.get(nome) || null,
    vociDaPasto,
    listaDaSettimana,
    analizzaPezzo,
    analizzaPasto,
    chiaveAlternativa,
    etichettaPiatto,
    leggiQuantita,
    formattaQuantita,
    testoGiorni,
    restringiGiorni,
    unisciVoci,
    confezioniNecessarie,
    VERSIONE_MOTORE,
    GIORNI_BREVI,
    classificaArticolo,
    normalizza,
    _interni: { radice, trovaVoci, VOCI },
  };

  if (typeof window !== "undefined") window.alimenti = api;
  if (typeof module !== "undefined") module.exports = api;
})();
