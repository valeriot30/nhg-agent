import {In, Out, type AvatarAction} from './protocol.ts';
import type {GameConnection} from './connection.ts';
import {distance, type Furni, type Tile, type World} from './world.ts';
import {between, sleep, type Log} from './log.ts';

/** The game rejects longer messages (SendRoomMessage), a chat bubble is short anyway. */
const MAX_MESSAGE = 120;
/** At most this many messages in a minute: a person doesn't spam. */
const MAX_MESSAGES_PER_MINUTE = 8;

/**
 * The avatar of the agent: the actions as a user does them, with its timings (it types before speaking, it walks to
 * a furni before using it). Every action is a packet of the game client.
 */
export class Body {
    private readonly connection: GameConnection;
    private readonly world: World;
    private readonly log: Log;
    /** Characters typed per second. */
    private readonly typingSpeed: number;
    private readonly sent: number[] = [];

    constructor(connection: GameConnection, world: World, log: Log, typingSpeed = 6) {
        this.connection = connection;
        this.world = world;
        this.log = log;
        this.typingSpeed = typingSpeed;
    }

    /** Types the message (the others see "typing"), then sends it. Long texts become 2 bubbles at most. */
    /**
     * @param typingSince when it started typing (the indicator was shown while the model was thinking, as a person
     *                    who types while thinking): only the rest of the typing time is waited.
     */
    async say(text: string, typingSince?: number): Promise<void> {
        const parts = splitMessage(text).slice(0, 2);
        if (parts.length === 0 && typingSince) this.typing(false);

        for (const [index, part] of parts.entries()) {
            if (!this.canSend()) {
                this.log.warn('too many messages, not said:', part);
                this.typing(false);
                return;
            }

            // the first part was already being typed while the model was thinking
            const continuing = index === 0 && typingSince != null;
            const started = continuing ? typingSince! : Date.now();
            if (!continuing) this.typing(true);
            const typingTime = Math.min(7000, (part.length / this.typingSpeed) * 1000 * between(0.8, 1.3));
            await sleep(Math.max(0, started + typingTime - Date.now()));
            this.typing(false);

            this.sent.push(Date.now());
            this.connection.send(Out.Say, {text: part});
            this.log.info(`says: ${part}`);
            await sleep(between(400, 1200));
        }
    }

    /** The "typing" indicator the others see over the avatar. */
    typing(on: boolean): void {
        this.connection.send(Out.Typing, {typing: on});
    }

    /** Walks to a tile; it resolves when the avatar arrives or stops (blocked), at most after `timeoutMs`. */
    async walkTo(tile: Tile, timeoutMs = 15_000): Promise<boolean> {
        const me = this.world.me;
        if (!me) return false;
        if (me.x === tile.x && me.y === tile.y) return true;

        this.connection.send(Out.Move, {x: tile.x, y: tile.y});
        this.log.info(`walks to ${tile.x},${tile.y}`);

        const start = Date.now();
        // it got there at least once: on a roller it's moved away right after
        let reached = false;
        await sleep(700);

        while (Date.now() - start < timeoutMs) {
            const now = this.world.me;
            if (!now) return false;
            if (now.x === tile.x && now.y === tile.y) reached = true;
            if (reached && !now.actions.includes('Move')) return true;
            if (!now.actions.includes('Move') && Date.now() - start > 1500) return reached;
            await sleep(250);
        }

        return reached;
    }

    /** Walks next to a tile (e.g. to a furni or to a user), the free tile nearest to it. */
    async walkNextTo(target: Tile): Promise<boolean> {
        const me = this.world.me;
        if (!me) return false;
        if (distance(me, target) === 1) return true;

        const tile = this.world.freeTilesAround(target, me)[0];
        return tile ? this.walkTo(tile) : false;
    }

    /**
     * Goes on a furni: a seat or a bed (the server makes it sit/lie), or a walkable one (a roller, a pressure plate,
     * a carpet...). The avatar walks to the free tile of it nearest to it.
     */
    async goOn(furni: Furni): Promise<boolean> {
        const me = this.world.me;
        if (!me) return false;

        const tiles = this.world.seatTiles(furni).filter(t => !this.world.humanAt(t.x, t.y) || (t.x === me.x && t.y === me.y));
        tiles.sort((a, b) => distance(a, me) - distance(b, me));

        return tiles[0] ? this.walkTo(tiles[0]) : false;
    }

    /**
     * Uses a furni as a double click of the client: next to it first (a dice must be next to the avatar, a
     * teleport is walked into by the server). A dice is rolled.
     */
    async use(furni: Furni): Promise<boolean> {
        const me = this.world.me;
        if (!me) return false;

        if (furni.interaction !== 'teleport' && !furni.wall && distance(me, furni) > 1) {
            if (!(await this.walkNextTo(furni))) return false;
            await sleep(between(300, 800));
        }

        if (furni.interaction === 'dice') {
            this.connection.send(Out.DiceActivate, {id: furni.id});
        } else {
            this.connection.send(Out.UseItem, {id: furni.id});
        }

        this.log.info(`uses ${furni.name}`);
        return true;
    }

    lookAt(tile: Tile): void {
        const me = this.world.me;
        if (!me || !this.world.room || (me.x === tile.x && me.y === tile.y)) return;

        this.connection.send(Out.LookAt, {roomId: this.world.room.id, x: tile.x, y: tile.y});
    }

    gesture(action: AvatarAction, style = 1): void {
        this.connection.send(Out.Action, {action, danceStyle: style, signValue: style});
        this.log.info(`gesture ${action}`);
    }

    enterRoom(roomId: number): void {
        this.connection.send(Out.EnterRoom, {id: roomId});
        this.log.info(`enters room ${roomId}`);
    }

    /** The navigator: the active rooms ("all") and its own rooms ("my"). */
    requestRooms(): void {
        this.connection.send(Out.AllRooms);
        this.connection.send(Out.MyRooms);
    }

    /** A chat command (e.g. ":effect 69"): typed in the chat as a user does, the server runs it (nobody sees it). */
    async command(text: string): Promise<void> {
        this.connection.send(Out.Typing, {typing: true});
        await sleep((text.length / this.typingSpeed) * 1000 * between(0.8, 1.3));
        this.connection.send(Out.Typing, {typing: false});
        this.connection.send(Out.Say, {text});
        this.log.info(`command ${text}`);
    }

    // #region furni of its rooms (the server answers with the inventory, InventoryItems)

    requestInventory(): void {
        this.connection.send(Out.InventoryItems);
    }

    /** The next inventory sent by the server (after a place, a pickup, a buy): false if it doesn't come. */
    async nextInventory(timeoutMs = 4000): Promise<boolean> {
        return (await this.connection.next([In.InventoryItems], timeoutMs)) != null;
    }

    /** A floor item of the inventory placed in the room (the server checks the tile: canPlaceItemAt). */
    placeItem(itemId: number, x: number, y: number, rot: number): void {
        this.connection.send(Out.PlaceItem, {id: itemId, x, y, rot});
        this.log.info(`places item ${itemId} at ${x},${y} rot ${rot}`);
    }

    /** A wallpaper, a floor or a landscape of the inventory applied to the room. */
    applyDecoration(itemId: number): void {
        this.connection.send(Out.ApplyDecoration, {id: itemId});
        this.log.info(`applies decoration ${itemId}`);
    }

    moveFurni(entityId: string, x: number, y: number): void {
        this.connection.send(Out.MoveItem, {id: entityId, x, y});
        this.log.info(`moves furni ${entityId} to ${x},${y}`);
    }

    rotateFurni(entityId: string): void {
        this.connection.send(Out.RotateItem, {id: entityId});
        this.log.info(`rotates furni ${entityId}`);
    }

    pickupFurni(entityId: string): void {
        this.connection.send(Out.PickupItem, {id: entityId});
        this.log.info(`picks up furni ${entityId}`);
    }

    /** A new room (the layout model_a of the client): the server answers with its id, to enter it. */
    createRoom(name: string): void {
        this.connection.send(Out.CreateRoom, {
            name,
            desc: '',
            layout: MODEL_A,
            door_x: 5,
            door_y: 3,
            door_dir: 2,
            maxUsers: 25,
        });
        this.log.info(`creates the room "${name}"`);
    }

    // #endregion

    /** A new look (the others see it at once, as with the look editor of the client). */
    changeLook(look: string): void {
        this.connection.send(Out.ChangeLook, {look});
        this.log.info(`changes look: ${look}`);
    }

    requestFriends(): void {
        this.connection.send(Out.FriendsList);
    }

    askFriendship(username: string): void {
        this.connection.send(Out.FriendRequest, {username});
        this.log.info(`asks the friendship of ${username}`);
    }

    answerFriendship(userId: number, accept: boolean): void {
        this.connection.send(accept ? Out.AcceptFriend : Out.DeclineFriend, {userId});
        this.log.info(`${accept ? 'accepts' : 'declines'} the friendship of ${userId}`);
        // the list with the new friend
        setTimeout(() => this.requestFriends(), 1500);
    }

    /** A private message to a friend: typed as the chat (but nobody sees "typing"), counted in the same limit. */
    async privateMessage(userId: number, text: string): Promise<boolean> {
        const clean = text.replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!clean || !this.canSend()) return false;

        await sleep(Math.min(6000, (clean.length / this.typingSpeed) * 1000 * between(0.8, 1.3)));
        this.sent.push(Date.now());
        this.connection.send(Out.PrivateMessage, {userId, text: clean});
        this.log.info(`private message to ${userId}: ${clean}`);
        return true;
    }

    /** Goes to the room of a friend (the server sends the room to enter). */
    followFriend(userId: number): void {
        this.connection.send(Out.FollowFriend, {userId});
        this.log.info(`follows ${userId}`);
    }

    private canSend(): boolean {
        const minuteAgo = Date.now() - 60_000;
        while (this.sent.length && this.sent[0] < minuteAgo) this.sent.shift();

        return this.sent.length < MAX_MESSAGES_PER_MINUTE;
    }
}

/** The layout model_a of the create room dialog of the client (CreateRoomGUI): the door is at 5,3. */
const MODEL_A = '000000000000/000011111111/000011111111/000011111111/000011111111/000111111111/000011111111/' +
    '000011111111/000011111111/000011111111/000011111111/000011111111/000011111111/000011111111/000000000000/000000000000';

/** The commands of the server (CommandHandler, prefixes ":" and "/"): written in the chat, they are run. */
const SERVER_COMMANDS = 'effect|sit|lay|drop|credits|item|badge|bot|pickall';
const COMMAND_IN_TEXT = new RegExp(`(^|\\s)[:/](${SERVER_COMMANDS})\\b[^.!?]*`, 'gi');
const COMMAND_AT_START = new RegExp(`^[:/](${SERVER_COMMANDS})\\b`, 'i');

/** The text as chat bubbles: no roleplay stars or quotes, split at the end of a sentence when it's long. */
export function splitMessage(text: string): string[] {
    const clean = text
        // a command goes only through chat_command (the allowed ones): never in what it says. Only the real commands:
        // the server runs a message only if it starts with the name of a command (":D" or ":P" are chat)
        .replace(COMMAND_IN_TEXT, ' ')
        .replace(/\*[^*]*\*/g, '')
        .replace(/^["«“]+|["»”]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!clean || COMMAND_AT_START.test(clean)) return [];
    if (clean.length <= MAX_MESSAGE) return [clean];

    const parts: string[] = [];
    let current = '';
    for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
        if ((current + ' ' + sentence).trim().length > MAX_MESSAGE && current) {
            parts.push(current.trim());
            current = '';
        }
        current += ' ' + sentence;
    }
    if (current.trim()) parts.push(current.trim());

    return parts.map(part => (part.length > MAX_MESSAGE ? part.slice(0, MAX_MESSAGE - 1) + '…' : part));
}
