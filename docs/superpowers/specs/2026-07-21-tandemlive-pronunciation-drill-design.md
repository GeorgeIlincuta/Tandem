# TandemLive — Pronunciation Drill Mode (Design)

Date: 2026-07-21
Status: approved (brainstorm), pending implementation plan
Work repo: `C:\LOCAL FILES\Claude Code\Tauri\TandemLive`
Coordination repo: `C:\LOCAL FILES\Claude Code\Tauri\tandem` (holds this spec + the plan)

Related: `2026-07-20-tandem-streaming-rust-design.md` (the streaming conversation app this
extends), `TandemLive/design_handoff_tandem_main_window/drill-mode-README.md` (visual handoff).

## 1. Goal

Let the learner find out how they actually pronounce a German word, how it should sound, and
what specifically to fix. One word at a time, in a tight retry loop.

Explicit non-goals:

- **No pronunciation scoring during conversation.** The conversation view is untouched.
- **No drill queue, no progress counter, no word list.** The page holds exactly one target word.
- **No integration with the transcript.** Nothing flags words during a turn or feeds them here.

These were live options during brainstorming and were cut deliberately: the drill page is
purely analytical.

## 2. Why a target word is required

Scoring compares two phoneme strings:

- **Expected** — the target word's text through grapheme-to-phoneme: `Vielleicht` → `/fiˈlaɪçt/`
- **Actual** — the recorded audio through a phoneme recognizer: e.g. `/fiˈlaɪkt/`

The mismatch is the feedback: `ç` was expected, `k` was produced — the ich-Laut. Without a
target text there is no expected string, so the system can report which sounds were made but
never that any were wrong.

Whisper's transcript was considered as an implicit reference and **rejected**. Whisper has a
language model and hears through an accent: a sloppy `Vielleicht` still transcribes as
"Vielleicht" (helpful), but a badly mispronounced one transcribes as something else entirely,
and the learner is then scored against a word they never intended — silently, and confidently.
It fails exactly when it is most needed.

Therefore the target word is always explicit: typed by the learner, or generated on request.

## 3. Engine

New Rust module `src-tauri/src/pron/`, a peer of `stt/` and `tts/`.

| Unit | Responsibility | Depends on |
|---|---|---|
| `g2p.rs` | German text → expected IPA phones, per syllable | `espeak-ng` crate |
| `phones.rs` | 16 kHz mono f32 → recognized IPA phones | `ort` (already used by TTS) |
| `align.rs` | expected vs recognized → per-phone verdicts | pure |
| `feedback.rs` | worst confusion pair → syllable scores + tip text | bundled rule table |

### 3.1 Data flow (one attempt)

```
target word ──> g2p ────────> expected phones ─┐
                                               ├─> align ─> per-phone verdicts
mic WAV ──> decode 16k ──> phones ─> actual ───┘             │
                                                             v
                                                syllable rollup + tip lookup
```

### 3.2 Model

`facebook/wav2vec2-xlsr-53-espeak-cv-ft`, exported to ONNX and run through `ort` — the same
runtime already loaded for Supertonic TTS. It emits IPA phone labels directly and is trained
multilingual including German. Session handling copies the `Supertonic` pattern: sessions
behind a scoped `Mutex`, DirectML attempted with CPU fallback.

Model files live under `models/pron/`, alongside `models/whisper` and `models/supertonic`,
resolved by the same exe-relative-with-CWD-fallback config logic.

### 3.3 Reuse

- `decode_wav_to_16k_mono_f32` (currently in `stt/mod.rs`) is exactly the decode / downmix /
  resample the phoneme model needs. It moves to a shared location rather than being duplicated.
- The **Listen** button calls the existing `speak_text` command. This command is currently
  dev-only and listed in `TODO.md` as a dead surface to strip; it becomes load-bearing.

### 3.4 Alignment

Needleman–Wunsch edit-distance alignment over phone sequences, not a positional zip: the
recognizer inserts and drops phones, so the alignment must yield substitutions, deletions and
insertions. Unit cost for substitution/indel; no phonetic distance weighting in v1.

This is the only algorithmic component and it is pure — testable with hand-written phone pairs,
no model required.

### 3.5 Syllable rollup

The design displays **orthographic** syllables (`Viel` / `leicht`) with a colored bar under each,
while scoring happens on phones. Letter-to-sound mapping is avoided entirely:

1. `hyphenation` crate (German TeX patterns) splits the word: `Vielleicht` → `Viel·leicht`.
2. Each syllable is phonemized separately by `espeak-ng`, giving the phone count it owns.
3. Those counts partition the expected phone sequence, so each syllable owns a known phone span.
4. A syllable's score is the worst verdict among its phones.

This sidesteps the `sch` (three letters, one sound) and context-dependent `ch` (`/ç/` vs `/x/`)
problems that a letter-by-letter mapping would hit.

### 3.6 Feedback text

A bundled rule table keyed on the confusion pair — expected phone + produced phone → a written
German-specific tip (ich-Laut vs ach-Laut, `ü`/`u`, `ö`/`o`, final devoicing, uvular `r`).
Deterministic, instant, offline, and correct because a human wrote it once. Confusions with no
table entry fall back to a generic "this syllable needs work" line naming the syllable.

An LLM-written tip was considered and rejected: it adds seconds to every attempt on a page whose
entire value is a tight retry loop, requires LM Studio, and small local models give unreliable
phonetics advice.

### 3.7 Score threshold

The visual design specifies a binary green/red bar per syllable, but the model produces graded
per-phone confidence. The binary display is kept; the threshold that produces it lives in config
rather than being hardcoded, so it can be tuned against real speech. A scorer that is too harsh
is worse than no scorer.

## 4. Frontend

### 4.1 A view state, not a second window

The handoff offers `drill.html` or an in-app view state. **In-app view state.** TandemLive is a
single `index.html` with a custom titlebar and one `AppState`; a second window would duplicate
the chrome, create a second mic-permission surface, and race the first for the shared
`AudioPlayer`. `showView('drill' | 'conversation')` swaps the header and body; the titlebar and
record bar persist.

Entry: a "Drill" toggle in the main header beside the wordmark. Exit: "Back" in the drill header.

### 4.2 Layout

```
┌ Titlebar ─────────────────────── 36px   (unchanged)
├ Drill header ─────────────────── 56px   Back │ "Drill"
│
│   [ Ein deutsches Wort…       ] [ Surprise me ]
│
│                  Vielleicht                       52px / 700
│                  /fiˈlaɪçt/                       mono 15px
│                  ( Listen )
│
│                  Viel   leicht                    22px
│                  ▔▔▔▔   ▔▔▔▔▔▔                    green #42c97a / red #e5484d
│
│         "leicht" — the "ch" sound needs work      mono 12px #e5848a
│
├ Record bar ───────────────────── 140px  "press to try again"
```

Tokens, typography and record-bar states come from the handoff unchanged; no new colors.

Removed from the handoff: `drillQueue`, `drillIndex`, the "3 / 5" progress counter, the "from
your last conversation" eyebrow, and the "Drill this word" entry from the transcript. The eyebrow
slot is reused for the input row. `lastAttempt` is retained as specified.

Note: the handoff's *main-window* `README.md` describes the superseded .NET HTTP architecture
(`serverUrl`, `POST /conversations`, `X-Assistant-Text` headers). Only its visual half applies.

### 4.3 Frontend state

- `drillWord` — `{ word, ipa, syllables[] }` or null
- `lastAttempt` — `{ syllables: [{ text, score }], feedback }` or null
- `recState` — `'ready' | 'recording' | 'thinking'`, the existing enum

## 5. Commands

Plain commands returning values — **no events**. A conversation turn streams and therefore needs
`turn:*`; a drill attempt is one short round-trip with nothing to progressively reveal.

| Command | Signature | Notes |
|---|---|---|
| `drill_set_word` | `(word: String) -> DrillTarget` | G2P + hyphenation only, no audio |
| `drill_suggest_word` | `() -> String` | one non-streaming LM Studio call |
| `drill_score` | `(audio: Vec<u8>, word: String) -> DrillResult` | on `spawn_blocking` |
| `speak_text` | existing | the Listen button |

`DrillTarget = { word, ipa, syllables: [String] }`
`DrillResult = { syllables: [{ text, score }], feedback: String, ipa_actual: String }`

`score` is the binary verdict `"good" | "needs_work"` — the threshold from §3.7 is applied in
Rust, so the frontend only ever picks a color and never owns scoring policy.

"Surprise me" writes its result into the same input box, so generated and typed words flow
through one identical path.

## 6. Error handling and degradation

Follows the precedent set by Task 17 (graceful degradation for missing models):

- `AppState.pron` is `Option<...>`; `health()` gains a `pron: bool`.
- A missing or unloadable phoneme model disables the Drill toggle with an explanatory caption.
  The app still starts and the conversation view is unaffected.
- "Surprise me" is disabled when `llm: false`; typing a word still works.
- `espeak-ng` failing on unphonemizable input (empty, digits, non-Latin) surfaces as an inline
  message on the input, not an exception.
- Empty or silent recordings produce an inline "nothing was recorded" state, not a scored result.
- Input is capped at a single word or short phrase; longer input is rejected inline.

Entering the drill view calls `player.stop()` and bumps the turn generation counter, so a tutor
reply still playing cannot talk over the first attempt. That machinery exists from fix wave 2;
this is an additional caller, not new concurrency.

## 7. Testing

Mirrors the existing split between pure unit tests and model-gated integration tests:

**Unit (always run)**
- `align.rs`: substitution, insertion, deletion, exact match, empty input
- syllable partition: phone spans sum to the full sequence; multi-syllable and monosyllable
- `feedback.rs`: known confusion pair → expected tip; unknown pair → generic fallback
- threshold: graded confidences → expected binary syllable verdicts

**Gated on model files present**
- `g2p`: known German words → expected IPA
- Supertonic → phoneme round-trip: synthesized `Vielleicht` scores as correct
- a deliberately wrong phone sequence scores the expected syllable as incorrect

## 8. Implementation order

**Phase 0 — spike, and it is allowed to kill the feature.** Before any UI work: export the model
to ONNX, run three German WAVs through `ort`, print expected vs recognized IPA. If a correct
`Vielleicht` and a deliberately mispronounced one do not produce visibly different phone strings,
stop and reconsider rather than building a page on a scorer that cannot score.

Everything downstream of the spike is pure or follows an established pattern in this codebase, so
the spike carries essentially all of the technical risk.

Subsequent phases: engine units (`g2p`, `align`, `feedback` — all testable without the model) →
`phones.rs` + model loading + health → commands → drill view → styling to the handoff.

## 9. Impact on existing TODO.md

- `speak_text` moves from "dead surface to strip before release" to load-bearing.
- "No HTTP timeouts anywhere" rises in priority: "Surprise me" adds a second UI path that can
  hang on an LM Studio JIT model load.
