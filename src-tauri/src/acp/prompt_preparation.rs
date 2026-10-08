//! Prompt preparation must yield to Stop before issuing the native request.
use super::connection::ConnectionCommand;
use super::file_checkpoint::CaptureControl;
use std::collections::VecDeque;
use std::future::Future;
use tokio::sync::mpsc;

pub(super) enum Prepared<T> {
    Ready(T),
    Canceled,
    Disconnected,
}

pub(super) async fn prepare<T>(
    work: impl Future<Output = T>,
    control: &CaptureControl,
    commands: &mut mpsc::Receiver<ConnectionCommand>,
    deferred: &mut VecDeque<ConnectionCommand>,
) -> Prepared<T> {
    tokio::pin!(work);
    loop {
        tokio::select! {
            // An already queued Stop wins over a ready snapshot. Await the
            // cooperative worker on either exit so its file lease is released.
            biased;
            command = commands.recv() => match command {
                Some(ConnectionCommand::Cancel) => {
                    control.cancel();
                    drop(work.await);
                    return Prepared::Canceled;
                }
                Some(ConnectionCommand::Disconnect) | None => {
                    control.cancel();
                    drop(work.await);
                    return Prepared::Disconnected;
                }
                Some(command) => deferred.push_back(command),
            },
            result = &mut work => return Prepared::Ready(result),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn queued_stop_wins_over_a_ready_preparation_and_keeps_other_commands() {
        let (send, mut receive) = mpsc::channel(4);
        send.send(ConnectionCommand::RespondPermission {
            request_id: "request".into(),
            option_id: "allow".into(),
        })
        .await
        .unwrap();
        send.send(ConnectionCommand::Cancel).await.unwrap();
        let mut deferred = VecDeque::new();
        let control = CaptureControl::default();
        let result = prepare(async { 42 }, &control, &mut receive, &mut deferred).await;
        assert!(matches!(result, Prepared::Canceled));
        assert!(control.cancel.load(std::sync::atomic::Ordering::Acquire));
        assert!(
            matches!(deferred.pop_front(), Some(ConnectionCommand::RespondPermission { request_id, .. }) if request_id == "request")
        );
        assert!(deferred.is_empty());
    }

    #[tokio::test]
    async fn disconnect_waits_until_the_capture_worker_releases_its_result() {
        struct Lease(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Lease {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::Release);
            }
        }
        let released = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let lease = Lease(released.clone());
        let (send, mut receive) = mpsc::channel(1);
        send.send(ConnectionCommand::Disconnect).await.unwrap();
        let control = CaptureControl::default();
        let worker_control = control.clone();
        let work = async move {
            while !worker_control
                .cancel
                .load(std::sync::atomic::Ordering::Acquire)
            {
                tokio::task::yield_now().await;
            }
            lease
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            prepare(work, &control, &mut receive, &mut VecDeque::new()),
        )
        .await
        .unwrap();
        assert!(matches!(result, Prepared::Disconnected));
        assert!(released.load(std::sync::atomic::Ordering::Acquire));
    }
}
