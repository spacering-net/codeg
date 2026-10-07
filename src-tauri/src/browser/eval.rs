//! Running an agent's own code on a page — the most powerful thing on this
//! surface, and the one with a switch of its very own.
//!
//! Everything else an agent may do to a page is a *named* act: read the tree,
//! click the ref the tree handed out, type this text, take a picture. A person
//! sharing a tab at `control` can picture the whole set. Arbitrary code is not
//! a member of that set — it is the set — so it is gated twice more on top of
//! the share: a switch of its own, which ships OFF, and the `control` level.
//! Both are read from the registry here, and an agent cannot reach either.
//!
//! A per-snippet confirmation is available on top of those and is not on by
//! default (`evalApproval` in the frontend's `browser-prefs`). That is a
//! deliberate placement of the decision rather than an absence of one: the
//! question used to be asked once per snippet and never remembered, which is
//! the most repetitive consent in the app, and a dialog answered by reflex is
//! not consent. So the weight sits on the switch, whose own text says that
//! turning it on means code runs without asking — a question asked once, while
//! the person is deciding, instead of a hundred times while they are working.
//! Either way the run is recorded on that tab's activity strip: not asking is
//! not the same as not showing.
//!
//! Two decisions here are load-bearing and easy to get wrong later.
//!
//! **The code runs in the page's own world, not codeg's.** The tempting thing
//! is to reuse the isolated world the rest of this subsystem evaluates in — it
//! has a proven envelope and the page cannot see it. It is also where
//! `browser_snapshot`, `browser_screenshot` and the action tools build their
//! answers, out of that world's `JSON.stringify` and that world's prototypes.
//! One confirmed snippet could replace those, and from then on every later
//! tool call's answer is whatever the snippet wants it to be — including the
//! `url` the host holds against the grant, which is how a page nobody shared
//! would be read. A person who allows one snippet has not allowed that. The
//! page's world has exactly the reach they did allow, and is walled off from
//! ours by the engine.
//!
//! **The answer carries no address.** The code is inlined into the source text
//! the engine parses — it has to be, because `eval` and `new Function` are
//! what a page's CSP switches off, and this must work on a page with a strict
//! one. Inlined text can close the wrapper around it and return anything at
//! all, so nothing in [`EvalAnswer`] can be trusted for a decision. Where the
//! page *is* comes from a separate evaluation in codeg's own world, which no
//! agent text ever enters; see `commands::browser::agent_eval_core`.

use serde::{Deserialize, Serialize};

/// The most code a caller may send in one call.
///
/// A cap on consent rather than on cost. The person approving a snippet has to
/// be able to read it; four thousand characters is already more than anyone
/// reads carefully, and a tool that accepted a hundred kilobytes of minified
/// script would be asking for a signature on a document nobody opened.
pub const MAX_EVAL_CODE_CHARS: usize = 4000;

/// The most of the result that comes back. Rendering happens in the page, so
/// this is also what stops a page from answering with a hundred megabytes.
pub const MAX_EVAL_VALUE_CHARS: usize = 4000;

/// The most the host will even parse from the page. The render above already
/// bounds an honest answer; this bounds a dishonest one, before `serde_json`
/// walks it.
pub const MAX_EVAL_ANSWER_BYTES: usize = 256 * 1024;

/// What an agent asks to run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalRequest {
    /// A function body: the code runs inside `function () { … }`, so it
    /// `return`s the value to report. Statements, `const`, early returns and
    /// comments all behave as they read.
    pub code: String,
}

/// Why a snippet was not even put in front of a person.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadCode {
    Empty,
    TooLong,
}

impl BadCode {
    pub fn message(self) -> String {
        match self {
            BadCode::Empty => "browser_eval needs `code`: the body of a function to run on the \
                               page, which returns the value to report."
                .to_string(),
            BadCode::TooLong => format!(
                "browser_eval takes at most {MAX_EVAL_CODE_CHARS} characters of code. A person \
                 has to read and approve every snippet before it runs, so send the smallest \
                 piece that answers your question rather than a program."
            ),
        }
    }
}

/// Whether this is a snippet worth showing a person at all.
///
/// Length is counted in characters, not bytes: it stands in for how much there
/// is to read, and a page's worth of Japanese is a page's worth either way.
pub fn validate_code(code: &str) -> Result<(), BadCode> {
    if code.trim().is_empty() {
        return Err(BadCode::Empty);
    }
    if code.chars().count() > MAX_EVAL_CODE_CHARS {
        return Err(BadCode::TooLong);
    }
    Ok(())
}

/// What the page says came of the code.
///
/// Every field of it is page-controlled — by the snippet, which can close the
/// wrapper it was inlined into, and by the page, whose `JSON.stringify` builds
/// the envelope. It is reported to the agent and used for nothing else.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalAnswer {
    pub ok: bool,
    /// `"string"`, `"number"`, `"object"`, `"node"`, `"promise"`, … — what the
    /// value looked like where it was produced.
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub truncated: bool,
    /// The exception, when the snippet threw.
    #[serde(default)]
    pub error: Option<String>,
}

/// What the agent gets back from a snippet that ran.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalOutcome {
    /// What the value looked like: `"string"`, `"number"`, `"object"`,
    /// `"undefined"`, `"node"`, … As reported by the page, and useful rather
    /// than authoritative.
    pub kind: String,
    /// The value rendered as text, at most [`MAX_EVAL_VALUE_CHARS`].
    pub value: String,
    /// The render stopped at the cap.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// Where the page was, read in codeg's own world after the code ran — not
    /// from [`EvalAnswer`], which the snippet could have written itself.
    pub url: String,
}

/// Longest a `kind` may be before the host stops believing it is a type name.
const MAX_KIND_CHARS: usize = 32;

/// What [`EvalOutcome::kind`] says when the snippet threw.
///
/// An exception is an outcome, not a failure of the tool: "what does this
/// throw" is half of what anyone runs code on a page to find out, and an agent
/// that got told "the call failed" would have lost the stack trace that was
/// the answer.
pub const EVAL_KIND_EXCEPTION: &str = "exception";

impl EvalOutcome {
    /// Take the page's answer as far as it is worth taking: clamp the two
    /// strings it chose, and fill in the address the host read for itself.
    pub fn from_answer(answer: &EvalAnswer, url: String) -> Self {
        if !answer.ok {
            let (value, clipped) = clip(
                answer
                    .error
                    .as_deref()
                    .unwrap_or("the code threw, and the page did not say what"),
                MAX_EVAL_VALUE_CHARS,
            );
            return Self {
                kind: EVAL_KIND_EXCEPTION.to_string(),
                value,
                truncated: answer.truncated || clipped,
                url,
            };
        }
        let kind = answer
            .kind
            .as_deref()
            .filter(|k| !k.is_empty() && k.chars().count() <= MAX_KIND_CHARS)
            .unwrap_or("unknown");
        let (value, clipped) = clip(answer.value.as_deref().unwrap_or(""), MAX_EVAL_VALUE_CHARS);
        Self {
            kind: kind.to_string(),
            value,
            truncated: answer.truncated || clipped,
            url,
        }
    }
}

/// `text` at most `limit` characters, and whether anything was dropped. Cuts on
/// a character boundary — Rust's own, so there is no surrogate to split here,
/// unlike in the page.
fn clip(text: &str, limit: usize) -> (String, bool) {
    match text.char_indices().nth(limit) {
        None => (text.to_string(), false),
        Some((end, _)) => (text[..end].to_string(), true),
    }
}

/// The expression the engine is asked to evaluate in the page's world.
///
/// `code` goes in as source text, between newlines. The newlines are not
/// cosmetic: a snippet ending in a `//` comment would otherwise swallow the
/// rest of the wrapper and the whole thing would fail to parse.
///
/// All of it — renderer included — sits inside one function, so an evaluation
/// leaves no names behind on the page's globals. A page that could see
/// `__codegEvalRender` lying around would know codeg had run something, which
/// is the page's business least of all.
///
/// The snippet can break out of the function it is wrapped in — there is no
/// quoting that would stop it, short of `new Function`, which a page's CSP is
/// entitled to refuse. That costs nothing, because the only thing this
/// expression is trusted to produce is a string to show an agent. It is a
/// deliberate property of the design and not a gap in it; see the module
/// comment.
pub fn eval_call(code: &str) -> String {
    format!("(function(){{\n{RENDER_JS}\ntry {{\nvar __codegEvalValue = (function () {{\n{code}\n}})();\nreturn __codegEvalRender(__codegEvalValue);\n}} catch (e) {{\nreturn __codegEvalError(e);\n}}\n}})()")
}

/// The renderer, as source text opening every call.
///
/// Written against the page's own intrinsics because there are no others
/// available where it runs. A hostile page can make all of it lie; nothing the
/// host decides rests on what it says.
///
/// A file beside the other injected scripts rather than a literal here, for
/// the same reason they are: `browser-agent/probe.mjs` runs these exact bytes
/// in real Chrome, which is the only place any of this JS is ever executed by
/// a test.
const RENDER_JS: &str = include_str!("../../../src/browser-injected/eval-render.js");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snippet_nobody_could_read_is_refused_before_anyone_is_asked() {
        assert_eq!(validate_code("  "), Err(BadCode::Empty));
        assert_eq!(validate_code(""), Err(BadCode::Empty));
        assert!(validate_code("return 1 + 1").is_ok());

        let long = "a".repeat(MAX_EVAL_CODE_CHARS);
        assert!(validate_code(&long).is_ok());
        assert_eq!(validate_code(&format!("{long}a")), Err(BadCode::TooLong));

        // Characters, not bytes: the cap stands for how much there is to read.
        let wide = "字".repeat(MAX_EVAL_CODE_CHARS);
        assert!(wide.len() > MAX_EVAL_CODE_CHARS);
        assert!(validate_code(&wide).is_ok());
    }

    /// A snippet ending in a line comment must not swallow the wrapper that
    /// follows it — the newline after the code is what keeps the expression
    /// parseable.
    #[test]
    fn a_trailing_line_comment_cannot_eat_the_wrapper() {
        let js = eval_call("return 1 // done");
        assert!(js.contains("return 1 // done\n"));
        let after = js.split("return 1 // done").nth(1).unwrap();
        assert!(after.starts_with('\n'), "code is followed by a newline");
        assert!(after.contains("__codegEvalRender"));
    }

    /// The answer type has no address in it, and cannot grow one by accident:
    /// the field the host holds against the grant is filled in by the host.
    #[test]
    fn the_pages_answer_carries_no_address() {
        let raw = r#"{"ok":true,"kind":"string","value":"hi","url":"https://evil.example"}"#;
        let answer: EvalAnswer = serde_json::from_str(raw).expect("parses");
        assert_eq!(answer.value.as_deref(), Some("hi"));
        let outcome = EvalOutcome::from_answer(&answer, "https://real.example/".into());
        assert_eq!(outcome.url, "https://real.example/");
        assert_eq!(outcome.kind, "string");
        assert!(!outcome.truncated);
    }

    /// What the page chose to send is clamped on arrival as well as at the
    /// source: the render is the page's code, and a page that skips it is
    /// exactly the case the host cap is for.
    #[test]
    fn an_oversized_answer_is_clamped_by_the_host_too() {
        let answer = EvalAnswer {
            ok: true,
            kind: Some("x".repeat(64)),
            value: Some("v".repeat(MAX_EVAL_VALUE_CHARS + 500)),
            truncated: false,
            error: None,
        };
        let outcome = EvalOutcome::from_answer(&answer, "https://a.example/".into());
        assert_eq!(outcome.value.chars().count(), MAX_EVAL_VALUE_CHARS);
        assert!(outcome.truncated);
        // A "type name" that long is not one.
        assert_eq!(outcome.kind, "unknown");
    }

    /// A snippet that threw comes back as an outcome with the stack in it —
    /// not as a failed call, which would throw the answer away.
    #[test]
    fn an_exception_is_an_answer() {
        let answer = EvalAnswer {
            ok: false,
            kind: None,
            value: None,
            truncated: false,
            error: Some("TypeError: x is not a function\n    at <anonymous>:1:1".into()),
            };
        let outcome = EvalOutcome::from_answer(&answer, "https://a.example/".into());
        assert_eq!(outcome.kind, EVAL_KIND_EXCEPTION);
        assert!(outcome.value.starts_with("TypeError:"));
        assert_eq!(outcome.url, "https://a.example/");

        // And a page that says nothing about what it threw still produces a
        // sentence rather than an empty one.
        let mute = EvalAnswer {
            ok: false,
            ..Default::default()
        };
        assert!(!EvalOutcome::from_answer(&mute, "https://a.example/".into())
            .value
            .is_empty());
    }

    /// A value clipped at the cap must not be cut inside a character.
    #[test]
    fn clipping_lands_on_a_character_boundary() {
        let text = "🙂".repeat(10);
        let (clipped, cut) = clip(&text, 4);
        assert!(cut);
        assert_eq!(clipped.chars().count(), 4);
        assert_eq!(clipped, "🙂🙂🙂🙂");
    }

    /// The renderer opens every call, so a snippet that never returns anything
    /// still has something to report with — and nothing it declares outlives
    /// the call on the page's globals.
    #[test]
    fn every_call_carries_its_renderer_and_leaves_nothing_behind() {
        let js = eval_call("return document.title");
        // One expression, opening and closing here: everything the renderer
        // declares is function-scoped, so an evaluation leaves no names on the
        // page's globals. `browser-agent/probe.mjs` measures that end in a
        // real browser; this pins the shape it measures.
        assert!(js.starts_with("(function(){\n"));
        assert!(js.ends_with("})()"));
        assert!(js.contains("var __codegEvalClip"));
        assert!(js.contains("__codegEvalError"));
        assert!(js.contains("return document.title"));
    }
}
