# Handoff: Tandem — Main Window

## Overview
Tandem is a Windows desktop app (Tauri v2) for practising spoken German: press
record, speak German, hear a German reply from an LLM tutor. This handoff covers
the **main window** UI — the header, scrolling transcript, and the record bar —
in its three live states: **Ready**, **Recording**, and **Thinking**.

The functional/architecture spec (API contract, data flow, Rust shell, mic
capture) is unchanged and included alongside this README as `original-spec.md`.
This document is the **visual** spec layered on top of it.

## About the Design Files
The files in this bundle are **design references created in HTML** — a prototype
showing the intended look and the three record-bar states, not production code to
copy directly.

- `Tandem.dc.html` — the visual prototype. It is authored as a "Design Component"
  and uses the bundled `support.js` runtime. **Open it in a browser to view**
  (keep `support.js` next to it). It renders all three states side by side on a
  presentation canvas; in the real app only one window exists, switching between
  these states at runtime.
- `support.js` — runtime needed only to view the prototype. **Do not ship it.**
- `original-spec.md` — the approved functional/architecture spec.

Per `original-spec.md`, the production frontend is **vanilla HTML/CSS/JS**
(`index.html` + `styles.css` + the `*.js` modules). Recreate the look documented
below in that vanilla frontend — translate the inline styles from the prototype
into `styles.css`. Do not import the Design-Component runtime into the app.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, and the three states are
all specified. Recreate the UI to match the hex/px values below.

## Window
- Size: **760 × 820** px content area (medium desktop window).
- Tauri v2 with a **custom titlebar** (the OS frame is hidden; the app draws its
  own 36px bar with window controls). The values below describe the app surface;
  the outer gray canvas in the prototype is just the presentation backdrop — not
  part of the app.
- Window corner radius **11px**, 1px border `rgba(255,255,255,0.08)`.

### Vertical structure (top → bottom)
| Region | Height | Notes |
|---|---|---|
| Titlebar | 36px (fixed) | window controls only, right-aligned |
| App header | 56px (fixed) | wordmark + status · New + settings |
| Transcript | flex (fills) | scrolls vertically |
| Record bar | 140px (fixed) | state-dependent |

## Design Tokens

### Colors
| Token | Hex | Use |
|---|---|---|
| Window background | `#1e1e24` | main body surface |
| Chrome surface | `#191920` | titlebar + record bar |
| Window border | `rgba(255,255,255,0.08)` | window outline |
| Titlebar border | `rgba(255,255,255,0.05)` | under titlebar |
| Section border | `rgba(255,255,255,0.06)` | under header, above record bar |
| Hairline / divider | `rgba(255,255,255,0.10)` | header divider, button borders |
| Text — primary | `#e9eaec` | wordmark |
| Text — tutor message | `#7a7870` | tutor transcript text |
| Text — your message | `#a09e95` | your ("Du") transcript text |
| Text — secondary | `#8b9099` | status label, "thinking" |
| Text — button label | `#c4c8cd` | New button, settings icon |
| Accent (gold) | `#bfa06a` | "Tutor" labels, thinking dots |
| Accent (gold, light) | `#cdb487` | mic glyph |
| Status — ok (green) | `#42c97a` | header health dot |
| Record — active (red) | `#e5484d` | recording button + waveform |
| Record — active text | `#e5848a` | recording caption |
| Muted captions | `#74767c`, `#5c6066`, `#4f5358` | record-bar captions |
| Label — your | `#6b7079` | "Du" speaker label |
| Idle button surface | `#14161a` | record button (ready/thinking) |

### Typography
- **UI / body:** `Hanken Grotesk` (weights 400, 500, 600, 700).
- **Labels / status / captions:** `JetBrains Mono` (weights 400, 500).
- Scale:
  - Wordmark "Tandem": 15px / 600 / letter-spacing −0.01em / `#e9eaec`
  - Transcript message: 15.5px / 400 / line-height 1.6 / max-width 600px
  - Speaker label: mono 10.5px / uppercase / letter-spacing 0.1em
  - Status "ready": mono 12px
  - New button: 13px / 500
  - Record-bar captions: mono 11px / letter-spacing 0.05em
  - Record-bar status line: mono 12px

### Spacing & radius
- Window radius 11px; buttons radius 7px; record button is a 62px circle.
- Header / record-bar horizontal padding 18px.
- Transcript padding `26px 26px 22px`; gap between turns 24px; gap between a
  turn's label and text 7px.
- Status dot 7px; New button padding `6px 12px`; settings button 32×32.

### Animations (keyframes)
- `tdm-ring` — 1.6s ease-out infinite, expanding red `box-shadow` halo on the
  recording button: `0 0 0 0 rgba(229,72,77,0.45)` → `0 0 0 12px transparent`.
- `tdm-wave` — 0.9s ease-in-out infinite, `scaleY` 0.35 → 1 on waveform bars,
  each bar offset with a staggered `animation-delay` (0–0.7s) for a lively meter.
- `tdm-dot` — 1.2s ease-in-out infinite, opacity 0.25 → 1, staggered 0/0.18/0.36s
  across three dots; used for the tutor typing indicator and the "thinking" dots.

## Screens / Views

### Region: Titlebar (36px, surface `#191920`)
- Right-aligned, 20px gap. Three monochrome line controls in `#6b7079`,
  ~11×11px each: **minimize** (single horizontal line), **maximize** (8px square,
  1px stroke, 1px radius), **close** (X, two crossed lines). Left side empty and
  draggable (Tauri `data-tauri-drag-region`).

### Region: App header (56px, bottom border `rgba(255,255,255,0.06)`)
- **Left group** (14px gap, vertically centered):
  - Wordmark **"Tandem"** — 15px / 600 / `#e9eaec`.
  - Vertical divider — 1px × 16px, `rgba(255,255,255,0.10)`.
  - **Status chip** (7px gap): 7px green dot `#42c97a` with glow
    `box-shadow:0 0 8px rgba(66,201,122,0.5)`, then **"ready"** mono 12px
    `#8b9099`. Bound to `GET /health` — turn the dot red and change the label
    when whisper/llm/tts is not ready.
- **Right group** (8px gap):
  - **New** button — ghost: transparent bg, 1px `rgba(255,255,255,0.10)` border,
    radius 7, padding `6px 12px`, text `#c4c8cd` 13px/500, with a 12px "+" line
    icon (stroke `#c4c8cd`) preceding the word. Starts a new conversation.
  - **Settings** button — 32×32 icon button, same border/radius. Icon is a
    15px "sliders" glyph (two horizontal lines, each with a 2px-radius knob
    circle; knob fill matches the surface `#1e1e24`), stroke `#c4c8cd`. Opens the
    settings overlay (server URL, voice, system prompt, Test connection — see
    `original-spec.md`; not drawn in this prototype).

### Region: Transcript (fills remaining height, scrolls)
- Vertical list, 24px gap between turns. Each turn = a small **speaker label**
  above its **message text** (7px gap), all left-aligned full width (no bubbles).
- **Speaker label:** mono 10.5px, uppercase, letter-spacing 0.1em.
  - Tutor → **"Tutor"** in gold `#bfa06a`.
  - You → **"Du"** in `#6b7079`.
- **Message text:** 15.5px, line-height 1.6, max-width 600px.
  - Tutor text → `#7a7870`. Your text → `#a09e95` (slightly lighter).
- Built from the `X-User-Transcript` / `X-Assistant-Text` response headers; new
  turns append at the bottom and the list auto-scrolls to the latest.
- Custom scrollbar: 9px, thumb `rgba(255,255,255,0.08)`, radius 5, 2px transparent
  inset, transparent track.
- Sample copy used in the prototype (German conversation about a Vienna trip):
  - Tutor: "Guten Tag! Worüber möchtest du heute sprechen?"
  - Du: "Hallo! Ich möchte über meinen Urlaub in Wien erzählen."
  - Tutor: "Schön! Was hast du dort gemacht, und was hat dir am besten gefallen?"
  - Du: "Ich habe Schloss Schönbrunn besucht und viel Kaffee getrunken. Der Melange war mein Favorit."
  - Tutor: "Wien ist berühmt für seine Kaffeehäuser. Die Melange passt wunderbar zu einem Stück Sachertorte — hast du das probiert?"

### Region: Record bar (140px, top border `rgba(255,255,255,0.06)`, surface `#191920`)
Vertically centered column, ~14px gap: **status line → button → caption**. The
button is always a 62px circle. The bar has three states:

**1. Ready (idle)**
- Status line: mono 12px `#5c6066` — "press to speak".
- Button: surface `#14161a`, 1px `rgba(255,255,255,0.12)` border, containing a
  22px **mic glyph** in `#cdb487` (rounded capsule + arc + stand + base lines).
- Caption: mono 11px `#74767c` — "Record".
- Behavior: click → start recording (`getUserMedia`).

**2. Recording**
- Status line replaced by a **waveform**: ~15 vertical bars, 2.5px wide, 20px
  tall, 2px radius, `#e5484d`, 3px gap, each animating `tdm-wave` with a
  staggered delay.
- Button: solid red `#e5484d`, no border, containing an 18px white rounded
  square (4px radius) = **Stop**; pulsing `tdm-ring` halo.
- Caption: mono 11px `#e5848a` — "listening · 0:06 · Stop" (live elapsed timer).
- Behavior: click → stop, encode WAV, POST the turn → transition to Thinking.

**3. Thinking (awaiting tutor reply)**
- Status line: mono 12px `#8b9099` "thinking" followed by three 4px `#8b9099`
  dots animating `tdm-dot`.
- Button: the idle mic, **dimmed** to opacity 0.38, `cursor:not-allowed`
  (disabled until the reply returns).
- Caption: mono 11px `#4f5358` — "generating reply…".
- In the transcript, the newest tutor turn shows a **typing indicator**: three
  6px gold `#bfa06a` dots animating `tdm-dot`, in place of the message text,
  until `X-Assistant-Text` arrives. The reply WAV auto-plays on arrival, then the
  bar returns to **Ready**.

## Interactions & Behavior
- **Record toggle:** click-to-start / click-to-stop (no push-to-talk in v1).
  Ready → Recording → Thinking → Ready.
- **New:** clears the transcript and starts a fresh session (`POST /conversations`
  with current settings).
- **Settings:** opens the overlay (see `original-spec.md`); voice / system-prompt
  changes apply to the next new conversation.
- **Auto-scroll:** transcript pins to the latest turn when one is appended.
- **Audio playback:** the tutor reply WAV plays automatically when received.
- Transitions are subtle; the three CSS keyframes above carry the motion.

## State (frontend)
- `serverUrl`, `voice`, `systemPrompt` — persisted in `localStorage`.
- `conversationId` — current session GUID.
- `transcript` — ordered list of `{ speaker: 'du'|'tutor', text }`.
- `recState` — `'ready' | 'recording' | 'thinking'` (drives the record bar).
- `health` — `{ whisper, tts, llm }` from `GET /health` (drives the header dot).
- `recordingElapsed` — seconds, for the live timer while recording.
- Error states (mic denied, server unreachable, `llm:false`, empty transcription)
  surface as inline status text per `original-spec.md` § Error handling.

## Assets
- **Fonts:** Hanken Grotesk + JetBrains Mono (Google Fonts). For an offline
  desktop app, bundle the font files locally rather than linking Google Fonts.
- **Icons:** all inline SVG (window controls, "+", sliders, mic, stop square) —
  no external icon assets. Recreate as inline SVG or your icon library.
- No raster images.

## Files
- `Tandem.dc.html` — visual prototype (open in a browser; needs `support.js`).
- `support.js` — prototype runtime only; **not for production**.
- `original-spec.md` — approved functional/architecture spec (API, data flow,
  Rust shell, settings, error handling, testing).
