//! What the browser shows when SpaceRing sends it back to Codeg.
//!
//! One short page per outcome, in the language of Codeg's interface (English,
//! or Chinese for a Chinese interface), telling the person to go back to
//! Codeg. It is drawn as SpaceRing's authorization page draws its answer:
//! SpaceRing's ring and Codeg's own icon joined by a line, a tick on the line
//! once the answer is in, a cross when the person declined; light or dark as
//! the system is.
//!
//! A release build's page also links to `codeg://open`, which brings Codeg's
//! main window forward (`deep_link`): Codeg tries to come forward on its own
//! when the browser returns, but macOS may keep an app in the background
//! from activating itself, and the person is looking at the browser. A
//! development build's page has no link: a development build never claims
//! the scheme (`lib.rs`), so the link would open an installed release app
//! instead.
//!
//! It loads nothing and runs nothing. The listener serves it under
//! [`CONTENT_SECURITY_POLICY`]: no source for anything but its one inline
//! stylesheet, allowed by that stylesheet's hash. The marks are inline SVG,
//! which needs no source. The link is neither a load nor a script: following
//! it is a navigation the person makes, which no directive here governs
//! (`form-action` is about form submissions; there is no form). Without a
//! script the tab cannot close itself, so the page says so and how to close
//! it.

use std::sync::LazyLock;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use sha2::{Digest, Sha256};

use crate::models::system::AppLocale;

/// The page's language.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PageLanguage {
    English,
    SimplifiedChinese,
    TraditionalChinese,
}

impl PageLanguage {
    pub fn of(locale: AppLocale) -> Self {
        match locale {
            AppLocale::ZhCn => Self::SimplifiedChinese,
            AppLocale::ZhTw => Self::TraditionalChinese,
            _ => Self::English,
        }
    }

    /// Whether SpaceRing's Chinese pages (`/zh/…`) are the ones to open.
    pub fn is_chinese(self) -> bool {
        !matches!(self, Self::English)
    }
}

/// What came back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// A code: Codeg is finishing the sign-in.
    Received,
    /// `error=access_denied`: the person declined.
    Declined,
}

/// The page's whole stylesheet: SpaceRing's palette (Void, Corona, Bead,
/// Graphite) by night, ink on paper by day, in the system's own fonts.
const STYLE: &str = r#"
:root {
  color-scheme: light dark;
  --bg: #f6f5f1;
  --fg: #17161c;
  --muted: rgb(23 22 28 / 0.66);
  --faint: #6c6a76;
  --line: rgb(23 22 28 / 0.18);
  --raised: #fff;
  --bead: #95560a;
  --bead-rgb: 205 130 30;
  --open-hover: #000;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #050507;
    --fg: #eceaf4;
    --muted: rgb(236 234 244 / 0.66);
    --faint: #8b8a99;
    --line: rgb(236 234 244 / 0.2);
    --raised: #0b0b10;
    --bead: #ffd9a0;
    --bead-rgb: 255 217 160;
    --open-hover: #fff;
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--fg); }
body {
  display: grid;
  place-items: center;
  min-height: 100vh;
  min-height: 100svh;
  margin: 0;
  padding: 34px 21px;
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  text-align: center;
  -webkit-font-smoothing: antialiased;
}
html:lang(zh-TW) body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", sans-serif;
}
main { width: 100%; max-width: 34rem; }
.link { display: flex; align-items: center; justify-content: center; }
.end {
  display: grid;
  place-items: center;
  flex: none;
  width: 56px;
  height: 56px;
  border: 1px solid var(--line);
  background: var(--raised);
}
.ring { border-radius: 50%; }
.ring svg { width: 34px; height: 34px; fill: var(--fg); }
/* Codeg's icon is a tile of its own; a little smaller than the ring, as a square looks larger than a circle as wide */
.codeg { width: 50px; height: 50px; border: 0; background: none; }
.codeg svg { display: block; width: 100%; height: 100%; }
.line {
  position: relative;
  width: 96px;
  height: 1px;
  margin: 0 8px;
  background: linear-gradient(90deg, rgb(var(--bead-rgb) / 0.2), rgb(var(--bead-rgb) / 0.85), rgb(var(--bead-rgb) / 0.2));
}
.badge {
  position: absolute;
  top: 0;
  left: 50%;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  margin: -13px 0 0 -13px;
  border: 1px solid rgb(var(--bead-rgb) / 0.7);
  border-radius: 50%;
  background: var(--bg);
  color: var(--bead);
  box-shadow: 0 0 18px rgb(var(--bead-rgb) / 0.22);
}
.badge svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.declined .line {
  background: repeating-linear-gradient(90deg, var(--line) 0 14px, transparent 14px 17px, var(--line) 17px 19px, transparent 19px 22px);
}
.declined .badge { border-color: var(--line); color: var(--muted); box-shadow: none; }
h1 {
  margin: 34px 0 0;
  font-size: clamp(28px, 4vw + 12px, 40px);
  font-weight: 300;
  line-height: 1.2;
  letter-spacing: -0.01em;
  text-wrap: balance;
}
html:lang(zh) h1 { font-weight: 400; letter-spacing: 0.02em; line-height: 1.3; }
.lede { max-width: 30em; margin: 13px auto 0; color: var(--muted); }
.lede span, .phrases span { display: inline-block; }
/* SpaceRing's primary button: a Corona pill that lights up with Bead */
.open {
  display: flex;
  align-items: center;
  justify-content: center;
  width: fit-content;
  min-width: 12em;
  height: 44px;
  margin: 34px auto 0;
  padding: 0 28px;
  /* invisible, but drawn in forced colours, where the fill is dropped */
  border: 1px solid transparent;
  border-radius: 22px;
  background: var(--fg);
  color: var(--bg);
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 0.01em;
  text-decoration: none;
  white-space: nowrap;
  transition: background-color 0.3s, box-shadow 0.4s;
}
@media (hover: hover) {
  .open:hover {
    background: var(--open-hover);
    box-shadow: 0 0 0 1px rgb(var(--bead-rgb) / 0.7), 0 0 30px rgb(var(--bead-rgb) / 0.32);
  }
}
.open:focus-visible { outline: 1.5px solid var(--bead); outline-offset: 3px; }
/* under the button, the hint is an aside: no frame of its own */
.open + .close { margin-top: 21px; padding: 0; border: 0; }
.close {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px 10px;
  margin: 34px 0 0;
  padding: 8px 16px;
  border: 1px solid var(--line);
  border-radius: 19px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--faint);
}
.keys { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
kbd {
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 6px;
  font: 12px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color: var(--muted);
}
"#;

/// The listener's `Content-Security-Policy`: nothing may load or run, the
/// page's own stylesheet ([`STYLE`], by its hash) aside; nothing may frame
/// it, set its base or submit a form from it.
pub(crate) static CONTENT_SECURITY_POLICY: LazyLock<String> = LazyLock::new(|| {
    format!(
        "default-src 'none'; style-src 'sha256-{}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        STANDARD.encode(Sha256::digest(STYLE.as_bytes()))
    )
});

/// SpaceRing's mark, as spacering.net's `favicon.svg` draws it, cropped to
/// the band.
const RING: &str = r#"<svg viewBox="41 41 430 430"><path fill-rule="evenodd" d="M447.95 366.91A221.8 192.09 30 0 1 159.82 422.36A221.8 192.09 30 0 1 63.78 145.11A221.8 192.09 30 0 1 351.91 89.66A221.8 192.09 30 0 1 447.95 366.91ZM416.77 323.09A172.89 149.73 30 0 0 341.91 106.98A172.89 149.73 30 0 0 117.32 150.2A172.89 149.73 30 0 0 192.18 366.31A172.89 149.73 30 0 0 416.77 323.09ZM188.32 413A20 10 30 0 0 176 394.34A20 10 30 0 0 153.68 393A20 10 30 0 0 166 411.66A20 10 30 0 0 188.32 413Z"/><path d="M134.69 146.1A160.53 137.37 30 0 1 411.63 305.99A172.89 149.73 30 0 0 134.69 146.1Z"/></svg>"#;

/// Codeg's own icon (`public/icon.svg`): its dark tile, the brackets and the
/// three coloured dots. Its colours are presentation attributes, not `style`
/// attributes (only the hashed stylesheet may style the page), and its
/// gradients' ids are its own; there is no `xmlns`, which HTML does not need.
const CODEG: &str = concat!(
    r#"<svg viewBox="0 0 512 512"><defs>"#,
    r##"<linearGradient id="codeg-icon-brackets" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#dcdfe9"/><stop offset="100%" stop-color="#cdd1e2"/></linearGradient>"##,
    r##"<linearGradient id="codeg-icon-dot-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4081"/><stop offset="100%" stop-color="#e91e63"/></linearGradient>"##,
    r##"<linearGradient id="codeg-icon-dot-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffeb3b"/><stop offset="100%" stop-color="#fdd835"/></linearGradient>"##,
    r##"<linearGradient id="codeg-icon-dot-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#29b6f6"/><stop offset="100%" stop-color="#03a9f4"/></linearGradient>"##,
    r##"</defs><rect width="512" height="512" rx="90" ry="90" fill="#1a1a2e"/>"##,
    r##"<polyline points="180,186 100,256 180,326" fill="none" stroke="url(#codeg-icon-brackets)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>"##,
    r##"<polyline points="332,186 412,256 332,326" fill="none" stroke="url(#codeg-icon-brackets)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>"##,
    r##"<circle cx="206" cy="256" r="30" fill="url(#codeg-icon-dot-1)" opacity="0.95"/>"##,
    r##"<circle cx="256" cy="256" r="36" fill="url(#codeg-icon-dot-2)" opacity="0.95"/>"##,
    r##"<circle cx="306" cy="256" r="30" fill="url(#codeg-icon-dot-3)" opacity="0.95"/>"##,
    "</svg>",
);

const TICK: &str = r#"<path d="M5.6 10.3l2.9 2.9 5.9-6.4"/>"#;
const CROSS: &str = r#"<path d="M6.6 6.6l6.8 6.8M13.4 6.6l-6.8 6.8"/>"#;

/// What the page's link opens: Codeg's main window, and nothing more
/// (`deep_link`).
const OPEN_CODEG: &str = "codeg://open";

/// The whole HTML document. `release`: whether this is a release build, the
/// only kind whose page links to [`OPEN_CODEG`].
pub(crate) fn html(outcome: Outcome, language: PageLanguage, release: bool) -> String {
    // Each sentence in phrases that are kept whole, so a narrow window breaks
    // between them rather than inside a word (Chinese breaks anywhere).
    let (lang, heading, text): (_, _, [&str; 2]) = match (language, outcome) {
        (PageLanguage::English, Outcome::Received) => (
            "en",
            "Return to Codeg",
            [
                "Codeg received SRN’s answer",
                "and is finishing the sign-in.",
            ],
        ),
        (PageLanguage::English, Outcome::Declined) => (
            "en",
            "Connection canceled",
            [
                "Codeg was not connected to your SRN account.",
                "You can start again from Codeg at any time.",
            ],
        ),
        (PageLanguage::SimplifiedChinese, Outcome::Received) => (
            "zh-CN",
            "请回到 Codeg",
            ["Codeg 已收到 SRN 的授权，", "正在完成登录。"],
        ),
        (PageLanguage::SimplifiedChinese, Outcome::Declined) => (
            "zh-CN",
            "已取消连接",
            [
                "Codeg 没有连接到你的 SRN 账号，",
                "随时可以在 Codeg 中重新发起。",
            ],
        ),
        (PageLanguage::TraditionalChinese, Outcome::Received) => (
            "zh-TW",
            "請回到 Codeg",
            ["Codeg 已收到 SRN 的授權，", "正在完成登入。"],
        ),
        (PageLanguage::TraditionalChinese, Outcome::Declined) => (
            "zh-TW",
            "已取消連線",
            [
                "Codeg 沒有連線到你的 SRN 帳號，",
                "隨時可以在 Codeg 中重新發起。",
            ],
        ),
    };
    // The page cannot close the tab itself (it runs nothing): it says so, and
    // how, for either kind of keyboard.
    let (close, or): ([&str; 2], _) = match language {
        PageLanguage::English => (
            ["This tab won’t close by itself.", "You can close it now."],
            "or",
        ),
        PageLanguage::SimplifiedChinese => (["此标签页不会自动关闭，", "现在可以关闭它了。"], "或"),
        PageLanguage::TraditionalChinese => (["此分頁不會自動關閉，", "現在可以關閉它了。"], "或"),
    };
    let (class, mark) = match outcome {
        Outcome::Received => ("received", TICK),
        Outcome::Declined => ("declined", CROSS),
    };
    let open = if release {
        let label = match language {
            PageLanguage::English => "Open Codeg",
            PageLanguage::SimplifiedChinese => "打开 Codeg",
            PageLanguage::TraditionalChinese => "開啟 Codeg",
        };
        format!("<a class=\"open\" href=\"{OPEN_CODEG}\">{label}</a>")
    } else {
        String::new()
    };
    // between phrases: a space in English, nothing in Chinese
    let gap = if language.is_chinese() { "" } else { " " };
    let [text_1, text_2] = text;
    let [close_1, close_2] = close;
    format!(
        "<!doctype html>\n<html lang=\"{lang}\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <meta name=\"color-scheme\" content=\"light dark\">\
         <title>{heading}</title><style>{STYLE}</style></head>\
         <body class=\"{class}\"><main>\
         <div class=\"link\" aria-hidden=\"true\"><span class=\"end ring\">{RING}</span>\
         <span class=\"line\"><span class=\"badge\"><svg viewBox=\"0 0 20 20\">{mark}</svg></span></span>\
         <span class=\"end codeg\">{CODEG}</span></div>\
         <h1>{heading}</h1><p class=\"lede\"><span>{text_1}</span>{gap}<span>{text_2}</span></p>\
         {open}<p class=\"close\"><span class=\"phrases\"><span>{close_1}</span>{gap}<span>{close_2}</span></span>\
         <span class=\"keys\"><kbd>⌘ W</kbd>{or}<kbd>Ctrl W</kbd></span></p>\
         </main></body></html>\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const LANGUAGES: [PageLanguage; 3] = [
        PageLanguage::English,
        PageLanguage::SimplifiedChinese,
        PageLanguage::TraditionalChinese,
    ];
    const OUTCOMES: [Outcome; 2] = [Outcome::Received, Outcome::Declined];
    /// A development build's page, then a release build's.
    const BUILDS: [bool; 2] = [false, true];

    #[test]
    fn the_page_follows_the_interface_language() {
        assert_eq!(
            PageLanguage::of(AppLocale::ZhCn),
            PageLanguage::SimplifiedChinese
        );
        assert_eq!(
            PageLanguage::of(AppLocale::ZhTw),
            PageLanguage::TraditionalChinese
        );
        for other in [AppLocale::En, AppLocale::Ja, AppLocale::De, AppLocale::Ar] {
            assert_eq!(PageLanguage::of(other), PageLanguage::English);
        }
        for release in BUILDS {
            let page = |outcome, language| html(outcome, language, release);
            assert!(page(Outcome::Received, PageLanguage::English).contains("Return to Codeg"));
            assert!(
                page(Outcome::Received, PageLanguage::SimplifiedChinese).contains("请回到 Codeg")
            );
            assert!(
                page(Outcome::Declined, PageLanguage::TraditionalChinese).contains("已取消連線")
            );
            assert!(
                page(Outcome::Received, PageLanguage::SimplifiedChinese).contains("lang=\"zh-CN\"")
            );
            assert!(page(Outcome::Declined, PageLanguage::English).contains("class=\"declined\""));
            // Codeg's icon as the app draws it: its tile and its coloured dots
            let page = page(Outcome::Received, PageLanguage::English);
            for colour in [
                "fill=\"#1a1a2e\"",
                "stop-color=\"#ff4081\"",
                "stop-color=\"#ffeb3b\"",
                "stop-color=\"#29b6f6\"",
            ] {
                assert!(page.contains(colour), "{colour}");
            }
        }
    }

    #[test]
    fn only_a_release_build_s_page_links_back_to_codeg() {
        for language in LANGUAGES {
            let label = match language {
                PageLanguage::English => "Open Codeg",
                PageLanguage::SimplifiedChinese => "打开 Codeg",
                PageLanguage::TraditionalChinese => "開啟 Codeg",
            };
            for outcome in OUTCOMES {
                // one link, after the sentence and before the hint
                let release = html(outcome, language, true);
                let link = format!("<a class=\"open\" href=\"codeg://open\">{label}</a>");
                assert_eq!(release.matches(&link).count(), 1, "{release}");
                assert_eq!(release.matches("<a").count(), 1, "{release}");
                let at = release.find(&link).unwrap();
                assert!(release.find("class=\"lede\"").unwrap() < at, "{release}");
                assert!(at < release.find("class=\"close\"").unwrap(), "{release}");

                // a development build's: none, and no label
                let development = html(outcome, language, false);
                assert!(!development.contains("<a"), "{development}");
                assert!(!development.contains("codeg:"), "{development}");
                assert!(!development.contains(label), "{development}");
            }
        }
    }

    #[test]
    fn the_page_loads_and_runs_nothing() {
        // no event handler attributes (onload=, onclick=, …)
        let handlers = regex::Regex::new(r"\son[a-z]+\s*=").unwrap();
        for language in LANGUAGES {
            for outcome in OUTCOMES {
                for release in BUILDS {
                    let page = html(outcome, language, release).to_ascii_lowercase();
                    for tag in [
                        "<script",
                        "<img",
                        "<link",
                        "<iframe",
                        "<object",
                        "<embed",
                        "<form",
                        "<image",
                        "<use",
                        "<base",
                        "src=",
                        "http",
                        "@import",
                        "javascript:",
                        "style=",
                    ] {
                        assert!(!page.contains(tag), "{tag} in {page}");
                    }
                    assert!(!handlers.is_match(&page), "{page}");
                    // the only address is the release build's link back to Codeg
                    let hrefs: Vec<&str> = page
                        .match_indices("href=")
                        .map(|(at, _)| &page[at..])
                        .collect();
                    assert_eq!(hrefs.len(), usize::from(release), "{page}");
                    for href in hrefs {
                        assert!(href.starts_with("href=\"codeg://open\""), "{page}");
                    }
                    // url() only names one of the page's own gradients, never a resource
                    for (at, _) in page.match_indices("url(") {
                        assert!(page[at..].starts_with("url(#codeg-icon-"), "{page}");
                    }
                    // one stylesheet, inline, and nothing else that holds CSS
                    assert_eq!(page.matches("<style").count(), 1, "{page}");
                }
            }
        }
    }

    /// The stylesheet the page carries, between its tags, exactly.
    fn style_of(page: &str) -> &str {
        let start = page.find("<style>").expect("a stylesheet") + "<style>".len();
        let end = page[start..].find("</style>").expect("its end") + start;
        &page[start..end]
    }

    #[test]
    fn the_policy_allows_exactly_the_pages_stylesheet() {
        let policy = CONTENT_SECURITY_POLICY.as_str();
        assert!(policy.starts_with("default-src 'none'; "), "{policy}");
        for directive in [
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
        ] {
            assert!(policy.contains(directive), "{directive} in {policy}");
        }
        assert!(!policy.contains("unsafe"), "{policy}");
        let sources: Vec<&str> = policy
            .split(';')
            .map(str::trim)
            .filter(|directive| directive.starts_with("style-src "))
            .collect();
        assert_eq!(sources.len(), 1, "{policy}");
        for language in LANGUAGES {
            for outcome in OUTCOMES {
                for release in BUILDS {
                    let page = html(outcome, language, release);
                    let hash = STANDARD.encode(Sha256::digest(style_of(&page).as_bytes()));
                    assert_eq!(sources[0], format!("style-src 'sha256-{hash}'"));
                }
            }
        }
    }
}
