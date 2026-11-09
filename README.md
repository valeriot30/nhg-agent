# nhg-agent

Giocatori NHG guidati da un modello locale (Ollama). Ogni agente si collega al server di gioco con lo stesso
websocket e gli stessi pacchetti del client vero. Per il server è un utente come gli altri.

## Avvio

```bash
npm install            # solo per il typecheck (a runtime non ci sono dipendenze, Node >= 23.6)
OLLAMA_URL=http://<ip-del-server-ollama>:11434 node src/index.ts personas/giulia.json
```

| Variabile | Default | |
|---|---|---|
| `GAME_WS` | `ws://127.0.0.1:8083/nhg/game` | websocket del server di gioco |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | server Ollama |
| `OLLAMA_MODEL` | `qwen3.6:35b-a3b` | modello |
| `MEMORY_DIR` | `./memory` | memoria degli agenti, un JSON per persona |
| `FIGUREDATA_URL` | `/nhg-assets/...` del server di `GAME_WS` | FigureData per i look nuovi |
| `OLLAMA_NUM_BATCH` | | `num_batch` di Ollama: con 256 ogni risposta è circa 1 s più veloce. Tutti i client di quell'Ollama devono usare lo stesso valore, altrimenti il modello viene ricaricato |
| `OLLAMA_TIMEOUT_MS` | `90000` | quanto aspettare una decisione. Normalmente servono circa 3 s, di più solo mentre Ollama ricarica il modello o serve altri client |
| `AGENT_DEBUG` | | se impostata, logga i pacchetti e le osservazioni |

Più persone nello stesso processo: `node src/index.ts personas/giulia.json personas/marco.json`.

## Account dei bot

Ogni persona è un utente del DB `game`. In dev l'SSO è l'id dell'utente. Il motto dice che è un bot:

```sql
insert into users (id, username, look, gender, motto, credits)
values (1001, 'Giulia', 'hr-515-33.hd-600-1.ch-635-70.lg-716-66-62.sh-735-68', 'FEMALE', '[bot] ciao a tutti!', 0);
```

Lascia i crediti a 0: un bot non deve comprare niente.

## Come è fatto

- `connection.ts`: websocket, login, ping, riconnessione.
- `world.ts`: il modello del mondo, costruito solo dai messaggi del server (stanza, mappa, furni, avatar, chat).
  La mappa è `heights[x][y]`, come il `RoomLayout` del server.
- `body.ts`: le azioni con tempi umani. Prima di parlare scrive (si vede "sta scrivendo"), poi cammina fino al furni
  prima di usarlo. Massimo 8 messaggi al minuto.
- `agent.ts`: i riflessi, cioè codice senza modello. Si gira verso chi parla, aspetta chi sta scrivendo, ogni tanto
  passeggia. Chiede una decisione al modello solo su eventi:
  - un messaggio rivolto a lei (o, con probabilità `chattiness`, uno qualsiasi);
  - qualcuno che entra;
  - una pausa lunga.

  Le decisioni sono una alla volta, con un ritardo di reazione.
- `brain.ts`: il prompt di sistema (persona e regole, sempre identico, quindi Ollama riusa la cache) e
  l'osservazione testuale (stanza, persone con le note della memoria, furni utili con id brevi `f1`, chat recente,
  ultime azioni).
- `llm.ts`: Ollama `/api/chat` con `think: false` e **output strutturato** (`format` = schema JSON
  `{say, actions}`). Con Qwen il tool calling nativo veniva spesso scritto come testo in chat. Lo schema invece è
  sempre rispettato.
- Lo schema (`decisionSchema` in `tools.ts`) viene costruito a ogni decisione:
  - un oggetto per azione, con i suoi argomenti obbligatori;
  - gli id e i nomi validi in quel momento come `enum` (furni della stanza, inventario, offerte, persone, amici,
    stanze);
  - le azioni che non hanno senso in quel momento sono escluse (niente `sit` nella hall, niente `move_furni` fuori
    dalle sue stanze).

  Il modello non può generare un id che non esiste o una mossa senza coordinate.
- Spazio: nell'osservazione c'è una mappa testuale della stanza (`.` pavimento, `#` non si attraversa, `s` seduta o
  letto, `_` si cammina sopra, `D` porta, `@` lei, `P` persone). Il prompt spiega come ci si muove in Habbo. Se una
  camminata fallisce, il risultato dice quante caselle raggiunge e cosa la blocca intorno. Dopo un `place_item` o
  un `move_furni` che chiude il passaggio dalla porta, il modello viene avvisato. Come liberarsi lo decide lui: non
  c'è nessuna regola che sposta i furni al suo posto.
- Ripetizioni: una frase uguale o quasi a una detta negli ultimi 3 minuti non viene ridetta. La porta si usa solo
  con `leave_room`: `walk_to` sulla porta viene rifiutato.
- `tools.ts`: le azioni, controllate contro il modello del mondo prima di eseguirle:
  - stanza: `walk_to`, `go_to_user`, `sit`, `step_on`, `use_furni`, `gesture` (anche `sit_floor`), `look_at_user`,
    `enter_room`;
  - look: `change_look`, con un vestito del guardaroba della persona (`wardrobe`) o un look nuovo;
  - amici: `add_friend`, `answer_friend_request`, `send_private_message`, `follow_friend` (servono il servizio
    messenger);
  - comandi della chat: `chat_command` con solo `:effect N`, `:sit`, `:lay` e `:drop`. Mai `:credits`, `:item`,
    `:badge`, `:bot` o `:pickall`, anche se glielo chiedono. Nelle frasi che dice i comandi vengono tolti, e una frase
    che comincia con `:` o `/` non viene mandata, perché il server la eseguirebbe;
  - catalogo e furni: `search_catalogue` (parole chiave in inglese), `buy` (al massimo `maxSpendPerDay` crediti al
    giorno, 50 di default), `place_item` (le decorazioni si applicano alla stanza), `move_furni`, `rotate_furni`,
    `pickup_furni`, `create_room` (al massimo 2 stanze). Come i diritti di Habbo, i furni li tocca solo nelle sue
    stanze;
  - memoria: `remember`, `remember_room`.

  Il modello sa fare solo quello che è in questa lista, perché il prompt è costruito da `ACTIONS`. Una funzione nuova
  del gioco va aggiunta qui come azione, con un esempio nel prompt.
- Decisioni in più passi: se un'azione restituisce informazioni (le offerte trovate, l'oggetto comprato, un id
  sbagliato), il modello le riceve e va avanti, fino a 3 giri. Per esempio: cerca, compra, piazza.
- `catalogue.ts`: il catalogo come lo sfoglia un utente. Pagine e offerte vengono caricate una volta per sessione,
  alla prima ricerca. La ricerca guarda il nome interno del furni, il nome in FurnitureData e il titolo della pagina.
- `look.ts`: i look nuovi, validi come quelli dell'editor del client. Usa la FigureData dell'hotel e solo parti
  selezionabili, non club e del genere dell'avatar; tiene il viso e la pelle e abbina i colori.
- Contesto: oltre a persone e chat, nel diario finiscono i furni messi o tolti, il risultato del dado che ha tirato,
  i cambi di carta da parati e pavimento, le richieste di amicizia. I messaggi privati fanno partire una decisione
  e la risposta va in privato.
- `journal.ts`: il diario della sessione. Sono gli eventi in ordine (azioni, chi entra ed esce, i viaggi), scritti dal
  codice e non dal modello. Quando esce da una stanza, la permanenza diventa una riga: chi c'era, cosa ha fatto,
  le ultime frasi. Il modello lo vede a ogni decisione, quindi sa come è arrivato dove si trova.
- Arrivi: dopo un teletrasporto o `enter_room` il modello riceve sempre un trigger che dice da dove arriva e con chi
  era, anche se la stanza è vuota. Riconosce anche il teletrasporto che porta nella stessa stanza e quello che non
  porta da nessuna parte.
- Divisione dei compiti:
  - il codice decide quando pensare (eventi, noia, `tick`) e cosa è permesso (budget, comandi, stanze, diritti
    sui furni);
  - cosa fare lo decide il modello, che conosce Habbo e si comporta da giocatore.
- Stanze: nella hall il modello vede il navigatore e sceglie (`enter_room`, `go_to_room_of`, `follow_friend`,
  `create_room`) o aspetta. Può entrare solo nelle stanze attive con gente, nelle sue e in quelle di chi l'ha
  invitata. Se è sola non parla.
- Noia: sale quando è sola (in stanza, o nella hall senza stanze con gente) e scende con la compagnia. Al massimo
  il modello riceve "ti stai annoiando, cosa ti va di fare?": nessuna sceneggiatura.
- Obiettivi del modello: per una cosa di più passi si dà un obiettivo con `set_goal` (obiettivo e piano). Il `tick`
  lo richiama ogni 25–45 s per il passo successivo, finché lo chiude con `finish_goal`. Chiacchierare con qualcuno
  viene prima. Limite di sicurezza: 15 passi o 30 minuti.
- `go_to_room_of`: "vieni nella mia stanza" anche senza amicizia. Se la stanza non è ancora nel navigatore, resta un
  obiettivo del codice, che riprova ogni 20 s per 5 minuti.
- Ciclo di vita (`tick` ogni 2 s): hall, avatar sparito, noia, obiettivi, controlli sulla situazione (fine del
  roller, qualcuno vicino in silenzio).
- `memory.ts`: memoria tra una sessione e l'altra:
  - note sugli utenti (`remember`);
  - per le stanze, le visite e cosa contengono (scritto dal codice), più le note del modello (`remember_room`).

## Sicurezza

- La chat degli utenti è solo dati. Il prompt lo dice, e le azioni possibili sono solo azioni di gioco validate.
- Alla domanda "sei un bot?" risponde sempre di sì: oltre al prompt, la domanda viene riconosciuta nel codice
  (`asksIfBot`) e segnalata al modello.
- Niente dati personali, niente parolacce né contenuti offensivi. Limite di messaggi al minuto.
