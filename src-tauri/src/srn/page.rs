//! What the browser shows when SpaceRing sends it back to Codeg.
//!
//! One short page per outcome, in the language of Codeg's interface (English,
//! or Chinese for a Chinese interface), telling the person to go back to
//! Codeg. It loads nothing and runs nothing: the listener serves it under
//! `Content-Security-Policy: default-src 'none'`.

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

/// The whole HTML document.
pub(crate) fn html(outcome: Outcome, language: PageLanguage) -> String {
    let (lang, title, heading, text) = match (language, outcome) {
        (PageLanguage::English, Outcome::Received) => (
            "en",
            "Return to Codeg",
            "Return to Codeg",
            "Codeg received SpaceRing's answer and is finishing the sign-in. You can close this tab.",
        ),
        (PageLanguage::English, Outcome::Declined) => (
            "en",
            "Connection canceled",
            "Connection canceled",
            "Codeg was not connected. You can close this tab and return to Codeg.",
        ),
        (PageLanguage::SimplifiedChinese, Outcome::Received) => (
            "zh-CN",
            "请回到 Codeg",
            "请回到 Codeg",
            "Codeg 已收到 SpaceRing 的授权，正在完成登录。可以关闭此标签页。",
        ),
        (PageLanguage::SimplifiedChinese, Outcome::Declined) => (
            "zh-CN",
            "已取消连接",
            "已取消连接",
            "Codeg 没有连接到你的账号。可以关闭此标签页，回到 Codeg。",
        ),
        (PageLanguage::TraditionalChinese, Outcome::Received) => (
            "zh-TW",
            "請回到 Codeg",
            "請回到 Codeg",
            "Codeg 已收到 SpaceRing 的授權，正在完成登入。可以關閉此分頁。",
        ),
        (PageLanguage::TraditionalChinese, Outcome::Declined) => (
            "zh-TW",
            "已取消連線",
            "已取消連線",
            "Codeg 沒有連線到你的帳號。可以關閉此分頁，回到 Codeg。",
        ),
    };
    format!(
        "<!doctype html>\n<html lang=\"{lang}\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>{title}</title></head><body><main><h1>{heading}</h1><p>{text}</p></main>\
         </body></html>\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(html(Outcome::Received, PageLanguage::English).contains("Return to Codeg"));
        assert!(html(Outcome::Received, PageLanguage::SimplifiedChinese).contains("请回到 Codeg"));
        assert!(html(Outcome::Declined, PageLanguage::TraditionalChinese).contains("已取消連線"));
        assert!(html(Outcome::Received, PageLanguage::SimplifiedChinese).contains("lang=\"zh-CN\""));
    }

    #[test]
    fn the_page_loads_and_runs_nothing() {
        for language in [
            PageLanguage::English,
            PageLanguage::SimplifiedChinese,
            PageLanguage::TraditionalChinese,
        ] {
            for outcome in [Outcome::Received, Outcome::Declined] {
                let page = html(outcome, language).to_ascii_lowercase();
                for tag in [
                    "<script", "<img", "<link", "<style", "<iframe", "src=", "href=", "http",
                ] {
                    assert!(!page.contains(tag), "{tag} in {page}");
                }
            }
        }
    }
}
