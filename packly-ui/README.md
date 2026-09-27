# packly-ui — Shared UI Kit

Design primitives shared across the app: the single source of visual truth
used by every screen in `src/`.

```
theme.ts        Design tokens — colors, spacing, typography, radii, shadows
components/     Button, TextField, ScreenHeader, ListRow, EmptyState,
                AddRoomModal, LeadingIcon
```

Conventions:

- Screens never hardcode colors or spacing — import tokens from `theme.ts`
- Light/dark support flows through the token layer
- `src/global.css` (Nativewind) is imported once by the theme for any
  Tailwind-based styling
