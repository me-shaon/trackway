---
name: Trackway
description: Why your code is the way it is
colors:
  cloud-white: "#fcfcfa"
  cloud-sunk: "#f5f5f2"
  slate-ink: "#22262c"
  slate-ink-secondary: "#565c64"
  slate-ink-tertiary: "#6a7179"
  hairline: "#e6e6e1"
  hairline-strong: "#d6d6d0"
  fringe-mint: "#3f9a7c"
  fringe-rose: "#c25f7c"
  fringe-violet: "#7a5cb8"
  fringe-dispersed: "#9aa0a7"
typography:
  display:
    fontFamily: "Commissioner, 'Helvetica Neue', system-ui, sans-serif"
    fontSize: "38px"
    fontWeight: 200
    lineHeight: 1.14
    letterSpacing: "-0.022em"
  headline:
    fontFamily: "Commissioner, 'Helvetica Neue', system-ui, sans-serif"
    fontSize: "25px"
    fontWeight: 200
    lineHeight: 1.45
    letterSpacing: "-0.014em"
  title:
    fontFamily: "Commissioner, 'Helvetica Neue', system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 300
    lineHeight: 1.4
    letterSpacing: "-0.008em"
  body:
    fontFamily: "Commissioner, 'Helvetica Neue', system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.15em"
rounded:
  hairline: "2px"
spacing:
  xs: "4px"
  sm: "12px"
  md: "26px"
  lg: "40px"
  gutter: "168px"
  inset: "56px"
components:
  band:
    textColor: "{colors.slate-ink-tertiary}"
    typography: "{typography.body}"
    padding: "4px 0 11px"
  band-active:
    textColor: "{colors.slate-ink}"
    typography: "{typography.body}"
    padding: "4px 0 11px"
  option-taken:
    textColor: "{colors.slate-ink}"
    typography: "{typography.body}"
    padding: "9px 0"
  option-dropped:
    textColor: "{colors.slate-ink-secondary}"
    typography: "{typography.body}"
    padding: "9px 0"
  tab:
    textColor: "{colors.slate-ink-tertiary}"
    typography: "{typography.body}"
    padding: "10px 0 13px"
  tab-active:
    textColor: "{colors.slate-ink}"
    typography: "{typography.body}"
    padding: "10px 0 13px"
  field-search:
    backgroundColor: "{colors.cloud-white}"
    textColor: "{colors.slate-ink}"
    padding: "5px 0"
---

# Design System: Trackway

## Overview

**Creative North Star: "The Iridescent Cloud Edge"**

A newly formed cloud stays plain white. Only at its boundary, where sunlight diffracts through droplets that happen to match in size, does it grow a narrow fringe of mint, rose and violet. That is the whole system. The reading surface is achromatic and colour is confined to a hairline at the edge of each record, carrying one fact and no more: how much this record matters.

The system runs on subtraction. There is no card, no chip, no badge, no pill, no coloured label anywhere in the interface. A record is a column of type in a wide white margin, and the things that would normally be chrome (who decided, when, which kind) sit in a right-aligned margin column beside the heading rather than stacked above it. What is left carries the reading.

Confirmed anti-reference: the developer-tool dashboard this replaced. Sidebar, filter chips, bordered cards, one blue accent, a badge on every row. The user's own words for it were "very basic". Its predictable opposite, near-black with a neon accent, was rejected in the same round.

**Key Characteristics:**
- Colour appears only at edges, never in a text field
- Hierarchy from scale and weight, never from hue
- No enclosing containers of any kind
- Wide margins and a 60–68ch measure
- Monospace strictly for measured values

## Colors

Cloud white and slate, with three spectral hues that never touch type.

### Primary
- **Fringe Mint** (`#3f9a7c`): the fringe on a technical record, and the check mark on the option that was taken.
- **Fringe Rose** (`#c25f7c`): the fringe on a product record.
- **Fringe Violet** (`#7a5cb8`): the fringe on a record the developer directed. Also the focus ring, because the developer's own attention belongs at the same end of the spectrum as their own decisions.

### Tertiary
- **Fringe Dispersed** (`#9aa0a7`): the achromatic end of the spectrum. Working detail, and any decision later superseded.

### Neutral
- **Cloud White** (`#fcfcfa`): the ground. Warm enough not to read as screen white.
- **Cloud Sunk** (`#f5f5f2`): the only recessed surface, used in the loading shimmer.
- **Slate Ink** (`#22262c`): headings and the option that was taken.
- **Slate Ink Secondary** (`#565c64`): body copy and the reasoning on every option, taken or not.
- **Slate Ink Tertiary** (`#6a7179`): the margin column, counts, dates. Never a full sentence.
- **Hairline** (`#e6e6e1`) and **Hairline Strong** (`#d6d6d0`): rules and the unfilled part of a spectrum bar.

### Named Rules

**The Achromatic Field Rule.** No text is ever coloured by its category. The four significance kinds are told apart by a 2px fringe at the record's edge and by a word in the margin. A coloured heading, a coloured chip, or a tinted row background breaks the system outright.

**The Removal Rule.** Unticking a kind removes those records. An earlier version dimmed them in place to show the reader what they had excluded; in use it read as a rendering fault, not a filter. The counts carry that information instead: every checkbox and every topic reports what it holds, so nothing is hidden without being counted.

## Typography

**Display Font:** Commissioner (with 'Helvetica Neue', system-ui, sans-serif)
**Body Font:** Commissioner
**Label/Mono Font:** IBM Plex Mono (with ui-monospace, SFMono-Regular, Menlo)

Both are served from `public/fonts` as woff2, latin and latin-ext only, 102 KB in
total. The product promises the explorer opens with no network, so no font may
come from a CDN.

**Character:** One humanist sans across the whole range, worked from 200 to 500. The low weights at large sizes are what makes the surface quiet; a heavier display cut would turn the questions into headlines and the record into a feed.

### Hierarchy
- **Display** (200, 38px, 1.14, -0.022em): the chosen option on the Decisions stage. One per screen.
- **Headline** (200, 25px, 1.45, -0.014em): the Overview's opening sentence, capped at 36ch.
- **Title** (300, 20px, 1.4, -0.008em): a record's question, and topic headings at 22px. Capped at 68ch, steps to 18px below 720px.
- **Body** (400, 16px, 1.6): option labels and reasoning. Measure 60–68ch.
- **Label** (400, 11.5px, 0.15em, uppercase): section titles and the "not taken" divider. Mono at the same size carries dates, counts and record ids.

### Named Rules

**The Measured-Value Rule.** Monospace appears only where a value is measured: a date, a count, a record id, a file path. It is never used to make prose look technical.

**The No-Eyebrow Rule.** Nothing is stacked above a heading. Kind, attribution and date live in a right-aligned margin column to the heading's left, or fold beneath the text below 720px.

## Layout

One centred container, `max-width: 1280px`, inset 40px (26px below 1120px, 18px below 820px). Every view sits on the same three tracks: a 244px rail, a 1px rule, and the reading column, with 42px of gap either side of the rule. The column caps at 840px. Moving between views moves content and nothing else.

The rule is its own grid track rather than a border on the rail, because a border stops where the rail's content ends and leaves the taller column unseparated.

A record is a two-column grid: a 168px margin column, right-aligned, and the text column beside it. Below 820px the grid collapses to one column, the rail unstacks above the reading column, and the record's margin folds beneath its text.

Vertical rhythm: 26px above a record's text, 40px below it, 30px above a topic heading and 14px below, so a heading always sits closer to what it introduces. The header is sticky with a 10px backdrop blur over a 92% ground.

Below 720px the record's margin column moves beneath its text and lays out as a wrapping row, and the fringe runs the full block.

## Elevation & Depth

No shadows anywhere. Depth is optical, not spatial: a fringe of colour, a blurred bleed beside it, and hairline rules. Surfaces never lift off the ground because nothing in this world is an object sitting on another object.

### Named Rules

**The One Boundary Rule.** An element declares itself with a hairline rule or with a fringe, never with both plus a shadow. There is no such thing as a bordered, shadowed surface in this system.

## Shapes

There are no containers, so there is no card radius. The only radius in the system is 2px, and it belongs to the things that are essentially lines: the fringe, the band underline, the spectrum bar, the focus ring.

Rules are 1px hairlines. Fringes are 2px. Nothing is thicker.

## Components

### The Fringe (signature)

One absolutely positioned pseudo-element on a record's text column: a 2px band carrying a vertical gradient, full colour at the top edge, 40% at 44%, transparent by 82%. That fade is what makes it a fringe rather than a rail; a fringe running the full height is the failure mode this system was corrected out of once already. It sits at 82% opacity and reaches full on hover.

It carried a second layer, an 11px blurred bleed, until that layer was removed: at any zoom the pair read as a rendering fault rather than as light. One mark, not a mark plus a glow.

### Kind checkboxes (the filter)

The four significance kinds as real checkboxes in the rail: a 16px box that fills with the kind's own colour when ticked, the label, and a right-aligned mono count. The first version set them as plain words over a fading underline and people could not tell what was on. A checkbox says it in the one shape everyone already reads.

Rows are 44px tall. Below 820px they lay out two-up.

### Options (the list you were offered)

An 18px mark column and the content beside it. Taken: a drawn check in the record's own fringe colour, label at 500 in primary ink. Not taken: a drawn cross in tertiary ink, label at 400 in secondary ink. The two groups are separated by a hairline and an uppercase mono "Not taken".

### Topic list

Rows of title plus mono count, 44px tall. A topic holding nothing under the current filters is disabled rather than hidden, so the list does not reshuffle as filters change; past eight topics a filter field appears above it, and empty topics fold behind one line. Below 820px the empty ones are hidden outright, because above the reading column they are scroll the reader pays for before reaching a record.

### Navigation

Tabs are plain words at 14.5px with a 2px underline in primary ink on the current one. No pills, no background, no border.

### Inputs

The search field is a bottom hairline and nothing else. Focus deepens the rule from `hairline-strong` to `slate-ink-secondary`; the native cancel button is removed.

### Spectrum bar

A 2px track in `hairline-strong` whose filled portion runs from full tone to 34% transparent, so the bar disperses at its end rather than stopping flat. It is not a progress bar and must never be labelled as one.

## Do's and Don'ts

### Do:
- **Do** put every category signal in the 2px fringe and the margin word. Nothing else encodes kind.
- **Do** keep running text between 60 and 68ch, and headings under 68ch.
- **Do** draw icons as SVG at `stroke-width: 1.5`, `round` caps and joins, on a 16 viewbox.
- **Do** remove filtered-out records, and report what they held in the counts beside every control.
- **Do** reserve IBM Plex Mono for dates, counts, ids and paths, with `font-variant-numeric: tabular-nums`.
- **Do** define every colour on bare `:root` and redefine only tokens under both `prefers-color-scheme: dark` and `[data-theme="dark"]`.
- **Do** give every interactive element the same 2px focus ring at 3px offset, inputs included.
- **Do** keep every interactive target at 44px or taller, and put a field's padding on the field rather than its wrapper.

### Don't:
- **Don't** introduce a card, a chip, a badge, a pill or a tinted row. There are no containers in this system.
- **Don't** let a fringe run the full height of its record. It fades out by 82% or it is a rail.
- **Don't** colour any text by its category, including headings and counts.
- **Don't** add a shadow. Depth here is a blurred colour bleed and a hairline, nothing else.
- **Don't** stack a kicker, eyebrow or label above a heading.
- **Don't** use monospace for prose, or a unicode glyph where an icon belongs.
- **Don't** use a radius above 2px anywhere.
- **Don't** load a typeface, script, or stylesheet from another host. The explorer opens with no network.
- **Don't** give a view its own page shape. The rail and the reading column are the only structure.
