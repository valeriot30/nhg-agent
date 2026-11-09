import type {RoomInfo} from './world.ts';

interface Entry {
    time: number;
    /** The end, for the summary of a stay (it's shown as a range). */
    until?: number;
    text: string;
    /** The room it happened in (null for a summary). */
    roomId: number | null;
}

/** The stay in a room: what the summary says when the agent leaves it. */
interface Stay {
    roomId: number;
    name: string;
    enteredAt: number;
    people: Set<string>;
    /** The last lines of the chat (who: text). */
    lastLines: string[];
    actions: string[];
}

const MAX_ENTRIES = 14;
const SHOWN_ENTRIES = 10;

/**
 * The diary of the session: what happened, in order, across the rooms. The model sees it at every decision, so it
 * knows how it got where it is (e.g. it took a teleport) and what it was doing before. It's written by the code, not
 * by the model: when the agent leaves a room, the entries of the stay become one line.
 */
export class Journal {
    private readonly entries: Entry[] = [];
    private stay: Stay | null = null;

    /** Something the agent did or that happened to it, in the current room. */
    add(text: string, isAction = true): void {
        this.entries.push({time: Date.now(), text, roomId: this.stay?.roomId ?? null});
        if (this.stay && isAction) this.stay.actions.push(text);
        while (this.entries.length > MAX_ENTRIES) this.entries.shift();
    }

    /** The agent is in a new room (`how`: "entri", "il teletrasporto ti porta"...): the previous stay is summarized. */
    enterRoom(room: RoomInfo, how: string): void {
        if (this.stay?.roomId === room.id) return;

        this.leaveRoom();
        this.stay = {roomId: room.id, name: room.name, enteredAt: Date.now(), people: new Set(), lastLines: [], actions: []};
        this.add(`${how} nella stanza "${room.name}" (id ${room.id}) di ${room.ownerName}`, false);
    }

    /** Out of the rooms (the hotel view): the stay is summarized, then what happened. */
    exitRoom(text: string): void {
        this.leaveRoom();
        this.add(text, false);
    }

    /** Someone is in the room with the agent. */
    met(name: string): void {
        this.stay?.people.add(name);
    }

    /** A line of the chat of the room (also the agent's: "tu"). */
    chat(who: string, text: string): void {
        if (!this.stay) return;

        this.stay.lastLines.push(`${who}: "${text.slice(0, 60)}"`);
        if (this.stay.lastLines.length > 3) this.stay.lastLines.shift();
    }

    /** The room the agent is in and who was there with it (for the text of an arrival). */
    get currentRoom(): {id: number; name: string; people: string[]} | null {
        return this.stay ? {id: this.stay.roomId, name: this.stay.name, people: [...this.stay.people]} : null;
    }

    lines(): string[] {
        return this.entries.slice(-SHOWN_ENTRIES).map(entry =>
            `- ${clock(entry.time)}${entry.until ? `-${clock(entry.until)}` : ''} ${entry.text}`);
    }

    private leaveRoom(): void {
        const stay = this.stay;
        if (!stay) return;

        // the detailed entries of the stay become one line
        const start = this.entries.findIndex(entry => entry.roomId === stay.roomId && entry.time >= stay.enteredAt);
        if (start >= 0) this.entries.splice(start);

        const parts = [`eri in "${stay.name}" (id ${stay.roomId})`];
        parts.push(stay.people.size ? `con ${[...stay.people].join(', ')}` : 'senza nessuno');
        if (stay.actions.length) parts.push(`hai fatto: ${stay.actions.slice(-4).join('; ')}`);
        if (stay.lastLines.length) parts.push(`ultime frasi: ${stay.lastLines.join(' ')}`);

        this.entries.push({time: stay.enteredAt, until: Date.now(), text: parts.join(', '), roomId: null});
        this.stay = null;
    }
}

function clock(time: number): string {
    return new Date(time).toLocaleTimeString('it-IT', {hour: '2-digit', minute: '2-digit'});
}
