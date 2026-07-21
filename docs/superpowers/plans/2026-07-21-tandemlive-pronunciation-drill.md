# TandemLive Pronunciation Drill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a drill view to TandemLive where the learner types a German word, hears it, says it, and sees which syllables were mispronounced plus one specific tip.

**Architecture:** A new `src-tauri/src/pron/` module scores one attempt by comparing two IPA phone strings — the expected string from `espeak-ng` grapheme-to-phoneme, and the actual string from a wav2vec2 phoneme ONNX model run through the `ort` runtime the app already loads for TTS. A Needleman–Wunsch alignment between them yields per-phone verdicts, which roll up onto orthographic syllables from German hyphenation. The frontend gains a `'drill'` view state inside the existing single window.

**Tech Stack:** Rust, Tauri v2, `ort` 2.0.0-rc.7 (ONNX Runtime), `espeak-ng` crate (G2P), `hyphenation` crate (German TeX patterns), `hound` (WAV decode), vanilla JS frontend.

**Spec:** `docs/superpowers/specs/2026-07-21-tandemlive-pronunciation-drill-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **REPO GUARDRAIL — read this first.** All code changes land in `C:\LOCAL FILES\Claude Code\Tauri\TandemLive`, **not** in the `tandem` repo that holds this plan. A previous plan lost work to exactly this mistake. Before **any** `git commit`, verify both:
  - `git rev-parse --show-toplevel` ends in `TandemLive`
  - `src-tauri/src/llm/client.rs` exists
- **Build toolchain.** `cargo` fails with ``is `cmake` not installed?`` in a fresh shell. Dump the MSVC dev env once and replay it: `cmd /c "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && set`, replay each `KEY=VALUE` into the shell env, then add `LIBCLANG_PATH=C:\Program Files\LLVM\bin` (vcvars does not set it). The `18\Community` install under `Program Files` has no compiler — it is a decoy. `vcvars64.bat` prints a benign `'vswhere.exe' is not recognized` warning; ignore it.
- **Run cargo from `TandemLive/src-tauri`.**
- **Graceful degradation is mandatory.** A missing or unloadable model file must never abort `setup()`. Follow the existing `Option<Engine>` + `require()` pattern in `src-tauri/src/state.rs`.
- **No lock held across an `.await`.** The codebase has zero instances; keep it that way. Blocking ORT calls go through `tokio::task::spawn_blocking`.
- **`cargo fmt` and zero warnings** before every commit: `cargo fmt` then `cargo clippy --all-targets`.
- **Design tokens are fixed.** Colors, fonts and sizes come verbatim from `TandemLive/design_handoff_tandem_main_window/drill-mode-README.md`. Introduce no new colors.
- **UI copy is English** (matching the existing record bar: "Record", "thinking", "press to speak"). Only the drilled words themselves are German.
- **Model files are not committed.** They live under `models/pron/`, reached by the existing `models` junction in dev.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `src-tauri/src/pron/mod.rs` | Module root; `PronScorer` facade tying the four units together |
| `src-tauri/src/pron/align.rs` | Needleman–Wunsch phone alignment; pure |
| `src-tauri/src/pron/g2p.rs` | German text → expected IPA + syllable partition |
| `src-tauri/src/pron/phones.rs` | ONNX phoneme recognition from WAV bytes |
| `src-tauri/src/pron/feedback.rs` | Syllable rollup + confusion-pair tip table; pure |
| `src-tauri/src/audio_decode.rs` | Shared WAV → 16 kHz mono f32 (moved out of `stt/mod.rs`) |
| `src-tauri/tests/pron_integration.rs` | Model-gated end-to-end scoring tests |
| `scripts/export_phoneme_model.py` | One-time ONNX export of the HF model |
| `src/drill.js` | Drill view controller |

**Modified:**

| Path | Change |
|---|---|
| `src-tauri/src/config.rs` | `pron_model_dir`, `pron_score_threshold` settings |
| `src-tauri/src/state.rs` | `pron: Option<PronScorer>`, `pron()`, `pron_ready()` |
| `src-tauri/src/lib.rs` | Load scorer in `setup`, register 3 commands, module decl |
| `src-tauri/src/stt/mod.rs` | Delegate decoding to `audio_decode` |
| `src-tauri/src/commands.rs` | `Health.pron`, `drill_set_word`, `drill_score`, `drill_suggest_word` |
| `src-tauri/src/llm/client.rs` | Add `complete_once` (non-streaming) for word suggestion |
| `src/index.html` | Drill header + body markup, Drill toggle button |
| `src/styles.css` | Drill view styles |
| `src/api.js` | Drill command wrappers |
| `src/app.js` | View switching, health `pron` handling |
| `README.md` | Drill mode + model setup section |

---

## Task 1: Spike — export the model and prove it can score

**This task is a decision gate. It is allowed to end the project.** Everything downstream assumes the phoneme model distinguishes a correct German word from a mispronounced one, and that `espeak-ng` produces usable German IPA. Both are unproven. Verify them before building anything on top.

**Files:**
- Create: `scripts/export_phoneme_model.py`
- Create: `src-tauri/examples/spike_phones.rs`
- Create: `docs/spike-phoneme-model.md` (findings)
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: nothing
- Produces: `models/pron/model.onnx` + `models/pron/vocab.json` on disk; a documented go/no-go verdict. No Rust API — `examples/spike_phones.rs` is throwaway and deleted in Task 5.

- [ ] **Step 1: Write the export script**

Create `scripts/export_phoneme_model.py`:

```python
"""One-time export of the wav2vec2 phoneme recognizer to ONNX.

Run once, outside the app, with: pip install torch transformers onnx
Writes models/pron/model.onnx and models/pron/vocab.json
"""
import json
import pathlib
import torch
from transformers import AutoProcessor, AutoModelForCTC

MODEL_ID = "facebook/wav2vec2-xlsr-53-espeak-cv-ft"
OUT_DIR = pathlib.Path(__file__).resolve().parents[1] / "models" / "pron"
OUT_DIR.mkdir(parents=True, exist_ok=True)

processor = AutoProcessor.from_pretrained(MODEL_ID)
model = AutoModelForCTC.from_pretrained(MODEL_ID)
model.eval()

# 2 seconds of 16 kHz audio as the tracing example; the time axis is dynamic.
dummy = torch.zeros(1, 32000, dtype=torch.float32)

torch.onnx.export(
    model,
    dummy,
    str(OUT_DIR / "model.onnx"),
    input_names=["input_values"],
    output_names=["logits"],
    dynamic_axes={"input_values": {1: "samples"}, "logits": {1: "frames"}},
    opset_version=17,
)

# id -> phone label, the inverse of the tokenizer vocab, for CTC decoding in Rust.
vocab = processor.tokenizer.get_vocab()
id_to_phone = [None] * (max(vocab.values()) + 1)
for phone, idx in vocab.items():
    id_to_phone[idx] = phone
(OUT_DIR / "vocab.json").write_text(
    json.dumps(id_to_phone, ensure_ascii=False), encoding="utf-8"
)
print(f"wrote {OUT_DIR}/model.onnx and vocab.json ({len(id_to_phone)} labels)")
```

- [ ] **Step 2: Run the export**

Run: `python scripts/export_phoneme_model.py`
Expected: `wrote .../model.onnx and vocab.json (N labels)`, with N in the low hundreds.

If the export fails, record the error in `docs/spike-phoneme-model.md` and **stop** — report back before improvising a different model.

- [ ] **Step 3: Add the spike dependencies**

In `src-tauri/Cargo.toml`, under `[dependencies]`:

```toml
# German grapheme-to-phoneme for the pronunciation drill: text -> IPA.
espeak-ng = "0.1"
# German hyphenation (TeX patterns) for splitting a word into the
# orthographic syllables the drill UI underlines.
hyphenation = { version = "0.8", features = ["embed_all"] }
```

- [ ] **Step 4: Write the spike binary**

Create `src-tauri/examples/spike_phones.rs`:

```rust
//! THROWAWAY spike (Task 1). Deleted in Task 5.
//!
//! Answers two questions before any real work starts:
//!   1. Does espeak-ng give sane German IPA?
//!   2. Does the ONNX phoneme model distinguish a good "Vielleicht" from a bad one?
//!
//! Run: cargo run --example spike_phones -- path/to/attempt.wav

use ndarray::Array2;
use ort::{Session, Value};

fn main() -> anyhow::Result<()> {
    // --- Question 1: G2P ---
    for word in ["Vielleicht", "Eichhörnchen", "über", "Buch"] {
        let ipa = espeak_ng::text_to_phonemes(word, "de", None)?;
        println!("g2p  {word:>14} -> {ipa}");
    }

    // --- Question 2: phoneme recognition ---
    let wav_path = std::env::args().nth(1).expect("usage: spike_phones <wav>");
    let wav = std::fs::read(&wav_path)?;
    let samples = decode(&wav)?;
    println!("audio {} samples", samples.len());

    let mut session = Session::builder()?.commit_from_file("../models/pron/model.onnx")?;
    let vocab: Vec<Option<String>> =
        serde_json::from_str(&std::fs::read_to_string("../models/pron/vocab.json")?)?;

    let normalized = normalize(&samples);
    let input = Array2::from_shape_vec((1, normalized.len()), normalized)?;
    let outputs = session.run(ort::inputs!["input_values" => Value::from_array(input)?]?)?;
    let (shape, logits) = outputs["logits"].try_extract_raw_tensor::<f32>()?;
    let (frames, vocab_size) = (shape[1] as usize, shape[2] as usize);
    println!("logits frames={frames} vocab={vocab_size}");

    let mut phones: Vec<String> = Vec::new();
    let mut prev = usize::MAX;
    for f in 0..frames {
        let row = &logits[f * vocab_size..(f + 1) * vocab_size];
        let best = row
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(i, _)| i)
            .unwrap();
        if best != prev && best != 0 {
            if let Some(Some(label)) = vocab.get(best) {
                phones.push(label.clone());
            }
        }
        prev = best;
    }
    println!("recognized: {}", phones.join(" "));
    Ok(())
}

fn normalize(samples: &[f32]) -> Vec<f32> {
    let n = samples.len() as f32;
    let mean = samples.iter().sum::<f32>() / n;
    let var = samples.iter().map(|s| (s - mean).powi(2)).sum::<f32>() / n;
    let std = (var + 1e-7).sqrt();
    samples.iter().map(|s| (s - mean) / std).collect()
}

fn decode(wav: &[u8]) -> anyhow::Result<Vec<f32>> {
    let mut reader = hound::WavReader::new(std::io::Cursor::new(wav))?;
    let spec = reader.spec();
    let mono: Vec<f32> = reader
        .samples::<i16>()
        .filter_map(|s| s.ok())
        .map(|s| s as f32 / 32768.0)
        .step_by(spec.channels as usize)
        .collect();
    anyhow::ensure!(
        spec.sample_rate == 16_000,
        "spike expects a 16 kHz wav, got {}",
        spec.sample_rate
    );
    Ok(mono)
}
```

- [ ] **Step 5: Record three attempts and run the spike**

Record three 16 kHz mono WAVs by any means (Windows Voice Recorder then convert, or the app's own mic):
- `good.wav` — "Vielleicht" pronounced correctly
- `bad.wav` — "Vielleicht" with a hard **k** instead of the ch-Laut ("fi-LAIKT")
- `other.wav` — a different word entirely, e.g. "Buch"

Run for each: `cargo run --example spike_phones -- good.wav`

- [ ] **Step 6: Judge the results and write them down**

Create `docs/spike-phoneme-model.md` recording, verbatim, the G2P output and the recognized phone string for all three WAVs.

**Pass criteria — all three must hold:**
1. `espeak-ng` produces plausible German IPA (`Vielleicht` → something like `fɪlaɪçt`, not empty, not English-sounding).
2. `good.wav` recognizes a phone string resembling the G2P output — roughly the right length, most phones matching.
3. `bad.wav` differs from `good.wav` **at the ch position specifically** — a `k`-like phone where `good.wav` has a `ç`-like one.

If criterion 1 fails, the `espeak-ng` crate is not viable: stop and report — the fallback (shelling out to the `espeak-ng` CLI, or `espeakng-sys`) is a design change, not an implementation detail.

If criteria 2 or 3 fail, the scorer cannot score: **stop and report.** Do not proceed to Task 2. Building a drill page on a scorer that cannot tell good from bad produces an app that lies to the learner, which is worse than no feature.

- [ ] **Step 7: Commit**

```bash
git rev-parse --show-toplevel   # MUST end in TandemLive
git add scripts/export_phoneme_model.py src-tauri/examples/spike_phones.rs docs/spike-phoneme-model.md src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "spike: validate phoneme model and German G2P for drill mode"
```

---

## Task 2: Phone alignment

Pure Needleman–Wunsch over phone sequences. No model, no I/O — the most testable piece in the feature, and where correctness matters most.

**Files:**
- Create: `src-tauri/src/pron/mod.rs`, `src-tauri/src/pron/align.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod pron;`)

**Interfaces:**
- Consumes: nothing
- Produces:
  ```rust
  pub enum AlignOp {
      Match { expected: String, actual: String },
      Substitution { expected: String, actual: String },
      Deletion { expected: String },
      Insertion { actual: String },
  }
  pub struct PhoneVerdict { pub expected: String, pub actual: Option<String>, pub correct: bool }
  pub fn align(expected: &[String], actual: &[String]) -> Vec<AlignOp>
  pub fn verdicts(ops: &[AlignOp]) -> Vec<PhoneVerdict>
  ```
  `verdicts` returns exactly one entry per expected phone, in order. Insertions map to no expected phone and are dropped (v1: an inserted sound is not itself reported).

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/pron/align.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn phones(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn identical_sequences_are_all_matches() {
        let e = phones("f i l a ɪ ç t");
        let ops = align(&e, &e);
        assert_eq!(ops.len(), 7);
        assert!(ops.iter().all(|op| matches!(op, AlignOp::Match { .. })));
    }

    #[test]
    fn one_wrong_phone_is_a_substitution_at_that_position() {
        let e = phones("f i l a ɪ ç t");
        let a = phones("f i l a ɪ k t");
        let v = verdicts(&align(&e, &a));
        assert_eq!(v.len(), 7, "one verdict per expected phone");
        assert_eq!(v[5].expected, "ç");
        assert_eq!(v[5].actual.as_deref(), Some("k"));
        assert!(!v[5].correct);
        assert!(v.iter().enumerate().all(|(i, x)| i == 5 || x.correct));
    }

    #[test]
    fn a_dropped_phone_is_a_deletion() {
        let e = phones("b u x");
        let a = phones("b u");
        let v = verdicts(&align(&e, &a));
        assert_eq!(v.len(), 3);
        assert_eq!(v[2].expected, "x");
        assert_eq!(v[2].actual, None);
        assert!(!v[2].correct);
    }

    #[test]
    fn an_extra_phone_does_not_shift_later_verdicts() {
        let e = phones("b u x");
        let a = phones("b u ə x");
        let v = verdicts(&align(&e, &a));
        assert_eq!(v.len(), 3, "insertions add no expected-phone verdicts");
        assert!(v.iter().all(|x| x.correct), "every expected phone was produced");
    }

    #[test]
    fn empty_actual_marks_every_expected_phone_wrong() {
        let e = phones("b u x");
        let v = verdicts(&align(&e, &[]));
        assert_eq!(v.len(), 3);
        assert!(v.iter().all(|x| !x.correct));
    }

    #[test]
    fn empty_expected_yields_no_verdicts() {
        assert!(verdicts(&align(&[], &phones("b u"))).is_empty());
    }
}
```

Create `src-tauri/src/pron/mod.rs`:

```rust
// ============================================================================
// Pronunciation scoring for drill mode.
//
// One attempt is scored by comparing two IPA phone strings: the expected one
// from grapheme-to-phoneme (`g2p`), and the actual one recognized from the
// recording (`phones`). `align` matches them up, `feedback` rolls the result
// onto orthographic syllables and picks a tip.
// ============================================================================

pub mod align;
```

Add to `src-tauri/src/lib.rs` after `pub mod pipeline;`:

```rust
pub mod pron;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --lib pron::align`
Expected: FAIL — `cannot find function 'align' in this scope`.

- [ ] **Step 3: Implement**

Prepend to `src-tauri/src/pron/align.rs`, above the test module:

```rust
// ============================================================================
// Needleman-Wunsch alignment between the expected and actual phone sequences.
//
// A positional zip would be wrong: the recognizer inserts and drops phones, so
// a single missing sound would shift every later comparison and report a word
// as entirely wrong. Edit-distance alignment localizes the error instead.
//
// Unit costs (match 0, substitution/indel 1) with no phonetic distance
// weighting -- a /k/ for /ç/ and a /b/ for /ç/ are both simply "wrong". Which
// confusion it was is preserved in the op, and `feedback` uses that to pick
// the tip.
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlignOp {
    Match { expected: String, actual: String },
    Substitution { expected: String, actual: String },
    Deletion { expected: String },
    Insertion { actual: String },
}

/// One entry per expected phone, in order: what was expected, what was
/// actually produced there (`None` if nothing was), and whether it was right.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneVerdict {
    pub expected: String,
    pub actual: Option<String>,
    pub correct: bool,
}

const COST_INDEL: u32 = 1;
const COST_SUB: u32 = 1;

pub fn align(expected: &[String], actual: &[String]) -> Vec<AlignOp> {
    let (n, m) = (expected.len(), actual.len());

    // dp[i][j] = min edit cost between expected[..i] and actual[..j].
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for (i, row) in dp.iter_mut().enumerate().take(n + 1) {
        row[0] = i as u32 * COST_INDEL;
    }
    for j in 0..=m {
        dp[0][j] = j as u32 * COST_INDEL;
    }
    for i in 1..=n {
        for j in 1..=m {
            let sub = dp[i - 1][j - 1]
                + if expected[i - 1] == actual[j - 1] {
                    0
                } else {
                    COST_SUB
                };
            dp[i][j] = sub
                .min(dp[i - 1][j] + COST_INDEL)
                .min(dp[i][j - 1] + COST_INDEL);
        }
    }

    // Traceback from the bottom-right, then reverse: ops come out in
    // sequence order.
    let mut ops = Vec::new();
    let (mut i, mut j) = (n, m);
    while i > 0 || j > 0 {
        let diagonal_ok = i > 0 && j > 0 && {
            let cost = if expected[i - 1] == actual[j - 1] {
                0
            } else {
                COST_SUB
            };
            dp[i][j] == dp[i - 1][j - 1] + cost
        };
        if diagonal_ok {
            let (e, a) = (expected[i - 1].clone(), actual[j - 1].clone());
            ops.push(if e == a {
                AlignOp::Match {
                    expected: e,
                    actual: a,
                }
            } else {
                AlignOp::Substitution {
                    expected: e,
                    actual: a,
                }
            });
            i -= 1;
            j -= 1;
        } else if i > 0 && dp[i][j] == dp[i - 1][j] + COST_INDEL {
            ops.push(AlignOp::Deletion {
                expected: expected[i - 1].clone(),
            });
            i -= 1;
        } else {
            ops.push(AlignOp::Insertion {
                actual: actual[j - 1].clone(),
            });
            j -= 1;
        }
    }
    ops.reverse();
    ops
}

/// Projects alignment ops onto the expected phones. Insertions produce no
/// verdict: they belong to no expected phone, and v1 doesn't report added
/// sounds -- only expected sounds that were wrong or missing.
pub fn verdicts(ops: &[AlignOp]) -> Vec<PhoneVerdict> {
    ops.iter()
        .filter_map(|op| match op {
            AlignOp::Match { expected, actual } => Some(PhoneVerdict {
                expected: expected.clone(),
                actual: Some(actual.clone()),
                correct: true,
            }),
            AlignOp::Substitution { expected, actual } => Some(PhoneVerdict {
                expected: expected.clone(),
                actual: Some(actual.clone()),
                correct: false,
            }),
            AlignOp::Deletion { expected } => Some(PhoneVerdict {
                expected: expected.clone(),
                actual: None,
                correct: false,
            }),
            AlignOp::Insertion { .. } => None,
        })
        .collect()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --lib pron::align`
Expected: PASS, 6 tests.

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt && cargo clippy --all-targets
git rev-parse --show-toplevel   # MUST end in TandemLive
git add src-tauri/src/pron src-tauri/src/lib.rs
git commit -m "feat: phone-sequence alignment for pronunciation scoring"
```

---

## Task 3: Grapheme-to-phoneme and syllable partition

Turns `Vielleicht` into the expected IPA plus a syllable breakdown where each syllable owns a known span of phones. This is what lets the UI underline `Viel` / `leicht` without ever mapping letters to sounds.

**Files:**
- Create: `src-tauri/src/pron/g2p.rs`
- Modify: `src-tauri/src/pron/mod.rs`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```rust
  pub struct Syllable { pub text: String, pub phones: Vec<String> }
  pub struct Phonemized { pub ipa: String, pub syllables: Vec<Syllable> }
  pub fn phonemize_word(word: &str) -> anyhow::Result<Phonemized>
  pub fn expected_phones(p: &Phonemized) -> Vec<String>   // flattens syllables in order
  ```
  `ipa` is the display string (e.g. `fɪlaɪçt`). `expected_phones` is what Task 2's `align` consumes.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/pron/g2p.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_input() {
        assert!(phonemize_word("   ").is_err());
    }

    #[test]
    fn rejects_multiple_words() {
        assert!(phonemize_word("guten Tag").is_err());
    }

    #[test]
    fn rejects_digits() {
        assert!(phonemize_word("12").is_err());
    }

    #[test]
    fn splits_a_two_syllable_word() {
        let p = phonemize_word("Vielleicht").unwrap();
        assert_eq!(p.syllables.len(), 2);
        let text: String = p.syllables.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(text, "Vielleicht", "syllables must reconstruct the word");
    }

    #[test]
    fn a_monosyllable_is_one_syllable_owning_every_phone() {
        let p = phonemize_word("Buch").unwrap();
        assert_eq!(p.syllables.len(), 1);
        assert_eq!(p.syllables[0].text, "Buch");
        assert_eq!(p.syllables[0].phones, expected_phones(&p));
    }

    #[test]
    fn every_phone_belongs_to_exactly_one_syllable() {
        let p = phonemize_word("Eichhörnchen").unwrap();
        let total: usize = p.syllables.iter().map(|s| s.phones.len()).sum();
        assert_eq!(total, expected_phones(&p).len());
        assert!(!expected_phones(&p).is_empty());
    }

    #[test]
    fn umlauts_survive_phonemization() {
        let p = phonemize_word("über").unwrap();
        assert!(!p.ipa.is_empty());
        assert!(!expected_phones(&p).is_empty());
    }
}
```

Add to `src-tauri/src/pron/mod.rs`:

```rust
pub mod g2p;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --lib pron::g2p`
Expected: FAIL — `cannot find function 'phonemize_word'`.

- [ ] **Step 3: Implement**

Prepend to `src-tauri/src/pron/g2p.rs`:

```rust
// ============================================================================
// German grapheme-to-phoneme + syllable partition.
//
// The drill UI underlines ORTHOGRAPHIC syllables ("Viel" / "leicht") but
// scoring happens on phones, so each syllable needs to own a known span of the
// phone sequence. Mapping letters to sounds directly is a trap in German --
// "sch" is three letters and one sound, "ch" is /ç/ or /x/ depending on
// context. Instead: hyphenate the word, then phonemize each syllable
// SEPARATELY and let the resulting phone counts partition the sequence. No
// letter-to-sound reasoning is ever performed.
//
// Caveat this accepts: phonemizing a syllable in isolation can differ slightly
// from phonemizing it in context (the ich-Laut/ach-Laut split is
// context-sensitive). The partition is used for grouping only -- the phones
// that get SCORED come from the whole-word phonemization -- so a per-syllable
// difference changes at worst which syllable a phone is attributed to, never
// whether it was judged correct.
// ============================================================================

use anyhow::{bail, Context, Result};
use hyphenation::{Hyphenator, Language, Load, Standard};
use std::sync::LazyLock;

/// German hyphenation patterns, embedded in the binary (the `embed_all`
/// feature) so there is no runtime data file to ship or find.
static DE_HYPHENATION: LazyLock<Option<Standard>> =
    LazyLock::new(|| Standard::from_embedded(Language::German1996).ok());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Syllable {
    pub text: String,
    pub phones: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Phonemized {
    pub ipa: String,
    pub syllables: Vec<Syllable>,
}

/// Phonemizes a single German word and partitions its phones across the word's
/// orthographic syllables.
pub fn phonemize_word(word: &str) -> Result<Phonemized> {
    let word = word.trim();
    if word.is_empty() {
        bail!("Enter a German word");
    }
    if word.split_whitespace().count() > 1 {
        bail!("One word at a time");
    }
    if !word.chars().all(|c| c.is_alphabetic() || c == '-' || c == '\'') {
        bail!("Letters only");
    }

    let ipa = phonemize(word)?;
    let all_phones = split_phones(&ipa);
    if all_phones.is_empty() {
        bail!("Couldn't work out how to pronounce '{word}'");
    }

    let pieces = hyphenate(word);
    let syllables = partition(&pieces, &all_phones);

    Ok(Phonemized { ipa, syllables })
}

/// Flattens the syllable partition back into the full expected phone sequence.
pub fn expected_phones(p: &Phonemized) -> Vec<String> {
    p.syllables
        .iter()
        .flat_map(|s| s.phones.iter().cloned())
        .collect()
}

fn phonemize(text: &str) -> Result<String> {
    espeak_ng::text_to_phonemes(text, "de", None)
        .with_context(|| format!("phonemize '{text}' as German"))
}

/// Splits an eSpeak IPA string into individual phones. Stress marks and
/// separators carry no pronunciation verdict of their own, so they're dropped;
/// combining marks (length, diacritics) stay attached to their base character.
fn split_phones(ipa: &str) -> Vec<String> {
    ipa.chars()
        .filter(|c| !matches!(c, 'ˈ' | 'ˌ' | '.' | '_' | ' '))
        .map(|c| c.to_string())
        .collect()
}

/// Hyphenates into orthographic syllables. If the patterns are unavailable or
/// the word doesn't break, the whole word is a single syllable -- the drill
/// still works, it just shows one bar.
fn hyphenate(word: &str) -> Vec<String> {
    let Some(dict) = DE_HYPHENATION.as_ref() else {
        return vec![word.to_string()];
    };
    let pieces: Vec<String> = dict
        .hyphenate(word)
        .into_iter()
        .segments()
        .map(|s| s.to_string())
        .collect();
    if pieces.is_empty() {
        vec![word.to_string()]
    } else {
        pieces
    }
}

/// Distributes `all_phones` across `pieces` by phonemizing each piece on its
/// own to learn how many phones it claims. The last syllable absorbs any
/// remainder, so the partition always covers the whole sequence exactly --
/// which is what the "every phone belongs to exactly one syllable" invariant
/// (and the UI) depends on.
fn partition(pieces: &[String], all_phones: &[String]) -> Vec<Syllable> {
    let mut out = Vec::with_capacity(pieces.len());
    let mut cursor = 0usize;

    for (i, piece) in pieces.iter().enumerate() {
        let is_last = i + 1 == pieces.len();
        let take = if is_last {
            all_phones.len().saturating_sub(cursor)
        } else {
            let claimed = phonemize(piece)
                .map(|ipa| split_phones(&ipa).len())
                .unwrap_or(1)
                .max(1);
            // Never consume so much that the remaining syllables get nothing.
            let remaining_syllables = pieces.len() - i - 1;
            let available = all_phones
                .len()
                .saturating_sub(cursor)
                .saturating_sub(remaining_syllables);
            claimed.min(available)
        };

        let phones = all_phones[cursor..cursor + take].to_vec();
        cursor += take;
        out.push(Syllable {
            text: piece.clone(),
            phones,
        });
    }

    out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --lib pron::g2p`
Expected: PASS, 7 tests.

If `splits_a_two_syllable_word` fails because German1996 patterns hyphenate `Vielleicht` differently than expected, adjust the **assertion** to whatever the library actually produces (the invariant that matters is that the pieces reconstruct the word), not the implementation.

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt && cargo clippy --all-targets
git rev-parse --show-toplevel   # MUST end in TandemLive
git add src-tauri/src/pron
git commit -m "feat: German G2P and syllable partition for drill mode"
```

---

## Task 4: Syllable scoring and feedback tips

Rolls per-phone verdicts onto syllables and picks the one sentence shown under the word.

**Files:**
- Create: `src-tauri/src/pron/feedback.rs`
- Modify: `src-tauri/src/pron/mod.rs`

**Interfaces:**
- Consumes: `pron::g2p::Syllable`, `pron::align::PhoneVerdict`
- Produces:
  ```rust
  pub struct SyllableScore { pub text: String, pub score: String }  // "good" | "needs_work"
  pub fn score_syllables(syllables: &[Syllable], verdicts: &[PhoneVerdict], threshold: f32) -> Vec<SyllableScore>
  pub fn tip(syllables: &[Syllable], verdicts: &[PhoneVerdict]) -> String
  ```
  `threshold` is the fraction of a syllable's phones that must be correct for `"good"` (from `Settings::pron_score_threshold`).

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/pron/feedback.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn syl(text: &str, phones: &[&str]) -> Syllable {
        Syllable {
            text: text.to_string(),
            phones: phones.iter().map(|p| p.to_string()).collect(),
        }
    }

    fn verdict(expected: &str, actual: Option<&str>) -> PhoneVerdict {
        PhoneVerdict {
            expected: expected.to_string(),
            actual: actual.map(str::to_string),
            correct: actual == Some(expected),
        }
    }

    #[test]
    fn an_all_correct_word_scores_every_syllable_good() {
        let syllables = vec![syl("Viel", &["f", "i", "l"]), syl("leicht", &["a", "ç", "t"])];
        let verdicts = vec![
            verdict("f", Some("f")),
            verdict("i", Some("i")),
            verdict("l", Some("l")),
            verdict("a", Some("a")),
            verdict("ç", Some("ç")),
            verdict("t", Some("t")),
        ];
        let scores = score_syllables(&syllables, &verdicts, 1.0);
        assert_eq!(scores.len(), 2);
        assert!(scores.iter().all(|s| s.score == "good"));
    }

    #[test]
    fn only_the_syllable_containing_the_bad_phone_is_marked() {
        let syllables = vec![syl("Viel", &["f", "i", "l"]), syl("leicht", &["a", "ç", "t"])];
        let verdicts = vec![
            verdict("f", Some("f")),
            verdict("i", Some("i")),
            verdict("l", Some("l")),
            verdict("a", Some("a")),
            verdict("ç", Some("k")),
            verdict("t", Some("t")),
        ];
        let scores = score_syllables(&syllables, &verdicts, 1.0);
        assert_eq!(scores[0].score, "good");
        assert_eq!(scores[1].score, "needs_work");
    }

    #[test]
    fn a_lenient_threshold_forgives_one_bad_phone_of_three() {
        let syllables = vec![syl("leicht", &["a", "ç", "t"])];
        let verdicts = vec![
            verdict("a", Some("a")),
            verdict("ç", Some("k")),
            verdict("t", Some("t")),
        ];
        assert_eq!(score_syllables(&syllables, &verdicts, 0.6)[0].score, "good");
        assert_eq!(
            score_syllables(&syllables, &verdicts, 1.0)[0].score,
            "needs_work"
        );
    }

    #[test]
    fn a_syllable_with_no_phones_is_not_punished() {
        let syllables = vec![syl("x", &[])];
        assert_eq!(score_syllables(&syllables, &[], 1.0)[0].score, "good");
    }

    #[test]
    fn a_known_confusion_gets_its_specific_tip() {
        let syllables = vec![syl("leicht", &["a", "ç", "t"])];
        let verdicts = vec![
            verdict("a", Some("a")),
            verdict("ç", Some("k")),
            verdict("t", Some("t")),
        ];
        let t = tip(&syllables, &verdicts);
        assert!(t.contains("leicht"), "the tip names the syllable: {t}");
        assert!(
            t.contains("ich-Laut") || t.contains("ch"),
            "the tip names the sound: {t}"
        );
    }

    #[test]
    fn an_unknown_confusion_falls_back_to_naming_the_syllable() {
        let syllables = vec![syl("bla", &["b", "l", "a"])];
        let verdicts = vec![
            verdict("b", Some("b")),
            verdict("l", Some("z")),
            verdict("a", Some("a")),
        ];
        let t = tip(&syllables, &verdicts);
        assert!(t.contains("bla"), "fallback still names the syllable: {t}");
        assert!(!t.is_empty());
    }

    #[test]
    fn a_dropped_phone_is_reported_as_missing() {
        let syllables = vec![syl("Buch", &["b", "u", "x"])];
        let verdicts = vec![
            verdict("b", Some("b")),
            verdict("u", Some("u")),
            verdict("x", None),
        ];
        let t = tip(&syllables, &verdicts);
        assert!(t.contains("Buch"));
    }

    #[test]
    fn a_perfect_attempt_is_praised_not_criticized() {
        let syllables = vec![syl("Buch", &["b", "u", "x"])];
        let verdicts = vec![
            verdict("b", Some("b")),
            verdict("u", Some("u")),
            verdict("x", Some("x")),
        ];
        let t = tip(&syllables, &verdicts);
        assert!(!t.contains("needs work"), "no criticism when nothing is wrong: {t}");
        assert!(!t.is_empty());
    }
}
```

Add to `src-tauri/src/pron/mod.rs`:

```rust
pub mod feedback;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --lib pron::feedback`
Expected: FAIL — `cannot find function 'score_syllables'`.

- [ ] **Step 3: Implement**

Prepend to `src-tauri/src/pron/feedback.rs`:

```rust
// ============================================================================
// Turns per-phone verdicts into what the drill page actually shows: a
// good/needs_work verdict per syllable, and one sentence of advice.
//
// The tip comes from a hand-written table keyed on the confusion pair
// (expected phone, produced phone). Deterministic, instant, offline, and the
// advice is correct because a human wrote it once. An LLM was considered and
// rejected: it would add seconds to every attempt on a page whose whole value
// is a tight retry loop.
// ============================================================================

use crate::pron::align::PhoneVerdict;
use crate::pron::g2p::Syllable;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SyllableScore {
    pub text: String,
    pub score: String,
}

const GOOD: &str = "good";
const NEEDS_WORK: &str = "needs_work";

/// The German confusions worth naming, keyed on (expected, produced).
/// Ordered most-specific first; lookup is a linear scan (a handful of entries,
/// checked once per attempt).
const TIPS: &[(&str, &str, &str)] = &[
    ("ç", "k", "the ich-Laut — a soft hiss at the front of the mouth, not a hard k"),
    ("ç", "ʃ", "the ich-Laut is lighter than \"sch\" — tongue forward, barely touching"),
    ("ç", "x", "this is the soft ich-Laut, not the throaty ach-Laut"),
    ("x", "ç", "this is the throaty ach-Laut, made further back than the ich-Laut"),
    ("x", "k", "the ach-Laut is a scrape at the back of the throat, not a hard k"),
    ("y", "u", "the ü — round your lips for \"u\" but say \"ee\""),
    ("yː", "uː", "the long ü — round your lips for \"u\" but say \"ee\""),
    ("ø", "o", "the ö — round your lips for \"o\" but say \"e\""),
    ("øː", "oː", "the long ö — round your lips for \"o\" but say \"e\""),
    ("ʁ", "r", "the German r is made in the throat, not with the tip of the tongue"),
    ("ʁ", "ɐ", "this r needs a throat scrape, not a vowel"),
    ("p", "b", "German devoices at the end of a word — this is a hard p"),
    ("t", "d", "German devoices at the end of a word — this is a hard t"),
    ("k", "ɡ", "German devoices at the end of a word — this is a hard k"),
    ("z", "s", "this s is voiced — buzz it, like an English z"),
    ("v", "f", "this w is voiced — like an English v"),
    ("ts", "s", "\"z\" in German is a t and an s together: ts"),
];

/// A syllable scores `good` when at least `threshold` of its phones were
/// produced correctly. Threshold is configurable rather than hardcoded because
/// a scorer that is too harsh is worse than no scorer -- see the spec.
pub fn score_syllables(
    syllables: &[Syllable],
    verdicts: &[PhoneVerdict],
    threshold: f32,
) -> Vec<SyllableScore> {
    let mut out = Vec::with_capacity(syllables.len());
    let mut cursor = 0usize;

    for syllable in syllables {
        let end = (cursor + syllable.phones.len()).min(verdicts.len());
        let span = if cursor < end {
            &verdicts[cursor..end]
        } else {
            &[][..]
        };
        cursor += syllable.phones.len();

        // A syllable with no phones (or no verdicts to judge it by) is not
        // evidence of a mistake, so it renders neutral-good rather than red.
        let score = if span.is_empty() {
            GOOD
        } else {
            let correct = span.iter().filter(|v| v.correct).count() as f32;
            if correct / span.len() as f32 >= threshold {
                GOOD
            } else {
                NEEDS_WORK
            }
        };

        out.push(SyllableScore {
            text: syllable.text.clone(),
            score: score.to_string(),
        });
    }

    out
}

/// One sentence about the single worst thing in the attempt. Picks the first
/// incorrect phone, finds which syllable owns it, and looks up the confusion.
pub fn tip(syllables: &[Syllable], verdicts: &[PhoneVerdict]) -> String {
    let Some((index, bad)) = verdicts.iter().enumerate().find(|(_, v)| !v.correct) else {
        return "Sounds right — try another word.".to_string();
    };

    let syllable_text = owning_syllable(syllables, index)
        .map(|s| s.text.clone())
        .unwrap_or_default();

    let Some(actual) = bad.actual.as_deref() else {
        return format!("\"{syllable_text}\" — that sound is missing entirely");
    };

    match TIPS
        .iter()
        .find(|(expected, produced, _)| *expected == bad.expected && *produced == actual)
    {
        Some((_, _, advice)) => format!("\"{syllable_text}\" — {advice}"),
        None => format!("\"{syllable_text}\" — the \"{}\" sound needs work", bad.expected),
    }
}

/// Which syllable owns the phone at `phone_index` in the flattened sequence.
fn owning_syllable(syllables: &[Syllable], phone_index: usize) -> Option<&Syllable> {
    let mut cursor = 0usize;
    for syllable in syllables {
        cursor += syllable.phones.len();
        if phone_index < cursor {
            return Some(syllable);
        }
    }
    syllables.last()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --lib pron::feedback`
Expected: PASS, 8 tests.

- [ ] **Step 5: Format, lint, commit**

```bash
cargo fmt && cargo clippy --all-targets
git rev-parse --show-toplevel   # MUST end in TandemLive
git add src-tauri/src/pron
git commit -m "feat: syllable scoring and pronunciation tips"
```

---

## Task 5: Phoneme recognition from audio

Loads the ONNX model and turns a recorded WAV into a phone sequence. Also extracts the WAV decoder currently buried in `stt/mod.rs` so both engines share one copy.

**Files:**
- Create: `src-tauri/src/audio_decode.rs`, `src-tauri/src/pron/phones.rs`
- Modify: `src-tauri/src/stt/mod.rs`, `src-tauri/src/pron/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/config.rs`
- Delete: `src-tauri/examples/spike_phones.rs`

**Interfaces:**
- Consumes: `Settings::pron_model_dir`
- Produces:
  ```rust
  // audio_decode.rs
  pub fn decode_wav_to_16k_mono_f32(wav_bytes: &[u8]) -> anyhow::Result<Vec<f32>>
  // pron/phones.rs
  pub struct PhoneRecognizer { /* private */ }
  impl PhoneRecognizer {
      pub fn load(settings: &crate::config::Settings) -> anyhow::Result<PhoneRecognizer>;
      pub fn recognize(&self, wav_bytes: &[u8]) -> anyhow::Result<Vec<String>>;
  }
  ```

- [ ] **Step 1: Move the WAV decoder into a shared module**

Create `src-tauri/src/audio_decode.rs`. Move `decode_wav_to_16k_mono_f32` and its helpers **verbatim** out of `src-tauri/src/stt/mod.rs` (including the existing tests for it, if any), changing only the visibility to `pub`:

```rust
// ============================================================================
// Shared WAV decoding: any sample rate / bit depth / channel count -> 16 kHz
// mono f32 in [-1.0, 1.0].
//
// Both speech models need exactly this: whisper.cpp and the wav2vec2 phoneme
// recognizer are both 16 kHz mono f32. Lived in `stt/mod.rs` until the
// pronunciation drill needed the same conversion.
// ============================================================================
```

In `src-tauri/src/lib.rs`, add before `pub mod commands;`:

```rust
pub mod audio_decode;
```

In `src-tauri/src/stt/mod.rs`, delete the moved functions and call the shared one — inside `transcribe`, replace the local call with:

```rust
let samples = crate::audio_decode::decode_wav_to_16k_mono_f32(wav_bytes)?;
```

- [ ] **Step 2: Run the existing tests to verify nothing broke**

Run: `cargo test`
Expected: PASS — the same counts as before this task (35 unit + 4 integration, 1 ignored). This step is purely a move; any change in results means something was altered in transit.

- [ ] **Step 3: Commit the move on its own**

Keeping the refactor in its own commit makes the next commit's diff purely additive.

```bash
cargo fmt && cargo clippy --all-targets
git rev-parse --show-toplevel   # MUST end in TandemLive
git add src-tauri/src/audio_decode.rs src-tauri/src/stt/mod.rs src-tauri/src/lib.rs
git commit -m "refactor: share the wav decoder between stt and pron"
```

- [ ] **Step 4: Add the settings**

In `src-tauri/src/config.rs`, add to the `Settings` struct:

```rust
    pub pron_model_dir: String,
    pub pron_score_threshold: f32,
```

to `Default`:

```rust
            pron_model_dir: "../models/pron".into(),
            // A syllable passes when every phone in it was produced
            // correctly. Tunable because a scorer that is too harsh is worse
            // than no scorer -- lower this if real speech scores red too often.
            pron_score_threshold: 1.0,
```

and to `Settings::load`, alongside the other path resolutions:

```rust
        settings.pron_model_dir = path_to_string(resolve_relative(
            &settings.pron_model_dir,
            exe_dir.as_deref(),
        ));
```

Extend the existing `defaults_are_sane` test in that file:

```rust
        assert_eq!(s.pron_score_threshold, 1.0);
```

- [ ] **Step 5: Write the failing test for CTC decoding**

The model itself needs files to test, but the CTC collapse is pure. Create `src-tauri/src/pron/phones.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn vocab() -> Vec<Option<String>> {
        vec![
            Some("<pad>".to_string()), // blank, id 0
            Some("f".to_string()),
            Some("i".to_string()),
            Some("ç".to_string()),
        ]
    }

    #[test]
    fn repeated_frames_collapse_to_one_phone() {
        let ids = vec![1, 1, 1, 2, 2, 3];
        assert_eq!(ctc_collapse(&ids, &vocab()), vec!["f", "i", "ç"]);
    }

    #[test]
    fn blanks_are_dropped() {
        let ids = vec![0, 1, 0, 0, 2, 0];
        assert_eq!(ctc_collapse(&ids, &vocab()), vec!["f", "i"]);
    }

    #[test]
    fn a_blank_between_repeats_preserves_both() {
        // The whole point of the CTC blank: "ff" is one phone, "f<pad>f" is two.
        let ids = vec![1, 0, 1];
        assert_eq!(ctc_collapse(&ids, &vocab()), vec!["f", "f"]);
    }

    #[test]
    fn silence_yields_no_phones() {
        assert!(ctc_collapse(&[0, 0, 0], &vocab()).is_empty());
    }

    #[test]
    fn unknown_ids_are_skipped_rather_than_panicking() {
        assert_eq!(ctc_collapse(&[1, 99, 2], &vocab()), vec!["f", "i"]);
    }

    #[test]
    fn word_delimiters_are_not_phones() {
        let mut v = vocab();
        v.push(Some("|".to_string()));
        assert_eq!(ctc_collapse(&[1, 4, 2], &v), vec!["f", "i"]);
    }

    #[test]
    fn normalization_gives_zero_mean_unit_variance() {
        let out = normalize(&[1.0, 2.0, 3.0, 4.0]);
        let mean: f32 = out.iter().sum::<f32>() / out.len() as f32;
        assert!(mean.abs() < 1e-5, "mean was {mean}");
        let var: f32 = out.iter().map(|x| x * x).sum::<f32>() / out.len() as f32;
        assert!((var - 1.0).abs() < 1e-3, "variance was {var}");
    }

    #[test]
    fn normalizing_silence_does_not_produce_nan() {
        assert!(normalize(&[0.0, 0.0, 0.0]).iter().all(|x| x.is_finite()));
    }
}
```

Add to `src-tauri/src/pron/mod.rs`:

```rust
pub mod phones;
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `cargo test --lib pron::phones`
Expected: FAIL — `cannot find function 'ctc_collapse'`.

- [ ] **Step 7: Implement**

Prepend to `src-tauri/src/pron/phones.rs`:

```rust
// ============================================================================
// Phoneme recognition: 16 kHz mono audio -> IPA phone sequence.
//
// Runs `facebook/wav2vec2-xlsr-53-espeak-cv-ft` exported to ONNX (see
// scripts/export_phoneme_model.py) through the `ort` runtime already loaded
// for Supertonic TTS. The model is CTC: it emits one distribution per ~20ms
// frame, which greedy-decodes by taking the argmax per frame, collapsing runs
// of the same id, and dropping the blank.
//
// Session handling mirrors `tts::Supertonic`: the session lives behind a
// `Mutex` (ORT's `Session::run` needs `&mut self` but `recognize` takes
// `&self`), the lock is scoped to the call and never held across an `.await`,
// and DirectML is attempted with a CPU fallback.
// ============================================================================

use anyhow::{bail, Context, Result};
use ndarray::Array2;
use ort::{DirectMLExecutionProvider, Session, Value};
use std::path::Path;
use std::sync::Mutex;

/// CTC blank. The export writes the tokenizer vocab in id order, and this
/// model's `<pad>` token is id 0.
const BLANK_ID: usize = 0;

/// Vocab entries that are structural rather than sounds.
const NON_PHONES: &[&str] = &["<pad>", "<s>", "</s>", "<unk>", "|"];

pub struct PhoneRecognizer {
    session: Mutex<Session>,
    /// id -> phone label, indexed directly by the argmax.
    vocab: Vec<Option<String>>,
}

impl PhoneRecognizer {
    pub fn load(settings: &crate::config::Settings) -> Result<PhoneRecognizer> {
        let dir = Path::new(&settings.pron_model_dir);
        let model_path = dir.join("model.onnx");
        let vocab_path = dir.join("vocab.json");

        let vocab: Vec<Option<String>> = serde_json::from_str(
            &std::fs::read_to_string(&vocab_path)
                .with_context(|| format!("read {}", vocab_path.display()))?,
        )
        .context("parse vocab.json")?;
        if vocab.is_empty() {
            bail!("vocab.json is empty");
        }

        let session = build_session(&model_path, settings.use_gpu)?;
        let recognizer = PhoneRecognizer {
            session: Mutex::new(session),
            vocab,
        };

        // Same GPU-validation shape as `Supertonic::load`: DirectML can build a
        // session fine and still fail at inference on this ORT build, so prove
        // it with one real run and rebuild on CPU if it fails. This also warms
        // the model, so the first real attempt isn't the slow one.
        if settings.use_gpu {
            let silence = vec![0.0f32; 16_000 / 5];
            if let Err(e) = recognizer.infer(&silence) {
                eprintln!("[pron] DirectML GPU inference failed ({e:#}); falling back to CPU.");
                *recognizer.session.lock().unwrap() = build_session(&model_path, false)?;
            }
        }

        Ok(recognizer)
    }

    /// Recognizes the phones in a recording. Accepts WAV bytes at any sample
    /// rate / depth / channel count.
    pub fn recognize(&self, wav_bytes: &[u8]) -> Result<Vec<String>> {
        let samples = crate::audio_decode::decode_wav_to_16k_mono_f32(wav_bytes)?;
        if samples.is_empty() {
            bail!("Nothing was recorded");
        }
        self.infer(&samples)
    }

    fn infer(&self, samples: &[f32]) -> Result<Vec<String>> {
        let normalized = normalize(samples);
        let input = Array2::from_shape_vec((1, normalized.len()), normalized)
            .context("shape input tensor")?;

        let ids = {
            // Scoped so the lock is released before any further work -- the
            // codebase holds no lock longer than the ORT call itself.
            let mut session = self
                .session
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let outputs = session
                .run(ort::inputs!["input_values" => Value::from_array(input)?]?)
                .context("run phoneme recognition")?;
            let (shape, logits) = outputs["logits"]
                .try_extract_raw_tensor::<f32>()
                .context("extract logits")?;
            if shape.len() != 3 {
                bail!("expected 3-D logits, got shape {shape:?}");
            }
            argmax_per_frame(logits, shape[1] as usize, shape[2] as usize)
        };

        Ok(ctc_collapse(&ids, &self.vocab))
    }
}

fn build_session(model_path: &Path, use_gpu: bool) -> Result<Session> {
    let mut builder = Session::builder().context("create ORT session builder")?;
    if use_gpu {
        // Best-effort, exactly like the TTS path: a registration failure here
        // is not fatal, ORT simply runs on CPU.
        let _ = builder.with_execution_providers([DirectMLExecutionProvider::default().build()]);
    }
    builder
        .commit_from_file(model_path)
        .with_context(|| format!("load phoneme model from {}", model_path.display()))
}

fn argmax_per_frame(logits: &[f32], frames: usize, vocab_size: usize) -> Vec<usize> {
    (0..frames)
        .map(|f| {
            let row = &logits[f * vocab_size..(f + 1) * vocab_size];
            row.iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map(|(i, _)| i)
                .unwrap_or(BLANK_ID)
        })
        .collect()
}

/// Greedy CTC decode: collapse runs of the same id, drop blanks and
/// non-phone tokens. A blank between two identical ids is what keeps a
/// genuine doubled phone from collapsing into one.
fn ctc_collapse(ids: &[usize], vocab: &[Option<String>]) -> Vec<String> {
    let mut out = Vec::new();
    let mut previous = usize::MAX;
    for &id in ids {
        if id != previous && id != BLANK_ID {
            if let Some(Some(label)) = vocab.get(id) {
                if !NON_PHONES.contains(&label.as_str()) {
                    out.push(label.clone());
                }
            }
        }
        previous = id;
    }
    out
}

/// Zero-mean unit-variance normalization, which is what this model's
/// feature extractor applies (`do_normalize=True`). The epsilon keeps
/// digital silence from dividing by zero.
fn normalize(samples: &[f32]) -> Vec<f32> {
    let n = samples.len() as f32;
    if n == 0.0 {
        return Vec::new();
    }
    let mean = samples.iter().sum::<f32>() / n;
    let variance = samples.iter().map(|s| (s - mean).powi(2)).sum::<f32>() / n;
    let std = (variance + 1e-7).sqrt();
    samples.iter().map(|s| (s - mean) / std).collect()
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cargo test --lib pron::phones`
Expected: PASS, 8 tests.

- [ ] **Step 9: Delete the spike**

```bash
git rm src-tauri/examples/spike_phones.rs
```

Its two questions are answered and its logic now lives in tested code.

- [ ] **Step 10: Format, lint, commit**

```bash
cargo fmt && cargo clippy --all-targets && cargo test
git rev-parse --show-toplevel   # MUST end in TandemLive
git add src-tauri/src/pron src-tauri/src/config.rs
git commit -m "feat: ONNX phoneme recognition for drill mode"
```

---

## Task 6: Wire the scorer into app state and health

**Files:**
- Create: nothing
- Modify: `src-tauri/src/pron/mod.rs`, `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `PhoneRecognizer`, `g2p::phonemize_word`, `align::align`/`verdicts`, `feedback::score_syllables`/`tip`
- Produces:
  ```rust
  // pron/mod.rs
  pub struct Attempt { pub syllables: Vec<SyllableScore>, pub feedback: String, pub ipa_actual: String }
  pub struct PronScorer { /* private */ }
  impl PronScorer {
      pub fn load(settings: &Settings) -> anyhow::Result<PronScorer>;
      pub fn score(&self, word: &str, wav_bytes: &[u8], threshold: f32) -> anyhow::Result<Attempt>;
  }
  // state.rs
  impl AppState { pub fn pron(&self) -> Result<&PronScorer, String>; pub fn pron_ready(&self) -> bool; }
  // commands.rs
  pub struct Health { pub whisper: bool, pub tts: bool, pub llm: bool, pub pron: bool }
  ```

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/state.rs`'s existing `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn require_reports_a_missing_pron_scorer_clearly() {
        let absent: Option<u8> = None;
        let err = require(&absent, "Pronunciation model not loaded").unwrap_err();
        assert_eq!(err, "Pronunciation model not loaded");
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --lib state::tests::require_reports_a_missing_pron_scorer_clearly`
Expected: PASS immediately if `require` is already generic — that is fine and expected; this test pins the message the next step introduces. If it fails to compile, `require` is not in scope in the test module; add `use super::require;`.

- [ ] **Step 3: Add the `PronScorer` facade**

Append to `src-tauri/src/pron/mod.rs`:

```rust
use crate::pron::feedback::SyllableScore;

/// The result of one drill attempt, as the frontend consumes it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Attempt {
    pub syllables: Vec<SyllableScore>,
    pub feedback: String,
    pub ipa_actual: String,
}

/// Ties the four units together. Owns the only expensive resource (the ONNX
/// session); G2P and scoring are stateless.
pub struct PronScorer {
    recognizer: phones::PhoneRecognizer,
}

impl PronScorer {
    pub fn load(settings: &crate::config::Settings) -> anyhow::Result<PronScorer> {
        Ok(PronScorer {
            recognizer: phones::PhoneRecognizer::load(settings)?,
        })
    }

    /// Scores one attempt at `word`. Blocking (ORT inference) -- callers run
    /// it on `spawn_blocking`.
    pub fn score(&self, word: &str, wav_bytes: &[u8], threshold: f32) -> anyhow::Result<Attempt> {
        let target = g2p::phonemize_word(word)?;
        let expected = g2p::expected_phones(&target);
        let actual = self.recognizer.recognize(wav_bytes)?;

        let verdicts = align::verdicts(&align::align(&expected, &actual));

        Ok(Attempt {
            syllables: feedback::score_syllables(&target.syllables, &verdicts, threshold),
            feedback: feedback::tip(&target.syllables, &verdicts),
            ipa_actual: actual.join(""),
        })
    }
}
```

- [ ] **Step 4: Add the state accessors**

In `src-tauri/src/state.rs`, add to `AppState`:

```rust
    /// `None` when the phoneme model is missing or failed to load. Drill mode
    /// is then unavailable, but the conversation view is unaffected -- same
    /// graceful-degradation contract as `tts`/`stt`.
    pub pron: Option<crate::pron::PronScorer>,
```

and to `impl AppState`:

```rust
    /// The loaded pronunciation scorer, or a clear user-facing error if the
    /// phoneme model failed to load at startup.
    pub fn pron(&self) -> Result<&crate::pron::PronScorer, String> {
        require(&self.pron, "Pronunciation model not loaded")
    }

    pub fn pron_ready(&self) -> bool {
        self.pron.is_some()
    }
```

- [ ] **Step 5: Load it at startup**

In `src-tauri/src/lib.rs`'s `setup`, after the `stt` block:

```rust
            // Same graceful-degradation contract as tts/stt: a missing
            // phoneme model disables drill mode, it does not stop the app.
            let pron = match pron::PronScorer::load(&settings) {
                Ok(pron) => Some(pron),
                Err(e) => {
                    eprintln!("[startup] Failed to load pronunciation model: {e:#}");
                    None
                }
            };
```

and add `pron,` to the `app.manage(AppState { ... })` initializer.

- [ ] **Step 6: Add `pron` to health**

In `src-tauri/src/commands.rs`, add to `Health`:

```rust
    pub pron: bool,
```

and in `health`:

```rust
    let pron = state.pron_ready();
```
```rust
    Ok(Health {
        whisper,
        tts,
        llm,
        pron,
    })
```

- [ ] **Step 7: Verify the whole suite still passes**

Run: `cargo test`
Expected: PASS — previous count plus the new state test.

- [ ] **Step 8: Format, lint, commit**

```bash
cargo fmt && cargo clippy --all-targets
git rev-parse --show-toplevel   # MUST end in TandemLive
git add src-tauri/src
git commit -m "feat: load the pronunciation scorer and report it in health"
```

---

## Task 7: Drill commands

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/llm/client.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `AppState::pron()`, `PronScorer::score`, `g2p::phonemize_word`, `LmStudioClient`
- Produces:
  ```rust
  #[derive(serde::Serialize)] pub struct DrillTarget { pub word: String, pub ipa: String, pub syllables: Vec<String> }
  #[tauri::command] pub fn drill_set_word(word: String) -> Result<DrillTarget, String>
  #[tauri::command] pub async fn drill_score(word: String, audio: Vec<u8>, app: tauri::AppHandle) -> Result<crate::pron::Attempt, String>
  #[tauri::command] pub async fn drill_suggest_word(state: tauri::State<'_, AppState>) -> Result<String, String>
  // llm/client.rs
  impl LmStudioClient { pub async fn complete_once(&self, prompt: &str) -> anyhow::Result<String> }
  ```

- [ ] **Step 1: Write the failing test for the suggestion prompt cleanup**

The LLM returns prose around the word often enough that it must be cleaned. Add to `src-tauri/src/commands.rs` a test module (or extend the existing one):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_word_passes_through() {
        assert_eq!(clean_suggested_word("Eichhörnchen"), Some("Eichhörnchen".to_string()));
    }

    #[test]
    fn surrounding_prose_is_stripped() {
        assert_eq!(
            clean_suggested_word("Sure! Try this word: Eichhörnchen."),
            Some("Eichhörnchen".to_string())
        );
    }

    #[test]
    fn quotes_and_punctuation_are_stripped() {
        assert_eq!(clean_suggested_word("\"Vielleicht\""), Some("Vielleicht".to_string()));
    }

    #[test]
    fn a_response_with_no_german_word_is_rejected() {
        assert_eq!(clean_suggested_word("...   !!!"), None);
    }

    #[test]
    fn an_empty_response_is_rejected() {
        assert_eq!(clean_suggested_word(""), None);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --lib commands`
Expected: FAIL — `cannot find function 'clean_suggested_word'`.

- [ ] **Step 3: Add the non-streaming LLM call**

In `src-tauri/src/llm/client.rs`, add to `impl LmStudioClient`:

```rust
    /// One-shot, non-streaming completion. `stream_reply` exists for the
    /// conversation, where progressive output is the whole point; drill's word
    /// suggestion is a handful of tokens with nothing to reveal progressively.
    pub async fn complete_once(&self, prompt: &str) -> anyhow::Result<String> {
        let body = serde_json::json!({
            "model": self.model,
            "messages": [{ "role": "user", "content": prompt }],
            "stream": false,
            "temperature": 1.0,
        });

        let response = self
            .client
            .post(format!("{}/v1/chat/completions", self.base_url))
            .json(&body)
            .send()
            .await
            .context("send completion request")?;

        let status = response.status();
        if !status.is_success() {
            anyhow::bail!("LM Studio returned {status}");
        }

        let json: serde_json::Value = response.json().await.context("parse completion response")?;
        json["choices"][0]["message"]["content"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow::anyhow!("no content in completion response"))
    }
```

If the field names `self.client` / `self.base_url` / `self.model` differ in that file, use whatever it actually calls them — do not rename the existing fields.

- [ ] **Step 4: Implement the commands**

Append to `src-tauri/src/commands.rs` (above the test module):

```rust
// ---------------------------------------------------------------------------
// Drill mode.
//
// These are plain commands returning values rather than event emitters. A
// conversation turn streams, so it needs `turn:*`; a drill attempt is one short
// round-trip with nothing to reveal progressively.
// ---------------------------------------------------------------------------

/// The target word as the drill page displays it.
#[derive(serde::Serialize)]
pub struct DrillTarget {
    pub word: String,
    pub ipa: String,
    pub syllables: Vec<String>,
}

/// Phonemizes and syllabifies a word for display. No audio, no model -- fast
/// enough to call on every input submit.
#[tauri::command]
pub fn drill_set_word(word: String) -> Result<DrillTarget, String> {
    let phonemized = crate::pron::g2p::phonemize_word(&word).map_err(|e| format!("{e:#}"))?;
    Ok(DrillTarget {
        word: word.trim().to_string(),
        ipa: phonemized.ipa,
        syllables: phonemized.syllables.into_iter().map(|s| s.text).collect(),
    })
}

/// Scores one recorded attempt at `word`.
///
/// Takes `AppHandle` rather than `State` because the scoring itself is a
/// blocking ORT call that must run on `spawn_blocking`, and a `tauri::State`
/// borrow cannot cross that boundary -- the same reason `submit_turn` takes an
/// `AppHandle`.
#[tauri::command]
pub async fn drill_score(
    word: String,
    audio: Vec<u8>,
    app: tauri::AppHandle,
) -> Result<crate::pron::Attempt, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let threshold = state.settings.pron_score_threshold;
        state
            .pron()?
            .score(&word, &audio, threshold)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| format!("scoring task failed: {e}"))?
}

/// Asks LM Studio for one German word worth practising.
#[tauri::command]
pub async fn drill_suggest_word(state: tauri::State<'_, AppState>) -> Result<String, String> {
    // Clone the strings out before awaiting: a `tauri::State` isn't guaranteed
    // `Send` across an await point. Same pattern as `health`.
    let base_url = state.settings.lm_studio_base_url.clone();
    let model = state.settings.lm_studio_model.clone();

    const PROMPT: &str = "Give me exactly one German word that is hard for English \
speakers to pronounce. Reply with the word only, nothing else. No punctuation, no \
explanation.";

    let raw = crate::llm::client::LmStudioClient::new(&base_url, &model)
        .complete_once(PROMPT)
        .await
        .map_err(|e| format!("{e:#}"))?;

    clean_suggested_word(&raw).ok_or_else(|| "Couldn't get a word — try typing one".to_string())
}

/// Pulls a single German word out of whatever the model actually said. Small
/// local models ignore "reply with the word only" often enough that this can't
/// be skipped: it takes the last word-like token and strips punctuation.
fn clean_suggested_word(raw: &str) -> Option<String> {
    raw.split_whitespace()
        .map(|token| {
            token
                .trim_matches(|c: char| !c.is_alphabetic() && c != '-')
                .to_string()
        })
        .filter(|token| token.chars().count() >= 2 && token.chars().all(|c| c.is_alphabetic() || c == '-'))
        .next_back()
}
```

Add `use tauri::Manager;` at the top of `commands.rs` if `app.state::<AppState>()` doesn't resolve.

- [ ] **Step 5: Register the commands**

In `src-tauri/src/lib.rs`'s `invoke_handler`, add after `commands::submit_turn`:

```rust
            commands::drill_set_word,
            commands::drill_score,
            commands::drill_suggest_word
```

(add a comma after `commands::submit_turn`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test`
Expected: PASS, including 5 new `commands` tests.

- [ ] **Step 7: Format, lint, commit**

```bash
cargo fmt && cargo clippy --all-targets
git rev-parse --show-toplevel   # MUST end in TandemLive
git add src-tauri/src
git commit -m "feat: drill_set_word, drill_score and drill_suggest_word commands"
```

---

## Task 8: Drill view markup and styles

**Files:**
- Modify: `src/index.html`, `src/styles.css`

**Interfaces:**
- Consumes: nothing
- Produces: DOM ids the next task binds to — `drill-btn`, `drill-back`, `drill-view`, `drill-input`, `drill-suggest`, `drill-word`, `drill-ipa`, `drill-listen`, `drill-syllables`, `drill-feedback`, `drill-error`; and `body[data-view]` as the view switch.

- [ ] **Step 1: Add the Drill toggle to the header**

In `src/index.html`, inside `<div class="right">`, before the `new-btn` button:

```html
          <button class="btn-ghost" id="drill-btn">Drill</button>
```

- [ ] **Step 2: Add the drill header and body**

In `src/index.html`, immediately after the closing `</div>` of the existing `<div class="header">`:

```html
      <!-- Drill header (shown only in the drill view) -->
      <div class="drill-header">
        <div class="left">
          <button class="btn-ghost" id="drill-back">
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4">
              <line x1="10" y1="6" x2="2" y2="6" /><polyline points="5,3 2,6 5,9" />
            </svg>
            Back
          </button>
          <span class="divider"></span>
          <span class="drill-title">Drill</span>
        </div>
      </div>

      <!-- Drill body -->
      <div class="drill-view" id="drill-view">
        <div class="drill-input-row">
          <input id="drill-input" type="text" spellcheck="false" placeholder="Ein deutsches Wort…" />
          <button class="btn-ghost" id="drill-suggest">Surprise me</button>
        </div>
        <div class="drill-error" id="drill-error"></div>
        <div class="drill-word" id="drill-word"></div>
        <div class="drill-ipa" id="drill-ipa"></div>
        <button class="drill-listen" id="drill-listen">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4">
            <polygon points="2,5 5,5 8,2 8,11 5,8 2,8" /><path d="M10 4.5a3.5 3.5 0 0 1 0 4" />
          </svg>
          Listen
        </button>
        <div class="drill-syllables" id="drill-syllables"></div>
        <div class="drill-feedback" id="drill-feedback"></div>
      </div>
```

- [ ] **Step 3: Add the styles**

Append to `src/styles.css`:

```css
/* ===================== Drill mode =====================
   Tokens are taken verbatim from
   design_handoff_tandem_main_window/drill-mode-README.md.
   No new colors: everything here already exists in the main window. */

/* View switching. The titlebar and record bar are shared and always
   visible; only the header and the body swap. */
.drill-header,
.drill-view {
  display: none;
}
body[data-view="drill"] .header,
body[data-view="drill"] .transcript {
  display: none;
}
body[data-view="drill"] .drill-header {
  display: flex;
}
body[data-view="drill"] .drill-view {
  display: flex;
}

.drill-header {
  height: 56px;
  flex: 0 0 56px;
  align-items: center;
  justify-content: space-between;
  padding: 0 18px;
  background: #191920;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.drill-header .left {
  display: flex;
  align-items: center;
  gap: 14px;
}
.drill-title {
  font-size: 15px;
  font-weight: 600;
  color: #e9eaec;
}

.drill-view {
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 26px;
  padding: 26px;
  overflow-y: auto;
}

.drill-input-row {
  display: flex;
  gap: 8px;
  width: 100%;
  max-width: 420px;
}
#drill-input {
  flex: 1;
  background: #14161a;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 7px;
  padding: 8px 12px;
  color: #e9eaec;
  font-family: "Hanken Grotesk", sans-serif;
  font-size: 14px;
}
#drill-input:focus {
  outline: none;
  border-color: rgba(255, 255, 255, 0.24);
}
#drill-suggest:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

.drill-error {
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  color: #e5848a;
  min-height: 14px;
}

.drill-word {
  font-size: 52px;
  font-weight: 700;
  color: #e9eaec;
  line-height: 1.1;
  text-align: center;
}
.drill-ipa {
  font-family: "JetBrains Mono", monospace;
  font-size: 15px;
  color: #7a7870;
}

.drill-listen {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 16px;
  border-radius: 20px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #c4c8cd;
  font-family: "Hanken Grotesk", sans-serif;
  font-size: 13px;
  cursor: pointer;
}
.drill-listen:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

/* Syllable score row: each syllable carries a 3px bar colored by verdict. */
.drill-syllables {
  display: flex;
  gap: 10px;
}
.drill-syllable {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  font-size: 22px;
  color: #a09e95;
}
.drill-syllable .bar {
  height: 3px;
  width: 100%;
  border-radius: 2px;
}
.drill-syllable.good .bar {
  background: #42c97a;
}
.drill-syllable.needs_work .bar {
  background: #e5484d;
}

.drill-feedback {
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  color: #e5848a;
  text-align: center;
  max-width: 480px;
  min-height: 15px;
}
```

- [ ] **Step 4: Verify visually**

Run the app with the MSVC env active: `cargo tauri dev`

Then in the app's devtools console, force the view on:

```js
document.body.dataset.view = "drill";
```

Expected: the transcript and main header disappear; the drill header ("Back │ Drill") and the centered input row appear; the record bar is unchanged and still at the bottom. The word/IPA/syllable areas are empty — Task 9 fills them.

- [ ] **Step 5: Commit**

```bash
git rev-parse --show-toplevel   # MUST end in TandemLive
git add src/index.html src/styles.css
git commit -m "feat: drill view markup and styles"
```

---

## Task 9: Drill view behavior

**Files:**
- Create: `src/drill.js`
- Modify: `src/api.js`, `src/app.js`

**Interfaces:**
- Consumes: commands from Task 7; `startRecording`/`stopRecording` from `audio.js`
- Produces: `initDrill({ onEnter, onExit })`, `setDrillEnginesReady(ready)`, `isDrillActive()` exported from `drill.js`

- [ ] **Step 1: Add the API wrappers**

Append to `src/api.js`:

```js
export const drillSetWord = (word) => invoke("drill_set_word", { word });
export const drillSuggestWord = () => invoke("drill_suggest_word");
export const speakText = (text) => invoke("speak_text", { text });

export async function drillScore(word, audioBytes) {
  return invoke("drill_score", { word, audio: Array.from(audioBytes) });
}
```

- [ ] **Step 2: Write the drill controller**

Create `src/drill.js`:

```js
// ============================================================================
// Drill view: type a German word, hear it, say it, see which syllables were
// wrong.
//
// Unlike a conversation turn, a drill attempt is a plain request/response --
// `drillScore` returns the whole result at once, so there are no events to
// subscribe to and no partial states to reconcile.
// ============================================================================

import { drillSetWord, drillSuggestWord, drillScore, speakText, stopPlayback } from "./api.js";
import { startRecording, stopRecording } from "./audio.js";

const $ = (id) => document.getElementById(id);

let active = false;
let target = null; // { word, ipa, syllables[] }
let recState = "ready"; // 'ready' | 'recording' | 'thinking'
let enginesReady = true;
let hooks = { onEnter: null, onExit: null };

export const isDrillActive = () => active;

function setRecState(state) {
  recState = state;
  $("recordbar").dataset.state = state;
  if (state === "ready") {
    $("rec-caption").textContent = enginesReady ? "press to try again" : "pronunciation model missing";
  } else if (state === "thinking") {
    $("rec-caption").textContent = "analysing…";
  }
}

function showError(message) {
  $("drill-error").textContent = message || "";
}

function clearAttempt() {
  $("drill-syllables").innerHTML = "";
  $("drill-feedback").textContent = "";
}

function renderTarget(t) {
  target = t;
  $("drill-word").textContent = t.word;
  $("drill-ipa").textContent = t.ipa ? `/${t.ipa}/` : "";
  $("drill-listen").disabled = false;
  clearAttempt();
}

function renderAttempt(result) {
  const row = $("drill-syllables");
  row.innerHTML = "";
  for (const syllable of result.syllables) {
    const cell = document.createElement("div");
    cell.className = "drill-syllable " + syllable.score;
    const text = document.createElement("span");
    text.textContent = syllable.text;
    const bar = document.createElement("span");
    bar.className = "bar";
    cell.append(text, bar);
    row.appendChild(cell);
  }
  $("drill-feedback").textContent = result.feedback;
}

async function submitWord(word) {
  showError("");
  try {
    renderTarget(await drillSetWord(word));
  } catch (e) {
    target = null;
    $("drill-word").textContent = "";
    $("drill-ipa").textContent = "";
    $("drill-listen").disabled = true;
    clearAttempt();
    showError(String(e));
  }
}

async function onSuggest() {
  showError("");
  $("drill-suggest").disabled = true;
  try {
    const word = await drillSuggestWord();
    $("drill-input").value = word;
    await submitWord(word);
  } catch (e) {
    showError(String(e));
  } finally {
    $("drill-suggest").disabled = !enginesReady ? true : false;
  }
}

async function onListen() {
  if (!target) return;
  try {
    await speakText(target.word);
  } catch (e) {
    showError(String(e));
  }
}

// The record button is shared with the conversation view, so this only runs
// when the drill view is active -- app.js routes the click.
export async function onDrillRecordClick() {
  if (recState === "thinking") return;
  if (!target) {
    showError("Enter a word first");
    return;
  }

  if (recState === "ready") {
    if (!enginesReady) return;
    try {
      await startRecording();
      setRecState("recording");
      $("rec-caption").textContent = "listening · Stop";
    } catch (e) {
      showError("Microphone unavailable: " + e.message);
    }
    return;
  }

  setRecState("thinking");
  try {
    const bytes = await stopRecording();
    const result = await drillScore(target.word, bytes);
    renderAttempt(result);
    showError("");
  } catch (e) {
    clearAttempt();
    showError(String(e));
  } finally {
    setRecState("ready");
  }
}

export function setDrillEnginesReady(ready) {
  enginesReady = ready;
  if (active) {
    $("rec-btn").disabled = !ready;
    if (recState === "ready") {
      $("rec-caption").textContent = ready ? "press to try again" : "pronunciation model missing";
    }
  }
}

export async function enterDrill() {
  active = true;
  document.body.dataset.view = "drill";
  // A tutor reply still playing must not talk over the first attempt. This
  // also bumps the backend's turn generation, cancelling any in-flight turn.
  try {
    await stopPlayback();
  } catch (_) {
    // Best-effort.
  }
  hooks.onEnter?.();
  setRecState("ready");
  $("rec-btn").disabled = !enginesReady;
  $("drill-input").focus();
}

export function exitDrill() {
  active = false;
  document.body.dataset.view = "conversation";
  hooks.onExit?.();
}

export function initDrill({ onEnter, onExit }) {
  hooks = { onEnter, onExit };
  document.body.dataset.view = "conversation";

  $("drill-btn").addEventListener("click", enterDrill);
  $("drill-back").addEventListener("click", exitDrill);
  $("drill-suggest").addEventListener("click", onSuggest);
  $("drill-listen").addEventListener("click", onListen);
  $("drill-listen").disabled = true;

  $("drill-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitWord($("drill-input").value);
  });
  $("drill-input").addEventListener("blur", () => {
    const value = $("drill-input").value.trim();
    if (value && value !== target?.word) submitWord(value);
  });
}
```

- [ ] **Step 3: Route the shared record button and health in app.js**

In `src/app.js`, add to the imports:

```js
import { initDrill, isDrillActive, onDrillRecordClick, setDrillEnginesReady, exitDrill } from "./drill.js";
```

Change `refreshHealth`'s health handling so the drill's readiness is fed through — replace the `setEnginesReady(h.whisper && h.tts);` line with:

```js
    setEnginesReady(h.whisper && h.tts);
    setDrillEnginesReady(h.pron && h.tts);
    $("drill-suggest").disabled = !h.llm;
```

Rename the existing click handler registration so drill clicks are routed. Replace:

```js
$("rec-btn").addEventListener("click", onRecordClick);
```

with:

```js
// The record bar is shared between the two views; the active view owns the click.
$("rec-btn").addEventListener("click", () => {
  if (isDrillActive()) onDrillRecordClick();
  else onRecordClick();
});
```

Guard the conversation's own state changes so a drill attempt can't be clobbered — at the top of `setEnginesReady`, after `enginesReady = ready;`:

```js
  if (isDrillActive()) return;
```

And register the view at the bottom, before `refreshHealth();`:

```js
initDrill({
  // Leaving drill returns the record bar to the conversation's idle state.
  onExit: () => settleTurn(),
});
```

- [ ] **Step 4: Verify the loop by hand**

Run: `cargo tauri dev` (MSVC env active).

Check each:
1. Click **Drill** — the view switches, the input is focused.
2. Type `Vielleicht`, press Enter — the word renders at 52px with `/…/` beneath it.
3. Click **Listen** — the German word is spoken.
4. Click record, say the word, click stop — the caption reads "analysing…", then syllable bars and a feedback line appear.
5. Say it deliberately wrong (hard **k** in "leicht") — at least one bar turns red and the feedback names the syllable.
6. Type `12` and press Enter — an inline error appears; nothing crashes.
7. Click **Surprise me** — a German word lands in the input and renders.
8. Click **Back** — the transcript returns intact and the record bar reads "Record".

- [ ] **Step 5: Commit**

```bash
git rev-parse --show-toplevel   # MUST end in TandemLive
git add src/drill.js src/api.js src/app.js
git commit -m "feat: drill view behavior"
```

---

## Task 10: Integration tests and documentation

**Files:**
- Create: `src-tauri/tests/pron_integration.rs`
- Modify: `README.md`, `TODO.md`

**Interfaces:**
- Consumes: `PronScorer`, `Settings`
- Produces: nothing consumed by other tasks

- [ ] **Step 1: Write the gated integration test**

Create `src-tauri/tests/pron_integration.rs`, following the `#[ignore]` convention already used by `tts_integration.rs` and `stt_integration.rs`:

```rust
// ============================================================================
// End-to-end pronunciation scoring, gated on the model files being present.
//
// `#[ignore]` by default (matching tts_integration/stt_integration): CI and a
// fresh clone have no models/ directory. Run explicitly with:
//   cargo test --test pron_integration -- --ignored --nocapture
// ============================================================================

use tandemlive_lib::config::Settings;
use tandemlive_lib::pron::PronScorer;

fn scorer() -> PronScorer {
    let settings = Settings::load();
    PronScorer::load(&settings).expect("load the pronunciation model")
}

/// TTS -> scorer round-trip: a synthesized word is, by construction, correctly
/// pronounced, so it must score clean. This is the test that would catch a
/// broken vocab mapping or a wrong normalization -- both of which would make
/// every attempt score red regardless of how it was said.
#[test]
#[ignore]
fn a_synthesized_word_scores_well() {
    let settings = Settings::load();
    let tts = tandemlive_lib::tts::Supertonic::load(&settings).expect("load tts");
    let (pcm, sample_rate) = tts
        .synthesize("Vielleicht", &settings.default_voice, &settings.language)
        .expect("synthesize");

    let mut wav = std::io::Cursor::new(Vec::new());
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    {
        let mut writer = hound::WavWriter::new(&mut wav, spec).expect("wav writer");
        for sample in &pcm {
            writer
                .write_sample((sample * i16::MAX as f32) as i16)
                .expect("write sample");
        }
        writer.finalize().expect("finalize");
    }

    let attempt = scorer()
        .score("Vielleicht", &wav.into_inner(), 1.0)
        .expect("score");

    println!("recognized: {}", attempt.ipa_actual);
    println!("feedback:   {}", attempt.feedback);
    assert!(!attempt.syllables.is_empty());
    assert!(
        !attempt.ipa_actual.is_empty(),
        "the recognizer produced no phones at all"
    );
    let good = attempt.syllables.iter().filter(|s| s.score == "good").count();
    assert!(
        good >= 1,
        "a correctly synthesized word scored no syllable good: {attempt:?}"
    );
}

/// Scoring audio of one word against a different target must not score clean.
/// Without this, a scorer that returns "good" unconditionally would pass the
/// test above.
#[test]
#[ignore]
fn the_wrong_word_does_not_score_clean() {
    let settings = Settings::load();
    let tts = tandemlive_lib::tts::Supertonic::load(&settings).expect("load tts");
    let (pcm, sample_rate) = tts
        .synthesize("Buch", &settings.default_voice, &settings.language)
        .expect("synthesize");

    let mut wav = std::io::Cursor::new(Vec::new());
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    {
        let mut writer = hound::WavWriter::new(&mut wav, spec).expect("wav writer");
        for sample in &pcm {
            writer
                .write_sample((sample * i16::MAX as f32) as i16)
                .expect("write sample");
        }
        writer.finalize().expect("finalize");
    }

    let attempt = scorer()
        .score("Eichhörnchen", &wav.into_inner(), 1.0)
        .expect("score");

    println!("recognized: {}", attempt.ipa_actual);
    assert!(
        attempt.syllables.iter().any(|s| s.score == "needs_work"),
        "audio of \"Buch\" scored fully good against \"Eichhörnchen\": {attempt:?}"
    );
}

/// A missing model must surface as an error, not a panic -- the graceful
/// degradation contract.
#[test]
fn a_missing_model_fails_to_load_without_panicking() {
    let mut settings = Settings::default();
    settings.pron_model_dir = "definitely/not/a/real/path".into();
    assert!(PronScorer::load(&settings).is_err());
}
```

- [ ] **Step 2: Run the always-on test**

Run: `cargo test --test pron_integration`
Expected: PASS, 1 test run, 2 ignored.

- [ ] **Step 3: Run the gated tests**

Run: `cargo test --test pron_integration -- --ignored --nocapture`
Expected: PASS, 2 tests. Read the printed `recognized:` lines — they are the evidence the pipeline works end to end.

If `a_synthesized_word_scores_well` fails, the likely causes in order: the vocab is off by one (check `vocab.json[0]` is the pad token), the audio isn't being resampled to 16 kHz, or the threshold of 1.0 is too strict for real audio. Diagnose before loosening the assertion — a test tuned until it passes is worthless here.

- [ ] **Step 4: Document it in the README**

Add to `README.md`, after the existing model setup section:

```markdown
### Pronunciation drill (optional)

Drill mode scores how you pronounce a single German word. It needs one extra
model, which is not included:

```bash
pip install torch transformers onnx
python scripts/export_phoneme_model.py
```

This writes `models/pron/model.onnx` and `models/pron/vocab.json` (~1 GB). If
they are absent the app still runs normally — the Drill button reports the
model as missing and the conversation view is unaffected.

**Using it:** click **Drill** in the header, type a German word (or press
**Surprise me** for one from the tutor), press **Listen** to hear it, then
record yourself. Each syllable gets a green or red bar, with one tip about the
sound that needs the most work.

**Tuning:** if real speech is scored too harshly, lower `pron_score_threshold`
in `settings.json` (default `1.0` = every phone in a syllable must be right;
`0.6` forgives one phone in three).
```

- [ ] **Step 5: Update TODO.md**

In `TODO.md`, under "Nice to have", edit the "Strip dead surfaces" entry to remove `speak_text` from the list, and add this note under "Worth doing first" on the HTTP-timeouts item:

```markdown
      Now also affects drill mode: "Surprise me" is a second UI path that can
      hang on an LM Studio JIT model load.
```

- [ ] **Step 6: Full verification**

Run: `cargo fmt && cargo clippy --all-targets && cargo test`
Expected: no warnings; all unit and integration tests pass; only the 3 model-gated tests ignored (1 pre-existing + 2 new).

- [ ] **Step 7: Commit**

```bash
git rev-parse --show-toplevel   # MUST end in TandemLive
git add src-tauri/tests/pron_integration.rs README.md TODO.md
git commit -m "test: end-to-end pronunciation scoring; document drill mode"
```

---

## Self-Review Notes

Checked against the spec:

- §2 (why a target word is required) → Tasks 7/9: word comes only from typing or `drill_suggest_word`; Whisper is never used as a reference.
- §3.1–3.3 (engine, model, reuse) → Tasks 1, 5. `speak_text` reused in Task 9 Step 2.
- §3.4 (Needleman–Wunsch) → Task 2.
- §3.5 (syllable rollup) → Task 3.
- §3.6 (rule table) → Task 4.
- §3.7 (configurable threshold) → Task 5 Step 4, Task 4's `threshold` parameter, README Step 4.
- §4.1–4.3 (view state, layout, frontend state) → Tasks 8, 9.
- §5 (commands, no events) → Task 7.
- §6 (degradation, `player.stop()` on entry) → Task 6, Task 9's `enterDrill`.
- §7 (testing) → Tasks 2, 3, 4, 5, 7 (unit); Task 10 (gated).
- §8 (spike first) → Task 1, with explicit stop conditions.
- §9 (TODO impact) → Task 10 Step 5.

Known risks carried into execution:

1. **The `espeak-ng` crate is unproven here.** Task 1 Step 6 gates on it. Its API is assumed to be `text_to_phonemes(text, lang, opts) -> Result<String>`; if the real signature differs, adapt the call sites in `g2p.rs` — do not swap the crate without reporting.
2. **`ort` rc.7 API details** (`inputs!`, `try_extract_raw_tensor`) are copied from the shape used in `tts/mod.rs`. If they don't compile, match whatever `tts/mod.rs` actually does — that file is known-good against this exact pinned version.
3. **Hyphenation may disagree** with intuition about where syllables break. Task 3 Step 4 explicitly says to adjust the assertion, not the code.
