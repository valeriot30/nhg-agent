import {readFileSync} from 'node:fs';

/** Who the agent is: its account, its character, how chatty it is. */
export interface Persona {
    /** The name of its account (as the other users see it). */
    name: string;
    /** The user id of the bot account; the dev SSO is the user id. */
    userId: number;
    sso: string;
    /** Free text: character, interests, way of writing. */
    personality: string;
    /** Characters typed per second. */
    typingSpeed: number;
    /** 0..1: how often it joins a chat that isn't for it. */
    chattiness: number;
    /** 0..1: how often it greets who enters the room. */
    greetChance: number;
    /** Seconds without anything happening before it decides something on its own (a range). */
    idleSeconds: [number, number];
    /** The credits it may spend in the catalogue in a day (0: it never buys). */
    maxSpendPerDay: number;
    /** Its outfits: the model can wear one by name (else it gets a new random look). */
    wardrobe: {name: string; look: string}[];
}

const DEFAULTS: Omit<Persona, 'name' | 'userId' | 'sso' | 'personality'> = {
    typingSpeed: 6,
    chattiness: 0.3,
    greetChance: 0.6,
    idleSeconds: [45, 120],
    wardrobe: [],
    maxSpendPerDay: 50,
};

export function loadPersona(path: string): Persona {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data.name || !data.userId || !data.personality) {
        throw new Error(`${path}: name, userId and personality are required`);
    }

    return {...DEFAULTS, sso: String(data.userId), ...data};
}
