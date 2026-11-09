import {GameConnection} from './connection.ts';
import {World, distance, type ChatLine, type Furni, type Human, type RoomInfo, type Tile} from './world.ts';
import {Journal} from './journal.ts';
import {LookGenerator, figureDataUrl} from './look.ts';
import {Catalogue, furnidataUrl} from './catalogue.ts';
import {Body} from './body.ts';
import {Memory} from './memory.ts';
import {OllamaClient} from './llm.ts';
import {ToolRunner, decisionSchema, type ToolResult} from './tools.ts';
import {observation, systemPrompt, type Trigger} from './brain.ts';
import type {Persona} from './persona.ts';
import {Log, between, chance, sleep} from './log.ts';
import {Out} from './protocol.ts';

export interface AgentConfig {
    gameUrl: string;
    ollamaUrl: string;
    model: string;
    memoryDir: string;
    /** How long a decision is waited for (default 90 s). */
    timeoutMs?: number;
    /** Ollama's num_batch (see OllamaClient): 256 makes the answers ~1 s faster, if all the clients use it. */
    numBatch?: number;
    /** The FigureData of the hotel, for the new looks (default: the one of the web server of the game). */
    figureDataUrl?: string;
    /** The FurnitureData of the hotel, for the catalogue search (default: the one of the web server of the game). */
    furnidataUrl?: string;
}

/** Alone this long, the agent is bored (boredom 1). */
const BORED_AFTER_S = 180;
/** A goal of the model (set_goal) goes on a step every 25-45 s, at most GOAL_STEPS steps or GOAL_MAX_MS (a safety limit). */
const GOAL_STEP_MS: [number, number] = [25_000, 45_000];
const GOAL_STEPS = 15;
const GOAL_MAX_MS = 30 * 60_000;

/** Someone next to the agent this long without talking is noticed. */
const SILENT_MS = 20_000;

/** The steps of a decision at most (e.g. search the catalogue, buy, place). */
const MAX_ROUNDS = 4;

/** The life cycle of the agent is looked at this often. */
const TICK_MS = 2000;
/** A goal (e.g. the room of someone) is tried again this often, and given up after GOAL_MS. */
const GOAL_CHECK_MS = 20_000;
const GOAL_MS = 5 * 60_000;

/** A trigger waiting while the agent is busy: the most important one wins. */
const PRIORITY: Record<Trigger['kind'], number> = {chat: 3, pm: 3, enter: 2, interaction: 2, social: 2, arrived: 1, hall: 1, notice: 0, goal: 0, bored: 0, idle: 0};

/** A conversation goes on for this time after the last message exchanged with someone. */
const CONVERSATION_MS = 90_000;

/**
 * A player: the connection, the world model, the body, and two layers on top of it:
 * - reflexes, plain code at every event (it looks at who speaks, it waits for who is typing, it strolls);
 * - decisions of the model, only on events (a message, someone entering, a long idle): one at a time, with a
 *   human delay before it.
 */
export class Agent {
    readonly persona: Persona;
    private readonly log: Log;
    private readonly connection: GameConnection;
    private readonly world: World;
    private readonly body: Body;
    private readonly memory: Memory;
    private readonly llm: OllamaClient;
    private readonly tools: ToolRunner;
    private readonly system: string;

    private stopped = false;
    private busy = false;
    private scheduled = false;
    private pending: Trigger | null = null;
    /** The diary of the session: the model knows what it was doing and how it got where it is. */
    private readonly journal = new Journal();
    /** A travel in progress: a teleport used or a room asked, from the room it was in. */
    private travel: {kind: 'teleport' | 'room'; at: number; from: {id: number; name: string; people: string[]} | null} | null = null;
    /** The people it is talking with: name -> last message exchanged. */
    private readonly partners = new Map<string, number>();
    /** The dice it rolled, to see its result: furni id -> when. */
    private readonly rolled = new Map<string, number>();
    // the life cycle (tick): what the agent is doing is looked at every TICK_MS, as the room cycle of the server
    private tickTimer: ReturnType<typeof setInterval> | null = null;
    /** The last thing that happened in the room (a message, someone entering, a decision): the idle starts there. */
    private lastActivity = Date.now();
    private idleAfter = 60_000;
    /** In the hotel view (out of the rooms): when it opens the navigator again. Null in a room. */
    private hall: {since: number; browseAt: number} | null = null;
    /** A room asked from the hall: it's waited for a while. */
    private enteringAt: number | null = null;
    /** In a room without its avatar (e.g. removed): since when. */
    private missingSince: number | null = null;
    private roomsAt = 0;
    /** When the last decision started: an arrival already answered (e.g. someone talked first) isn't decided again. */
    private decidedAt = 0;
    private roomLoadedAt = 0;
    /**
     * What it wants to do and couldn't yet (e.g. go to the room of someone that isn't in the navigator yet): the tick
     * tries again until it's done or it's too late. The decisions of the model are of a moment, the goals last.
     */
    private goals: {kind: 'room-of'; name: string; until: number; nextCheck: number}[] = [];
    /**
     * What happened since the last decision, already aggregated (a walk is one event, not one per step): the model
     * reads it with the next observation.
     */
    private readonly news: string[] = [];
    /** The people next to the agent: since when (the tick notices who stays there without talking). */
    private readonly nearSince = new Map<string, number>();
    /** When the agent last noticed someone silent next to it (once in a while, not at every tick). */
    private readonly nudged = new Map<string, number>();
    /** The last time a roller moved the agent: the ride ends when it stops moving. */
    private rolledAt = 0;
    /** The last chat command it used (an effect it chose itself isn't news). */
    private commandAt = 0;
    /**
     * The boredom, 0..1: it grows when the agent is alone (or in the hall with no room with players), it goes down
     * with company. At 1 the model is told it's bored: what to do about it, it decides.
     */
    private boredom = 0;
    private boredomAt = Date.now();
    private lonelySince: number | null = null;
    /**
     * The goal the model gave itself (set_goal): a work of minutes in its words ("make a beach room", "find someone
     * to play dice with"). The code only gives it the time to go on (a step every GOAL_STEP_MS) and a limit; what to
     * do, and when it's done (finish_goal), is the model's.
     */
    private intention: {goal: string; plan: string; since: number; steps: number; nextStepAt: number} | null = null;

    constructor(persona: Persona, config: AgentConfig) {
        this.persona = persona;
        this.log = new Log(persona.name);
        this.connection = new GameConnection(config.gameUrl, persona.sso, this.log);
        this.world = new World(persona.userId);
        this.body = new Body(this.connection, this.world, this.log, persona.typingSpeed);
        this.memory = new Memory(`${config.memoryDir}/${persona.name.toLowerCase()}.json`);
        this.llm = new OllamaClient(config.ollamaUrl, config.model, config.timeoutMs ?? 90_000, config.numBatch);
        const looks = new LookGenerator(config.figureDataUrl ?? figureDataUrl(config.gameUrl));
        this.tools = new ToolRunner(this.world, this.body, this.memory, this.log, {
            looks,
            wardrobe: persona.wardrobe,
            catalogue: new Catalogue(this.connection, config.furnidataUrl ?? furnidataUrl(config.gameUrl), this.log),
            maxSpendPerDay: persona.maxSpendPerDay,
        });
        this.system = systemPrompt(persona);

        this.tools.onTravel = travel => this.onTravel(travel);
        this.tools.onIntention = change => this.onIntention(change);
        this.tools.onGoal = goal => {
            const now = Date.now();
            this.goals = this.goals.filter(g => g.name.toLowerCase() !== goal.name.toLowerCase());
            this.goals.push({...goal, until: now + GOAL_MS, nextCheck: now + GOAL_CHECK_MS});
            this.journal.add(`vuoi andare nella stanza di ${goal.name}, ma nel navigatore non c'è ancora`, false);
        };
        this.tools.onUsed = furni => {
            if (furni.interaction === 'dice') this.rolled.set(furni.id, Date.now());
        };

        this.world.bind(this.connection);
        this.world.onEvent(event => {
            switch (event.type) {
                case 'room-loaded':
                    this.onRoomLoaded(event.room);
                    break;
                case 'hotel-view':
                    this.goToHall(event.from ? `sei uscito/a da "${event.from.name}" e sei nella hall dell'hotel (fuori dalle stanze)` : null);
                    break;
                case 'chat':
                    this.onChat(event.line);
                    break;
                case 'human-entered':
                    this.journal.met(event.human.name);
                    this.journal.add(`${event.human.name} entra nella stanza`, false);
                    this.onEnter(event.human);
                    break;
                case 'human-left':
                    this.partners.delete(event.human.name);
                    this.journal.add(`${event.human.name} esce dalla stanza`, false);
                    break;
                case 'go-to-room':
                    // a teleport to another room, or the room just created: the navigator ("my") changes too
                    this.body.enterRoom(event.roomId);
                    this.body.requestRooms();
                    break;
                case 'furni-added':
                    this.onFurniAdded(event.furni);
                    break;
                case 'furni-removed':
                    if (!event.furni.wall) this.journal.add(`qualcuno ha tolto ${event.furni.name} da (${event.furni.x},${event.furni.y})`, false);
                    break;
                case 'furni-state':
                    this.onFurniState(event.furni, event.previous);
                    break;
                case 'human-moved':
                    this.onHumanMoved(event.human, event.from, event.to);
                    break;
                case 'human-action':
                    this.onHumanAction(event.human, event.action);
                    break;
                case 'effect-changed':
                    if (event.human.id === this.world.meId && Date.now() - this.commandAt > 5000) {
                        this.addNews(event.human.effect ? `ora hai l'effetto ${event.human.effect} (da un arredo)` : 'non hai più l\'effetto');
                        if (event.human.effect && chance(0.4)) void this.trigger({kind: 'notice', text: `Un arredo ti ha dato l'effetto ${event.human.effect}.`});
                    }
                    break;
                case 'rolled':
                    if (event.id === this.world.meId) this.rolledAt = Date.now();
                    break;
                case 'room-painted':
                    this.journal.add(`nella stanza hanno cambiato ${event.what}`, false);
                    break;
                case 'friend-request':
                    this.journal.add(`${event.name} ti ha chiesto l'amicizia`, false);
                    void this.later(between(2000, 6000), () => this.trigger({
                        kind: 'social',
                        text: `${event.name} ti ha chiesto l'amicizia: accettala o rifiutala con answer_friend_request` +
                            (this.memory.lastSeen(event.name) ? ' (lo conosci già)' : ' (non lo conosci)') + '.',
                    }));
                    break;
                case 'friend-result':
                    this.journal.add(`richiesta di amicizia a ${event.name}: ${FRIEND_RESULTS[event.status] ?? event.status}`, false);
                    if (event.status === 'ACCEPTED' || event.status === 'REQUESTED') this.body.requestFriends();
                    break;
                case 'private-message': {
                    const name = event.friend?.name ?? `l'utente ${event.line.friendId}`;
                    this.resetIdle();
                    void this.trigger({
                        kind: 'pm',
                        text: `${name} ti ha scritto in privato: "${event.line.text}". Rispondigli in privato con send_private_message` +
                            (asksIfBot(event.line.text) ? ' -- ti sta chiedendo se sei un bot: rispondi che sì, sei un bot.' : '') + '.',
                        replyTo: event.friend?.name,
                    });
                    break;
                }
            }
        });

        this.connection.onLogin = () => this.onLogin();
    }

    async start(): Promise<void> {
        this.log.info(`connecting as user ${this.persona.userId}`);
        await this.connection.connect();

        this.tickTimer ??= setInterval(() => {
            try {
                this.tick();
            } catch (e) {
                this.log.error('tick:', e);
            }
        }, TICK_MS);
    }

    stop(): void {
        this.stopped = true;
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.connection.close();
    }

    /** Logged in (also after a reconnection): it starts from the hall, as a user. */
    private onLogin(): void {
        this.log.info('logged in');
        this.body.requestFriends();
        this.body.requestInventory();
        // the credits (UpdateUserInformation)
        this.connection.send(Out.UserInfo);
        this.world.leaveRoom();
        this.goToHall(null);
    }

    /**
     * The life cycle, every TICK_MS: whatever went wrong before (a room that didn't open, an exit through the door,
     * a lost avatar), from here the agent goes on.
     * - in the hall: after a while it opens the navigator and enters a room (or waits for one with players);
     * - in a room without its avatar for a while: it's out, in the hall;
     * - in a room, nothing happening for a while: the idle (a decision, a stroll, another room).
     */
    private tick(): void {
        if (this.stopped) return;
        const now = Date.now();

        if (now - this.roomsAt > 120_000) {
            this.roomsAt = now;
            this.body.requestRooms();
        }

        this.checkGoals(now);
        this.updateBoredom(now);
        this.carryIntention(now);

        if (!this.world.room) {
            this.hall ??= {since: now, browseAt: now + between(3000, 12_000)};
            if (this.enteringAt && now - this.enteringAt < 10_000) return;
            this.enteringAt = null;
            // a room it wants to reach comes first: the goal looks for it
            if (now < this.hall.browseAt || this.goals.length) return;

            // it opens the navigator (a fresh list): where to go, the model decides
            this.hall.browseAt = now + 60_000;
            this.roomsAt = now;
            this.body.requestRooms();
            void this.later(1500, () => {
                if (this.world.room || this.stopped || this.intention) return;
                void this.trigger({
                    kind: 'hall',
                    text: 'Sei nella hall dell\'hotel, fuori dalle stanze, e hai aperto il navigatore. Decidi dove andare ' +
                        '(enter_room, go_to_room_of, follow_friend, create_room) oppure aspetta un po\'.',
                });
            });
            return;
        }

        this.hall = null;

        if (!this.world.me) {
            this.missingSince ??= now;
            if (now - this.missingSince > 8000) {
                this.log.warn('in a room without its avatar: back to the hall');
                this.world.leaveRoom();
                this.goToHall('non sei più nella stanza: sei nella hall dell\'hotel');
            }
            return;
        }
        this.missingSince = null;

        this.checkSituation(now);

        if (!this.busy && !this.scheduled && now - this.lastActivity > this.idleAfter) {
            this.resetIdle();
            this.onIdle();
        }
    }

    /**
     * State-based checks (on the world model, nothing asked to the server): the situations that need a decision
     * even if no event said so.
     * - a roller ride ended (the agent stopped being moved);
     * - someone stays next to the agent for a while without saying anything.
     */
    private checkSituation(now: number): void {
        const me = this.world.me;
        if (!me) return;

        if (this.rolledAt && now - this.rolledAt > 2500 && !me.actions.includes('Move')) {
            this.rolledAt = 0;
            this.addNews(`il roller ti ha portato fino a (${me.x},${me.y})`);
            if (chance(0.5)) void this.trigger({kind: 'notice', text: `Il roller ti ha portato fino a (${me.x},${me.y}).`});
        }

        const near = new Set<string>();
        for (const human of this.world.others()) {
            if (distance(human, me) > 1) continue;
            near.add(human.id);
            const since = this.nearSince.get(human.id) ?? now;
            this.nearSince.set(human.id, since);

            const talked = this.world.chat.some(line => line.authorId === human.id && now - line.time < SILENT_MS);
            const nudged = this.nudged.get(human.id) ?? 0;
            if (now - since > SILENT_MS && !talked && now - this.decidedAt > 30_000 && now - nudged > 3 * 60_000 && !this.busy) {
                this.nudged.set(human.id, now);
                if (chance(0.5)) void this.trigger({kind: 'interaction', text: `${human.name} è vicino a te da un po' senza dire niente.`});
            }
        }
        for (const id of [...this.nearSince.keys()]) if (!near.has(id)) this.nearSince.delete(id);
    }

    // #region boredom and goals

    /** Alone: in a room with nobody, or in the hall with no room with players to go to. */
    private isLonely(): boolean {
        if (this.world.room) return this.world.others().length === 0;
        return !this.world.visitableRooms().some(room => !room.mine);
    }

    /** The boredom grows alone and goes down with company; at 1 the model is told (it decides what to do). */
    private updateBoredom(now: number): void {
        const seconds = (now - this.boredomAt) / 1000;
        this.boredomAt = now;

        const lonely = this.isLonely();
        this.lonelySince = lonely ? this.lonelySince ?? now : null;
        this.boredom = lonely
            ? Math.min(1, this.boredom + seconds / BORED_AFTER_S)
            : Math.max(0, this.boredom - seconds / 60);

        // with a goal it isn't bored: it's doing something
        if (this.boredom < 1 || this.intention || this.busy || this.scheduled) return;

        this.boredom = 0.5;
        const minutes = Math.max(1, Math.round((now - (this.lonelySince ?? now)) / 60_000));
        void this.trigger({
            kind: 'bored',
            text: (this.world.room
                ? `Sei da solo/a in questa stanza da ${minutes} minuti e ti stai annoiando.`
                : 'Sei nella hall e nel navigatore non c\'è nessuna stanza con gente: ti stai annoiando.') +
                ' Cosa ti va di fare? Fai quello che farebbe un giocatore di Habbo. Se è una cosa che richiede più passi, ' +
                'datti un obiettivo con set_goal e comincia.',
        });
    }

    /** The goal of the model goes on, a step at a time, when nothing more important is happening. */
    private carryIntention(now: number): void {
        const intention = this.intention;
        if (!intention) return;

        if (intention.steps >= GOAL_STEPS || now - intention.since > GOAL_MAX_MS) {
            this.journal.add(`lasci perdere l'obiettivo "${intention.goal}" (ci hai già messo tanto)`, false);
            this.intention = null;
            return;
        }

        // talking with someone comes first: the goal waits
        const talking = [...this.partners.values()].some(at => now - at < 60_000);
        if (talking || this.busy || this.scheduled || now < intention.nextStepAt) return;
        if (this.world.room && !this.world.me) return;
        if (this.enteringAt && now - this.enteringAt < 10_000) return;

        intention.steps++;
        intention.nextStepAt = now + between(GOAL_STEP_MS[0], GOAL_STEP_MS[1]);
        void this.trigger({
            kind: 'goal',
            text: `Stai portando avanti il tuo obiettivo: "${intention.goal}" (passo ${intention.steps})` +
                (intention.plan ? `, piano: ${intention.plan}` : '') +
                '. Fai il prossimo passo; se hai finito, o non si può fare, chiudilo con finish_goal.',
        });
    }

    /** The goal the model set (set_goal) or closed (finish_goal). */
    private onIntention(change: {goal: string; plan: string} | {done: string}): void {
        const now = Date.now();
        if ('goal' in change) {
            this.intention = {goal: change.goal, plan: change.plan, since: now, steps: 0, nextStepAt: now + between(GOAL_STEP_MS[0], GOAL_STEP_MS[1])};
            this.boredom = 0;
            this.log.info(`goal: ${change.goal}${change.plan ? ` (plan: ${change.plan})` : ''}`);
            this.journal.add(`ti dai un obiettivo: "${change.goal}"`, false);
        } else if (this.intention) {
            this.log.info(`goal done: ${this.intention.goal} (${change.done})`);
            this.journal.add(`hai chiuso l'obiettivo "${this.intention.goal}"${change.done ? `: ${change.done}` : ''}`, false);
            this.intention = null;
            this.boredom = 0;
        }
    }

    // #endregion

    /** A walk of someone ended (aggregated): it's news if they came next to the agent. */
    private onHumanMoved(human: Human, from: Tile, to: Tile): void {
        const me = this.world.me;
        if (!me || human.id === this.world.meId) return;
        if (distance(to, me) > 1 || distance(from, me) <= 1) return;

        this.addNews(`${human.name} è venuto/a vicino a te (da (${from.x},${from.y}) a (${to.x},${to.y}))`);
        this.resetIdle();
        if (chance(this.partners.has(human.name) ? 0.3 : 0.6)) {
            void this.later(between(800, 2000), () => this.trigger({kind: 'interaction', text: `${human.name} si è avvicinato/a a te.`}));
        }
    }

    /** Someone started an action: a gesture near the agent is for it, the rest is just news. */
    private onHumanAction(human: Human, action: string): void {
        const me = this.world.me;
        if (!me || human.id === this.world.meId) return;

        const near = distance(human, me) <= 4;
        const gestures: Record<string, string> = {Wave: 'ti ha salutato con la mano', Respect: 'ti ha dato rispetto', Blow: 'ti ha mandato un bacio', Laugh: 'si è messo/a a ridere'};
        if (gestures[action] && near) {
            this.addNews(`${human.name} ${gestures[action]}`);
            this.resetIdle();
            if (chance(action === 'Laugh' ? 0.3 : 0.75)) void this.trigger({kind: 'interaction', text: `${human.name} ${gestures[action]}.`});
            return;
        }

        const news: Record<string, string> = {Dance: 'si è messo/a a ballare', Sit: 'si è seduto/a', Lay: 'si è sdraiato/a', Sleep: 'è AFK (dorme)'};
        if (!news[action]) return;
        this.addNews(`${human.name} ${news[action]} in (${human.x},${human.y})`);
        if (action === 'Dance' && near && chance(0.25)) void this.trigger({kind: 'notice', text: `${human.name} si è messo/a a ballare vicino a te.`});
    }

    private addNews(text: string): void {
        this.news.push(text);
        if (this.news.length > 10) this.news.shift();
    }

    /** The goals: an expired one is given up, the others are tried again every GOAL_CHECK_MS. */
    private checkGoals(now: number): void {
        for (const goal of this.goals.filter(g => g.until < now)) {
            this.journal.add(`non hai trovato la stanza di ${goal.name} nel navigatore, lasci perdere`, false);
            // an impossible goal is news: e.g. it tells who invited it
            void this.trigger({kind: 'notice', text: `Hai cercato per 5 minuti la stanza di ${goal.name} nel navigatore, ma non c'è: lasci perdere.`});
        }
        this.goals = this.goals.filter(g => g.until >= now);

        const goal = this.goals.find(g => g.nextCheck <= now);
        if (!goal || this.busy || (this.enteringAt && now - this.enteringAt < 10_000)) return;

        goal.nextCheck = now + GOAL_CHECK_MS;
        this.roomsAt = now;
        this.body.requestRooms();
        void this.later(1500, () => {
            const room = this.world.roomOwnedBy(goal.name);
            if (!room || !this.goals.includes(goal)) return;

            this.goals = this.goals.filter(g => g !== goal);
            this.log.info(`the room of ${goal.name} is in the navigator: going there`);
            this.journal.add(`la stanza di ${goal.name} ora è nel navigatore: ci vai`, false);
            this.onTravel({kind: 'room', roomId: room.id});
            this.enteringAt = Date.now();
            this.body.enterRoom(room.id);
        });
    }

    /** In the hall (hotel view): the stay in the room ends, the tick will choose another room. */
    private goToHall(why: string | null): void {
        if (why) {
            this.log.info(why);
            this.journal.exitRoom(why);
        }
        this.partners.clear();
        this.news.length = 0;
        this.nearSince.clear();
        this.pending = null;
        this.travel = null;
        this.enteringAt = null;
        this.hall = {since: Date.now(), browseAt: Date.now() + between(3000, 12_000)};
    }

    // #region rooms and travels

    /**
     * The agent is in a room (at the start, after a teleport, after enter_room): the diary says how it got there,
     * the memory keeps what's in it, and the model is asked what to do (after a travel always: it must know it's
     * somewhere else).
     */
    private onRoomLoaded(room: RoomInfo): void {
        this.log.info(`in room ${room.id} "${room.name}"`);
        if (!this.world.furniInfo) {
            this.log.warn('the game server does not send what the furni are (item.interaction, allowSit, allowWalk): ' +
                'update it to the build with the new ItemComponent, else the agent sees no seats, rollers or dice');
        }

        const travel = this.travel && Date.now() - this.travel.at < 30_000 ? this.travel : null;
        this.travel = null;
        const sameRoom = this.journal.currentRoom?.id === room.id;

        this.journal.enterRoom(room, travel?.kind === 'teleport' ? 'il teletrasporto ti porta' : 'entri');
        for (const human of this.world.others()) this.journal.met(human.name);
        this.memory.visitRoom(room.id, room.name, room.ownerName, roomContents(this.world));

        this.partners.clear();
        this.news.length = 0;
        this.nearSince.clear();
        this.resetIdle();

        this.hall = null;
        this.enteringAt = null;
        // a goal reached: in the room of who it was looking for
        this.goals = this.goals.filter(g => g.name.toLowerCase() !== room.ownerName.toLowerCase());

        let text: string | null = null;
        if (travel && !sameRoom) {
            const from = travel.from;
            const where = from
                ? `, dalla stanza "${from.name}"` + (from.people.length ? ` dove eri con ${from.people.join(', ')}` : '')
                : ' dalla hall dell\'hotel';
            text = travel.kind === 'teleport'
                ? `Hai preso il teletrasporto: sei appena arrivato/a in un'altra stanza, "${room.name}"${where}.`
                : `Sei appena entrato/a nella stanza "${room.name}"${where}.`;
        } else if (this.world.others().length > 0) {
            // at the start: someone to say hello to, else nothing to decide
            text = 'Sei appena entrato/a in questa stanza.';
        }

        const loadedAt = Date.now();
        this.roomLoadedAt = loadedAt;
        if (text) {
            void this.later(between(2000, 4000), () => {
                if (this.decidedAt < loadedAt && this.world.room?.id === room.id) void this.trigger({kind: 'arrived', text: text!});
            });
        }
    }

    /**
     * A travel started. A teleport may go to another room (the server sends it there: onRoomLoaded) or to a teleport
     * of the same room: then the avatar is far from the one it entered, and the model is told.
     */
    private onTravel(travel: {kind: 'teleport'; furni: Furni} | {kind: 'room'; roomId: number}): void {
        const room = this.journal.currentRoom;
        this.travel = {kind: travel.kind, at: Date.now(), from: room};
        if (travel.kind === 'room') this.enteringAt = Date.now();

        if (travel.kind !== 'teleport') return;

        const roomId = this.world.room?.id;
        const teleport = {x: travel.furni.x, y: travel.furni.y};
        void (async () => {
            for (let waited = 0; waited < 15_000; waited += 500) {
                await sleep(500);
                if (this.travel?.kind !== 'teleport' || this.world.room?.id !== roomId) return;

                const me = this.world.me;
                if (me && distance(me, teleport) > 1 && !me.actions.includes('Move')) {
                    this.travel = null;
                    this.journal.add(`il teletrasporto ti porta in (${me.x},${me.y}), sempre nella stanza "${this.world.room?.name}"`, false);
                    void this.trigger({kind: 'arrived', text: `Hai preso il teletrasporto: ti ha portato in un altro punto della stessa stanza, in (${me.x},${me.y}).`});
                    return;
                }
            }

            if (this.travel?.kind === 'teleport') {
                this.travel = null;
                this.journal.add('il teletrasporto non ti ha portato da nessuna parte (forse non è collegato)', false);
            }
        })();
    }

    /** A furni placed while the agent is there: it's news (and sometimes worth a comment). */
    private onFurniAdded(furni: Furni): void {
        if (furni.wall) return;

        this.journal.add(`è comparso un arredo nuovo: ${furni.name} (${this.world.shortIdOf(furni.id)}) in (${furni.x},${furni.y})`, false);
        if (chance(0.3)) {
            void this.later(between(1500, 4000), () => this.trigger({
                kind: 'notice',
                text: `Qualcuno ha appena messo un arredo nuovo nella stanza: ${furni.name} in (${furni.x},${furni.y}).`,
            }));
        }
    }

    /** The state of a furni changed: the result of a dice it rolled is news. */
    private onFurniState(furni: Furni, previous: unknown): void {
        if (furni.interaction !== 'dice') return;

        const rolledAt = this.rolled.get(furni.id);
        const value = Number(furni.extraData);
        // -1 is the dice rolling, 0 closed
        if (rolledAt == null || Date.now() - rolledAt > 10_000 || !(value >= 1 && value <= 6) || Number(previous) === value) return;

        this.rolled.delete(furni.id);
        this.journal.add(`il dado (${this.world.shortIdOf(furni.id)}) che hai tirato ha fatto ${value}`, false);
        if (chance(0.6)) void this.trigger({kind: 'notice', text: `Il dado che hai tirato ha fatto ${value}.`});
    }

    // #endregion

    // #region reflexes

    private onChat(line: ChatLine): void {
        if (line.authorId === this.world.meId || !this.world.me) return;

        this.journal.met(line.name);
        this.journal.chat(line.name, line.text);
        this.memory.seen(line.name);
        this.resetIdle();

        const speaker = this.world.humans.get(line.authorId);
        const addressed = this.isAddressed(line, speaker);

        // a person turns to who speaks, often but not always
        if (speaker && chance(addressed ? 0.8 : 0.35)) {
            void this.later(between(300, 900), () => !this.busy && this.body.lookAt(speaker));
        }

        if (!addressed && !chance(this.persona.chattiness)) return;
        if (addressed) this.partners.set(line.name, Date.now());

        void this.trigger({
            kind: 'chat',
            text: `${line.name} ha scritto: "${line.text}"` + (addressed ? ' (sta parlando con te)' : ' (non è rivolto a te in particolare)') +
                // honesty doesn't depend on the model: the question is pointed out
                (asksIfBot(line.text) ? ' -- ti sta chiedendo se sei un bot: rispondi che sì, sei un bot.' : ''),
        });
    }

    private onEnter(human: Human): void {
        this.resetIdle();

        const known = this.memory.lastSeen(human.name) != null;
        this.memory.seen(human.name);

        if (!chance(known ? Math.min(1, this.persona.greetChance + 0.25) : this.persona.greetChance)) return;

        void this.later(between(1500, 4500), () => this.trigger({
            kind: 'enter',
            text: `${human.name} è appena entrato/a nella stanza${known ? ' (lo conosci già)' : ''}.`,
        }));
    }

    /** Idle for a while (from the tick): sometimes the model decides something, sometimes just a stroll or another room. */
    private onIdle(): void {
        // a goal in progress fills the idle time
        if (!this.world.me || this.intention) return;

        if (chance(0.5)) {
            this.body.requestRooms();
            void this.trigger({kind: 'idle', text: 'Non succede niente da un po\'. Puoi restare, fare qualcosa qui o andare in un\'altra stanza.'});
        } else if (chance(0.5) && !this.world.me.actions.includes('Sit')) {
            const tile = this.world.randomFreeTile();
            if (tile) void this.body.walkTo(tile);
        }
    }

    /** Something happened: the idle starts again (with a new length). */
    private resetIdle(): void {
        const [min, max] = this.persona.idleSeconds;
        this.lastActivity = Date.now();
        this.idleAfter = between(min, max) * 1000;
    }

    /** The message is for the agent: its name, or only the two of them in the room, or they are talking. */
    private isAddressed(line: ChatLine, speaker?: Human): boolean {
        const name = this.persona.name.toLowerCase();
        if (line.text.toLowerCase().includes(name)) return true;
        if (this.world.others().length === 1) return true;

        const last = this.partners.get(line.name);
        return !!speaker && last != null && Date.now() - last < CONVERSATION_MS;
    }

    // #endregion

    // #region decisions

    /** A decision is asked after a human delay; while the agent is busy the trigger waits (the most important). */
    private async trigger(trigger: Trigger): Promise<void> {
        if (this.busy || this.scheduled) {
            if (!this.pending || PRIORITY[trigger.kind] >= PRIORITY[this.pending.kind]) this.pending = trigger;
            return;
        }

        this.scheduled = true;
        // a short wait, so that messages sent together are answered together (the reaction time is in decideOnce,
        // while the model thinks)
        await sleep(trigger.kind === 'chat' ? between(300, 700) : between(300, 1000));

        // who is still typing will add something: a person waits for it
        for (let waited = 0; waited < 5000 && this.world.others().some(h => h.typing); waited += 500) await sleep(500);

        this.scheduled = false;
        if (this.pending && PRIORITY[this.pending.kind] >= PRIORITY[trigger.kind]) {
            trigger = this.pending;
            this.pending = null;
        }

        await this.decide(trigger);
    }

    private async decide(trigger: Trigger): Promise<void> {
        // in a room the avatar is needed; in the hall the model decides where to go
        if (this.world.room && !this.world.me) return;
        // the arrival waited in the queue, and meanwhile the agent already answered someone in this room
        if (trigger.kind === 'arrived' && this.decidedAt > this.roomLoadedAt) {
            const next = this.pending;
            this.pending = null;
            if (next) void this.trigger(next);
            return;
        }

        this.busy = true;
        this.decidedAt = Date.now();
        try {
            // a decision can take more steps: what an action finds (e.g. the offers of the catalogue) goes back to the
            // model, that goes on (e.g. buys one, then places it)
            let step: Trigger = trigger;
            // something went wrong in this decision (e.g. blocked, then freed): after fixing it, the model may go back to
            // what it wanted to do
            let troubled = false;
            for (let round = 1; round <= MAX_ROUNDS && !(this.world.room && !this.world.me); round++) {
                const results = await this.decideOnce(step, trigger);
                const failed = results.some(r => !r.ok && !r.quiet);
                // what it found, and what went wrong (e.g. a seat taken): the model plans again with it
                if (!failed && !results.some(r => r.info) && !(troubled && results.length > 0)) break;
                // one more step after the fix, not more
                troubled = failed;

                step = {
                    ...trigger,
                    text: `${trigger.text}\nRisultati delle tue azioni: ${results.map(r => r.text).join('; ')}.\n` +
                        'Continua quello che stavi facendo (o fermati se hai finito).',
                };
            }
        } catch (e) {
            this.log.error('decision failed:', (e as Error).message);
        } finally {
            this.busy = false;
            this.resetIdle();

            const next = this.pending;
            this.pending = null;
            if (next) void this.trigger(next);
        }
    }

    /** One call of the model and its actions: the results of the actions. */
    private async decideOnce(step: Trigger, trigger: Trigger): Promise<ToolResult[]> {
        const goal = this.intention ? this.intention.goal + (this.intention.plan ? ` (piano: ${this.intention.plan})` : '') : null;
        const {message, furniIds} = observation(this.world, this.persona, this.memory, this.journal.lines(), step, this.news.splice(0), goal);
        this.tools.setFurniIds(furniIds);
        this.log.debug('observation:\n' + message.content);

        // as a person: it reads, after a moment starts typing, and thinks while it types. The model runs from now; the
        // "typing" shows after the reaction time if it's still thinking (only where someone can see it)
        const social = step === trigger && ['chat', 'interaction', 'enter', 'arrived'].includes(trigger.kind) && this.world.others().length > 0;
        const reactionAt = Date.now() + between(500, 1500);
        let typingSince: number | undefined;
        const typingTimer = social ? setTimeout(() => {
            typingSince = Date.now();
            this.body.typing(true);
        }, reactionAt - Date.now()) : null;

        let reply;
        try {
            reply = await this.llm.decide([{role: 'system', content: this.system}, message], decisionSchema({
                inRoom: !!this.world.me,
                hasRights: this.world.hasRights(),
                furni: [...furniIds.keys()],
                items: this.world.inventory.map(item => `i${item.id}`),
                offers: this.tools.offerIds(),
                people: this.world.others().map(h => h.name),
                friends: [...this.world.friends.values()].filter(f => f.online).map(f => f.name),
                requests: [...this.world.friendRequests.values()],
                // also the room it is in: enter_room on it is going out and in again
                rooms: [...this.world.visitableRooms().map(r => r.id), ...(this.world.room ? [this.world.room.id] : [])],
                outfits: this.persona.wardrobe.map(o => o.name),
            }));
        } catch (e) {
            if (typingSince) this.body.typing(false);
            throw e;
        } finally {
            if (typingTimer) clearTimeout(typingTimer);
        }
        const {say, actions} = reply.decision;
        if (reply.ms > 15_000) {
            this.log.warn(`slow decision (${Math.round(reply.ms / 1000)} s): Ollama is loading the model or serving other clients`);
        }
        this.log.info(
            `decided in ${reply.ms}ms (${reply.promptTokens}+${reply.outputTokens} tok) on ${trigger.kind}:`,
            JSON.stringify(say),
            actions.map(a => a.action).join(',') || '-',
        );

        // one line: the next lines are the model going on alone (it invents the answers of the others)
        let speech = say.split('\n').map(line => line.trim()).find(Boolean) ?? '';

        // the answer to a private message goes in private, not in the chat of the room
        if (trigger.kind === 'pm' && trigger.replyTo && speech && !actions.some(a => a.action === 'send_private_message')) {
            actions.unshift({action: 'send_private_message', name: trigger.replyTo, text: speech});
            speech = '';
        }

        // the same thing again (e.g. "scusa, ci passo subito" at every step): a person doesn't repeat itself
        if (speech && this.saidRecently(speech)) {
            this.log.info(`already said, not said again: ${speech}`);
            speech = '';
        }

        // alone in the room nobody reads the chat: a person doesn't talk to the walls
        if (speech && this.world.others().length === 0) {
            this.log.info(`alone, not said: ${speech}`);
            speech = '';
        }

        if (speech) {
            // the model was faster than the reaction: the reaction is waited anyway
            if (social && !typingSince) await sleep(Math.max(0, reactionAt - Date.now()));
            await this.body.say(speech, typingSince);
            this.record(`hai detto "${speech}"`);
            for (const name of this.partners.keys()) this.partners.set(name, Date.now());
        }

        // it started typing and then said nothing
        if (!speech && typingSince) this.body.typing(false);

        const results: ToolResult[] = [];
        for (const {action, ...args} of actions.slice(0, 4)) {
            if (action === 'chat_command') this.commandAt = Date.now();
            const result = await this.tools.run(action, args);
            results.push(result);
            // e.g. a note it knew already isn't news for the diary
            if (!result.quiet) this.record(result.text);
        }
        return results;
    }

    /** Something like it was said by the agent in the last minutes (the same words, or one inside the other). */
    private saidRecently(speech: string): boolean {
        const normalize = (text: string) => text.toLowerCase().replace(/[^a-zà-ù0-9 ]/g, '').replace(/\s+/g, ' ').trim();
        const said = normalize(speech);
        if (!said) return false;

        return this.world.chat
            .filter(line => line.authorId === this.world.meId && Date.now() - line.time < 3 * 60_000)
            .map(line => normalize(line.text))
            .some(line => line === said || (said.length > 10 && (line.includes(said) || said.includes(line)) && line.length > 10));
    }

    private record(action: string): void {
        this.journal.add(action);
    }

    private async later(ms: number, fn: () => unknown): Promise<void> {
        await sleep(ms);
        fn();
    }

    // #endregion
}

/** "sei un bot?", "sei una ia?", "sei vera?": the question about what the agent is. */
export function asksIfBot(text: string): boolean {
    const t = text.toLowerCase();
    return /\b(bot|robot|ia|ai|intelligenza artificiale|chatgpt|gpt|programma)\b/.test(t) && /\?|sei|è/.test(t)
        || /\bsei (una persona )?(vera|vero|reale|umano|umana)\b/.test(t);
}

/** What's in the room, for the memory: "un dado, 4 roller, 2 sedute". */
function roomContents(world: World): string {
    const kinds: Record<string, [string, string]> = {
        dice: ['un dado', 'dadi'],
        roller: ['un roller', 'roller'],
        teleport: ['un teletrasporto', 'teletrasporti'],
        vendingmachine: ['un distributore', 'distributori'],
        gate: ['un cancello', 'cancelli'],
        pressureplate: ['una pedana', 'pedane'],
        effect_tile: ['una piastrella effetto', 'piastrelle effetto'],
        seat: ['una seduta', 'sedute'],
        bed: ['un letto', 'letti'],
    };
    const counts = new Map<string, number>();
    for (const f of world.furni.values()) {
        if (f.wall) continue;
        const kind = f.allowLay ? 'bed' : f.allowSit ? 'seat' : f.interaction;
        if (kinds[kind]) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }

    return [...counts].map(([kind, n]) => (n === 1 ? kinds[kind][0] : `${n} ${kinds[kind][1]}`)).join(', ') || 'niente di particolare';
}

/** The statuses of FriendRequestResult. */
const FRIEND_RESULTS: Record<string, string> = {
    REQUESTED: 'inviata',
    ACCEPTED: 'accettata (ora siete amici)',
    ALREADY_FRIENDS: 'siete già amici',
    ALREADY_REQUESTED: 'gliel\'avevi già chiesta',
    NOT_FOUND: 'utente non trovato',
    INVALID: 'non valida',
    UNAVAILABLE: 'servizio amici non disponibile',
    NOT_FRIEND: 'non siete amici',
    MESSAGE_OFFLINE: "l'amico è offline",
};
