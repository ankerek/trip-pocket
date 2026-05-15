# Agent guidelines

## Conditional Tailwind classNames

Use the `cn()` helper from `@/tw/cn` for any conditional or composed `className`. Never concatenate Tailwind classes inside a template literal.

```tsx
// ❌ Don't — Prettier's tailwind plugin trims whitespace inside string
// literals it thinks are class lists, which silently collapses
// adjacent class fragments (e.g. `mt-2` + `flex-1` → `mt-2flex-1`,
// an unknown utility that resolves to no styles).
<View className={`mt-2 ${active ? 'flex-1' : ''}`} />

// ✅ Do — `cn()` joins arguments with spaces that Prettier can't
// touch, drops falsy values, and de-conflicts via tailwind-merge.
<View className={cn('mt-2', active && 'flex-1')} />
```

`cn()` is `clsx` + `tailwind-merge`. Accepts strings, arrays, objects, and
falsy values; later classes win on conflict.

## Format & lint at the end of work

After finishing a chunk of work (a feature, a refactor, a bugfix — not after
every individual edit), run formatter and linter before reporting done:

```bash
npx prettier --write .
npm run lint
```

Fix anything they surface. Don't bypass with `--no-verify` or
`eslint-disable` unless you can explain why the rule shouldn't apply here.
