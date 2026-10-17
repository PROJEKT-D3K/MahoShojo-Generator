//! Invoke completion describes accepted Channel sends, not renderer delivery.
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;

use crate::{ai, arena_hosted};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StreamCompletionReceipt {
    request_id: String,
    channel_event_count: usize,
}

pub(crate) struct CountingEventSink<S> {
    inner: S,
    accepted: AtomicUsize,
}

impl<S> CountingEventSink<S> {
    pub(crate) fn new(inner: S) -> Self {
        Self {
            inner,
            accepted: AtomicUsize::new(0),
        }
    }

    pub(crate) fn receipt(&self, request_id: String) -> StreamCompletionReceipt {
        StreamCompletionReceipt {
            request_id,
            channel_event_count: self.accepted.load(Ordering::Relaxed),
        }
    }
}

impl<S: ai::EventSink> ai::EventSink for CountingEventSink<S> {
    fn send(&self, event: ai::AiStreamEvent) -> Result<(), ()> {
        self.inner.send(event)?;
        self.accepted.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

impl<S: arena_hosted::EventSink> arena_hosted::EventSink for CountingEventSink<S> {
    fn send(&self, event: arena_hosted::ChannelEvent) -> Result<(), arena_hosted::ArenaError> {
        self.inner.send(event)?;
        self.accepted.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}
