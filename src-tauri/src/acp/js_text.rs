//! JavaScript's string semantics, for the places codeg ports one of
//! codex-acp's helpers and has to read text exactly the way the adapter does
//! (`acp::service_error`, `parsers::codex_desktop_attachments`).

/// JavaScript's `\s`, which is also what `String.prototype.trim` strips: its
/// WhiteSpace and LineTerminator characters. Not `char::is_whitespace`, which
/// adds U+0085 and leaves out U+FEFF.
pub(crate) fn is_js_whitespace(c: char) -> bool {
    // U+2000..=U+200A are the typographic spaces (en quad through hair space).
    matches!(c, '\u{2000}'..='\u{200A}')
        || matches!(
            c,
            '\t' | '\n'
                | '\u{0B}'
                | '\u{0C}'
                | '\r'
                | ' '
                | '\u{A0}'
                | '\u{1680}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
        )
}

/// JavaScript's `s.trim().length === 0`.
pub(crate) fn is_js_blank(s: &str) -> bool {
    s.chars().all(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn differs_from_rust_whitespace_exactly_where_javascript_does() {
        assert!(!is_js_whitespace('\u{85}') && '\u{85}'.is_whitespace());
        assert!(is_js_whitespace('\u{FEFF}') && !'\u{FEFF}'.is_whitespace());
        for c in (0..=0x10FFFF_u32).filter_map(char::from_u32) {
            if c != '\u{85}' && c != '\u{FEFF}' {
                assert_eq!(is_js_whitespace(c), c.is_whitespace(), "{:#X}", c as u32);
            }
        }
    }

    #[test]
    fn blank_is_javascript_trim_to_nothing() {
        assert!(is_js_blank(""));
        assert!(is_js_blank(" \t\u{3000}\u{FEFF}\u{2028}"));
        assert!(!is_js_blank("\u{85}"));
        assert!(!is_js_blank(" x "));
    }
}
