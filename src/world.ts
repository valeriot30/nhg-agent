import {In} from './protocol.ts';
import type {GameConnection} from './connection.ts';

export interface Tile {
    x: number;
    y: number;
}

export interface Furni {
    id: string;
    /** The classname of the furni (e.g. chair_polyfon). */
    name: string;
    /** The interaction type (default, gate, dice, teleport, roller, dimmer...). */
    interaction: string;
    /** Floor furni have a position, wall furni don't. */
    wall: boolean;
    x: number;
    y: number;
    z: number;
    rot: number;
    sizeX: number;
    sizeY: number;
    height: number;
    allowSit: boolean;
    allowLay: boolean;
    allowWalk: boolean;
    extraData: unknown;
}

export interface Human {
    id: string;
    name: string;
    userId: number | null;
    x: number;
    y: number;
    z: number;
    rot: number;
    actions: string[];
    motto: string;
    gender: string;
    typing: boolean;
    /** The avatar effect (e.g. from an effect tile or :effect), 0 none. */
    effect: number;
    /** Where its walk started: the move is told once, when it ends (WorldEvent human-moved). */
    walkFrom: Tile | null;
}

/** The actions of an avatar that are news when they start (a gesture, sitting...). */
const NEWS_ACTIONS = ['Wave', 'Respect', 'Blow', 'Laugh', 'Dance', 'Sign', 'Sit', 'Lay', 'Sleep'];

export interface ChatLine {
    authorId: string;
    name: string;
    text: string;
    time: number;
}

export interface RoomInfo {
    id: number;
    name: string;
    ownerName: string;
    ownerId: number;
    door: Tile;
    /** heights[x][y] (as the server's RoomLayout: a row of the layout is an x), 0 when the tile isn't in the room. */
    heights: number[][];
}

export interface Friend {
    id: number;
    name: string;
    online: boolean;
}

export interface PrivateLine {
    /** The friend of the conversation. */
    friendId: number;
    fromMe: boolean;
    text: string;
    time: number;
}

export type WorldEvent =
    | {type: 'room-loaded'; room: RoomInfo}
    /** Out of the rooms (through the door, or sent away): the hotel view. */
    | {type: 'hotel-view'; from: RoomInfo | null}
    | {type: 'furni-added'; furni: Furni}
    | {type: 'furni-removed'; furni: Furni}
    | {type: 'furni-state'; furni: Furni; previous: unknown}
    | {type: 'room-painted'; what: string}
    /** Aggregated: a walk ended (not every step of it). */
    | {type: 'human-moved'; human: Human; from: Tile; to: Tile}
    /** An action started: a gesture, sitting, dancing, sleeping... */
    | {type: 'human-action'; human: Human; action: string}
    | {type: 'effect-changed'; human: Human; previous: number}
    /** Something moved by a roller (also the agent). */
    | {type: 'rolled'; id: string}
    | {type: 'friend-request'; id: number; name: string}
    | {type: 'friend-result'; status: string; name: string}
    | {type: 'private-message'; line: PrivateLine; friend: Friend | undefined}
    | {type: 'chat'; line: ChatLine}
    | {type: 'human-entered'; human: Human}
    | {type: 'human-left'; human: Human}
    | {type: 'go-to-room'; roomId: number}
    | {type: 'rooms'; rooms: NavigatorRoom[]};

/** An item of the inventory of the agent (not in a room). */
export interface InventoryItem {
    id: number;
    /** The classname of the furni. */
    name: string;
    wall: boolean;
    /** A wallpaper, a floor or a landscape: applied to the room, not placed. */
    decoration: boolean;
}

/** A room of the navigator. */
export interface NavigatorRoom {
    id: number;
    name: string;
    owner: string;
    users: number;
}

const CHAT_HISTORY = 30;

/**
 * What the agent knows of the hotel, built only from the messages of the server (as the game client): the room it
 * is in, the furni and the avatars in it, the chat. Nothing a real user couldn't see.
 */
export class World {
    readonly userId: number;
    room: RoomInfo | null = null;
    readonly furni = new Map<string, Furni>();
    readonly humans = new Map<string, Human>();
    readonly chat: ChatLine[] = [];
    /** The navigator, "all": the active rooms. */
    rooms: NavigatorRoom[] = [];
    /** The navigator, "my": the rooms of the agent. */
    myRooms: NavigatorRoom[] = [];
    /** Who invited the agent in their room (owner name, lowercase -> until when): their rooms are visitable even empty. */
    private readonly invitations = new Map<string, number>();
    readonly friends = new Map<number, Friend>();
    /** The friendship requests received and not answered: id -> name. */
    readonly friendRequests = new Map<number, string>();
    readonly privateChat: PrivateLine[] = [];
    /** The look of the agent (its avatar), e.g. hr-515-33.hd-600-1... */
    myLook = '';
    /** The credits of the agent (UpdateUserInformation), null until the server says them. */
    credits: number | null = null;
    /** Its inventory (InventoryItems): the items not placed in a room. */
    inventory: InventoryItem[] = [];
    myGender = '';
    /** The id of the avatar of the agent in the room. */
    meId: string | null = null;
    /** The short ids of the furni for the model (f1, f2...): the same for all the time in the room. */
    private readonly shortIds = new Map<string, string>();
    /**
     * False if the server doesn't send what the furni are (interaction, seat, walkable: ItemComponent of a recent
     * game build): the agent can't see seats, rollers and dice.
     */
    furniInfo = true;
    private listeners: ((event: WorldEvent) => void)[] = [];

    constructor(userId: number) {
        this.userId = userId;
    }

    get me(): Human | undefined {
        return this.meId ? this.humans.get(this.meId) : undefined;
    }

    onEvent(listener: (event: WorldEvent) => void): void {
        this.listeners.push(listener);
    }

    bind(connection: GameConnection): void {
        connection.on(In.RoomData, body => this.onRoomData(body));
        connection.on(In.RoomEntities, body => {
            this.furni.clear();
            this.shortIds.clear();
            this.humans.clear();
            this.meId = null;
            for (const entity of body?.data ?? []) this.upsert(entity, false);
            if (this.room) this.emit({type: 'room-loaded', room: this.room});
        });
        connection.on(In.AddEntity, body => this.upsert(body, true));
        connection.on(In.UpdateEntity, body => {
            for (const entity of [].concat(body?.data ?? body)) this.upsert(entity, false);
        });
        connection.on(In.RemoveEntity, body => this.remove(String(body?.data ?? body)));
        connection.on(In.Chat, body => this.onChat(body));
        connection.on(In.Typing, body => {
            const human = this.humans.get(String(body?.id));
            if (human) human.typing = !!body.typing;
        });
        connection.on(In.ObjectsRolling, body => {
            for (const move of body?.data ?? []) {
                const object = this.humans.get(move.id) ?? this.furni.get(move.id);
                if (object) {
                    Object.assign(object, {x: move.x, y: move.y, z: move.z});
                    this.emit({type: 'rolled', id: move.id});
                }
            }
        });
        connection.on(In.GoToRoom, body => {
            const roomId = Number(body?.data ?? body);
            if (Number.isFinite(roomId)) this.emit({type: 'go-to-room', roomId});
        });
        connection.on(In.RoomPaint, body => {
            const what = ({wallpaper: 'la carta da parati', floor: 'il pavimento', landscape: 'il paesaggio'} as Record<string, string>)[body?.type] ?? 'i colori';
            this.emit({type: 'room-painted', what});
        });
        connection.on(In.FriendsList, body => {
            this.friends.clear();
            for (const f of body?.friends ?? []) this.friends.set(f.id, {id: f.id, name: f.username, online: !!f.online});
            this.friendRequests.clear();
            for (const r of body?.requests ?? []) this.friendRequests.set(r.id, r.username);
        });
        connection.on(In.FriendRequestReceived, body => {
            if (body?.id == null) return;
            this.friendRequests.set(body.id, body.username);
            this.emit({type: 'friend-request', id: body.id, name: body.username});
        });
        connection.on(In.FriendRequestResult, body => {
            this.emit({type: 'friend-result', status: String(body?.status ?? ''), name: String(body?.username ?? '')});
        });
        connection.on(In.FriendMessage, body => {
            const fromMe = body?.fromId === this.userId;
            const friendId = fromMe ? body?.toId : body?.fromId;
            const line: PrivateLine = {friendId, fromMe, text: String(body?.text ?? ''), time: Date.now()};
            this.privateChat.push(line);
            if (this.privateChat.length > 40) this.privateChat.shift();
            if (!fromMe) this.emit({type: 'private-message', line, friend: this.friends.get(friendId)});
        });
        connection.on(In.UserInfo, body => {
            const user = body?.data ?? body;
            if (typeof user?.credits === 'number') this.credits = user.credits;
        });
        connection.on(In.InventoryItems, body => {
            this.inventory = (body?.data ?? [])
                .filter((item: any) => item.room_id == null || Number(item.room_id) < 0)
                .map((item: any) => ({
                    id: item.id,
                    name: item.name,
                    wall: item.item_type === 'WALL_ITEM',
                    decoration: /^(wallpaper|floor|landscape)/i.test(item.name ?? ''),
                }));
        });
        connection.on(In.MyRooms, body => {
            this.myRooms = (body?.data ?? []).map(navigatorRoom);
        });
        connection.on(In.AllRooms, body => {
            this.rooms = (body?.data ?? []).map(navigatorRoom);
            this.emit({type: 'rooms', rooms: this.rooms});
        });
    }

    // #region queries

    /** The avatars in the room but the agent. */
    others(): Human[] {
        return [...this.humans.values()].filter(human => human.id !== this.meId);
    }

    /**
     * The rooms the agent may go to, as a player choosing in the navigator: the active rooms with someone in them,
     * and its own rooms. Never the room it is in.
     */
    visitableRooms(): (NavigatorRoom & {mine: boolean})[] {
        const current = this.room?.id;
        const rooms = new Map<number, NavigatorRoom & {mine: boolean}>();

        for (const room of this.myRooms) if (room.id !== current) rooms.set(room.id, {...room, mine: true});
        for (const room of this.rooms) {
            if (room.id === current) continue;
            const mine = rooms.get(room.id);
            if (mine) mine.users = room.users;
            else if (room.users > 0 || this.isWelcomeIn(room)) rooms.set(room.id, {...room, mine: false});
        }

        return [...rooms.values()];
    }

    /** Someone invited the agent in their room: for a while their rooms are visitable even if empty. */
    invite(owner: string, ms = 10 * 60_000): void {
        this.invitations.set(owner.toLowerCase(), Date.now() + ms);
    }

    /** The active room of the navigator owned by someone (the one with more people), not the one the agent is in. */
    roomOwnedBy(owner: string): NavigatorRoom | undefined {
        const wanted = owner.trim().toLowerCase().replace(/^@/, '');
        return this.rooms
            .filter(room => room.owner.toLowerCase() === wanted && room.id !== this.room?.id)
            .sort((a, b) => b.users - a.users)[0];
    }

    /** The room of who invited the agent, or of someone in the room with it: it may go there even if it's empty. */
    private isWelcomeIn(room: NavigatorRoom): boolean {
        const owner = room.owner.toLowerCase();
        const until = this.invitations.get(owner);
        if (until && until > Date.now()) return true;

        return this.others().some(human => human.name.toLowerCase() === owner);
    }

    findFriend(name: string): Friend | undefined {
        const wanted = name.trim().toLowerCase().replace(/^@/, '');
        return [...this.friends.values()].find(friend => friend.name.toLowerCase() === wanted);
    }

    findHuman(name: string): Human | undefined {
        const wanted = name.trim().toLowerCase().replace(/^@/, '');
        return this.others().find(human => human.name.toLowerCase() === wanted);
    }

    /** The agent has rights in the room it is in: it's its own room (Room#hasRights is the owner). */
    hasRights(): boolean {
        return !!this.room && this.room.ownerId === this.userId;
    }

    // #region paths and map

    /** An avatar can walk across the tile (not only stop on it): a seat or a bed can be the end of a walk, not a passage. */
    canPass(x: number, y: number, ignore?: string): boolean {
        if (this.tileHeight(x, y) <= 0) return false;
        return this.furniAt(x, y).every(f => f.id === ignore || f.allowWalk || this.isOpenGate(f));
    }

    /**
     * The tiles reachable walking from a tile (8 directions, as the avatars), the start included. A furni can be
     * ignored (to see what changes without it).
     */
    reachable(from: Tile, ignore?: string): Set<string> {
        const seen = new Set<string>([`${from.x},${from.y}`]);
        const queue: Tile[] = [from];
        while (queue.length) {
            const tile = queue.shift()!;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const next = {x: tile.x + dx, y: tile.y + dy};
                    const key = `${next.x},${next.y}`;
                    if (seen.has(key) || !this.canPass(next.x, next.y, ignore)) continue;
                    seen.add(key);
                    queue.push(next);
                }
            }
        }
        return seen;
    }

    /** The tiles of the room (height > 0). */
    floorTiles(): number {
        return this.room ? this.room.heights.flat().filter(h => h > 0).length : 0;
    }

    /** What is on the 8 tiles around a tile (the agent by default) that can't be walked across (why a walk fails). */
    blockersAround(center?: Tile): string[] {
        const me = center ?? this.me;
        if (!me) return [];

        const blockers: string[] = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const x = me.x + dx;
                const y = me.y + dy;
                if ((dx === 0 && dy === 0) || this.tileHeight(x, y) <= 0) continue;

                const furni = this.furniAt(x, y).filter(f => !(f.allowWalk || this.isOpenGate(f)));
                for (const f of furni) {
                    const kind = f.allowSit ? 'seduta' : f.allowLay ? 'letto' : 'arredo';
                    blockers.push(`(${x},${y}) ${this.shortIdOf(f.id)} ${f.name} (${kind}: non si attraversa)`);
                }
            }
        }
        return blockers;
    }

    /**
     * The room as a small map, a row for each y: . floor, # a furni that can't be crossed, s a seat or a bed (the end
     * of a walk, not a passage), _ a furni to walk on (rug, roller...), D the door, @ the agent, P a person, space
     * not a tile.
     */
    map(): string[] {
        const room = this.room;
        if (!room) return [];

        const sizeX = room.heights.length;
        const sizeY = Math.max(0, ...room.heights.map(column => column.length));
        let minX = sizeX, maxX = -1, minY = sizeY, maxY = -1;
        room.heights.forEach((column, x) => column.forEach((h, y) => {
            if (h <= 0) return;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }));
        if (maxX < 0) return [];

        const rows: string[] = [];
        rows.push('    x ' + Array.from({length: maxX - minX + 1}, (_, i) => String((minX + i) % 10)).join(''));
        for (let y = minY; y <= maxY; y++) {
            let row = '';
            for (let x = minX; x <= maxX; x++) {
                const human = this.humanAt(x, y);
                if (this.tileHeight(x, y) <= 0) row += ' ';
                else if (human && human.id === this.meId) row += '@';
                else if (human) row += 'P';
                else if (this.isDoor(x, y)) row += 'D';
                else {
                    const furni = this.furniAt(x, y);
                    if (furni.length === 0) row += '.';
                    else if (furni.every(f => f.allowWalk || this.isOpenGate(f))) row += '_';
                    else if (furni.some(f => f.allowSit || f.allowLay)) row += 's';
                    else row += '#';
                }
            }
            rows.push(`y ${String(y).padStart(2)} ${row}`);
        }
        return rows;
    }

    // #endregion

    /** Out of the room: nothing of it is known any more. */
    leaveRoom(): void {
        this.room = null;
        this.furni.clear();
        this.humans.clear();
        this.shortIds.clear();
        this.chat.length = 0;
        this.meId = null;
    }

    /** The short id of a furni (f1, f2...), given the first time it's asked. */
    shortIdOf(furniId: string): string {
        let id = this.shortIds.get(furniId);
        if (!id) {
            id = `f${this.shortIds.size + 1}`;
            this.shortIds.set(furniId, id);
        }
        return id;
    }

    tileHeight(x: number, y: number): number {
        return this.room?.heights[x]?.[y] ?? 0;
    }

    /** The floor furni covering the tile. */
    furniAt(x: number, y: number): Furni[] {
        return [...this.furni.values()].filter(
            f => !f.wall && x >= f.x && x < f.x + f.sizeX && y >= f.y && y < f.y + f.sizeY,
        );
    }

    humanAt(x: number, y: number): Human | undefined {
        return [...this.humans.values()].find(human => human.x === x && human.y === y);
    }

    /** The agent can stop on the tile: in the room, no avatar on it, the furni on it walkable or a seat/bed. */
    /** The door tile: a walk that ends on it leaves the room (MovementComponent#exitIfOnDoor). */
    isDoor(x: number, y: number): boolean {
        return !!this.room && this.room.door.x === x && this.room.door.y === y;
    }

    /** The agent can stop on the tile without leaving the room: in the room, not the door, free, walkable. */
    canStandOn(x: number, y: number): boolean {
        if (this.tileHeight(x, y) <= 0 || this.isDoor(x, y)) return false;
        if (this.humanAt(x, y)) return false;

        return this.furniAt(x, y).every(f => f.allowWalk || f.allowSit || f.allowLay || this.isOpenGate(f));
    }

    /** The seats (and beds) of the room nobody is on. */
    freeSeats(): Furni[] {
        return [...this.furni.values()].filter(
            f => !f.wall && (f.allowSit || f.allowLay) && this.seatTiles(f).some(t => !this.humanAt(t.x, t.y)),
        );
    }

    seatTiles(f: Furni): Tile[] {
        const tiles: Tile[] = [];
        for (let x = f.x; x < f.x + f.sizeX; x++) for (let y = f.y; y < f.y + f.sizeY; y++) tiles.push({x, y});
        return tiles;
    }

    /** The free tiles next to a tile (the 8 around it), the nearest to `from` first. */
    freeTilesAround(target: Tile, from?: Tile): Tile[] {
        const tiles: Tile[] = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const tile = {x: target.x + dx, y: target.y + dy};
                if (this.canStandOn(tile.x, tile.y) || (this.me && this.me.x === tile.x && this.me.y === tile.y)) {
                    tiles.push(tile);
                }
            }
        }

        if (from) tiles.sort((a, b) => distance(a, from) - distance(b, from));
        return tiles;
    }

    /** A random free tile of the room (for a stroll), not the door. */
    randomFreeTile(): Tile | null {
        if (!this.room) return null;

        const free: Tile[] = [];
        this.room.heights.forEach((row, x) =>
            row.forEach((_, y) => {
                if (this.canStandOn(x, y) && !(x === this.room!.door.x && y === this.room!.door.y)) free.push({x, y});
            }),
        );

        return free.length ? free[Math.floor(Math.random() * free.length)] : null;
    }

    private isOpenGate(f: Furni): boolean {
        return f.interaction === 'gate' && Number(f.extraData) === 1;
    }

    // #endregion

    private onRoomData(body: any): void {
        // the room data of the id -1 is the hotel view (Room#exitThroughDoor): the client closes the room
        if (body?.id == null || body.id < 0) {
            const from = this.room;
            this.leaveRoom();
            this.emit({type: 'hotel-view', from});
            return;
        }

        const heights = String(body.layout ?? '')
            .split(/\r?\n|\//)
            .filter(row => row.length)
            .map(row => [...row].map(parseHeight));

        this.room = {
            id: body.id,
            name: body.name ?? '',
            ownerName: body.owner_name ?? '',
            ownerId: body.owner_id ?? 0,
            door: {x: body.door_x ?? 0, y: body.door_y ?? 0},
            heights,
        };
        this.chat.length = 0;
    }

    private upsert(entity: any, added: boolean): void {
        if (!entity?.id) return;

        if (entity.type === 'i') {
            const item = entity.item ?? {};
            if (item.interaction === undefined && entity.position) this.furniInfo = false;
            const previous = this.furni.get(entity.id);
            const furni: Furni = {
                id: entity.id,
                name: entity.name?.name ?? previous?.name ?? '',
                interaction: item.interaction ?? previous?.interaction ?? 'default',
                wall: entity.wallPosition != null || (previous?.wall ?? false),
                x: entity.position?.x ?? previous?.x ?? 0,
                y: entity.position?.y ?? previous?.y ?? 0,
                z: entity.position?.z ?? previous?.z ?? 0,
                rot: entity.rotation?.rot ?? previous?.rot ?? 0,
                sizeX: item.sizeX ?? previous?.sizeX ?? 1,
                sizeY: item.sizeY ?? previous?.sizeY ?? 1,
                height: item.height ?? previous?.height ?? 0,
                allowSit: item.allowSit ?? previous?.allowSit ?? false,
                allowLay: item.allowLay ?? previous?.allowLay ?? false,
                allowWalk: item.allowWalk ?? previous?.allowWalk ?? false,
                extraData: entity.interaction?.extraData ?? previous?.extraData ?? null,
            };
            this.furni.set(entity.id, furni);

            // placed while the agent is in the room (204), or its state changed (e.g. the result of a dice)
            if (added && !previous) this.emit({type: 'furni-added', furni});
            else if (previous && String(previous.extraData) !== String(furni.extraData)) {
                this.emit({type: 'furni-state', furni, previous: previous.extraData});
            }
            return;
        }

        const previous = this.humans.get(entity.id);
        const human: Human = {
            id: entity.id,
            name: entity.name?.name ?? previous?.name ?? '?',
            userId: entity.user?.id ?? previous?.userId ?? null,
            x: entity.position?.x ?? previous?.x ?? 0,
            y: entity.position?.y ?? previous?.y ?? 0,
            z: entity.position?.z ?? previous?.z ?? 0,
            rot: entity.bh_rot?.body_rot ?? previous?.rot ?? 0,
            actions: entity.action?.actions ?? previous?.actions ?? [],
            motto: entity.motto?.motto ?? previous?.motto ?? '',
            gender: entity.aspect?.gender ?? previous?.gender ?? '',
            typing: previous?.typing ?? false,
            effect: entity.effect?.id ?? previous?.effect ?? 0,
            walkFrom: previous?.walkFrom ?? null,
        };
        this.humans.set(human.id, human);

        // aggregated events: a walk is told when it ends, an action when it starts
        if (previous) {
            const walking = human.actions.includes('Move');
            const wasWalking = previous.actions.includes('Move');
            if (walking && !wasWalking) human.walkFrom = {x: previous.x, y: previous.y};
            if (!walking && wasWalking) {
                const from = previous.walkFrom ?? {x: previous.x, y: previous.y};
                human.walkFrom = null;
                if (from.x !== human.x || from.y !== human.y) this.emit({type: 'human-moved', human, from, to: {x: human.x, y: human.y}});
            }
            for (const action of human.actions) {
                if (NEWS_ACTIONS.includes(action) && !previous.actions.includes(action)) this.emit({type: 'human-action', human, action});
            }
            if (human.effect !== previous.effect) this.emit({type: 'effect-changed', human, previous: previous.effect});
        }

        if (human.userId === this.userId) {
            this.meId = human.id;
            this.myLook = entity.aspect?.look ?? this.myLook;
            this.myGender = entity.aspect?.gender ?? this.myGender;
        } else if (added && !previous) {
            this.emit({type: 'human-entered', human});
        }
    }

    private remove(id: string): void {
        const furni = this.furni.get(id);
        if (furni) {
            this.furni.delete(id);
            this.emit({type: 'furni-removed', furni});
        }

        const human = this.humans.get(id);
        if (!human) return;

        this.humans.delete(id);
        if (id === this.meId) {
            this.meId = null;
        } else {
            this.emit({type: 'human-left', human});
        }
    }

    private onChat(body: any): void {
        const author = this.humans.get(String(body?.authorId));
        const line: ChatLine = {
            authorId: String(body?.authorId),
            name: author?.name ?? '?',
            text: String(body?.text ?? ''),
            time: Date.now(),
        };

        this.chat.push(line);
        if (this.chat.length > CHAT_HISTORY) this.chat.shift();

        this.emit({type: 'chat', line});
    }

    private emit(event: WorldEvent): void {
        for (const listener of this.listeners) listener(event);
    }
}

/** The steps between two tiles (an avatar walks also diagonally). */
export function distance(a: Tile, b: Tile): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** A heightmap char as the server's RoomLayout: 0 is no tile, a digit or a letter (A = 10) is a height. */
function parseHeight(char: string): number {
    if (/[0-9]/.test(char)) return Number(char);
    if (/[a-z]/i.test(char)) return char.toUpperCase().charCodeAt(0) - 55;
    return 0;
}

function navigatorRoom(room: any): NavigatorRoom {
    return {id: room.id, name: room.name ?? '', owner: room.owner_name ?? '', users: room.users_count ?? 0};
}
