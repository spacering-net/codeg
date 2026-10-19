//! `--output-schema`: a run that hands in its result as JSON matching a
//! schema.
//!
//! The agent hands it in with codeg-mcp's `submit_result`, a tool whose input
//! schema is the run's schema: each result is checked here, and one that does
//! not match is refused with what to fix, so the agent can try again — up to
//! [`MAX_REFUSED`] times. An agent codeg-mcp cannot reach (Pi, Cline,
//! OpenClaw) is asked to reply with the JSON instead, and so is every agent
//! read that way when it ends its turn without a result: the whole reply, or
//! its one ```json block.
//!
//! The schema travels with the run's root connection from the moment it
//! exists (`RootSeed`), so the connection's codeg-mcp is given the tool; a
//! delegated child never is.

use std::sync::Mutex as StdMutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

/// The largest schema a run takes, compact: it goes with the tool's
/// definition into every request the agent makes to its model.
pub const MAX_OUTPUT_SCHEMA_BYTES: usize = 64 * 1024;

/// How many results `submit_result` refuses before it takes no more.
pub const MAX_REFUSED: u32 = 5;

/// How many of a result's mismatches are told, and how long each may be.
const MAX_ERRORS: usize = 8;
const MAX_ERROR_CHARS: usize = 300;

/// Where the schema is said to live: a `$ref` to anything outside it
/// resolves elsewhere, and is refused.
const SCHEMA_URL: &str = "https://codeg.invalid/output-schema.json";

/// The checks that need no compiled schema — also made by `codeg-cli` before
/// it sends one: a JSON object, at most [`MAX_OUTPUT_SCHEMA_BYTES`], whose
/// root takes objects only.
pub fn check_shape(schema: &Value) -> Result<(), String> {
    let Some(root) = schema.as_object() else {
        return Err("an output schema is a JSON object".into());
    };
    let size = serde_json::to_vec(schema).map(|b| b.len()).unwrap_or(0);
    if size > MAX_OUTPUT_SCHEMA_BYTES {
        return Err(format!(
            "the output schema is {size} bytes; it may be {} KiB at most",
            MAX_OUTPUT_SCHEMA_BYTES / 1024
        ));
    }
    let takes_objects_only = match root.get("type") {
        Some(Value::String(t)) => t == "object",
        Some(Value::Array(types)) => types.len() == 1 && types[0] == "object",
        _ => false,
    };
    if !takes_objects_only {
        return Err(
            "the output schema's root must say \"type\": \"object\": the result is \
             handed in as a tool's arguments, which are an object. Put a list or a single \
             value in a property of one"
                .into(),
        );
    }
    Ok(())
}

/// True when a host's name for a tool is codeg's own `submit_result`, in
/// whatever spelling the host composed it
/// ([`crate::acp::delegation::is_codeg_mcp_tool`]).
pub fn is_codeg_submit_tool_name(name: &str) -> bool {
    crate::acp::delegation::is_codeg_mcp_tool(name, "submit_result")
}

/// A refused result, for the run's `notice` events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// 1 for the first result refused.
    pub number: u32,
    pub errors: Vec<String>,
}

/// What `submit_result` answers, as codeg-mcp relays it to the agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubmitOutcome {
    pub accepted: bool,
    /// For the agent: what became of the result, and what to do next.
    pub message: String,
    /// Where the result does not match, one line each.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

impl SubmitOutcome {
    fn refused(message: impl Into<String>, errors: Vec<String>) -> Self {
        Self {
            accepted: false,
            message: message.into(),
            errors,
        }
    }

    /// For a connection that was asked for no result.
    pub fn not_asked() -> Self {
        Self::refused(
            "Not accepted: this session was not asked for a result.",
            Vec::new(),
        )
    }
}

/// How a run's result came out, once its turn is over.
#[derive(Debug, Clone, PartialEq)]
pub struct Settlement {
    /// The result that matches: the last `submit_result` accepted, or else the
    /// JSON in the agent's reply.
    pub output: Option<Value>,
    /// Without one: why, for people.
    pub unmet: Option<String>,
}

#[derive(Default)]
struct Handed {
    /// The last result that matched.
    accepted: Option<Value>,
    refused: u32,
    last_errors: Vec<String>,
    /// The run settled: nothing more is taken.
    closed: bool,
    refusals: Option<mpsc::UnboundedSender<Refusal>>,
}

/// Why the reply is not the result.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ReplyMiss {
    NoReply,
    NoJson,
    /// Its one ```json block, and why that is not JSON.
    BadBlock(String),
    /// How many ```json blocks it has.
    SeveralBlocks(usize),
    Mismatch(Vec<String>),
}

/// A run's `--output-schema`, compiled, and what the agent handed in against
/// it. Shared by the run and its root connection's state, where the listener
/// finds it for `submit_result`.
pub struct OutputSchema {
    schema: Value,
    schemas: boon::Schemas,
    index: boon::SchemaIndex,
    handed: StdMutex<Handed>,
}

impl std::fmt::Debug for OutputSchema {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutputSchema")
            .field("schema", &self.schema)
            .finish_non_exhaustive()
    }
}

/// Refuses every load: a schema is checked as written, never with what a
/// `$ref` to elsewhere would fetch — a file on the runtime's machine, say.
struct NoLoads;

impl boon::UrlLoader for NoLoads {
    fn load(&self, url: &str) -> Result<Value, Box<dyn std::error::Error>> {
        Err(format!("{url} is outside the schema, and nothing outside it is read").into())
    }
}

impl OutputSchema {
    /// The schema, checked ([`check_shape`]) and compiled. `$schema` picks the
    /// draft; 2020-12 without one.
    pub fn compile(schema: Value) -> Result<Self, String> {
        check_shape(&schema)?;
        let mut compiler = boon::Compiler::new();
        compiler.set_default_draft(boon::Draft::V2020_12);
        compiler.use_loader(Box::new(NoLoads));
        compiler
            .add_resource(SCHEMA_URL, schema.clone())
            .map_err(|e| format!("the output schema cannot be read: {e:#}"))?;
        let mut schemas = boon::Schemas::new();
        let index = compiler
            .compile(SCHEMA_URL, &mut schemas)
            .map_err(|e| format!("the output schema is not a valid JSON Schema: {e:#}"))?;
        Ok(Self {
            schema,
            schemas,
            index,
            handed: StdMutex::new(Handed::default()),
        })
    }

    /// The schema as it was given: `submit_result`'s input schema.
    pub fn schema(&self) -> &Value {
        &self.schema
    }

    /// Each refused result from now on, until the run settles.
    pub fn refusals(&self) -> mpsc::UnboundedReceiver<Refusal> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.handed.lock().expect("handed").refusals = Some(tx);
        rx
    }

    fn check(&self, value: &Value) -> Result<(), Vec<String>> {
        self.schemas
            .validate(value, self.index)
            .map_err(|e| mismatches(&e))
    }

    /// A result handed in with `submit_result`.
    pub fn submit(&self, value: Value) -> SubmitOutcome {
        let mut handed = self.handed.lock().expect("handed");
        if handed.closed {
            return SubmitOutcome::refused("Not accepted: this run has ended.", Vec::new());
        }
        if handed.refused >= MAX_REFUSED {
            return SubmitOutcome::refused(
                format!(
                    "Not accepted: {MAX_REFUSED} results were refused, and this run takes no \
                     more. End your turn, and say what kept the result from matching."
                ),
                Vec::new(),
            );
        }
        let errors = match self.check(&value) {
            Ok(()) => {
                handed.accepted = Some(value);
                return SubmitOutcome {
                    accepted: true,
                    message: "Accepted: this is the run's result. You can end your turn; \
                              calling submit_result again replaces it."
                        .into(),
                    errors: Vec::new(),
                };
            }
            Err(errors) => errors,
        };
        handed.refused += 1;
        handed.last_errors = errors.clone();
        if let Some(tx) = &handed.refusals {
            let _ = tx.send(Refusal {
                number: handed.refused,
                errors: errors.clone(),
            });
        }
        let left = MAX_REFUSED - handed.refused;
        let mut message = if left == 0 {
            "Not accepted: the result does not match the schema, and that was the last try. \
             End your turn, and say what kept it from matching."
                .to_string()
        } else {
            format!(
                "Not accepted: the result does not match the schema. Fix what is listed and \
                 call submit_result again ({left} more {}).",
                if left == 1 { "try" } else { "tries" }
            )
        };
        if handed.accepted.is_some() {
            message.push_str(" The result accepted before still stands.");
        }
        SubmitOutcome::refused(message, errors)
    }

    /// The run's turn is over: take nothing more, and say how the result came
    /// out. `reply` is the agent's final reply; `tool_offered`, whether it had
    /// `submit_result`.
    pub fn settle(&self, reply: Option<&str>, tool_offered: bool) -> Settlement {
        let (accepted, refused, last_errors) = {
            let mut handed = self.handed.lock().expect("handed");
            handed.closed = true;
            handed.refusals = None;
            (
                handed.accepted.clone(),
                handed.refused,
                handed.last_errors.clone(),
            )
        };
        if let Some(output) = accepted {
            return Settlement {
                output: Some(output),
                unmet: None,
            };
        }
        let miss = match reply.map(|text| self.check_reply(text)) {
            Some(Ok(output)) => {
                return Settlement {
                    output: Some(output),
                    unmet: None,
                }
            }
            Some(Err(miss)) => miss,
            None => ReplyMiss::NoReply,
        };
        let unmet = if refused > 0 {
            format!(
                "the agent handed in no result that matches --output-schema: submit_result \
                 refused {refused}, the last for {}",
                last_errors.join("; ")
            )
        } else {
            let (no_call, reply_part) = if tool_offered {
                ("the agent did not call submit_result, and ", "its reply")
            } else {
                ("", "the agent's reply")
            };
            match miss {
                ReplyMiss::NoReply if tool_offered => {
                    "the agent ended its turn without calling submit_result".to_string()
                }
                ReplyMiss::NoReply => {
                    "the agent ended its turn without a reply, so there is no result".to_string()
                }
                ReplyMiss::NoJson => format!(
                    "{no_call}{reply_part} holds no JSON: it is not JSON as a whole, and has no \
                     ```json block"
                ),
                ReplyMiss::BadBlock(why) => {
                    format!("{no_call}the ```json block in {reply_part} is not JSON: {why}")
                }
                ReplyMiss::SeveralBlocks(n) => format!(
                    "{no_call}{reply_part} has {n} ```json blocks, and only one can be the result"
                ),
                ReplyMiss::Mismatch(errors) => format!(
                    "{no_call}the JSON in {reply_part} does not match --output-schema: {}",
                    errors.join("; ")
                ),
            }
        };
        Settlement {
            output: None,
            unmet: Some(unmet),
        }
    }

    fn check_reply(&self, text: &str) -> Result<Value, ReplyMiss> {
        let value = json_in_reply(text)?;
        self.check(&value).map_err(ReplyMiss::Mismatch)?;
        Ok(value)
    }

    /// What the agent is told, after the prompt: how to hand the result in.
    /// Without the tool, the schema itself.
    pub fn instructions(&self, tool_offered: bool) -> String {
        if tool_offered {
            return "The person who started this run from Codeg's command line wants its result \
                    as JSON. When you are done, call the `submit_result` tool with the result as \
                    its arguments. It checks them against its input schema: a result that does \
                    not match is refused with what to fix, and you call it again. Your reply \
                    can say whatever else is worth saying."
                .to_string();
        }
        let schema = serde_json::to_string_pretty(&self.schema).unwrap_or_default();
        format!(
            "The person who started this run from Codeg's command line wants its result as \
             JSON. When you are done, reply with the result: one JSON object matching the JSON \
             Schema below, as the whole reply or in a single ```json code block.\n\n```json\n\
             {schema}\n```"
        )
    }
}

/// The JSON a reply holds: the whole reply, or its one ```json block.
fn json_in_reply(text: &str) -> Result<Value, ReplyMiss> {
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        return Ok(value);
    }
    let mut blocks: Vec<String> = Vec::new();
    let mut open: Option<Vec<&str>> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        match &mut open {
            Some(body) => {
                if trimmed == "```" {
                    blocks.push(body.join("\n"));
                    open = None;
                } else {
                    body.push(line);
                }
            }
            None => {
                if let Some(info) = trimmed.strip_prefix("```") {
                    if info.trim().eq_ignore_ascii_case("json") {
                        open = Some(Vec::new());
                    }
                }
            }
        }
    }
    match blocks.as_slice() {
        [] => Err(ReplyMiss::NoJson),
        [only] => serde_json::from_str(only).map_err(|e| ReplyMiss::BadBlock(e.to_string())),
        several => Err(ReplyMiss::SeveralBlocks(several.len())),
    }
}

/// One line for each place a value does not match: the innermost reasons,
/// first ones first.
fn mismatches(error: &boon::ValidationError) -> Vec<String> {
    fn leaves(error: &boon::ValidationError, out: &mut Vec<String>) {
        if error.causes.is_empty() {
            let place = error.instance_location.to_string();
            let place = if place.is_empty() {
                "the top level".to_string()
            } else {
                place
            };
            let mut line = format!("at {place}: {}", error.kind);
            if line.chars().count() > MAX_ERROR_CHARS {
                line = line.chars().take(MAX_ERROR_CHARS).collect::<String>() + "…";
            }
            if !out.contains(&line) {
                out.push(line);
            }
            return;
        }
        for cause in &error.causes {
            leaves(cause, out);
        }
    }
    let mut out = Vec::new();
    leaves(error, &mut out);
    out.truncate(MAX_ERRORS);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn review_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "verdict": {"enum": ["pass", "fail"]},
                "issues": {"type": "array", "items": {"type": "string"}}
            },
            "required": ["verdict", "issues"],
            "additionalProperties": false
        })
    }

    fn compiled() -> OutputSchema {
        OutputSchema::compile(review_schema()).expect("a good schema compiles")
    }

    #[test]
    fn only_an_object_schema_of_objects_is_taken() {
        for (schema, why) in [
            (json!(true), "a JSON object"),
            (json!({"type": "array"}), "\"type\": \"object\""),
            (json!({"properties": {}}), "\"type\": \"object\""),
            (json!({"type": ["object", "null"]}), "\"type\": \"object\""),
        ] {
            let err = OutputSchema::compile(schema.clone()).unwrap_err();
            assert!(err.contains(why), "{schema}: {err}");
        }
        assert!(OutputSchema::compile(json!({"type": ["object"]})).is_ok());
        let big = json!({"type": "object", "description": "x".repeat(MAX_OUTPUT_SCHEMA_BYTES)});
        assert!(OutputSchema::compile(big).unwrap_err().contains("64 KiB"));
    }

    #[test]
    fn a_schema_that_is_not_one_is_refused() {
        let err =
            OutputSchema::compile(json!({"type": "object", "minProperties": "two"})).unwrap_err();
        assert!(err.contains("not a valid JSON Schema"), "{err}");
    }

    /// Nothing outside the schema is read: not a file on the runtime's
    /// machine, not a URL. A reference inside it is followed.
    #[test]
    fn a_reference_is_followed_inside_the_schema_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("other.json");
        std::fs::write(&file, r#"{"type": "string"}"#).unwrap();
        let file_url = url::Url::from_file_path(&file).unwrap().to_string();
        for target in [
            file_url.as_str(),
            "https://example.com/s.json",
            "other.json",
        ] {
            let schema = json!({"type": "object", "properties": {"a": {"$ref": target}}});
            let err = OutputSchema::compile(schema).unwrap_err();
            assert!(
                err.contains("nothing outside it is read"),
                "{target}: {err}"
            );
        }
        let inner = OutputSchema::compile(json!({
            "type": "object",
            "properties": {"a": {"$ref": "#/$defs/word"}},
            "$defs": {"word": {"type": "string"}}
        }))
        .unwrap();
        assert!(inner.submit(json!({"a": "x"})).accepted);
        assert!(!inner.submit(json!({"a": 1})).accepted);
    }

    #[test]
    fn the_draft_is_the_schemas_own() {
        // Draft 7 reads `items` as an array as one schema per position.
        let draft7 = OutputSchema::compile(json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {"pair": {"items": [{"type": "string"}, {"type": "integer"}]}}
        }))
        .unwrap();
        assert!(draft7.submit(json!({"pair": ["a", 1]})).accepted);
        assert!(!draft7.submit(json!({"pair": [1, "a"]})).accepted);
    }

    /// `format` is checked as each draft has it — in draft 7 and earlier, not
    /// in 2020-12 — as docs/cli.md says.
    #[test]
    fn format_is_checked_as_the_draft_says() {
        let schema = |draft: Option<&str>| {
            let mut schema = json!({
                "type": "object",
                "properties": {"mail": {"type": "string", "format": "email"}}
            });
            if let Some(draft) = draft {
                schema["$schema"] = json!(draft);
            }
            OutputSchema::compile(schema).unwrap()
        };
        let not_mail = json!({"mail": "not an address"});
        assert!(schema(None).submit(not_mail.clone()).accepted);
        assert!(
            !schema(Some("http://json-schema.org/draft-07/schema#"))
                .submit(not_mail)
                .accepted
        );
    }

    #[test]
    fn a_result_that_matches_is_the_runs() {
        let schema = compiled();
        let outcome = schema.submit(json!({"verdict": "pass", "issues": []}));
        assert!(outcome.accepted, "{outcome:?}");
        assert!(outcome.errors.is_empty());
        let settled = schema.settle(Some("All good."), true);
        assert_eq!(
            settled.output,
            Some(json!({"verdict": "pass", "issues": []}))
        );
        assert_eq!(settled.unmet, None);
    }

    #[test]
    fn a_result_that_does_not_match_is_refused_with_where() {
        let schema = compiled();
        let mut refusals = schema.refusals();
        let outcome = schema.submit(json!({"verdict": "maybe", "issues": [1], "extra": true}));
        assert!(!outcome.accepted);
        assert!(
            outcome.message.contains("4 more tries"),
            "{}",
            outcome.message
        );
        let all = outcome.errors.join("\n");
        assert!(all.contains("at /verdict"), "{all}");
        assert!(all.contains("at /issues/0"), "{all}");
        assert!(all.contains("at the top level"), "{all}");
        let told = refusals.try_recv().expect("the run hears of it");
        assert_eq!(told.number, 1);
        assert_eq!(told.errors, outcome.errors);
    }

    #[test]
    fn the_last_result_accepted_counts_and_a_refusal_does_not_undo_it() {
        let schema = compiled();
        assert!(
            schema
                .submit(json!({"verdict": "fail", "issues": ["a"]}))
                .accepted
        );
        let refused = schema.submit(json!({"verdict": 3}));
        assert!(!refused.accepted);
        assert!(refused.message.contains("accepted before still stands"));
        assert!(
            schema
                .submit(json!({"verdict": "pass", "issues": []}))
                .accepted
        );
        assert_eq!(
            schema.settle(None, true).output,
            Some(json!({"verdict": "pass", "issues": []}))
        );
    }

    #[test]
    fn after_five_refusals_nothing_more_is_taken() {
        let schema = compiled();
        for n in 1..=MAX_REFUSED {
            let outcome = schema.submit(json!({}));
            assert!(!outcome.accepted);
            if n == MAX_REFUSED {
                assert!(outcome.message.contains("last try"), "{}", outcome.message);
            }
        }
        let closed = schema.submit(json!({"verdict": "pass", "issues": []}));
        assert!(!closed.accepted, "even a good one");
        assert!(closed.message.contains("takes no more"));
        let settled = schema.settle(None, true);
        assert_eq!(settled.output, None);
        let unmet = settled.unmet.unwrap();
        assert!(unmet.contains("refused 5"), "{unmet}");
        assert!(unmet.contains("missing properties"), "{unmet}");
    }

    #[test]
    fn nothing_is_taken_once_the_run_settled() {
        let schema = compiled();
        let mut refusals = schema.refusals();
        let _ = schema.settle(None, true);
        let late = schema.submit(json!({"verdict": "pass", "issues": []}));
        assert!(!late.accepted);
        assert!(late.message.contains("has ended"));
        assert!(
            matches!(
                refusals.try_recv(),
                Err(mpsc::error::TryRecvError::Disconnected)
            ),
            "the run stops listening"
        );
    }

    #[test]
    fn a_reply_is_the_result_whole_or_in_its_one_json_block() {
        let good = r#"{"verdict": "pass", "issues": []}"#;
        for reply in [
            good.to_string(),
            format!("\n  {good}\n"),
            format!("Here it is:\n\n```json\n{good}\n```\nThat is all."),
            format!("```JSON\n{good}\n```"),
            // A block of another language does not count against it.
            format!("Ran:\n```sh\nls\n```\n```json\n{good}\n```"),
        ] {
            let settled = compiled().settle(Some(&reply), false);
            assert_eq!(
                settled.output,
                Some(json!({"verdict": "pass", "issues": []})),
                "{reply}"
            );
        }
        for (reply, why) in [
            ("Looks fine to me.".to_string(), "holds no JSON"),
            (
                format!("```json\n{good}\n```\nor\n```json\n{good}\n```"),
                "has 2 ```json blocks",
            ),
            (
                "```json\n{verdict: pass}\n```".to_string(),
                "block in the agent's reply is not JSON",
            ),
            (r#"{"verdict": "great"}"#.to_string(), "does not match"),
        ] {
            let settled = compiled().settle(Some(&reply), false);
            assert_eq!(settled.output, None, "{reply}");
            let unmet = settled.unmet.unwrap();
            assert!(unmet.contains(why), "{reply}: {unmet}");
            assert!(!unmet.contains("submit_result"), "it had no tool: {unmet}");
        }
    }

    #[test]
    fn why_there_is_no_result_names_the_tool_it_had() {
        let unmet = compiled().settle(None, true).unmet.unwrap();
        assert_eq!(
            unmet,
            "the agent ended its turn without calling submit_result"
        );
        let unmet = compiled().settle(Some("done"), true).unmet.unwrap();
        assert!(
            unmet.starts_with("the agent did not call submit_result, and its reply holds no JSON")
        );
        let unmet = compiled().settle(None, false).unmet.unwrap();
        assert!(unmet.contains("without a reply"), "{unmet}");
    }

    #[test]
    fn an_agent_without_the_tool_is_given_the_schema() {
        let schema = compiled();
        let with_tool = schema.instructions(true);
        assert!(with_tool.contains("`submit_result`"));
        assert!(
            !with_tool.contains("\"verdict\""),
            "the tool carries the schema"
        );
        let without = schema.instructions(false);
        assert!(!without.contains("submit_result"));
        assert!(without.contains("\"verdict\""));
        assert!(without.contains("```json"));
    }

    #[test]
    fn the_submit_tool_is_known_by_both_halves_of_its_name() {
        for name in [
            "mcp__codeg-mcp__submit_result",
            "codeg-mcp/submit_result",
            "codeg-mcp: submit_result",
            "CODEG-MCP.SUBMIT_RESULT",
        ] {
            assert!(is_codeg_submit_tool_name(name), "{name}");
        }
        for name in [
            "mcp__other__submit_result",
            "mcp__other-codeg-mcp__submit_result",
            "mcp__codeg__mcp_submit_result",
            "mcp__codeg-mcp__submit_result_twice",
            "submit_result",
            "mcp__codeg-mcp__ask",
        ] {
            assert!(!is_codeg_submit_tool_name(name), "{name}");
        }
    }

    #[test]
    fn an_outcome_reads_the_same_on_both_sides_of_the_socket() {
        let outcome = compiled().submit(json!({"verdict": "pass"}));
        let wire = serde_json::to_value(&outcome).unwrap();
        assert_eq!(wire["accepted"], false);
        assert!(wire["errors"].as_array().is_some_and(|e| !e.is_empty()));
        assert_eq!(
            serde_json::from_value::<SubmitOutcome>(wire).unwrap(),
            outcome
        );
        let accepted =
            serde_json::to_value(compiled().submit(json!({"verdict": "pass", "issues": []})))
                .unwrap();
        assert!(accepted.get("errors").is_none());
    }
}
