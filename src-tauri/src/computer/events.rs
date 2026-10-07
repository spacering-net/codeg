//! What the frontend is told about computer use.
//!
//! On the desktop, deliberately not `web::event_bridge::emit_event`, which
//! also fans every event out to the web service's clients. What these carry
//! — the titles of the windows a person shared, which of their applications
//! an agent just looked at — is about this machine's screen, and a browser
//! connected to the desktop's web service is somewhere else: there, sharing
//! a window is the desktop window's own action, and so is watching it.
//!
//! codeg-server has no window of its own. Where the person who runs it has
//! let it share the screen it runs on (`CODEG_COMPUTER_USE`), its web
//! clients — each holding the server's token — are the only panel there is,
//! and they are told.

use std::sync::Arc;

use serde::Serialize;

use super::agent::{
    ComputerActivityPayload, ComputerGrantPayload, AGENT_ACTIVITY_EVENT, AGENT_GRANT_EVENT,
};
use super::backend::BackendStatus;
use super::driver_admin::DriverInfo;
use super::stop_shortcut::StopKeyStatus;
use super::targets::{SharedApp, SharedScreen, SharedWindow};
use crate::web::event_bridge::WebEventBroadcaster;

/// Every window with a grant in force — the source of truth for the panel.
pub const STATE_EVENT: &str = "computer://state";

/// The helper's state, for the panel's status line.
pub const BACKEND_STATUS_EVENT: &str = "computer://backend-status";

/// Whether the stop shortcut is in force, for every place that offers Stop.
pub const STOP_KEY_EVENT: &str = "computer://stop-key";

/// The driver as Settings shows it, whenever it changes or an install moves.
pub const DRIVER_EVENT: &str = "computer://driver";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatePayload<'a> {
    shared: &'a [SharedWindow],
    apps: &'a [SharedApp],
    #[serde(skip_serializing_if = "Option::is_none")]
    screen: Option<&'a SharedScreen>,
}

/// Where computer use tells what changed.
#[derive(Clone)]
pub enum ComputerEvents {
    /// The desktop app's own webviews — never the clients of its web
    /// service (see the module note).
    #[cfg(feature = "tauri-runtime")]
    Desktop(tauri::AppHandle),
    /// codeg-server's web clients: the only panel there is in server mode.
    Web(Arc<WebEventBroadcaster>),
}

impl ComputerEvents {
    fn send<T: Serialize>(&self, channel: &str, payload: &T) {
        match self {
            #[cfg(feature = "tauri-runtime")]
            Self::Desktop(app) => {
                use tauri::Emitter;
                let _ = app.emit(channel, payload);
            }
            Self::Web(broadcaster) => {
                let _ = broadcaster.send(channel, payload);
            }
        }
    }

    pub fn state(
        &self,
        shared: &[SharedWindow],
        apps: &[SharedApp],
        screen: Option<&SharedScreen>,
    ) {
        self.send(
            STATE_EVENT,
            &StatePayload {
                shared,
                apps,
                screen,
            },
        );
    }

    pub fn grant(&self, payload: &ComputerGrantPayload) {
        self.send(AGENT_GRANT_EVENT, payload);
    }

    pub fn activity(&self, payload: &ComputerActivityPayload) {
        self.send(AGENT_ACTIVITY_EVENT, payload);
    }

    pub fn backend_status(&self, status: &BackendStatus) {
        self.send(BACKEND_STATUS_EVENT, status);
    }

    pub fn stop_key(&self, status: &StopKeyStatus) {
        self.send(STOP_KEY_EVENT, status);
    }

    pub fn driver(&self, info: &DriverInfo) {
        self.send(DRIVER_EVENT, info);
    }
}
