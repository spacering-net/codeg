//! Browsing the catalog: what the Discover section shows.
//!
//! JSON goes through as the API wrote it — no struct in between, so a field
//! or an enumeration value this Codeg has never heard of reaches the frontend
//! untouched (the frontend's types are generated from the API's OpenAPI
//! document). What is checked is only that the answer is the kind of thing
//! asked for: JSON of the expected outer shape, HTML, text, a picture — and,
//! for a package's file read by its hash, that it hashes to it.
//!
//! An item address, an image path and a file's hash are validated before
//! anything is sent, and are then the only thing of the caller's that
//! reaches the URL's path.
//!
//! Everything here is for display. See `cache.rs` for why none of it may
//! decide an install.

use serde::Deserialize;
use serde_json::Value;

use super::client::Expect;
use super::error::HarnessError;
use super::Harness;

/// The API's own prefix on the origin.
pub(crate) const API_PREFIX: &str = "/api/harness/v1";

/// The two places on SpaceRing a picture is fetched from: publishers'
/// avatars, and the catalog's own media (a prompt's cover).
const ASSET_PREFIXES: [&str; 2] = ["/api/avatars/", "/api/harness/v1/media/"];

/// Longer than any picture's address (a media file is 64 hex digits and an
/// extension), short enough to keep nonsense out of a URL.
const MAX_ASSET_PATH_BYTES: usize = 256;

/// The API's own limits on a list query's values, in UTF-16 units as it
/// counts them (`api/harness/routes.ts`).
const MAX_Q: usize = 200;
const MAX_KIND: usize = 20;
const MAX_TAG: usize = 40;
const MAX_RUNTIME: usize = 20;
const MAX_SORT: usize = 20;
const MAX_CURSOR: usize = 500;

/// An item's address, `publisher/name`: publisher `[a-z0-9][a-z0-9.-]{0,252}`,
/// name `[a-z0-9-]{1,64}`. Neither part can be `.` or `..`, hold a slash, or
/// need escaping, so both go into a URL's path as they are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemRef {
    publisher: String,
    name: String,
}

impl ItemRef {
    pub fn parse(raw: &str) -> Result<Self, HarnessError> {
        let (publisher, name) = raw.split_once('/').ok_or(HarnessError::InvalidRef)?;
        let lower_or_digit = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
        let publisher_ok = (1..=253).contains(&publisher.len())
            && publisher.bytes().next().is_some_and(lower_or_digit)
            && publisher
                .bytes()
                .all(|byte| lower_or_digit(byte) || byte == b'.' || byte == b'-');
        let name_ok = (1..=64).contains(&name.len())
            && name
                .bytes()
                .all(|byte| lower_or_digit(byte) || byte == b'-');
        if !publisher_ok || !name_ok {
            return Err(HarnessError::InvalidRef);
        }
        Ok(Self {
            publisher: publisher.to_string(),
            name: name.to_string(),
        })
    }

    pub fn publisher(&self) -> &str {
        &self.publisher
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The item's own address under the API, with `rest` after it.
    pub(crate) fn api_path(&self, rest: &str) -> String {
        format!("{API_PREFIX}/items/{}/{}{rest}", self.publisher, self.name)
    }
}

impl std::fmt::Display for ItemRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.publisher, self.name)
    }
}

/// A picture's path on SpaceRing, checked: under one of the two prefixes,
/// made of plain segments (letters, digits, `.`, `-`, `_`), none of them
/// empty or starting with a dot. That leaves no `..`, no query, no fragment,
/// no escape and no second host to slip through.
pub(crate) fn validate_asset_path(path: &str) -> Result<&str, HarnessError> {
    let rest = ASSET_PREFIXES
        .iter()
        .find_map(|prefix| path.strip_prefix(prefix))
        .ok_or(HarnessError::InvalidRef)?;
    let plain = |segment: &str| {
        !segment.is_empty()
            && !segment.starts_with('.')
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    };
    if path.len() > MAX_ASSET_PATH_BYTES || !rest.split('/').all(plain) {
        return Err(HarnessError::InvalidRef);
    }
    Ok(path)
}

/// A file's address on SpaceRing: its SHA-256, as exactly 64 lowercase
/// hexadecimal digits — which is also all that may reach the URL.
pub(crate) fn validate_sha256(sha256: &str) -> Result<&str, HarnessError> {
    let hex = |byte: u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte);
    if sha256.len() == 64 && sha256.bytes().all(hex) {
        Ok(sha256)
    } else {
        Err(HarnessError::InvalidRef)
    }
}

/// What to list. Every value is optional; an absent one and an empty one
/// mean the same.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct ListQuery {
    /// Search text. Without it the catalog is browsed in `sort` order.
    pub q: Option<String>,
    /// `skill`, `mcp`, `prompt`, `assistant` or `plugin`.
    pub kind: Option<String>,
    pub tag: Option<String>,
    pub runtime: Option<String>,
    /// `popular`, `new` or `updated`.
    pub sort: Option<String>,
    /// The `next` of the page before.
    pub cursor: Option<String>,
}

impl ListQuery {
    /// The query's pairs in one fixed order, trimmed, without the empty ones:
    /// the same question always makes the same URL, here in the cache and at
    /// the site's edge.
    ///
    /// What a value may be is the API's to say (an unknown `kind` is answered
    /// 400 there). Only its length is checked here, against the API's own
    /// limits, so that nothing unbounded goes into a URL: a value over its
    /// limit is refused as the API would refuse it, without the round trip.
    fn pairs(&self) -> Result<Vec<(&'static str, &str)>, HarnessError> {
        let mut pairs = Vec::new();
        for (name, value, limit) in [
            ("q", &self.q, MAX_Q),
            ("kind", &self.kind, MAX_KIND),
            ("tag", &self.tag, MAX_TAG),
            ("runtime", &self.runtime, MAX_RUNTIME),
            ("sort", &self.sort, MAX_SORT),
            ("cursor", &self.cursor, MAX_CURSOR),
        ] {
            let Some(value) = value.as_deref().map(str::trim).filter(|v| !v.is_empty()) else {
                continue;
            };
            if value.encode_utf16().count() > limit {
                return Err(HarnessError::Server { status: 400 });
            }
            pairs.push((name, value));
        }
        Ok(pairs)
    }
}

/// A picture, as fetched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    /// `image/webp`, `image/png`, `image/jpeg` or `image/gif`.
    pub mime: String,
    pub bytes: Vec<u8>,
}

impl Harness {
    /// `GET /config`: the lists the filters are built from, and the limits a
    /// package is checked against before it is installed.
    pub async fn config(&self) -> Result<Value, HarnessError> {
        self.ensure_enabled()?;
        let config = self.json(&format!("{API_PREFIX}/config"), &[]).await?;
        object(config, "/config")
    }

    /// `GET /items`: a page of items, `{ items, next, approxTotal }`.
    pub async fn list(&self, query: &ListQuery) -> Result<Value, HarnessError> {
        self.ensure_enabled()?;
        let pairs = query.pairs()?;
        let page = object(
            self.json(&format!("{API_PREFIX}/items"), &pairs).await?,
            "/items",
        )?;
        if !page.get("items").is_some_and(Value::is_array) {
            return Err(HarnessError::invalid_response("/items has no items"));
        }
        Ok(page)
    }

    /// `GET /items/{publisher}/{name}`: one item.
    pub async fn item(&self, item_ref: &str) -> Result<Value, HarnessError> {
        self.ensure_enabled()?;
        let item_ref = ItemRef::parse(item_ref)?;
        object(self.json(&item_ref.api_path(""), &[]).await?, "an item")
    }

    /// The `versions` array of `GET /items/{ref}/versions`, newest first.
    pub async fn versions(&self, item_ref: &str) -> Result<Value, HarnessError> {
        self.ensure_enabled()?;
        let item_ref = ItemRef::parse(item_ref)?;
        let mut answer = self.json(&item_ref.api_path("/versions"), &[]).await?;
        match answer.get_mut("versions").map(Value::take) {
            Some(versions @ Value::Array(_)) => Ok(versions),
            _ => Err(HarnessError::invalid_response("/versions has no versions")),
        }
    }

    /// The `releases` array of `GET /items/{ref}/releases` (plugins only),
    /// newest first.
    pub async fn releases(&self, item_ref: &str) -> Result<Value, HarnessError> {
        self.ensure_enabled()?;
        let item_ref = ItemRef::parse(item_ref)?;
        let mut answer = self.json(&item_ref.api_path("/releases"), &[]).await?;
        match answer.get_mut("releases").map(Value::take) {
            Some(releases @ Value::Array(_)) => Ok(releases),
            _ => Err(HarnessError::invalid_response("/releases has no releases")),
        }
    }

    /// An item's description: the sanitized HTML fragment, as text. `None`
    /// when the item has none.
    ///
    /// The API answers 404 both for an item without a description and for no
    /// such item, and this cannot tell them apart: both are `None`. A missing
    /// item is [`Harness::item`]'s to report.
    ///
    /// Sanitized by SpaceRing or not, the fragment is third-party markup: the
    /// frontend never inserts it as HTML.
    pub async fn readme(&self, item_ref: &str) -> Result<Option<String>, HarnessError> {
        self.ensure_enabled()?;
        let item_ref = ItemRef::parse(item_ref)?;
        let url = self.origin.join(&item_ref.api_path("/readme"))?;
        match self
            .fetch(&url, Expect::Html, self.limits.readme_bytes)
            .await
        {
            Ok((_, body)) => text(body, "a description").map(Some),
            Err(HarnessError::NotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// A prompt's text, as it is to be used. Prompts only: anything else is
    /// not found.
    pub async fn prompt(&self, item_ref: &str) -> Result<String, HarnessError> {
        self.ensure_enabled()?;
        let item_ref = ItemRef::parse(item_ref)?;
        let url = self.origin.join(&item_ref.api_path("/prompt"))?;
        let (_, body) = self
            .fetch(&url, Expect::Text, self.limits.prompt_bytes)
            .await?;
        text(body, "a prompt")
    }

    /// One file of a package, by its SHA-256, as UTF-8 text: what "copy the
    /// definition" (an assistant) and "copy the prompt file" copy. At most
    /// 256 KiB (`Limits::blob_bytes`).
    ///
    /// The file is served from its copy whenever there is one: its address
    /// is its hash, so it cannot have changed (see `Harness::fetch_by_hash`).
    pub async fn blob(&self, sha256: &str) -> Result<String, HarnessError> {
        self.ensure_enabled()?;
        let sha256 = validate_sha256(sha256)?;
        let url = self.origin.join(&format!("{API_PREFIX}/blobs/{sha256}"))?;
        let body = self
            .fetch_by_hash(&url, sha256, self.limits.blob_bytes)
            .await?;
        text(body, "a file")
    }

    /// A picture kept on SpaceRing — a publisher's avatar, a prompt's cover —
    /// by the site-relative path the catalog gave for it.
    pub async fn asset(&self, path: &str) -> Result<Asset, HarnessError> {
        self.ensure_enabled()?;
        let url = self.origin.join(validate_asset_path(path)?)?;
        let (mime, bytes) = self
            .fetch(&url, Expect::Image, self.limits.asset_bytes)
            .await?;
        Ok(Asset { mime, bytes })
    }

    /// GETs a JSON answer from a path Codeg wrote, with `query` appended.
    pub(crate) async fn json(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<Value, HarnessError> {
        let mut url = self.origin.join(path)?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let (_, body) = self
            .fetch(&url, Expect::Json, self.limits.json_bytes)
            .await?;
        serde_json::from_slice(&body)
            .map_err(|error| HarnessError::invalid_response(format!("not JSON: {error}")))
    }
}

fn object(value: Value, what: &str) -> Result<Value, HarnessError> {
    if value.is_object() {
        Ok(value)
    } else {
        Err(HarnessError::invalid_response(format!(
            "{what} is not a JSON object"
        )))
    }
}

fn text(body: Vec<u8>, what: &str) -> Result<String, HarnessError> {
    String::from_utf8(body)
        .map_err(|_| HarnessError::invalid_response(format!("{what} is not UTF-8 text")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_item_address_is_publisher_slash_name() {
        for good in [
            "anthropics/pdf",
            "a/b",
            "0x/1",
            "example.com/notes-mcp",
            "sub.example.co.uk/a-b-c",
            "a-b.c/x",
            "a../b",
        ] {
            let parsed = ItemRef::parse(good).unwrap_or_else(|_| panic!("{good} was refused"));
            assert_eq!(parsed.to_string(), good);
        }
        let parsed = ItemRef::parse("example.com/notes").unwrap();
        assert_eq!(parsed.publisher(), "example.com");
        assert_eq!(parsed.name(), "notes");
        assert_eq!(
            parsed.api_path("/versions"),
            "/api/harness/v1/items/example.com/notes/versions"
        );

        let longest = format!("{}/{}", "a".repeat(253), "b".repeat(64));
        assert!(ItemRef::parse(&longest).is_ok());
    }

    #[test]
    fn anything_else_is_not_an_item_address() {
        let too_long_publisher = format!("{}/b", "a".repeat(254));
        let too_long_name = format!("a/{}", "b".repeat(65));
        for bad in [
            "",
            "/",
            "pdf",
            "anthropics/",
            "/pdf",
            "anthropics/pdf/",
            "anthropics/pdf/versions",
            "anthropics//pdf",
            "Anthropics/pdf",
            "anthropics/PDF",
            "anthropics/pdf.v2",
            "anthropics/pdf_v2",
            ".anthropics/pdf",
            "-anthropics/pdf",
            "./pdf",
            "../pdf",
            "anthropics/..",
            "anthropics/.",
            "anthropics/pdf?x=1",
            "anthropics/pdf#x",
            "anthropics/p df",
            " anthropics/pdf",
            "anthropics/pdf ",
            "anthropics/pdf\n",
            "anthropics/%2e%2e",
            "anthropics\\pdf",
            "https://elsewhere.example/pdf",
            "ａnthropics/pdf",
            "anthropics/pdƒ",
            too_long_publisher.as_str(),
            too_long_name.as_str(),
        ] {
            assert_eq!(
                ItemRef::parse(bad),
                Err(HarnessError::InvalidRef),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_picture_s_path_is_under_one_of_two_prefixes() {
        for good in [
            "/api/avatars/0199b5e2-6c4f-7d1a-9f2e-3c8a1b5d7e90/4f1c2a9e8b7d6c5a.png",
            "/api/avatars/u/a.jpg",
            "/api/harness/v1/media/9f2c0d1e9f2c0d1e9f2c0d1e9f2c0d1e9f2c0d1e9f2c0d1e9f2c0d1e9f2c0d1e.webp",
            "/api/harness/v1/media/a_b-c.gif",
        ] {
            assert_eq!(validate_asset_path(good), Ok(good), "{good}");
        }
    }

    #[test]
    fn no_other_path_is_fetched() {
        let too_long = format!("/api/avatars/{}.png", "a".repeat(MAX_ASSET_PATH_BYTES));
        for bad in [
            "",
            "/",
            "/api/avatars",
            "/api/avatars/",
            "/api/harness/v1/media/",
            "api/avatars/u/a.png",
            // other parts of the site, and of the API
            "/api/me",
            "/api/auth/session",
            "/api/harness/v1/items",
            "/api/harness/v1/archives/9f2c.zip",
            "/api/harness/v1/mediaX/a.png",
            "/api/avatarsX/a.png",
            "/API/AVATARS/u/a.png",
            // leaving the prefix
            "/api/avatars/../me",
            "/api/avatars/u/../../me",
            "/api/avatars/./a.png",
            "/api/avatars/u/..",
            "/api/avatars/.hidden",
            "/api/avatars/%2e%2e/me",
            "/api/avatars/..%2fme",
            "/api/avatars/u//a.png",
            "/api/avatars/u/a.png/",
            "/api/avatars/u\\..\\..\\me",
            "/api/harness/v1/media/../items",
            // a query or a fragment
            "/api/avatars/u/a.png?size=9999",
            "/api/avatars/u/a.png?redirect=https://elsewhere.example",
            "/api/avatars/u/a.png#x",
            "/api/avatars/u/a.png;x",
            // another host
            "https://spacering.net/api/avatars/u/a.png",
            "https://elsewhere.example/api/avatars/u/a.png",
            "//elsewhere.example/api/avatars/u/a.png",
            "/api/avatars/@elsewhere.example/a.png",
            "/api/avatars/u:a@elsewhere.example",
            // not plain
            "/api/avatars/u/a b.png",
            "/api/avatars/u/a\n.png",
            "/api/avatars/u/a\u{0}.png",
            "/api/avatars/u/ä.png",
            " /api/avatars/u/a.png",
            too_long.as_str(),
        ] {
            assert_eq!(
                validate_asset_path(bad),
                Err(HarnessError::InvalidRef),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_file_s_address_is_its_hash_in_lowercase_hex() {
        for good in ["9f2c0d1e".repeat(8), "0123456789abcdef".repeat(4)] {
            assert_eq!(validate_sha256(&good), Ok(good.as_str()));
        }
        let a = |count: usize| "a".repeat(count);
        for bad in [
            String::new(),
            "9f2c".to_string(),
            a(63),
            a(65),
            "9F2C0D1E".repeat(8),
            "9f2c0d1E".repeat(8),
            format!("{}g", a(63)),
            format!("{}é", a(62)),
            format!(" {}", a(63)),
            format!("{}\n", a(63)),
            format!("../{}", a(61)),
            format!("{}/x", a(62)),
            format!("{}?x", a(62)),
            format!("{}#x", a(62)),
            format!("%2e{}", a(61)),
            format!("sha256:{}", a(57)),
        ] {
            assert_eq!(
                validate_sha256(&bad),
                Err(HarnessError::InvalidRef),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_query_is_its_set_values_in_one_order() {
        assert!(ListQuery::default().pairs().unwrap().is_empty());
        let query = ListQuery {
            q: Some("  pdf forms ".into()),
            kind: Some("skill".into()),
            tag: Some("".into()),
            runtime: Some("   ".into()),
            sort: Some("popular".into()),
            cursor: None,
        };
        assert_eq!(
            query.pairs().unwrap(),
            [("q", "pdf forms"), ("kind", "skill"), ("sort", "popular")]
        );
        // a value the API may come to know is the API's to judge
        let later = ListQuery {
            kind: Some("connector".into()),
            sort: Some("trending".into()),
            ..ListQuery::default()
        };
        assert_eq!(
            later.pairs().unwrap(),
            [("kind", "connector"), ("sort", "trending")]
        );
    }

    #[test]
    fn a_value_over_the_api_s_limit_is_refused_as_the_api_would() {
        let at = |length: usize| "x".repeat(length);
        assert!(ListQuery {
            q: Some(at(200)),
            cursor: Some(at(500)),
            tag: Some(at(40)),
            runtime: Some(at(20)),
            ..ListQuery::default()
        }
        .pairs()
        .is_ok());
        for over in [
            ListQuery {
                q: Some(at(201)),
                ..ListQuery::default()
            },
            ListQuery {
                kind: Some(at(21)),
                ..ListQuery::default()
            },
            ListQuery {
                tag: Some(at(41)),
                ..ListQuery::default()
            },
            ListQuery {
                runtime: Some(at(21)),
                ..ListQuery::default()
            },
            ListQuery {
                sort: Some(at(21)),
                ..ListQuery::default()
            },
            ListQuery {
                cursor: Some(at(501)),
                ..ListQuery::default()
            },
        ] {
            assert_eq!(over.pairs(), Err(HarnessError::Server { status: 400 }));
        }
        // counted as the API counts: a character outside the BMP is two
        assert!(ListQuery {
            q: Some("𝒳".repeat(100)),
            ..ListQuery::default()
        }
        .pairs()
        .is_ok());
        assert!(ListQuery {
            q: Some("𝒳".repeat(101)),
            ..ListQuery::default()
        }
        .pairs()
        .is_err());
    }

    #[test]
    fn a_query_reads_the_arguments_the_frontend_sends() {
        let query: ListQuery = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(query, ListQuery::default());
        let query: ListQuery = serde_json::from_value(serde_json::json!({
            "q": "pdf", "kind": "mcp", "tag": "docs", "runtime": "node",
            "sort": "new", "cursor": "abc", "somethingLater": 1, "limit": 100
        }))
        .unwrap();
        assert_eq!(query.q.as_deref(), Some("pdf"));
        assert_eq!(query.kind.as_deref(), Some("mcp"));
        assert_eq!(query.tag.as_deref(), Some("docs"));
        assert_eq!(query.runtime.as_deref(), Some("node"));
        assert_eq!(query.sort.as_deref(), Some("new"));
        assert_eq!(query.cursor.as_deref(), Some("abc"));
        let query: ListQuery = serde_json::from_value(serde_json::json!({ "q": null })).unwrap();
        assert_eq!(query.q, None);
    }
}
