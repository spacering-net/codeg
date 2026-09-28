//! Where the tunnel may connect to, and how it gets there.
//!
//! The tunnel sits behind codeg's token, and that token already runs
//! arbitrary commands on this host (`terminal_spawn`): letting its holder
//! reach any address from here adds no power they did not have. So the
//! default is `all` — a dev page on this host pulls fonts, CDN scripts and
//! OAuth pages from the internet, and a remote tab must behave as it would
//! here. `CODEG_BROWSER_TUNNEL=private` narrows it to this host and the
//! networks it sits on, for deployments that want the tunnel to be only
//! that; `off` turns the endpoint off.
//!
//! The check is on the addresses a name resolved to, and the connection goes
//! to exactly those addresses: a name that resolves to a public address when
//! checked and a private one when dialled (DNS rebinding) cannot slip past.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use tokio::net::TcpStream;

use super::frame::CloseCode;

/// Longest a connection attempt may take, per address.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub const ENV_VAR: &str = "CODEG_BROWSER_TUNNEL";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelPolicy {
    /// No tunnel at all: the endpoint answers 403.
    Off,
    /// This host (loopback) and the private networks it is on.
    Private,
    /// Anywhere this host can reach.
    All,
}

impl TunnelPolicy {
    /// `value` is the environment variable: unset or empty means the default
    /// (`all`). An unknown value is refused rather than guessed at — the
    /// caller decides what a typo costs (see `current`).
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            None | Some("") | Some("all") => Ok(Self::All),
            Some("private") => Ok(Self::Private),
            Some("off") => Ok(Self::Off),
            Some(other) => Err(format!(
                "{ENV_VAR}={other:?} is not one of all, private, off"
            )),
        }
    }

    /// The policy this process runs with. A value that cannot be read turns
    /// the tunnel off: somebody meant to restrict it.
    pub fn current() -> Self {
        let value = std::env::var(ENV_VAR).ok();
        Self::parse(value.as_deref()).unwrap_or_else(|err| {
            tracing::warn!("[browser-tunnel] {err}; the tunnel is off");
            Self::Off
        })
    }

    pub fn allows(self, ip: IpAddr) -> bool {
        match self {
            Self::Off => false,
            Self::All => true,
            Self::Private => is_local_network(ip),
        }
    }
}

/// This host, or a network it sits on: loopback, the unspecified address
/// (which connects to this host), RFC 1918, link-local, IPv6 unique-local.
/// Link-local includes 169.254.169.254, a cloud host's metadata service —
/// on the host's own network, and as reachable from its shell as from here.
fn is_local_network(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_unspecified() || v4.is_private() || v4.is_link_local()
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
        }
    }
}

/// `localhost` and every `*.localhost` name: always this host (RFC 6761),
/// never a question for DNS — a resolver that answered otherwise would send
/// the page somewhere else. A browser that bypasses its proxy for `localhost`
/// itself (WebKit does) reaches this host through such a subdomain instead.
fn is_localhost_name(host: &str) -> bool {
    let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    host == "localhost" || host.ends_with(".localhost")
}

/// The addresses to try for `host:port`, in order.
pub async fn resolve(host: &str, port: u16) -> Result<Vec<SocketAddr>, (CloseCode, String)> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    if is_localhost_name(host) {
        // IPv4 first: most dev servers listen there, and one that listens on
        // `::1` only is found on the second try.
        return Ok(vec![
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
        ]);
    }
    // Bounded like the connection itself: a resolver that never answers
    // must not hold the stream open for good.
    let lookup = tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::lookup_host((host, port)));
    let Ok(looked_up) = lookup.await else {
        return Err((CloseCode::Timeout, format!("{host} did not resolve in time")));
    };
    match looked_up {
        Ok(addrs) => {
            let addrs: Vec<SocketAddr> = addrs.collect();
            if addrs.is_empty() {
                Err((CloseCode::Unreachable, format!("{host} did not resolve")))
            } else {
                Ok(addrs)
            }
        }
        Err(err) => Err((CloseCode::Unreachable, format!("{host} did not resolve: {err}"))),
    }
}

/// Connect to `host:port` as `policy` allows, trying each allowed address in
/// turn. The error names the first thing that decided the outcome.
pub async fn dial(
    host: &str,
    port: u16,
    policy: TunnelPolicy,
) -> Result<TcpStream, (CloseCode, String)> {
    let candidates = resolve(host, port).await?;
    let allowed: Vec<SocketAddr> = candidates
        .iter()
        .copied()
        .filter(|addr| policy.allows(addr.ip()))
        .collect();
    if allowed.is_empty() {
        return Err((
            CloseCode::NotAllowed,
            format!("{host}:{port} is outside what this server's tunnel may reach"),
        ));
    }
    let mut last = (CloseCode::Unreachable, format!("{host}:{port} could not be reached"));
    for addr in allowed {
        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
            Ok(Ok(stream)) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Ok(Err(err)) if err.kind() == std::io::ErrorKind::ConnectionRefused => {
                last = (CloseCode::Refused, format!("nothing listens at {addr}"));
            }
            Ok(Err(err)) => last = (CloseCode::Unreachable, format!("{addr}: {err}")),
            Err(_) => last = (CloseCode::Timeout, format!("{addr} did not answer in time")),
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn the_default_is_everywhere_and_a_typo_is_refused() {
        assert_eq!(TunnelPolicy::parse(None), Ok(TunnelPolicy::All));
        assert_eq!(TunnelPolicy::parse(Some("")), Ok(TunnelPolicy::All));
        assert_eq!(TunnelPolicy::parse(Some(" Private ")), Ok(TunnelPolicy::Private));
        assert_eq!(TunnelPolicy::parse(Some("OFF")), Ok(TunnelPolicy::Off));
        assert!(TunnelPolicy::parse(Some("privat")).is_err());
    }

    #[test]
    fn private_means_this_host_and_its_networks() {
        let private = TunnelPolicy::Private;
        for allowed in [
            "127.0.0.1", "127.8.9.10", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255",
            "192.168.1.1", "169.254.169.254", "::1", "::", "fd00::1", "fe80::1",
            // IPv4-mapped IPv6 is judged as the IPv4 address it carries.
            "::ffff:127.0.0.1", "::ffff:192.168.0.1",
        ] {
            assert!(private.allows(ip(allowed)), "{allowed} should be allowed");
        }
        for refused in ["8.8.8.8", "172.32.0.1", "100.64.0.1", "2001:db8::1", "::ffff:8.8.8.8"] {
            assert!(!private.allows(ip(refused)), "{refused} should be refused");
        }
        assert!(TunnelPolicy::All.allows(ip("8.8.8.8")));
        assert!(!TunnelPolicy::Off.allows(ip("127.0.0.1")));
    }

    #[tokio::test]
    async fn localhost_names_are_this_host_without_asking_dns() {
        for host in ["localhost", "LOCALHOST", "localhost.", "remote.localhost", "a.b.localhost"] {
            let addrs = resolve(host, 3000).await.unwrap();
            assert_eq!(
                addrs,
                vec!["127.0.0.1:3000".parse().unwrap(), "[::1]:3000".parse().unwrap()],
                "{host}"
            );
        }
        assert_eq!(
            resolve("192.168.1.9", 80).await.unwrap(),
            vec!["192.168.1.9:80".parse().unwrap()]
        );
        assert_eq!(resolve("::1", 80).await.unwrap(), vec!["[::1]:80".parse().unwrap()]);
    }

    #[tokio::test]
    async fn a_refused_destination_is_refused_and_a_disallowed_one_is_not_dialled() {
        // A port nothing listens on: bind, learn the port, close.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let (code, _) = dial("127.0.0.1", port, TunnelPolicy::All).await.unwrap_err();
        assert_eq!(code, CloseCode::Refused);
        let (code, _) = dial("8.8.8.8", 53, TunnelPolicy::Private).await.unwrap_err();
        assert_eq!(code, CloseCode::NotAllowed);
    }

    #[tokio::test]
    async fn a_localhost_name_reaches_a_server_on_either_loopback() {
        let v6 = tokio::net::TcpListener::bind("[::1]:0").await;
        // Some CI hosts have no IPv6 loopback; the IPv4 case still runs.
        if let Ok(listener) = v6 {
            let port = listener.local_addr().unwrap().port();
            let accept = tokio::spawn(async move { listener.accept().await.map(|_| ()) });
            let stream = dial("dev.localhost", port, TunnelPolicy::Private).await.unwrap();
            assert!(stream.peer_addr().unwrap().is_ipv6());
            accept.await.unwrap().unwrap();
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accept = tokio::spawn(async move { listener.accept().await.map(|_| ()) });
        let stream = dial("localhost", port, TunnelPolicy::Private).await.unwrap();
        assert!(stream.peer_addr().unwrap().is_ipv4());
        accept.await.unwrap().unwrap();
    }
}
