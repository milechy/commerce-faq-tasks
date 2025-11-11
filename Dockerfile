FROM node:20-bullseye
WORKDIR /workspace
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm i --frozen-lockfile
COPY . .
EXPOSE 3000
CMD ["pnpm","dev"]