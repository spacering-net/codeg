//! Parse credentials in memory. Never return them to the frontend.
use serde_json::Value;

pub fn claude_oauth_access_token_from_credentials(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    value
        .get("claudeAiOauth")
        .and_then(|oauth| oauth.get("accessToken"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

pub fn grok_cli_bearer_from_auth_json(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    let obj = value.as_object()?;
    let mut preferred = None;
    let mut fallback = None;
    for (key, entry) in obj {
        let Some(token) = entry.get("key").and_then(Value::as_str) else {
            continue;
        };
        if token.is_empty() {
            continue;
        }
        if key == "https://auth.x.ai"
            || key.starts_with("https://auth.x.ai::")
            || key.starts_with("https://auth.x.ai/")
        {
            preferred = Some(token.to_string());
        } else if key.starts_with("https://accounts.x.ai/") && fallback.is_none() {
            fallback = Some(token.to_string());
        }
    }
    preferred.or(fallback)
}

pub fn cursor_access_token_from_auth_json(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    value
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .or_else(|| {
            value
                .get("apiKey")
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
                .map(str::to_string)
        })
}

pub fn opencode_go_key_from_auth_json(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    let obj = value.as_object()?;
    // `opencode-go` wins when present, but a plain `opencode` entry is the
    // common single-account shape, so a missing provider skips to the next one
    // instead of ending the search.
    for provider in ["opencode-go", "opencode"] {
        let Some(entry) = obj.get(provider).and_then(Value::as_object) else {
            continue;
        };
        let Some(key) = entry.get("key").and_then(Value::as_str) else {
            continue;
        };
        if !key.is_empty() {
            return Some(key.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn does_not_send_other_issuers_tokens_to_grok() {
        assert!(grok_cli_bearer_from_auth_json(
            r#"{"https://auth.x.ai.example.com":{"key":"private"}}"#
        )
        .is_none());
        assert_eq!(
            grok_cli_bearer_from_auth_json(r#"{"https://auth.x.ai::account":{"key":"own"}}"#)
                .as_deref(),
            Some("own")
        );
    }
}
