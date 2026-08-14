---
name: Summit
description: Field-first roofing OS — flat ink, glass cards, color used as seasoning
colors:
  graphite: "#111111"
  mist: "#f3f5f8"
  raised: "#ffffff"
  chrome: "#d5dae2"
  chrome-line: "#e2e6ec"
  steel: "#5c6066"
  accent-blue: "#6ba6ff"
  accent-green: "#7bc9a6"
  danger: "#ff7a7a"
  stage-lead: "#f5d36b"
  stage-prospect: "#ffb07a"
  stage-approved: "#7bc9a6"
  stage-completed: "#6ba6ff"
  stage-invoiced: "#ff7a7a"
  night-ground: "#111111"
  metal-ink: "#f3f5f8"
typography:
  display:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
  body:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.08em"
  caption:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "normal"
  figure:
    fontFamily: "Plus Jakarta Sans, system-ui, sans-serif"
    fontSize: "2.34375rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.03em"
rounded:
  sm: "6px"
  md: "24px"
  lg: "32px"
  pill: "9999px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
  page-x: "clamp(1rem, 2.5vw, 1.5rem)"
  page-y: "clamp(1.25rem, 2vw, 1.75rem)"
  card: "1.25rem"
components:
  button-primary:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.metal-ink}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.metal-ink}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.graphite}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.steel}"
    padding: "8px 2px"
  card-glass:
    backgroundColor: "rgba(255, 255, 255, 0.3)"
    textColor: "{colors.graphite}"
    rounded: "{rounded.lg}"
    padding: "{spacing.card}"
  input:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
---

# Design System: Summit

## Overview

**Creative North Star: "Flat Ink, Seasoned"**

Summit looks like a field clipboard, not a SaaS dashboard. The ground is cool mist (`#f3f5f8`) with a faint page wash. Primary actions are flat graphite ink — not chrome, not gradient candy. Color is seasoning: a short list of hues used sparingly for status, signals, and pipeline stages.

Day and night share the same seasoning hexes. Night inverts ground and ink (`#111111` / `#f3f5f8`) so the app can be used after dark without a second palette. Glass cards are the default surface: low fill so the page wash reads through; menus and drawers stay opaque so type never sits on blur.

Rejected: Warm Trade cozy linen / terracotta. Also rejected: carnival motion, purple SaaS, and helper blurbs under titles.

**Key Characteristics:**
- One type family (Plus Jakarta Sans); weight and tracking carry hierarchy
- Pill CTAs in graphite ink; quiet outline and text siblings
- Glass list cards at 32px radius; solid ink panels only when a block must command
- Color as seasoning, never as a wash across the screen
- Phone, tablet, and desk share the same shell (estimator-first width, not sparse)

## Colors

Cool mist ground, graphite ink, and a closed seasoning set. Night flips ground and ink; seasoning hexes do not change.

### Primary
- **Graphite** (`#111111`): ink for type, primary CTAs, Closed stage, night ground. The voice of the product.
- **Mist** (`#f3f5f8`): day page ground and night ink. Not pure white.

### Secondary
- **Signal Blue** (`#6ba6ff`): links, focus rings, Completed stage, selected calendar days. Not a brand wash.
- **Work Green** (`#7bc9a6`): positive money, Approved stage, success seasoning.

### Tertiary
- **Coral** (`#ff7a7a`): danger and Invoiced. Same hue for error and that stage — do not invent a second red.
- **Lead Gold** (`#f5d36b`) / **Prospect Peach** (`#ffb07a`): pipeline stages only.

### Neutral
- **Raised White** (`#ffffff`): day raised cards and opaque menus.
- **Chrome** (`#d5dae2`) / **Chrome Line** (`#e2e6ec`): borders and rails.
- **Steel** (`#5c6066`): secondary type, text buttons, hints.

### Named Rules
**The Seasoning Rule.** Only the named accent hues. Color is a pinch on graphite and mist, not a second theme.

**The Same-Hex Night Rule.** Night remaps ground and ink. Seasoning hexes stay put. Do not author a night-only blue or green.

## Typography

**Display Font:** Plus Jakarta Sans (system-ui, sans-serif)
**Body Font:** Plus Jakarta Sans (same family)
**Label/Mono Font:** Plus Jakarta Sans; tabular numerals on money and counts

**Character:** One voice. Hierarchy is weight and tracking, never a second family.

### Hierarchy
- **Display** (800, 1.875rem / 2.25rem, −0.03em): page titles (`h1`, `.page-title`).
- **Headline** (700, 1.25rem, −0.02em): card and roof-pick labels.
- **Title** (600, 1rem): section heads and primary row titles.
- **Body** (400, 1rem, 1.5): reading copy. Night body is 500 with a hair of tracking.
- **Label** (500, 0.75rem, 0.08em uppercase): overlines and chips. Do not use as body.
- **Caption** (400, 11px / 0.6875rem): stat labels under figures (Doors, Hail, Convos). Not a heading.
- **Figure** (800, 2.34375rem, −0.03em): commanding numbers on Home glimpse cards (Canvassing Today).

### Named Rules
**The One Family Rule.** Plus Jakarta Sans only in the app UI. A second display face is a redesign, not a tweak.

## Layout

Estimator-first: content sits in a shared shell around `--page-max` (72rem / 1152px), with `--page-pad-x` and `--page-pad-y`. Not sparse marketing width, not full-bleed sprawl. Header is `--header-h` (3.5rem phone / 4rem from 640px, plus safe-area). Sidebar is an icon rail that expands to labels on desktop. Phone, iPad, and laptop share the same screens; density tightens, structure does not fork.

## Elevation & Depth

Hybrid: glass cards refract the page wash; menus are opaque; a few solid ink panels command. Depth is a short lift on hover (`translateY(-2px)`), not a heavy drop shadow language.

### Shadow Vocabulary
- **Glass** (`var(--glass-shadow)` plus inset highlight): default cards.
- **Menu** (`0 18px 40px -16px rgba(17,17,17,0.22)`): drawers and popovers — opaque.
- **Card rest** (`0 10px 15px -3px rgb(0 0 0 / 0.1)`): `.card` / lead cards.
- **Card hover** (`0 20px 25px -5px rgb(0 0 0 / 0.1)`): lift, do not rest here.

### Named Rules
**The Opaque Menu Rule.** Type in a menu or drawer never sits on glass. Frost is for cards, not for controls that must be read.

## Shapes

Pills for actions (9999px). Large soft rectangles for list cards (32px) and roof picks (24px). Small radius (6px) only on text-button focus and tight fields. Recurring silhouette: rounded rectangle card + pill CTA. No hard 4px Material chips as the default.

## Components

### Buttons
- **Shape:** pill (9999px)
- **Primary:** graphite ink fill, mist type, 8×16 padding (14×32 for full-width footers). Hover brightens and lifts 1px; press scales to 0.97.
- **Secondary:** outline, no fill, glass border.
- **Text:** steel type, no chrome; Forgot / Today / Connect.

### Chips
- **Style:** pill, graphite type, 0.75rem / 600. Roof chips and stage dots use seasoning fills, not grey pills.

### Cards / Containers
- **Corner Style:** 32px list cards; 24px roof picks
- **Background:** glass (low fill) by default; opaque white/night steel for menus; solid graphite/blue/green/coral when a block must command
- **Shadow Strategy:** glass + short hover lift
- **Border:** 1px glass or chrome line
- **Internal Padding:** 1.25rem (1.5rem from 640px)

### Inputs / Fields
- **Style:** raised surface, chrome line, 16px minimum type on touch
- **Focus:** 2px graphite outline on picks; blue ring (`--accent-blue-ring`) on secondary/text buttons
- **Error:** coral, same as danger — no extra red

### Navigation
Sidebar rail + top header. Active destination is ink, not a colored blob. Touch targets in header/sidebar are 44px on coarse pointers. Safe-area insets on notch devices.

### Glass card (signature)
Default card material. Fill stays low so the page wash shows through. Optional `--glass-tint` is a faint seasoning gradient (blue / coral / green), never a solid fill. `prefers-reduced-transparency` drops blur to a flat panel.

## Do's and Don'ts

### Do:
- **Do** use graphite ink for the primary action and mist for the page.
- **Do** keep seasoning hues rare — status, stages, one signal per view.
- **Do** write a title and an action; skip the subtitle that restates the screen.
- **Do** keep pinch-zoom and 16px inputs on phones.

### Don't:
- **Don't** introduce a second type family or a chrome/gradient CTA.
- **Don't** author a night-only palette; invert ink and ground only.
- **Don't** revive Warm Trade linen / terracotta, purple SaaS, or carnival motion.
- **Don't** invent prices, coverage numbers, or testimonials in the UI.
