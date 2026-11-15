# Desktop app snapshots

App snapshots add the image and available text of an application window to a
conversation input. The user reviews the snapshot and sends the message.

## Capture a window

1. Open the camera control in the desktop status bar.
2. Choose **Capture in 3 seconds**, then switch to the application to capture.
3. Review the window image and application text. The text can be edited.
4. Choose an open conversation, or create a new one, then choose **Add to
   conversation**. This adds context to the composer; it does not send a message.

A global shortcut can be recorded and saved in the same control. It is off until
the user chooses one. Use a standard key with at least two modifiers, including
Control or Command. Registration failures are shown, and saving retries them.

## What is captured

- One native window image, bounded to a 2,000-pixel long edge.
- Available accessibility text, including off-screen text where the application
  exposes it. This is not a guarantee of the complete document.
- The application, window title, and capture time.

Text is bounded to 40,000 characters. Missing and truncated text are indicated in
the preview. An agent that cannot accept images receives text with an explicit
notice to the user. Images use the existing agent capability and attachment
encoding, including embedded resources where appropriate.

## Desktop and permission boundaries

The control is available in the local main desktop window. No HTTP endpoint,
server feature, mobile feature, or agent tool is added.

On macOS, grant Screen Recording and Accessibility to **codeg-computer-helper**,
as for Computer Use. Codeg itself does not gain these permissions. A snapshot
uses an independent, short-lived helper connection, so it does not enable agent
Computer Use or create a persistent read/control grant. Existing application
exclusions apply, including Codeg itself.

The error dialog can request each permission and open its System Settings page.
Requesting first lets macOS list the helper on a first use or after its permission
entry was removed. The agent Computer Use switch can remain off throughout.

The native result remains pending until reviewed or dismissed. Repeated requests
do not replace a pending snapshot. A window that closes, changes process identity,
or changes document title during capture is discarded rather than handed off.

## Verification

```sh
pnpm test src/lib/appshots.test.ts src/components/layout/desktop-appshots.test.tsx
cd src-tauri
cargo test --features test-utils --lib appshots::
```

For a desktop smoke test, open a long plain-text document with distinct markers
at the beginning and beyond the visible viewport. Capture the foreground window,
check the image and exposed text, cancel once, then capture again and add it to
a conversation. Confirm no message is sent and no window is persistently shared.
Also check a missing permission, a closed destination conversation, repeated
capture while reviewing, and an agent without image input.
