pub mod acp;
#[cfg(feature = "tauri-runtime")]
pub mod app_update;
pub mod assistants;
pub mod automation;
pub mod background;
pub mod backup;
#[cfg(feature = "tauri-runtime")]
pub mod browser;
/// The browser tool group's on/off switch. Unlike `browser` itself this is not
/// desktop-only: the shared codeg-mcp plumbing reads it in both runtimes.
pub mod browser_tools;
pub mod canvas;
pub mod chat_authoring;
pub mod chat_channel;
/// The `codeg-cli` access switch (desktop; the server's is a web handler).
#[cfg(feature = "tauri-runtime")]
pub mod cli_access;
/// Files-onto-the-OS-clipboard. Only the command itself is desktop-gated; the
/// path validation and URI encoding stay compiled in every mode so their tests
/// run without the tauri stack.
pub mod clipboard;
/// Codex's model list: user saves through the commit coordinator, and the
/// provider-list commands (both runtimes).
pub mod codex_catalog;
/// The ✨ commit message generator (both runtimes).
pub mod commit_message;
/// Computer use: sharing windows, the helper, the agent reads — the desktop
/// app's, and codeg-server's where it is let share the screen it runs on.
pub mod computer;
/// The computer-use switches. Like `browser_tools`, compiled in both runtimes:
/// the shared codeg-mcp plumbing reads them.
pub mod computer_tools;
pub mod config_sync;
pub mod conversation_tags;
pub mod conversations;
/// "New folder" in the directory browser (both runtimes).
pub mod create_directory;
pub mod custom_agents;
pub mod custom_skills;
pub mod deepseek_settings;
pub mod delegation;
pub mod experts;
pub mod feedback;
#[cfg(feature = "tauri-runtime")]
pub mod file_io;
pub mod folder_commands;
pub mod folder_links;
pub mod folders;
pub mod forge;
/// The `ui-render` skill and the agents it is enabled for (Skill Packs > UI).
pub mod generative_ui;
/// Folder commands set to run on the desktop's own machine ("Run on this
/// computer"), even from a remote-desktop window. Desktop-only by design.
#[cfg(feature = "tauri-runtime")]
pub mod local_command;
pub mod logging;
pub mod mcp;
pub mod mcp_service;
pub mod model_provider;
pub mod office_tools;
/// OpenCode 2's provider credentials, through OpenCode's own API (both
/// runtimes).
pub mod opencode_credentials;
pub mod open_in;
#[cfg(feature = "tauri-runtime")]
pub mod notification;
pub mod pet;
pub mod project_boot;
pub mod question;
pub mod quick_messages;
#[cfg(feature = "tauri-runtime")]
pub mod remote_proxy;
#[cfg(feature = "tauri-runtime")]
pub mod remote_workspace;
pub mod science;
pub mod session_info;
pub mod system_settings;
pub mod terminal;
pub mod token_usage;
pub mod turn_window;
pub mod version_control;
#[cfg(feature = "tauri-runtime")]
pub mod windows;
pub mod work_task;
pub mod workspace_state;
#[cfg(feature = "tauri-runtime")]
pub mod workspace_windows;
