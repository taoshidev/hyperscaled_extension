# Design Rules

Decisions and conventions for the Hyperscaled extension. Paste this file as context into any Claude session working on this codebase.

---

## White Opacity Scale

The UI uses translucent whites over a near-black background (`#18181b`) to create depth. Never use flat gray colors for layered text — use the opacity primitives so elements stay correct on any future dark background.

| Token | Value | Use when |
|-------|-------|----------|
| `--white-90` / `--text-strong` | 90% | Section titles, card titles — the highest readable non-primary text |
| `--white-70` / `--text-body` | 70% | Secondary values, amounts that need to be read but aren't KPIs |
| `--white-50` / `--text-subtle` | 50% | Supplemental info, muted navigation links |
| `--white-45` / `--text-label` | 45% | Field labels, balance card labels — clearly subordinate to values |
| `--white-40` / `--text-faint` | 40% | Progress bar sublabels, subtitles, secondary descriptors |
| `--white-35` / `--text-neutral` | 35% | Separators ("of"), neutral change text, mid-opacity dividers |
| `--white-30` / `--text-ghost` | 30% | Footer text, empty state messages — barely visible, decorative |
| `--text-primary` (`#ffffff`) | 100% | KPI values, primary content — the user's most important data |

**Rule:** Prefer semantic aliases (`--text-strong`, `--text-label`, etc.) in CSS rules. Use the raw primitive (`--white-90`) only if you're defining a new semantic token.

---

## Accent Surfaces

Teal (`#00c6a7`) is the brand's single interactive color. It signals: active, safe, positive, interactive.

| Token | Value | Use when |
|-------|-------|----------|
| `--accent` | `#00c6a7` | Progress fills, active indicators, `color` on accent text |
| `--green` | alias of `--accent` | **Directional/semantic use only:** positive P&L, positive balance change |
| `--accent-bg` | 10% teal | Badge backgrounds only (LONG badge, In Challenge badge) |
| `--accent-border` | 20% teal | Badge borders; also ghost button hover background |
| `--accent-hover-border` | 35% teal | Ghost button hover border only |

**Rule:** Reserve teal for **one element per visual grouping**. Never apply `--accent` to more than one text element in the same card. If two elements compete for teal, one of them is the wrong color.

**Budget:** The 380px popup has two categories of teal:
- **Semantic/directional** (always correct, exempt from budget): `--green` on positive P&L, positive change values — this is trading convention, not brand decoration. A trader reads `color: green` as "winning" before they read the number.
- **Brand accent** (3 max simultaneously): In Challenge badge, challenge progress fill, LONG position badge. That's the brand budget spent.

**Never** render a directional value in `--text-primary`. Color encodes direction before the user reads a single character.

### Button Hierarchy

Three levels. Use the lowest level that communicates the action's importance.

| Level | Use when | Pattern |
|-------|----------|---------|
| **Ghost** | Utility / setup actions (e.g. Save wallet address) | `background: transparent`, `border: --border-card`, hover reveals `--accent-border` |
| **Muted** | Dev tools / debug actions (e.g. Test Notification) | `background: --card-bg-subtle`, `border: --border-card`, hover lightens to `--card-bg` |
| **Accent** | Reserved — no primary CTA buttons exist in the current popup | `background: --accent-bg`, `border: --accent-border` |

**Ghost button hover pattern:**
```css
.btn-ghost:hover {
  border-color: var(--accent-border);  /* teal border hint, no fill */
  color: var(--text-primary);
  background: transparent;
}
```

---

## Danger Surfaces

Red signals: blocked, critical, loss, unsafe to trade.

| Token | Value | Use when |
|-------|-------|----------|
| `--danger-bg` | 8% red | Warning panel background, SHORT badge background |
| `--danger-border` | 25% red | Warning panel border, SHORT badge border |
| `--red` | `rgb(239, 68, 68)` | Text color on danger elements (title, badge text) |

**Rule:** Use `--danger-bg` and `--danger-border` as a pair — they're calibrated to work together. Don't mix one without the other. The pulsing border animation on low-balance warnings uses these same tokens so the intensity reads as the same semantic state.

---

## Indigo Surface

Indigo (`#6466f1`) is used exclusively for the Trading Capacity bar — a neutral, non-semantic indicator distinct from teal (positive/active) and amber/red (warning/loss).

| Token | Value | Use when |
|-------|-------|----------|
| `--indigo` | `#6466f1` | Capacity bar fill (gradient start) |
| `--indigo-bg` | `rgba(100, 102, 241, 0.1)` | Capacity bar track background |

**Rule:** Do not use `--indigo` for any semantic purpose (it has no directional meaning). It is a visual separator from teal and amber — one color per indicator type.

---

## Card Surfaces

Layered surfaces create depth without heavy shadows. Use the lowest opacity that achieves legibility.

| Token | Value | Use when |
|-------|-------|----------|
| `--card-bg` | 3% white | Primary/elevated card only (Funded Account, Position cards) |
| `--card-bg-subtle` | 2% white | Setup/config cards (wallet config form) |
| `--border-card` | 6% white | Standard card border |
| `--border-outer` | 8% white | Container border, stronger dividers |
| `--bar-bg` | 6% white | Progress bar tracks |

**Card usage rule:** Use cards for: Funded Account balance card (primary KPI), Position cards (grouped interactive data), Analytics link (navigational destination), Wallet Config form (first-run setup). Everything else — Trading Capacity, Challenge Progress, Drawdown — breathes directly on the background.

**Never** add box-shadows to cards — depth comes from opacity layering only.

---

## Typography Rules

### Font assignment

- **`ui-sans-serif, system-ui, sans-serif`** (`--font-ui`) — all UI chrome: labels, titles, descriptions, section headers, button text. Resolves to SF Pro on macOS, Segoe UI on Windows — native OS fonts with superior rendering vs a web-loaded font in an extension context
- **Menlo** (`--font-mono`) — all financial data, without exception: prices, sizes, symbols, percentages, leverage multipliers, P&L deltas, section values (e.g. "6.45% / 10%"). **Always pair with `font-variant-numeric: tabular-nums`.**

### Type scale

| Use | Font | Size | Weight | Notes |
|-----|------|------|--------|-------|
| Balance / KPI large | Menlo | 22px | 400 | tracking -0.44px, tabular-nums |
| Balance secondary | Menlo | 18px | 400 | tracking -0.36px, tabular-nums |
| Balance change / P&L delta | UI | 12px | 400 | `--green` or `--red` |
| Section titles (Challenge Progress, Drawdown) | UI | 14px | 600 | `--text-strong` |
| Section values (percentages, gauge readings) | Menlo | 13px | 600 | tabular-nums; challenge = `--accent`, drawdown = `--amber` |
| Capacity title | UI | 14px | 600 | `--text-strong` |
| Balance card label | UI | 11px | 400 | `--text-label`, line-height 16.5px |
| Body / misc | UI | 14px | 400 | |
| Capacity footer values | UI | 11px | 400 | `--text-faint` |
| Position PnL | UI | 12px | 600 | `--green` / `--red` |
| Trading symbols | Menlo | 12px | 600 | |
| Trading data | Menlo | 10px | 400–600 | |

### Letter-spacing on KPIs

Large monetary values use negative letter-spacing to feel precise and compact:
- 22px values: `letter-spacing: -0.44px`
- 18px values: `letter-spacing: -0.36px`

Do not apply negative tracking to body text or labels.

### Status badges and pills

Small pills (like "In Challenge", "LONG", "LOW BALANCE") use:
- Font: Inter, 10–11px, weight 500–600
- Padding: 3–5px vertical, 6–10px horizontal
- Border radius: 4–12px (use `--radius-card` for header badges, 4px for inline status badges)
- Color: always the semantic color (`--accent`, `--red`) with matching surface (`--accent-bg`/`--danger-bg`)

---

## Spacing Conventions

### Scale

4px base unit. Use tokens only — never raw pixel values for spacing.

| Token | rem | px |
|-------|-----|----|
| `--space-1` | 0.25rem | 4px |
| `--space-2` | 0.5rem | 8px |
| `--space-3` | 0.75rem | 12px |
| `--space-4` | 1rem | 16px |
| `--space-5` | 1.25rem | 20px |
| `--space-6` | 1.5rem | 24px |
| `--space-8` | 2rem | 32px |
| `--space-10` | 2.5rem | 40px |
| `--space-12` | 3rem | 48px |
| `--space-16` | 4rem | 64px |
| `--space-20` | 5rem | 80px |
| `--space-24` | 6rem | 96px |

### Application rules

- **Section margin-bottom:** `--space-3` (12px) — migrating from hardcoded `14px`; use `--space-3` for new work
- **Card padding:** `--space-3` compact · `--space-4` standard (position cards, balance cards)
- **Inner gaps (flex):** `--space-2` (8px) for inline elements; `--space-1` (4px) for tight badge/icon pairs
- **Section header margin-bottom:** `--space-2` (8px) — tight coupling between header and content
- **Progress bar height:** `10px` primary gauges · `5px` secondary bars — height encodes informational rank
- **Progress bar spacing:** `margin-top: --space-1` · `margin-bottom: --space-3`
- **Border radius ladder:** `--radius-outer` (16px) → `--radius-card` (12px) → `--radius-sm` (8px) → 4–6px badges/inputs; `5px` progress bars (track and fill must match)

---

## Transitions

All interactive elements use one of two durations:
- `0.15s ease` — buttons, border-color changes (snappy, immediate feedback)
- `0.2–0.3s ease` — color changes, width animations (progress bars), link hover states

Never use `cubic-bezier` or spring animations — keep it linear-weighted ease for a precise, technical feel.

---

## Progressive Disclosure

Configuration UI that is only needed once (or rarely) must not consume prime vertical real estate on every open. Collapse it once setup is complete.

**Pattern:** Setup UI moves into the header when configured. The expanded form card only appears on first run or when explicitly editing. Zero screen real estate is spent on configuration during normal operation.

**Wallet address — rules:**
- Collapsed state lives in `.header-right` as `.wallet-inline`: `0x34...1234`. First 4 chars of address (`0x` + 2 hex) + `...` + last 4 chars. Brevity with enough context to recognize the address.
- Address text: `--font-mono`, `--text-dim`. Edit link: `--text-ghost` at rest → `--text-subtle` on hover. No teal at any state.
- `#walletConfig` card is hidden (`display: none`) whenever a saved address exists.
- On save, collapse immediately via `showWalletCollapsed(address)`. No separate success state.
- The full form remains in the DOM (just hidden) so input values are preserved if the user cancels an edit.

---

## What This UI Should Never Have

- Gradients used decoratively (the teal glow in `.container::before` is the only allowed ambient gradient)
- Bright or white backgrounds
- Heavy drop shadows (`box-shadow` on cards)
- Rounded corners larger than `--radius-outer` (16px)
- Bold colors on more than one element in the same card/section
- Emoji used as decoration (only acceptable in functional states: ⚠️ warning, 🔔 notification)
- Font sizes below 10px or above 22px in the popup UI
