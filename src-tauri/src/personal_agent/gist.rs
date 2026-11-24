//! The gist of a result: its first plain sentence, for a line that says
//! what came of a piece of work ("today"'s done list, a result card's
//! point). A result is Markdown an executor wrote — a heading, a table or a
//! code block says nothing on a line of its own, so they are skipped, and
//! the rest is read as plain words: no list marks, no emphasis, a link's
//! text only.

use std::sync::LazyLock;

use regex::Regex;

/// The longest gist.
pub const GIST_MAX: usize = 200;

/// `![alt](url)` and `[text](url)`: their words.
static LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!?\[([^\]]*)\]\([^)]*\)").expect("a valid pattern"));
/// `<https://…>`: the address.
static AUTOLINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<((?:https?|mailto):[^>\s]+)>").expect("a valid pattern"));
/// A list item's or a task's mark, a quote's `>`.
static MARK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:>\s*)*(?:(?:[-*+]|\d{1,3}[.)])\s+)?(?:\[[ xX]\]\s+)?")
        .expect("a valid pattern")
});
/// A table's divider row (`|---|:--:|`), or a rule (`---`, `***`).
static DIVIDER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$|^(?:[-*_]\s*){3,}$")
        .expect("a valid pattern")
});

/// A list item's mark, after any quote marks.
static LIST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:>\s*)*(?:[-*+]|\d{1,3}[.)])\s+").expect("a valid pattern"));

/// What a line of Markdown is, as far as a gist cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Line {
    Blank,
    /// Says nothing on its own: a rule, a table's row, an HTML line.
    Mute,
    /// Opens a fenced block (code, a spec) closed by the same fence.
    Fence(&'static str),
    /// Opens a card a long result's excerpt was flattened to
    /// (`spec_text::cards_as_text`), closed by `[/card]`.
    Card,
    Heading,
    /// Starts a list item: a paragraph of its own.
    Item,
    Text,
}

fn line_of(line: &str, next: Option<&str>) -> Line {
    if line.is_empty() {
        return Line::Blank;
    }
    if let Some(open) = ["```", "~~~"].into_iter().find(|f| line.starts_with(f)) {
        return Line::Fence(open);
    }
    if line == "[card]" {
        return Line::Card;
    }
    if heading_text(line).is_some() {
        return Line::Heading;
    }
    let table_head =
        line.contains('|') && next.is_some_and(|n| n.contains('|') && DIVIDER.is_match(n.trim()));
    if DIVIDER.is_match(line)
        || line.starts_with('|')
        || table_head
        // An HTML line (a `<details>`, a comment) says nothing either.
        || (line.starts_with('<') && !AUTOLINK.is_match(line))
    {
        return Line::Mute;
    }
    if LIST.is_match(line) {
        return Line::Item;
    }
    Line::Text
}

/// The first plain sentence of `text`, at most [`GIST_MAX`]; `None` when it
/// has no words outside headings, tables, cards and code. A sentence runs
/// on over the lines of its paragraph. With nothing but headings, the
/// first heading's words.
pub fn plain_gist(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let mut heading: Option<String> = None;
    let mut i = 0;
    // Inside a table (after its divider): to the next blank line.
    let mut table = false;
    while i < lines.len() {
        let line = lines[i];
        let kind = line_of(line, lines.get(i + 1).copied());
        i += 1;
        // A table runs on over its rows: lines with a `|` that start no
        // other block (a heading or a fence right under it is its own).
        if table {
            table = line.contains('|') && matches!(kind, Line::Mute | Line::Text | Line::Item);
            if table {
                continue;
            }
        }
        match kind {
            Line::Blank => {}
            Line::Mute => table = line.contains('|'),
            Line::Fence(open) => {
                while i < lines.len() {
                    let l = lines[i];
                    i += 1;
                    if l.starts_with(open) && l[open.len()..].trim().is_empty() {
                        break;
                    }
                }
            }
            // To its `[/card]`; a card with no words is the marker alone.
            Line::Card => {
                if let Some(end) = lines[i..].iter().position(|l| *l == "[/card]") {
                    i += end + 1;
                }
            }
            Line::Heading => {
                if heading.is_none() {
                    heading = heading_text(line).map(plain).filter(|h| !h.is_empty());
                }
            }
            Line::Item | Line::Text => {
                let mut para = MARK.replace(line, "").into_owned();
                while let Some(next) = lines.get(i).copied() {
                    if line_of(next, lines.get(i + 1).copied()) != Line::Text {
                        break;
                    }
                    join(&mut para, MARK.replace(next, "").as_ref());
                    i += 1;
                }
                let words = plain(&para);
                if !words.is_empty() {
                    return Some(cut(first_sentence(&words)));
                }
            }
        }
    }
    heading.map(|h| cut(&h))
}

/// `next` after `para`, a space between unless the two meet in CJK text
/// (written without spaces).
fn join(para: &mut String, next: &str) {
    let cjk = |c: Option<char>| {
        c.is_some_and(|c| {
            matches!(c, '\u{2E80}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}' | '\u{FF00}'..='\u{FFEF}')
        })
    };
    if !(cjk(para.chars().last()) && cjk(next.chars().next())) {
        para.push(' ');
    }
    para.push_str(next);
}

/// A heading's words: `## Title` (up to six `#`, then a space).
fn heading_text(line: &str) -> Option<&str> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &line[hashes..];
    if rest.is_empty() {
        return Some("");
    }
    rest.starts_with([' ', '\t'])
        .then(|| rest.trim().trim_end_matches('#').trim())
}

/// `text` with its inline Markdown read as words.
fn plain(text: &str) -> String {
    let text = LINK.replace_all(text, "$1");
    let text = AUTOLINK.replace_all(&text, "$1");
    let text = text.replace("**", "").replace("__", "").replace('`', "");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Up to the end of the first sentence: a CJK full stop, or `.` `!` `?`
/// before a space (not "e.g." inside a word, not "v1.2").
fn first_sentence(text: &str) -> &str {
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match c {
            '。' | '！' | '？' => return &text[..i + c.len_utf8()],
            '.' | '!' | '?' if chars.peek().is_some_and(|(_, n)| n.is_whitespace()) => {
                return &text[..i + 1];
            }
            _ => {}
        }
    }
    text
}

/// At most [`GIST_MAX`] characters, an ellipsis where it was cut.
fn cut(text: &str) -> String {
    if text.chars().count() <= GIST_MAX {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(GIST_MAX - 1).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_heading_is_skipped_for_the_first_sentence_under_it() {
        let text =
            "## 项目定位\n\nmy-app 是一个 **Next.js** 前端演示与原型项目。它用 App Router。\n";
        assert_eq!(
            plain_gist(text).as_deref(),
            Some("my-app 是一个 Next.js 前端演示与原型项目。")
        );
    }

    #[test]
    fn code_tables_and_spec_blocks_say_nothing() {
        let text = "```spec\n{\"root\":1}\n```\n| a | b |\n|---|:-:|\n| 1 | 2 |\n\n```rust\nfn main() {}\n```\nThe tests pass. Two were added.";
        assert_eq!(plain_gist(text).as_deref(), Some("The tests pass."));
    }

    #[test]
    fn list_marks_emphasis_links_and_backticks_are_read_as_words() {
        assert_eq!(
            plain_gist("- [x] Fixed `parse()` in [the parser](https://x.y/z) — see <https://a.b>")
                .as_deref(),
            Some("Fixed parse() in the parser — see https://a.b")
        );
        assert_eq!(plain_gist("1. __Done__").as_deref(), Some("Done"));
        assert_eq!(plain_gist("> quoted line").as_deref(), Some("quoted line"));
    }

    #[test]
    fn a_full_stop_inside_a_word_or_a_version_does_not_end_the_sentence() {
        assert_eq!(
            plain_gist("Bumped to v1.2.3 and e.g.x works. Next.").as_deref(),
            Some("Bumped to v1.2.3 and e.g.x works.")
        );
    }

    #[test]
    fn only_headings_give_the_first_heading_and_nothing_gives_none() {
        assert_eq!(
            plain_gist("# Report\n## Details\n").as_deref(),
            Some("Report")
        );
        assert_eq!(plain_gist("```\ncode\n```\n---\n"), None);
        assert_eq!(plain_gist(""), None);
        // `#tag` is not a heading.
        assert_eq!(plain_gist("#tag stays").as_deref(), Some("#tag stays"));
    }

    #[test]
    fn a_table_without_leading_pipes_and_a_flattened_card_say_nothing() {
        let text = "Status | Detail\n--- | ---\nok | fine\n\n[card]\nTitle\n- row\n[/card]\nShipped the fix.";
        assert_eq!(plain_gist(text).as_deref(), Some("Shipped the fix."));
        // A card with no words is its marker alone: what follows is read.
        assert_eq!(
            plain_gist("[card]\n\nShipped the fix.").as_deref(),
            Some("Shipped the fix.")
        );
        // A heading right under a table is its own block, and so what is
        // under it.
        assert_eq!(
            plain_gist("| a | b |\n|---|---|\n| 1 | 2 |\n## Outcome\nAll green.").as_deref(),
            Some("All green.")
        );
        assert_eq!(
            plain_gist("a | b\n--- | ---\n```\nx\n```\nDone.").as_deref(),
            Some("Done.")
        );
    }

    #[test]
    fn a_sentence_runs_on_over_the_lines_of_its_paragraph() {
        assert_eq!(
            plain_gist("The patch can ship\nonly after the migration runs. Then more.").as_deref(),
            Some("The patch can ship only after the migration runs.")
        );
        assert_eq!(
            plain_gist("补丁可以发布，\n但要先跑迁移。之后再说。").as_deref(),
            Some("补丁可以发布，但要先跑迁移。")
        );
        // A list item is a paragraph of its own; the next item is not it.
        assert_eq!(
            plain_gist("- First thing\n- Second thing").as_deref(),
            Some("First thing")
        );
    }

    #[test]
    fn a_long_sentence_is_cut() {
        let long = "x".repeat(GIST_MAX + 10);
        let gist = plain_gist(&long).unwrap();
        assert_eq!(gist.chars().count(), GIST_MAX);
        assert!(gist.ends_with('…'));
    }
}
