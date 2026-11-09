import {Agent} from './agent.ts';
import {loadPersona} from './persona.ts';

/**
 * node src/index.ts personas/giulia.json [personas/other.json ...]
 * One agent per persona, all in this process. The config is in the environment:
 *   GAME_WS       the websocket of the game server (default ws://127.0.0.1:8083/nhg/game)
 *   OLLAMA_URL    the Ollama server (default http://127.0.0.1:11434)
 *   OLLAMA_MODEL  the model (default qwen3.6:35b-a3b)
 *   MEMORY_DIR    where the memory of the agents is saved (default ./memory)
 *   FIGUREDATA_URL the FigureData of the hotel, for the new looks (default: /nhg-assets of the web server of GAME_WS)
 *   OLLAMA_NUM_BATCH Ollama's num_batch (256: ~1 s faster per answer; all the clients of that Ollama must use the same)
 *   OLLAMA_TIMEOUT_MS how long a decision is waited for (default 90000)
 *   AGENT_DEBUG   set it to log the packets and the observations
 */
const paths = process.argv.slice(2);
if (paths.length === 0) {
    console.error('usage: node src/index.ts personas/<name>.json [...]');
    process.exit(1);
}

const config = {
    gameUrl: process.env.GAME_WS ?? 'ws://127.0.0.1:8083/nhg/game',
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
    model: process.env.OLLAMA_MODEL ?? 'qwen3.6:35b-a3b',
    memoryDir: process.env.MEMORY_DIR ?? './memory',
    figureDataUrl: process.env.FIGUREDATA_URL,
    numBatch: process.env.OLLAMA_NUM_BATCH ? Number(process.env.OLLAMA_NUM_BATCH) : undefined,
    timeoutMs: process.env.OLLAMA_TIMEOUT_MS ? Number(process.env.OLLAMA_TIMEOUT_MS) : undefined,
};

const agents = paths.map(path => new Agent(loadPersona(path), config));

process.on('SIGINT', () => {
    for (const agent of agents) agent.stop();
    process.exit(0);
});

console.log(`model ${config.model} at ${config.ollamaUrl}, game ${config.gameUrl}`);

// Ollama is checked at the start: a wrong OLLAMA_URL is seen at once, not at the first decision
try {
    const response = await fetch(`${config.ollamaUrl.replace(/\/$/, '')}/api/tags`, {signal: AbortSignal.timeout(5000)});
    const models: string[] = ((await response.json()).models ?? []).map((m: {name: string}) => m.name);
    if (!models.includes(config.model)) console.warn(`WARN Ollama at ${config.ollamaUrl} has not the model ${config.model} (it has: ${models.join(', ')})`);
} catch (e) {
    const cause = (e as {cause?: {code?: string}}).cause?.code ?? (e as Error).message;
    console.warn(`WARN Ollama at ${config.ollamaUrl} not reachable (${cause}): check OLLAMA_URL`);
}

// the agents connect a few seconds apart, as people do
for (const agent of agents) {
    void agent.start();
    await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 4000));
}
