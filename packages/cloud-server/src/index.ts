import 'dotenv/config';
import { config } from './config';
import { buildApp } from './app';

async function main() {
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`MemCode cloud server running on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
