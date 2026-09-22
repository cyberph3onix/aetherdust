# syntax=docker/dockerfile:1.7
# One image, two entrypoints: `api` (public) and `worker` (private; holds the sponsor seed).
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
# the dashboard is a separate image (deploy/Dockerfile.dashboard); this one only needs the api and the worker
RUN pnpm -r --filter './packages/*' --filter './apps/*' --filter '!@aetherdust/dashboard' run build
RUN pnpm prune --prod

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
COPY deploy/entrypoint.sh ./deploy/entrypoint.sh
COPY scripts ./scripts
USER node
EXPOSE 8080
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
CMD ["api"]
