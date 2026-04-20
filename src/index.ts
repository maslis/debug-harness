import { buildServer } from "./server.ts";

const PORT = Number(process.env.PORT ?? 3939);
const HOST = process.env.HOST ?? "0.0.0.0";

const { app, close } = await buildServer();
await app.listen({ port: PORT, host: HOST });

const shutdown = async () => {
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
