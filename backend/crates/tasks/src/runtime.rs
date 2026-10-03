use std::{future::Future, io};

use tokio::{runtime::Runtime, task::JoinHandle};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub struct TaskExecutor {
    runtime: Runtime,
    tracker: TaskTracker,
    shutdown_token: CancellationToken,
}

impl TaskExecutor {
    pub fn new() -> Result<Self, io::Error> {
        Ok(Self {
            runtime: tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?,
            tracker: TaskTracker::new(),
            shutdown_token: CancellationToken::new(),
        })
    }

    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown_token.clone()
    }

    pub fn spawn<F>(&self, future: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.tracker.spawn_on(future, self.runtime.handle())
    }

    pub fn spawn_blocking<F, T>(&self, task: F) -> JoinHandle<T>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        self.tracker.spawn_blocking_on(task, self.runtime.handle())
    }

    pub fn block_on<F: Future>(&self, future: F) -> F::Output {
        self.runtime.block_on(future)
    }

    pub fn shutdown(self) {
        self.shutdown_token.cancel();
        self.tracker.close();
        self.runtime.block_on(self.tracker.wait());
    }
}

#[cfg(test)]
mod tests {
    use super::TaskExecutor;
    use std::sync::mpsc;
    use tokio::sync::oneshot;

    #[test]
    fn shutdown_cancels_and_waits_for_tasks() {
        let tasks = TaskExecutor::new().unwrap();
        let token = tasks.shutdown_token();
        let (done_tx, done_rx) = mpsc::channel();

        tasks.spawn(async move {
            token.cancelled().await;
            done_tx.send(()).unwrap();
        });

        tasks.shutdown();
        done_rx.try_recv().unwrap();
    }

    #[test]
    fn block_on_and_spawn_return_results() {
        let tasks = TaskExecutor::new().unwrap();
        let (tx, rx) = oneshot::channel();
        let handle = tasks.spawn(async move {
            tx.send(42).unwrap();
            7
        });

        assert_eq!(tasks.block_on(rx).unwrap(), 42);
        assert_eq!(tasks.block_on(handle).unwrap(), 7);
        tasks.shutdown();
    }

    #[test]
    fn spawn_blocking_returns_result() {
        let tasks = TaskExecutor::new().unwrap();
        let handle = tasks.spawn_blocking(|| 21 * 2);

        assert_eq!(tasks.block_on(handle).unwrap(), 42);
        tasks.shutdown();
    }
}
