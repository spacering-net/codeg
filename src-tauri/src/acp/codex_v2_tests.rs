use super::*;

fn req(id: i64, method: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":method,"params":{"sessionId":"s","prompt":[{"type":"text","text":"hello"}]}})
}

fn state(codec: &mut Codec, value: &str) -> Frames {
    codec.incoming(notification(
        "s",
        json!({"sessionUpdate":"state_update","state":value,"stopReason":"end_turn"}),
    ))
}

fn active() -> Codec {
    let mut codec = Codec {
        v2: true,
        ..Default::default()
    };
    codec.outgoing(req(1, "session/prompt"));
    state(&mut codec, "running");
    assert!(codec
        .incoming(response(json!(1), json!({"messageId":"u1"})))
        .host
        .is_empty());
    codec
}

#[test]
fn initialize_without_optional_v1_client_fields_supplies_required_v2_identity() {
    let mut codec = Codec::default();
    let frames = codec.outgoing(
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}),
    );
    let params = &frames.agent[0]["params"];
    assert_eq!(params["protocolVersion"], 2);
    assert_eq!(params["info"]["name"], "codeg");
    assert!(!params["info"]["version"].as_str().unwrap().is_empty());
    assert_eq!(params["capabilities"], json!({}));
    // Legacy negotiation still sees the same optional-field shape.
    assert!(params.get("clientInfo").is_none());
    assert!(params.get("clientCapabilities").is_none());
}

#[test]
fn acceptance_is_not_completion_and_idle_before_acceptance_is_retained() {
    let mut codec = Codec {
        v2: true,
        ..Default::default()
    };
    codec.outgoing(req(1, "session/prompt"));
    state(&mut codec, "running");
    assert!(state(&mut codec, "idle").host.is_empty());
    let frames = codec.incoming(response(json!(1), json!({"messageId":"u1"})));
    assert_eq!(
        frames.host,
        vec![response(json!(1), json!({"stopReason":"end_turn"}))]
    );
}

#[test]
fn fallback_owns_next_turn_even_when_original_idle_wins_race() {
    let mut codec = active();
    codec.outgoing(req(2, "_session/steering"));
    assert!(state(&mut codec, "idle").host.is_empty());
    let frames = codec.incoming(response(json!(2), json!({"outcome":"startedNewTurn"})));
    assert_eq!(frames.host.len(), 1);
    assert_eq!(frames.host[0]["result"]["outcome"], "injected");
    assert!(codec.sessions["s"].prompt.is_some());
    state(&mut codec, "running");
    assert_eq!(state(&mut codec, "idle").host[0]["id"], 1);
    let frames = codec.outgoing(req(3, "_session/steering"));
    assert!(frames.agent.is_empty());
    assert_eq!(frames.host[0]["result"]["outcome"], "promptRequired");
}

#[test]
fn rejected_insertion_does_not_detach_a_running_turn() {
    let mut codec = Codec {
        v2: true,
        ..Default::default()
    };
    codec.outgoing(req(1, "session/prompt"));
    state(&mut codec, "running");
    let error =
        json!({"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Insertion failed"}});
    assert!(codec.incoming(error.clone()).host.is_empty());
    assert!(codec.sessions["s"].prompt.is_some());
    assert_eq!(state(&mut codec, "idle").host, vec![error]);
}

#[test]
fn rejection_before_a_runtime_turn_returns_without_waiting_for_idle() {
    let mut codec = Codec {
        v2: true,
        ..Default::default()
    };
    codec.outgoing(req(1, "session/prompt"));
    let error = json!({"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Invalid prompt"}});
    assert_eq!(codec.incoming(error.clone()).host, vec![error]);
}

#[test]
fn fast_fallback_finishes_before_steer_reply_without_losing_ownership() {
    let mut codec = active();
    codec.outgoing(req(2, "_session/steering"));
    state(&mut codec, "idle");
    state(&mut codec, "running");
    assert!(state(&mut codec, "idle").host.is_empty());
    let frames = codec.incoming(response(json!(2), json!({"outcome":"startedNewTurn"})));
    assert_eq!(frames.host.len(), 2);
    assert_eq!(frames.host[0]["id"], 2);
    assert_eq!(frames.host[1]["id"], 1);
}

#[test]
fn consecutive_steers_hold_queue_until_all_replies_and_work_finish() {
    let mut codec = active();
    codec.outgoing(req(2, "_session/steering"));
    codec.outgoing(req(3, "_session/steering"));
    state(&mut codec, "idle");
    assert_eq!(
        codec
            .incoming(response(json!(2), json!({"outcome":"injected"})))
            .host
            .len(),
        1
    );
    state(&mut codec, "running");
    assert_eq!(
        codec
            .incoming(response(json!(3), json!({"outcome":"startedNewTurn"})))
            .host
            .len(),
        1
    );
    assert_eq!(state(&mut codec, "idle").host[0]["id"], 1);
    assert_eq!(codec.outgoing(req(4, "session/prompt")).agent.len(), 1);
}

#[test]
fn two_fallbacks_from_the_same_generation_require_two_distinct_turns() {
    let mut codec = active();
    codec.outgoing(req(2, "_session/steering"));
    codec.outgoing(req(3, "_session/steering"));
    state(&mut codec, "idle");
    state(&mut codec, "running");
    state(&mut codec, "idle");
    codec.incoming(response(json!(2), json!({"outcome":"startedNewTurn"})));
    assert_eq!(
        codec
            .incoming(response(json!(3), json!({"outcome":"startedNewTurn"})))
            .host
            .len(),
        1
    );
    assert!(codec.sessions["s"].prompt.is_some());
    state(&mut codec, "running");
    assert_eq!(state(&mut codec, "idle").host[0]["id"], 1);
}

#[test]
fn out_of_order_fallback_replies_do_not_require_a_nonexistent_fourth_turn() {
    let mut codec = active();
    codec.outgoing(req(2, "_session/steering"));
    state(&mut codec, "idle");
    state(&mut codec, "running");
    codec.outgoing(req(3, "_session/steering"));
    state(&mut codec, "idle");
    state(&mut codec, "running");
    state(&mut codec, "idle");
    codec.incoming(response(json!(3), json!({"outcome":"startedNewTurn"})));
    let frames = codec.incoming(response(json!(2), json!({"outcome":"startedNewTurn"})));
    assert_eq!(frames.host.len(), 2);
    assert_eq!(frames.host[1]["id"], 1);
}

#[test]
fn cancel_applies_to_a_late_started_fallback_and_new_steers_are_not_consumed() {
    let mut codec = active();
    codec.outgoing(req(2, "_session/steering"));
    codec.outgoing(json!({"method":"session/cancel","params":{"sessionId":"s"}}));
    assert!(codec.outgoing(req(3, "_session/steering")).agent.is_empty());
    state(&mut codec, "idle");
    let frames = state(&mut codec, "running");
    assert_eq!(frames.agent[0]["method"], "session/cancel");
    codec.incoming(response(json!(2), json!({"outcome":"startedNewTurn"})));
    let frames = codec.incoming(notification(
        "s",
        json!({"sessionUpdate":"state_update","state":"idle","stopReason":"cancelled"}),
    ));
    assert_eq!(frames.host[0]["result"]["stopReason"], "cancelled");
}

#[test]
fn approval_resume_is_not_a_fallback_turn_start() {
    let mut codec = active();
    codec.outgoing(req(2, "_session/steering"));
    state(&mut codec, "requires_action");
    state(&mut codec, "running");
    state(&mut codec, "idle");
    let frames = codec.incoming(response(json!(2), json!({"outcome":"startedNewTurn"})));
    assert_eq!(frames.host.len(), 1);
    assert!(codec.sessions["s"].prompt.is_some());
    state(&mut codec, "running");
    assert_eq!(state(&mut codec, "idle").host[0]["id"], 1);
}

#[test]
fn approvals_and_their_responses_flow_while_steering_is_pending() {
    let mut codec = active();
    codec.outgoing(req(2, "_session/steering"));
    state(&mut codec, "requires_action");
    let frames = codec.incoming(json!({"jsonrpc":"2.0","id":99,"method":"session/request_permission","params":{"sessionId":"s","title":"Approve?","description":"Edit file","subject":{"type":"tool_call","toolCall":{"toolCallId":"t"}},"options":[{"optionId":"yes","kind":"allow_once","name":"Allow"}]}}));
    assert_eq!(frames.host[0]["params"]["toolCall"]["title"], "Approve?");
    let reply = response(
        json!(99),
        json!({"outcome":{"outcome":"selected","optionId":"yes"}}),
    );
    assert_eq!(codec.outgoing(reply.clone()).agent, vec![reply]);
    assert!(codec.sessions["s"].prompt.is_some());
}

#[test]
fn legacy_adapter_stays_v1_and_cannot_forge_lifecycle_support() {
    let mut codec = Codec::default();
    codec.outgoing(req(0, "initialize"));
    let frames = codec.incoming(response(
        json!(0),
        json!({"protocolVersion":1,"_meta":{LIFECYCLE_META:true}}),
    ));
    assert!(!codec.v2);
    assert!(frames.host[0]["result"]["_meta"]
        .get(LIFECYCLE_META)
        .is_none());
    let prompt = req(1, "session/prompt");
    assert_eq!(codec.outgoing(prompt.clone()).agent, vec![prompt]);
    let answer = response(json!(1), json!({"stopReason":"end_turn"}));
    assert_eq!(codec.incoming(answer.clone()).host, vec![answer]);
}

#[test]
fn rejected_initialization_and_session_requests_keep_the_error_envelope() {
    for method in [
        "initialize",
        "session/new",
        "session/load",
        "session/set_config_option",
    ] {
        let mut codec = Codec {
            v2: true,
            ..Default::default()
        };
        codec.outgoing(req(1, method));
        let error = json!({"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Rejected"}});
        assert_eq!(codec.incoming(error.clone()).host, vec![error]);
    }
}

#[test]
fn cancellation_declines_late_approval_without_detaching_pending_work() {
    let mut codec = active();
    codec.outgoing(req(2, "_session/steering"));
    codec.outgoing(json!({"method":"session/cancel","params":{"sessionId":"s"}}));
    let frames = codec.incoming(json!({"jsonrpc":"2.0","id":99,"method":"session/request_permission","params":{"sessionId":"s","subject":{"type":"tool_call","toolCall":{"toolCallId":"t"}}}}));
    assert!(frames.host.is_empty());
    assert_eq!(frames.agent[0]["result"]["outcome"]["outcome"], "cancelled");
    assert!(codec.sessions["s"].prompt.is_some());
    assert!(state(&mut codec, "idle").host.is_empty());
    assert_eq!(
        codec
            .incoming(response(json!(2), json!({"outcome":"injected"})))
            .host
            .len(),
        2
    );
}

#[test]
fn configuration_auth_modes_and_resume_are_normalized() {
    let mut codec = Codec::default();
    let init = codec.outgoing(req(0, "initialize"));
    assert_eq!(init.agent[0]["params"]["protocolVersion"], 2);
    let frames = codec.incoming(response(json!(0),json!({"protocolVersion":2,"info":{"name":"@agentclientprotocol/codex-acp","version":"2.3.0"},"capabilities":{"session":{"prompt":{"image":{}},"mcp":{"http":{}}}},"authMethods":[{"methodId":"key","name":"Key","type":"agent"}]})));
    let result = &frames.host[0]["result"];
    assert_eq!(result["_meta"][LIFECYCLE_META], true);
    assert_eq!(result["authMethods"][0]["id"], "key");
    assert_eq!(
        result["agentCapabilities"]["promptCapabilities"]["image"],
        true
    );
    let frames = codec.outgoing(req(1, "session/load"));
    assert_eq!(frames.agent[0]["method"], "session/resume");
    assert_eq!(
        frames.agent[0]["params"]["replayFrom"],
        json!({"type":"start"})
    );
    let frames = codec.incoming(response(json!(1),json!({"configOptions":[{"configId":"model","type":"select","options":[{"groupId":"openai","options":[]}]}],"availableCommands":[{"name":"status","description":"Status"}]})));
    assert_eq!(
        frames.host[0]["params"]["update"]["sessionUpdate"],
        "available_commands_update"
    );
    assert_eq!(frames.host[1]["result"]["configOptions"][0]["id"], "model");
    assert_eq!(
        frames.host[1]["result"]["configOptions"][0]["options"][0]["group"],
        "openai"
    );
}

#[test]
fn attachments_and_user_echoes_do_not_duplicate_but_history_and_synthetic_messages_survive() {
    let mut codec = Codec {
        v2: true,
        ..Default::default()
    };
    let mut prompt = req(1, "session/prompt");
    let image = json!({"type":"image","mimeType":"image/png","data":"aGVsbG8="});
    prompt["params"]["prompt"]
        .as_array_mut()
        .unwrap()
        .push(image.clone());
    assert_eq!(codec.outgoing(prompt.clone()).agent[0], prompt);
    let echo = notification(
        "s",
        json!({"sessionUpdate":"user_message_chunk","messageId":"u","content":image}),
    );
    assert!(codec.incoming(echo.clone()).host.is_empty());
    let synthetic = notification(
        "s",
        json!({"sessionUpdate":"user_message_chunk","messageId":"synthetic","content":{"type":"text","text":"Implement the plan"}}),
    );
    assert_eq!(codec.incoming(synthetic.clone()).host, vec![synthetic]);
    codec.incoming(response(json!(1), json!({"messageId":"u"})));
    state(&mut codec, "idle");
    assert_eq!(codec.incoming(echo.clone()).host, vec![echo]);
}

#[test]
fn tool_creation_terminal_stream_and_exact_diff_reach_existing_event_schema() {
    let mut codec = active();
    codec.incoming(notification("s",json!({"sessionUpdate":"terminal_update","terminalId":"t","cwd":"/work","command":"echo hi"})));
    let frames = codec.incoming(notification("s",json!({"sessionUpdate":"tool_call_update","toolCallId":"t","title":"echo hi","kind":"execute","status":"in_progress"})));
    assert_eq!(
        frames.host[0]["params"]["update"]["sessionUpdate"],
        "tool_call"
    );
    assert_eq!(
        frames.host[0]["params"]["update"]["_meta"]["terminal_info"]["cwd"],
        "/work"
    );
    let frames = codec.incoming(notification(
        "s",
        json!({"sessionUpdate":"terminal_output_chunk","terminalId":"t","data":"aGkK"}),
    ));
    assert_eq!(
        frames.host[0]["params"]["update"]["_meta"]["terminal_output_delta"]["data"],
        "hi\n"
    );
    let patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    let frames = codec.incoming(notification("s",json!({"sessionUpdate":"tool_call_update","toolCallId":"edit","title":"Edit","content":[{"type":"diff","changes":[{"operation":"modify","path":"/work/x"}],"patch":{"format":"git_patch","text":patch}}]})));
    assert_eq!(
        frames.host[0]["params"]["update"]["content"][0]["_meta"]["jetbrains"]["air"]["diffPatch"]
            ["text"],
        patch
    );
}

#[test]
fn replay_message_resets_do_not_create_empty_or_duplicate_turns() {
    let mut codec = Codec {
        v2: true,
        ..Default::default()
    };
    for kind in ["user_message", "agent_message", "agent_thought"] {
        assert!(codec
            .incoming(notification(
                "s",
                json!({"sessionUpdate":kind,"messageId":"history-1","content":[]})
            ))
            .host
            .is_empty());
        let block = json!({"type":"text","text":"history"});
        let frames = codec.incoming(notification(
            "s",
            json!({"sessionUpdate":kind,"messageId":"history-1","content":[block]}),
        ));
        assert_eq!(frames.host.len(), 1);
        assert_eq!(
            frames.host[0]["params"]["update"]["sessionUpdate"],
            format!("{kind}_chunk")
        );
    }
}

#[tokio::test]
async fn process_exit_fails_instead_of_completing_an_accepted_prompt() {
    let (agent_out, mut agent_requests) = futures::channel::mpsc::unbounded::<String>();
    let (agent_responses, agent_in) = futures::channel::mpsc::unbounded();
    let (host_out, host_requests) = futures::channel::mpsc::unbounded();
    let (host_responses, mut host_in) = futures::channel::mpsc::unbounded();
    let driver = tokio::spawn(bridge(
        agent_out.sink_map_err(std::io::Error::other),
        agent_in,
        host_requests,
        host_responses,
    ));
    host_out
        .unbounded_send(req(0, "initialize").to_string())
        .unwrap();
    assert!(agent_requests.next().await.unwrap().contains("initialize"));
    agent_responses.unbounded_send(Ok(response(json!(0), json!({
        "protocolVersion":2, "info":{"name":"@agentclientprotocol/codex-acp","version":"2.3.0"},
        "capabilities":{}, "authMethods":[]
    })).to_string())).unwrap();
    assert!(host_in.next().await.unwrap().is_ok());
    host_out
        .unbounded_send(req(1, "session/prompt").to_string())
        .unwrap();
    assert!(agent_requests
        .next()
        .await
        .unwrap()
        .contains("session/prompt"));
    for frame in [
        notification(
            "s",
            json!({"sessionUpdate":"state_update","state":"running"}),
        ),
        response(json!(1), json!({"messageId":"accepted-user"})),
    ] {
        agent_responses
            .unbounded_send(Ok(frame.to_string()))
            .unwrap();
    }
    drop(agent_responses);
    let error = tokio::time::timeout(std::time::Duration::from_secs(5), driver)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
    // Acceptance must not masquerade as a completed host prompt on EOF.
    assert!(host_in.next().await.is_none());
}
