import {In, Out} from './protocol.ts';
import {Log, sleep} from './log.ts';

type Handler = (body: any) => void;

/**
 * The websocket to the game server, as the game client: login with the SSO, a ping every 30 s, the messages
 * dispatched by header. If the connection drops it reconnects (and logs in again).
 */
export class GameConnection {
    private readonly url: string;
    private readonly sso: string;
    private readonly log: Log;
    private readonly handlers = new Map<number, Handler[]>();
    private ws: WebSocket | null = null;
    private ping: ReturnType<typeof setInterval> | null = null;
    private closed = false;
    /** Called after every (re)login. */
    onLogin: () => void = () => {};

    constructor(url: string, sso: string, log: Log) {
        this.url = url;
        this.sso = sso;
        this.log = log;
    }

    on(header: number, handler: Handler): void {
        const list = this.handlers.get(header) ?? [];
        list.push(handler);
        this.handlers.set(header, list);
    }

    /** The next message with this header (e.g. the answer to a request), null after `timeoutMs`. */
    next(headers: number[], timeoutMs = 5000): Promise<{header: number; body: any} | null> {
        return new Promise(resolve => {
            const handlers: [number, Handler][] = [];
            const done = (value: {header: number; body: any} | null) => {
                clearTimeout(timer);
                for (const [header, handler] of handlers) {
                    const list = this.handlers.get(header) ?? [];
                    this.handlers.set(header, list.filter(h => h !== handler));
                }
                resolve(value);
            };
            const timer = setTimeout(() => done(null), timeoutMs);
            for (const header of headers) {
                const handler: Handler = body => done({header, body});
                handlers.push([header, handler]);
                this.on(header, handler);
            }
        });
    }

    send(header: number, body: object = {}): void {
        if (this.ws?.readyState !== WebSocket.OPEN) return;

        this.log.debug('->', header, JSON.stringify(body));
        this.ws.send(JSON.stringify({header, body}));
    }

    async connect(): Promise<void> {
        let delay = 1000;

        while (!this.closed) {
            try {
                await this.open();
                return;
            } catch (e) {
                this.log.warn(`connection to ${this.url} failed (${(e as Error).message}), retry in ${delay / 1000}s`);
                await sleep(delay);
                delay = Math.min(delay * 2, 30_000);
            }
        }
    }

    close(): void {
        this.closed = true;
        if (this.ping) clearInterval(this.ping);
        this.ws?.close();
    }

    private open(): Promise<void> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url);
            let logged = false;

            ws.onopen = () => {
                this.ws = ws;
                ws.send(JSON.stringify({header: Out.Login, body: {sso: this.sso}}));
            };

            ws.onmessage = event => {
                let message: {header: number; body: any};
                try {
                    message = JSON.parse(String(event.data));
                } catch {
                    return;
                }

                if (message.header === In.LoginResult && !logged) {
                    logged = true;
                    this.ping = setInterval(() => this.send(Out.Ping), 30_000);
                    resolve();
                    this.onLogin();
                }

                for (const handler of this.handlers.get(message.header) ?? []) {
                    try {
                        handler(message.body);
                    } catch (e) {
                        this.log.error(`handler of ${message.header}:`, e);
                    }
                }
            };

            ws.onerror = () => {
                if (!logged) reject(new Error('websocket error'));
            };

            ws.onclose = () => {
                if (this.ping) clearInterval(this.ping);
                this.ws = null;

                if (!logged) {
                    reject(new Error('closed before the login (wrong SSO?)'));
                } else if (!this.closed) {
                    this.log.warn('disconnected, reconnecting');
                    void this.connect();
                }
            };
        });
    }
}
