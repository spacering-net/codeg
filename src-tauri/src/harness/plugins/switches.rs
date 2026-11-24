//! The server's switch for native plugin installs: `/config`'s
//! `plugins.adapters`, `{ <host>: { enabled, minVersion, maxVersion } }`,
//! keyed by `PluginHost.host`.
//!
//! A host may take a plugin natively only if this Codeg has an adapter for
//! it ([`BUILT_IN_MINIMUMS`]), the server lists it as enabled, and the
//! host's version is at least the higher of the server's and the built-in
//! minimum and at most the server's maximum. Everything else fails closed:
//! a missing or malformed `plugins`, `adapters`, host entry or version
//! leaves that host to skills only — never the other way round.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use semver::Version;
use serde_json::Value;

/// The hosts this Codeg has an adapter for, each with the oldest version
/// the adapter was tested against (P0). The server can raise a minimum,
/// never lower one.
pub const BUILT_IN_MINIMUMS: &[(&str, &str)] = &[
    ("claude", "2.1.185"),
    ("codex", "0.149.1"),
    ("opencode", "2.3.2"),
];

/// One host the server lets take plugins natively, with its versions.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Range {
    /// `None`: the server sets none (the built-in one still holds).
    min: Option<Version>,
    /// `None`: no limit.
    max: Option<Version>,
}

/// What `/config` says of native plugin installs, read once per answer.
/// The default allows nothing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AdapterSwitches {
    /// Only hosts whose entry is well formed and enabled.
    enabled: BTreeMap<String, Range>,
}

impl AdapterSwitches {
    /// Read off `/config`'s answer as it came (`Harness::config()`).
    pub fn from_config(config: &Value) -> Self {
        let Some(adapters) = config
            .get("plugins")
            .and_then(|plugins| plugins.get("adapters"))
            .and_then(Value::as_object)
        else {
            return Self::default();
        };
        let enabled = adapters
            .iter()
            .filter_map(|(host, entry)| Some((host.clone(), range_of(entry)?)))
            .collect();
        Self { enabled }
    }

    /// Whether the server lets `host` take plugins natively at some
    /// version, and this Codeg has an adapter for it.
    pub fn enabled(&self, host: &str) -> bool {
        built_in_minimum(host).is_some() && self.enabled.contains_key(host)
    }

    /// Whether a plugin may be installed natively into `host` at `version`.
    pub fn allows(&self, host: &str, version: &Version) -> bool {
        let Some(built_in) = built_in_minimum(host) else {
            return false;
        };
        let Some(range) = self.enabled.get(host) else {
            return false;
        };
        // By precedence: build metadata (`2.3.2+vendor`) is no other version.
        let at_least = |min: &Version| version.cmp_precedence(min) != Ordering::Less;
        at_least(&built_in)
            && range.min.as_ref().is_none_or(at_least)
            && range
                .max
                .as_ref()
                .is_none_or(|max| version.cmp_precedence(max) != Ordering::Greater)
    }
}

/// The adapter's own minimum for `host`; `None` when this Codeg has no
/// adapter for it.
fn built_in_minimum(host: &str) -> Option<Version> {
    BUILT_IN_MINIMUMS
        .iter()
        .find(|(id, _)| *id == host)
        .and_then(|(_, version)| Version::parse(version).ok())
}

/// One host's entry, if it is well formed and enabled: `enabled` exactly
/// `true`, and each of `minVersion` and `maxVersion` present, either `null`
/// or a version.
fn range_of(entry: &Value) -> Option<Range> {
    let entry = entry.as_object()?;
    if entry.get("enabled")?.as_bool()? {
        Some(Range {
            min: version_field(entry.get("minVersion")?)?,
            max: version_field(entry.get("maxVersion")?)?,
        })
    } else {
        None
    }
}

/// `null` → `Some(None)`; a version → `Some(Some(_))`; anything else →
/// `None` (the entry is malformed).
fn version_field(value: &Value) -> Option<Option<Version>> {
    match value {
        Value::Null => Some(None),
        Value::String(text) => Version::parse(text).ok().map(Some),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    /// `/config` as spacering.net answers it, with `plugins.adapters` as
    /// the website's `PLUGIN_ADAPTERS` has it (production sends it from the
    /// next deploy).
    fn config(adapters: Value) -> Value {
        json!({
            "limits": { "zipBytes": 10485760, "totalBytes": 31457280, "files": 500, "fileBytes": 5242880,
                        "depth": 10, "pathBytes": 512, "compression": { "minBytes": 1048576, "ratio": 100 },
                        "textBytes": 102400, "descriptionChars": 1024 },
            "kinds": ["skill", "mcp", "prompt", "assistant", "connector", "plugin"],
            "sorts": ["popular", "new", "updated"],
            "runtimes": [], "tags": [], "review": "off",
            "plugins": { "adapters": adapters }
        })
    }

    fn website() -> Value {
        json!({
            "claude": { "enabled": true, "minVersion": "2.1.185", "maxVersion": null },
            "codex": { "enabled": true, "minVersion": "0.149.1", "maxVersion": null },
            "opencode": { "enabled": true, "minVersion": "2.3.2", "maxVersion": null }
        })
    }

    #[test]
    fn the_website_s_switches_allow_each_host_from_its_minimum() {
        let switches = AdapterSwitches::from_config(&config(website()));
        assert!(switches.allows("claude", &v("2.1.185")));
        assert!(switches.allows("claude", &v("3.0.0")));
        assert!(!switches.allows("claude", &v("2.1.184")));
        assert!(!switches.allows("claude", &v("2.1.185-beta.1")));
        assert!(switches.allows("codex", &v("0.149.1")));
        assert!(!switches.allows("codex", &v("0.149.0")));
        assert!(switches.allows("opencode", &v("2.3.2")));
        assert!(!switches.allows("opencode", &v("1.14.0")));
        assert!(switches.enabled("claude"));
        // a host the server lists but this Codeg has no adapter for
        let mut more = website();
        more["cursor"] = json!({ "enabled": true, "minVersion": null, "maxVersion": null });
        let switches = AdapterSwitches::from_config(&config(more));
        assert!(!switches.allows("cursor", &v("9.9.9")));
        assert!(!switches.enabled("cursor"));
        assert!(!switches.allows("", &v("9.9.9")));
    }

    #[test]
    fn without_the_switch_every_host_is_off() {
        let today = json!({ "limits": {}, "kinds": ["skill"], "review": "off" });
        for config in [
            today,
            json!(null),
            json!([]),
            json!({ "plugins": null }),
            json!({ "plugins": [] }),
            json!({ "plugins": {} }),
            json!({ "plugins": { "adapters": null } }),
            json!({ "plugins": { "adapters": [website()] } }),
            json!({ "plugins": { "adapters": {} } }),
        ] {
            let switches = AdapterSwitches::from_config(&config);
            assert_eq!(switches, AdapterSwitches::default(), "{config}");
            for (host, _) in BUILT_IN_MINIMUMS {
                assert!(!switches.allows(host, &v("99.0.0")), "{config}");
                assert!(!switches.enabled(host), "{config}");
            }
        }
    }

    #[test]
    fn a_malformed_or_disabled_entry_turns_only_that_host_off() {
        for entry in [
            json!({ "enabled": false, "minVersion": null, "maxVersion": null }),
            json!({ "enabled": "true", "minVersion": null, "maxVersion": null }),
            json!({ "enabled": 1, "minVersion": null, "maxVersion": null }),
            json!({ "minVersion": null, "maxVersion": null }),
            json!({ "enabled": true, "maxVersion": null }),
            json!({ "enabled": true, "minVersion": null }),
            json!({ "enabled": true, "minVersion": "2.1", "maxVersion": null }),
            json!({ "enabled": true, "minVersion": "latest", "maxVersion": null }),
            json!({ "enabled": true, "minVersion": 2, "maxVersion": null }),
            json!({ "enabled": true, "minVersion": null, "maxVersion": "" }),
            json!({ "enabled": true, "minVersion": " 2.1.185 ", "maxVersion": null }),
            json!({ "enabled": true, "minVersion": "v2.1.185", "maxVersion": null }),
            json!({ "enabled": true, "minVersion": null, "maxVersion": ["3.0.0"] }),
            json!(true),
            json!(null),
            json!("on"),
        ] {
            let mut adapters = website();
            adapters["claude"] = entry.clone();
            let switches = AdapterSwitches::from_config(&config(adapters));
            assert!(!switches.allows("claude", &v("3.0.0")), "{entry}");
            assert!(!switches.enabled("claude"), "{entry}");
            assert!(switches.allows("codex", &v("1.0.0")), "{entry}");
            assert!(switches.allows("opencode", &v("2.3.2")), "{entry}");
        }
        // a host missing from the answer
        let mut adapters = website();
        adapters.as_object_mut().unwrap().remove("codex");
        let switches = AdapterSwitches::from_config(&config(adapters));
        assert!(!switches.allows("codex", &v("1.0.0")));
        assert!(switches.allows("claude", &v("3.0.0")));
    }

    #[test]
    fn the_range_is_the_higher_minimum_up_to_the_server_s_maximum() {
        let switches = AdapterSwitches::from_config(&config(json!({
            // the server's minimum below the built-in one: the built-in holds
            "claude": { "enabled": true, "minVersion": "2.0.0", "maxVersion": "2.2.0" },
            // above it: the server's holds
            "codex": { "enabled": true, "minVersion": "0.150.0", "maxVersion": null },
            // none from the server: the built-in holds
            "opencode": { "enabled": true, "minVersion": null, "maxVersion": "2.3.2" }
        })));
        assert!(!switches.allows("claude", &v("2.1.0")));
        assert!(!switches.allows("claude", &v("2.1.184")));
        assert!(switches.allows("claude", &v("2.1.185")));
        assert!(switches.allows("claude", &v("2.2.0")));
        assert!(!switches.allows("claude", &v("2.2.1")));
        assert!(!switches.allows("claude", &v("2.2.1-alpha")));
        assert!(!switches.allows("codex", &v("0.149.1")));
        assert!(switches.allows("codex", &v("0.150.0")));
        assert!(switches.allows("codex", &v("10.0.0")));
        assert!(!switches.allows("opencode", &v("2.3.1")));
        assert!(switches.allows("opencode", &v("2.3.2")));
        assert!(!switches.allows("opencode", &v("2.3.3")));
        // build metadata is the same version, at either bound
        assert!(switches.allows("opencode", &v("2.3.2+vendor.1")));
        assert!(switches.allows("claude", &v("2.1.185+build.7")));
        assert!(switches.allows("claude", &v("2.2.0+zz")));
        assert!(!switches.allows("codex", &v("0.149.1+zz")));

        // a maximum below the minimum allows nothing
        let switches = AdapterSwitches::from_config(&config(json!({
            "claude": { "enabled": true, "minVersion": null, "maxVersion": "2.1.0" }
        })));
        assert!(!switches.allows("claude", &v("2.1.0")));
        assert!(!switches.allows("claude", &v("2.1.185")));
    }
}
