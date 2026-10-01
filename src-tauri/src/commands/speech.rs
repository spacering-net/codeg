use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;
#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;
use base64::{engine::general_purpose, Engine as _};
use reqwest::multipart;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;

#[cfg(feature = "tauri-runtime")]
use tauri::State;

const SPEECH_CLOUD_API_KEY: &str = "speech-cloud-api-key";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCloudSettings {
    pub base_url: String,
    pub stt_model: String,
    pub tts_model: String,
    pub tts_voice: String,
}

impl Default for SpeechCloudSettings {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".to_string(),
            stt_model: "whisper-1".to_string(),
            tts_model: "tts-1".to_string(),
            tts_voice: "alloy".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCloudSettingsView {
    pub settings: SpeechCloudSettings,
    pub api_key_set: bool,
}

#[cfg(not(test))]
mod store {
    pub fn get_secret(key: &str) -> Result<Option<String>, String> {
        crate::keyring_store::get_secret(key)
    }

    pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
        crate::keyring_store::set_secret(key, value)
    }

    pub fn delete_secret(key: &str) -> Result<(), String> {
        crate::keyring_store::delete_secret(key)
    }
}

#[cfg(test)]
mod store {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};

    static STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    static UNREADABLE: AtomicBool = AtomicBool::new(false);

    pub fn set_unreadable(unreadable: bool) {
        UNREADABLE.store(unreadable, Ordering::SeqCst);
    }

    fn get_store() -> &'static Mutex<HashMap<String, String>> {
        STORE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub fn get_secret(key: &str) -> Result<Option<String>, String> {
        if UNREADABLE.load(Ordering::SeqCst) {
            return Err("store is unreadable".to_string());
        }
        let store = get_store().lock().unwrap();
        Ok(store.get(key).cloned())
    }

    pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
        if UNREADABLE.load(Ordering::SeqCst) {
            return Err("store is unreadable".to_string());
        }
        let mut store = get_store().lock().unwrap();
        store.insert(key.to_string(), value.to_string());
        Ok(())
    }

    pub fn delete_secret(key: &str) -> Result<(), String> {
        if UNREADABLE.load(Ordering::SeqCst) {
            return Err("store is unreadable".to_string());
        }
        let mut store = get_store().lock().unwrap();
        store.remove(key);
        Ok(())
    }
}

pub async fn get_settings_core(conn: &sea_orm::DatabaseConnection) -> SpeechCloudSettings {
    match app_metadata_service::get_value(conn, "speech_cloud_settings").await {
        Ok(Some(val)) => serde_json::from_str(&val).unwrap_or_default(),
        _ => SpeechCloudSettings::default(),
    }
}

pub async fn speech_get_settings_core(
    conn: &sea_orm::DatabaseConnection,
) -> Result<SpeechCloudSettingsView, AppCommandError> {
    let settings = get_settings_core(conn).await;
    let api_key_set = store::get_secret(SPEECH_CLOUD_API_KEY)
        .unwrap_or(None)
        .is_some();
    Ok(SpeechCloudSettingsView {
        settings,
        api_key_set,
    })
}

pub async fn speech_update_settings_core(
    conn: &sea_orm::DatabaseConnection,
    settings: SpeechCloudSettings,
    api_key: Option<String>,
) -> Result<SpeechCloudSettingsView, AppCommandError> {
    let mut clean_base_url = settings.base_url.trim().to_string();
    if clean_base_url.ends_with('/') {
        clean_base_url.pop();
    }
    if !clean_base_url.starts_with("http://") && !clean_base_url.starts_with("https://") {
        return Err(AppCommandError::invalid_input(
            "base_url must start with http or https",
        ));
    }

    let clean_settings = SpeechCloudSettings {
        base_url: clean_base_url,
        ..settings
    };

    let val = serde_json::to_string(&clean_settings).map_err(|e| {
        AppCommandError::io_error("Failed to serialize speech settings").with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, "speech_cloud_settings", &val).await?;

    if let Some(key) = api_key {
        if key.is_empty() {
            store::delete_secret(SPEECH_CLOUD_API_KEY).map_err(|e| {
                AppCommandError::io_error("Failed to delete the speech API key").with_detail(e)
            })?;
        } else {
            store::set_secret(SPEECH_CLOUD_API_KEY, &key).map_err(|e| {
                AppCommandError::io_error("Failed to store the speech API key").with_detail(e)
            })?;
        }
    }

    speech_get_settings_core(conn).await
}

fn get_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(format!("codeg/{}", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap()
    })
}

pub async fn speech_transcribe_core(
    conn: &sea_orm::DatabaseConnection,
    audio_base64: String,
    mime_type: String,
    language: Option<String>,
) -> Result<String, AppCommandError> {
    if audio_base64.is_empty() {
        return Err(AppCommandError::invalid_input("Audio data is empty"));
    }
    if audio_base64.len() > 25 * 1024 * 1024 * 4 / 3 + 1024 {
        return Err(AppCommandError::invalid_input("Audio size exceeds 25 MiB"));
    }

    let audio_bytes = general_purpose::STANDARD
        .decode(&audio_base64)
        .map_err(|_| AppCommandError::invalid_input("Invalid base64 audio data"))?;

    if audio_bytes.is_empty() {
        return Err(AppCommandError::invalid_input("Audio data is empty"));
    }
    if audio_bytes.len() > 25 * 1024 * 1024 {
        return Err(AppCommandError::invalid_input("Audio size exceeds 25 MiB"));
    }

    let ext = match mime_type.as_str() {
        "audio/webm" => "webm",
        "audio/ogg" => "ogg",
        "audio/mp4" => "m4a",
        "audio/wav" => "wav",
        _ => "webm",
    };
    let filename = format!("speech.{}", ext);

    let api_key = store::get_secret(SPEECH_CLOUD_API_KEY)
        .map_err(|e| AppCommandError::io_error("Failed to read the speech API key").with_detail(e))?
        .ok_or_else(|| AppCommandError::configuration_missing("Speech cloud API key not set"))?;

    let settings = get_settings_core(conn).await;

    let part = multipart::Part::bytes(audio_bytes)
        .file_name(filename)
        .mime_str(&mime_type)
        .map_err(|e| AppCommandError::network(e.to_string()))?;

    let mut form = multipart::Form::new()
        .part("file", part)
        .text("model", settings.stt_model)
        .text("response_format", "json");

    if let Some(lang) = language {
        let subtag = lang.split('-').next().unwrap_or(&lang).to_string();
        form = form.text("language", subtag);
    }

    let url = format!("{}/audio/transcriptions", settings.base_url);

    let res = get_client()
        .post(&url)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| AppCommandError::network(e.to_string()))?;

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(AppCommandError::authentication_failed(
            "Speech cloud API authentication failed",
        ));
    }

    if !status.is_success() {
        let body = res
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read response body".to_string());
        let truncated: String = body.chars().take(500).collect();
        return Err(AppCommandError::network(format!(
            "API error {}: {}",
            status, truncated
        )));
    }

    #[derive(Deserialize)]
    struct TranscriptionResponse {
        text: String,
    }

    let json: TranscriptionResponse = res
        .json()
        .await
        .map_err(|e| AppCommandError::network(e.to_string()))?;

    Ok(json.text.trim().to_string())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn speech_get_settings(
    db: State<'_, AppDatabase>,
) -> Result<SpeechCloudSettingsView, AppCommandError> {
    speech_get_settings_core(&db.conn).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn speech_update_settings(
    db: State<'_, AppDatabase>,
    settings: SpeechCloudSettings,
    api_key: Option<String>,
) -> Result<SpeechCloudSettingsView, AppCommandError> {
    speech_update_settings_core(&db.conn, settings, api_key).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn speech_transcribe(
    db: State<'_, AppDatabase>,
    audio_base64: String,
    mime_type: String,
    language: Option<String>,
) -> Result<String, AppCommandError> {
    speech_transcribe_core(&db.conn, audio_base64, mime_type, language).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every test that reads or writes the API key goes through the one
    /// process-global test store, so they take this lock for their whole run.
    static KEY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    use crate::app_error::AppErrorCode;
    use crate::db::test_helpers::fresh_in_memory_db as setup_test_db;

    #[tokio::test]
    async fn test_settings_roundtrip() {
        let _guard = KEY_LOCK.lock().await;
        let db = setup_test_db().await;
        let settings = SpeechCloudSettings {
            stt_model: "custom-model".to_string(),
            ..Default::default()
        };

        let view =
            speech_update_settings_core(&db.conn, settings.clone(), Some("test-key".to_string()))
                .await
                .unwrap();
        assert_eq!(view.settings.stt_model, "custom-model");
        assert!(view.api_key_set);

        let fetched = speech_get_settings_core(&db.conn).await.unwrap();
        assert_eq!(fetched.settings.stt_model, "custom-model");
        assert!(fetched.api_key_set);
    }

    #[tokio::test]
    async fn test_invalid_base_url() {
        let db = setup_test_db().await;
        let settings = SpeechCloudSettings {
            base_url: "ftp://api.openai.com/v1".to_string(),
            ..Default::default()
        };
        let res = speech_update_settings_core(&db.conn, settings.clone(), None).await;
        assert!(res.is_err());
        assert!(matches!(res.unwrap_err().code, AppErrorCode::InvalidInput));
    }

    #[tokio::test]
    async fn test_defaults_on_bad_json() {
        let db = setup_test_db().await;
        app_metadata_service::upsert_value(&db.conn, "speech_cloud_settings", "invalid json")
            .await
            .unwrap();
        let settings = get_settings_core(&db.conn).await;
        assert_eq!(settings.base_url, "https://api.openai.com/v1");
    }

    #[tokio::test]
    async fn test_key_tri_state() {
        let _guard = KEY_LOCK.lock().await;
        store::set_unreadable(false);
        let db = setup_test_db().await;
        let settings = SpeechCloudSettings::default();

        speech_update_settings_core(&db.conn, settings.clone(), Some("secret".to_string()))
            .await
            .unwrap();
        assert_eq!(
            store::get_secret(SPEECH_CLOUD_API_KEY).unwrap(),
            Some("secret".to_string())
        );

        let view = speech_update_settings_core(&db.conn, settings.clone(), None)
            .await
            .unwrap();
        assert!(view.api_key_set);
        assert_eq!(
            store::get_secret(SPEECH_CLOUD_API_KEY).unwrap(),
            Some("secret".to_string())
        );

        let view = speech_update_settings_core(&db.conn, settings.clone(), Some(String::new()))
            .await
            .unwrap();
        assert!(!view.api_key_set);
        assert_eq!(store::get_secret(SPEECH_CLOUD_API_KEY).unwrap(), None);
    }

    #[tokio::test]
    async fn test_unreadable_store_on_save_leaves_key_untouched() {
        let _guard = KEY_LOCK.lock().await;

        let db = setup_test_db().await;
        let settings = SpeechCloudSettings::default();
        store::set_unreadable(false);
        speech_update_settings_core(&db.conn, settings.clone(), Some("initial".to_string()))
            .await
            .unwrap();

        store::set_unreadable(true);
        let res =
            speech_update_settings_core(&db.conn, settings.clone(), Some("new-secret".to_string()))
                .await;
        assert!(res.is_err());

        store::set_unreadable(false);
        assert_eq!(
            store::get_secret(SPEECH_CLOUD_API_KEY).unwrap(),
            Some("initial".to_string())
        );
    }

    #[tokio::test]
    async fn test_transcribe_empty_audio() {
        let db = setup_test_db().await;
        let res =
            speech_transcribe_core(&db.conn, "".to_string(), "audio/wav".to_string(), None).await;
        assert!(res.is_err());
        assert!(matches!(res.unwrap_err().code, AppErrorCode::InvalidInput));
    }

    use axum::extract::Multipart;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::post;
    use axum::Router;
    use tokio::net::TcpListener;

    async fn mock_transcription_handler(
        headers: HeaderMap,
        mut multipart: Multipart,
    ) -> impl IntoResponse {
        if let Some(auth) = headers.get("authorization") {
            if auth != "Bearer test-key" {
                return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
            }
        } else {
            return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
        }

        let mut has_file = false;
        let mut model = String::new();
        let mut response_format = String::new();
        let mut language = None;

        while let Some(field) = multipart.next_field().await.unwrap() {
            let name = field.name().unwrap().to_string();
            if name == "file" {
                let filename = field.file_name().unwrap_or_default().to_string();
                if filename.starts_with("speech.") {
                    has_file = true;
                }
            } else if name == "model" {
                model = field.text().await.unwrap();
            } else if name == "response_format" {
                response_format = field.text().await.unwrap();
            } else if name == "language" {
                language = Some(field.text().await.unwrap());
            }
        }

        if !has_file || model != "whisper-1" || response_format != "json" {
            return (StatusCode::INTERNAL_SERVER_ERROR, "Bad request").into_response();
        }

        if let Some(lang) = language {
            if lang == "fr" {
                return (
                    StatusCode::OK,
                    axum::Json(serde_json::json!({ "text": "bonjour" })),
                )
                    .into_response();
            }
        }

        (
            StatusCode::OK,
            axum::Json(serde_json::json!({ "text": "hello from mock" })),
        )
            .into_response()
    }

    async fn start_mock_server() -> String {
        let app = Router::new().route("/v1/audio/transcriptions", post(mock_transcription_handler));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{}", addr)
    }

    #[tokio::test]
    async fn test_transcription_success() {
        let _guard = KEY_LOCK.lock().await;

        let db = setup_test_db().await;
        let base_url = start_mock_server().await;

        let settings = SpeechCloudSettings {
            base_url: format!("{}/v1", base_url),
            ..Default::default()
        };
        speech_update_settings_core(&db.conn, settings, Some("test-key".to_string()))
            .await
            .unwrap();

        let audio_base64 = base64::engine::general_purpose::STANDARD.encode(b"fake audio data");

        let res = speech_transcribe_core(&db.conn, audio_base64, "audio/wav".to_string(), None)
            .await
            .unwrap();
        assert_eq!(res, "hello from mock");
    }

    #[tokio::test]
    async fn test_transcription_language() {
        let _guard = KEY_LOCK.lock().await;

        let db = setup_test_db().await;
        let base_url = start_mock_server().await;

        let settings = SpeechCloudSettings {
            base_url: format!("{}/v1", base_url),
            ..Default::default()
        };
        speech_update_settings_core(&db.conn, settings, Some("test-key".to_string()))
            .await
            .unwrap();

        let audio_base64 = base64::engine::general_purpose::STANDARD.encode(b"fake audio data");

        let res = speech_transcribe_core(
            &db.conn,
            audio_base64,
            "audio/wav".to_string(),
            Some("fr-CA".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(res, "bonjour");
    }

    #[tokio::test]
    async fn test_transcription_unauthorized() {
        let _guard = KEY_LOCK.lock().await;

        let db = setup_test_db().await;
        let base_url = start_mock_server().await;

        let settings = SpeechCloudSettings {
            base_url: format!("{}/v1", base_url),
            ..Default::default()
        };
        speech_update_settings_core(&db.conn, settings, Some("wrong-key".to_string()))
            .await
            .unwrap();

        let audio_base64 = base64::engine::general_purpose::STANDARD.encode(b"fake audio data");

        let err = speech_transcribe_core(&db.conn, audio_base64, "audio/wav".to_string(), None)
            .await
            .unwrap_err();
        assert!(matches!(err.code, AppErrorCode::AuthenticationFailed));
    }

    #[tokio::test]
    async fn test_transcription_network_error() {
        let _guard = KEY_LOCK.lock().await;

        let db = setup_test_db().await;
        let base_url = start_mock_server().await;

        let settings = SpeechCloudSettings {
            base_url: format!("{}/v1", base_url),
            stt_model: "wrong-model".to_string(), // triggers 500 in mock
            ..Default::default()
        };
        speech_update_settings_core(&db.conn, settings, Some("test-key".to_string()))
            .await
            .unwrap();

        let audio_base64 = base64::engine::general_purpose::STANDARD.encode(b"fake audio data");

        let err = speech_transcribe_core(&db.conn, audio_base64, "audio/wav".to_string(), None)
            .await
            .unwrap_err();
        assert!(matches!(err.code, AppErrorCode::NetworkError));
    }
}
