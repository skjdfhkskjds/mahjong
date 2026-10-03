use std::sync::mpsc;

pub struct MailboxSender<T> {
    sender: mpsc::Sender<T>,
}

pub struct MailboxReceiver<T> {
    receiver: mpsc::Receiver<T>,
}

pub fn channel<T>() -> (MailboxSender<T>, MailboxReceiver<T>) {
    let (sender, receiver) = mpsc::channel();
    (MailboxSender { sender }, MailboxReceiver { receiver })
}

impl<T> Clone for MailboxSender<T> {
    fn clone(&self) -> Self {
        Self {
            sender: self.sender.clone(),
        }
    }
}

impl<T> MailboxSender<T> {
    pub fn send(&self, message: T) -> Result<(), mpsc::SendError<T>> {
        self.sender.send(message)
    }
}

impl<T> Iterator for MailboxReceiver<T> {
    type Item = T;

    fn next(&mut self) -> Option<T> {
        self.receiver.recv().ok()
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::mpsc, thread, time::Duration};

    use crate::channel;

    #[test]
    fn next_blocks_until_a_message_arrives() {
        let (sender, mut receiver) = channel();
        let (ready_sender, ready_receiver) = mpsc::channel();
        let (finished_sender, finished_receiver) = mpsc::channel();
        let reader = thread::spawn(move || {
            ready_sender.send(()).unwrap();
            finished_sender.send(receiver.next()).unwrap();
        });

        ready_receiver.recv().unwrap();
        assert!(matches!(
            finished_receiver.recv_timeout(Duration::from_millis(20)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        sender.send(42).unwrap();

        assert_eq!(finished_receiver.recv().unwrap(), Some(42));
        reader.join().unwrap();
    }

    #[test]
    fn cloned_senders_share_fifo_queue() {
        let (sender, mut receiver) = channel();
        let second_sender = sender.clone();

        sender.send(1).unwrap();
        second_sender.send(2).unwrap();
        drop(sender);
        drop(second_sender);

        assert_eq!(receiver.next(), Some(1));
        assert_eq!(receiver.next(), Some(2));
        assert_eq!(receiver.next(), None);
    }

    #[test]
    fn send_returns_message_after_receiver_is_dropped() {
        let (sender, receiver) = channel();
        drop(receiver);

        assert_eq!(sender.send(42).unwrap_err().0, 42);
    }
}
