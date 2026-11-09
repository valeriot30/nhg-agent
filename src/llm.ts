/** A message of Ollama's /api/chat. */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/** What the model decided: the line to say ("" for nothing) and the actions, in order. */
export interface Decision {
    say: string;
    actions: {action: string; [arg: string]: unknown}[];
}

export interface LlmReply {
    decision: Decision;
    /** Time of the request, and the tokens of the prompt and of the answer. */
    ms: number;
    promptTokens: number;
    outputTokens: number;
}

/**
 * A model served by Ollama (its native API). The answer is constrained to a JSON schema (`format`): with a local
 * model it's more reliable than the tool calls, which it often writes as text. `think: false` turns off the
 * reasoning: a chat must answer in seconds. The URL and the model come from the config.
 */
export class OllamaClient {
    private readonly url: string;
    private readonly model: string;
    private readonly timeoutMs: number;
    /**
     * Ollama's num_batch. With a hybrid model as Qwen3.6 the cache of the prompt is reused up to a checkpoint: the last
     * ~2 batches are evaluated again at every request (512 -> ~1020 tokens, ~1.9 s on two P100; 256 -> ~250 tokens,
     * ~1 s). It's an option of the loaded model: every client of that Ollama must use the same, else it's reloaded.
     */
    private readonly numBatch: number | undefined;

    /**
     * @param timeoutMs a decision takes ~3 s; much more only while Ollama loads the model (30-45 s) or serves other
     *                  clients: a short timeout throws away an answer Ollama computes anyway.
     */
    constructor(url: string, model: string, timeoutMs = 90_000, numBatch?: number) {
        this.url = url.replace(/\/$/, '');
        this.model = model;
        this.timeoutMs = timeoutMs;
        this.numBatch = numBatch;
    }

    async decide(messages: ChatMessage[], schema: object, temperature = 0.8): Promise<LlmReply> {
        const start = Date.now();
        const response = await fetch(`${this.url}/api/chat`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            signal: AbortSignal.timeout(this.timeoutMs),
            body: JSON.stringify({
                model: this.model,
                messages,
                format: schema,
                stream: false,
                think: false,
                keep_alive: -1,
                options: {temperature, num_predict: 160, ...(this.numBatch ? {num_batch: this.numBatch} : {})},
            }),
        }).catch((e: Error & {cause?: {code?: string; message?: string}}) => {
            // "fetch failed" alone doesn't say why: the address and the cause (ECONNREFUSED, ENOTFOUND, timeout...)
            throw new Error(`Ollama at ${this.url} not reachable: ${e.cause?.code ?? e.cause?.message ?? e.message}`);
        });

        if (!response.ok) throw new Error(`ollama ${response.status}: ${(await response.text()).slice(0, 200)}`);

        const data = await response.json();

        return {
            decision: parseDecision(String(data.message?.content ?? '')),
            ms: Date.now() - start,
            promptTokens: data.prompt_eval_count ?? 0,
            outputTokens: data.eval_count ?? 0,
        };
    }
}

/** The JSON of the model, tolerant: a broken answer is "do nothing". */
export function parseDecision(text: string): Decision {
    try {
        const data = JSON.parse(text);
        return {
            say: typeof data?.say === 'string' ? data.say : '',
            actions: Array.isArray(data?.actions)
                ? data.actions.filter((a: unknown) => a && typeof a === 'object' && typeof (a as any).action === 'string')
                : [],
        };
    } catch {
        return {say: '', actions: []};
    }
}
