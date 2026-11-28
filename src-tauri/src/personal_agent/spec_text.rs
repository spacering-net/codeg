//! Cards as words (9.5).
//!
//! A reply can carry a ```spec block: JSONL patches the page renders as a
//! card. Fed back to a brain — the recent conversation on a handoff card, a
//! quoted row, `timeline_read`, an executor's result excerpt — the JSON
//! lines would fill its context with markup. Each such block is turned into
//! its words instead: the titles, texts, table rows and buttons
//! (`[button] Go with plan A`), in the order the card shows them.
//!
//! A fence whose first line is not a patch (an RPM spec file) is left as it
//! is, the way the page leaves it code.

use std::borrow::Cow;
use std::collections::HashSet;

use serde_json::{Map, Value};

/// The most elements of one card turned into words.
const MAX_ELEMENTS: usize = 400;
/// The most items of one repeated list.
const MAX_REPEAT: usize = 50;
/// The most rows of a table or points of a chart.
const MAX_ROWS: usize = 30;
/// The deepest nesting walked.
const MAX_DEPTH: usize = 24;
/// The most segments of a patch's path: a deeper one is no card's, and
/// building it would nest values past what dropping them can recurse.
const MAX_PATH_SEGMENTS: usize = 32;

/// `text` with every card block in it turned into its words.
pub fn cards_as_text(text: &str) -> Cow<'_, str> {
    if !text.contains("spec") {
        return Cow::Borrowed(text);
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut changed = false;
    let mut i = 0;
    while i < lines.len() {
        let Some((marker, len)) = opening_fence(lines[i]) else {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        };
        // The block's lines, up to its closing fence (or the end: a reply
        // cut short).
        let mut end = i + 1;
        while end < lines.len() && !closes(lines[end], marker, len) {
            end += 1;
        }
        let body = &lines[i + 1..end.min(lines.len())];
        match card_words(body) {
            Some(words) => {
                out.push(words);
                changed = true;
            }
            None => out.extend(
                lines[i..(end + 1).min(lines.len())]
                    .iter()
                    .map(|l| l.to_string()),
            ),
        }
        i = end + 1;
    }
    if changed {
        Cow::Owned(out.join("\n"))
    } else {
        Cow::Borrowed(text)
    }
}

/// A fence that opens a block labelled `spec`: its marker and length.
fn opening_fence(line: &str) -> Option<(char, usize)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let marker = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let len = rest.chars().take_while(|c| *c == marker).count();
    if len < 3 {
        return None;
    }
    let info = rest[len..].trim();
    (info.split_whitespace().next() == Some("spec")).then_some((marker, len))
}

fn closes(line: &str, marker: char, len: usize) -> bool {
    let t = line.trim();
    t.len() >= len && t.chars().all(|c| c == marker)
}

/// The words of one block, or `None` when it is not a card.
fn card_words(body: &[&str]) -> Option<String> {
    let first = body.iter().find(|l| !l.trim().is_empty())?;
    patch_of(first)?;
    let mut spec = Map::new();
    spec.insert("root".into(), Value::String(String::new()));
    spec.insert("elements".into(), Value::Object(Map::new()));
    spec.insert("state".into(), Value::Object(Map::new()));
    let mut spec = Value::Object(spec);
    for line in body {
        if let Some(patch) = patch_of(line) {
            apply(&mut spec, &patch);
        }
    }
    let mut walk = Walk {
        spec: &spec,
        lines: Vec::new(),
        seen: 0,
        on_path: HashSet::new(),
    };
    if let Some(root) = spec
        .get("root")
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty())
    {
        walk.element(root, None, 0);
    }
    let lines: Vec<String> = walk
        .lines
        .into_iter()
        .filter(|l| !l.trim().is_empty())
        .collect();
    Some(if lines.is_empty() {
        "[card]".to_string()
    } else {
        format!("[card]\n{}\n[/card]", lines.join("\n"))
    })
}

/// A line that is one JSON patch.
fn patch_of(line: &str) -> Option<Map<String, Value>> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let obj = v.as_object()?;
    (obj.get("op").and_then(Value::as_str).is_some()
        && obj.get("path").and_then(Value::as_str).is_some())
    .then(|| obj.clone())
}

fn pointer_segments(path: &str) -> Option<Vec<String>> {
    let rest = path.strip_prefix('/')?;
    Some(
        rest.split('/')
            .map(|s| s.replace("~1", "/").replace("~0", "~"))
            .collect(),
    )
}

/// Apply `add`, `replace` and `remove`; anything else is skipped, as a
/// renderer would.
fn apply(doc: &mut Value, patch: &Map<String, Value>) {
    let op = patch.get("op").and_then(Value::as_str).unwrap_or("");
    let Some(segments) = patch
        .get("path")
        .and_then(Value::as_str)
        .and_then(pointer_segments)
    else {
        return;
    };
    if segments.len() > MAX_PATH_SEGMENTS || segments.iter().any(|s| s == "__proto__") {
        return;
    }
    match op {
        "add" | "replace" => {
            let value = patch.get("value").cloned().unwrap_or(Value::Null);
            set(doc, &segments, value);
        }
        "remove" => remove(doc, &segments),
        _ => {}
    }
}

fn set(doc: &mut Value, segments: &[String], value: Value) {
    let Some((last, parents)) = segments.split_last() else {
        *doc = value;
        return;
    };
    let mut at = doc;
    for (i, seg) in parents.iter().enumerate() {
        let next_is_index = segments[i + 1] == "-" || segments[i + 1].parse::<usize>().is_ok();
        at = match at {
            Value::Object(map) => map.entry(seg.clone()).or_insert_with(|| {
                if next_is_index {
                    Value::Array(Vec::new())
                } else {
                    Value::Object(Map::new())
                }
            }),
            Value::Array(items) => match seg.parse::<usize>() {
                Ok(n) if n < items.len() => &mut items[n],
                _ => return,
            },
            _ => return,
        };
    }
    match at {
        Value::Object(map) => {
            map.insert(last.clone(), value);
        }
        Value::Array(items) => {
            if last == "-" {
                items.push(value);
            } else if let Ok(n) = last.parse::<usize>() {
                if n < items.len() {
                    items[n] = value;
                } else if n == items.len() {
                    items.push(value);
                }
            }
        }
        _ => {}
    }
}

fn remove(doc: &mut Value, segments: &[String]) {
    let Some((last, parents)) = segments.split_last() else {
        return;
    };
    let mut at = doc;
    for seg in parents {
        at = match at {
            Value::Object(map) => match map.get_mut(seg) {
                Some(v) => v,
                None => return,
            },
            Value::Array(items) => match seg.parse::<usize>().ok().and_then(|n| items.get_mut(n)) {
                Some(v) => v,
                None => return,
            },
            _ => return,
        };
    }
    match at {
        Value::Object(map) => {
            map.remove(last);
        }
        Value::Array(items) => {
            if let Ok(n) = last.parse::<usize>() {
                if n < items.len() {
                    items.remove(n);
                }
            }
        }
        _ => {}
    }
}

/// The repeat item an element is drawn for.
#[derive(Clone, Copy)]
struct Scope<'a> {
    item: &'a Value,
    index: usize,
}

struct Walk<'a> {
    spec: &'a Value,
    lines: Vec<String>,
    seen: usize,
    on_path: HashSet<String>,
}

impl<'a> Walk<'a> {
    fn state(&self, pointer: &str) -> Option<&'a Value> {
        let state = self.spec.get("state")?;
        if pointer.is_empty() || pointer == "/" {
            return Some(state);
        }
        state.pointer(pointer)
    }

    /// A prop's value, its `$state` / `$bindState` / `$item` / `$template`
    /// / `$cond` resolved as far as words need.
    fn resolve(&self, v: &'a Value, scope: Option<Scope<'a>>) -> Option<Cow<'a, Value>> {
        let Some(obj) = v.as_object() else {
            return Some(Cow::Borrowed(v));
        };
        for key in ["$state", "$bindState"] {
            if let Some(p) = obj.get(key).and_then(Value::as_str) {
                return self.state(p).map(Cow::Borrowed);
            }
        }
        for key in ["$item", "$bindItem"] {
            if let Some(field) = obj.get(key).and_then(Value::as_str) {
                let item = scope?.item;
                return if field.is_empty() {
                    Some(Cow::Borrowed(item))
                } else {
                    item.pointer(&format!("/{}", field.replace('.', "/")))
                        .map(Cow::Borrowed)
                };
            }
        }
        if obj.contains_key("$index") {
            return scope.map(|s| Cow::Owned(Value::from(s.index)));
        }
        if let Some(t) = obj.get("$template").and_then(Value::as_str) {
            return Some(Cow::Owned(Value::String(self.template(t, scope))));
        }
        if obj.contains_key("$cond") {
            // Which branch shows depends on state the owner may change:
            // the first is as good a reading as any.
            return obj.get("$then").and_then(|t| self.resolve(t, scope));
        }
        Some(Cow::Borrowed(v))
    }

    fn template(&self, t: &str, scope: Option<Scope<'a>>) -> String {
        let mut out = String::new();
        let mut rest = t;
        while let Some(start) = rest.find("${") {
            out.push_str(&rest[..start]);
            let after = &rest[start + 2..];
            let Some(end) = after.find('}') else {
                out.push_str(&rest[start..]);
                return out;
            };
            let name = &after[..end];
            let value = if name.starts_with('/') {
                self.state(name)
            } else {
                scope
                    .and_then(|s| s.item.get(name))
                    .or_else(|| self.state(&format!("/{name}")))
            };
            out.push_str(&value.map(scalar).unwrap_or_default());
            rest = &after[end + 1..];
        }
        out.push_str(rest);
        out
    }

    fn text(&self, props: &'a Value, key: &str, scope: Option<Scope<'a>>) -> Option<String> {
        let v = self.resolve(props.get(key)?, scope)?;
        let s = scalar(&v);
        let s = s.trim();
        (!s.is_empty()).then(|| s.to_string())
    }

    fn element(&mut self, key: &str, scope: Option<Scope<'a>>, depth: usize) {
        if depth > MAX_DEPTH || self.seen >= MAX_ELEMENTS || self.on_path.contains(key) {
            return;
        }
        let Some(el) = self.spec.get("elements").and_then(|e| e.get(key)) else {
            return;
        };
        self.seen += 1;
        self.on_path.insert(key.to_string());
        if let Some(repeat) = el.get("repeat") {
            self.own_words(el, scope);
            if let Some(items) = self.repeat_items(repeat, scope) {
                for (index, item) in items.iter().take(MAX_REPEAT).enumerate() {
                    self.children(el, Some(Scope { item, index }), depth);
                }
            }
        } else {
            self.own_words(el, scope);
            self.children(el, scope, depth);
        }
        self.on_path.remove(key);
    }

    /// The list a `repeat` draws its children for: a state path, or (in
    /// another repeat) a field of the enclosing item.
    fn repeat_items(&self, repeat: &'a Value, scope: Option<Scope<'a>>) -> Option<&'a Vec<Value>> {
        match repeat.get("statePath")? {
            Value::String(path) => self.state(path)?.as_array(),
            Value::Object(o) => {
                let field = o.get("$item")?.as_str()?;
                let item = scope?.item;
                let list = if field.is_empty() {
                    item
                } else {
                    item.pointer(&format!("/{}", field.replace('.', "/")))?
                };
                list.as_array()
            }
            _ => None,
        }
    }

    fn children(&mut self, el: &'a Value, scope: Option<Scope<'a>>, depth: usize) {
        let mut keys: Vec<&str> = el
            .get("children")
            .and_then(Value::as_array)
            .map(|c| c.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if let Some(slots) = el.get("slots").and_then(Value::as_object) {
            for slot in slots.values().filter_map(Value::as_array) {
                keys.extend(slot.iter().filter_map(Value::as_str));
            }
        }
        for child in keys {
            self.element(child, scope, depth + 1);
        }
    }

    fn own_words(&mut self, el: &'a Value, scope: Option<Scope<'a>>) {
        let kind = el.get("type").and_then(Value::as_str).unwrap_or("");
        let Some(props) = el.get("props") else {
            return;
        };
        let t = |k: &str| self.text(props, k, scope);
        let line = match kind {
            "Card" | "Collapsible" | "Dialog" | "Drawer" => join_dash(t("title"), t("description")),
            "Heading" | "Text" => t("text"),
            "Badge" => t("text").map(|s| format!("[{s}]")),
            "Alert" => match (t("title"), t("message")) {
                (Some(a), Some(b)) => Some(format!("{a}: {b}")),
                (a, b) => a.or(b),
            },
            "Button" => t("label").map(|s| format!("[button] {s}")),
            "Link" => match (t("label"), t("href")) {
                (Some(l), Some(h)) if h != "#" => Some(format!("{l} ({h})")),
                (l, _) => l,
            },
            "Progress" => {
                let value = t("value").unwrap_or_default();
                Some(match t("label") {
                    Some(l) => format!("{l}: {value}%"),
                    None => format!("{value}%"),
                })
            }
            "Table" => {
                self.table(props, scope);
                None
            }
            "Accordion" | "Carousel" => {
                self.pairs(props, scope, &["title"], &["content", "description"]);
                None
            }
            "Tabs" | "ToggleGroup" | "ButtonGroup" | "DropdownMenu" => {
                let list = self.labels(
                    props,
                    scope,
                    if kind == "Tabs" {
                        "tabs"
                    } else if kind == "ButtonGroup" {
                        "buttons"
                    } else {
                        "items"
                    },
                );
                match (t("label"), list) {
                    (Some(l), Some(list)) => Some(format!("{l}: {list}")),
                    (l, list) => list.or(l),
                }
            }
            "Input" | "Textarea" | "Checkbox" | "Switch" | "Slider" => {
                t("label").map(|l| format!("[field] {l}"))
            }
            "Select" | "Radio" => {
                let options = self.labels(props, scope, "options");
                t("label").map(|l| match options {
                    Some(o) => format!("[field] {l} ({o})"),
                    None => format!("[field] {l}"),
                })
            }
            "Toggle" => t("label").map(|l| format!("[toggle] {l}")),
            "Tooltip" => join_dash(t("text"), t("content")),
            "Popover" => join_dash(t("trigger"), t("content")),
            "Avatar" => t("name"),
            "Image" => t("alt").map(|a| format!("[image] {a}")),
            "Spinner" => t("label"),
            "AreaChart" | "BarChart" | "LineChart" | "PieChart" | "RadarChart" | "RadialChart"
            | "ScatterChart" => {
                self.chart(props, scope);
                None
            }
            "Stack" | "Grid" | "Separator" | "Skeleton" | "Pagination" => None,
            // A component this reading does not know: whatever words it has.
            _ => {
                let words: Vec<String> = [
                    "title",
                    "text",
                    "label",
                    "description",
                    "content",
                    "message",
                ]
                .iter()
                .filter_map(|k| t(k))
                .collect();
                (!words.is_empty()).then(|| words.join(" — "))
            }
        };
        if let Some(line) = line {
            self.lines.push(line);
        }
    }

    fn list(&self, props: &'a Value, key: &str, scope: Option<Scope<'a>>) -> Vec<Value> {
        match props.get(key).and_then(|v| self.resolve(v, scope)) {
            Some(v) => v.as_array().cloned().unwrap_or_default(),
            None => Vec::new(),
        }
    }

    fn labels(&self, props: &'a Value, scope: Option<Scope<'a>>, key: &str) -> Option<String> {
        let items = self.list(props, key, scope);
        let words: Vec<String> = items
            .iter()
            .map(|i| match i {
                Value::Object(o) => o.get("label").map(scalar).unwrap_or_default(),
                other => scalar(other),
            })
            .filter(|s| !s.trim().is_empty())
            .collect();
        (!words.is_empty()).then(|| words.join(" / "))
    }

    fn pairs(
        &mut self,
        props: &'a Value,
        scope: Option<Scope<'a>>,
        heads: &[&str],
        bodies: &[&str],
    ) {
        let items = self.list(props, "items", scope);
        for item in items.iter().take(MAX_ROWS) {
            let pick = |keys: &[&str]| {
                keys.iter()
                    .find_map(|k| item.get(*k).map(scalar).filter(|s| !s.trim().is_empty()))
            };
            if let Some(line) = join_dash(pick(heads), pick(bodies)) {
                self.lines.push(line);
            }
        }
    }

    fn table(&mut self, props: &'a Value, scope: Option<Scope<'a>>) {
        if let Some(caption) = self.text(props, "caption", scope) {
            self.lines.push(caption);
        }
        let columns: Vec<String> = self
            .list(props, "columns", scope)
            .iter()
            .map(scalar)
            .collect();
        if !columns.is_empty() {
            self.lines.push(format!("| {} |", columns.join(" | ")));
        }
        let rows = self.list(props, "rows", scope);
        for row in rows.iter().take(MAX_ROWS) {
            let cells: Vec<String> = match row {
                Value::Array(cells) => cells.iter().map(scalar).collect(),
                other => vec![scalar(other)],
            };
            self.lines.push(format!("| {} |", cells.join(" | ")));
        }
        if rows.len() > MAX_ROWS {
            self.lines
                .push(format!("(+{} more rows)", rows.len() - MAX_ROWS));
        }
    }

    fn chart(&mut self, props: &'a Value, scope: Option<Scope<'a>>) {
        let data = self.list(props, "data", scope);
        let x = self
            .text(props, "xKey", scope)
            .or_else(|| self.text(props, "nameKey", scope));
        let mut keys: Vec<String> = self
            .list(props, "series", scope)
            .iter()
            .filter_map(|s| s.get("key").map(scalar))
            .collect();
        for k in ["valueKey", "yKey"] {
            if let Some(v) = self.text(props, k, scope) {
                keys.push(v);
            }
        }
        self.lines.push("[chart]".to_string());
        for point in data.iter().take(MAX_ROWS) {
            let label = x
                .as_deref()
                .and_then(|x| point.get(x))
                .map(scalar)
                .unwrap_or_default();
            let values: Vec<String> = keys
                .iter()
                .filter_map(|k| point.get(k).map(|v| format!("{k} {}", scalar(v))))
                .collect();
            self.lines.push(format!("{label}: {}", values.join(", ")));
        }
    }
}

fn join_dash(a: Option<String>, b: Option<String>) -> Option<String> {
    match (a, b) {
        (Some(a), Some(b)) => Some(format!("{a} — {b}")),
        (a, b) => a.or(b),
    }
}

/// A value as one line of words.
fn scalar(v: &Value) -> String {
    match v {
        Value::String(s) => s.split_whitespace().collect::<Vec<_>>().join(" "),
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fence(lines: &[&str]) -> String {
        format!("```spec\n{}\n```", lines.join("\n"))
    }

    #[test]
    fn a_card_reads_as_its_title_texts_rows_and_buttons() {
        let card = fence(&[
            r#"{"op":"add","path":"/root","value":"main"}"#,
            r#"{"op":"add","path":"/elements/main","value":{"type":"Card","props":{"title":"Two ways","description":"pick one"},"children":["t","tab","row"]}}"#,
            r#"{"op":"add","path":"/elements/t","value":{"type":"Text","props":{"text":"Both pass the tests."},"children":[]}}"#,
            r#"{"op":"add","path":"/elements/tab","value":{"type":"Table","props":{"columns":["Plan","Lines"],"rows":[["A","+40"],["B","+120"]]},"children":[]}}"#,
            r#"{"op":"add","path":"/elements/row","value":{"type":"Stack","props":{"direction":"horizontal"},"children":["a","b"]}}"#,
            r#"{"op":"add","path":"/elements/a","value":{"type":"Button","props":{"label":"Go with plan A"},"on":{"press":{"action":"pa.reply"}},"children":[]}}"#,
            r#"{"op":"add","path":"/elements/b","value":{"type":"Button","props":{"label":"Go with plan B"},"children":[]}}"#,
        ]);
        let text = format!("Here are the two.\n\n{card}");
        assert_eq!(
            cards_as_text(&text),
            "Here are the two.\n\n[card]\nTwo ways — pick one\nBoth pass the tests.\n| Plan | Lines |\n| A | +40 |\n| B | +120 |\n[button] Go with plan A\n[button] Go with plan B\n[/card]"
        );
    }

    #[test]
    fn state_items_and_templates_are_read() {
        let card = fence(&[
            r#"{"op":"add","path":"/root","value":"list"}"#,
            r#"{"op":"add","path":"/elements/list","value":{"type":"Stack","props":{},"repeat":{"statePath":"/todos"},"children":["row"]}}"#,
            r##"{"op":"add","path":"/elements/row","value":{"type":"Text","props":{"text":{"$template":"#${id} ${title}"}},"children":[]}}"##,
            r#"{"op":"add","path":"/state/todos","value":[]}"#,
            r#"{"op":"add","path":"/state/todos/0","value":{"id":"7","title":"Fix CI"}}"#,
            r#"{"op":"add","path":"/state/todos/-","value":{"id":"9","title":"Review"}}"#,
        ]);
        assert_eq!(
            cards_as_text(&card),
            "[card]\n#7 Fix CI\n#9 Review\n[/card]"
        );
    }

    #[test]
    fn what_is_not_a_card_stays_as_it_is() {
        let rpm = "```spec\nName: codeg\nVersion: 1\n```";
        assert_eq!(cards_as_text(rpm), rpm);
        let plain = "No cards here, just a spec sheet.";
        assert!(matches!(cards_as_text(plain), Cow::Borrowed(_)));
        let code = "```rust\nfn main() {}\n```";
        assert_eq!(cards_as_text(code), code);
    }

    #[test]
    fn a_cut_off_card_and_a_cycle_still_read() {
        // A reply cut short: no closing fence, a half line.
        let cut = "Status:\n```spec\n{\"op\":\"add\",\"path\":\"/root\",\"value\":\"m\"}\n{\"op\":\"add\",\"path\":\"/elements/m\",\"value\":{\"type\":\"Heading\",\"props\":{\"text\":\"Done\"},\"children\":[\"m\"]}}\n{\"op\":\"add\",\"pa";
        assert_eq!(cards_as_text(cut), "Status:\n[card]\nDone\n[/card]");
    }

    #[test]
    fn a_path_nested_past_any_card_is_skipped() {
        // Built, it would nest 5000 deep and overflow the stack when dropped.
        let deep = format!("/state{}", "/x".repeat(5_000));
        let text = format!(
            "```spec\n{}\n{}\n{}\n```",
            r#"{"op":"add","path":"/root","value":"m"}"#,
            r#"{"op":"add","path":"/elements/m","value":{"type":"Text","props":{"text":"ok"},"children":[]}}"#,
            serde_json::json!({ "op": "add", "path": deep, "value": 1 })
        );
        let out = std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(move || cards_as_text(&text).into_owned())
            .unwrap()
            .join()
            .expect("no overflow");
        assert_eq!(out, "[card]\nok\n[/card]");
    }

    #[test]
    fn text_after_a_card_and_a_second_card_are_kept_in_order() {
        let one = fence(&[
            r#"{"op":"add","path":"/root","value":"h"}"#,
            r#"{"op":"add","path":"/elements/h","value":{"type":"Badge","props":{"text":"red"},"children":[]}}"#,
        ]);
        let text = format!("a\n{one}\nb\n{one}");
        assert_eq!(
            cards_as_text(&text),
            "a\n[card]\n[red]\n[/card]\nb\n[card]\n[red]\n[/card]"
        );
    }
}
