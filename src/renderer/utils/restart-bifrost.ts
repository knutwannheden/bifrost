import type { AppAction } from '../context/AppContext';

/** Restarts Bifrost, first naming how many dev terminals that ends when any are open, unless forced. */
export async function restartBifrost(dispatch: (action: AppAction) => void, force = false): Promise<void> {
  const { restarting, devTerminals } = await window.bifrost.restartApp(force);
  if (restarting) {
    dispatch({ type: 'SHOW_TOAST', message: 'Restarting Bifrost…', duration: 30_000 });
    return;
  }
  dispatch({
    type: 'SHOW_TOAST',
    message: `Restarting Bifrost ends ${devTerminals} dev terminal${devTerminals === 1 ? '' : 's'}.`,
    duration: 15_000,
    action: { label: 'Restart anyway', callback: () => void restartBifrost(dispatch, true) },
  });
}
