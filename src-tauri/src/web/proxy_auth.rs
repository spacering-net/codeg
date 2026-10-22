//! Opt-in authentication by an identity-aware proxy's signed assertion.
//!
//! With `CODEG_AUTH=proxy-jwt`, a request is also let in when a header set by
//! a proxy in front of Codeg (Cloudflare Access sends `Cf-Access-Jwt-Assertion`)
//! holds a JWT whose signature verifies against the proxy's published keys
//! (JWKS) and whose `iss`, `aud`, `exp` and `nbf` match. The browser then needs
//! no Codeg token: the proxy's login is the login. The token keeps working for
//! every other client (`codeg-cli --url`, scripts).
//!
//! Why a signature check and not "trust the header": anything that can reach
//! the listener — any local process when Codeg is bound to loopback — can set
//! a header, but cannot forge the proxy's signature.
//!
//! Fail closed throughout: an incomplete configuration refuses to start the
//! server, and a missing header, an unreachable JWKS with no cached key, an
//! unknown key id, an algorithm other than RS256/ES256 or any claim mismatch
//! rejects the request (the caller answers 401).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::http::{HeaderMap, HeaderName};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::signature::{self, RsaPublicKeyComponents, UnparsedPublicKey};
use serde_json::{Map, Value};
use tokio::sync::{Mutex, RwLock};

pub const AUTH_MODE_VAR: &str = "CODEG_AUTH";
pub const AUTH_MODE_PROXY_JWT: &str = "proxy-jwt";
pub const HEADER_VAR: &str = "CODEG_PROXY_AUTH_HEADER";
pub const JWKS_URL_VAR: &str = "CODEG_PROXY_AUTH_JWKS_URL";
pub const ISSUER_VAR: &str = "CODEG_PROXY_AUTH_ISSUER";
pub const AUDIENCE_VAR: &str = "CODEG_PROXY_AUTH_AUDIENCE";

/// A real assertion is about 1 KB; the bound only caps the work an
/// oversized header can cause before it is rejected.
const MAX_ASSERTION_LEN: usize = 16 * 1024;
/// Tolerated clock skew between the proxy and this host for `exp` / `nbf`.
const CLOCK_LEEWAY_SECS: f64 = 60.0;
/// Keys are re-fetched at most this old, so a rotation is picked up even
/// when every request names a key id that is still cached.
const KEYS_MAX_AGE: Duration = Duration::from_secs(60 * 60);
/// At most one JWKS fetch per interval: an assertion naming an unknown key id
/// triggers a refresh, and must not let a caller turn that into a request flood
/// against the proxy's key endpoint.
const MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const JWKS_FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_JWKS_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyAuthConfig {
    pub header: HeaderName,
    pub jwks_url: reqwest::Url,
    pub issuer: String,
    pub audience: String,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("{AUTH_MODE_VAR}={0:?} is not a known mode (expected \"token\" or \"{AUTH_MODE_PROXY_JWT}\")")]
    UnknownMode(String),
    #[error("{AUTH_MODE_VAR}={AUTH_MODE_PROXY_JWT} needs {0} to be set")]
    Missing(&'static str),
    #[error("{0} is set but {AUTH_MODE_VAR} is not {AUTH_MODE_PROXY_JWT}; set it, or unset {0}")]
    WithoutMode(&'static str),
    #[error("{HEADER_VAR}={0:?} is not a valid header name")]
    BadHeader(String),
    #[error("{JWKS_URL_VAR}={0:?} must be an https URL (http only for a loopback host)")]
    BadJwksUrl(String),
}

impl ProxyAuthConfig {
    /// Reads the configuration from the environment. `Ok(None)` is token-only
    /// authentication, as before this mode existed.
    pub fn from_env() -> Result<Option<Self>, ConfigError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, ConfigError> {
        let value = |name: &str| {
            get(name)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let mode = value(AUTH_MODE_VAR);
        match mode.as_deref() {
            None | Some("token") => {
                // A proxy setting without the mode would leave the operator
                // believing the proxy's login is enough while every request
                // without the token gets 401: say so at startup instead.
                for name in [HEADER_VAR, JWKS_URL_VAR, ISSUER_VAR, AUDIENCE_VAR] {
                    if value(name).is_some() {
                        return Err(ConfigError::WithoutMode(name));
                    }
                }
                return Ok(None);
            }
            Some(AUTH_MODE_PROXY_JWT) => {}
            Some(other) => return Err(ConfigError::UnknownMode(other.to_string())),
        }
        let require = |name: &'static str| value(name).ok_or(ConfigError::Missing(name));
        let header_raw = require(HEADER_VAR)?;
        let header = HeaderName::try_from(header_raw.as_str())
            .map_err(|_| ConfigError::BadHeader(header_raw.clone()))?;
        let url_raw = require(JWKS_URL_VAR)?;
        let jwks_url = reqwest::Url::parse(&url_raw)
            .ok()
            .filter(jwks_url_allowed)
            .ok_or_else(|| ConfigError::BadJwksUrl(url_raw.clone()))?;
        Ok(Some(Self {
            header,
            jwks_url,
            issuer: require(ISSUER_VAR)?,
            audience: require(AUDIENCE_VAR)?,
        }))
    }
}

/// The keys decide what verifies, so they must not come over a channel anyone
/// on the path can rewrite. Plain http is accepted only for loopback (a local
/// key server, tests).
fn jwks_url_allowed(url: &reqwest::Url) -> bool {
    match url.scheme() {
        "https" => url.host().is_some(),
        "http" => is_loopback(url),
        _ => false,
    }
}

fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Alg {
    Rs256,
    Es256,
}

impl Alg {
    fn from_jose(name: &str) -> Option<Self> {
        match name {
            "RS256" => Some(Self::Rs256),
            "ES256" => Some(Self::Es256),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
enum PublicKey {
    Rsa {
        n: Vec<u8>,
        e: Vec<u8>,
    },
    /// Uncompressed SEC1 point: 0x04 || x || y.
    EcP256 {
        point: Vec<u8>,
    },
}

impl PublicKey {
    fn alg(&self) -> Alg {
        match self {
            Self::Rsa { .. } => Alg::Rs256,
            Self::EcP256 { .. } => Alg::Es256,
        }
    }

    fn verify(&self, message: &[u8], sig: &[u8]) -> bool {
        match self {
            Self::Rsa { n, e } => RsaPublicKeyComponents { n, e }
                .verify(&signature::RSA_PKCS1_2048_8192_SHA256, message, sig)
                .is_ok(),
            Self::EcP256 { point } => {
                UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
                    .verify(message, sig)
                    .is_ok()
            }
        }
    }
}

/// The proxy's verification keys by key id.
#[derive(Debug, Clone, Default)]
pub struct KeySet(HashMap<String, PublicKey>);

impl KeySet {
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn contains(&self, kid: &str) -> bool {
        self.0.contains_key(kid)
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum JwksError {
    #[error("the JWKS document is not a JSON object with a \"keys\" array")]
    NotAKeySet,
    #[error("the JWKS document holds no RS256 or ES256 signing key")]
    NoUsableKey,
}

/// Parses a JWKS document (RFC 7517). Keys this module cannot use — other key
/// types or curves, encryption keys, keys without a `kid`, keys whose `alg`
/// disagrees with their type — are skipped, not fatal, since a proxy may
/// publish more than its signing keys (Cloudflare adds `public_cert(s)`
/// beside `keys`, which is ignored).
pub fn parse_jwks(body: &[u8]) -> Result<KeySet, JwksError> {
    let doc: Value = serde_json::from_slice(body).map_err(|_| JwksError::NotAKeySet)?;
    let keys = doc
        .get("keys")
        .and_then(Value::as_array)
        .ok_or(JwksError::NotAKeySet)?;
    let set: HashMap<String, PublicKey> = keys
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|jwk| Some((jwk_str(jwk, "kid")?.to_string(), parse_jwk(jwk)?)))
        .collect();
    if set.is_empty() {
        return Err(JwksError::NoUsableKey);
    }
    Ok(KeySet(set))
}

fn jwk_str<'a>(jwk: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    jwk.get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn jwk_bytes(jwk: &Map<String, Value>, name: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(jwk_str(jwk, name)?)
        .ok()
        .filter(|b| !b.is_empty())
}

fn parse_jwk(jwk: &Map<String, Value>) -> Option<PublicKey> {
    if jwk.get("use").is_some_and(|u| u.as_str() != Some("sig")) {
        return None;
    }
    let key = match jwk_str(jwk, "kty")? {
        "RSA" => PublicKey::Rsa {
            n: jwk_bytes(jwk, "n")?,
            e: jwk_bytes(jwk, "e")?,
        },
        "EC" if jwk_str(jwk, "crv")? == "P-256" => {
            let (x, y) = (jwk_bytes(jwk, "x")?, jwk_bytes(jwk, "y")?);
            if x.len() != 32 || y.len() != 32 {
                return None;
            }
            let mut point = Vec::with_capacity(65);
            point.push(0x04);
            point.extend_from_slice(&x);
            point.extend_from_slice(&y);
            PublicKey::EcP256 { point }
        }
        _ => return None,
    };
    // An `alg` on the key pins it to one algorithm; one that disagrees with the
    // key's type is a key this module would use differently from its owner.
    if let Some(alg) = jwk.get("alg") {
        if alg.as_str().and_then(Alg::from_jose) != Some(key.alg()) {
            return None;
        }
    }
    Some(key)
}

/// Why an assertion was refused. Logged by reason only — never the assertion,
/// which is a bearer credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Rejection {
    #[error("no assertion header")]
    Missing,
    #[error("malformed assertion: {0}")]
    Malformed(&'static str),
    #[error("algorithm not accepted")]
    Algorithm,
    #[error("unknown key id")]
    UnknownKey,
    #[error("no verification keys available")]
    NoKeys,
    #[error("bad signature")]
    Signature,
    #[error("expired")]
    Expired,
    #[error("not yet valid")]
    NotYetValid,
    #[error("wrong issuer")]
    Issuer,
    #[error("wrong audience")]
    Audience,
}

fn decode_json_object(part: &str, what: &'static str) -> Result<Map<String, Value>, Rejection> {
    let bytes = URL_SAFE_NO_PAD
        .decode(part)
        .map_err(|_| Rejection::Malformed(what))?;
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(Rejection::Malformed(what)),
    }
}

/// The key id an assertion names, read before its signature is checked so the
/// caller knows whether its cached keys can answer.
fn assertion_kid(assertion: &str) -> Result<String, Rejection> {
    let header = assertion.split('.').next().unwrap_or_default();
    let header = decode_json_object(header, "header")?;
    jwk_str(&header, "kid")
        .map(str::to_string)
        .ok_or(Rejection::Malformed("kid"))
}

fn numeric_date(claims: &Map<String, Value>, name: &str) -> Result<Option<f64>, Rejection> {
    match claims.get(name) {
        None => Ok(None),
        Some(v) => v
            .as_f64()
            .filter(|t| t.is_finite())
            .map(Some)
            .ok_or(Rejection::Malformed("date claim")),
    }
}

/// Verifies a compact-serialized JWS (RFC 7515) and its claims (RFC 7519).
/// `now` is seconds since the Unix epoch.
pub fn verify(
    assertion: &str,
    keys: &KeySet,
    issuer: &str,
    audience: &str,
    now: u64,
) -> Result<(), Rejection> {
    if assertion.len() > MAX_ASSERTION_LEN {
        return Err(Rejection::Malformed("too long"));
    }
    let parts: Vec<&str> = assertion.split('.').collect();
    let [header_b64, claims_b64, sig_b64] = parts.as_slice() else {
        return Err(Rejection::Malformed("not three parts"));
    };

    let header = decode_json_object(header_b64, "header")?;
    // The algorithm comes from the key, never from the header alone: the
    // header only has to agree. That shuts out `none`, HS256 with a public key
    // as the secret, and every other algorithm-confusion variant.
    let alg = header
        .get("alg")
        .and_then(Value::as_str)
        .and_then(Alg::from_jose)
        .ok_or(Rejection::Algorithm)?;
    // RFC 7515 §4.1.11: an extension this verifier does not implement must
    // reject the token.
    if header.contains_key("crit") {
        return Err(Rejection::Malformed("crit"));
    }
    let kid = jwk_str(&header, "kid").ok_or(Rejection::Malformed("kid"))?;
    let key = keys.0.get(kid).ok_or(Rejection::UnknownKey)?;
    if key.alg() != alg {
        return Err(Rejection::Algorithm);
    }

    let sig = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| Rejection::Malformed("signature"))?;
    let signing_input = &assertion[..header_b64.len() + 1 + claims_b64.len()];
    if !key.verify(signing_input.as_bytes(), &sig) {
        return Err(Rejection::Signature);
    }

    // Claims are only read once the signature says who wrote them.
    let claims = decode_json_object(claims_b64, "claims")?;
    let now = now as f64;
    let exp = numeric_date(&claims, "exp")?.ok_or(Rejection::Malformed("exp"))?;
    if now >= exp + CLOCK_LEEWAY_SECS {
        return Err(Rejection::Expired);
    }
    if let Some(nbf) = numeric_date(&claims, "nbf")? {
        if now + CLOCK_LEEWAY_SECS < nbf {
            return Err(Rejection::NotYetValid);
        }
    }
    if claims.get("iss").and_then(Value::as_str) != Some(issuer) {
        return Err(Rejection::Issuer);
    }
    let audience_ok = match claims.get("aud") {
        Some(Value::String(aud)) => aud == audience,
        Some(Value::Array(auds)) => auds.iter().any(|a| a.as_str() == Some(audience)),
        _ => false,
    };
    if !audience_ok {
        return Err(Rejection::Audience);
    }
    Ok(())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The configured proxy authentication with its key cache.
pub struct ProxyJwtAuth {
    config: ProxyAuthConfig,
    client: reqwest::Client,
    keys: RwLock<Option<(Arc<KeySet>, Instant)>>,
    /// Serializes refreshes and remembers the last attempt (success or not)
    /// for the rate limit.
    last_refresh: Mutex<Option<Instant>>,
    min_refresh_interval: Duration,
    keys_max_age: Duration,
    /// Set while a refresh started for keys past their age is out, so the
    /// requests that find them stale meanwhile do not start one each.
    refreshing_in_background: AtomicBool,
}

impl ProxyJwtAuth {
    pub fn new(config: ProxyAuthConfig) -> Result<Self, reqwest::Error> {
        let mut client = reqwest::Client::builder()
            .timeout(JWKS_FETCH_TIMEOUT)
            // A redirect could lead off the configured (https) origin.
            .redirect(reqwest::redirect::Policy::none());
        // A key server on this machine is not reached through HTTP(S)_PROXY:
        // a proxy on another host would dial its own loopback.
        if is_loopback(&config.jwks_url) {
            client = client.no_proxy();
        }
        let client = client.build()?;
        Ok(Self {
            config,
            client,
            keys: RwLock::new(None),
            last_refresh: Mutex::new(None),
            min_refresh_interval: MIN_REFRESH_INTERVAL,
            keys_max_age: KEYS_MAX_AGE,
            refreshing_in_background: AtomicBool::new(false),
        })
    }

    pub fn config(&self) -> &ProxyAuthConfig {
        &self.config
    }

    /// Fetches the keys once at startup so the first request does not wait,
    /// and so a wrong URL shows in the log right away. A failure is not fatal:
    /// requests are refused until a later fetch succeeds.
    pub async fn prime(&self) {
        self.refresh().await;
        if self.keys.read().await.is_none() {
            tracing::warn!(
                "[AUTH] proxy-jwt: no verification keys yet from {}; requests without the token are refused until a fetch succeeds",
                self.config.jwks_url
            );
        }
    }

    /// Checks the request's assertion header.
    pub async fn authenticate(self: &Arc<Self>, headers: &HeaderMap) -> Result<(), Rejection> {
        let assertion = headers
            .get(&self.config.header)
            .ok_or(Rejection::Missing)?
            .to_str()
            .map_err(|_| Rejection::Malformed("header encoding"))?;
        if assertion.len() > MAX_ASSERTION_LEN {
            return Err(Rejection::Malformed("too long"));
        }
        let kid = assertion_kid(assertion)?;
        let keys = self.keys_for(&kid).await?;
        verify(
            assertion,
            &keys,
            &self.config.issuer,
            &self.config.audience,
            unix_now(),
        )
    }

    async fn cached(&self) -> Option<(Arc<KeySet>, Instant)> {
        self.keys.read().await.clone()
    }

    async fn keys_for(self: &Arc<Self>, kid: &str) -> Result<Arc<KeySet>, Rejection> {
        if let Some((keys, fetched)) = self.cached().await {
            if keys.contains(kid) {
                // Past their age the keys still verify what they signed: answer
                // with them and refresh beside the request, so a slow or
                // unreachable key endpoint never holds requests up. A key the
                // endpoint has withdrawn is refused once the refresh is in.
                if fetched.elapsed() >= self.keys_max_age {
                    self.refresh_in_background();
                }
                return Ok(keys);
            }
        }
        // An unknown key id (a rotation) or no keys yet: nothing cached can
        // answer, so this request waits for the fetch.
        self.refresh().await;
        // A failed refresh keeps the previous keys: they still verify what
        // they signed, and `exp` bounds how long such an assertion lives.
        self.cached()
            .await
            .map(|(keys, _)| keys)
            .ok_or(Rejection::NoKeys)
    }

    fn refresh_in_background(self: &Arc<Self>) {
        if self.refreshing_in_background.swap(true, Ordering::AcqRel) {
            return;
        }
        let this = Arc::clone(self);
        tokio::spawn(async move {
            this.refresh().await;
            this.refreshing_in_background
                .store(false, Ordering::Release);
        });
    }

    async fn refresh(&self) {
        let mut last = self.last_refresh.lock().await;
        if last.is_some_and(|at| at.elapsed() < self.min_refresh_interval) {
            return;
        }
        *last = Some(Instant::now());
        match self.fetch().await {
            Ok(keys) => {
                tracing::info!(
                    "[AUTH] proxy-jwt: loaded {} verification key(s)",
                    keys.len()
                );
                *self.keys.write().await = Some((Arc::new(keys), Instant::now()));
            }
            Err(reason) => {
                tracing::warn!(
                    "[AUTH] proxy-jwt: fetching keys from {} failed: {reason}",
                    self.config.jwks_url
                );
            }
        }
    }

    async fn fetch(&self) -> Result<KeySet, String> {
        let mut response = self
            .client
            .get(self.config.jwks_url.clone())
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|len| len > MAX_JWKS_BYTES as u64)
        {
            return Err("document too large".into());
        }
        // Read by chunk so a body sent without a length stops at the cap too.
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| e.without_url().to_string())?
        {
            if body.len() + chunk.len() > MAX_JWKS_BYTES {
                return Err("document too large".into());
            }
            body.extend_from_slice(&chunk);
        }
        parse_jwks(&body).map_err(|e| e.to_string())
    }
}

/// A test issuer: one ES256 key, its key set preloaded into a
/// `ProxyJwtAuth`, and assertions it signs. For other modules' tests.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    use serde_json::json;

    pub(crate) const HEADER: &str = "cf-access-jwt-assertion";
    pub(crate) const ISSUER: &str = "https://team.example.test";
    pub(crate) const AUDIENCE: &str = "app-audience-tag";

    pub(crate) struct TestIssuer {
        pair: EcdsaKeyPair,
    }

    impl TestIssuer {
        pub(crate) fn new() -> Self {
            let rng = SystemRandom::new();
            let pkcs8 =
                EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
            let pair =
                EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
                    .unwrap();
            Self { pair }
        }

        /// A `ProxyJwtAuth` that already holds this issuer's key, so no
        /// request reaches the (unroutable) key URL.
        pub(crate) async fn auth(&self) -> ProxyJwtAuth {
            let config = ProxyAuthConfig {
                header: HeaderName::from_static(HEADER),
                jwks_url: reqwest::Url::parse("http://127.0.0.1:9/certs").unwrap(),
                issuer: ISSUER.into(),
                audience: AUDIENCE.into(),
            };
            let auth = ProxyJwtAuth::new(config).unwrap();
            let p = self.pair.public_key().as_ref();
            let doc = json!({"keys": [{"kid": "k", "kty": "EC", "crv": "P-256",
                "x": URL_SAFE_NO_PAD.encode(&p[1..33]), "y": URL_SAFE_NO_PAD.encode(&p[33..65])}]});
            let keys = parse_jwks(doc.to_string().as_bytes()).unwrap();
            *auth.keys.write().await = Some((Arc::new(keys), Instant::now()));
            auth
        }

        /// A currently valid assertion for `audience`.
        pub(crate) fn assertion_for(&self, audience: &str) -> String {
            let now = unix_now();
            let header = json!({"alg": "ES256", "kid": "k", "typ": "JWT"});
            let claims = json!({"iss": ISSUER, "aud": [audience], "exp": now + 300,
                                "iat": now, "nbf": now, "sub": "user"});
            let input = format!(
                "{}.{}",
                URL_SAFE_NO_PAD.encode(header.to_string()),
                URL_SAFE_NO_PAD.encode(claims.to_string())
            );
            let sig = self
                .pair
                .sign(&SystemRandom::new(), input.as_bytes())
                .unwrap();
            format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig.as_ref()))
        }

        pub(crate) fn assertion(&self) -> String {
            self.assertion_for(AUDIENCE)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{
        EcdsaKeyPair, KeyPair, RsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING, RSA_PKCS1_SHA256,
    };
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // TEST-ONLY 2048-bit RSA key (PKCS#8 DER, standard base64), made for these
    // tests with `openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -outform
    // DER` (ring reads PKCS#8 only, and cannot generate RSA keys, hence a
    // fixture). It signs nothing outside this module.
    const TEST_ONLY_RSA_PKCS8: &str = "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC4iJcjrRiHvy7nrn95DNrBIMOTix+8B6ZIguRZTiymPnfnaPwW5c+81Jg0yaZmm1XP2a181TluHDvRZ5lmjl83glTdlVwJ1I6NDeXY88RXYAX8kkrjEBw3XWClmEZr8e4QdhJguzJ+LJjnHsO23tC+/M1RDI/9oLXNB64GEmjFr6WyoX/c4MsJE/ANAma5lyNXXNJKTBYmN/ie1p4U8tA20qorT+2+cJv+tcQWkfuAKw0xnzfbViYgMv2pdXXM9H1yi/SGnJDU2927DysiKfWX3rbFiY6/z7kx0qQu8u+6Bz+tiPLoCiUY3/uOEGY/lh1+I7UH+uHCT3M5w16gtrwxAgMBAAECggEABL+rGAVv0Kp4VAj3Cc/tXzPvJIBbiDSwMESCCNRMrNiFsGRQvGwcjPDxm8YmrJRJwIgLAV/hUvaSCYD/fxah16VYdr1NuYkJRBL7+7nGLzNu5AGFwNMczsXt40UIZuW6aR0IuwmGMp4GL0ho4+9W8ttBk1jd6bp1gzmz3j8iCBhCWYI+Lfk23e9Lnb8aACMNyPK0a04q8q8c+Z303PLQ8Lw7YW2ep6fNu2zG2DksnKvOL11lYbFi/IIN6FWX+OMVqe5+jp/dzT6gCRZcGGeqJmaGqqBXyMp0+O3t2FeL20BXZD5N+glRSZFpW+8rpzJPSciwjePKsPlYw9eBmCdZmQKBgQDkgTP25hgAYzUV+M4n/0+ioGII316/WnTfPtrE+Y0baXPW8vQtvbiirCB61xEh//+c0Bs1PY+I0y28sm6rCo84F4Ta1CExlIYSHl6Ye1dCKIWlnFKo9hqUVMN1yuEir4ruVm6Vhw3/FhTgaVpOoO8UnTD1ngsF23FxZUQ4OZR0XQKBgQDOvOmFl3laEf+1HF4tsMiw6LGRBlnB1T1rsCQm/dihhEFvd6gDgltSKb/Sxenqcvnmc1bQb1y2DyiPAPgFgaWfq5stQrKPbc71x0ikcn2cu16sWMziH+PH1M0vaYzzjSZhfk/Wr6UyjR+DrT7E6ZF7d/x8sD2kE8rYSS9Q9Orp5QKBgD45CKN06JhCa5Q+GjU+CrtoHQn5eV12Dlk0TnJQ2iHax1aC9gb2oK57XKTWp62wfjR/XslSqCFEEDJQDF67E2Dc1qqYFSnhHdkVOAEhpRM44ZvFQ6UKzxYRNuB+jGvbjWN1WcuR6TfLFYg+Z/79R90/KLPZg3rm1K9iOf9tfoVpAoGBALrvEIyuUZlC6x9dfj78OgvU7DJBNsnQwg/snlPvdoFdcDmVTYOWzHI3s+6m7IME4bgiFJ62A3PPsxHTg3CfMR52cgLz6zdLyDZust2XdMNSnSFjziatRS582eeEHmJfABRpvVFXUx2pg5RyA27T76tf7Brm1WXWS7VUP4eJXhyNAoGBANzRGdONiEnwf7NkVf0MwpJhzNKherecxH5aGwDvt74q+FlA95V1QAuvxTksdF32Hk0x2OmWHTLkqib7HuxTzb0D6GqT1S4WYmmgk74/dvk01yw+XRsTTbx9z5yrQBadICs2Oo85gvzlALX3Akp8RTlKAz853ZufLLmbG3o6qEYC";

    const ISS: &str = "https://team.example.test";
    const AUD: &str = "app-audience-tag";
    const NOW: u64 = 1_800_000_000;

    fn b64(bytes: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(bytes)
    }

    enum SignerKind {
        Rsa(RsaKeyPair),
        Ec(EcdsaKeyPair),
    }

    struct Signer {
        kid: &'static str,
        kind: SignerKind,
    }

    fn rsa_signer(kid: &'static str) -> Signer {
        use base64::engine::general_purpose::STANDARD;
        let der = STANDARD.decode(TEST_ONLY_RSA_PKCS8).unwrap();
        Signer {
            kid,
            kind: SignerKind::Rsa(RsaKeyPair::from_pkcs8(&der).unwrap()),
        }
    }

    fn ec_signer(kid: &'static str) -> Signer {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
            .unwrap();
        Signer {
            kid,
            kind: SignerKind::Ec(pair),
        }
    }

    impl Signer {
        fn jwk(&self) -> Value {
            match &self.kind {
                SignerKind::Rsa(pair) => {
                    let c = RsaPublicKeyComponents::<Vec<u8>>::from(pair.public());
                    json!({"kid": self.kid, "kty": "RSA", "alg": "RS256", "use": "sig",
                           "n": b64(&c.n), "e": b64(&c.e)})
                }
                SignerKind::Ec(pair) => {
                    let p = pair.public_key().as_ref();
                    json!({"kid": self.kid, "kty": "EC", "crv": "P-256", "alg": "ES256",
                           "use": "sig", "x": b64(&p[1..33]), "y": b64(&p[33..65])})
                }
            }
        }

        fn alg(&self) -> &'static str {
            match self.kind {
                SignerKind::Rsa(_) => "RS256",
                SignerKind::Ec(_) => "ES256",
            }
        }

        fn sign_with_header(&self, header: &Value, claims: &Value) -> String {
            let input = format!(
                "{}.{}",
                b64(header.to_string().as_bytes()),
                b64(claims.to_string().as_bytes())
            );
            let rng = SystemRandom::new();
            let sig = match &self.kind {
                SignerKind::Rsa(pair) => {
                    let mut sig = vec![0; pair.public().modulus_len()];
                    pair.sign(&RSA_PKCS1_SHA256, &rng, input.as_bytes(), &mut sig)
                        .unwrap();
                    sig
                }
                SignerKind::Ec(pair) => {
                    pair.sign(&rng, input.as_bytes()).unwrap().as_ref().to_vec()
                }
            };
            format!("{input}.{}", b64(&sig))
        }

        fn sign(&self, claims: &Value) -> String {
            let header = json!({"alg": self.alg(), "kid": self.kid, "typ": "JWT"});
            self.sign_with_header(&header, claims)
        }
    }

    fn keyset(signers: &[&Signer]) -> KeySet {
        let doc = json!({"keys": signers.iter().map(|s| s.jwk()).collect::<Vec<_>>()});
        parse_jwks(doc.to_string().as_bytes()).unwrap()
    }

    // Shaped like a Cloudflare Access application token.
    fn claims() -> Value {
        json!({"iss": ISS, "aud": [AUD], "exp": NOW + 300, "iat": NOW - 60,
               "nbf": NOW - 60, "sub": "user-id", "email": "someone@example.test",
               "type": "app"})
    }

    fn check(token: &str, keys: &KeySet) -> Result<(), Rejection> {
        verify(token, keys, ISS, AUD, NOW)
    }

    // ── verify: what passes ──────────────────────────────────────────────

    #[test]
    fn accepts_rs256_and_es256() {
        let (rsa, ec) = (rsa_signer("r1"), ec_signer("e1"));
        let keys = keyset(&[&rsa, &ec]);
        assert_eq!(check(&rsa.sign(&claims()), &keys), Ok(()));
        assert_eq!(check(&ec.sign(&claims()), &keys), Ok(()));
    }

    #[test]
    fn accepts_a_string_audience_and_no_nbf() {
        let rsa = rsa_signer("r1");
        let mut c = claims();
        c["aud"] = json!(AUD);
        c.as_object_mut().unwrap().remove("nbf");
        assert_eq!(check(&rsa.sign(&c), &keyset(&[&rsa])), Ok(()));
    }

    #[test]
    fn tolerates_clock_skew_within_the_leeway() {
        let rsa = rsa_signer("r1");
        let mut c = claims();
        c["exp"] = json!(NOW - 30);
        c["nbf"] = json!(NOW + 30);
        assert_eq!(check(&rsa.sign(&c), &keyset(&[&rsa])), Ok(()));
    }

    // ── verify: what is refused ──────────────────────────────────────────

    #[test]
    fn refuses_an_expired_assertion() {
        let rsa = rsa_signer("r1");
        let mut c = claims();
        c["exp"] = json!(NOW - 61);
        assert_eq!(
            check(&rsa.sign(&c), &keyset(&[&rsa])),
            Err(Rejection::Expired)
        );
    }

    #[test]
    fn refuses_an_assertion_without_exp() {
        let rsa = rsa_signer("r1");
        let mut c = claims();
        c.as_object_mut().unwrap().remove("exp");
        assert_eq!(
            check(&rsa.sign(&c), &keyset(&[&rsa])),
            Err(Rejection::Malformed("exp"))
        );
    }

    #[test]
    fn refuses_a_non_numeric_exp() {
        let rsa = rsa_signer("r1");
        let mut c = claims();
        c["exp"] = json!("tomorrow");
        assert_eq!(
            check(&rsa.sign(&c), &keyset(&[&rsa])),
            Err(Rejection::Malformed("date claim"))
        );
    }

    #[test]
    fn refuses_an_assertion_not_yet_valid() {
        let rsa = rsa_signer("r1");
        let mut c = claims();
        c["nbf"] = json!(NOW + 61);
        assert_eq!(
            check(&rsa.sign(&c), &keyset(&[&rsa])),
            Err(Rejection::NotYetValid)
        );
    }

    #[test]
    fn refuses_another_issuer() {
        let rsa = rsa_signer("r1");
        let mut c = claims();
        c["iss"] = json!("https://other.example.test");
        assert_eq!(
            check(&rsa.sign(&c), &keyset(&[&rsa])),
            Err(Rejection::Issuer)
        );
        c.as_object_mut().unwrap().remove("iss");
        assert_eq!(
            check(&rsa.sign(&c), &keyset(&[&rsa])),
            Err(Rejection::Issuer)
        );
    }

    #[test]
    fn refuses_another_audience() {
        let rsa = rsa_signer("r1");
        let keys = keyset(&[&rsa]);
        let mut c = claims();
        c["aud"] = json!(["other-app"]);
        assert_eq!(check(&rsa.sign(&c), &keys), Err(Rejection::Audience));
        c["aud"] = json!("other-app");
        assert_eq!(check(&rsa.sign(&c), &keys), Err(Rejection::Audience));
        c.as_object_mut().unwrap().remove("aud");
        assert_eq!(check(&rsa.sign(&c), &keys), Err(Rejection::Audience));
    }

    #[test]
    fn refuses_a_tampered_payload() {
        let rsa = rsa_signer("r1");
        let token = rsa.sign(&claims());
        let parts: Vec<&str> = token.split('.').collect();
        let mut c = claims();
        c["email"] = json!("attacker@example.test");
        let forged = format!(
            "{}.{}.{}",
            parts[0],
            b64(c.to_string().as_bytes()),
            parts[2]
        );
        assert_eq!(check(&forged, &keyset(&[&rsa])), Err(Rejection::Signature));
    }

    #[test]
    fn refuses_a_signature_by_a_key_not_in_the_set() {
        let (trusted, other) = (ec_signer("k1"), ec_signer("k1"));
        assert_eq!(
            check(&other.sign(&claims()), &keyset(&[&trusted])),
            Err(Rejection::Signature)
        );
    }

    #[test]
    fn refuses_an_unknown_key_id() {
        let (rsa, ec) = (rsa_signer("r1"), ec_signer("e1"));
        assert_eq!(
            check(&ec.sign(&claims()), &keyset(&[&rsa])),
            Err(Rejection::UnknownKey)
        );
    }

    #[test]
    fn refuses_alg_none_and_hs256() {
        let rsa = rsa_signer("r1");
        let keys = keyset(&[&rsa]);
        let body = b64(claims().to_string().as_bytes());
        for alg in ["none", "HS256", "RS512", "PS256"] {
            let header = b64(json!({"alg": alg, "kid": "r1"}).to_string().as_bytes());
            assert_eq!(
                check(&format!("{header}.{body}."), &keys),
                Err(Rejection::Algorithm),
                "{alg}"
            );
            assert_eq!(
                check(&format!("{header}.{body}.c2ln"), &keys),
                Err(Rejection::Algorithm),
                "{alg}"
            );
        }
    }

    #[test]
    fn refuses_a_header_alg_that_disagrees_with_the_key() {
        // ES256 claimed for an RSA key id: the key decides the algorithm.
        let (rsa, ec) = (rsa_signer("r1"), ec_signer("e1"));
        let header = json!({"alg": "ES256", "kid": "r1"});
        let token = ec.sign_with_header(&header, &claims());
        assert_eq!(check(&token, &keyset(&[&rsa])), Err(Rejection::Algorithm));
    }

    #[test]
    fn refuses_a_crit_header() {
        let rsa = rsa_signer("r1");
        let header = json!({"alg": "RS256", "kid": "r1", "crit": ["exp"]});
        let token = rsa.sign_with_header(&header, &claims());
        assert_eq!(
            check(&token, &keyset(&[&rsa])),
            Err(Rejection::Malformed("crit"))
        );
    }

    #[test]
    fn refuses_malformed_structure() {
        let rsa = rsa_signer("r1");
        let keys = keyset(&[&rsa]);
        let token = rsa.sign(&claims());
        assert_eq!(
            check("", &keys),
            Err(Rejection::Malformed("not three parts"))
        );
        assert_eq!(
            check("a.b", &keys),
            Err(Rejection::Malformed("not three parts"))
        );
        assert_eq!(
            check(&format!("{token}.extra"), &keys),
            Err(Rejection::Malformed("not three parts"))
        );
        assert_eq!(check("!!.b.c", &keys), Err(Rejection::Malformed("header")));
        let no_kid = rsa.sign_with_header(&json!({"alg": "RS256"}), &claims());
        assert_eq!(check(&no_kid, &keys), Err(Rejection::Malformed("kid")));
        let (head, rest) = token.split_once('.').unwrap();
        let (body, _) = rest.split_once('.').unwrap();
        assert_eq!(
            check(&format!("{head}.{body}.!!"), &keys),
            Err(Rejection::Malformed("signature"))
        );
        assert_eq!(
            check(&format!("{head}.{body}."), &keys),
            Err(Rejection::Signature)
        );
        let long = "a".repeat(MAX_ASSERTION_LEN + 1);
        assert_eq!(check(&long, &keys), Err(Rejection::Malformed("too long")));
    }

    #[test]
    fn refuses_a_signed_payload_that_is_not_an_object() {
        let rsa = rsa_signer("r1");
        let token = rsa.sign(&json!(["not", "claims"]));
        assert_eq!(
            check(&token, &keyset(&[&rsa])),
            Err(Rejection::Malformed("claims"))
        );
    }

    // ── parse_jwks ───────────────────────────────────────────────────────

    #[test]
    fn jwks_keeps_usable_keys_and_skips_the_rest() {
        let (rsa, ec) = (rsa_signer("r1"), ec_signer("e1"));
        let mut enc = rsa.jwk();
        enc["kid"] = json!("enc");
        enc["use"] = json!("enc");
        let mut mislabeled = ec.jwk();
        mislabeled["kid"] = json!("mislabeled");
        mislabeled["alg"] = json!("RS256");
        let mut no_kid = rsa.jwk();
        no_kid.as_object_mut().unwrap().remove("kid");
        let doc = json!({
            "keys": [rsa.jwk(), ec.jwk(), enc, mislabeled, no_kid,
                     {"kid": "p384", "kty": "EC", "crv": "P-384", "x": "AA", "y": "AA"},
                     {"kid": "oct", "kty": "oct", "k": "c2VjcmV0"},
                     {"kid": "short", "kty": "EC", "crv": "P-256", "x": "AAAA", "y": "AAAA"},
                     "not an object"],
            // Cloudflare publishes the same keys as certificates beside them.
            "public_cert": {"kid": "r1", "cert": "-----BEGIN CERTIFICATE-----"},
            "public_certs": []
        });
        let keys = parse_jwks(doc.to_string().as_bytes()).unwrap();
        assert_eq!(keys.len(), 2);
        assert!(keys.contains("r1") && keys.contains("e1"));
    }

    #[test]
    fn jwks_without_a_usable_key_is_an_error() {
        assert_eq!(
            parse_jwks(b"{\"keys\": []}").unwrap_err(),
            JwksError::NoUsableKey
        );
        assert_eq!(
            parse_jwks(b"{\"keys\": {}}").unwrap_err(),
            JwksError::NotAKeySet
        );
        assert_eq!(parse_jwks(b"<html>").unwrap_err(), JwksError::NotAKeySet);
    }

    // ── configuration ────────────────────────────────────────────────────

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    fn full() -> Vec<(&'static str, &'static str)> {
        vec![
            (AUTH_MODE_VAR, "proxy-jwt"),
            (HEADER_VAR, "Cf-Access-Jwt-Assertion"),
            (
                JWKS_URL_VAR,
                "https://team.example.test/cdn-cgi/access/certs",
            ),
            (ISSUER_VAR, ISS),
            (AUDIENCE_VAR, AUD),
        ]
    }

    #[test]
    fn config_is_off_by_default() {
        assert_eq!(ProxyAuthConfig::from_lookup(env(&[])), Ok(None));
        assert_eq!(
            ProxyAuthConfig::from_lookup(env(&[(AUTH_MODE_VAR, "token")])),
            Ok(None)
        );
        assert_eq!(
            ProxyAuthConfig::from_lookup(env(&[(AUTH_MODE_VAR, "  ")])),
            Ok(None)
        );
    }

    #[test]
    fn config_reads_a_complete_proxy_setup() {
        let config = ProxyAuthConfig::from_lookup(env(&full())).unwrap().unwrap();
        assert_eq!(config.header.as_str(), "cf-access-jwt-assertion");
        assert_eq!(config.issuer, ISS);
        assert_eq!(config.audience, AUD);
    }

    #[test]
    fn config_refuses_an_incomplete_proxy_setup() {
        for missing in [HEADER_VAR, JWKS_URL_VAR, ISSUER_VAR, AUDIENCE_VAR] {
            let pairs: Vec<_> = full().into_iter().filter(|(k, _)| *k != missing).collect();
            assert_eq!(
                ProxyAuthConfig::from_lookup(env(&pairs)),
                Err(ConfigError::Missing(missing))
            );
            let blank: Vec<_> = full()
                .into_iter()
                .map(|(k, v)| if k == missing { (k, " ") } else { (k, v) })
                .collect();
            assert_eq!(
                ProxyAuthConfig::from_lookup(env(&blank)),
                Err(ConfigError::Missing(missing))
            );
        }
    }

    #[test]
    fn config_refuses_an_unknown_mode_and_settings_without_the_mode() {
        assert_eq!(
            ProxyAuthConfig::from_lookup(env(&[(AUTH_MODE_VAR, "proxy")])),
            Err(ConfigError::UnknownMode("proxy".into()))
        );
        let without: Vec<_> = full()
            .into_iter()
            .filter(|(k, _)| *k != AUTH_MODE_VAR)
            .collect();
        assert_eq!(
            ProxyAuthConfig::from_lookup(env(&without)),
            Err(ConfigError::WithoutMode(HEADER_VAR))
        );
    }

    #[test]
    fn config_refuses_a_bad_header_name() {
        let pairs: Vec<_> = full()
            .into_iter()
            .map(|(k, v)| {
                if k == HEADER_VAR {
                    (k, "bad header")
                } else {
                    (k, v)
                }
            })
            .collect();
        assert_eq!(
            ProxyAuthConfig::from_lookup(env(&pairs)),
            Err(ConfigError::BadHeader("bad header".into()))
        );
    }

    #[test]
    fn config_wants_https_for_the_keys_except_on_loopback() {
        let with_url = |url: &'static str| {
            let pairs: Vec<_> = full()
                .into_iter()
                .map(|(k, v)| if k == JWKS_URL_VAR { (k, url) } else { (k, v) })
                .collect();
            ProxyAuthConfig::from_lookup(env(&pairs))
        };
        for bad in [
            "http://team.example.test/certs",
            "ftp://team.example.test/certs",
            "file:///etc/certs.json",
            "not a url",
        ] {
            assert_eq!(
                with_url(bad),
                Err(ConfigError::BadJwksUrl(bad.into())),
                "{bad}"
            );
        }
        for ok in [
            "http://127.0.0.1:8080/certs",
            "http://localhost/certs",
            "http://[::1]/certs",
        ] {
            assert!(with_url(ok).unwrap().is_some(), "{ok}");
        }
    }

    // ── key cache ────────────────────────────────────────────────────────

    struct KeyServer {
        url: String,
        served: Arc<std::sync::Mutex<Value>>,
        hits: Arc<AtomicUsize>,
    }

    async fn key_server(doc: Value) -> KeyServer {
        key_server_answering_after(doc, Duration::ZERO).await
    }

    async fn key_server_answering_after(doc: Value, delay: Duration) -> KeyServer {
        let served = Arc::new(std::sync::Mutex::new(doc));
        let hits = Arc::new(AtomicUsize::new(0));
        let (s, h) = (served.clone(), hits.clone());
        let app = axum::Router::new().route(
            "/certs",
            axum::routing::get(move || {
                let (s, h) = (s.clone(), h.clone());
                async move {
                    h.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(delay).await;
                    let doc = s.lock().unwrap().clone();
                    axum::Json(doc)
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/certs", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        KeyServer { url, served, hits }
    }

    fn auth_for(url: &str, min_refresh_interval: Duration) -> ProxyJwtAuth {
        let config = ProxyAuthConfig::from_lookup(env(&[
            (AUTH_MODE_VAR, "proxy-jwt"),
            (HEADER_VAR, "Cf-Access-Jwt-Assertion"),
            (JWKS_URL_VAR, url),
            (ISSUER_VAR, ISS),
            (AUDIENCE_VAR, AUD),
        ]))
        .unwrap()
        .unwrap();
        let mut auth = ProxyJwtAuth::new(config).unwrap();
        auth.min_refresh_interval = min_refresh_interval;
        auth
    }

    fn live_claims() -> Value {
        let now = unix_now();
        let mut c = claims();
        c["exp"] = json!(now + 300);
        c["iat"] = json!(now);
        c["nbf"] = json!(now);
        c
    }

    fn with_assertion(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("cf-access-jwt-assertion", token.parse().unwrap());
        headers
    }

    #[tokio::test]
    async fn fetches_keys_once_and_serves_from_the_cache() {
        let rsa = rsa_signer("r1");
        let server = key_server(json!({"keys": [rsa.jwk()]})).await;
        let auth = Arc::new(auth_for(&server.url, Duration::ZERO));
        let token = rsa.sign(&live_claims());

        assert_eq!(auth.authenticate(&with_assertion(&token)).await, Ok(()));
        assert_eq!(auth.authenticate(&with_assertion(&token)).await, Ok(()));
        assert_eq!(server.hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn an_unknown_key_id_refreshes_the_keys_after_a_rotation() {
        let (old, new) = (ec_signer("old"), ec_signer("new"));
        let server = key_server(json!({"keys": [old.jwk()]})).await;
        let auth = Arc::new(auth_for(&server.url, Duration::ZERO));
        auth.prime().await;

        *server.served.lock().unwrap() = json!({"keys": [old.jwk(), new.jwk()]});
        let token = new.sign(&live_claims());
        assert_eq!(auth.authenticate(&with_assertion(&token)).await, Ok(()));
        assert_eq!(server.hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn unknown_key_ids_cannot_drive_a_fetch_per_request() {
        let (known, stranger) = (ec_signer("known"), ec_signer("stranger"));
        let server = key_server(json!({"keys": [known.jwk()]})).await;
        let auth = Arc::new(auth_for(&server.url, Duration::from_secs(3600)));
        auth.prime().await;

        let token = stranger.sign(&live_claims());
        for _ in 0..5 {
            assert_eq!(
                auth.authenticate(&with_assertion(&token)).await,
                Err(Rejection::UnknownKey)
            );
        }
        assert_eq!(server.hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn refuses_everything_while_no_keys_could_be_fetched() {
        // Bound and closed again: nothing listens on that port.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/certs", listener.local_addr().unwrap());
        drop(listener);
        let auth = Arc::new(auth_for(&url, Duration::ZERO));
        let token = rsa_signer("r1").sign(&live_claims());
        assert_eq!(
            auth.authenticate(&with_assertion(&token)).await,
            Err(Rejection::NoKeys)
        );
    }

    #[tokio::test]
    async fn keeps_the_last_keys_when_a_refresh_fails() {
        let (rsa, stranger) = (rsa_signer("r1"), ec_signer("x"));
        let server = key_server(json!({"keys": [rsa.jwk()]})).await;
        let auth = Arc::new(auth_for(&server.url, Duration::ZERO));
        auth.prime().await;

        // The endpoint now serves garbage; an unknown kid forces a refresh.
        *server.served.lock().unwrap() = json!({"keys": []});
        assert_eq!(
            auth.authenticate(&with_assertion(&stranger.sign(&live_claims())))
                .await,
            Err(Rejection::UnknownKey)
        );
        assert_eq!(
            auth.authenticate(&with_assertion(&rsa.sign(&live_claims())))
                .await,
            Ok(())
        );
    }

    // The size cap holds for a body sent without a length too: the fetch stops
    // reading once the document is past it, instead of keeping all of it until
    // the stream ends or the timeout.
    #[tokio::test]
    async fn an_endless_key_document_is_cut_off_at_the_size_cap() {
        let app = axum::Router::new().route(
            "/certs",
            axum::routing::get(|| async {
                let chunks = futures_util::stream::unfold((), |()| async {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    Some((
                        Ok::<_, std::io::Error>(axum::body::Bytes::from(vec![b' '; 64 * 1024])),
                        (),
                    ))
                });
                axum::body::Body::from_stream(chunks)
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/certs", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let auth = Arc::new(auth_for(&url, Duration::ZERO));

        let fetched = tokio::time::timeout(Duration::from_secs(3), auth.fetch()).await;
        assert_eq!(
            fetched.map(|r| r.err()),
            Ok(Some("document too large".into()))
        );
    }

    /// `auth_for` already holding `signers`' keys, which are past their age.
    async fn with_stale_keys(url: &str, signers: &[&Signer]) -> Arc<ProxyJwtAuth> {
        let mut auth = auth_for(url, Duration::ZERO);
        auth.keys_max_age = Duration::ZERO;
        *auth.keys.write().await = Some((Arc::new(keyset(signers)), Instant::now()));
        Arc::new(auth)
    }

    // Keys past their age still verify what they signed, so the refresh they
    // call for must not hold the request up, however slow the key endpoint.
    #[tokio::test]
    async fn a_stale_key_set_answers_without_waiting_for_its_refresh() {
        // Takes connections and never answers: a fetch waits out its timeout.
        let blackhole = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/certs", blackhole.local_addr().unwrap());
        let rsa = rsa_signer("r1");
        let auth = with_stale_keys(&url, &[&rsa]).await;

        let answer = tokio::time::timeout(
            Duration::from_secs(3),
            auth.authenticate(&with_assertion(&rsa.sign(&live_claims()))),
        )
        .await;
        assert_eq!(answer, Ok(Ok(())));
    }

    // The refresh runs beside the request; once it is in, a key the endpoint
    // no longer publishes is refused.
    #[tokio::test]
    async fn a_stale_key_set_is_refreshed_beside_the_request() {
        let (old, new) = (ec_signer("old"), ec_signer("new"));
        let server = key_server(json!({"keys": [new.jwk()]})).await;
        let auth = with_stale_keys(&server.url, &[&old]).await;

        let signed_by_old = with_assertion(&old.sign(&live_claims()));
        assert_eq!(auth.authenticate(&signed_by_old).await, Ok(()));
        // Generous: it only has to catch a refresh that never lands.
        let deadline = Instant::now() + Duration::from_secs(30);
        while !auth
            .cached()
            .await
            .is_some_and(|(keys, _)| keys.contains("new"))
        {
            assert!(Instant::now() < deadline, "the refresh never landed");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            auth.authenticate(&signed_by_old).await,
            Err(Rejection::UnknownKey)
        );
        assert_eq!(
            auth.authenticate(&with_assertion(&new.sign(&live_claims())))
                .await,
            Ok(())
        );
    }

    // Requests that find the keys stale while a refresh is out do not start
    // one each.
    #[tokio::test]
    async fn stale_keys_start_one_refresh_at_a_time() {
        let rsa = rsa_signer("r1");
        let server =
            key_server_answering_after(json!({"keys": [rsa.jwk()]}), Duration::from_millis(300))
                .await;
        let auth = with_stale_keys(&server.url, &[&rsa]).await;
        let headers = with_assertion(&rsa.sign(&live_claims()));

        let answers =
            futures_util::future::join_all((0..8).map(|_| auth.authenticate(&headers))).await;
        assert!(
            answers.iter().all(|answer| *answer == Ok(())),
            "{answers:?}"
        );
        // Generous: it only has to catch a refresh that never starts or ends.
        let deadline = Instant::now() + Duration::from_secs(30);
        while server.hits.load(Ordering::SeqCst) == 0 {
            assert!(Instant::now() < deadline, "no refresh started");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // A second fetch, had one started, would show within this time; a slow
        // machine can only hide one, never invent it.
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(server.hits.load(Ordering::SeqCst), 1);

        // Once that refresh is over, keys found stale again start the next one.
        while auth.refreshing_in_background.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline, "the first refresh never ended");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(auth.authenticate(&headers).await, Ok(()));
        while server.hits.load(Ordering::SeqCst) < 2 {
            assert!(Instant::now() < deadline, "no second refresh started");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn refuses_a_request_without_the_header() {
        let auth = Arc::new(auth_for("http://127.0.0.1:9/certs", Duration::ZERO));
        assert_eq!(
            auth.authenticate(&HeaderMap::new()).await,
            Err(Rejection::Missing)
        );
    }
}
