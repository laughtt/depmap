# The same image runs locally (docker compose --profile full) and on Cloud Run.
FROM rust:1.99-slim AS wasm
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && rustup target add wasm32-unknown-unknown && cargo install wasm-pack --version 0.15.0 --locked
WORKDIR /app
COPY crates crates
RUN cd crates/graph-core \
 && wasm-pack build --release --target web --out-dir /out/web --out-name graph_core \
 && wasm-pack build --release --target nodejs --out-dir /out/server --out-name graph_core

FROM node:24-slim AS web
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY web web
COPY --from=wasm /out/web web/src/wasm
RUN pnpm --filter web build

FROM node:24-slim
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter server
COPY server server
COPY fixtures fixtures
COPY demo demo
COPY scripts scripts
COPY --from=wasm /out/server server/wasm
COPY --from=web /app/web/dist web/dist
USER node
EXPOSE 8080
CMD ["node", "server/src/api/main.ts"]
