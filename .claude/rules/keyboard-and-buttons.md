When creating or modifying interactive overlays, panels, or dialogs:

**Primary Button:**
- Only one visible primary button (`PrimaryButton`) per overlay at a time
- Enter key must trigger the primary action (unless focus is in a textarea or a dropdown is open)
- Use `PrimaryButton` component — never hand-roll accent button styles

**Mnemonics (Alt+letter):**
- Each mnemonic letter must be unique within the overlay's context
- Use `ActionLabel` to render underlined hint characters
- Show hints with `showHint={true}` (or conditionally on focus for list items)
- Footer hint bar must list all available mnemonics

**Footer:**
- Every overlay with keyboard shortcuts must have an `OverlayFooter` listing them
- Format: `↑↓ navigate · Tab cycle · ⌥R remove · Enter action · Esc close`
