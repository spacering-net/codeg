use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use url::Url;

use super::{invalid, HostPlugins, InstalledPlugin, Mutation, MAX_MANIFEST_BYTES};
use crate::app_error::{AppCommandError, AppErrorCode};

const FILE_NAME: &str = "codeg-plugin.json";
const NPM_MIRROR: &str = "https://registry.npmmirror.com";
const MAX_ARCHIVE_BYTES: usize = 8 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 32 * 1024 * 1024;
const NPM_OFFICIAL: &str = crate::commands::acp::NPM_OFFICIAL_REGISTRY;

#[derive(Clone, Copy, Default, Deserialize)]
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
    },
    Npm {
        package: String,
        version: String,
    },
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
    let (manifest, source) = match parse(input)? {
        Source::Directory(path) => tokio::task::spawn_blocking(move || read_directory(path))
            .await
            .map_err(|_| invalid("Could not read the plugin directory"))??,
        Source::GitHub {
            repository,
            reference,
            directory,
        } => read_github(&client()?, repository, reference, directory).await?,
        Source::Npm { package, selector } => {
            read_npm(&client()?, registry, package, selector).await?
        }
    };
    plugins.apply_with_source(Mutation::Install { manifest }, Some(source))
}

fn parse(input: &str) -> Result<Source<'_>, AppCommandError> {
    let input = input.trim();
    if input.is_empty() || input.len() > 1024 || input.chars().any(char::is_control) {
        return Err(invalid(
            "Enter a plugin package, GitHub repository, or absolute directory path",
        ));
    }
    if Path::new(input).is_absolute() {
        let path = PathBuf::from(input);
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
        return Ok(Source::Directory(path));
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
            && (directory.is_empty() || crate::harness::skills::package::safe_path(directory))
        {
            return Ok(Source::GitHub {
                repository,
                reference,
                directory,
            });
        }
        return Err(invalid(
            "Use a GitHub repository such as owner/repo or https://github.com/owner/repo#ref",
        ));
    }
    let npm = input.strip_prefix("npm:").unwrap_or(input);
    let (package, selector) = npm
        .char_indices()
        .skip(1)
        .find(|&(_, c)| c == '@')
        .map_or((npm, "latest"), |(index, _)| {
            (&npm[..index], &npm[index + 1..])
        });
    let valid_name = if let Some(scoped) = package.strip_prefix('@') {
        scoped
            .split_once('/')
            .is_some_and(|(scope, name)| valid_part(scope) && valid_part(name))
    } else {
        valid_part(package)
    };
    if valid_name && package.len() <= 214 && selector.len() <= 128 && valid_part(selector) {
        return Ok(Source::Npm { package, selector });
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

fn read_directory(path: PathBuf) -> Result<(String, InstalledSource), AppCommandError> {
    let manifest = path.join(FILE_NAME);
    let metadata = std::fs::symlink_metadata(&manifest)
        .map_err(|_| invalid("The host directory does not contain codeg-plugin.json"))?;
    if !metadata.is_file() {
        return Err(invalid("codeg-plugin.json must be a regular file"));
    }
    let file =
        std::fs::File::open(manifest).map_err(|_| invalid("Could not open codeg-plugin.json"))?;
    Ok((
        read_manifest(file)?,
        InstalledSource::Directory {
            path: path.to_string_lossy().into_owned(),
        },
    ))
}

fn read_manifest(reader: impl Read) -> Result<String, AppCommandError> {
    let mut text = String::new();
    reader
        .take(MAX_MANIFEST_BYTES as u64 + 1)
        .read_to_string(&mut text)
        .map_err(|_| invalid("Could not read codeg-plugin.json as UTF-8"))?;
    if text.len() > MAX_MANIFEST_BYTES {
        return Err(invalid("Plugin manifest exceeds 64 KiB"));
    }
    Ok(text)
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
) -> Result<(String, InstalledSource), AppCommandError> {
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
    Ok((
        read_manifest(bytes.as_slice())?,
        InstalledSource::GitHub {
            repository: repository.to_owned(),
            commit: sha,
            directory: directory.to_owned(),
        },
    ))
}

async fn read_npm(
    client: &reqwest::Client,
    registry: Registry,
    package: &str,
    selector: &str,
) -> Result<(String, InstalledSource), AppCommandError> {
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
    let manifest = tokio::task::spawn_blocking(move || verified_manifest(&bytes, &expected))
        .await
        .map_err(|_| invalid("Could not read the plugin archive"))??;
    Ok((
        manifest,
        InstalledSource::Npm {
            package: package_info.name,
            version: package_info.version,
        },
    ))
}

fn verified_manifest(bytes: &[u8], expected: &[u8]) -> Result<String, AppCommandError> {
    if &Sha512::digest(bytes)[..] != expected {
        return Err(invalid(
            "Downloaded plugin package failed its integrity check",
        ));
    }
    manifest_from_archive(bytes)
}

fn manifest_from_archive(bytes: &[u8]) -> Result<String, AppCommandError> {
    let mut archive =
        tar::Archive::new(GzDecoder::new(Cursor::new(bytes)).take(MAX_UNPACKED_BYTES));
    let malformed = |_| invalid("Could not read the plugin archive");
    let mut manifest = None;
    for entry in archive.entries().map_err(malformed)? {
        let entry = entry.map_err(malformed)?;
        if entry.path_bytes().as_ref() != b"package/codeg-plugin.json" {
            continue;
        }
        if manifest.is_some() || !entry.header().entry_type().is_file() {
            return Err(invalid(
                "Plugin package must contain one regular codeg-plugin.json",
            ));
        }
        manifest = Some(read_manifest(entry)?);
    }
    manifest.ok_or_else(|| invalid("Plugin package does not contain codeg-plugin.json"))
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
            verified_manifest(&package, &Sha512::digest(&package)).unwrap(),
            SAMPLE
        );
        assert!(verified_manifest(&package, &[0; 64]).is_err());
        assert!(manifest_from_archive(&archive(&[path, path], SAMPLE)).is_err());
        assert!(
            manifest_from_archive(&archive(&["package/sub/codeg-plugin.json"], SAMPLE)).is_err()
        );
        assert!(
            manifest_from_archive(&archive(&[path], &"x".repeat(MAX_MANIFEST_BYTES + 1))).is_err()
        );
    }
}
