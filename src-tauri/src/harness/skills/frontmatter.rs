//! The two changes Codeg makes to a skill's `SKILL.md` (plan §7.3 step 5):
//! `allowed-tools` taken out unless the user keeps it — it lets the skill
//! use tools without asking (SEP-2640 asks the same of skills sent over
//! MCP) — and `name` set to the install name when the two differ.
//!
//! The frontmatter is edited line by line, so everything else in it stays
//! exactly as the author wrote it (comments, quoting, order, values that are
//! not strict YAML, which agents read as text). The result is checked before
//! it is used: read again, it must have the same top-level keys but for the
//! changes, `name` must be the install name, and — when the original is
//! valid YAML — the new frontmatter must be too, and mean the original with
//! exactly those changes. Anything that cannot be checked so is refused
//! (`skill_md_invalid`) rather than installed half-changed.

use super::model::{AllowedTools, NameRewrite, Rewrites};

/// `SKILL.md` as installed, and what was changed in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Rewritten {
    pub bytes: Vec<u8>,
    pub rewrites: Rewrites,
}

const ALLOWED_TOOLS_KEY: &str = "allowed-tools";
const NAME_KEY: &str = "name";

struct Document<'a> {
    bom: bool,
    /// The opening `---` line, with its line end.
    open: &'a str,
    /// The frontmatter's lines, each with its line end.
    yaml: Vec<&'a str>,
    /// The closing `---` line and everything after it.
    rest: &'a str,
}

fn without_eol(line: &str) -> &str {
    line.trim_end_matches(['\n', '\r'])
}

fn split(text: &str) -> Option<Document<'_>> {
    let (bom, text) = match text.strip_prefix('\u{feff}') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let first = lines.first()?;
    if without_eol(first) != "---" || !first.ends_with('\n') {
        return None;
    }
    let close = lines.iter().enumerate().skip(1).find_map(|(i, line)| {
        let bare = without_eol(line);
        (bare.starts_with("---") && bare[3..].chars().all(|c| c == ' ' || c == '\t')).then_some(i)
    })?;
    let offset: usize = lines[..close].iter().map(|line| line.len()).sum();
    Some(Document {
        bom,
        open: first,
        yaml: lines[1..close].to_vec(),
        rest: &text[offset..],
    })
}

/// The top-level key a frontmatter line starts, if it starts one.
fn key_of(line: &str) -> Option<String> {
    let bare = without_eol(line);
    let quoted = |quote: char| -> Option<String> {
        let rest = bare.strip_prefix(quote)?;
        let end = rest.find(quote)?;
        let after = rest[end + 1..].trim_start_matches([' ', '\t']);
        let after = after.strip_prefix(':')?;
        (after.is_empty() || after.starts_with([' ', '\t'])).then(|| rest[..end].to_string())
    };
    if let Some(key) = quoted('"').or_else(|| quoted('\'')) {
        return Some(key);
    }
    let first = bare.chars().next()?;
    if !(first.is_ascii_alphanumeric() || first == '_') {
        return None;
    }
    let end = bare
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')))
        .unwrap_or(bare.len());
    let key = &bare[..end];
    let after = bare[end..].trim_start_matches([' ', '\t']);
    let after = after.strip_prefix(':')?;
    (after.is_empty() || after.starts_with([' ', '\t'])).then(|| key.to_string())
}

/// A line that carries on the entry above it: blank, indented, or a block
/// sequence's item at the left edge.
fn continues(line: &str) -> bool {
    let bare = without_eol(line);
    bare.trim().is_empty() || bare.starts_with([' ', '\t']) || bare.starts_with('-')
}

/// The top-level entries: (key, first line, one past the last line).
fn entries(yaml: &[&str]) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < yaml.len() {
        let Some(key) = key_of(yaml[i]) else {
            i += 1;
            continue;
        };
        let start = i;
        let mut end = i + 1;
        while end < yaml.len() && key_of(yaml[end]).is_none() && continues(yaml[end]) {
            end += 1;
        }
        // Blank lines at its end separate it from what follows.
        while end > start + 1 && without_eol(yaml[end - 1]).trim().is_empty() {
            end -= 1;
        }
        out.push((key, start, end));
        i = end;
    }
    out
}

/// The value of a one-line `key: value`, as text: quotes taken off, a
/// trailing comment left out. `None` for anything else (a block scalar, a
/// multi-line value, an escape sequence).
fn one_line_value(lines: &[&str]) -> Option<String> {
    if lines.len() != 1 {
        return None;
    }
    let bare = without_eol(lines[0]);
    let (_, value) = bare.split_once(':')?;
    let value = value.trim();
    if let Some(inner) = value.strip_prefix('"') {
        let end = inner.find('"')?;
        let text = &inner[..end];
        return (!text.contains('\\')).then(|| text.to_string());
    }
    if let Some(inner) = value.strip_prefix('\'') {
        return Some(inner.split_once('\'')?.0.to_string());
    }
    let value = match value.find(" #").or_else(|| value.find("\t#")) {
        Some(at) => value[..at].trim_end(),
        None => value,
    };
    if value.is_empty() || value.starts_with(['|', '>', '[', '{', '&', '*', '!']) {
        return None;
    }
    Some(value.to_string())
}

/// The install name as a YAML scalar that every reader takes as that text:
/// quoted when it could read as a number, a date, a boolean or null.
fn name_scalar(name: &str) -> String {
    const WORDS: [&str; 12] = [
        "true", "false", "null", "yes", "no", "on", "off", "y", "n", "~", "nan", "inf",
    ];
    if name.starts_with(|c: char| c.is_ascii_digit()) || WORDS.contains(&name) {
        format!("\"{name}\"")
    } else {
        name.to_string()
    }
}

fn eol_of(line: &str) -> &'static str {
    if line.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// `SKILL.md` with `allowed-tools` dropped (unless `keep_allowed_tools`)
/// and `name` set to `install_name`; `Err` says why it cannot be.
pub(crate) fn rewrite(
    original: &[u8],
    install_name: &str,
    keep_allowed_tools: bool,
) -> Result<Rewritten, String> {
    let text = std::str::from_utf8(original).map_err(|_| "SKILL.md is not UTF-8".to_string())?;
    let document = split(text).ok_or_else(|| "SKILL.md has no frontmatter".to_string())?;
    let found = entries(&document.yaml);
    let eol = eol_of(document.open);

    let mut rewrites = Rewrites::default();
    let declares_tools = found.iter().any(|(key, _, _)| key == ALLOWED_TOOLS_KEY);
    if declares_tools {
        rewrites.allowed_tools = Some(if keep_allowed_tools {
            AllowedTools::Kept
        } else {
            AllowedTools::Removed
        });
    }
    let names: Vec<&(String, usize, usize)> =
        found.iter().filter(|(key, _, _)| key == NAME_KEY).collect();
    if names.len() > 1 {
        return Err("SKILL.md's frontmatter has `name` twice".to_string());
    }
    let current_name = names
        .first()
        .and_then(|(_, start, end)| one_line_value(&document.yaml[*start..*end]));
    let rename = current_name.as_deref() != Some(install_name);
    if rename {
        rewrites.name = Some(NameRewrite {
            from: current_name.clone(),
            to: install_name.to_string(),
        });
    }

    let name_line = format!("{NAME_KEY}: {}{eol}", name_scalar(install_name));
    let mut yaml: Vec<String> = Vec::with_capacity(document.yaml.len() + 1);
    if rename && names.is_empty() {
        yaml.push(name_line.clone());
    }
    let mut i = 0;
    while i < document.yaml.len() {
        match found.iter().find(|(_, start, _)| *start == i) {
            Some((key, start, end)) if key == ALLOWED_TOOLS_KEY && !keep_allowed_tools => {
                i = (*end).max(start + 1);
            }
            Some((key, _, end)) if key == NAME_KEY && rename => {
                yaml.push(name_line.clone());
                i = *end;
            }
            _ => {
                yaml.push(document.yaml[i].to_string());
                i += 1;
            }
        }
    }

    let mut out = String::with_capacity(text.len() + name_line.len());
    if document.bom {
        out.push('\u{feff}');
    }
    out.push_str(document.open);
    for line in &yaml {
        out.push_str(line);
    }
    out.push_str(document.rest);

    check(&document, &out, install_name, keep_allowed_tools)?;
    Ok(Rewritten {
        bytes: out.into_bytes(),
        rewrites,
    })
}

/// Read the result again: see the module docs.
fn check(
    original: &Document<'_>,
    result: &str,
    install_name: &str,
    keep_allowed_tools: bool,
) -> Result<(), String> {
    let unsure = |what: &str| format!("the rewritten frontmatter could not be checked: {what}");
    let document = split(result).ok_or_else(|| unsure("no frontmatter"))?;
    let before: Vec<String> = entries(&original.yaml)
        .into_iter()
        .map(|(key, _, _)| key)
        .filter(|key| keep_allowed_tools || key != ALLOWED_TOOLS_KEY)
        .collect();
    let after_entries = entries(&document.yaml);
    let after: Vec<String> = after_entries
        .iter()
        .map(|(key, _, _)| key.clone())
        .collect();
    let mut expected = before.clone();
    if !expected.iter().any(|key| key == NAME_KEY) {
        expected.insert(0, NAME_KEY.to_string());
    }
    if after != expected {
        return Err(unsure("its keys are not the original's"));
    }
    let name = after_entries
        .iter()
        .find(|(key, _, _)| key == NAME_KEY)
        .and_then(|(_, start, end)| one_line_value(&document.yaml[*start..*end]));
    if name.as_deref() != Some(install_name) {
        return Err(unsure("`name` is not the install name"));
    }
    if original.rest != document.rest {
        return Err(unsure("the body changed"));
    }
    // Where the original is YAML, the result must mean it with the changes.
    let parse = |yaml: &[&str]| serde_yaml::from_str::<serde_yaml::Value>(&yaml.concat());
    if let Ok(serde_yaml::Value::Mapping(mut want)) = parse(&original.yaml) {
        if !keep_allowed_tools {
            want.remove(ALLOWED_TOOLS_KEY);
        }
        want.insert(
            serde_yaml::Value::String(NAME_KEY.to_string()),
            serde_yaml::Value::String(install_name.to_string()),
        );
        match parse(&document.yaml) {
            Ok(serde_yaml::Value::Mapping(got)) if got == want => {}
            _ => return Err(unsure("it does not read as the original with the changes")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str, name: &str, keep: bool) -> (String, Rewrites) {
        let done = rewrite(text.as_bytes(), name, keep).unwrap();
        (String::from_utf8(done.bytes).unwrap(), done.rewrites)
    }

    #[test]
    fn allowed_tools_go_unless_kept_and_the_rest_stays_as_written() {
        let text = "---\nname: pdf\n# a comment\ndescription: >\n  Fill PDF forms.\nallowed-tools:\n  - Bash\n  - Read\nlicense: MIT\n---\nBody\n";
        let (out, rewrites) = run(text, "pdf", false);
        assert_eq!(
            out,
            "---\nname: pdf\n# a comment\ndescription: >\n  Fill PDF forms.\nlicense: MIT\n---\nBody\n"
        );
        assert_eq!(rewrites.allowed_tools, Some(AllowedTools::Removed));
        assert_eq!(rewrites.name, None);

        let (kept, rewrites) = run(text, "pdf", true);
        assert_eq!(kept, text);
        assert_eq!(rewrites.allowed_tools, Some(AllowedTools::Kept));

        // a sequence at the left edge, and a one-line list
        let edge = "---\nallowed-tools:\n- Bash\n- Read\nname: pdf\n---\n";
        assert_eq!(run(edge, "pdf", false).0, "---\nname: pdf\n---\n");
        let inline = "---\nname: pdf\nallowed-tools: Bash(git *) Read\ndescription: x\n---\n";
        assert_eq!(
            run(inline, "pdf", false).0,
            "---\nname: pdf\ndescription: x\n---\n"
        );
        // nested under another key: not the skill's own field
        let nested = "---\nname: pdf\nmetadata:\n  allowed-tools: x\n---\n";
        let (out, rewrites) = run(nested, "pdf", false);
        assert_eq!(out, nested);
        assert_eq!(rewrites, Rewrites::default());
    }

    #[test]
    fn the_name_becomes_the_install_name() {
        let text = "---\r\nname: \"pdf\" # the skill\r\ndescription: x\r\n---\r\nBody\r\n";
        let (out, rewrites) = run(text, "pdf-anthropics", false);
        assert_eq!(
            out,
            "---\r\nname: pdf-anthropics\r\ndescription: x\r\n---\r\nBody\r\n"
        );
        assert_eq!(
            rewrites.name,
            Some(NameRewrite {
                from: Some("pdf".into()),
                to: "pdf-anthropics".into()
            })
        );
        // no name at all: one is added
        let (out, rewrites) = run("---\ndescription: x\n---\n", "pdf", false);
        assert_eq!(out, "---\nname: pdf\ndescription: x\n---\n");
        assert_eq!(rewrites.name.unwrap().from, None);
        // a name that would read as a number or a date is quoted
        let (out, _) = run("---\nname: x\n---\n", "2026-11-17", false);
        assert_eq!(out, "---\nname: \"2026-11-17\"\n---\n");
        // a value that is not strict YAML elsewhere is left as it is
        let loose = "---\nname: pdf\nargument-hint: [pr-number] [priority]\n---\n";
        let (out, _) = run(loose, "pdf-2", false);
        assert_eq!(
            out,
            "---\nname: pdf-2\nargument-hint: [pr-number] [priority]\n---\n"
        );
    }

    #[test]
    fn what_cannot_be_rewritten_safely_is_refused() {
        assert!(rewrite(b"no frontmatter", "pdf", false).is_err());
        assert!(rewrite(&[0xff, 0xfe], "pdf", false).is_err());
        assert!(rewrite(b"---\nname: a\nname: b\n---\n", "pdf", false).is_err());
        // unterminated
        assert!(rewrite(b"---\nname: a\n", "pdf", false).is_err());
    }
}
