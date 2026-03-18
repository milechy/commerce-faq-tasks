FROM node:20-bullseye AS builder
WORKDIR /workspace
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm i --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:20-bullseye-slim
WORKDIR /workspace
RUN corepack enable && \
    addgroup --system --gid 1001 app && \
    adduser --system --uid 1001 --ingroup app app
COPY package.json pnpm-lock.yaml ./
RUN pnpm i --frozen-lockfile --prod
COPY --chown=app:app --from=builder /workspace/dist ./dist
COPY --chown=app:app --from=builder /workspace/public ./public
COPY --chown=app:app --from=builder /workspace/config ./config
RUN mkdir -p /workspace/logs /workspace/tmp && chown -R app:app /workspace/logs /workspace/tmp
USER app
EXPOSE 3100
CMD ["node", "dist/index.js"]
