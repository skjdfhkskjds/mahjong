use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, Weak, mpsc},
};

use crate::SubscribeError;

struct State<T> {
    next_id: u64,
    senders: HashMap<u64, mpsc::Sender<T>>,
}

fn lock_state<T>(state: &Mutex<State<T>>) -> MutexGuard<'_, State<T>> {
    match state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub struct Publisher<T> {
    state: Arc<Mutex<State<T>>>,
}

pub struct Subscription<T> {
    receiver: mpsc::Receiver<T>,
    state: Weak<Mutex<State<T>>>,
    id: u64,
}

impl<T> Publisher<T> {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                next_id: 0,
                senders: HashMap::new(),
            })),
        }
    }

    pub fn subscribe(&self) -> Result<Subscription<T>, SubscribeError> {
        let (sender, receiver) = mpsc::channel();
        let mut state = lock_state(&self.state);
        let id = state.next_id;
        state.next_id = id
            .checked_add(1)
            .ok_or(SubscribeError::SubscriberIdsExhausted)?;
        state.senders.insert(id, sender);

        Ok(Subscription {
            receiver,
            state: Arc::downgrade(&self.state),
            id,
        })
    }

    pub fn publish(&self, message: T) -> usize
    where
        T: Clone,
    {
        let mut state = lock_state(&self.state);
        state
            .senders
            .retain(|_, sender| sender.send(message.clone()).is_ok());
        state.senders.len()
    }
}

impl<T> Default for Publisher<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Clone for Publisher<T> {
    fn clone(&self) -> Self {
        Self {
            state: Arc::clone(&self.state),
        }
    }
}

impl<T> Iterator for Subscription<T> {
    type Item = T;

    fn next(&mut self) -> Option<T> {
        self.receiver.recv().ok()
    }
}

impl<T> Drop for Subscription<T> {
    fn drop(&mut self) {
        if let Some(state) = self.state.upgrade() {
            lock_state(&state).senders.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::mpsc, thread, time::Duration};

    use super::lock_state;
    use crate::{Publisher, SubscribeError};

    #[test]
    fn each_subscriber_receives_future_messages_in_order() {
        let publisher = Publisher::new();
        let mut first = publisher.subscribe().unwrap();
        assert_eq!(publisher.publish(1), 1);
        let second = publisher.subscribe().unwrap();
        assert_eq!(publisher.publish(2), 2);
        assert_eq!(publisher.publish(3), 2);
        drop(publisher);

        assert_eq!(first.by_ref().collect::<Vec<_>>(), vec![1, 2, 3]);
        assert_eq!(second.collect::<Vec<_>>(), vec![2, 3]);
    }

    #[test]
    fn next_blocks_until_a_message_arrives() {
        let publisher = Publisher::new();
        let mut subscription = publisher.subscribe().unwrap();
        let (ready_sender, ready_receiver) = mpsc::channel();
        let (finished_sender, finished_receiver) = mpsc::channel();
        let reader = thread::spawn(move || {
            ready_sender.send(()).unwrap();
            finished_sender.send(subscription.next()).unwrap();
        });

        ready_receiver.recv().unwrap();
        assert!(matches!(
            finished_receiver.recv_timeout(Duration::from_millis(20)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        publisher.publish(42);

        assert_eq!(finished_receiver.recv().unwrap(), Some(42));
        reader.join().unwrap();
    }

    #[test]
    fn last_publisher_drop_ends_subscriptions() {
        let publisher = Publisher::new();
        let other_publisher = publisher.clone();
        let mut subscription = publisher.subscribe().unwrap();
        drop(publisher);

        other_publisher.publish(42);
        drop(other_publisher);

        assert_eq!(subscription.next(), Some(42));
        assert_eq!(subscription.next(), None);
    }

    #[test]
    fn dropped_subscriptions_are_removed() {
        let publisher = Publisher::new();
        let subscription = publisher.subscribe().unwrap();
        drop(subscription);

        assert_eq!(publisher.publish(42), 0);
    }

    #[test]
    fn exhausted_subscriber_ids_return_an_error() {
        let publisher = Publisher::<u8>::new();
        lock_state(&publisher.state).next_id = u64::MAX;

        assert!(matches!(
            publisher.subscribe(),
            Err(SubscribeError::SubscriberIdsExhausted)
        ));
    }
}
