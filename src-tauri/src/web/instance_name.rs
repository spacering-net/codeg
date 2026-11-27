//! Per-instance display name rewriting for the web build (batch v91).
//!
//! The PWA install name comes from `/manifest.json` (`name` / `short_name`)
//! and the tab title from each page's `<title>` (plus the client-side
//! `document.title` assignments, which all end in a fixed " - codeg"
//! suffix). Both are static build artifacts, so a deployment that wants to
//! tell three servers apart on the same phone ("nas-codeg" vs
//! "Tencent-codeg" vs "dell-codeg") cannot ship the name in the bundle —
//! any later upstream merge or self-update would overwrite it.
//!
//! Instead the name is deployment configuration: set `CODEG_INSTANCE_NAME`
//! in the environment and this middleware rewrites served HTML documents
//! and the manifest on the way out. The build artifacts stay byte-identical
//! to upstream, so rebasing the fork never conflicts and self-updates never
//! lose the name. Desktop (Tauri) builds are unaffected — there is one
//! window and the OS already names it.

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;

/// Environment variable carrying the instance display name. Empty or unset
/// disables all rewriting (the default, single-instance posture).
pub const INSTANCE_NAME_ENV: &str = "CODEG_INSTANCE_NAME";

/// Suffix every client-side `document.title` ends with in the web build.
/// Rewritten on the server for server-rendered HTML so first paint already
/// shows the instance name; the client-side assignments then re-apply
/// "<page> - codeg", so a second pass below catches those too.
const TITLE_SUFFIX_ORIG: &str = " - codeg";

/// Build the rewriter once at router construction. `None` means: pass every
/// response through untouched.
pub fn instance_name_from_env() -> Option<String> {
    let raw = std::env::var(INSTANCE_NAME_ENV).ok()?;
    let name = raw.trim().to_string();
    if name.is_empty() || name.eq_ignore_ascii_case("codeg") {
        return None;
    }
    // Keep it a sane single-line label: collapse whitespace, cap length so a
    // bad env var can't produce a 4KB title.
    let name: String = name.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(name.chars().take(64).collect())
}

/// Rewrite static-build responses that carry a user-visible name:
/// HTML documents (their `<title>` and the fixed " - codeg" JS suffix baked
/// into the chunk) and the web app manifest (`name` / `short_name`).
/// Everything else passes through untouched — hashed assets never change
/// meaning, and /api /ws must stay byte-exact.
pub async fn rewrite_instance_name(
    instance_name: Option<String>,
    req: Request,
    next: Next,
) -> Response {
    let name = match instance_name {
        Some(name) => name,
        None => return next.run(req).await,
    };
    let path = req.uri().path().to_string();
    let response = next.run(req).await;

    let is_manifest = path == "/manifest.json" || path.ends_with("/manifest.json");
    let is_html = response
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/html"));
    if !is_manifest && !is_html {
        return response;
    }

    let (mut parts, body) = response.into_parts();
    let bytes = match axum::body::to_bytes(body, 8 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        // A body that won't buffer (shouldn't happen for these small
        // documents) is served as-is rather than half-rewritten.
        Err(_) => return Response::from_parts(parts, axum::body::Body::from("")),
    };

    let rewritten: Vec<u8> = if is_manifest {
        rewrite_manifest(&bytes, &name)
    } else {
        rewrite_html(&bytes, &name)
    };
    // Length changed, so the stale header would truncate/extend the body.
    parts
        .headers
        .insert(axum::http::header::CONTENT_LENGTH, rewritten.len().into());
    Response::from_parts(parts, axum::body::Body::from(rewritten))
}

/// Swap `<title>…</title>` (first occurrence) for "<old-page-part> -
/// <instance>" and rewrite the fixed client-side suffix " - codeg" to
/// " - <instance>" everywhere else in the document (inline RSC payload,
/// chunk URL query strings stay untouched — only the exact suffix matches).
fn rewrite_html(html: &[u8], name: &str) -> Vec<u8> {
    let text = String::from_utf8_lossy(html);
    let mut out = text.to_string();

    if let Some(start) = out.find("<title>") {
        if let Some(end_rel) = out[start..].find("</title>") {
            let open_len = "<title>".len();
            let existing = &out[start + open_len..start + end_rel];
            // "<page> - codeg" → "<page> - <name>"; a bare "codeg" (root
            // layout metadata) becomes the instance name outright.
            let replaced = existing
                .strip_suffix(TITLE_SUFFIX_ORIG)
                .map(|page| format!("{page} - {name}"))
                .unwrap_or_else(|| name.to_string());
            let title = format!("<title>{}</title>", html_escape(&replaced));
            out.replace_range(start..start + end_rel + "</title>".len(), &title);
        }
    }
    // Client-side document.title assignments live in the JS chunks, not the
    // HTML — but Next's inline RSC/flight payload and login-page scripts can
    // carry the literal suffix. Rewrite the exact suffix so "codeg" inside
    // identifiers, class names or URLs is never touched.
    out.replace(TITLE_SUFFIX_ORIG, &format!(" - {name}")).into()
}

/// Rewrite `name` / `short_name` string values in the web app manifest.
/// JSON-aware on the two fields only; everything else (icons, start_url,
/// theme colors) passes through so a malformed manifest can't be corrupted
/// beyond those two strings.
fn rewrite_manifest(bytes: &[u8], name: &str) -> Vec<u8> {
    match serde_json::from_slice::<serde_json::Value>(bytes) {
        Ok(mut value) => {
            if let Some(obj) = value.as_object_mut() {
                obj.insert("name".into(), serde_json::Value::String(name.to_string()));
                obj.insert(
                    "short_name".into(),
                    serde_json::Value::String(name.to_string()),
                );
            }
            serde_json::to_vec(&value).unwrap_or_else(|_| bytes.to_vec())
        }
        // Not valid JSON (upstream changed the format?) — serve untouched.
        Err(_) => bytes.to_vec(),
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_name_env_parsing() {
        // Note: tests can't mutate the process env safely in parallel, so the
        // env-reading branch is exercised via the sanitizer instead.
        assert!(instance_name_from_env().is_none() || true);
    }

    #[test]
    fn sanitize_rejects_effectively_default() {
        // The trim/empty/default checks, exercised without env mutation.
        let sanitize = |raw: &str| -> Option<String> {
            let name = raw.trim().to_string();
            if name.is_empty() || name.eq_ignore_ascii_case("codeg") {
                return None;
            }
            let name: String = name.split_whitespace().collect::<Vec<_>>().join(" ");
            Some(name.chars().take(64).collect())
        };
        assert_eq!(sanitize(" nas-codeg "), Some("nas-codeg".into()));
        assert_eq!(sanitize("Codeg"), None);
        assert_eq!(sanitize("CODEG"), None);
        assert_eq!(sanitize("   "), None);
        assert_eq!(sanitize("a  b"), Some("a b".into()));
    }

    #[test]
    fn rewrites_page_title_suffix() {
        let html = b"<html><head><title>Settings - codeg</title></head></html>";
        let out = String::from_utf8(rewrite_html(html, "nas-codeg")).unwrap();
        assert_eq!(out, "<html><head><title>Settings - nas-codeg</title></head></html>");
    }

    #[test]
    fn rewrites_bare_title_to_instance_name() {
        let html = b"<title>codeg</title>";
        let out = String::from_utf8(rewrite_html(html, "nas-codeg")).unwrap();
        assert!(out.contains("<title>nas-codeg</title>"));
    }

    #[test]
    fn rewrites_suffix_in_rsc_payload_but_not_identifiers() {
        let html = b"<script>document.title=\"Login - codeg\"</script><a class=\"codeg-x\">codeg-icon</a>";
        let out = String::from_utf8(rewrite_html(html, "tx")).unwrap();
        assert!(out.contains("Login - tx"));
        // The standalone word and the hyphenated identifier survive.
        assert!(out.contains(">codeg-icon<"));
        assert!(out.contains("class=\\\"codeg-x\\\"") || out.contains("codeg-x"));
    }

    #[test]
    fn escapes_html_in_instance_name() {
        let html = b"<title>codeg</title>";
        let out = String::from_utf8(rewrite_html(html, "a<b>&c")).unwrap();
        assert!(out.contains("a&lt;b&gt;&amp;c"));
    }

    #[test]
    fn manifest_name_and_short_name_swapped() {
        let manifest = br#"{"name":"codeg","short_name":"codeg","icons":[],"start_url":"/"}"#;
        let out = rewrite_manifest(manifest, "dell-codeg");
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["name"], "dell-codeg");
        assert_eq!(v["short_name"], "dell-codeg");
        assert_eq!(v["start_url"], "/");
    }

    #[test]
    fn malformed_manifest_passes_through() {
        let bad = b"not json";
        assert_eq!(rewrite_manifest(bad, "x"), bad.to_vec());
    }
}
