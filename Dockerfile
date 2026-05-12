FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

RUN npm install -g pnpm@9

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin

RUN pnpm build:vendor

# Consumer projects mount their tests/config into /work; symlink node_modules
# so `playwright test` from /work can resolve @playwright/test from /app.
RUN mkdir -p /work && ln -s /app/node_modules /work/node_modules

ENV PORT=3939 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 3939
VOLUME ["/app/artifacts"]

CMD ["pnpm", "start"]
