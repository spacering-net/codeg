//! A standalone test process with an isolated Codeg data directory and a loopback origin.
use codeg_lib::harness::{Harness, HarnessError};
use codeg_lib::srn::{client::SrnApi, error::SrnError, pkce::AccessToken};

#[tokio::test]
async fn disabling_spacering_stops_both_clients_before_they_open_a_connection() {
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    std::env::set_var("CODEG_DATA_DIR", dir.path());
    std::env::set_var("CODEG_SRN_ORIGIN", &origin);
    std::env::remove_var("CODEG_HARNESS");
    std::env::remove_var("CODEG_SRN");

    let catalog = Harness::from_env(dir.path());
    assert!(catalog.enabled());
    let api = SrnApi::new(catalog.origin().clone());
    let token = AccessToken::parse(&"a".repeat(43)).unwrap();
    let marker = dir.path().join("spacering-offline");
    std::fs::write(&marker, []).unwrap();
    for _ in 0..2 {
        assert!(!catalog.enabled());
        assert!(matches!(
            catalog.config().await,
            Err(HarnessError::Disabled)
        ));
        assert!(matches!(
            api.me(&token).await,
            Err(SrnError::OnlineDisabled)
        ));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), listener.accept())
                .await
                .is_err()
        );
        std::env::set_var("CODEG_SRN", "off");
        if marker.exists() {
            std::fs::remove_file(&marker).unwrap();
        }
    }

    std::env::remove_var("CODEG_SRN");
    assert!(catalog.enabled());
    // A release build pins the production origin. The positive control runs only on loopback.
    if catalog.origin().as_str() == origin {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let peer = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf).await.unwrap();
                stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            }
        });
        assert!(matches!(api.me(&token).await, Err(SrnError::Unauthorized)));
        assert!(!matches!(
            catalog.config().await,
            Err(HarnessError::Disabled)
        ));
        tokio::time::timeout(std::time::Duration::from_secs(3), peer)
            .await
            .unwrap()
            .unwrap();
    }
}
