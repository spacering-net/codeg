//! The work assistants' templates (4.13): a role each — what it does, what
//! it does not, how its work is handed out, the standing instructions of its
//! executor config, and the opener and choices it starts with — in every
//! language codeg's UI comes in. The words live in `bot_templates/<locale>.json`;
//! what a template is beyond its words (the ways its executor config may be
//! used, the kind of work it is first for, the choice that asks for a
//! project) is here, the same in every language.
//!
//! A name is matched to a template by the keywords of every language
//! (`infer`): no model is asked.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::db::entities::personal_agent_dispatch::DispatchMode;
use crate::models::personal_agent_bots::TemplateView;
use crate::models::system::AppLocale;

/// The template a name matches nothing of.
pub const BLANK: &str = "blank";

/// What a template is beyond its words.
#[derive(Debug, Clone, Copy)]
pub struct TemplateSpec {
    pub id: &'static str,
    /// How its executor config may be used (`None`: every way).
    pub modes: Option<&'static [DispatchMode]>,
    /// The kind of work it is first for (10.5 "fill two").
    pub division: Option<&'static str>,
    /// The choice (0-based) that asks for a project.
    pub project_option: Option<usize>,
}

/// The templates, in the order the pages list them.
pub const SPECS: [TemplateSpec; 9] = [
    TemplateSpec {
        id: "dev",
        modes: Some(&[DispatchMode::Task]),
        division: Some("code"),
        project_option: Some(2),
    },
    TemplateSpec {
        id: "review",
        modes: Some(&[DispatchMode::Session]),
        division: Some("review"),
        project_option: None,
    },
    TemplateSpec {
        id: "test",
        modes: Some(&[DispatchMode::Task, DispatchMode::Session]),
        division: Some("test"),
        project_option: None,
    },
    TemplateSpec {
        id: "ci",
        modes: Some(&[DispatchMode::Task]),
        division: Some("fix_ci"),
        project_option: Some(0),
    },
    TemplateSpec {
        id: "docs",
        modes: Some(&[DispatchMode::Task, DispatchMode::Chat]),
        division: Some("docs"),
        project_option: Some(0),
    },
    TemplateSpec {
        id: "release",
        modes: Some(&[DispatchMode::Session]),
        division: Some("release"),
        project_option: None,
    },
    TemplateSpec {
        id: "cleanup",
        modes: Some(&[DispatchMode::Task]),
        division: None,
        project_option: Some(0),
    },
    TemplateSpec {
        id: "research",
        modes: Some(&[DispatchMode::Chat, DispatchMode::Session]),
        division: Some("research"),
        project_option: None,
    },
    TemplateSpec {
        id: BLANK,
        modes: None,
        division: None,
        project_option: None,
    },
];

/// The words of one template in one language.
#[derive(Debug, Clone, Deserialize)]
pub struct TemplateText {
    pub name: String,
    pub job: String,
    #[serde(default)]
    pub not_jobs: Vec<String>,
    #[serde(default)]
    pub rules: Vec<String>,
    #[serde(default)]
    pub instructions: Vec<String>,
    #[serde(default)]
    pub description: String,
    pub opener: String,
    pub options: Vec<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SoulText {
    heading: String,
    intro: String,
    job: String,
    not_job: String,
    common_heading: String,
    common: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RulesText {
    heading: String,
    common: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct LocaleFile {
    other: String,
    soul: SoulText,
    rules: RulesText,
    templates: HashMap<String, TemplateText>,
}

const FILES: [(AppLocale, &str); 10] = [
    (AppLocale::En, include_str!("bot_templates/en.json")),
    (AppLocale::ZhCn, include_str!("bot_templates/zh-CN.json")),
    (AppLocale::ZhTw, include_str!("bot_templates/zh-TW.json")),
    (AppLocale::Ja, include_str!("bot_templates/ja.json")),
    (AppLocale::Ko, include_str!("bot_templates/ko.json")),
    (AppLocale::Es, include_str!("bot_templates/es.json")),
    (AppLocale::De, include_str!("bot_templates/de.json")),
    (AppLocale::Fr, include_str!("bot_templates/fr.json")),
    (AppLocale::Pt, include_str!("bot_templates/pt.json")),
    (AppLocale::Ar, include_str!("bot_templates/ar.json")),
];

/// Every language's file, parsed once. One that does not parse (a test
/// catches it first) reads as English.
fn files() -> &'static Vec<(AppLocale, LocaleFile)> {
    static PARSED: OnceLock<Vec<(AppLocale, LocaleFile)>> = OnceLock::new();
    PARSED.get_or_init(|| {
        let mut out: Vec<(AppLocale, LocaleFile)> = Vec::new();
        for (locale, raw) in FILES {
            match serde_json::from_str::<LocaleFile>(raw) {
                Ok(f) => out.push((locale, f)),
                Err(e) => {
                    tracing::warn!("[personal-agent] templates for {locale:?} unreadable: {e}")
                }
            }
        }
        out
    })
}

fn file(locale: AppLocale) -> &'static LocaleFile {
    let all = files();
    all.iter()
        .find(|(l, _)| *l == locale)
        .or_else(|| all.iter().find(|(l, _)| *l == AppLocale::En))
        .map(|(_, f)| f)
        .expect("the English templates parse")
}

/// A template's spec, by id.
pub fn spec(id: &str) -> Option<&'static TemplateSpec> {
    SPECS.iter().find(|s| s.id == id)
}

/// A template's words in `locale` (English where that language lacks it).
pub fn text(locale: AppLocale, id: &str) -> Option<&'static TemplateText> {
    file(locale)
        .templates
        .get(id)
        .or_else(|| file(AppLocale::En).templates.get(id))
}

/// "Other", the choice the owner writes themselves.
pub fn other_label(locale: AppLocale) -> &'static str {
    &file(locale).other
}

fn bullets(lines: &[String]) -> String {
    lines
        .iter()
        .map(|l| format!("- {l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// A work assistant's `SOUL.md` for template `id`: its role, its job, what
/// it does not do, and how it works.
pub fn soul_md(locale: AppLocale, id: &str) -> String {
    let f = file(locale);
    let t = text(locale, id)
        .or_else(|| text(locale, BLANK))
        .expect("blank exists");
    let mut out = format!(
        "{}\n\n{}\n\n{}\n\n{}\n",
        f.soul.heading,
        f.soul.intro.replace("{role}", &t.name),
        f.soul.job,
        t.job
    );
    if !t.not_jobs.is_empty() {
        out.push_str(&format!(
            "\n{}\n\n{}\n",
            f.soul.not_job,
            bullets(&t.not_jobs)
        ));
    }
    out.push_str(&format!(
        "\n{}\n\n{}\n",
        f.soul.common_heading,
        bullets(&f.soul.common)
    ));
    out
}

/// A work assistant's `AGENTS.md` for template `id`: the rules every work
/// assistant keeps, then its role's.
pub fn rules_md(locale: AppLocale, id: &str) -> String {
    let f = file(locale);
    let t = text(locale, id)
        .or_else(|| text(locale, BLANK))
        .expect("blank exists");
    let mut lines = f.rules.common.clone();
    lines.extend(t.rules.iter().cloned());
    format!("{}\n\n{}\n", f.rules.heading, bullets(&lines))
}

/// The standing instructions of a template's executor config.
pub fn instructions(locale: AppLocale, id: &str) -> String {
    text(locale, id)
        .map(|t| bullets(&t.instructions))
        .unwrap_or_default()
}

/// The template a name reads as: the one whose keyword — in any language —
/// matches the longest stretch of it; blank when none does.
pub fn infer(name: &str) -> &'static str {
    let hay = name.to_lowercase();
    let mut best: Option<(usize, usize)> = None;
    for (i, s) in SPECS.iter().enumerate() {
        if s.id == BLANK {
            continue;
        }
        for (_, f) in files() {
            let Some(t) = f.templates.get(s.id) else {
                continue;
            };
            for kw in t.keywords.iter().chain(std::iter::once(&t.name)) {
                let kw = kw.trim().to_lowercase();
                if kw.is_empty() || !matches(&hay, &kw) {
                    continue;
                }
                let len = kw.chars().count();
                if best.is_none_or(|(l, _)| len > l) {
                    best = Some((len, i));
                }
            }
        }
    }
    best.map(|(_, i)| SPECS[i].id).unwrap_or(BLANK)
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xac00..=0xd7af | 0xf900..=0xfaff)
}

/// A letter or digit that joins a word, where CJK ones do not (they are
/// written without spaces, so "修CI" holds the word "ci").
fn joins(c: char) -> bool {
    c.is_alphanumeric() && !is_cjk(c)
}

/// Whether `kw` is in `hay`: anywhere for a CJK keyword; for any other, at
/// the start of a word — the whole word when it is short ("ci" is not in
/// "city", "review" is in "reviewers").
fn matches(hay: &str, kw: &str) -> bool {
    if kw.chars().any(is_cjk) {
        return hay.contains(kw);
    }
    let short = kw.chars().count() <= 3;
    let mut from = 0;
    while let Some(pos) = hay[from..].find(kw) {
        let at = from + pos;
        let end = at + kw.len();
        let before_ok = hay[..at].chars().next_back().is_none_or(|c| !joins(c));
        let after_ok = !short || hay[end..].chars().next().is_none_or(|c| !joins(c));
        if before_ok && after_ok {
            return true;
        }
        from = at + kw.chars().next().map(char::len_utf8).unwrap_or(1);
    }
    false
}

/// Every template as the pages read it, in `locale`.
pub fn views(locale: AppLocale) -> Vec<TemplateView> {
    SPECS.iter().filter_map(|s| view(locale, s.id)).collect()
}

/// One template as the pages read it.
pub fn view(locale: AppLocale, id: &str) -> Option<TemplateView> {
    let s = spec(id)?;
    let t = text(locale, id)?;
    Some(TemplateView {
        id: s.id.to_string(),
        name: t.name.clone(),
        job: t.job.clone(),
        description: t.description.clone(),
        instructions: instructions(locale, id),
        opener: t.opener.clone(),
        options: t.options.clone(),
        other: other_label(locale).to_string(),
        modes: s.modes.map(|m| m.to_vec()),
        division: s.division.map(str::to_string),
        project_option: s.project_option,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_language_has_every_template_whole() {
        assert_eq!(files().len(), FILES.len(), "every file parses");
        let en = file(AppLocale::En);
        for (locale, f) in files() {
            for s in SPECS {
                let t = f
                    .templates
                    .get(s.id)
                    .unwrap_or_else(|| panic!("{locale:?} lacks {}", s.id));
                let e = &en.templates[s.id];
                assert_eq!(t.options.len(), 3, "{locale:?} {}", s.id);
                assert_eq!(t.not_jobs.len(), e.not_jobs.len(), "{locale:?} {}", s.id);
                assert_eq!(t.rules.len(), e.rules.len(), "{locale:?} {}", s.id);
                assert_eq!(
                    t.instructions.len(),
                    e.instructions.len(),
                    "{locale:?} {}",
                    s.id
                );
                assert!(!t.name.trim().is_empty() && !t.opener.trim().is_empty());
                assert_eq!(s.id == BLANK, t.keywords.is_empty(), "{locale:?} {}", s.id);
            }
            assert_eq!(
                f.templates.len(),
                SPECS.len(),
                "{locale:?} has no extra template"
            );
            assert!(f.soul.intro.contains("{role}"), "{locale:?}");
            assert!(!f.other.trim().is_empty());
        }
    }

    #[test]
    fn a_name_is_matched_to_its_role_in_any_language() {
        for (name, want) in [
            ("代码评审", "review"),
            ("Code Reviewer", "review"),
            ("reviewers", "review"),
            ("修CI", "ci"),
            ("修 CI", "ci"),
            ("CI fixer", "ci"),
            ("夜间清理", "cleanup"),
            ("Nightly cleanup", "cleanup"),
            ("研发", "dev"),
            ("Backend developer", "dev"),
            ("测试", "test"),
            ("QA", "test"),
            ("文档", "docs"),
            ("调研", "research"),
            ("发布", "release"),
            ("Alfred", BLANK),
            ("City guide", BLANK),
            ("", BLANK),
        ] {
            assert_eq!(infer(name), want, "{name}");
        }
    }

    #[test]
    fn a_role_writes_its_files_in_the_language_asked_for() {
        let soul = soul_md(AppLocale::ZhCn, "review");
        assert!(soul.starts_with("# 人设"));
        assert!(soul.contains("岗位：评审"));
        assert!(soul.contains("- 不改代码。"));
        let rules = rules_md(AppLocale::ZhCn, "review");
        assert!(rules.starts_with("# 规则"));
        assert!(rules.contains("`dispatch` 省掉 `assistant_id`"));
        assert!(rules.contains("只读的 `session`"));
        let blank = soul_md(AppLocale::En, BLANK);
        assert!(
            !blank.contains("Not your job"),
            "a blank role lists nothing it does not do"
        );
        assert_eq!(
            instructions(AppLocale::En, "review"),
            "- Read only; change no file.\n- Give evidence as `file:line`.\n- Keep what must change apart from what is a suggestion."
        );
        let v = view(AppLocale::En, "dev").unwrap();
        assert_eq!(v.project_option, Some(2));
        assert_eq!(v.options[2], "Look at a project's to-dos first");
        assert_eq!(views(AppLocale::Ja).len(), SPECS.len());
    }
}
