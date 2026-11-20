//! Phase 5 — network probes and test requests for the four shared-provider API
//! families.
//!
//! The probe lists models from a provider's `/models` endpoint; the test sends
//! a minimal chat request and returns the model's reply. Both run only from
//! the settings editor (never from a browser) with a hard timeout so a hanging
//! endpoint cannot wedge the editor, and both surface a readable one-line
//! error instead of a raw transport failure.

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde_json::{json, Value};

use crate::models::model_provider_file::{
    ModelEntryDraft, ModelProviderApiType, ProbeOutcome, TestOutcome, WireModelInput,
};

/// Hard cap for a probe/test round-trip. 20s covers slow gateways without
/// making the settings editor feel hung.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// List models from a provider endpoint for the given API family.
pub async fn probe_models(
    base_url: &str,
    api: ModelProviderApiType,
    api_key: Option<&str>,
    auth_header: bool,
) -> ProbeOutcome {
    let Some(key) = non_empty(api_key) else {
        return probe_fail("API key is required");
    };
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return probe_fail("Base URL is required");
    }

    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(e) => return probe_fail(&format!("failed to build HTTP client: {e}")),
    };

    let (url, headers) = match api {
        ModelProviderApiType::OpenAiCompletions | ModelProviderApiType::OpenAiResponses => {
            (format!("{base}/models"), openai_headers(key, auth_header))
        }
        ModelProviderApiType::AnthropicMessages => {
            let mut headers = HeaderMap::new();
            insert_header(&mut headers, "x-api-key", key);
            insert_header(&mut headers, "anthropic-version", "2023-06-01");
            (format!("{base}/v1/models"), headers)
        }
        ModelProviderApiType::GoogleGenerativeAi => {
            let mut headers = HeaderMap::new();
            insert_header(&mut headers, "x-goog-api-key", key);
            (format!("{base}/models"), headers)
        }
    };

    match client.get(&url).headers(headers).send().await {
        Ok(response) if response.status().is_success() => {
            let body = match response.text().await {
                Ok(body) => body,
                Err(e) => return probe_fail(&format!("failed to read response: {e}")),
            };
            parse_models(api, &body)
        }
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            probe_fail(&format!("HTTP {status}: {}", first_line(&body)))
        }
        Err(e) => probe_fail(&format!("request failed: {e}")),
    }
}

/// Send a minimal chat request to a provider and return the model's reply.
pub async fn test_model(
    base_url: &str,
    api: ModelProviderApiType,
    api_key: Option<&str>,
    model_id: &str,
    auth_header: bool,
) -> TestOutcome {
    let Some(key) = non_empty(api_key) else {
        return test_fail("API key is required");
    };
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return test_fail("Base URL is required");
    }
    if non_empty(Some(model_id)).is_none() {
        return test_fail("Model id is required");
    }

    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(e) => return test_fail(&format!("failed to build HTTP client: {e}")),
    };

    let (url, headers, body) = match api {
        ModelProviderApiType::OpenAiCompletions => (
            format!("{base}/chat/completions"),
            openai_headers(key, auth_header),
            json!({
                "model": model_id,
                "max_tokens": 8,
                "messages": [{"role": "user", "content": "ping"}],
            }),
        ),
        ModelProviderApiType::OpenAiResponses => (
            format!("{base}/responses"),
            openai_headers(key, auth_header),
            json!({
                "model": model_id,
                "max_output_tokens": 8,
                "input": "ping",
            }),
        ),
        ModelProviderApiType::AnthropicMessages => {
            let mut headers = HeaderMap::new();
            insert_header(&mut headers, "x-api-key", key);
            insert_header(&mut headers, "anthropic-version", "2023-06-01");
            (
                format!("{base}/v1/messages"),
                headers,
                json!({
                    "model": model_id,
                    "max_tokens": 8,
                    "messages": [{"role": "user", "content": "ping"}],
                }),
            )
        }
        ModelProviderApiType::GoogleGenerativeAi => {
            let mut headers = HeaderMap::new();
            insert_header(&mut headers, "x-goog-api-key", key);
            (
                format!("{base}/models/{model_id}:generateContent"),
                headers,
                json!({ "contents": [{"parts": [{"text": "ping"}]}] }),
            )
        }
    };

    match client.post(&url).headers(headers).json(&body).send().await {
        Ok(response) if response.status().is_success() => {
            let raw = match response.text().await {
                Ok(raw) => raw,
                Err(e) => return test_fail(&format!("failed to read response: {e}")),
            };
            let reply = serde_json::from_str::<Value>(&raw)
                .ok()
                .and_then(|value| extract_reply(api, &value))
                .unwrap_or_else(|| "ok".to_string());
            TestOutcome {
                ok: true,
                reply: Some(reply),
                error: None,
            }
        }
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            test_fail(&format!("HTTP {status}: {}", first_line(&body)))
        }
        Err(e) => test_fail(&format!("request failed: {e}")),
    }
}

/// Parse a `/models` response into editor drafts. OpenAI and Anthropic list
/// models under `data[]` with an `id`; Google lists them under `models[]`
/// with a `models/<id>` `name`.
fn parse_models(api: ModelProviderApiType, body: &str) -> ProbeOutcome {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return probe_fail(&format!(
            "unexpected response (not JSON): {}",
            first_line(body)
        ));
    };
    let list = match api {
        ModelProviderApiType::GoogleGenerativeAi => value.get("models").and_then(Value::as_array),
        _ => value.get("data").and_then(Value::as_array),
    };
    let Some(list) = list else {
        return probe_fail("response had no model list");
    };

    let mut models = Vec::new();
    for item in list {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| item.get("name").and_then(Value::as_str))
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(|id| id.strip_prefix("models/").unwrap_or(id).to_string());
        if let Some(id) = id {
            models.push(ModelEntryDraft {
                id,
                reasoning: false,
                input: WireModelInput::Text,
                context_window: None,
                max_tokens: None,
                base_instructions: None,
            });
        }
    }
    if models.is_empty() {
        return probe_fail("no models returned by provider");
    }
    ProbeOutcome {
        ok: true,
        models: Some(models),
        error: None,
    }
}

/// Extract the model's reply text from a successful chat response. Returns
/// `None` when the shape differs from the family's standard success payload
/// (the caller then falls back to a plain "ok").
fn extract_reply(api: ModelProviderApiType, body: &Value) -> Option<String> {
    let candidate: Option<&str> = match api {
        ModelProviderApiType::OpenAiCompletions => {
            body["choices"][0]["message"]["content"].as_str()
        }
        ModelProviderApiType::OpenAiResponses => {
            let content = &body["output"][0]["content"];
            content.as_str().or_else(|| {
                content
                    .get(0)
                    .and_then(|c| c.get("text").and_then(Value::as_str))
            })
        }
        ModelProviderApiType::AnthropicMessages => body["content"][0]["text"].as_str(),
        ModelProviderApiType::GoogleGenerativeAi => {
            body["candidates"][0]["content"]["parts"][0]["text"].as_str()
        }
    };
    candidate
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn openai_headers(api_key: &str, auth_header: bool) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if auth_header {
        if let Ok(value) = HeaderValue::from_str(&format!("Bearer {api_key}")) {
            headers.insert(AUTHORIZATION, value);
        }
    } else {
        insert_header(&mut headers, "x-api-key", api_key);
    }
    headers
}

fn insert_header(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(reqwest::header::HeaderName::from_static(name), value);
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

fn first_line(body: &str) -> String {
    body.lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect()
}

fn probe_fail(error: &str) -> ProbeOutcome {
    ProbeOutcome {
        ok: false,
        models: None,
        error: Some(error.to_string()),
    }
}

fn test_fail(error: &str) -> TestOutcome {
    TestOutcome {
        ok: false,
        reply: None,
        error: Some(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header::AUTHORIZATION, HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::{routing::get, Json, Router};

    async fn spawn_server(router: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            axum::serve(listener, router).await.expect("serve");
        });
        format!("http://{addr}")
    }

    async fn openai_models_handler(headers: HeaderMap) -> Response {
        if headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()) == Some("Bearer sk-test") {
            Json(json!({"data": [{"id": "gpt-test-1"}, {"id": "gpt-test-2"}]})).into_response()
        } else {
            StatusCode::UNAUTHORIZED.into_response()
        }
    }

    async fn anthropic_models_handler(headers: HeaderMap) -> Response {
        let key_ok = headers.get("x-api-key").and_then(|v| v.to_str().ok()) == Some("sk-test");
        let version_ok = headers
            .get("anthropic-version")
            .and_then(|v| v.to_str().ok())
            == Some("2023-06-01");
        if key_ok && version_ok {
            Json(json!({"data": [{"id": "claude-test", "type": "model"}]})).into_response()
        } else {
            StatusCode::UNAUTHORIZED.into_response()
        }
    }

    async fn gemini_models_handler(headers: HeaderMap) -> Response {
        if headers.get("x-goog-api-key").and_then(|v| v.to_str().ok()) == Some("sk-test") {
            Json(json!({"models": [{"name": "models/gemini-test"}]})).into_response()
        } else {
            StatusCode::UNAUTHORIZED.into_response()
        }
    }

    fn chat_router() -> Router {
        Router::new()
            .route(
                "/chat/completions",
                axum::routing::post(|| async {
                    Json(json!({"choices": [{"message": {"content": "pong"}}]}))
                }),
            )
            .route(
                "/responses",
                axum::routing::post(|| async {
                    Json(
                        json!({"output": [{"content": [{"type": "output_text", "text": "pong"}]}]}),
                    )
                }),
            )
            .route(
                "/v1/messages",
                axum::routing::post(|| async {
                    Json(json!({"content": [{"type": "text", "text": "pong"}]}))
                }),
            )
            .route(
                "/models/model-a:generateContent",
                axum::routing::post(|| async {
                    Json(json!({"candidates": [{"content": {"parts": [{"text": "pong"}]}}]}))
                }),
            )
    }

    fn models_router() -> Router {
        Router::new()
            .route("/models", get(openai_models_handler))
            .route("/v1/models", get(anthropic_models_handler))
            .route("/gemini/models", get(gemini_models_handler))
    }

    #[tokio::test]
    async fn probe_lists_openai_models_with_bearer() {
        let base = spawn_server(models_router()).await;
        let outcome = probe_models(
            &base,
            ModelProviderApiType::OpenAiCompletions,
            Some("sk-test"),
            true,
        )
        .await;
        assert!(outcome.ok, "{outcome:?}");
        let ids: Vec<&str> = outcome
            .models
            .as_ref()
            .unwrap()
            .iter()
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(ids, ["gpt-test-1", "gpt-test-2"]);
    }

    #[tokio::test]
    async fn probe_lists_anthropic_models_with_x_api_key_and_version() {
        let base = spawn_server(models_router()).await;
        let outcome = probe_models(
            &base,
            ModelProviderApiType::AnthropicMessages,
            Some("sk-test"),
            false,
        )
        .await;
        assert!(outcome.ok, "{outcome:?}");
        assert_eq!(outcome.models.as_ref().unwrap()[0].id, "claude-test");
    }

    #[tokio::test]
    async fn probe_lists_gemini_models_with_x_goog_api_key() {
        // Gemini's probe path is also `{base}/models`; serve the google-shaped
        // handler at /gemini/models and point the probe at a base ending in
        // /gemini so it routes there.
        let base = format!("{}/gemini", spawn_server(models_router()).await);
        let outcome = probe_models(
            &base,
            ModelProviderApiType::GoogleGenerativeAi,
            Some("sk-test"),
            false,
        )
        .await;
        assert!(outcome.ok, "{outcome:?}");
        assert_eq!(outcome.models.as_ref().unwrap()[0].id, "gemini-test");
    }

    #[tokio::test]
    async fn probe_requires_api_key_without_network() {
        let outcome = probe_models(
            "https://example.invalid",
            ModelProviderApiType::OpenAiCompletions,
            None,
            true,
        )
        .await;
        assert!(!outcome.ok);
        assert!(outcome.error.as_deref().unwrap().contains("API key"));
    }

    #[tokio::test]
    async fn probe_reports_http_error_status() {
        let base = spawn_server(chat_router()).await;
        let outcome = probe_models(
            &format!("{base}/missing"),
            ModelProviderApiType::OpenAiCompletions,
            Some("sk-test"),
            true,
        )
        .await;
        assert!(!outcome.ok);
        assert!(
            outcome.error.as_deref().unwrap().starts_with("HTTP 404"),
            "{outcome:?}"
        );
    }

    #[tokio::test]
    async fn probe_rejects_non_json_body() {
        let router = Router::new().route("/models", get(|| async { "hello" }));
        let base = spawn_server(router).await;
        let outcome = probe_models(
            &base,
            ModelProviderApiType::OpenAiCompletions,
            Some("sk-test"),
            true,
        )
        .await;
        assert!(!outcome.ok);
        assert!(
            outcome.error.as_deref().unwrap().contains("not JSON"),
            "{outcome:?}"
        );
    }

    #[tokio::test]
    async fn test_chat_extracts_reply_per_api_family() {
        let base = spawn_server(chat_router()).await;
        let cases = [
            ModelProviderApiType::OpenAiCompletions,
            ModelProviderApiType::OpenAiResponses,
            ModelProviderApiType::AnthropicMessages,
            ModelProviderApiType::GoogleGenerativeAi,
        ];
        for api in cases {
            let outcome = test_model(&base, api, Some("sk-test"), "model-a", true).await;
            assert!(outcome.ok, "{api:?}: {outcome:?}");
            assert_eq!(outcome.reply.as_deref(), Some("pong"), "{api:?}");
        }
    }

    #[tokio::test]
    async fn test_chat_reports_http_error() {
        let base = spawn_server(chat_router()).await;
        let outcome = test_model(
            &format!("{base}/missing"),
            ModelProviderApiType::OpenAiCompletions,
            Some("sk-test"),
            "model-a",
            true,
        )
        .await;
        assert!(!outcome.ok);
        assert!(
            outcome.error.as_deref().unwrap().starts_with("HTTP 404"),
            "{outcome:?}"
        );
    }

    #[tokio::test]
    async fn openai_x_api_key_mode_uses_custom_header() {
        // A provider with authHeader=false must send x-api-key, not Bearer.
        let router = Router::new().route(
            "/models",
            get(|headers: HeaderMap| async move {
                if headers.get("x-api-key").and_then(|v| v.to_str().ok()) == Some("sk-test") {
                    Json(json!({"data": [{"id": "gpt-test"}]})).into_response()
                } else {
                    StatusCode::UNAUTHORIZED.into_response()
                }
            }),
        );
        let base = spawn_server(router).await;
        let outcome = probe_models(
            &base,
            ModelProviderApiType::OpenAiCompletions,
            Some("sk-test"),
            false,
        )
        .await;
        assert!(outcome.ok, "{outcome:?}");
    }
}
