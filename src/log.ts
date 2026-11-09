/** A small logger: every line has the time and the agent name. */
export class Log {
    private readonly name: string;

    constructor(name: string) {
        this.name = name;
    }

    info(...args: unknown[]): void {
        console.log(this.prefix(), ...args);
    }

    warn(...args: unknown[]): void {
        console.warn(this.prefix(), 'WARN', ...args);
    }

    error(...args: unknown[]): void {
        console.error(this.prefix(), 'ERROR', ...args);
    }

    debug(...args: unknown[]): void {
        if (process.env.AGENT_DEBUG) console.log(this.prefix(), 'debug', ...args);
    }

    private prefix(): string {
        return `${new Date().toISOString().slice(11, 19)} [${this.name}]`;
    }
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A random number in [min, max]. */
export const between = (min: number, max: number) => min + Math.random() * (max - min);

export const chance = (p: number) => Math.random() < p;
