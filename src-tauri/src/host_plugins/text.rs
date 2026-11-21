use std::{collections::BTreeMap, sync::LazyLock};

use regex::Regex;
static LOCALE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\A[a-z]{2,8}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?\z")
        .expect("valid plugin locale pattern")
});

pub(super) type Translations = BTreeMap<String, String>;

pub(super) fn valid_locale(locale: &str) -> bool {
    LOCALE.is_match(locale)
}

pub(super) fn valid_translations(
    translations: &Translations,
    validate: impl Fn(&str) -> bool,
) -> bool {
    translations
        .iter()
        .all(|(locale, value)| valid_locale(locale) && validate(value))
}
