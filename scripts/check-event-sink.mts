/**
 * Services hand their events to the sink, and the sink hands each one to
 * everyone listening. Run with `npm run check:event-sink`.
 */
import { BELL, emit, emitFrom, subscribe } from '../src/main/event-sink.ts';
import { IPC_STREAM } from '../src/shared/ipc-channels.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);

{
  const a: unknown[] = [];
  const b: unknown[] = [];
  subscribe((channel, args) => a.push([channel, args]));
  const leave = subscribe((channel, args) => b.push([channel, args]));
  emit(IPC_STREAM.TOAST, 'hi', 5000);
  leave();
  emit(BELL, 'task');
  check(
    'every listener gets each event, and one that unsubscribed gets no more',
    show(a) ===
      show([
        [IPC_STREAM.TOAST, ['hi', 5000]],
        [BELL, ['task']],
      ]) && show(b) === show([[IPC_STREAM.TOAST, ['hi', 5000]]]),
    show({ a, b }),
  );
}

{
  subscribe(() => {
    throw new Error('boom');
  });
  const c: unknown[] = [];
  subscribe((channel) => c.push(channel));
  let threw = false;
  try {
    emit(IPC_STREAM.TOAST, 'x');
  } catch {
    threw = true;
  }
  check(
    'a listener that throws keeps the event from no other listener',
    !threw && c.at(-1) === IPC_STREAM.TOAST,
    show({ threw, c }),
  );
}

{
  const origins: unknown[] = [];
  subscribe((_channel, _args, origin) => origins.push(origin));
  emit(IPC_STREAM.TOAST, 'here');
  emitFrom('b', IPC_STREAM.TOAST, 'there');
  check(
    'an event relayed from another instance says where it came from',
    show(origins.slice(-2)) === show([undefined, 'b']),
    show(origins.slice(-2)),
  );
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
