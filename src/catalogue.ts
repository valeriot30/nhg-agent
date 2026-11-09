import {In, Out} from './protocol.ts';
import type {GameConnection} from './connection.ts';
import type {Log} from './log.ts';

/** An offer of the catalogue. */
export interface CatalogueEntry {
    /** The id of the offer (BuyItem). */
    id: number;
    /** The classname of the furni (e.g. chair_polyfon). */
    name: string;
    /** Its name in the FurnitureData of the hotel. */
    title: string;
    credits: number;
    page: string;
}

/** Words of a query that say nothing about the furni. */
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'un', 'una', 'uno', 'il', 'lo', 'la', 'i', 'gli', 'le', 'di', 'da', 'per', 'con']);
const MAX_PAGES = 400;

/**
 * The catalogue as a user sees it: the pages (CataloguePages) and the offers of each page (CatalogueItems), loaded once
 * per session at the first search, as someone who browses it. The search is on the classname of the furni, its name
 * in the FurnitureData and the title of the page.
 */
export class Catalogue {
    private readonly connection: GameConnection;
    private readonly furnidataUrl: string;
    private readonly log: Log;
    private entries: CatalogueEntry[] | null = null;
    private loading: Promise<CatalogueEntry[]> | null = null;

    constructor(connection: GameConnection, furnidataUrl: string, log: Log) {
        this.connection = connection;
        this.furnidataUrl = furnidataUrl;
        this.log = log;
    }

    async search(query: string, limit = 8): Promise<CatalogueEntry[]> {
        const entries = await this.load();
        const words = query.toLowerCase().split(/[^a-z0-9àèéìòù]+/).filter(w => w.length > 1 && !STOPWORDS.has(w));
        if (words.length === 0) return [];

        return entries
            .map(entry => {
                const name = entry.name.toLowerCase();
                const title = entry.title.toLowerCase();
                const page = entry.page.toLowerCase();
                let score = 0;
                for (const word of words) {
                    if (name.split(/[_*]/).includes(word)) score += 5;
                    else if (name.includes(word)) score += 3;
                    if (title.includes(word)) score += 3;
                    if (page.includes(word)) score += 1;
                }
                return {entry, score};
            })
            .filter(r => r.score > 0)
            .sort((a, b) => b.score - a.score || a.entry.credits - b.entry.credits)
            .slice(0, limit)
            .map(r => r.entry);
    }

    find(id: number): CatalogueEntry | undefined {
        return this.entries?.find(entry => entry.id === id);
    }

    /** Buys an offer: the server answers BuyItem (then the new credits and the inventory) or NotEnoughCredits. */
    async buy(id: number): Promise<'bought' | 'no-credits' | 'no-answer'> {
        this.connection.send(Out.BuyItem, {id});
        const answer = await this.connection.next([In.BuyItem, In.NotEnoughCredits], 8000);
        if (!answer) return 'no-answer';

        return answer.header === In.BuyItem ? 'bought' : 'no-credits';
    }

    private load(): Promise<CatalogueEntry[]> {
        if (this.entries) return Promise.resolve(this.entries);

        this.loading ??= (async () => {
            const titles = await this.furnidataTitles();

            this.connection.send(Out.CataloguePages);
            const pagesAnswer = await this.connection.next([In.CataloguePages], 8000);
            const pages: {id: number; title: string}[] = (pagesAnswer?.body?.data ?? []).slice(0, MAX_PAGES);

            const entries: CatalogueEntry[] = [];
            for (const page of pages) {
                this.connection.send(Out.CataloguePage, {id: page.id});
                const answer = await this.connection.next([In.CatalogueItems], 4000);
                for (const item of answer?.body?.data ?? []) {
                    entries.push({
                        id: item.id,
                        name: item.name,
                        title: titles.get(item.name) ?? '',
                        credits: item.credits ?? 0,
                        page: page.title ?? '',
                    });
                }
            }

            this.log.info(`catalogue: ${pages.length} pages, ${entries.length} offers`);
            this.entries = entries;
            this.loading = null;
            return entries;
        })();

        return this.loading;
    }

    /** classname -> name in the FurnitureData (empty if it can't be read: the search uses the classnames). */
    private async furnidataTitles(): Promise<Map<string, string>> {
        const titles = new Map<string, string>();
        try {
            const response = await fetch(this.furnidataUrl, {signal: AbortSignal.timeout(15_000)});
            const data = await response.json();
            for (const item of [...(data.floorItems ?? []), ...(data.wallItems ?? [])]) {
                if (item.className && item.name) titles.set(item.className, item.name);
            }
        } catch (e) {
            this.log.warn(`FurnitureData not read (${(e as Error).message}): the catalogue search uses the classnames only`);
        }
        return titles;
    }
}

/** The FurnitureData of the hotel: the web server serves it at /nitro (in dev, the assets are on the port 8080). */
export function furnidataUrl(gameUrl: string): string {
    const url = new URL(gameUrl.replace(/^ws/, 'http'));
    if (url.port === '8083') url.port = '8080';

    return `${url.protocol}//${url.host}/nitro/gamedata/json/FurnitureData.json`;
}
