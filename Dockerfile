FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

RUN npm install -g pnpm@9

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin

RUN pnpm build:vendor

ENV PORT=3939 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 3939
VOLUME ["/app/artifacts"]

CMD ["pnpm", "start"]
