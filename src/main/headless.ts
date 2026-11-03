import { startInstance, stopInstance } from './instance.ts';

startInstance().catch((err) => {
  console.error('[headless] failed to start:', err);
  process.exit(1);
});

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  stopInstance().then(
    () => process.exit(0),
    (err) => {
      console.error('[headless] failed to stop:', err);
      process.exit(1);
    },
  );
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
