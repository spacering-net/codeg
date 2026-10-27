use super::*;

#[test]
fn pi_native_configuration_preserves_policies_extensions_and_other_servers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("custom-profile/mcp.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let native = json!({"extensions":{"keep":true}, "mcpServers":{
        "local":{"command":"old", "cwd":"/work", "exposure":"deferred", "toolExposure":{"read":"direct"}, "timeout":123},
        "remote":{"url":"https://example.test/mcp","auth":{"provider":"oauth"}}
    }});
    write_json_file(&path, &native).unwrap();
    upsert_pi_server_at(
        &path,
        "local",
        &json!({"type":"stdio","command":"new","args":["--ok"],"env":{"TOKEN":"!literal$VALUE"}}),
    )
    .unwrap();
    let changed = read_json_file(&path).unwrap();
    assert_eq!(changed["extensions"], native["extensions"]);
    assert_eq!(
        changed["mcpServers"]["remote"],
        native["mcpServers"]["remote"]
    );
    let local = &changed["mcpServers"]["local"];
    for key in ["cwd", "exposure", "toolExposure", "timeout"] {
        assert_eq!(local[key], native["mcpServers"]["local"][key]);
    }
    assert_eq!(local["env"]["TOKEN"], "!literal$VALUE"); // Native config retains Pi's native expressions.
    assert!(local.get("type").is_none());
    upsert_pi_server_at(
        &path,
        "local",
        &json!({"type":"http","url":"http://127.0.0.1/mcp","headers":{"x-key":"$SECRET"}}),
    )
    .unwrap();
    let changed = read_json_file(&path).unwrap();
    assert!(changed["mcpServers"]["local"].get("command").is_none());
    assert_eq!(changed["mcpServers"]["local"]["exposure"], "deferred");
    assert!(remove_pi_server_at(&path, "local").unwrap());
    assert!(!remove_pi_server_at(&path, "local").unwrap());
    assert_eq!(read_pi_servers_at(&path).unwrap().len(), 1);
}

#[test]
fn pi_sse_and_malformed_configuration_are_rejected_without_writes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mcp.json");
    assert!(upsert_pi_server_at(
        &path,
        "sse",
        &json!({"type":"sse","url":"http://127.0.0.1/sse"})
    )
    .is_err());
    assert!(!path.exists());
    for original in ["[]", r#"{"mcpServers":"keep"}"#] {
        std::fs::write(&path, original).unwrap();
        assert!(read_pi_servers_at(&path).is_err());
        assert!(upsert_pi_server_at(&path, "new", &json!({"command":"bin"})).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }
}

#[test]
fn pi_scan_targets_the_selected_profile_without_changing_process_environment() {
    let dir = tempfile::tempdir().unwrap();
    let paths = McpPaths {
        pi: dir.path().join("selected/mcp.json"),
    };
    paths
        .upsert(McpAppType::Pi, "selected", &json!({"command":"test-bin"}))
        .unwrap();
    fn must_not_read_default() -> LocalMcpReadResult {
        panic!("must use selected profile")
    }
    let readers = [LocalMcpReader::new(
        "pi",
        McpAppType::Pi,
        must_not_read_default,
    )];
    let scanned = scan_local_servers_with_pi(&readers, Some(&paths.pi));
    assert_eq!(scanned.servers.len(), 1);
    assert_eq!(scanned.servers[0].id, "selected");
    assert!(paths.remove(McpAppType::Pi, "selected").unwrap());
}
