import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

interface UserMemory {
    notes: string[];
    lastSeen: number;
}

/** A room it visited: the code writes what's in it, the model its notes (remember_room). */
export interface RoomMemory {
    name: string;
    owner: string;
    visits: number;
    lastVisit: number;
    /** The visit before the current one (0 the first time). */
    previousVisit: number;
    /** What's in it, e.g. "un dado, 4 roller, 2 sedute" (written at every visit). */
    contents: string;
    notes: string[];
}

interface MemoryData {
    users: Record<string, UserMemory>;
    rooms: Record<string, RoomMemory>;
    /** The credits spent in the catalogue, per day (YYYY-MM-DD). */
    spent?: Record<string, number>;
}

const MAX_NOTES_PER_USER = 8;
const MAX_NOTES_PER_ROOM = 5;

/**
 * What the agent remembers between sessions: short notes on the users it met (the model writes them with the
 * remember tool) and the rooms it visited. It's a JSON file per persona.
 */
export class Memory {
    private readonly path: string;
    private data: MemoryData = {users: {}, rooms: {}};

    constructor(path: string) {
        this.path = path;
        if (existsSync(path)) {
            try {
                this.data = {users: {}, rooms: {}, ...JSON.parse(readFileSync(path, 'utf8'))};
            } catch {
                this.data = {users: {}, rooms: {}};
            }
        }
    }

    spentToday(): number {
        return this.data.spent?.[today()] ?? 0;
    }

    addSpent(credits: number): void {
        this.data.spent ??= {};
        this.data.spent[today()] = this.spentToday() + credits;
        this.save();
    }

    /** The room as it was at the previous visit (null the first time). */
    roomOf(id: number): RoomMemory | null {
        return this.data.rooms[String(id)] ?? null;
    }

    /** A visit to the room: what's in it now. */
    visitRoom(id: number, name: string, owner: string, contents: string): void {
        const room = (this.data.rooms[String(id)] ??= {name, owner, visits: 0, lastVisit: 0, previousVisit: 0, contents, notes: []});
        Object.assign(room, {name, owner, contents, previousVisit: room.lastVisit, lastVisit: Date.now(), visits: room.visits + 1});
        this.save();
    }

    rememberRoom(id: number, note: string): void {
        const room = this.data.rooms[String(id)];
        const text = note.trim().slice(0, 160);
        if (!room || !text || room.notes.includes(text)) return;

        room.notes.push(text);
        if (room.notes.length > MAX_NOTES_PER_ROOM) room.notes.shift();
        this.save();
    }

    notesOf(name: string): string[] {
        return this.data.users[name.toLowerCase()]?.notes ?? [];
    }

    lastSeen(name: string): number | null {
        return this.data.users[name.toLowerCase()]?.lastSeen ?? null;
    }

    /** @return false if it knew it already. */
    remember(name: string, note: string): boolean {
        const user = this.user(name);
        const text = note.trim().slice(0, 160);
        if (!text || user.notes.includes(text)) return false;

        user.notes.push(text);
        if (user.notes.length > MAX_NOTES_PER_USER) user.notes.shift();
        this.save();
        return true;
    }

    seen(name: string): void {
        this.user(name).lastSeen = Date.now();
        this.save();
    }

    private user(name: string): UserMemory {
        const key = name.toLowerCase();
        return (this.data.users[key] ??= {notes: [], lastSeen: 0});
    }

    private save(): void {
        mkdirSync(dirname(this.path), {recursive: true});
        writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    }
}

function today(): string {
    return new Date().toISOString().slice(0, 10);
}
