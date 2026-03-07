FROM node:20-bullseye AS builder
WORKDIR /workspace
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm i --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:20-bullseye-slim
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm i --frozen-lockfile --prod
COPY --from=builder /workspace/dist ./dist
COPY --from=builder /workspace/public ./public
COPY --from=builder /workspace/config ./config
EXPOSE 3100
CMD ["node", "dist/index.js"]
