import type { Task } from '../../shared/types';
import { useApp } from '../context/AppContext';
import PrimaryButton from './PrimaryButton';

const CONTINUE_PROMPT =
  'The command you were running was killed when Bifrost exited, which is the "Error: Exit code 137" above. ' +
  'Pick up where you left off, re-running it only if its result is still needed and it is safe to repeat.';

/**
 * A turn cut off by quitting leaves work half-done, and the session cannot know
 * that on its own. Offered rather than sent: the killed command may have been
 * partly applied, which only the person who ran it can judge.
 */
export default function InterruptedBanner({ task }: { task: Task }) {
  const { dispatch } = useApp();
  if (!task.interruptedAt) return null;

  const clear = () => {
    dispatch({ type: 'UPDATE_TASK', task: { ...task, interruptedAt: undefined } });
    window.bifrost.clearInterrupted(task.id);
  };

  const when = new Date(task.interruptedAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border-default bg-warning/10 px-3 py-1.5">
      <span className="flex-1 text-xs text-secondary">
        Working when Bifrost exited on {when} — its command was killed.
      </span>
      <PrimaryButton
        size="sm"
        onClick={() => {
          window.bifrost.sendPrompt(task.id, CONTINUE_PROMPT, 'direct');
          clear();
        }}
      >
        Continue
      </PrimaryButton>
      <button
        type="button"
        onClick={clear}
        className="text-secondary hover:text-primary text-lg leading-none transition-colors"
        title="Dismiss"
      >
        &times;
      </button>
    </div>
  );
}
