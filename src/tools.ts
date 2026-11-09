import type {Body} from './body.ts';
import type {Memory} from './memory.ts';
import type {Furni, Tile, World} from './world.ts';
import type {AvatarAction} from './protocol.ts';
import type {LookGenerator} from './look.ts';
import type {Catalogue, CatalogueEntry} from './catalogue.ts';
import {distance} from './world.ts';
import {between, sleep, type Log} from './log.ts';

const GESTURES: Record<string, AvatarAction> = {
    wave: 'Wave',
    dance: 'Dance',
    laugh: 'Laugh',
    blow_kiss: 'Blow',
    respect: 'Respect',
    sleep: 'Sleep',
    sit_floor: 'Sit',
    stop: 'Default',
};

/**
 * The actions of a user, as the model reads them in the system prompt. The ids of the furni are the short ones of
 * the observation (f1, f2...).
 */
export const ACTIONS: {action: string; args: string; description: string}[] = [
    {action: 'walk_to', args: '"x", "y"', description: 'cammini fino a una casella'},
    {action: 'go_to_user', args: '"name"', description: 'cammini vicino a una persona'},
    {action: 'sit', args: '"furni_id"', description: 'vai a sederti su una seduta libera (o sdraiarti su un letto)'},
    {action: 'step_on', args: '"furni_id"', description: 'sali su un arredo calpestabile: un roller, una pedana, un tappeto...'},
    {action: 'use_furni', args: '"furni_id"', description: 'usi un arredo come con un doppio clic: tiri un dado, entri in un teletrasporto'},
    {action: 'gesture', args: `"type" (${Object.keys(GESTURES).join(', ')})`, description: 'fai un gesto con l\'avatar'},
    {action: 'look_at_user', args: '"name"', description: 'ti giri a guardare una persona'},
    {action: 'remember', args: '"name", "note"', description: 'ti segni una cosa su una persona per le prossime volte'},
    {action: 'remember_room', args: '"note"', description: 'ti segni una cosa su questa stanza per le prossime volte'},
    {action: 'enter_room', args: '"room_id"', description: 'vai in un\'altra stanza'},
    {action: 'go_to_room_of', args: '"name"', description: 'vai nella stanza di una persona (anche se non siete amici): la cerchi nel navigatore'},
    {action: 'leave_room', args: '', description: 'esci dalla stanza dalla porta (torni nella hall dell\'hotel)'},
    {action: 'chat_command', args: '"command" (effect, sit, lay, drop), "value" (per effect: il numero dell\'effetto, 0 lo toglie)', description: 'usi un comando della chat: :effect N mette un effetto all\'avatar, :sit ti siedi, :lay ti sdrai, :drop lasci l\'oggetto che hai in mano'},
    {action: 'set_goal', args: '"goal", "plan" (facoltativo)', description: 'ti dai un obiettivo che richiede più passi: lo porterai avanti nelle prossime decisioni'},
    {action: 'finish_goal', args: '"result" (facoltativo)', description: 'chiudi il tuo obiettivo: finito, o non si può fare'},
    {action: 'search_catalogue', args: '"query" (parole chiave in inglese, come i nomi dei furni: chair, sofa, table, lamp, plant, dice, bed, rug...)', description: 'cerchi un arredo nel catalogo: vedi le offerte (id c1, c2...) e i prezzi'},
    {action: 'buy', args: '"offer_id" (es. c1)', description: 'compri un\'offerta del catalogo trovata con search_catalogue: finisce nel tuo inventario'},
    {action: 'place_item', args: '"item_id" (es. i123), "x", "y" (facoltativi), "rot" (0, 2, 4, 6)', description: 'metti nella stanza un arredo del tuo inventario (solo nelle tue stanze); carta da parati e pavimenti si applicano alla stanza'},
    {action: 'move_furni', args: '"furni_id", "x", "y"', description: 'sposti un arredo della stanza (solo nelle tue stanze)'},
    {action: 'rotate_furni', args: '"furni_id"', description: 'ruoti un arredo della stanza (solo nelle tue stanze)'},
    {action: 'pickup_furni', args: '"furni_id"', description: 'riprendi un arredo nel tuo inventario (solo nelle tue stanze)'},
    {action: 'create_room', args: '"name"', description: 'crei una stanza tua (ne puoi avere al massimo 2) e ci entri'},
    {action: 'change_look', args: '"outfit" (facoltativo: un vestito del tuo guardaroba)', description: 'cambi look; senza outfit ne inventi uno nuovo'},
    {action: 'add_friend', args: '"name"', description: 'chiedi l\'amicizia a una persona'},
    {action: 'answer_friend_request', args: '"name", "accept" (true/false)', description: 'accetti o rifiuti una richiesta di amicizia'},
    {action: 'send_private_message', args: '"name", "text"', description: 'scrivi un messaggio privato a un amico (anche se non è nella stanza)'},
    {action: 'follow_friend', args: '"name"', description: 'vai nella stanza in cui si trova un amico'},
];

/**
 * The chat commands (CommandHandler of the server) a player uses on itself. The others (credits, item, badge,
 * bot, pickall) give things or act on others: never, whoever asks for them.
 */
export const PLAYER_COMMANDS = ['effect', 'sit', 'lay', 'drop'] as const;

/** What is valid now, for the schema of the answer: the ids and the names the model can use. */
export interface DecisionContext {
    inRoom: boolean;
    hasRights: boolean;
    /** The short ids of the furni of the observation (f1...). */
    furni: string[];
    /** The items of the inventory (i123...). */
    items: string[];
    /** The offers of the last catalogue search (c1...). */
    offers: string[];
    people: string[];
    friends: string[];
    requests: string[];
    rooms: number[];
    outfits: string[];
}

const text = {type: 'string'};
const int = {type: 'integer'};
const oneOf = (values: (string | number)[]) => ({enum: values});

/**
 * The answer of the model (Ollama's structured output: a grammar the model can't go out of), built at every decision:
 * an object for each action with its arguments (required where they are), and the ids and the names valid now as
 * enums. So the model can't use a furni that isn't there, move a furni without saying where, or use an action that
 * makes no sense now (e.g. sit in the hall).
 */
export function decisionSchema(ctx: DecisionContext): object {
    const actions: [string, Record<string, unknown>, string[]][] = [];
    const add = (action: string, properties: Record<string, unknown> = {}, required: string[] = Object.keys(properties)) =>
        actions.push([action, properties, required]);

    if (ctx.inRoom) {
        add('walk_to', {x: int, y: int});
        if (ctx.people.length) {
            add('go_to_user', {name: oneOf(ctx.people)});
            add('look_at_user', {name: oneOf(ctx.people)});
        }
        if (ctx.furni.length) {
            add('sit', {furni_id: oneOf(ctx.furni)});
            add('step_on', {furni_id: oneOf(ctx.furni)});
            add('use_furni', {furni_id: oneOf(ctx.furni)});
        }
        add('gesture', {type: oneOf(Object.keys(GESTURES))});
        add('remember_room', {note: text});
        add('leave_room');
        add('chat_command', {command: oneOf([...PLAYER_COMMANDS]), value: int}, ['command']);
        if (ctx.hasRights) {
            if (ctx.items.length) add('place_item', {item_id: oneOf(ctx.items), x: int, y: int, rot: oneOf([0, 2, 4, 6])}, ['item_id']);
            if (ctx.furni.length) {
                add('move_furni', {furni_id: oneOf(ctx.furni), x: int, y: int});
                add('rotate_furni', {furni_id: oneOf(ctx.furni)});
                add('pickup_furni', {furni_id: oneOf(ctx.furni)});
            }
        }
        add('change_look', ctx.outfits.length ? {outfit: oneOf(ctx.outfits)} : {}, []);
    }
    add('remember', {name: text, note: text});
    if (ctx.rooms.length) add('enter_room', {room_id: oneOf(ctx.rooms)});
    add('go_to_room_of', {name: text});
    add('create_room', {name: text});
    add('set_goal', {goal: text, plan: text}, ['goal']);
    add('finish_goal', {result: text}, []);
    add('search_catalogue', {query: text});
    if (ctx.offers.length) add('buy', {offer_id: oneOf(ctx.offers)});
    add('add_friend', {name: text});
    if (ctx.requests.length) add('answer_friend_request', {name: oneOf(ctx.requests), accept: {type: 'boolean'}});
    if (ctx.friends.length) {
        add('send_private_message', {name: oneOf(ctx.friends), text});
        add('follow_friend', {name: oneOf(ctx.friends)});
    }

    return {
        type: 'object',
        properties: {
            say: text,
            actions: {
                type: 'array',
                maxItems: 3,
                items: {
                    anyOf: actions.map(([action, properties, required]) => ({
                        type: 'object',
                        properties: {action: {enum: [action]}, ...properties},
                        required: ['action', ...required],
                        additionalProperties: false,
                    })),
                },
            },
        },
        required: ['say', 'actions'],
    };
}

/** What a tool did: the agent logs it and shows it to the model next time ("le tue ultime azioni"). */
export interface ToolResult {
    ok: boolean;
    text: string;
    /** The result is information for the model (e.g. the offers of the catalogue): it decides again with it. */
    info?: boolean;
    /** Nothing happened worth telling (e.g. a note it knew already): not in the diary, no new step. */
    quiet?: boolean;
}

/**
 * Runs the tools chosen by the model, after checking them against the world: only furni, people and rooms that
 * exist, tiles where the avatar can stand. A tool never does more than a user could do.
 */
export class ToolRunner {
    private readonly world: World;
    private readonly body: Body;
    private readonly memory: Memory;
    private readonly log: Log;
    /** The short ids of the last observation: f1 -> the uuid of the furni. */
    private furniIds = new Map<string, string>();
    /** A travel started: a teleport used (to wait for where it goes) or another room asked. */
    onTravel: (travel: {kind: 'teleport'; furni: Furni} | {kind: 'room'; roomId: number}) => void = () => {};
    /** The goal the model gives itself (set_goal), or closes (finish_goal): the agent carries it on. */
    onIntention: (change: {goal: string; plan: string} | {done: string}) => void = () => {};
    /** The room of someone isn't in the navigator yet (e.g. they didn't go there yet): the agent keeps looking for it. */
    onGoal: (goal: {kind: 'room-of'; name: string}) => void = () => {};
    /** A furni was used (e.g. a dice rolled: the agent waits for its result). */
    onUsed: (furni: Furni) => void = () => {};

    private readonly looks: LookGenerator;
    private readonly wardrobe: {name: string; look: string}[];
    private readonly catalogue: Catalogue;
    private readonly maxSpendPerDay: number;
    /** The short ids of the last search in the catalogue: c1 -> the offer. */
    private offers = new Map<string, CatalogueEntry>();

    constructor(world: World, body: Body, memory: Memory, log: Log, options: {
        looks: LookGenerator;
        wardrobe: {name: string; look: string}[];
        catalogue: Catalogue;
        maxSpendPerDay: number;
    }) {
        this.world = world;
        this.body = body;
        this.memory = memory;
        this.log = log;
        this.looks = options.looks;
        this.wardrobe = options.wardrobe;
        this.catalogue = options.catalogue;
        this.maxSpendPerDay = options.maxSpendPerDay;
    }

    offerIds(): string[] {
        return [...this.offers.keys()];
    }

    setFurniIds(ids: Map<string, string>): void {
        this.furniIds = ids;
    }

    async run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const result = await this.runTool(name, args);
            this.log.info(`tool ${name}(${JSON.stringify(args)}) -> ${result.text}`);
            return result;
        } catch (e) {
            this.log.error(`tool ${name}:`, e);
            return {ok: false, text: `${name}: errore`};
        }
    }

    private async runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        switch (name) {
            case 'walk_to': {
                const x = Math.round(Number(args.x));
                const y = Math.round(Number(args.y));
                if (!Number.isFinite(x) || !Number.isFinite(y)) return {ok: false, text: 'casella non valida'};
                // the door: a walk that ends there leaves the room, only leave_room does it (on purpose)
                if (this.world.isDoor(x, y)) return {ok: false, text: `(${x},${y}) è la porta: per uscire usa leave_room`};

                const tile = this.world.canStandOn(x, y) ? {x, y} : this.world.freeTilesAround({x, y}, this.world.me)[0];
                if (!tile) return {ok: false, text: `non puoi andare in (${x},${y})`};

                const ok = await this.body.walkTo(tile);
                return {ok, text: ok ? `ora sei in (${tile.x},${tile.y})` : `non arrivi in (${x},${y}): ${this.whyBlocked(tile)}`};
            }
            case 'go_to_user': {
                const human = this.world.findHuman(String(args.name ?? ''));
                if (!human) return {ok: false, text: `${args.name} non è nella stanza`};

                const ok = await this.body.walkNextTo(human);
                if (ok) {
                    await sleep(between(200, 600));
                    this.body.lookAt(human);
                }
                return {ok, text: ok ? `sei vicino a ${human.name}` : `non riesci ad avvicinarti a ${human.name}: ${this.whyBlocked(human)}`};
            }
            case 'sit': {
                const furni = this.furni(args.furni_id);
                if (!furni || !(furni.allowSit || furni.allowLay)) return {ok: false, text: 'non è una seduta'};

                const ok = await this.body.goOn(furni);
                return {ok, text: ok ? `ora sei su ${furni.name} in (${furni.x},${furni.y})` : `${furni.name} è occupata o non raggiungibile`};
            }
            case 'step_on': {
                const furni = this.furni(args.furni_id);
                if (!furni) return {ok: false, text: this.unknownFurni(args.furni_id)};
                if (!(isWalkable(furni) || furni.allowSit || furni.allowLay)) return {ok: false, text: `su ${furni.name} non si può salire`};

                const ok = await this.body.goOn(furni);
                return {ok, text: ok ? `sei salito/a su ${furni.name} (${this.world.shortIdOf(furni.id)}) in (${furni.x},${furni.y})` : `${furni.name} è occupato o non raggiungibile`};
            }
            case 'use_furni': {
                const furni = this.furni(args.furni_id);
                if (!furni) return {ok: false, text: this.unknownFurni(args.furni_id)};

                const ok = await this.body.use(furni);
                if (ok && furni.interaction === 'teleport') this.onTravel({kind: 'teleport', furni});
                if (ok) this.onUsed(furni);
                return {ok, text: ok ? `hai usato ${furni.name} (${this.world.shortIdOf(furni.id)})` : `non riesci a raggiungere ${furni.name}`};
            }
            case 'gesture': {
                const action = GESTURES[String(args.type)];
                if (!action) return {ok: false, text: 'gesto sconosciuto'};

                this.body.gesture(action, action === 'Dance' ? 1 + Math.floor(Math.random() * 4) : 1);
                return {ok: true, text: `gesto ${args.type}`};
            }
            case 'look_at_user': {
                const human = this.world.findHuman(String(args.name ?? ''));
                if (!human) return {ok: false, text: `${args.name} non è nella stanza`};

                this.body.lookAt(human);
                return {ok: true, text: `guardi ${human.name}`};
            }
            case 'remember': {
                const who = String(args.name ?? '').trim();
                const note = String(args.note ?? '').trim();
                if (!who || !note) return {ok: false, text: 'niente da ricordare'};

                if (!this.memory.remember(who, note)) return {ok: false, quiet: true, text: `lo sapevi già di ${who}`};
                return {ok: true, text: `ricorderai di ${who}: ${note}`};
            }
            case 'leave_room':
                return this.leaveRoom();
            case 'remember_room': {
                const note = String(args.note ?? '').trim();
                if (!note || !this.world.room) return {ok: false, text: 'niente da ricordare'};

                const room = this.world.room;
                // a room not visited yet (e.g. just made) is added to the memory first
                if (!this.memory.roomOf(room.id)) this.memory.visitRoom(room.id, room.name, room.ownerName, '');
                this.memory.rememberRoom(room.id, note);
                return {ok: true, text: `ricorderai di questa stanza: ${note}`};
            }
            case 'chat_command': {
                const command = String(args.command ?? '').trim().replace(/^[:/]/, '').toLowerCase();
                if (!(PLAYER_COMMANDS as readonly string[]).includes(command)) {
                    return {ok: false, text: `il comando :${command} non lo usi (solo ${PLAYER_COMMANDS.map(c => ':' + c).join(', ')})`};
                }

                let text = `:${command}`;
                if (command === 'effect') {
                    const value = Math.round(Number(args.value ?? 0));
                    if (!Number.isFinite(value) || value < 0 || value > 10_000) return {ok: false, text: 'effetto non valido'};
                    text += ` ${value}`;
                }

                await this.body.command(text);
                return {ok: true, text: `hai usato il comando ${text}`};
            }
            case 'set_goal': {
                const goal = String(args.goal ?? '').trim().slice(0, 200);
                if (!goal) return {ok: false, text: 'quale obiettivo?'};

                this.onIntention({goal, plan: String(args.plan ?? '').trim().slice(0, 300)});
                return {ok: true, text: `il tuo obiettivo: ${goal}`};
            }
            case 'finish_goal':
                this.onIntention({done: String(args.result ?? '').trim().slice(0, 200)});
                return {ok: true, text: 'obiettivo chiuso'};
            case 'search_catalogue': {
                const query = String(args.query ?? '').trim();
                if (!query) return {ok: false, text: 'cosa cerchi?'};

                const found = await this.catalogue.search(query);
                this.offers = new Map(found.map((entry, index) => [`c${index + 1}`, entry]));
                if (found.length === 0) return {ok: false, info: true, text: `nel catalogo non trovi niente per "${query}" (prova altre parole in inglese)`};

                return {
                    ok: true,
                    info: true,
                    text: `nel catalogo per "${query}" trovi: ` + [...this.offers]
                        .map(([id, e]) => `${id}: ${e.name}${e.title ? ` (${e.title})` : ''}, ${e.credits} crediti`)
                        .join('; '),
                };
            }
            case 'buy': {
                const offer = this.offers.get(String(args.offer_id ?? '').trim().toLowerCase());
                if (!offer) return {ok: false, info: true, text: 'offerta non trovata: prima cerca nel catalogo con search_catalogue'};

                const left = this.maxSpendPerDay - this.memory.spentToday();
                if (offer.credits > left) return {ok: false, text: `${offer.name} costa ${offer.credits} crediti: oggi puoi spenderne ancora ${Math.max(0, left)}`};
                if (this.world.credits != null && this.world.credits < offer.credits) {
                    return {ok: false, text: `non hai abbastanza crediti per ${offer.name} (ne hai ${this.world.credits}, costa ${offer.credits})`};
                }

                const before = new Set(this.world.inventory.map(item => item.id));
                const answer = await this.catalogue.buy(offer.id);
                if (answer === 'no-credits') return {ok: false, text: `non hai abbastanza crediti per ${offer.name}`};
                if (answer === 'no-answer') return {ok: false, text: 'il catalogo non risponde'};

                this.memory.addSpent(offer.credits);
                await this.body.nextInventory();
                const bought = this.world.inventory.find(item => !before.has(item.id) && item.name === offer.name);
                return {
                    ok: true,
                    info: true,
                    text: `hai comprato ${offer.name} per ${offer.credits} crediti` + (bought ? `: è nel tuo inventario come i${bought.id}` : ''),
                };
            }
            case 'place_item': {
                const id = Number(String(args.item_id ?? '').replace(/^i/i, ''));
                const item = this.world.inventory.find(i => i.id === id);
                if (!item) return {ok: false, info: true, text: `nel tuo inventario non c'è ${args.item_id}`};
                if (!this.world.hasRights()) return {ok: false, text: 'puoi mettere arredi solo nelle tue stanze'};

                if (item.decoration) {
                    this.body.applyDecoration(item.id);
                    await this.body.nextInventory();
                    return {ok: true, text: `hai applicato ${item.name} alla stanza`};
                }
                if (item.wall) return {ok: false, text: `${item.name} va appeso al muro: non lo sai ancora fare`};

                const tile = this.placeTile(args);
                if (!tile) return {ok: false, text: 'non c\'è una casella libera dove metterlo'};

                const rot = [0, 2, 4, 6].includes(Number(args.rot)) ? Number(args.rot) : 2;
                this.body.placeItem(item.id, tile.x, tile.y, rot);
                await this.body.nextInventory();
                const placed = !this.world.inventory.some(i => i.id === item.id);
                if (!placed) return {ok: false, text: `${item.name} non ci sta in (${tile.x},${tile.y})`};

                await sleep(300);
                const furni = this.world.furniAt(tile.x, tile.y).find(f => f.name === item.name);
                return {ok: true, text: `hai messo ${item.name} in (${tile.x},${tile.y})` + (furni ? this.passageWarning(furni) : '')};
            }
            case 'move_furni':
            case 'rotate_furni':
            case 'pickup_furni': {
                const furni = this.furni(args.furni_id);
                if (!furni) return {ok: false, info: true, text: this.unknownFurni(args.furni_id)};
                if (!this.world.hasRights()) return {ok: false, text: 'puoi toccare gli arredi solo nelle tue stanze'};

                if (name === 'pickup_furni') {
                    this.body.pickupFurni(furni.id);
                    await this.body.nextInventory();
                    return {ok: true, text: `hai ripreso ${furni.name} nell'inventario`};
                }
                if (name === 'rotate_furni') {
                    this.body.rotateFurni(furni.id);
                    await sleep(600);
                    return {ok: true, text: `hai ruotato ${furni.name}`};
                }

                const x = Math.round(Number(args.x));
                const y = Math.round(Number(args.y));
                if (!Number.isFinite(x) || !Number.isFinite(y)) return {ok: false, text: 'dove lo sposti?'};
                this.body.moveFurni(furni.id, x, y);
                await sleep(800);
                const moved = this.world.furni.get(furni.id);
                return moved && moved.x === x && moved.y === y
                    ? {ok: true, text: `hai spostato ${furni.name} in (${x},${y})` + this.passageWarning(moved)}
                    : {ok: false, text: `${furni.name} non ci sta in (${x},${y})`};
            }
            case 'create_room': {
                const roomName = String(args.name ?? '').trim().slice(0, 40);
                if (!roomName) return {ok: false, text: 'che nome le dai?'};
                if (this.world.myRooms.length >= 2) return {ok: false, text: 'hai già 2 stanze: usa una di quelle'};

                this.onTravel({kind: 'room', roomId: -1});
                this.body.createRoom(roomName);
                return {ok: true, text: `hai creato la stanza "${roomName}"`};
            }
            case 'change_look': {
                const wanted = String(args.outfit ?? '').trim().toLowerCase();
                const outfit = wanted ? this.wardrobe.find(o => o.name.toLowerCase() === wanted) : undefined;
                const look = outfit?.look ?? await this.looks.random(this.world.myGender, this.world.myLook);

                this.body.changeLook(look);
                return {ok: true, text: outfit ? `ti sei messo/a "${outfit.name}"` : 'hai cambiato look con uno nuovo'};
            }
            case 'add_friend': {
                const name = String(args.name ?? '').trim();
                if (!name) return {ok: false, text: 'a chi?'};
                if (this.world.findFriend(name)) return {ok: false, text: `${name} è già tuo amico`};

                this.body.askFriendship(name);
                return {ok: true, text: `hai chiesto l'amicizia a ${name}`};
            }
            case 'answer_friend_request': {
                const name = String(args.name ?? '').trim().toLowerCase();
                const request = [...this.world.friendRequests].find(([, n]) => n.toLowerCase() === name);
                if (!request) return {ok: false, text: `${args.name} non ti ha chiesto l'amicizia`};

                const accept = args.accept === true || args.accept === 'true';
                this.world.friendRequests.delete(request[0]);
                this.body.answerFriendship(request[0], accept);
                return {ok: true, text: `${accept ? 'hai accettato' : 'hai rifiutato'} l'amicizia di ${request[1]}`};
            }
            case 'send_private_message': {
                const friend = this.world.findFriend(String(args.name ?? ''));
                if (!friend) return {ok: false, text: `${args.name} non è tuo amico: puoi scrivergli solo nella chat della stanza`};
                if (!friend.online) return {ok: false, text: `${friend.name} è offline`};

                const ok = await this.body.privateMessage(friend.id, String(args.text ?? ''));
                return {ok, text: ok ? `hai scritto in privato a ${friend.name}: "${String(args.text).slice(0, 60)}"` : 'messaggio non inviato'};
            }
            case 'follow_friend': {
                const friend = this.world.findFriend(String(args.name ?? ''));
                if (!friend) return {ok: false, text: `${args.name} non è tuo amico`};
                if (!friend.online) return {ok: false, text: `${friend.name} è offline`};

                this.onTravel({kind: 'room', roomId: -1});
                this.body.followFriend(friend.id);
                return {ok: true, text: `vai da ${friend.name}`};
            }
            case 'go_to_room_of': {
                const name = String(args.name ?? '').trim();
                if (!name) return {ok: false, text: 'di chi?'};
                if (this.world.room && this.world.room.ownerName.toLowerCase() === name.toLowerCase()) {
                    return {ok: false, text: `sei già nella stanza di ${name}`};
                }

                // as a user: the navigator, a fresh list, the room of that person
                this.world.invite(name);
                this.body.requestRooms();
                await sleep(1500);

                const room = this.world.roomOwnedBy(name);
                if (!room) {
                    this.onGoal({kind: 'room-of', name});
                    return {ok: false, text: `nel navigatore non c'è ancora una stanza di ${name}: ci andrai appena compare`};
                }

                this.onTravel({kind: 'room', roomId: room.id});
                this.body.enterRoom(room.id);
                return {ok: true, text: `vai nella stanza di ${name}, "${room.name}"`};
            }
            case 'enter_room': {
                const roomId = Math.round(Number(args.room_id));
                // the room it is in: the server lets it out and in again (UserEnterRoom), as "rientrare"
                if (roomId === this.world.room?.id) {
                    this.body.enterRoom(roomId);
                    return {ok: true, text: `esci e rientri nella stanza "${this.world.room.name}"`};
                }
                if (!this.world.visitableRooms().some(room => room.id === roomId)) {
                    return {ok: false, text: 'stanza non disponibile (vai solo in stanze con gente o nelle tue)'};
                }

                this.onTravel({kind: 'room', roomId});
                this.body.enterRoom(roomId);
                return {ok: true, text: `vai nella stanza ${roomId}`};
            }
            default:
                return {ok: false, text: `azione sconosciuta ${name}`};
        }
    }

    /** Out through the door: the server lets out who ends a walk on it (who just entered is on it without walking). */
    /** Where to place a furni: the tile asked if it's free, else a free tile in front of the agent. */
    /** The tile asked if it's free, else a free tile next to the agent but not next to the door (it would close it). */
    private placeTile(args: Record<string, unknown>): Tile | null {
        const x = Math.round(Number(args.x));
        const y = Math.round(Number(args.y));
        if (Number.isFinite(x) && Number.isFinite(y) && this.world.canStandOn(x, y) && this.world.furniAt(x, y).length === 0) {
            return {x, y};
        }

        const me = this.world.me;
        const door = this.world.room?.door;
        return me ? this.world.freeTilesAround(me, me)
            .find(t => this.world.furniAt(t.x, t.y).length === 0 && !(door && distance(t, door) <= 1)) ?? null : null;
    }

    /**
     * Why a walk failed, for the model to find a way out: the tiles it can reach from where it is and, if they are
     * few, what is around it that can't be crossed (in its room it can move those furni).
     */
    private whyBlocked(target: Tile): string {
        const me = this.world.me;
        if (!me) return 'non sei in una stanza';

        const reachable = this.world.reachable(me);
        const floor = this.world.floorTiles();
        const targetReachable = [...this.world.freeTilesAround(target), target].some(t => reachable.has(`${t.x},${t.y}`));

        if (reachable.size <= Math.max(3, floor / 10)) {
            const blockers = this.world.blockersAround();
            return `sei bloccato/a: da dove sei raggiungi solo ${reachable.size} caselle su ${floor}` +
                (blockers.length ? `. Intorno a te: ${blockers.join('; ')}` : '') +
                (this.world.hasRights() ? '. È la tua stanza: puoi spostare (move_furni) o riprendere (pickup_furni) gli arredi che ti chiudono.' : '. Puoi chiedere aiuto o uscire (leave_room).');
        }
        return targetReachable
            ? 'la strada è occupata in questo momento (forse da qualcuno), riprova'
            : `(${target.x},${target.y}) non si raggiunge da dove sei: gli arredi chiudono il passaggio (guarda la mappa)`;
    }

    /** A furni just placed or moved closes the way from the door to part of the room: the model is told. */
    private passageWarning(furni: Furni): string {
        const door = this.world.room?.door;
        if (!door) return '';

        const now = this.world.reachable(door).size;
        const without = this.world.reachable(door, furni.id).size;
        const lost = without - now - furni.sizeX * furni.sizeY;
        return lost > 0 ? `. Attenzione: così dalla porta non si arriva più in ${lost} caselle della stanza (chi entra resta chiuso)` : '';
    }

    private async leaveRoom(): Promise<ToolResult> {
        const door = this.world.room?.door;
        const me = this.world.me;
        if (!door || !me) return {ok: false, text: 'non sei in una stanza'};

        if (me.x === door.x && me.y === door.y) {
            const step = this.world.freeTilesAround(door)[0];
            if (step) {
                await this.body.walkTo(step);
                await sleep(between(300, 700));
            }
        }
        await this.body.walkTo(door);

        for (let waited = 0; waited < 3000 && this.world.room; waited += 250) await sleep(250);
        if (!this.world.room) return {ok: true, text: 'sei uscito/a dalla porta'};

        // why: the door can't be reached (furni around it), or it's taken
        const reachable = this.world.me ? this.world.reachable(this.world.me) : new Set<string>();
        const blockers = this.world.blockersAround(door);
        return {
            ok: false,
            text: 'non sei riuscito/a a uscire: ' + (reachable.has(`${door.x},${door.y}`)
                ? 'la porta è occupata in questo momento'
                : `non arrivi alla porta (${door.x},${door.y})` + (blockers.length ? `, intorno alla porta ci sono: ${blockers.join('; ')}` : '') +
                  (this.world.hasRights() ? '. È la tua stanza: puoi spostarli (move_furni) o riprenderli (pickup_furni)' : '')),
        };
    }

    private unknownFurni(id: unknown): string {
        const ids = [...this.furniIds.keys()];
        return `l'arredo ${String(id)} non c'è` + (ids.length ? ` (gli arredi sono: ${ids.join(', ')})` : ' (nella stanza non ci sono arredi utili)');
    }

    private furni(id: unknown): Furni | undefined {
        const uuid = this.furniIds.get(String(id ?? '').trim().toLowerCase());
        return uuid ? this.world.furni.get(uuid) : undefined;
    }
}

/** What anyone can use with a double click. */
const USABLE = new Set(['dice', 'teleport', 'vendingmachine']);

/** An avatar can stand on it (a gate only when open). */
export function isWalkable(f: Furni): boolean {
    if (f.interaction === 'gate') return Number(f.extraData) === 1;
    return f.allowWalk;
}

/**
 * The furni worth showing to the model, the nearest first: the seats, what anyone can use, the walkable ones that do
 * something (rollers, pressure plates, effect tiles...), then the plain walkable ones (carpets) if there's room.
 */
export function interestingFurni(world: World): Furni[] {
    const me = world.me;
    const door = world.room?.door;
    // in its rooms it can move all the furni: it sees all of them
    const mine = world.hasRights();
    const rank = (f: Furni) => {
        // what is at the door matters to everyone (it can close the room)
        if (door && world.seatTiles(f).some(t => distance(t, door) <= 1)) return 0;
        if (f.allowSit || f.allowLay || USABLE.has(f.interaction)) return 0;
        if (f.interaction !== 'default' && (f.allowWalk || f.interaction === 'gate')) return 0;
        if (f.allowWalk) return 1;
        return mine ? 2 : -1;
    };

    return [...world.furni.values()]
        .filter(f => !f.wall && rank(f) >= 0)
        .sort((a, b) => rank(a) - rank(b) || (me ? distance(a, me) - distance(b, me) : 0))
        .slice(0, mine ? 40 : 20);
}
