import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startInstance, stopInstance } from './instance.ts';

/** Where an instance on another machine says which port is its own, since api-port may name the IDE there. */
const PORT_FILE = path.join(os.homedir(), '.bifrost', 'instance-port');

startInstance()
  .then((port) => {
    if (port) fs.writeFileSync(PORT_FILE, `${port}\n`);
  })
  .catch((err) => {
    console.error('[headless] failed to start:', err);
    process.exit(1);
  });

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  fs.rmSync(PORT_FILE, { force: true });
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
process.on('SIGHUP', stop);
