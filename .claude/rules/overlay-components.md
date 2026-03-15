When creating or modifying overlay components (files matching `*Overlay.tsx`, `*Panel.tsx`, `*Dialog.tsx`):

- Use `OverlayHeader` for the header (or custom header with `CloseButton`)
- Use `OverlayFooter` for keyboard hint footer bars
- Use `useOverlayFocus` hook for auto-focus on mount
- Backdrop: `absolute inset-0 z-20 bg-overlay focus:outline-hidden`
- Inner panel: `bg-surface rounded-lg border border-border-input shadow-xl`
- Use `PillToggle` for filter tabs, `SectionHeader` for group labels
- Use `FormInput`/`FormTextarea` for inputs, `PrimaryButton` for primary actions
