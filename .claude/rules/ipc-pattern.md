When adding a new IPC channel, follow all four steps:
1. Add the channel string to `IPC` or `IPC_STREAM` in `src/shared/ipc-channels.ts`
2. Add the method signature to the `BifrostAPI` interface in the same file
3. Implement the method in `src/preload/preload.ts`
4. Register the handler in `src/main/ipc-handlers.ts`

All four files must be updated together — missing any step causes runtime errors.
