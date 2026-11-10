import { createReceiverApp } from './app';

const port = Number(process.env.PORT ?? 4000);
const secret = process.env.RECEIVER_SECRET ?? 'whsec_demo_local_secret';
const hangMs = Number(process.env.RECEIVER_HANG_MS ?? 6000);

const server = createReceiverApp({ secret, hangMs }).listen(port, () => {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', msg: 'receiver_listening', port }) + '\n');
});
const stop = (): void => void server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
