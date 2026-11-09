/**
 * New looks for the avatar, valid as the ones of the look editor of the client: from the FigureData of the hotel,
 * only the selectable parts that aren't club, of the gender of the avatar (or unisex), with selectable colors.
 */

interface FigureSet {
    gender: string;
    club: string;
    selectable: string;
    colorable: string;
    parts: {colorindex: number}[];
}

interface FigureData {
    palette: Record<string, Record<string, {club: number; selectable: number}>>;
    settype: Record<string, {paletteid: string; set: Record<string, FigureSet>}>;
}

/** The parts always worn, and the accessories with the chance of wearing one. */
const MANDATORY = ['hd', 'hr', 'ch', 'lg', 'sh'];
const OPTIONAL: [string, number][] = [['ha', 0.2], ['ea', 0.15], ['cc', 0.2], ['ca', 0.15], ['wa', 0.1]];

export class LookGenerator {
    private readonly url: string;
    private data: FigureData | null = null;

    constructor(url: string) {
        this.url = url;
    }

    /**
     * A random look. The head (face and skin) of `current` is kept: a person changes clothes and hair, not face.
     *
     * @param gender MALE or FEMALE (the server doesn't change the gender of an account).
     */
    async random(gender: string, current = ''): Promise<string> {
        const data = await this.load();
        const g = gender.toUpperCase().startsWith('F') ? 'F' : 'M';
        const keptHead = current.split('.').find(part => part.startsWith('hd-'));

        // the colors of this look: 2 for each palette, the clothes match
        const themes = new Map<string, string[]>();
        const parts: string[] = [];
        for (const type of MANDATORY) {
            if (type === 'hd' && keptHead) {
                parts.push(keptHead);
                continue;
            }
            const part = this.pick(data, type, g, themes);
            if (part) parts.push(part);
        }
        for (const [type, chance] of OPTIONAL) {
            if (Math.random() < chance) {
                const part = this.pick(data, type, g, themes);
                if (part) parts.push(part);
            }
        }

        return parts.join('.');
    }

    /** "type-set-color[-color2]", or null if the type has nothing for the gender. */
    private pick(data: FigureData, type: string, gender: string, themes: Map<string, string[]>): string | null {
        const setType = data.settype[type];
        if (!setType) return null;

        const sets = Object.entries(setType.set).filter(([, set]) =>
            (set.gender === gender || set.gender === 'U') && set.selectable === '1' && set.club === '0');
        if (sets.length === 0) return null;

        const [id, set] = sets[Math.floor(Math.random() * sets.length)];
        const colorCount = set.colorable === '1' ? Math.max(1, ...set.parts.map(p => p.colorindex ?? 0)) : 0;
        if (colorCount === 0) return `${type}-${id}`;

        let colors = themes.get(setType.paletteid);
        if (!colors) {
            const all = Object.entries(data.palette[setType.paletteid] ?? {})
                .filter(([, color]) => color.selectable === 1 && color.club === 0)
                .map(([colorId]) => colorId);
            colors = [0, 1].map(() => all[Math.floor(Math.random() * all.length)]).filter(Boolean);
            themes.set(setType.paletteid, colors);
        }
        if (colors.length === 0) return `${type}-${id}`;

        const chosen = Array.from({length: colorCount}, () => colors[Math.floor(Math.random() * colors.length)]);
        return [type, id, ...chosen].join('-');
    }

    private async load(): Promise<FigureData> {
        if (this.data) return this.data;

        const response = await fetch(this.url, {signal: AbortSignal.timeout(15_000)});
        if (!response.ok) throw new Error(`FigureData ${response.status} at ${this.url}`);

        this.data = (await response.json()) as FigureData;
        return this.data;
    }
}

/**
 * The FigureData of the hotel of the game server: the web server serves it at /nhg-assets (in dev, the game is on
 * the port 8083 and the assets on the 8080).
 */
export function figureDataUrl(gameUrl: string): string {
    const url = new URL(gameUrl.replace(/^ws/, 'http'));
    if (url.port === '8083') url.port = '8080';

    return `${url.protocol}//${url.host}/nhg-assets/gamedata/json/FigureData.json`;
}
