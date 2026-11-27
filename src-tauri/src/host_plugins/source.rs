use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use url::Url;

use super::MAX_CLIENT_HTML_BYTES;
use super::{
    invalid, runtime::MAX_MODULE_BYTES, HostPlugins, InstalledPlugin, Manifest, PluginBundle,
    MAX_MANIFEST_BYTES,
};
use crate::app_error::{AppCommandError, AppErrorCode};

const FILE_NAME: &str = "codeg-plugin.json";
const NPM_MIRROR: &str = "https://registry.npmmirror.com";
const MAX_ARCHIVE_BYTES: usize = 8 * 1024 * 1024;
const MAX_INDEX_BYTES: usize = 512 * 1024;
const MAX_INDEX_PLUGINS: usize = 128;
const MAX_INDEX_VERSIONS: usize = 32;
const MAX_UNPACKED_BYTES: u64 = 32 * 1024 * 1024;
const NPM_OFFICIAL: &str = crate::commands::acp::NPM_OFFICIAL_REGISTRY;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Registry {
    #[default]
    Npm,
    Mirror,
}

impl Registry {
    fn origin(self) -> &'static str {
        match self {
            Self::Npm => NPM_OFFICIAL,
            Self::Mirror => NPM_MIRROR,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginIndex {
    pub api_version: u32,
    pub plugins: Vec<PluginIndexEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginIndexEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub versions: Vec<PluginIndexVersion>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginIndexVersion {
    pub version: String,
    pub source: String,
    #[serde(default)]
    pub registry: Registry,
}

impl PluginIndex {
    fn parse(text: &str) -> Result<Self, AppCommandError> {
        if text.len() > MAX_INDEX_BYTES {
            return Err(invalid("Plugin index exceeds 512 KiB"));
        }
        let index: Self = serde_json::from_str(text)
            .map_err(|error| invalid(format!("Invalid plugin index: {error}")))?;
        index.validate().map_err(invalid)?;
        Ok(index)
    }

    fn validate(&self) -> Result<(), String> {
        if self.api_version != 1 {
            return Err(format!(
                "Unsupported plugin index API version: {}",
                self.api_version
            ));
        }
        if self.plugins.is_empty() || self.plugins.len() > MAX_INDEX_PLUGINS {
            return Err("Provide 1 to 128 indexed plugins".to_owned());
        }
        let mut ids = std::collections::BTreeSet::new();
        for plugin in &self.plugins {
            if !super::valid_id(&plugin.id)
                || !super::valid_label(&plugin.name)
                || !ids.insert(&plugin.id)
                || plugin.description.len() > 4096
                || plugin.versions.is_empty()
                || plugin.versions.len() > MAX_INDEX_VERSIONS
            {
                return Err("Invalid or duplicate indexed plugin".to_owned());
            }
            let mut versions = std::collections::BTreeSet::new();
            for version in &plugin.versions {
                if semver::Version::parse(&version.version).is_err()
                    || !versions.insert(&version.version)
                    || version.source.len() > 1024
                    || !is_remote_source(&version.source)
                {
                    return Err("Invalid or duplicate indexed plugin version".to_owned());
                }
                match parse(&version.source) {
                    Ok(Source::Npm { selector, .. })
                        if semver::Version::parse(selector).is_err() =>
                    {
                        return Err(
                            "Indexed npm versions must use an exact semantic version".to_owned()
                        );
                    }
                    Ok(_) => {}
                    Err(_) => return Err("Invalid indexed plugin source".to_owned()),
                }
            }
        }
        Ok(())
    }
}

pub async fn fetch_index(url: &str) -> Result<PluginIndex, AppCommandError> {
    let url =
        Url::parse(url.trim()).map_err(|_| invalid("Enter a valid HTTPS plugin index URL"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.authority().contains('@')
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err(invalid(
            "Plugin index URLs must use HTTPS without credentials or fragments",
        ));
    }
    let bytes = download(&client()?, url, MAX_INDEX_BYTES).await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| invalid("Plugin index is not UTF-8"))?;
    PluginIndex::parse(text)
}

fn is_remote_source(source: &str) -> bool {
    !Path::new(source).is_absolute()
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InstalledSource {
    Directory {
        path: String,
    },
    GitHub {
        repository: String,
        commit: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        directory: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reference: Option<String>,
    },
    Npm {
        package: String,
        version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        registry: Option<Registry>,
    },
}

impl InstalledSource {
    pub(super) async fn refresh(mut self) -> Result<(PluginBundle, Self), AppCommandError> {
        let bundle = match &mut self {
            Self::Directory { path } => load_directory(directory_path(path)?).await?,
            Self::GitHub {
                repository,
                commit,
                directory,
                reference,
            } => {
                let requested = reference.as_deref().unwrap_or(commit);
                validate_github(repository, requested, directory)?;
                let (manifest, resolved) =
                    read_github(&client()?, repository, requested, directory).await?;
                *commit = resolved;
                manifest
            }
            Self::Npm {
                package,
                version,
                selector,
                registry,
            } => {
                let requested = selector.as_deref().unwrap_or(version);
                validate_npm(package, requested)?;
                let (manifest, resolved) =
                    read_npm(&client()?, registry.unwrap_or_default(), package, requested).await?;
                *version = resolved;
                manifest
            }
        };
        Ok((bundle, self))
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Source<'a> {
    Directory(PathBuf),
    GitHub {
        repository: &'a str,
        reference: &'a str,
        directory: &'a str,
    },
    Npm {
        package: &'a str,
        selector: &'a str,
    },
}

pub async fn install(
    plugins: &HostPlugins,
    input: &str,
    registry: Registry,
) -> Result<Vec<InstalledPlugin>, AppCommandError> {
    let (bundle, source) = resolve(input, registry).await?;
    plugins.install(PluginBundle::manifest_only(bundle.manifest)?, Some(source))
}

pub(super) async fn resolve(
    input: &str,
    registry: Registry,
) -> Result<(PluginBundle, InstalledSource), AppCommandError> {
    let source = match parse(input)? {
        Source::Directory(path) => InstalledSource::Directory {
            path: path.to_string_lossy().into_owned(),
        },
        Source::GitHub {
            repository,
            reference,
            directory,
        } => InstalledSource::GitHub {
            repository: repository.to_owned(),
            commit: String::new(),
            directory: directory.to_owned(),
            reference: Some(reference.to_owned()),
        },
        Source::Npm { package, selector } => InstalledSource::Npm {
            package: package.to_owned(),
            version: String::new(),
            selector: Some(selector.to_owned()),
            registry: Some(registry),
        },
    };
    source.refresh().await
}

fn parse(input: &str) -> Result<Source<'_>, AppCommandError> {
    let input = input.trim();
    if input.is_empty() || input.len() > 1024 || input.chars().any(char::is_control) {
        return Err(invalid(
            "Enter a plugin package, GitHub repository, or absolute directory path",
        ));
    }
    if Path::new(input).is_absolute() {
        return directory_path(input).map(Source::Directory);
    }
    let github = input
        .strip_prefix("https://github.com/")
        .or_else(|| input.strip_prefix("github:"));
    if github.is_some()
        || (!input.starts_with('@') && !input.starts_with("npm:") && input.contains('/'))
    {
        let repository = github.unwrap_or(input);
        let (repository, reference, directory) =
            if let Some((repository, tree)) = repository.split_once("/tree/") {
                let (reference, directory) = tree.split_once('/').unwrap_or((tree, ""));
                (repository, reference, directory.trim_end_matches('/'))
            } else {
                let (repository, reference) =
                    repository.split_once('#').unwrap_or((repository, "HEAD"));
                (repository, reference, "")
            };
        let repository = repository.trim_end_matches('/');
        let repository = repository.strip_suffix(".git").unwrap_or(repository);
        validate_github(repository, reference, directory)?;
        return Ok(Source::GitHub {
            repository,
            reference,
            directory,
        });
    }
    let npm = input.strip_prefix("npm:").unwrap_or(input);
    let (package, selector) = npm
        .char_indices()
        .skip(1)
        .find(|&(_, c)| c == '@')
        .map_or((npm, "latest"), |(index, _)| {
            (&npm[..index], &npm[index + 1..])
        });
    validate_npm(package, selector)?;
    Ok(Source::Npm { package, selector })
}

fn directory_path(input: &str) -> Result<PathBuf, AppCommandError> {
    let path = PathBuf::from(input);
    if !path.is_absolute() || input.len() > 1024 || input.chars().any(char::is_control) {
        return Err(invalid("Use an absolute directory on the connected host"));
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        {
            return Err(invalid(
                "Use a directory on a local drive of the connected host",
            ));
        }
    }
    Ok(path)
}

fn validate_github(
    repository: &str,
    reference: &str,
    directory: &str,
) -> Result<(), AppCommandError> {
    let valid_repository = repository.split_once('/').is_some_and(|(owner, name)| {
        owner.len() <= 39
            && name.len() <= 100
            && valid_part(owner)
            && valid_part(name)
            && owner
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    });
    if valid_repository
        && reference.len() <= 255
        && reference.split('/').all(valid_part)
        && directory.len() <= 1024
        && (directory.is_empty() || crate::harness::skills::package::safe_path(directory))
    {
        return Ok(());
    }
    Err(invalid(
        "Use a GitHub repository such as owner/repo or https://github.com/owner/repo#ref",
    ))
}

fn validate_npm(package: &str, selector: &str) -> Result<(), AppCommandError> {
    let valid_name = if let Some(scoped) = package.strip_prefix('@') {
        scoped
            .split_once('/')
            .is_some_and(|(scope, name)| valid_part(scope) && valid_part(name))
    } else {
        valid_part(package)
    };
    if valid_name && package.len() <= 214 && selector.len() <= 128 && valid_part(selector) {
        return Ok(());
    }
    Err(invalid(
        "Use an npm package name with an optional version or dist-tag",
    ))
}

fn valid_part(part: &str) -> bool {
    part.as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        && part
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-+".contains(&byte))
}

async fn load_directory(path: PathBuf) -> Result<PluginBundle, AppCommandError> {
    tokio::task::spawn_blocking(move || {
        let manifest =
            Manifest::parse(&read_directory_file(&path, FILE_NAME, MAX_MANIFEST_BYTES)?)?;
        let code = manifest
            .server
            .as_ref()
            .map(|server| read_directory_file(&path, &server.entry, MAX_MODULE_BYTES))
            .transpose()?;
        let html = manifest
            .client
            .as_ref()
            .map(|client| read_directory_file(&path, &client.entry, MAX_CLIENT_HTML_BYTES))
            .transpose()?;
        bundle(manifest, code, html)
    })
    .await
    .map_err(|_| invalid("Could not read the plugin directory"))?
}

fn read_directory_file(path: &Path, name: &str, limit: usize) -> Result<String, AppCommandError> {
    let file = path.join(name);
    let metadata = std::fs::symlink_metadata(&file)
        .map_err(|_| invalid(format!("The host directory does not contain {name}")))?;
    if !metadata.is_file() {
        return Err(invalid(format!("{name} must be a regular file")));
    }
    let file = std::fs::File::open(file).map_err(|_| invalid(format!("Could not open {name}")))?;
    read_text(file, name, limit)
}

fn read_text(reader: impl Read, name: &str, limit: usize) -> Result<String, AppCommandError> {
    let mut text = String::new();
    reader
        .take(limit as u64 + 1)
        .read_to_string(&mut text)
        .map_err(|_| invalid(format!("Could not read {name} as UTF-8")))?;
    if text.len() > limit {
        return Err(invalid(format!("{name} exceeds its size limit")));
    }
    Ok(text)
}

fn bundle(
    manifest: Manifest,
    code: Option<String>,
    html: Option<String>,
) -> Result<PluginBundle, AppCommandError> {
    for module in [&code, &html].into_iter().flatten() {
        if module.trim().is_empty() || module.contains('\0') {
            return Err(invalid("A plugin module must contain valid UTF-8 text"));
        }
    }
    Ok(PluginBundle {
        rpc: manifest.compile_rpc().map_err(invalid)?,
        event_contracts: super::services::compile_events(&manifest).map_err(invalid)?,
        manifest,
        server_code: code.map(Into::into),
        client_html: html.map(Into::into),
    })
}

fn client() -> Result<reqwest::Client, AppCommandError> {
    reqwest::Client::builder()
        .user_agent("codeg-host-plugins")
        .https_only(true)
        .referer(false)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| network("Could not initialize the plugin downloader"))
}

async fn download(
    client: &reqwest::Client,
    url: Url,
    limit: usize,
) -> Result<Vec<u8>, AppCommandError> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| network("Could not reach the plugin source"))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(AppCommandError::new(
            AppErrorCode::NotFound,
            "Plugin source or codeg-plugin.json was not found",
        ));
    }
    if !status.is_success() {
        return Err(network(format!("Plugin source returned HTTP {status}")));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| network("Could not download the plugin source"))?
    {
        if chunk.len() > limit - bytes.len() {
            return Err(invalid("Plugin source exceeds its download size limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn endpoint(origin: &str, segments: &[&str]) -> Url {
    let mut url = Url::parse(origin).expect("fixed plugin source URL");
    url.path_segments_mut()
        .expect("plugin source URL is hierarchical")
        .extend(segments);
    url
}

async fn read_github(
    client: &reqwest::Client,
    repository: &str,
    reference: &str,
    directory: &str,
) -> Result<(PluginBundle, String), AppCommandError> {
    #[derive(Deserialize)]
    struct Commit {
        sha: String,
    }
    let (owner, repo) = repository.split_once('/').expect("validated repository");
    let url = endpoint(
        "https://api.github.com",
        &["repos", owner, repo, "commits", reference],
    );
    let data = download(client, url, 1024 * 1024).await?;
    let Commit { sha } =
        serde_json::from_slice(&data).map_err(|_| network("GitHub did not return a commit"))?;
    if sha.len() != 40 || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(network("GitHub returned an invalid commit ID"));
    }
    let mut segments = vec![owner, repo, &sha];
    segments.extend(directory.split('/').filter(|segment| !segment.is_empty()));
    segments.push(FILE_NAME);
    let url = endpoint("https://raw.githubusercontent.com", &segments);
    let bytes = download(client, url, MAX_MANIFEST_BYTES).await?;
    let manifest = Manifest::parse(&read_text(bytes.as_slice(), FILE_NAME, MAX_MANIFEST_BYTES)?)?;
    segments.pop();
    let code = if let Some(server) = &manifest.server {
        Some(github_file(client, &segments, &server.entry, MAX_MODULE_BYTES).await?)
    } else {
        None
    };
    let html = if let Some(module) = &manifest.client {
        Some(github_file(client, &segments, &module.entry, MAX_CLIENT_HTML_BYTES).await?)
    } else {
        None
    };
    Ok((bundle(manifest, code, html)?, sha))
}

async fn github_file(
    client: &reqwest::Client,
    root: &[&str],
    name: &str,
    limit: usize,
) -> Result<String, AppCommandError> {
    let mut segments = root.to_vec();
    segments.push(name);
    let url = endpoint("https://raw.githubusercontent.com", &segments);
    let bytes = download(client, url, limit).await?;
    read_text(bytes.as_slice(), name, limit)
}

async fn read_npm(
    client: &reqwest::Client,
    registry: Registry,
    package: &str,
    selector: &str,
) -> Result<(PluginBundle, String), AppCommandError> {
    #[derive(Deserialize)]
    struct Package {
        name: String,
        version: String,
        dist: Distribution,
    }
    #[derive(Deserialize)]
    struct Distribution {
        tarball: String,
        integrity: String,
    }

    let url = endpoint(registry.origin(), &[package, selector]);
    let metadata = download(client, url, 1024 * 1024).await?;
    let package_info: Package = serde_json::from_slice(&metadata)
        .map_err(|_| invalid("Registry did not return a package with SHA-512 integrity"))?;
    let tarball = Url::parse(&package_info.dist.tarball)
        .map_err(|_| invalid("Registry returned an invalid plugin tarball URL"))?;
    let tarball_origin = tarball.origin();
    let version = semver::Version::parse(&package_info.version)
        .map_err(|_| invalid("Registry returned an invalid package version"))?;
    if package_info.name != package
        || semver::Version::parse(selector).is_ok_and(|requested| requested != version)
        || ![NPM_OFFICIAL, registry.origin()]
            .iter()
            .any(|origin| Url::parse(origin).is_ok_and(|url| url.origin() == tarball_origin))
        || !tarball.username().is_empty()
        || tarball.authority().contains('@')
        || tarball.fragment().is_some()
    {
        return Err(invalid(
            "Registry returned an unexpected plugin package or tarball URL",
        ));
    }
    let expected = package_info
        .dist
        .integrity
        .strip_prefix("sha512-")
        .and_then(|hash| base64::engine::general_purpose::STANDARD.decode(hash).ok())
        .filter(|hash| hash.len() == 64)
        .ok_or_else(|| invalid("Registry package is missing valid SHA-512 integrity"))?;
    let bytes = download(client, tarball, MAX_ARCHIVE_BYTES).await?;
    let bundle = tokio::task::spawn_blocking(move || verified_bundle(&bytes, &expected))
        .await
        .map_err(|_| invalid("Could not read the plugin archive"))??;
    Ok((bundle, package_info.version))
}

fn verified_bundle(bytes: &[u8], expected: &[u8]) -> Result<PluginBundle, AppCommandError> {
    if &Sha512::digest(bytes)[..] != expected {
        return Err(invalid(
            "Downloaded plugin package failed its integrity check",
        ));
    }
    let manifest = Manifest::parse(&archive_file(bytes, FILE_NAME, MAX_MANIFEST_BYTES)?)?;
    let code = manifest
        .server
        .as_ref()
        .map(|server| archive_file(bytes, &server.entry, MAX_MODULE_BYTES))
        .transpose()?;
    let html = manifest
        .client
        .as_ref()
        .map(|client| archive_file(bytes, &client.entry, MAX_CLIENT_HTML_BYTES))
        .transpose()?;
    bundle(manifest, code, html)
}

fn archive_file(bytes: &[u8], name: &str, limit: usize) -> Result<String, AppCommandError> {
    let mut archive =
        tar::Archive::new(GzDecoder::new(Cursor::new(bytes)).take(MAX_UNPACKED_BYTES));
    let malformed = |_| invalid("Could not read the plugin archive");
    let path = format!("package/{name}");
    let mut contents = None;
    for entry in archive.entries().map_err(malformed)? {
        let entry = entry.map_err(malformed)?;
        if entry.path_bytes().as_ref() != path.as_bytes() {
            continue;
        }
        if contents.is_some() || !entry.header().entry_type().is_file() {
            return Err(invalid(format!(
                "Plugin package must contain one regular {name}"
            )));
        }
        contents = Some(read_text(entry, name, limit)?);
    }
    contents.ok_or_else(|| invalid(format!("Plugin package does not contain {name}")))
}

fn network(message: impl Into<String>) -> AppCommandError {
    AppCommandError::new(AppErrorCode::NetworkError, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("../../../examples/plugins/turn-activity/codeg-plugin.json");

    #[test]
    fn source_inputs_select_only_the_supported_origins_and_paths() {
        assert_eq!(
            parse("@scope/example@1.0.0").unwrap(),
            Source::Npm {
                package: "@scope/example",
                selector: "1.0.0"
            }
        );
        assert_eq!(
            parse("npm:example").unwrap(),
            Source::Npm {
                package: "example",
                selector: "latest"
            }
        );
        assert_eq!(
            parse("owner/example#feature/demo").unwrap(),
            Source::GitHub {
                repository: "owner/example",
                reference: "feature/demo",
                directory: ""
            }
        );
        assert_eq!(
            parse("https://github.com/owner/example/tree/abc/demo/plugin").unwrap(),
            Source::GitHub {
                repository: "owner/example",
                reference: "abc",
                directory: "demo/plugin"
            }
        );
        assert_eq!(
            endpoint(NPM_OFFICIAL, &["@scope/example", "latest"]).path(),
            "/@scope%2Fexample/latest"
        );
        for input in [
            "https://localhost/owner/repo",
            "https://github.com/owner/repo/tree/main/../foo",
            "npm:@scope/repo@^1.2.3",
            "github:owner/repo#",
            "owner/repo?token=x",
        ] {
            assert!(parse(input).is_err(), "accepted {input}");
        }
    }

    #[tokio::test]
    async fn directory_install_persists_source_and_starts_disabled() {
        let host = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join(FILE_NAME), SAMPLE).unwrap();
        let plugins = HostPlugins::new(host.path());
        let path = source.path().to_str().unwrap();
        let catalog = install(&plugins, path, Registry::Npm).await.unwrap();
        assert!(!catalog[0].enabled);
        assert!(
            matches!(&catalog[0].source, Some(InstalledSource::Directory { path: stored }) if stored == path)
        );
        assert!(install(&plugins, path, Registry::Npm).await.is_err());
        let reopened = HostPlugins::new(host.path()).list().unwrap();
        assert!(
            matches!(&reopened[0].source, Some(InstalledSource::Directory { path: stored }) if stored == path)
        );
    }

    #[test]
    fn previously_stored_sources_keep_their_resolved_values() {
        for source in [
            serde_json::json!({"type": "npm", "package": "example", "version": "1.0.0"}),
            serde_json::json!({"type": "gitHub", "repository": "owner/example", "commit": "0".repeat(40)}),
        ] {
            let installed: InstalledSource = serde_json::from_value(source.clone()).unwrap();
            assert_eq!(serde_json::to_value(installed).unwrap(), source);
        }
    }

    #[test]
    fn plugin_indexes_validate_metadata_and_only_allow_remote_sources() {
        let text = r#"{
            "apiVersion": 1,
            "plugins": [{
                "id": "codeg.turn-activity",
                "name": "Turn Activity",
                "description": "Show completed turns.",
                "versions": [{
                    "version": "1.0.0",
                    "source": "https://github.com/owner/example#v1.0.0"
                }]
            }]
        }"#;
        let index = PluginIndex::parse(text).unwrap();
        assert_eq!(index.plugins[0].versions[0].registry, Registry::Npm);
        for invalid in [
            text.replace("\"apiVersion\": 1", "\"apiVersion\": 2"),
            text.replace("https://github.com/owner/example#v1.0.0", "/tmp/plugin"),
            text.replace(
                "https://github.com/owner/example#v1.0.0",
                "http://owner/example",
            ),
            text.replace("https://github.com/owner/example#v1.0.0", "npm:example"),
        ] {
            assert!(PluginIndex::parse(&invalid).is_err());
        }
    }

    #[tokio::test]
    async fn plugin_index_urls_require_https_without_credentials_or_fragments() {
        for url in [
            "http://example.com/plugins.json",
            "https://user@example.com/plugins.json",
            "https://example.com/plugins.json#fragment",
        ] {
            assert!(fetch_index(url).await.is_err(), "accepted {url}");
        }
    }

    #[test]
    fn npm_archive_reads_only_the_root_manifest_and_rejects_duplicate_entries() {
        fn archive(paths: &[&str], text: &str) -> Vec<u8> {
            let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            let mut builder = tar::Builder::new(gz);
            for path in paths {
                let mut entry = tar::Header::new_gnu();
                entry.set_size(text.len() as u64);
                entry.set_mode(0o644);
                entry.set_cksum();
                builder
                    .append_data(&mut entry, path, text.as_bytes())
                    .unwrap();
            }
            builder.into_inner().unwrap().finish().unwrap()
        }
        let path = "package/codeg-plugin.json";
        let package = archive(&[path, "package/index.js"], SAMPLE);
        assert_eq!(
            verified_bundle(&package, &Sha512::digest(&package))
                .unwrap()
                .manifest,
            Manifest::parse(SAMPLE).unwrap()
        );
        assert!(verified_bundle(&package, &[0; 64]).is_err());
        assert!(archive_file(
            &archive(&[path, path], SAMPLE),
            FILE_NAME,
            MAX_MANIFEST_BYTES
        )
        .is_err());
        assert!(archive_file(
            &archive(&["package/sub/codeg-plugin.json"], SAMPLE),
            FILE_NAME,
            MAX_MANIFEST_BYTES
        )
        .is_err());
        assert!(archive_file(
            &archive(&[path], &"x".repeat(MAX_MANIFEST_BYTES + 1)),
            FILE_NAME,
            MAX_MANIFEST_BYTES
        )
        .is_err());
    }
}
