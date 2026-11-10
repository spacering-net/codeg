//! Forge webhook deliveries: is this one genuine, what is it about, and which
//! repository is it for.
//!
//! Pure on purpose — the HTTP route that receives deliveries is unauthenticated
//! by necessity (no forge can send codeg's own bearer token), so the signature
//! check here IS the authentication, and it is tested on byte-exact payloads.
//!
//! A delivery is only ever a NUDGE. Nothing in its body is trusted beyond the
//! repository it names, which merely picks which folders to rescan; the scan
//! that follows reads every item from the forge's own API with the folder's own
//! credentials, exactly as a scheduled scan does. A forged or replayed delivery
//! that somehow verified could therefore do no more than make codeg look at a
//! repository a little earlier than it would have anyway.

use hmac::{Hmac, Mac};
use http::HeaderMap;
use sha2::Sha256;

use crate::forge::normalize_repo;

/// What a delivery is about, as far as auto-processing cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    /// GitHub's hello when a webhook is created — answered, not acted on.
    Ping,
    /// Something happened to an issue or a pull / merge request: opened,
    /// reopened, labelled, edited, marked ready… Any of them can make an item
    /// match the rules, so every one is worth a scan.
    WorkItem,
    /// Pushes, releases, comments and everything else.
    Other,
}

/// The event a delivery carries, by the header each forge names it in.
///
/// Gitea / Forgejo are read FIRST: for compatibility they also send
/// `X-GitHub-Event`, and their grouped event names (`issues`, `pull_request`)
/// are the ones to match. GitLab names its hooks in prose (`Issue Hook`).
pub fn classify(headers: &HeaderMap) -> (String, EventKind) {
    if let Some(event) = ["x-forgejo-event", "x-gitea-event", "x-gogs-event"]
        .into_iter()
        .find_map(|name| header(headers, name))
    {
        let kind = match event {
            "issues" | "pull_request" => EventKind::WorkItem,
            _ => EventKind::Other,
        };
        return (event.to_string(), kind);
    }
    if let Some(event) = header(headers, "x-gitlab-event") {
        let kind = match event {
            "Issue Hook" | "Confidential Issue Hook" | "Merge Request Hook" => EventKind::WorkItem,
            _ => EventKind::Other,
        };
        return (event.to_string(), kind);
    }
    if let Some(event) = header(headers, "x-github-event") {
        let kind = match event {
            "ping" => EventKind::Ping,
            "issues" | "pull_request" => EventKind::WorkItem,
            _ => EventKind::Other,
        };
        return (event.to_string(), kind);
    }
    (String::new(), EventKind::Other)
}

/// Whether `body` was signed with `secret`, by whichever scheme the delivery
/// uses:
///
/// - GitHub, and Gitea / Forgejo since they added it: `X-Hub-Signature-256:
///   sha256=<hex HMAC-SHA256 of the raw body>`;
/// - Gitea / Forgejo / Gogs on their own header: the same digest, bare hex;
/// - GitLab: no signature at all — `X-Gitlab-Token` carries the secret itself.
///
/// Every comparison is constant-time. An empty secret verifies nothing, and a
/// delivery with no recognizable signature is refused, never let through.
pub fn verify(headers: &HeaderMap, body: &[u8], secret: &str) -> bool {
    let secret = secret.trim();
    if secret.is_empty() {
        return false;
    }
    if let Some(token) = header(headers, "x-gitlab-token") {
        return constant_time_eq(token.as_bytes(), secret.as_bytes());
    }
    if let Some(signature) = header(headers, "x-hub-signature-256") {
        return signature
            .strip_prefix("sha256=")
            .is_some_and(|hex| hmac_matches(secret, body, hex));
    }
    [
        "x-forgejo-signature",
        "x-gitea-signature",
        "x-gogs-signature",
    ]
    .into_iter()
    .find_map(|name| header(headers, name))
    .is_some_and(|hex| hmac_matches(secret, body, hex))
}

/// The repository a delivery is about: `(server host, owner/repo)`, in the
/// same coordinates a folder's git remote parses into — which is what it is
/// matched against.
///
/// Two shapes, tried independently because GitLab payloads carry a
/// `repository` object too, just not this one: GitHub and Gitea send
/// `repository.full_name` + `repository.html_url`, GitLab sends
/// `project.path_with_namespace` + `project.web_url`. The host comes from the
/// web URL and the path from the dedicated field — a GitLab under a relative
/// URL root has the mount in its web URL but not in its path, which is exactly
/// how the folder's remote is normalized (`forge::strip_base_path`).
pub fn repository_of(payload: &serde_json::Value) -> Option<(String, String)> {
    let shape = |object: &str, path_field: &str, url_field: &str| {
        let node = payload.get(object)?;
        let path = node.get(path_field)?.as_str()?;
        let url = node.get(url_field)?.as_str()?;
        let host = url::Url::parse(url).ok()?.host_str()?.to_ascii_lowercase();
        Some((host, normalize_repo(path)?))
    };
    shape("repository", "full_name", "html_url")
        .or_else(|| shape("project", "path_with_namespace", "web_url"))
}

fn header<'h>(headers: &'h HeaderMap, name: &str) -> Option<&'h str> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn hmac_matches(secret: &str, body: &[u8], hex: &str) -> bool {
    let Some(expected) = decode_hex(hex.trim()) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&expected).is_ok()
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.is_empty() || !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(hex.get(at..at + 2)?, 16).ok())
        .collect()
}

/// Equal-length inputs are compared without an early exit. A length mismatch
/// returns at once — it says only how long the secret is, not what it is.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "It's a Secret to Everybody";
    const BODY: &[u8] = b"Hello, World!";
    /// GitHub's own documented example: this secret over this body.
    const GITHUB_EXAMPLE: &str = "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                http::header::HeaderName::from_bytes(name.as_bytes()).expect("header name"),
                value.parse().expect("header value"),
            );
        }
        map
    }

    /// The vector from GitHub's "Validating webhook deliveries" guide, so
    /// the digest is checked against the forge's own arithmetic rather than
    /// against this file's.
    #[test]
    fn a_github_signature_verifies_against_the_documented_example() {
        let signed = headers(&[("x-hub-signature-256", &format!("sha256={GITHUB_EXAMPLE}"))]);
        assert!(verify(&signed, BODY, SECRET));
        assert!(!verify(&signed, b"Hello, World?", SECRET), "a changed body");
        assert!(
            !verify(&signed, BODY, "another secret"),
            "a different secret"
        );
        // Uppercase hex is the same digest.
        let upper = headers(&[(
            "x-hub-signature-256",
            &format!("sha256={}", GITHUB_EXAMPLE.to_uppercase()),
        )]);
        assert!(verify(&upper, BODY, SECRET));
        // Without the scheme prefix it is not GitHub's format.
        let bare = headers(&[("x-hub-signature-256", GITHUB_EXAMPLE)]);
        assert!(!verify(&bare, BODY, SECRET));
    }

    /// Gitea / Forgejo put the same digest, bare, on their own header.
    #[test]
    fn a_gitea_signature_is_the_same_digest_without_the_prefix() {
        for name in [
            "x-gitea-signature",
            "x-forgejo-signature",
            "x-gogs-signature",
        ] {
            assert!(
                verify(&headers(&[(name, GITHUB_EXAMPLE)]), BODY, SECRET),
                "{name}"
            );
            assert!(
                !verify(&headers(&[(name, "deadbeef")]), BODY, SECRET),
                "{name}"
            );
        }
        // A Gitea with no secret configured still sends the header, empty.
        assert!(!verify(
            &headers(&[("x-gitea-signature", "")]),
            BODY,
            SECRET
        ));
    }

    #[test]
    fn a_gitlab_token_is_the_secret_itself() {
        assert!(verify(
            &headers(&[("x-gitlab-token", SECRET)]),
            BODY,
            SECRET
        ));
        assert!(!verify(
            &headers(&[("x-gitlab-token", "guess")]),
            BODY,
            SECRET
        ));
        assert!(!verify(
            &headers(&[("x-gitlab-token", "It's a Secret to Everybodx")]),
            BODY,
            SECRET
        ));
    }

    /// No signature at all is a refusal — never "nothing to check, so fine".
    #[test]
    fn an_unsigned_delivery_or_an_empty_secret_never_verifies() {
        assert!(!verify(&HeaderMap::new(), BODY, SECRET));
        assert!(!verify(
            &headers(&[("x-github-event", "issues")]),
            BODY,
            SECRET
        ));
        let signed = headers(&[("x-hub-signature-256", &format!("sha256={GITHUB_EXAMPLE}"))]);
        assert!(!verify(&signed, BODY, ""));
        assert!(!verify(&headers(&[("x-gitlab-token", "")]), BODY, ""));
    }

    #[test]
    fn events_are_classified_by_each_forges_own_header() {
        let gh = |event: &str| classify(&headers(&[("x-github-event", event)])).1;
        assert_eq!(gh("issues"), EventKind::WorkItem);
        assert_eq!(gh("pull_request"), EventKind::WorkItem);
        assert_eq!(gh("ping"), EventKind::Ping);
        assert_eq!(gh("push"), EventKind::Other);

        let gl = |event: &str| classify(&headers(&[("x-gitlab-event", event)])).1;
        assert_eq!(gl("Issue Hook"), EventKind::WorkItem);
        assert_eq!(gl("Confidential Issue Hook"), EventKind::WorkItem);
        assert_eq!(gl("Merge Request Hook"), EventKind::WorkItem);
        assert_eq!(gl("Push Hook"), EventKind::Other);

        // Gitea sends GitHub's header too; its own grouped name decides.
        let gitea = headers(&[
            ("x-gitea-event", "issues"),
            ("x-gitea-event-type", "issue_label"),
            ("x-github-event", "issues"),
        ]);
        assert_eq!(
            classify(&gitea),
            ("issues".to_string(), EventKind::WorkItem)
        );
        let gitea_push = headers(&[("x-gitea-event", "push"), ("x-github-event", "push")]);
        assert_eq!(classify(&gitea_push).1, EventKind::Other);

        assert_eq!(
            classify(&HeaderMap::new()),
            (String::new(), EventKind::Other)
        );
    }

    #[test]
    fn the_repository_comes_from_github_and_gitea_payloads() {
        let payload = serde_json::json!({
            "action": "opened",
            "issue": { "number": 7 },
            "repository": {
                "full_name": "Acme/App",
                "html_url": "https://GitHub.com/Acme/App",
            },
        });
        assert_eq!(
            repository_of(&payload),
            Some(("github.com".to_string(), "acme/app".to_string()))
        );
        // A self-hosted Gitea on a port: the host is the host, the port goes.
        let gitea = serde_json::json!({
            "repository": {
                "full_name": "team/tool",
                "html_url": "http://git.corp.test:3000/team/tool",
            },
        });
        assert_eq!(
            repository_of(&gitea),
            Some(("git.corp.test".to_string(), "team/tool".to_string()))
        );
    }

    /// GitLab sends a `repository` object too — without `full_name` — so the
    /// project shape must still be reached rather than given up on.
    #[test]
    fn the_repository_comes_from_a_gitlab_payload_with_subgroups() {
        let payload = serde_json::json!({
            "object_kind": "issue",
            "project": {
                "path_with_namespace": "Group/Sub/Proj",
                "web_url": "https://gitlab.corp.test/gitlab/Group/Sub/Proj",
            },
            "repository": { "name": "Proj", "url": "git@gitlab.corp.test:group/sub/proj.git" },
        });
        assert_eq!(
            repository_of(&payload),
            Some(("gitlab.corp.test".to_string(), "group/sub/proj".to_string()))
        );
    }

    #[test]
    fn a_payload_without_a_usable_repository_names_none() {
        assert_eq!(repository_of(&serde_json::json!({})), None);
        assert_eq!(
            repository_of(&serde_json::json!({ "repository": { "full_name": "a/b" } })),
            None,
            "no URL, no host"
        );
        assert_eq!(
            repository_of(&serde_json::json!({
                "repository": { "full_name": "no slash here", "html_url": "https://github.com/x" }
            })),
            None,
            "a path that is not a repository"
        );
    }
}
