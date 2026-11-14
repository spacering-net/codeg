use super::*;
use std::sync::Mutex;

struct Source {
    reads: Mutex<usize>,
    before: Vec<RawWindow>,
    after: Vec<RawWindow>,
    text: Option<String>,
    fail_image: bool,
    targets: Mutex<Vec<(u32, u64)>>,
}

#[async_trait]
impl AppshotSource for Source {
    async fn windows(&self) -> Result<Vec<RawWindow>, BackendError> {
        let mut reads = self.reads.lock().unwrap();
        *reads += 1;
        Ok(if *reads == 1 {
            self.before.clone()
        } else {
            self.after.clone()
        })
    }
    async fn picture(&self, w: &RawWindow) -> Result<RawCapture, BackendError> {
        self.targets.lock().unwrap().push((w.pid, w.window_id));
        if self.fail_image {
            return Err(BackendError::PermissionMissing(
                crate::computer::protocol::OsPermission::ScreenRecording,
            ));
        }
        Ok(serde_json::from_value(serde_json::json!({
            "pngBase64": "aW1hZ2U=", "width": 100, "height": 80,
            "nativeWidth": 100, "nativeHeight": 80,
            "windowBounds": {"x":0,"y":0,"width":100,"height":80}
        }))
        .unwrap())
    }
    async fn text(&self, w: &RawWindow) -> Result<RawSnapshot, BackendError> {
        self.targets.lock().unwrap().push((w.pid, w.window_id));
        match &self.text {
            Some(text) => Ok(serde_json::from_value(
                serde_json::json!({"tree":text,"elementCount":1}),
            )
            .unwrap()),
            None => Err(BackendError::PermissionMissing(
                crate::computer::protocol::OsPermission::Accessibility,
            )),
        }
    }
}

fn window(id: u64, z: i64, key: &str) -> RawWindow {
    serde_json::from_value(serde_json::json!({
        "windowId":id,"pid":42,"title":"Document","onScreen":true,"zIndex":z,
        "bounds":{"x":0,"y":0,"width":100,"height":80},
        "app":{"pid":42,"name":"Editor","bundleId":key,"active":true,"startedAt":7}
    }))
    .unwrap()
}

fn source() -> Source {
    let windows = vec![window(1, 100, "test.editor")];
    Source {
        reads: Mutex::new(0),
        before: windows.clone(),
        after: windows,
        text: Some("Text outside the scroll viewport".to_string()),
        fail_image: false,
        targets: Mutex::new(Vec::new()),
    }
}

async fn run(source: &Source) -> Result<Appshot, String> {
    capture(
        source,
        &SelfIdentity::default(),
        &Blocklist::configured(&[], &[]),
    )
    .await
}

#[tokio::test]
async fn both_channels_stay_on_the_pinned_window_when_focus_moves() {
    let mut s = source();
    s.after.push(window(2, 200, "test.other"));
    let shot = run(&s).await.unwrap();
    assert!(shot.text.contains("outside the scroll viewport"));
    assert_eq!(*s.targets.lock().unwrap(), vec![(42, 1), (42, 1)]);
    assert!(!shot.text_unavailable);
}

#[tokio::test]
async fn blocked_front_window_never_falls_back_to_an_allowed_one() {
    let mut s = source();
    s.before.push(window(2, 200, "com.agilebits.onepassword7"));
    let result = capture(
        &s,
        &SelfIdentity::default(),
        &Blocklist::configured(&["com.agilebits.onepassword7".to_string()], &[]),
    )
    .await;
    assert!(result.unwrap_err().starts_with("not-capturable:"));
    assert!(s.targets.lock().unwrap().is_empty());
}

#[tokio::test]
async fn never_captures_codeg_itself() {
    let mut s = source();
    s.before[0].app.bundle_id = Some("app.codeg".to_string());
    assert!(run(&s).await.unwrap_err().starts_with("not-capturable:"));
    assert!(s.targets.lock().unwrap().is_empty());
}

#[tokio::test]
async fn discards_closed_reused_and_navigated_windows() {
    for change in 0..3 {
        let mut s = source();
        match change {
            0 => s.after.clear(),
            1 => s.after[0].app.started_at = Some(8),
            _ => s.after[0].title = "Different document".into(),
        }
        assert_eq!(run(&s).await.unwrap_err(), "window-changed");
    }
}

#[tokio::test]
async fn missing_text_keeps_the_picture_and_reports_partial_capture() {
    let mut s = source();
    s.text = None;
    let shot = run(&s).await.unwrap();
    assert!(shot.text_unavailable);
    assert!(shot.text.is_empty());
    assert!(!shot.image.data.is_empty());
}

#[tokio::test]
async fn failed_picture_does_not_read_text_or_return_an_attachment() {
    let mut s = source();
    s.fail_image = true;
    assert!(run(&s).await.unwrap_err().contains("Screen Recording"));
    assert_eq!(s.targets.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn text_budget_preserves_unicode_and_reports_truncation() {
    let mut s = source();
    s.text = Some("汉".repeat(MAX_TEXT_CHARS + 1));
    let shot = run(&s).await.unwrap();
    assert_eq!(shot.text.chars().count(), MAX_TEXT_CHARS);
    assert!(shot.truncated);
}
