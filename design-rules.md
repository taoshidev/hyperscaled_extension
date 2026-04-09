# Design Rules

Decisions and conventions for the Hyperscaled extension. Paste this file as context into any Claude session working on this codebase.

---

## Base Surfaces

| Token | Value | Use when |
|-------|-------|----------|
| `--bg` | `#18181b` | Root background for all Hyperscaled UI — popup container, injected banner. The single source of truth for the near-black base referenced throughout the design system. |

**Rule:** Never hardcode `#18181b` — always use `var(--bg)`. This keeps future theming possible.

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
| **Accent** | Reserved — no primary CTA buttons exist in the current popup | `background: --accent-bg`, `border: --accent-border` |

**Ghost button hover pattern:**
```css
.btn-ghost:hover {
  border-color: var(--accent-border);  /* teal border hint, no fill */
  color: var(--text-primary);
  background: transparent;
}
```

### Toggle Pill

Used exclusively in the Settings notification preferences. A 36×20px pill with a 14px white knob.

| State | Property | Token / Value |
|-------|----------|---------------|
| OFF | Background | `--border-card` (6% white) |
| OFF | Knob position | `left: 3px` |
| ON | Background | `--accent` |
| ON | Knob position | `left: 19px` |
| Knob | Size / color / radius | 14px / `#ffffff` / 50% |
| Pill | Width / height / radius | 36px / 20px / 10px |
| Transition | All | `0.2s ease` |

**Rule:** State is toggled via `data-state="on"` / `data-state="off"` attribute on `.settings-toggle`. JS owns the state — CSS only reads the attribute.

---

## Amber / Caution Surface

Amber (`#ffb900`) signals: approaching a limit, caution, elevated risk. It sits between teal (safe) and red (blocked) in the severity scale.

| Token | Value | Use when |
|-------|-------|----------|
| `--amber` | `#ffb900` | Drawdown values ≥ 4%, target progress ≥ 8%, warning-state bottom borders. Always paired with the ⚠ icon when used on drawdown values. |

**Rule:** Amber is a transitional state — it means "pay attention, not yet critical." If the condition worsens, the value graduates to `--red`. Never use amber and red on the same element simultaneously.

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
For Trading Capacity "Per Asset", use indigo for both the main utilization bar and asset-level sub-bars only; vary depth with opacity (track at 10-16% tint), not hue changes.

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

**Card usage rule:** Use cards for: Funded Account balance card, HL Account balance card (2-column grid), Position cards (grouped interactive data), Next Payout card (navigational destination), Analytics link (navigational destination), Wallet Config form (first-run setup). Everything else — Trading Capacity, Challenge Progress, Drawdown — breathes directly on the background.

**Never** add box-shadows to cards — depth comes from opacity layering only.

---

## Hyperliquid page toasts (content script)

Fixed-position toasts injected on the Hyperliquid trading page (`content.css` — `.hf-toast-*`). Used for order clamp feedback and registration prompts.

| Rule | Value / intent |
|------|----------------|
| Host isolation | Do **not** use `var(--bg)` / `var(--text-primary)` on toasts — Hyperliquid defines those on `:root`; a translucent `--bg` made injected toasts look “see-through.” Prefer **`#hf-toast-container`-scoped** rules in `content.css` so page `background` shorthands lose the cascade war; use literal `background: #hex none` (not only `background-color`) so host `background-image` layers are cleared. No `::before` glow on toasts — it read as transparency. |
| Shown state | `opacity: 1` on `.hf-toast-show` — must stay fully opaque over HL’s busy UI. |
| Default surface | Solid `#141416`, 14% white border, inset + outer shadow for separation from the chart. |
| `--warning` (order prevented / zero headroom) | Solid `#120f0f`, strong red border + 3px left `#f87171`, title `#fecaca`, body ~94% white, light text-shadow for legibility on busy pixels. |
| `--alert` (clamped but non-zero) | Solid `#1a1712`, amber border + 3px left `#ffb900`, title `#fcd34d`. |
| `--info` | Solid `#141416`, teal border + 3px left `#00c6a7` — no translucent “glass” fill. |
| `--blocked` (manual over-limit attempt) | Compact red-leaning toast (`280px` width) with title `#f87171`, concise reason line, and a click-to-expand helper panel (`.hf-toast-details`) that explicitly answers **what is happening, why it is blocked, and how to avoid it**. |

**Expandable blocked helper rule:** Keep the first line brief and actionable; put explanatory copy behind a button (`.hf-toast-details-toggle`, label "Why blocked?"). The expanded panel uses a low-contrast red tint (`rgba(248,113,113,0.05)`), 10px text, and three structured bullets (`What`, `Why`, `How to avoid`) so traders can skim under pressure.

---

## Typography Rules

### Font assignment

- **`ui-sans-serif, system-ui, sans-serif`** (`--font-ui`) — all UI chrome: labels, titles, descriptions, section headers, button text. Resolves to SF Pro on macOS, Segoe UI on Windows — native OS fonts with superior rendering vs a web-loaded font in an extension context
- **Menlo** (`--font-mono`) — all financial data, without exception: prices, sizes, symbols, percentages, leverage multipliers, P&L deltas, section values (e.g. "6.45% / 10%"). **Always pair with `font-variant-numeric: tabular-nums`.**

### Type scale

| Use | Font | Size | Weight | Notes |
|-----|------|------|--------|-------|
| Balance value | Menlo | 19px | 700 | tracking -0.38px, tabular-nums — both Funded and HL cards |
| Payout value (inline card) | Menlo | 18px | 700 | tracking -0.36px, tabular-nums, `--accent` |
| Payout value (claimable hero) | Menlo | 28px | 800 | tracking -0.56px, tabular-nums, `--accent` |
| Balance change / P&L delta | UI | 11px | 400 | `--green` or `--red` |
| Section titles (Challenge Progress, Drawdown, Capacity) | UI | 12px | 600 | `--text-strong` |
| Section values (percentages, gauge readings) | Menlo | 12px | 700 | tabular-nums; challenge header = `--accent`; drawdown uses `--amber` on Daily/Trailing row values only |
| Drawdown row values (Daily / Trailing) | Menlo | 11px | 400 | tabular-nums; `--amber`, paired with row labels in UI font |
| Balance card label | UI | 10px | 400 | `--text-label`, uppercase, letter-spacing 0.08em |
| Body / misc | UI | 14px | 400 | |
| Capacity footer values | UI | 11px | 400 | `--text-faint` |
| Capacity asset mini-bars | Menlo | 10px | 600 (symbol) / 400 (value) | symbol `--text-secondary`, value `--text-faint`; value text is right-aligned tabular `used / max` |
| Position PnL | UI | 12px | 600 | `--green` / `--red` |
| Trading symbols | Menlo | 12px | 600 | |
| Trading data | Menlo | 10px | 400–600 | |

### Letter-spacing on KPIs

Large monetary values use negative letter-spacing to feel precise and compact:
- 19px values: `letter-spacing: -0.38px`
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
- **Progress bar height:** `10px` — all bars use a uniform height for visual consistency
- **Progress bar spacing:** `margin-top: --space-1` · `margin-bottom: --space-1`
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

## Screen States

The popup has three mutually exclusive screen states, toggled via `style.display` in JS:

| State | Trigger | Visible sections | Hidden sections |
|-------|---------|-----------------|-----------------|
| **Not Registered** | No wallet address saved | Header + `#walletConfig` (not-registered screen) + Footer | Pending, all active-trading sections, Positions, Payouts, Settings |
| **Pending** | Address saved, no active challenge | Header + `#pendingScreen` + Footer | walletConfig, all active-trading sections, Positions, Payouts, Settings |
| **Active** | Address saved, active challenge found | Header + walletCollapsed + balance/capacity/challenge/drawdown/positions/events + Footer | walletConfig, pendingScreen, Positions, Payouts, Settings |
| **Payouts** | Payout card tapped from Active | Header + `#payoutsScreen` + Footer | All active-trading sections |
| **Settings** | Settings entry point tapped | Header + `#settingsScreen` + Footer | All active-trading sections |

**Rule:** Screen toggling is JS-only via `style.display`. CSS defines the layout for each screen; JS owns the state machine. Never use CSS classes for screen visibility toggling.

### Progress bar height

All progress bars use a uniform `10px` height for visual consistency. No height-based hierarchy — bar purpose is distinguished by color alone (teal = challenge, amber = drawdown/pending, indigo = capacity). Current Drawdown is represented as two stacked amber bars (Daily and Trailing), each still `10px`.

---

## Banner Dropdown Panel

The injected banner's Daily/Trailing stat group is clickable and opens a dropdown panel with detailed drawdown rules.

### Trigger
- `.hf-dd-trigger` on the `.hf-dd-stack` element
- `cursor: pointer`, `opacity: 0.75` on hover, `0.15s ease` transition
- Click toggles `.hf-dd-panel--open` on the panel; clicking outside dismisses

### Panel surface
| Property | Value |
|----------|-------|
| Position | `absolute`, `top: 38px` (below bar), left-aligned to trigger |
| Background | `#13161A` (slightly lighter than `--bg`) |
| Border | `1px solid --border-card`, no top border (visually attaches to bar) |
| Border-radius | `0 0 --radius-card --radius-card` (bottom corners only) |
| Padding | `--space-4` |
| Width | `560px` |
| Shadow | `0 16px 40px rgba(0,0,0,0.7)` |
| z-index | `999998` (one below banner) |

### Layout
- `display: grid`, `grid-template-columns: 1fr 1fr`, `gap: --space-3`
- Header (full-width): title `--text-strong` 14px 700, subtitle `--text-subtle` 11px
- Each column: dot (8px circle, indigo or amber) + uppercase title + status badge
- 4 data rows per column: key `--text-subtle` 12px, value `--font-mono` 12px 600 tabular-nums
- Footer (full-width): `--text-ghost` 10px, separator `|` at 0.3 opacity

### Status badges
| State | Color | Background | Border |
|-------|-------|------------|--------|
| Safe | `--accent` | `--accent-bg` | `--accent-border` |
| Warning | `--amber` | `rgba(255,185,0,0.10)` | `rgba(255,185,0,0.20)` |
| Breached | `--red` | `--danger-bg` | `--danger-border` |

**Rule:** Badge state is derived from the drawdown percentage: < 4% = Safe, 4–5% = Warning, >= 5% = Breached. Same thresholds as `ddColor()`.

---

## Injected Banner Blocked State

When orders are blocked due to insufficient remaining capacity, the banner uses the `hf-blocked` class for behavior only (messaging + trade lock state), not a danger surface tint.

| Element | Treatment |
|---------|-----------|
| `.hf-bar` bottom border | `--border-card` (neutral) |
| Optional inline blocked text/icon | `--text-subtle` |
| Optional sub-strip surface | `rgba(255,255,255,0.03)` + `1px solid --border-card` |
| Optional sub-strip CTA | Neutral ghost treatment (`--border-card`, `--text-subtle`) |

**Rule:** Capacity-blocked state should read as constrained, not breached. Reserve red danger surfaces for true loss/drawdown breach semantics only.

---

## Info Expand (Educational Tooltips)

Inline expandable explanations that educate users about trading concepts and metrics. A small circle-i icon next to section headers toggles a collapsible text panel.

### Toggle button (`.info-toggle`)
| Property | Value |
|----------|-------|
| Size | Inline, 12×12px SVG icon |
| Color (rest) | `--text-faint` (40%) |
| Color (hover) | `--text-subtle` (50%) |
| Color (expanded) | `--accent` |
| Margin-left | `4px` from label text |
| Transition | `0.15s ease` on color |

### Expand panel (`.info-expand`)
| Property | Value |
|----------|-------|
| Font | `--font-ui`, 11px, weight 400, line-height 1.6 |
| Color | `--text-subtle` (50%) |
| Padding | `6px 0 8px` when visible |
| Animation | `max-height` transition, `0.25s ease` |
| Item labels | `--text-body` (70%), weight 600 via `<strong>` |

**Rule:** Explanations are educational only — they should describe what a metric means and how it affects the user. Never use info-expand for error messages or warnings.

**Rule:** Keep explanation text concise (2–3 sentences max). Traders glance, they don't read paragraphs.

---

## Order events list (pagination)

The dashboard **Order Events** section shows validator order activity. When there are more events than fit a single view, pagination keeps the popup scannable.

| Element | Treatment |
|---------|-----------|
| Page size | `8` events per page (`EVENTS_PER_PAGE` in `popup/events.js`) |
| Controls | Prev / next ghost-style icon buttons (`.events-page-btn`), same hover pattern as other ghost controls: `border-color: var(--accent-border)`, `color: var(--accent)` when enabled |
| Range label | Centered `11px`, `var(--text-faint)`, tabular nums — e.g. `1–8 of 24` |
| Container | `.events-pagination`: top border `var(--border-card)`, `margin-top` / `padding-top` `--space-2`, horizontal flex with `--space-3` gap |
| Visibility | Pagination row is `hidden` when total events ≤ page size, or when there is no list (wallet missing, error, empty) |

**Rule:** Header badge (`.events-count`) continues to show the **total** filtered event count, not the current page only.

---

## Trading Capacity — Unified Block with Toggle

Trading capacity is a single block with a segmented toggle (`HL | Hyperscaled`) in the header. Both views share the same indigo bar pattern and structure; the toggle swaps which scale is visible.

1. **HL view** (default) — based on HL spot + perps equity. These are the enforced limits the trader works within.
2. **Hyperscaled view** — the same limits mirrored proportionally to the funded account size (`HL values × mirrorRatio`). Speaks the same scale as challenge target and drawdown.

| Element | Treatment |
|---------|-----------|
| Toggle container | `rgba(255,255,255,0.04)` bg, `border-radius: 6px`, `padding: 2px`, `gap: 2px` |
| Toggle button | `10px`, `--font-ui`, `500 weight`, `--text-faint` default, `--text-body` when active |
| Toggle active bg | `rgba(255,255,255,0.08)`, `border-radius: 4px` |
| Basis note (HL) | `10px`, `--font-ui`, `--text-faint` — e.g. "Based on HL equity of $1,000" |
| Basis note (HS) | Same style — e.g. "Mirrored from HL at 10.0x — based on account size of $100,000" |
| Basis values | `--font-mono`, `--text-body` — inline monospace for dollar amounts and ratios |
| Multiplier badge | `10px`, `--font-mono`, `--text-subtle`, `margin-left: 4px` — on HL view row labels only |

**Rule:** "Total Portfolio" is renamed to **"Total Available Size"** in both views to avoid confusion with the trader's overall portfolio.

**Rule:** The HS view mirrors HL values by a constant ratio — the percentage fills are identical between the two views (same utilization, different scale). This lets the trader see "$625 used on HL = $6,250 on my $100k account" at a glance.

**Rule:** The toggle uses `hidden` attribute on `.capacity-view` containers. Both views remain in the DOM and are populated on every data refresh — the toggle only controls visibility.

---

## Mirror Preview Card (Content Script)

A floating card that appears below the order size input on the Hyperliquid trading page. Shows the HL order notional, mirrored amount on the funded account, and a capacity impact bar.

| Property | Value |
|----------|-------|
| Position | Fixed, below the active size input (8px gap), clamped to viewport |
| Width | `220px` |
| Background | `#141416` (solid, no translucency) |
| Border | `1px solid rgba(255,255,255,0.08)` |
| Border radius | `10px` |
| Shadow | `0 8px 24px rgba(0,0,0,0.6)`, subtle white inset glow |
| Row labels | `11px`, `rgba(255,255,255,0.45)` |
| HL value | `12px / 500`, Menlo, `rgba(255,255,255,0.85)` |
| Mirror value | `12px / 600`, Menlo, `#00c6a7` (teal) |
| Mirror ratio | `10px`, Menlo, `rgba(255,255,255,0.3)`, parenthesized |
| Capacity title | `9px / 600`, uppercase, `rgba(255,255,255,0.3)` |
| Capacity pct | `11px / 600`, Menlo, color shifts with usage (indigo → amber → red) |
| Capacity bar | `5px` height, indigo fill, two segments (current + pending) |
| Capacity detail | `10px`, Menlo, `rgba(255,255,255,0.35)` |
| Transition | `opacity 0.15s ease`, `translateY 0.15s ease` |
| Pointer events | None (does not interfere with order entry) |

**Capacity bar colors:** Default indigo (`#6466f1`), pending segment at 40% opacity. Above 70% usage: amber (`#ffb900`). Above 90%: red (`rgb(239,68,68)`).

**Rule:** The card is non-interactive (`pointer-events: none`). It disappears 1.5s after the input loses focus. If mirror ratio is unavailable (data loading), the mirror row is hidden but HL order and capacity still display. Uses solid-background approach to avoid host CSS interference.

---

## Side Panel

The extension supports Chrome's Side Panel API for pinning the dashboard alongside the trading page.

| Property | Value |
|----------|-------|
| Width | Fills available panel width (`width: 100%`, `min-width: 300px`) |
| Container | No border, no border-radius (panel provides its own chrome) |
| Pin button | Hidden when already in side panel context (`body[data-context="sidepanel"]`) |

**Rule:** The side panel reuses the same popup HTML/CSS/JS — no separate component library needed. The only adjustments are removing the fixed 380px width and the container's decorative border.

---

## Pin Button (Header)

A ghost icon button in the header that opens the extension as a side panel.

| Property | Value |
|----------|-------|
| Size | `28px × 28px`, centered SVG icon |
| Default | `transparent` bg, `--border-card` border, `--text-faint` icon color |
| Hover | `--accent-border` border, `--text-primary` icon color |
| Transition | `0.15s ease` on border-color and color |
| Hidden | When `chrome.sidePanel` API unavailable; when in side panel context |

---

## What This UI Should Never Have

- Gradients used decoratively (the teal glow in `.container::before` is the only allowed ambient gradient)
- Bright or white backgrounds
- Heavy drop shadows (`box-shadow` on cards)
- Rounded corners larger than `--radius-outer` (16px)
- Bold colors on more than one element in the same card/section
- Emoji used in the UI — use inline SVG icons instead (⚠ warning icon is the only remaining text symbol, acceptable in data contexts)
- Font sizes below 10px or above 22px in the popup UI
