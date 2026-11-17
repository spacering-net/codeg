//! Which remote addresses Codeg writes into an agent's config.
//!
//! Harness lists an imported server whose endpoint is not public with a
//! `remote_not_public` reason, but still hands out its `server.json` as
//! published. So Codeg checks the address itself, after the user's values
//! are in it, and is the final guard: its rule is the website's
//! (`isPublicHttps` in `api/harness/mcp.ts`) and stricter. Everything the
//! site refuses is refused here too; on top of that, a host is judged as the
//! address it parses to, not as text:
//!
//! - a name with a trailing dot is the same name (`localhost.` is localhost);
//! - an IPv4 address is checked against every range that is not public
//!   (private, shared, loopback, link-local, documentation, benchmarking,
//!   6to4 relay, multicast, reserved, broadcast);
//! - an IPv6 address likewise (unspecified, loopback, link-local `fe80::/10`,
//!   unique-local `fc00::/7`, multicast, documentation, discard), and one that
//!   carries an IPv4 address (mapped `::ffff:0:0/96`, compatible `::/96`,
//!   NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) is judged by that IPv4 address.
//!
//! Both sides parse with the WHATWG URL rules (`new URL` there, the `url`
//! crate here), so an address is judged in the form it would be requested
//! in: `https://2130706433/` is `127.0.0.1`.

use std::net::{Ipv4Addr, Ipv6Addr};

use url::{Host, Url};

/// Whether `raw` is an `https:` address without credentials whose host is
/// public: not this machine, a private, shared, link-local or reserved
/// network, or a name that only resolves inside one.
pub fn is_public_https(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.host() {
        Some(Host::Domain(name)) => is_public_name(name),
        Some(Host::Ipv4(ip)) => is_public_v4(ip),
        Some(Host::Ipv6(ip)) => is_public_v6(ip),
        None => false,
    }
}

/// A host name, as the site judges one, with trailing dots ignored.
fn is_public_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let name = name.trim_end_matches('.');
    // What is left of a name that was all dots, or that the URL parser did
    // not already take for an address, judged as an address all the same.
    if let Ok(ip) = name.parse::<Ipv4Addr>() {
        return is_public_v4(ip);
    }
    !(name.is_empty()
        || name == "localhost"
        || name.ends_with(".localhost")
        || name.ends_with(".local")
        || name.ends_with(".internal")
        || name.ends_with(".lan")
        || !name.contains('.'))
}

/// Not in any IPv4 range that is not public (IANA special-purpose
/// registry: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12,
/// 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15,
/// 198.51.100/24, 203.0.113/24, 224/4, 240/4 with 255.255.255.255).
pub(crate) fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || (a == 100 && (64..=127).contains(&b))
        || a == 127
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

/// Not in any IPv6 range that is not public, and, for an address that
/// carries an IPv4 address, that one public too.
pub(crate) fn is_public_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    if ip.is_unspecified() || ip.is_loopback() {
        return false;
    }
    let embedded =
        |high: usize| Ipv4Addr::from(((segments[high] as u32) << 16) | segments[high + 1] as u32);
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible)
    if segments[..5] == [0; 5] && (segments[5] == 0xffff || segments[5] == 0) {
        return is_public_v4(embedded(6));
    }
    // 64:ff9b::a.b.c.d (NAT64)
    if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return is_public_v4(embedded(6));
    }
    // 2002:aabb:ccdd::/48 (6to4)
    if segments[0] == 0x2002 {
        return is_public_v4(embedded(1));
    }
    !((segments[0] & 0xffc0) == 0xfe80 // link-local, fe80::/10
        || (segments[0] & 0xfe00) == 0xfc00 // unique local, fc00::/7
        || (segments[0] & 0xff00) == 0xff00 // multicast, ff00::/8
        || (segments[0] == 0x2001 && segments[1] == 0x0db8) // documentation
        || segments[..4] == [0x0100, 0, 0, 0]) // discard, 100::/64
}

/// The host of `raw`, for a message; empty when it has none.
pub(crate) fn host_of(raw: &str) -> String {
    Url::parse(raw)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The website's own cases (`tests/harness/formats.test.mjs`,
    /// "isPublicHttps refuses this machine, private networks and plain
    /// http").
    #[test]
    fn the_websites_cases() {
        for ok in ["https://mcp.example.org/x", "https://8.8.8.8/"] {
            assert!(is_public_https(ok), "{ok}");
        }
        for bad in [
            "http://mcp.example.org",
            "https://localhost:3000",
            "https://192.168.1.2",
            "https://10.1.2.3",
            "https://172.20.0.1",
            "https://[::1]/",
            "https://printer.local",
            "https://user:pw@a.io",
            "https://intranet",
        ] {
            assert!(!is_public_https(bad), "{bad}");
        }
    }

    /// The website's function, run in Node (2026-11-16): what it answered for
    /// each address. Codeg refuses everything it refuses; where it accepts,
    /// [`codeg_is_stricter_than_the_site`] says which Codeg still refuses.
    const SITE: &[(&str, bool)] = &[
        ("https://mcp.example.com/mcp", true),
        ("https://MCP.Example.COM/mcp", true),
        ("https://a.io", true),
        ("https://user@a.io", false),
        ("https://:pw@a.io", false),
        ("https://:@a.io/", true),
        ("https://@a.io/", true),
        ("https://localhost", false),
        ("https://LOCALHOST./", true),
        ("https://localhost./", true),
        ("https://app.localhost", false),
        ("https://box.local", false),
        ("https://db.internal", false),
        ("https://nas.lan", false),
        ("https://example.com.", true),
        ("https://example", false),
        ("https://127.0.0.1", false),
        ("https://127.1", false),
        ("https://2130706433/", false),
        ("https://0x7f.0.0.1/", false),
        ("https://0177.0.0.1/", false),
        ("https://0.0.0.0", false),
        ("https://0.1.2.3", false),
        ("https://169.254.1.1", false),
        ("https://169.253.1.1", true),
        ("https://172.15.0.1", true),
        ("https://172.16.0.1", false),
        ("https://172.31.255.255", false),
        ("https://172.32.0.1", true),
        ("https://192.168.0.1", false),
        ("https://192.169.0.1", true),
        ("https://100.63.0.1", true),
        ("https://100.64.0.1", false),
        ("https://100.127.0.1", false),
        ("https://100.128.0.1", true),
        ("https://223.255.255.255", true),
        ("https://224.0.0.1", false),
        ("https://255.255.255.255", false),
        ("https://1.1.1.1:8443/x", true),
        ("https://999.1.1.1", false),
        ("https://1.2.3.4.5", false),
        ("https://[::]/", false),
        ("https://[0:0:0:0:0:0:0:1]/", false),
        ("https://[fc00::1]/", false),
        ("https://[fd12:3456::1]/", false),
        ("https://[fe80::1]/", false),
        ("https://[FE80::1]/", false),
        ("https://[fe81::1]/", true),
        ("https://[2001:4860:4860::8888]/", true),
        ("https://[::ffff:127.0.0.1]/", true),
        ("https://[::ffff:10.0.0.1]/", true),
        ("ftp://a.io", false),
        ("wss://a.io/x", false),
        ("HTTPS://a.io", true),
        ("https:a.io", true),
        ("https:/a.io", true),
        ("https:\\\\a.io\\x", true),
        ("  https://a.io  ", true),
        ("https://a.io:443", true),
        ("https://a.io?x=1#y", true),
        ("https://xn--bcher-kva.example", true),
        ("https://bücher.example", true),
        ("not a url", false),
        ("", false),
        ("https://", false),
        ("https://exa mple.com", false),
        ("https://%6cocalhost/", false),
        ("https://local%68ost/", false),
        ("https://a..b", true),
    ];

    /// The site's rule judges text; Codeg judges the address. These the site
    /// lets through, and Codeg does not.
    const STRICTER: &[&str] = &[
        "https://LOCALHOST./",
        "https://localhost./",
        "https://[fe81::1]/",
        "https://[::ffff:127.0.0.1]/",
        "https://[::ffff:10.0.0.1]/",
    ];

    #[test]
    fn whatever_the_site_refuses_codeg_refuses() {
        for (raw, site) in SITE {
            if !site {
                assert!(!is_public_https(raw), "{raw:?}: the site refuses it");
            }
        }
        for (raw, site) in SITE {
            if *site {
                assert_eq!(is_public_https(raw), !STRICTER.contains(raw), "{raw:?}");
            }
        }
    }

    #[test]
    fn codeg_is_stricter_than_the_site() {
        let refused = [
            // a trailing dot names the same host
            "https://localhost./mcp",
            "https://localhost../mcp",
            "https://app.localhost./mcp",
            "https://printer.local./mcp",
            "https://intranet./mcp",
            "https://127.0.0.1./mcp",
            // IPv4 ranges the site does not list
            "https://192.0.0.8/",
            "https://192.0.2.1/",
            "https://192.88.99.1/",
            "https://198.18.0.1/",
            "https://198.19.255.254/",
            "https://198.51.100.7/",
            "https://203.0.113.9/",
            "https://240.0.0.1/",
            // link-local is fe80::/10, not just `fe80:`
            "https://[fe81::1]/",
            "https://[febf::1]/",
            "https://[ff02::1]/",
            "https://[2001:db8::1]/",
            "https://[100::1]/",
            // an IPv4 address carried in an IPv6 one is judged as itself
            "https://[::ffff:127.0.0.1]/",
            "https://[::ffff:7f00:1]/",
            "https://[::ffff:10.0.0.1]/",
            "https://[::ffff:192.168.1.1]/",
            "https://[::10.0.0.1]/",
            "https://[::127.0.0.1]/",
            "https://[64:ff9b::10.0.0.1]/",
            "https://[64:ff9b::7f00:1]/",
            "https://[2002:a00:1::1]/",
            "https://[2002:7f00:1::]/",
            "https://[2002:c0a8:101::1]/",
        ];
        for raw in refused {
            assert!(!is_public_https(raw), "{raw:?}");
        }
        let public = [
            "https://mcp.example.com./mcp",
            "https://192.0.1.1/",
            "https://192.88.98.1/",
            "https://198.17.255.255/",
            "https://198.20.0.1/",
            "https://203.0.114.1/",
            "https://223.255.255.255/",
            "https://[fec0::1]/",
            "https://[2001:db9::1]/",
            "https://[100:0:0:1::1]/",
            "https://[::ffff:8.8.8.8]/",
            "https://[64:ff9b::808:808]/",
            "https://[2002:808:808::1]/",
            "https://[2606:4700:4700::1111]/",
        ];
        for raw in public {
            assert!(is_public_https(raw), "{raw:?}");
        }
    }

    #[test]
    fn a_host_is_named_for_the_message() {
        assert_eq!(
            host_of("https://user:pw@Mcp.Example.com:8443/x"),
            "mcp.example.com"
        );
        assert_eq!(host_of("http://10.0.0.1/mcp"), "10.0.0.1");
        assert_eq!(host_of("not a url"), "");
    }
}
