# The NHG agents: Node runs the TypeScript sources directly (type stripping), no build and no runtime dependencies.
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY personas ./personas

ENV NODE_ENV=production \
    MEMORY_DIR=/data/memory
VOLUME /data

USER node
# the personas to run: AGENT_PERSONAS="personas/giulia.json personas/marco.json"
CMD ["sh", "-c", "exec node src/index.ts ${AGENT_PERSONAS:-personas/giulia.json}"]
