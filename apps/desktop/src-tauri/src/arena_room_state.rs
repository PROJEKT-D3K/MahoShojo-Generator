//! Room 的纯 Document 证明与有界投递账本。平台层必须先核实真实 Webview marker。
//!
//! 超时只撤销逻辑证明；eval 的物理容量只能由该次真实 callback 或真实实例销毁释放。
//! 字节在离开本模块前记账，发送失败不退款。退休丢正文，不能丢框架已接收的债务。

use std::collections::{BTreeMap, VecDeque};
use std::io::{self, Write};

use serde::Serialize;
use serde_json::Value;

use crate::arena_room_protocol::RoomError;

pub(crate) const MAX_NATIVE_QUEUED_BYTES: usize = 256 * 1024;
pub(crate) const MAX_BATCH_BYTES: usize = 256 * 1024;
pub(crate) const MAX_NOTIFICATION_BYTES: usize = 1024;
pub(crate) const MAX_DELIVERED_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_SCOPE_RECORDS: usize = 128;
pub(crate) const MAX_QUEUED_BATCHES: usize = 128;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn error(code: &str) -> RoomError {
    RoomError::new(code, "not-applicable")
}

/// 只允许平台层从已核实的 ResourceTable marker 分配；不是 Webview label 或 IPC 参数。
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub(crate) struct InstanceToken(u64);

impl InstanceToken {
    pub(crate) fn new(value: u64) -> Self {
        Self(value)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct DocumentId {
    pub(crate) instance: InstanceToken,
    pub(crate) generation: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct EvalAttempt {
    pub(crate) document: DocumentId,
    pub(crate) document_nonce: String,
    pub(crate) attach_intent: u64,
    pub(crate) account_epoch: u64,
    pub(crate) challenge: String,
    attach_generation: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DocumentProof {
    pub(crate) document: DocumentId,
    pub(crate) document_nonce: String,
    pub(crate) attach_intent: u64,
    pub(crate) account_epoch: u64,
    attach_generation: u64,
}

struct PhysicalEval {
    attempt: EvalAttempt,
    live: bool,
}

pub(crate) struct DocumentState {
    instance: InstanceToken,
    generation: u64,
    attach_generation: u64,
    max_attach_intent: u64,
    loading: bool,
    destroyed: bool,
    nonce: Option<String>,
    physical_eval: Option<PhysicalEval>,
}

impl DocumentState {
    pub(crate) fn new(instance: InstanceToken) -> Self {
        Self {
            instance,
            generation: 0,
            attach_generation: 0,
            max_attach_intent: 0,
            loading: true,
            destroyed: false,
            nonce: None,
            physical_eval: None,
        }
    }

    fn matching_instance(&self, instance: InstanceToken) -> Result<(), RoomError> {
        if self.instance != instance || self.destroyed {
            return Err(error("document-unavailable"));
        }
        Ok(())
    }

    fn invalidate_attach(&mut self) -> Result<(), RoomError> {
        // 不 wrap：进程内无法继续唯一编号时 fail closed。
        self.attach_generation = self.attach_generation.checked_add(1).ok_or_else(|| {
            self.loading = true;
            error("document-unavailable")
        })?;
        if let Some(physical) = &mut self.physical_eval {
            physical.live = false;
        }
        Ok(())
    }

    pub(crate) fn page_started(&mut self, instance: InstanceToken) -> Result<(), RoomError> {
        self.matching_instance(instance)?;
        self.loading = true;
        self.nonce = None;
        self.max_attach_intent = 0;
        self.invalidate_attach()?;
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| error("document-unavailable"))?;
        Ok(())
    }

    pub(crate) fn page_finished(
        &mut self,
        instance: InstanceToken,
    ) -> Result<DocumentId, RoomError> {
        self.matching_instance(instance)?;
        self.invalidate_attach()?;
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| error("document-unavailable"))?;
        self.nonce = None;
        self.max_attach_intent = 0;
        self.loading = false;
        self.current_document(instance)
    }

    pub(crate) fn current_document(
        &self,
        instance: InstanceToken,
    ) -> Result<DocumentId, RoomError> {
        self.matching_instance(instance)?;
        if self.loading {
            return Err(error("document-unavailable"));
        }
        Ok(DocumentId {
            instance,
            generation: self.generation,
        })
    }

    /// 账号撤销也必须即时使已获得的证明与未完成 eval 失效，不释放物理 eval 槽。
    pub(crate) fn revoke_account(&mut self, instance: InstanceToken) -> Result<(), RoomError> {
        self.matching_instance(instance)?;
        self.invalidate_attach()
    }

    pub(crate) fn begin_attach(
        &mut self,
        instance: InstanceToken,
        document_nonce: String,
        attach_intent: u64,
        account_epoch: u64,
        challenge: String,
    ) -> Result<EvalAttempt, RoomError> {
        self.matching_instance(instance)?;
        let document = self.current_document(instance)?;
        if !valid_nonce(&document_nonce)
            || !(1..=MAX_SAFE_INTEGER).contains(&attach_intent)
            || !valid_identifier(&challenge, 128)
        {
            return Err(error("invalid-request"));
        }
        if self
            .nonce
            .as_ref()
            .is_some_and(|nonce| nonce != &document_nonce)
        {
            return Err(error("document-unavailable"));
        }
        // 不让旧 Document 的错误 nonce 或同 Document 的晚到旧 intent 撤销新证明。
        if self.physical_eval.as_ref().is_some_and(|physical| {
            physical.attempt.document == document
                && physical.attempt.document_nonce != document_nonce
        }) {
            return Err(error("document-unavailable"));
        }
        if attach_intent <= self.max_attach_intent {
            return Err(error("scope-changed"));
        }
        self.max_attach_intent = attach_intent;
        // 真正更高的新意图即使 busy 失败，也不得让旧 attach 随后复活。
        self.invalidate_attach()?;
        if self.physical_eval.is_some() {
            return Err(error("busy"));
        }
        let attempt = EvalAttempt {
            document,
            document_nonce,
            attach_intent,
            account_epoch,
            challenge,
            attach_generation: self.attach_generation,
        };
        self.physical_eval = Some(PhysicalEval {
            attempt: attempt.clone(),
            live: true,
        });
        Ok(attempt)
    }

    /// 调用方必须在真实 eval callback 中调用；不能从 timeout 分支假造 callback。
    /// 无法解析的 callback 传 None：释放该真实回调的容量，但绝不形成证明。
    pub(crate) fn complete_eval(
        &mut self,
        attempt: &EvalAttempt,
        callback_instance: InstanceToken,
        account_epoch: u64,
        nonce: Option<&str>,
        challenge: Option<&str>,
    ) -> Result<DocumentProof, RoomError> {
        self.matching_instance(callback_instance)?;
        let exact = self
            .physical_eval
            .as_ref()
            .is_some_and(|physical| physical.attempt == *attempt);
        if !exact || attempt.document.instance != callback_instance {
            return Err(error("scope-changed"));
        }
        let physical = self.physical_eval.take().expect("matched physical eval");
        // 回执可以证明本 Document 的 nonce，但不能复活已退休的 attach。
        // 这种情况必须保留已观察到的更高 intent，而不是把逻辑退休误当错 nonce。
        let nonce_verified = !self.loading
            && attempt.document.generation == self.generation
            && nonce == Some(attempt.document_nonce.as_str())
            && challenge == Some(attempt.challenge.as_str())
            && self
                .nonce
                .as_ref()
                .is_none_or(|current| current == &attempt.document_nonce);
        if nonce_verified {
            self.nonce = Some(attempt.document_nonce.clone());
        }
        if !physical.live
            || self.loading
            || attempt.document.generation != self.generation
            || attempt.attach_generation != self.attach_generation
            || attempt.account_epoch != account_epoch
            || nonce != Some(attempt.document_nonce.as_str())
            || challenge != Some(attempt.challenge.as_str())
            || self
                .nonce
                .as_ref()
                .is_some_and(|current| current != &attempt.document_nonce)
        {
            // 尚未证实的 nonce 不能把新 Document 的 intent 高水位永久抬高。
            if self.nonce.is_none() && attempt.document.generation == self.generation {
                self.max_attach_intent = 0;
            }
            return Err(error("scope-changed"));
        }
        self.nonce = Some(attempt.document_nonce.clone());
        Ok(DocumentProof {
            document: attempt.document,
            document_nonce: attempt.document_nonce.clone(),
            attach_intent: attempt.attach_intent,
            account_epoch,
            attach_generation: attempt.attach_generation,
        })
    }

    pub(crate) fn eval_timed_out(&mut self, attempt: &EvalAttempt) -> bool {
        let Some(physical) = &mut self.physical_eval else {
            return false;
        };
        if physical.attempt != *attempt {
            return false;
        }
        physical.live = false;
        true
    }

    pub(crate) fn is_current(&self, proof: &DocumentProof, account_epoch: u64) -> bool {
        !self.destroyed
            && !self.loading
            && proof.document.instance == self.instance
            && proof.document.generation == self.generation
            && proof.attach_generation == self.attach_generation
            && proof.account_epoch == account_epoch
            && self.nonce.as_deref() == Some(proof.document_nonce.as_str())
    }

    #[cfg(test)]
    pub(crate) fn has_physical_eval(&self) -> bool {
        self.physical_eval.is_some()
    }

    pub(crate) fn destroyed(&mut self, instance: InstanceToken) -> bool {
        if self.instance != instance || self.destroyed {
            return false;
        }
        self.destroyed = true;
        self.loading = true;
        self.nonce = None;
        self.physical_eval = None;
        true
    }
}

fn valid_nonce(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Batch<'a> {
    handle: &'a str,
    subscription_id: &'a str,
    batch_id: &'a str,
    sequence: u64,
    event: &'a Value,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum PullReply<'a> {
    Batch { batch: Batch<'a> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Notification<'a> {
    handle: &'a str,
    subscription_id: &'a str,
    sequence: u64,
    #[serde(rename = "type")]
    notification_type: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RevokedNotification<'a> {
    handle: &'a str,
    subscription_id: &'a str,
    batch_id: &'a str,
    sequence: u64,
    request_id: Option<&'a str>,
    operation: &'static str,
    error: &'a RoomError,
    #[serde(rename = "type")]
    notification_type: &'static str,
}

struct RevokedDebt {
    sequence: u64,
    bytes: usize,
}

struct BoundedJson {
    bytes: Vec<u8>,
    limit: usize,
}

impl Write for BoundedJson {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(io::Error::other("room output limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// 在写入过程中限制完整 serde 输出，不先创建不受控的整份 JSON 副本。
fn bounded_json(value: &impl Serialize, limit: usize) -> Result<String, RoomError> {
    let mut writer = BoundedJson {
        bytes: Vec::new(),
        limit,
    };
    serde_json::to_writer(&mut writer, value).map_err(|_| error("backpressure"))?;
    String::from_utf8(writer.bytes).map_err(|_| error("internal-error"))
}

struct QueuedBatch {
    sequence: u64,
    batch_id: String,
    body: String,
    http_terminal: bool,
}

struct InFlight {
    sequence: u64,
    bytes: usize,
    body_sent: bool,
}

struct ScopeRecord {
    document: DocumentId,
    handle: String,
    subscription_id: String,
    batch_prefix: String,
    next_sequence: u64,
    acknowledged_through: u64,
    in_flight: Option<InFlight>,
    revoked: Option<RevokedDebt>,
    retired: bool,
}

impl ScopeRecord {
    fn batch_id(&self, sequence: u64) -> String {
        format!("{}:{sequence}", self.batch_prefix)
    }
}

const HTTP_TERMINAL_NATIVE_RESERVE: usize = 2 * 1024;
const HTTP_TERMINAL_FRAMEWORK_RESERVE: usize = 3 * 1024;
struct HttpTerminalReservation {
    scope: u64,
    request_id: String,
    operation: crate::arena_room_protocol::Operation,
    sequence: Option<u64>,
    framework_bytes: usize,
    preserve_error: bool,
}

/// 每个真实 Webview 独有，父引擎在同一锁内调用。返回 String 是完整 JSON
/// 输出，平台层必须原样投递。已交框架的通知/正文，不因失败或退休退款。
/// backpressure 保留 scope 终结入口；不能静默丢帧后继续假装在线。
pub(crate) struct DeliveryQueue {
    instance: InstanceToken,
    document: Option<DocumentId>,
    newest_document_generation: u64,
    records: BTreeMap<u64, ScopeRecord>,
    active: Option<u64>,
    next_scope: u64,
    queued: VecDeque<QueuedBatch>,
    owned_bytes: usize,
    delivered_bytes: usize,
    http_terminal: Option<HttpTerminalReservation>,
    subscription_terminal: Option<u64>,
    terminal_notification_attempted: bool,
    backpressured: bool,
    destroyed: bool,
}

impl DeliveryQueue {
    pub(crate) fn new(instance: InstanceToken) -> Self {
        Self {
            instance,
            document: None,
            newest_document_generation: 0,
            records: BTreeMap::new(),
            active: None,
            next_scope: 0,
            queued: VecDeque::new(),
            owned_bytes: 0,
            delivered_bytes: 0,
            http_terminal: None,
            subscription_terminal: None,
            terminal_notification_attempted: false,
            backpressured: false,
            destroyed: false,
        }
    }

    pub(crate) fn activate(
        &mut self,
        document: DocumentId,
        handle: String,
        subscription_id: String,
        batch_prefix: String,
    ) -> Result<(), RoomError> {
        if self.destroyed
            || document.instance != self.instance
            || document.generation < self.newest_document_generation
            || document.generation == 0
        {
            return Err(error("scope-changed"));
        }
        if !valid_identifier(&handle, 128)
            || !valid_identifier(&subscription_id, 128)
            || !valid_identifier(&batch_prefix, 64)
        {
            return Err(error("invalid-request"));
        }
        if self
            .records
            .values()
            .any(|scope| scope.handle == handle && scope.subscription_id == subscription_id)
        {
            return Err(error("invalid-request"));
        }
        self.retire();
        if self.records.len() >= MAX_SCOPE_RECORDS {
            self.records.retain(|_, scope| {
                scope.in_flight.is_some()
                    || scope.revoked.as_ref().is_some_and(|debt| debt.bytes != 0)
            });
        }
        if self.records.len() >= MAX_SCOPE_RECORDS {
            return self.backpressure();
        }
        let serial = self
            .next_scope
            .checked_add(1)
            .ok_or_else(|| error("backpressure"))?;
        self.next_scope = serial;
        self.records.insert(
            serial,
            ScopeRecord {
                document,
                handle,
                subscription_id,
                batch_prefix,
                next_sequence: 1,
                acknowledged_through: 0,
                in_flight: None,
                revoked: None,
                retired: false,
            },
        );
        self.active = Some(serial);
        self.document = Some(document);
        self.newest_document_generation = document.generation;
        self.backpressured = false;
        self.terminal_notification_attempted = false;
        Ok(())
    }

    /// 退休仅丢 Native 所有内容/尚未交付的预留，不释放已交框架的债务。
    pub(crate) fn retire(&mut self) {
        if let Some(serial) = self.active.take() {
            if let Some(scope) = self.records.get_mut(&serial) {
                scope.retired = true;
            }
        }
        self.queued.clear();
        self.owned_bytes = 0;
        self.http_terminal = None;
        self.subscription_terminal = None;
        self.terminal_notification_attempted = false;
    }

    #[cfg(test)]
    pub(crate) fn retire_scope(
        &mut self,
        document: DocumentId,
        handle: &str,
        subscription_id: &str,
    ) -> bool {
        let Ok(serial) = self.active_scope(document, handle, subscription_id) else {
            return false;
        };
        if self.active == Some(serial) {
            self.retire();
            return true;
        }
        false
    }

    pub(crate) fn revoke_document(&mut self, instance: InstanceToken) -> bool {
        if self.instance != instance || self.destroyed {
            return false;
        }
        self.retire();
        self.document = None;
        true
    }

    fn latch_backpressure(&mut self) {
        // 未 pull 的大 HTTP 成功正文也必须退成同批次的小终结；已有明确 request-error
        // 保留原 outcome。通知只携带 sequence，因此同一未派发 body 可以安全收缩。
        let replacement = self.http_terminal.as_ref().and_then(|reservation| {
            if reservation.preserve_error { return None; }
            let sequence = reservation.sequence?;
            let failure = serde_json::json!({"kind":"request-error","requestId":reservation.request_id,
                "operation":reservation.operation.as_str(),"error":RoomError::new("backpressure",
                    if reservation.operation.is_post() { "unknown" } else { "not-applicable" })});
            self.serialize_batch(reservation.scope, sequence, &failure, HTTP_TERMINAL_NATIVE_RESERVE).ok()
        });
        self.queued.retain(|batch| batch.http_terminal);
        if let Some(mut replacement) = replacement {
            replacement.http_terminal = true;
            if let Some(reservation) = self.http_terminal.as_mut() {
                let notification_debt = self
                    .records
                    .get(&reservation.scope)
                    .and_then(|scope| scope.in_flight.as_ref())
                    .filter(|flight| {
                        Some(flight.sequence) == reservation.sequence && !flight.body_sent
                    })
                    .map_or(0, |flight| flight.bytes);
                reservation.framework_bytes = (replacement.body.len() + MAX_NOTIFICATION_BYTES)
                    .max(HTTP_TERMINAL_FRAMEWORK_RESERVE)
                    .saturating_sub(notification_debt);
                reservation.preserve_error = true;
            }
            self.queued.clear();
            self.queued.push_back(replacement);
        }
        self.owned_bytes = self.queued.iter().map(|batch| batch.body.len()).sum();
        if self
            .active
            .and_then(|serial| self.records.get(&serial))
            .is_some_and(|scope| scope.in_flight.is_some())
        {
            // 已有可到达的 pull/ack 终结入口，不额外制造一笔终结通知债务。
            self.terminal_notification_attempted = true;
        }
        self.backpressured = true;
    }

    fn backpressure<T>(&mut self) -> Result<T, RoomError> {
        self.latch_backpressure();
        Err(error("backpressure"))
    }

    fn active_scope(
        &self,
        document: DocumentId,
        handle: &str,
        subscription_id: &str,
    ) -> Result<u64, RoomError> {
        if self.destroyed || self.document != Some(document) {
            return Err(error("scope-changed"));
        }
        let serial = self.active.ok_or_else(|| error("scope-changed"))?;
        let scope = self
            .records
            .get(&serial)
            .ok_or_else(|| error("scope-changed"))?;
        if scope.retired
            || scope.document != document
            || scope.handle != handle
            || scope.subscription_id != subscription_id
        {
            return Err(error("scope-changed"));
        }
        Ok(serial)
    }

    fn subscription_reserved_bytes(&self) -> usize {
        usize::from(self.subscription_terminal.is_some()) * MAX_NOTIFICATION_BYTES
    }

    fn reserved_native_bytes(&self) -> usize {
        let subscription = self.subscription_reserved_bytes();
        let Some(reservation) = &self.http_terminal else {
            return subscription;
        };
        let actual = reservation
            .sequence
            .and_then(|sequence| {
                self.queued
                    .iter()
                    .find(|batch| batch.http_terminal && batch.sequence == sequence)
                    .map(|batch| batch.body.len())
            })
            .unwrap_or(0);
        subscription + HTTP_TERMINAL_NATIVE_RESERVE.saturating_sub(actual)
    }
    fn reserved_framework_bytes(&self) -> usize {
        self.subscription_reserved_bytes()
            + self
                .http_terminal
                .as_ref()
                .map_or(0, |reservation| reservation.framework_bytes)
    }
    fn reserved_queue_slots(&self) -> usize {
        usize::from(
            self.http_terminal
                .as_ref()
                .is_some_and(|reservation| reservation.sequence.is_none()),
        )
    }

    /// accepted 和业务派发之前调用。单槽同时保留小终结的 Native、框架和队列额度。
    pub(crate) fn reserve_http_terminal(
        &mut self,
        request_id: &str,
        operation: crate::arena_room_protocol::Operation,
    ) -> Result<(), RoomError> {
        if operation == crate::arena_room_protocol::Operation::Ticket {
            return Err(RoomError::new("invalid-request", "not-applied"));
        }
        self.reserve_terminal(request_id, operation)
    }

    /// Subscribe 回执前保留独立小终结槽，持续到退休；不占业务 HTTP 槽。
    pub(crate) fn reserve_subscription_terminal(&mut self) -> Result<(), RoomError> {
        let serial = self.active.ok_or_else(|| error("scope-changed"))?;
        if self.subscription_terminal == Some(serial) {
            return Ok(());
        }
        if self.backpressured
            || MAX_NOTIFICATION_BYTES
                > MAX_NATIVE_QUEUED_BYTES
                    .saturating_sub(self.owned_bytes)
                    .saturating_sub(self.reserved_native_bytes())
            || MAX_NOTIFICATION_BYTES
                > MAX_DELIVERED_BYTES
                    .saturating_sub(self.delivered_bytes)
                    .saturating_sub(self.reserved_framework_bytes())
            || self
                .records
                .get(&serial)
                .is_none_or(|scope| scope.next_sequence > MAX_SAFE_INTEGER)
        {
            return self.backpressure();
        }
        self.subscription_terminal = Some(serial);
        Ok(())
    }

    fn reserve_terminal(
        &mut self,
        request_id: &str,
        operation: crate::arena_room_protocol::Operation,
    ) -> Result<(), RoomError> {
        let serial = self.active.ok_or_else(|| error("scope-changed"))?;
        if (operation == crate::arena_room_protocol::Operation::Ticket && !request_id.is_empty())
            || (operation != crate::arena_room_protocol::Operation::Ticket
                && !valid_identifier(request_id, 128))
        {
            return Err(RoomError::new("invalid-request", "not-applied"));
        }
        if self.http_terminal.is_some() {
            return Err(RoomError::new("busy", "not-applied"));
        }
        let scope = self
            .records
            .get(&serial)
            .ok_or_else(|| error("scope-changed"))?;
        if self.backpressured
            || scope.next_sequence
                > MAX_SAFE_INTEGER - u64::from(self.subscription_terminal.is_some())
            || self.queued.len() >= MAX_QUEUED_BATCHES
            || HTTP_TERMINAL_NATIVE_RESERVE
                > MAX_NATIVE_QUEUED_BYTES
                    .saturating_sub(self.owned_bytes)
                    .saturating_sub(self.subscription_reserved_bytes())
            || HTTP_TERMINAL_FRAMEWORK_RESERVE
                > MAX_DELIVERED_BYTES
                    .saturating_sub(self.delivered_bytes)
                    .saturating_sub(self.subscription_reserved_bytes())
        {
            self.latch_backpressure();
            return Err(RoomError::new("backpressure", "not-applied"));
        }
        self.http_terminal = Some(HttpTerminalReservation {
            scope: serial,
            request_id: request_id.to_owned(),
            operation,
            sequence: None,
            framework_bytes: HTTP_TERMINAL_FRAMEWORK_RESERVE,
            preserve_error: false,
        });
        Ok(())
    }

    /// 受检认证终结的唯一小通知，可越过旧正文的消费等待，但不交第二份正文。
    /// 与正文共用序号、独立记债；从当前 HTTP 保留容量转账，返回前已按完整字节计费。
    pub(crate) fn take_http_revoked(&mut self, failure: &RoomError) -> Result<String, RoomError> {
        let serial = self.active.ok_or_else(|| error("scope-changed"))?;
        let reservation = self
            .http_terminal
            .as_ref()
            .ok_or_else(|| error("invalid-request"))?;
        if reservation.scope != serial || reservation.sequence.is_some() {
            return Err(error("invalid-request"));
        }
        let request_id = reservation.request_id.clone();
        let operation = reservation.operation.as_str();
        let capacity = reservation.framework_bytes;
        self.take_revoked(serial, Some(&request_id), operation, failure, capacity)
    }

    pub(crate) fn take_subscription_revoked(
        &mut self,
        failure: &RoomError,
    ) -> Result<String, RoomError> {
        let serial = self.active.ok_or_else(|| error("scope-changed"))?;
        if self.subscription_terminal != Some(serial) {
            return Err(error("invalid-request"));
        }
        let mut failure = failure.clone();
        failure.outcome = "not-applicable";
        self.take_revoked(serial, None, "subscribe", &failure, MAX_NOTIFICATION_BYTES)
    }

    fn take_revoked(
        &mut self,
        serial: u64,
        request_id: Option<&str>,
        operation: &'static str,
        failure: &RoomError,
        capacity: usize,
    ) -> Result<String, RoomError> {
        let scope = self
            .records
            .get(&serial)
            .ok_or_else(|| error("scope-changed"))?;
        if scope.revoked.is_some() || scope.next_sequence > MAX_SAFE_INTEGER {
            return Err(error("backpressure"));
        }
        let sequence = scope.next_sequence;
        let batch_id = scope.batch_id(sequence);
        let notification = bounded_json(
            &RevokedNotification {
                handle: &scope.handle,
                subscription_id: &scope.subscription_id,
                batch_id: &batch_id,
                sequence,
                request_id,
                operation,
                error: failure,
                notification_type: "revoked",
            },
            MAX_NOTIFICATION_BYTES,
        )?;
        if notification.len() > capacity
            || notification.len() > MAX_DELIVERED_BYTES.saturating_sub(self.delivered_bytes)
        {
            return Err(error("backpressure"));
        }
        self.delivered_bytes += notification.len();
        let scope = self.records.get_mut(&serial).expect("active scope");
        scope.next_sequence += 1;
        scope.revoked = Some(RevokedDebt {
            sequence,
            bytes: notification.len(),
        });
        // Atomic winner retires both unhanded reservations. Previously delivered
        // body/notification debt remains independently charged until its exact ACK.
        self.retire();
        Ok(notification)
    }

    /// 只供派发前取消；已排队的终结须保留到真正 pull/退休，不能被提前释放。
    #[cfg(test)]
    pub(crate) fn cancel_http_terminal(&mut self) -> bool {
        if self
            .http_terminal
            .as_ref()
            .is_some_and(|reservation| reservation.sequence.is_none())
        {
            self.http_terminal = None;
            true
        } else {
            false
        }
    }

    fn serialize_batch(
        &self,
        serial: u64,
        sequence: u64,
        event: &Value,
        limit: usize,
    ) -> Result<QueuedBatch, RoomError> {
        let scope = self
            .records
            .get(&serial)
            .ok_or_else(|| error("scope-changed"))?;
        let batch_id = scope.batch_id(sequence);
        let body = bounded_json(
            &PullReply::Batch {
                batch: Batch {
                    handle: &scope.handle,
                    subscription_id: &scope.subscription_id,
                    batch_id: &batch_id,
                    sequence,
                    event,
                },
            },
            limit.min(MAX_BATCH_BYTES),
        )?;
        Ok(QueuedBatch {
            sequence,
            batch_id,
            body,
            http_terminal: false,
        })
    }

    /// true 表示原闭合终结已排入；false 表示容量不足，已改排同 requestId/op 的
    /// 小 request-error。普通服务错误保留原 outcome，仅容量降级的 POST 为 unknown。
    pub(crate) fn finish_http_terminal(&mut self, event: &Value) -> Result<bool, RoomError> {
        let serial = self.active.ok_or_else(|| error("scope-changed"))?;
        let reservation = self
            .http_terminal
            .as_ref()
            .ok_or_else(|| error("invalid-request"))?;
        if reservation.scope != serial {
            return Err(error("scope-changed"));
        }
        if reservation.operation == crate::arena_room_protocol::Operation::Ticket {
            return Err(error("invalid-request"));
        }
        if reservation.sequence.is_some() {
            return Err(error("busy"));
        }
        if !matches!(
            event.get("kind").and_then(Value::as_str),
            Some("http-result" | "request-error")
        ) || event.get("requestId").and_then(Value::as_str)
            != Some(reservation.request_id.as_str())
            || event.get("operation").and_then(Value::as_str)
                != Some(reservation.operation.as_str())
        {
            return Err(error("invalid-request"));
        }
        let request_id = reservation.request_id.clone();
        let operation = reservation.operation;
        let sequence = self
            .records
            .get(&serial)
            .expect("active scope")
            .next_sequence;
        if sequence > MAX_SAFE_INTEGER - u64::from(self.subscription_terminal.is_some()) {
            return self.backpressure();
        }
        let preferred = self.serialize_batch(
            serial,
            sequence,
            event,
            MAX_NATIVE_QUEUED_BYTES
                .saturating_sub(self.owned_bytes)
                .saturating_sub(self.subscription_reserved_bytes()),
        );
        let preferred = preferred.ok().filter(|batch| {
            (!self.backpressured || event["kind"] == "request-error")
                && (batch.body.len() + MAX_NOTIFICATION_BYTES).max(HTTP_TERMINAL_FRAMEWORK_RESERVE)
                    <= MAX_DELIVERED_BYTES
                        .saturating_sub(self.delivered_bytes)
                        .saturating_sub(self.subscription_reserved_bytes())
                && self.queued.len() < MAX_QUEUED_BATCHES
        });
        let accepted_original = preferred.is_some();
        let mut batch = match preferred {
            Some(batch) => batch,
            None => {
                self.latch_backpressure();
                let failure = serde_json::json!({"kind":"request-error","requestId":request_id,"operation":operation.as_str(),
                    "error":RoomError::new("backpressure", if operation.is_post() { "unknown" } else { "not-applicable" })});
                self.serialize_batch(serial, sequence, &failure, HTTP_TERMINAL_NATIVE_RESERVE)?
            }
        };
        batch.http_terminal = true;
        let framework_bytes =
            (batch.body.len() + MAX_NOTIFICATION_BYTES).max(HTTP_TERMINAL_FRAMEWORK_RESERVE);
        if framework_bytes
            > MAX_DELIVERED_BYTES
                .saturating_sub(self.delivered_bytes)
                .saturating_sub(self.subscription_reserved_bytes())
        {
            // This would mean an internal caller bypassed a reservation. Never over-deliver.
            return self.backpressure();
        }
        let reservation = self.http_terminal.as_mut().expect("reserved HTTP terminal");
        reservation.sequence = Some(sequence);
        reservation.framework_bytes = framework_bytes;
        reservation.preserve_error = !accepted_original || event["kind"] == "request-error";
        self.records
            .get_mut(&serial)
            .expect("active scope")
            .next_sequence += 1;
        self.owned_bytes += batch.body.len();
        self.queued.push_back(batch);
        Ok(accepted_original)
    }

    /// 引擎据此把已知 mutation 结果保留至精确 batch ACK，不能因 notify 成功就清意图。
    pub(crate) fn http_terminal_batch(&self) -> Option<(String, u64)> {
        let reservation = self.http_terminal.as_ref()?;
        let sequence = reservation.sequence?;
        let scope = self.records.get(&reservation.scope)?;
        Some((scope.batch_id(sequence), sequence))
    }

    /// 只暴露下一笔可 pull 批次的身份，不复制正文，不越过旧通知/未 ack 批次。
    #[cfg(test)]
    pub(crate) fn peek_batch_id(&self) -> Option<(String, u64)> {
        let scope = self.records.get(&self.active?)?;
        let flight = scope.in_flight.as_ref()?;
        if flight.body_sent {
            return None;
        }
        let head = self.queued.front()?;
        if head.sequence != flight.sequence {
            return None;
        }
        Some((head.batch_id.clone(), head.sequence))
    }

    /// 普通 WS/status event 必须先通过闭合协议验证。不能动用 HTTP 的终结预留。
    pub(crate) fn enqueue(&mut self, event: &Value) -> Result<(), RoomError> {
        self.enqueue_receipted(event).map(|_| ())
    }

    /// Exact identity of this enqueued observation, never a later unrelated batch.
    pub(crate) fn enqueue_receipted(&mut self, event: &Value) -> Result<(String, u64), RoomError> {
        let serial = self.active.ok_or_else(|| error("scope-changed"))?;
        if self.backpressured {
            return Err(error("backpressure"));
        }
        let sequence = self
            .records
            .get(&serial)
            .ok_or_else(|| error("scope-changed"))?
            .next_sequence;
        if self.queued.len() + self.reserved_queue_slots() >= MAX_QUEUED_BATCHES
            || sequence > MAX_SAFE_INTEGER
            || sequence
                > MAX_SAFE_INTEGER
                    - self.reserved_queue_slots() as u64
                    - u64::from(self.subscription_terminal.is_some())
        {
            return self.backpressure();
        }
        let available = MAX_NATIVE_QUEUED_BYTES
            .saturating_sub(self.owned_bytes)
            .saturating_sub(self.reserved_native_bytes());
        let batch = match self.serialize_batch(serial, sequence, event, available) {
            Ok(batch) => batch,
            Err(_) => return self.backpressure(),
        };
        self.records
            .get_mut(&serial)
            .expect("active scope")
            .next_sequence += 1;
        self.owned_bytes += batch.body.len();
        let receipt = (batch.batch_id.clone(), batch.sequence);
        self.queued.push_back(batch);
        Ok(receipt)
    }

    /// 返回之前转成完整通知债务。无论 send 结果如何都不退款、不重发。
    pub(crate) fn take_notification(
        &mut self,
        document: DocumentId,
        handle: &str,
        subscription_id: &str,
    ) -> Result<Option<String>, RoomError> {
        let serial = self.active_scope(document, handle, subscription_id)?;
        let scope = self.records.get(&serial).expect("active scope");
        if scope.in_flight.is_some() {
            return Ok(None);
        }
        let (sequence, http_terminal, terminal_only) = if let Some(head) = self.queued.front() {
            (head.sequence, head.http_terminal, false)
        } else if self.backpressured && !self.terminal_notification_attempted {
            // HTTP 完成后会使用自己的保证槽发唯一终结，无需提前烧掉一笔唤醒债务。
            if self.http_terminal.is_some() {
                return Ok(None);
            }
            if scope.next_sequence
                > MAX_SAFE_INTEGER - u64::from(self.subscription_terminal.is_some())
            {
                return Err(error("backpressure"));
            }
            (scope.next_sequence, false, true)
        } else {
            return Ok(None);
        };
        let notification = bounded_json(
            &Notification {
                handle,
                subscription_id,
                sequence,
                notification_type: "available",
            },
            MAX_NOTIFICATION_BYTES,
        )?;
        let reserved = if http_terminal {
            self.subscription_reserved_bytes()
        } else {
            self.reserved_framework_bytes()
        };
        if notification.len()
            > MAX_DELIVERED_BYTES
                .saturating_sub(self.delivered_bytes)
                .saturating_sub(reserved)
        {
            return self.backpressure();
        }
        if http_terminal {
            let reservation = self
                .http_terminal
                .as_mut()
                .ok_or_else(|| error("internal-error"))?;
            if reservation.sequence != Some(sequence)
                || notification.len() > reservation.framework_bytes
            {
                return Err(error("internal-error"));
            }
            reservation.framework_bytes -= notification.len();
        }
        self.delivered_bytes += notification.len();
        let scope = self.records.get_mut(&serial).expect("active scope");
        scope.in_flight = Some(InFlight {
            sequence,
            bytes: notification.len(),
            body_sent: false,
        });
        if terminal_only {
            scope.next_sequence += 1;
        }
        if terminal_only || (self.backpressured && http_terminal) {
            self.terminal_notification_attempted = true;
        }
        Ok(Some(notification))
    }

    /// 重复 pull 不复制正文。latch 后不能静默 empty：HTTP 终结优先，其他请求返回
    /// backpressure；原通知正文已被丢弃时也不返回 internal-error 或永久空转。
    pub(crate) fn pull(
        &mut self,
        document: DocumentId,
        handle: &str,
        subscription_id: &str,
    ) -> Result<Option<String>, RoomError> {
        let serial = self.active_scope(document, handle, subscription_id)?;
        let scope = self.records.get(&serial).expect("active scope");
        let Some(in_flight) = &scope.in_flight else {
            return if self.backpressured {
                Err(error("backpressure"))
            } else {
                Ok(None)
            };
        };
        if in_flight.body_sent {
            return if self.backpressured {
                Err(error("backpressure"))
            } else {
                Ok(None)
            };
        }
        let Some(head) = self.queued.front() else {
            return if self.backpressured {
                Err(error("backpressure"))
            } else {
                Err(error("internal-error"))
            };
        };
        if head.sequence != in_flight.sequence || head.batch_id != scope.batch_id(head.sequence) {
            return if self.backpressured {
                Err(error("backpressure"))
            } else {
                Err(error("internal-error"))
            };
        }
        if self.backpressured && !head.http_terminal {
            return Err(error("backpressure"));
        }
        let reserved = if head.http_terminal {
            self.subscription_reserved_bytes()
        } else {
            self.reserved_framework_bytes()
        };
        if head.body.len()
            > MAX_DELIVERED_BYTES
                .saturating_sub(self.delivered_bytes)
                .saturating_sub(reserved)
        {
            return self.backpressure();
        }
        let head = self.queued.pop_front().expect("checked queued body");
        let in_flight = self
            .records
            .get_mut(&serial)
            .expect("active scope")
            .in_flight
            .as_mut()
            .expect("checked in-flight");
        in_flight.body_sent = true;
        in_flight.bytes += head.body.len();
        self.delivered_bytes += head.body.len();
        self.owned_bytes -= head.body.len();
        if head.http_terminal {
            self.http_terminal = None;
        }
        Ok(Some(head.body))
    }

    /// 精确 ack 先释放自己的债务；当前 scope 已过载则同时明确报告终结，不能假装
    /// 继续在线。退休 scope 的合法旧 ack 只退自己的账，不影响新 scope。
    pub(crate) fn ack(
        &mut self,
        document: DocumentId,
        handle: &str,
        subscription_id: &str,
        batch_id: &str,
        sequence: u64,
    ) -> Result<bool, RoomError> {
        if self.destroyed || self.document != Some(document) {
            return Err(error("scope-changed"));
        }
        let scope = self
            .records
            .values_mut()
            .find(|scope| {
                scope.document == document
                    && scope.handle == handle
                    && scope.subscription_id == subscription_id
            })
            .ok_or_else(|| error("scope-changed"))?;
        if !(1..=MAX_SAFE_INTEGER).contains(&sequence) || scope.batch_id(sequence) != batch_id {
            return Err(error("invalid-request"));
        }
        // A revocation consumes no business body and cannot acknowledge a skipped batch.
        if let Some(revoked) = &mut scope.revoked {
            if revoked.sequence == sequence {
                if revoked.bytes == 0 {
                    return Ok(false);
                }
                self.delivered_bytes -= revoked.bytes;
                revoked.bytes = 0;
                return Ok(true);
            }
        }
        let terminal = self.backpressured && !scope.retired;
        if sequence <= scope.acknowledged_through {
            return if terminal {
                Err(error("backpressure"))
            } else {
                Ok(false)
            };
        }
        let Some(in_flight) = &scope.in_flight else {
            return Err(error("invalid-request"));
        };
        if !in_flight.body_sent || sequence != in_flight.sequence {
            return Err(error("invalid-request"));
        }
        let released = scope.in_flight.take().expect("checked in-flight").bytes;
        scope.acknowledged_through = sequence;
        self.delivered_bytes -= released;
        if terminal {
            Err(error("backpressure"))
        } else {
            Ok(true)
        }
    }

    #[cfg(test)]
    pub(crate) fn native_queued_bytes(&self) -> usize {
        self.owned_bytes
    }
    #[cfg(test)]
    pub(crate) fn delivered_unacked_bytes(&self) -> usize {
        self.delivered_bytes
    }
    #[cfg(test)]
    pub(crate) fn scope_record_count(&self) -> usize {
        self.records.len()
    }
    #[cfg(test)]
    pub(crate) fn is_backpressured(&self) -> bool {
        self.backpressured
    }

    /// 只有真正捕获原 marker 的 Destroyed callback 能清框架债务。
    pub(crate) fn destroy(&mut self, instance: InstanceToken) -> bool {
        if self.instance != instance || self.destroyed {
            return false;
        }
        self.retire();
        self.records.clear();
        self.document = None;
        self.delivered_bytes = 0;
        self.destroyed = true;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn instance() -> InstanceToken {
        InstanceToken::new(7)
    }

    fn document() -> DocumentId {
        DocumentId {
            instance: instance(),
            generation: 1,
        }
    }

    fn nonce() -> String {
        "a".repeat(64)
    }

    fn code<T>(result: Result<T, RoomError>) -> String {
        let Err(error) = result else {
            panic!("expected closed error");
        };
        serde_json::to_value(error).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn ready_document() -> DocumentState {
        let mut state = DocumentState::new(instance());
        state.page_finished(instance()).unwrap();
        state
    }

    fn begin(state: &mut DocumentState, intent: u64) -> EvalAttempt {
        state
            .begin_attach(
                instance(),
                nonce(),
                intent,
                11,
                format!("challenge-{intent}"),
            )
            .unwrap()
    }

    fn complete(state: &mut DocumentState, attempt: &EvalAttempt) -> DocumentProof {
        state
            .complete_eval(
                attempt,
                instance(),
                11,
                Some(attempt.document_nonce.as_str()),
                Some(attempt.challenge.as_str()),
            )
            .unwrap()
    }

    fn new_queue() -> DeliveryQueue {
        let mut queue = DeliveryQueue::new(instance());
        queue
            .activate(
                document(),
                "handle".into(),
                "subscription".into(),
                "batch".into(),
            )
            .unwrap();
        queue
    }

    // Payload intentionally exercises only serialization/accounting; protocol validation
    // is the caller's separate responsibility and has its own shared-fixture tests.
    fn event(text: impl Into<String>) -> Value {
        json!({"text": text.into()})
    }

    fn exact_body_size(
        handle: &str,
        subscription: &str,
        prefix: &str,
        sequence: u64,
        bytes: usize,
    ) -> Value {
        let batch_id = format!("{prefix}:{sequence}");
        let empty = event("");
        let overhead = bounded_json(
            &PullReply::Batch {
                batch: Batch {
                    handle,
                    subscription_id: subscription,
                    batch_id: &batch_id,
                    sequence,
                    event: &empty,
                },
            },
            MAX_BATCH_BYTES,
        )
        .unwrap()
        .len();
        assert!(bytes >= overhead);
        event("x".repeat(bytes - overhead))
    }

    fn notified_and_pulled(queue: &mut DeliveryQueue) -> (Value, usize) {
        let notification = queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        let body = queue
            .pull(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        (
            serde_json::from_str(&body).unwrap(),
            notification.len() + body.len(),
        )
    }

    #[test]
    fn loading_document_cannot_attach_and_started_revokes_existing_proof() {
        let mut state = DocumentState::new(instance());
        assert_eq!(
            code(state.begin_attach(instance(), nonce(), 1, 11, "proof".into())),
            "document-unavailable"
        );
        let first_document = state.page_finished(instance()).unwrap();
        let attempt = begin(&mut state, 2);
        let proof = complete(&mut state, &attempt);
        assert_eq!(proof.document, first_document);
        assert!(state.is_current(&proof, 11));
        state.page_started(instance()).unwrap();
        assert!(!state.is_current(&proof, 11));
        assert_eq!(
            code(state.current_document(instance())),
            "document-unavailable"
        );
        let renewed = state.page_finished(instance()).unwrap();
        assert!(renewed.generation > first_document.generation);
        assert!(!state.is_current(&proof, 11));
    }

    #[test]
    fn document_nonce_is_immutable_after_successful_proof() {
        let mut state = ready_document();
        let first = begin(&mut state, 1);
        let proof = complete(&mut state, &first);
        assert_eq!(
            code(state.begin_attach(instance(), "b".repeat(64), 2, 11, "next".into())),
            "document-unavailable"
        );
        // A wrong nonce must not invalidate the current Document's newer proof.
        assert!(state.is_current(&proof, 11));
        let second = begin(&mut state, 3);
        let second_proof = complete(&mut state, &second);
        assert!(state.is_current(&second_proof, 11));
    }

    #[test]
    fn latest_attach_initiation_wins_even_if_physical_slot_is_busy() {
        let mut state = ready_document();
        let old = begin(&mut state, 1);
        assert_eq!(
            code(state.begin_attach(instance(), nonce(), 2, 11, "next".into())),
            "busy"
        );
        assert_eq!(
            code(state.complete_eval(
                &old,
                instance(),
                11,
                Some(&old.document_nonce),
                Some(&old.challenge)
            )),
            "scope-changed"
        );
        assert!(!state.has_physical_eval());
        for intent in [1, 2] {
            assert_eq!(
                code(state.begin_attach(instance(), nonce(), intent, 11, "late-old".into())),
                "scope-changed"
            );
        }
        let latest = begin(&mut state, 3);
        assert_eq!(complete(&mut state, &latest).attach_intent, 3);
    }

    #[test]
    fn earlier_or_duplicate_renderer_intent_cannot_revoke_later_intent() {
        let mut state = ready_document();
        let later = begin(&mut state, 2);
        assert_eq!(
            code(state.begin_attach(instance(), nonce(), 1, 11, "older".into())),
            "scope-changed"
        );
        assert_eq!(
            code(state.begin_attach(instance(), nonce(), 2, 11, "duplicate".into())),
            "scope-changed"
        );
        let proof = complete(&mut state, &later);
        assert!(state.is_current(&proof, 11));
        assert_eq!(
            code(state.begin_attach(instance(), nonce(), 1, 11, "older".into())),
            "scope-changed"
        );
        assert!(state.is_current(&proof, 11));
    }

    #[test]
    fn unproved_old_nonce_cannot_poison_new_document_intent_highwater() {
        let mut state = ready_document();
        let stale = state
            .begin_attach(instance(), "b".repeat(64), 100, 11, "stale".into())
            .unwrap();
        assert_eq!(
            code(state.complete_eval(
                &stale,
                instance(),
                11,
                Some(&nonce()),
                Some(&stale.challenge)
            )),
            "scope-changed"
        );
        let current = begin(&mut state, 1);
        let proof = complete(&mut state, &current);
        assert!(state.is_current(&proof, 11));
        assert_eq!(
            code(state.begin_attach(instance(), "b".repeat(64), 100, 11, "wrong".into())),
            "document-unavailable"
        );
        assert!(state.is_current(&proof, 11));
    }

    #[test]
    fn timeout_does_not_free_physical_slot_and_late_callback_cannot_renew() {
        let mut state = ready_document();
        let timed_out = begin(&mut state, 1);
        assert!(state.eval_timed_out(&timed_out));
        assert!(state.has_physical_eval());
        for intent in 2..5 {
            assert_eq!(
                code(state.begin_attach(instance(), nonce(), intent, 11, "blocked".into())),
                "busy"
            );
            assert!(state.has_physical_eval());
        }
        assert_eq!(
            code(state.complete_eval(
                &timed_out,
                instance(),
                11,
                Some(&timed_out.document_nonce),
                Some(&timed_out.challenge)
            )),
            "scope-changed"
        );
        let current = begin(&mut state, 5);
        // An old duplicate callback cannot release the newer physical slot.
        assert_eq!(
            code(state.complete_eval(
                &timed_out,
                instance(),
                11,
                Some(&timed_out.document_nonce),
                Some(&timed_out.challenge)
            )),
            "scope-changed"
        );
        assert!(state.has_physical_eval());
        complete(&mut state, &current);
        assert!(!state.has_physical_eval());
    }

    #[test]
    fn reload_keeps_physical_capacity_until_old_callback_arrives() {
        let mut state = ready_document();
        let old = begin(&mut state, 1);
        state.page_started(instance()).unwrap();
        state.page_finished(instance()).unwrap();
        assert_eq!(
            code(state.begin_attach(instance(), "b".repeat(64), 2, 11, "new-document".into())),
            "busy"
        );
        assert_eq!(
            code(state.complete_eval(
                &old,
                instance(),
                11,
                Some(&old.document_nonce),
                Some(&old.challenge)
            )),
            "scope-changed"
        );
        let fresh = state
            .begin_attach(instance(), "b".repeat(64), 3, 11, "fresh".into())
            .unwrap();
        let proof = state
            .complete_eval(
                &fresh,
                instance(),
                11,
                Some(&fresh.document_nonce),
                Some(&fresh.challenge),
            )
            .unwrap();
        assert!(state.is_current(&proof, 11));
        assert_ne!(proof.document, old.document);
    }

    #[test]
    fn malformed_wrong_nonce_and_wrong_challenge_callbacks_never_prove_document() {
        for response in [0, 1, 2] {
            let mut state = ready_document();
            let attempt = begin(&mut state, 1);
            let returned_nonce = if response == 0 {
                None
            } else if response == 1 {
                Some("wrong")
            } else {
                Some(attempt.document_nonce.as_str())
            };
            let returned_challenge = if response == 2 {
                Some("wrong")
            } else {
                Some(attempt.challenge.as_str())
            };
            assert_eq!(
                code(state.complete_eval(
                    &attempt,
                    instance(),
                    11,
                    returned_nonce,
                    returned_challenge
                )),
                "scope-changed"
            );
            assert!(!state.has_physical_eval());
        }
    }

    #[test]
    fn wrong_true_instance_cannot_complete_or_destroy_original_instance() {
        let mut state = ready_document();
        let attempt = begin(&mut state, 1);
        let other = InstanceToken::new(8);
        assert_eq!(
            code(state.complete_eval(
                &attempt,
                other,
                11,
                Some(&attempt.document_nonce),
                Some(&attempt.challenge)
            )),
            "document-unavailable"
        );
        assert!(!state.destroyed(other));
        assert!(state.has_physical_eval());
        let proof = complete(&mut state, &attempt);
        assert!(state.is_current(&proof, 11));
        assert!(state.destroyed(instance()));
        assert!(!state.destroyed(instance()));
        assert!(!state.is_current(&proof, 11));
        assert_eq!(
            code(state.page_finished(instance())),
            "document-unavailable"
        );
    }

    #[test]
    fn account_epoch_and_explicit_revocation_invalidate_eval_and_proof() {
        let mut state = ready_document();
        let stale = begin(&mut state, 1);
        assert_eq!(
            code(state.complete_eval(
                &stale,
                instance(),
                12,
                Some(&stale.document_nonce),
                Some(&stale.challenge)
            )),
            "scope-changed"
        );
        let next = begin(&mut state, 2);
        let proof = complete(&mut state, &next);
        assert!(!state.is_current(&proof, 12));
        state.revoke_account(instance()).unwrap();
        assert!(!state.is_current(&proof, 11));
        let outstanding = begin(&mut state, 3);
        state.revoke_account(instance()).unwrap();
        assert!(state.has_physical_eval());
        assert_eq!(
            code(state.complete_eval(
                &outstanding,
                instance(),
                11,
                Some(&outstanding.document_nonce),
                Some(&outstanding.challenge)
            )),
            "scope-changed"
        );
    }

    #[test]
    fn true_destruction_is_the_only_noncallback_physical_slot_release() {
        let mut state = ready_document();
        let attempt = begin(&mut state, 1);
        state.eval_timed_out(&attempt);
        assert!(state.destroyed(instance()));
        assert!(!state.has_physical_eval());
        assert_eq!(
            code(state.complete_eval(
                &attempt,
                instance(),
                11,
                Some(&attempt.document_nonce),
                Some(&attempt.challenge)
            )),
            "document-unavailable"
        );
        let mut replacement = DocumentState::new(InstanceToken::new(8));
        replacement.page_finished(InstanceToken::new(8)).unwrap();
        assert!(!replacement.destroyed(instance()));
        assert!(replacement.current_document(InstanceToken::new(8)).is_ok());
    }

    #[test]
    fn complete_pull_wrapper_hits_exact_byte_limit_and_one_more_fails_closed() {
        let value = exact_body_size("handle", "subscription", "batch", 1, MAX_BATCH_BYTES);
        let mut exact = new_queue();
        exact.enqueue(&value).unwrap();
        assert_eq!(exact.native_queued_bytes(), MAX_BATCH_BYTES);
        let (_, bytes) = notified_and_pulled(&mut exact);
        assert!(bytes > MAX_BATCH_BYTES); // Notification is independently accounted.
        assert_eq!(exact.native_queued_bytes(), 0);
        let mut over = new_queue();
        let value = exact_body_size("handle", "subscription", "batch", 1, MAX_BATCH_BYTES + 1);
        assert_eq!(code(over.enqueue(&value)), "backpressure");
        assert!(over.is_backpressured());
        assert_eq!(over.native_queued_bytes(), 0);
        assert_eq!(
            code(over.pull(document(), "handle", "subscription")),
            "backpressure"
        );
    }

    #[test]
    fn unicode_and_json_escaping_charge_actual_serialized_utf8() {
        let mut queue = new_queue();
        let value = event("中文😀\n\t\u{0000}\"\\");
        queue.enqueue(&value).unwrap();
        let queued = queue.native_queued_bytes();
        let notification = queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        let body = queue
            .pull(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        assert_eq!(queued, body.len());
        assert!(body.contains("中文😀"));
        assert!(body.contains("\\u0000"));
        assert!(body.contains("\\n\\t"));
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["batch"]["event"],
            value
        );
        assert_eq!(
            queue.delivered_unacked_bytes(),
            notification.len() + body.len()
        );
        let mut exact = new_queue();
        let escaped = event("\u{0000}".repeat(MAX_BATCH_BYTES / 6));
        assert_eq!(code(exact.enqueue(&escaped)), "backpressure");
    }

    #[test]
    fn notification_serializer_bounds_complete_output_not_character_count() {
        let exact = "x".repeat(MAX_NOTIFICATION_BYTES - 2);
        assert_eq!(
            bounded_json(&exact, MAX_NOTIFICATION_BYTES).unwrap().len(),
            MAX_NOTIFICATION_BYTES
        );
        assert_eq!(
            code(bounded_json(&(exact + "x"), MAX_NOTIFICATION_BYTES)),
            "backpressure"
        );
        let notification = Notification {
            handle: &"a".repeat(128),
            subscription_id: &"b".repeat(128),
            sequence: MAX_SAFE_INTEGER,
            notification_type: "available",
        };
        assert!(
            bounded_json(&notification, MAX_NOTIFICATION_BYTES)
                .unwrap()
                .len()
                <= MAX_NOTIFICATION_BYTES
        );
    }

    #[test]
    fn aggregate_native_bodies_are_bounded_independently_of_single_batch() {
        let mut exact = new_queue();
        exact
            .enqueue(&exact_body_size(
                "handle",
                "subscription",
                "batch",
                1,
                MAX_NATIVE_QUEUED_BYTES / 2,
            ))
            .unwrap();
        exact
            .enqueue(&exact_body_size(
                "handle",
                "subscription",
                "batch",
                2,
                MAX_NATIVE_QUEUED_BYTES / 2,
            ))
            .unwrap();
        assert_eq!(exact.native_queued_bytes(), MAX_NATIVE_QUEUED_BYTES);
        let mut over = new_queue();
        over.enqueue(&exact_body_size(
            "handle",
            "subscription",
            "batch",
            1,
            MAX_NATIVE_QUEUED_BYTES / 2,
        ))
        .unwrap();
        assert_eq!(
            code(over.enqueue(&exact_body_size(
                "handle",
                "subscription",
                "batch",
                2,
                MAX_NATIVE_QUEUED_BYTES / 2 + 1
            ))),
            "backpressure"
        );
        assert_eq!(over.native_queued_bytes(), 0);
    }

    #[test]
    fn duplicate_pull_never_hands_large_body_to_framework_twice() {
        let mut queue = new_queue();
        queue.enqueue(&event("first")).unwrap();
        queue.enqueue(&event("second")).unwrap();
        assert!(queue
            .pull(document(), "handle", "subscription")
            .unwrap()
            .is_none());
        assert!(queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .is_some());
        let notification_bytes = queue.delivered_unacked_bytes();
        assert!(queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .is_none());
        assert_eq!(queue.delivered_unacked_bytes(), notification_bytes);
        assert_eq!(
            code(queue.ack(document(), "handle", "subscription", "batch:1", 1)),
            "invalid-request"
        );
        assert!(queue
            .pull(document(), "handle", "subscription")
            .unwrap()
            .is_some());
        let delivered = queue.delivered_unacked_bytes();
        for _ in 0..20 {
            assert!(queue
                .pull(document(), "handle", "subscription")
                .unwrap()
                .is_none());
            assert!(queue
                .take_notification(document(), "handle", "subscription")
                .unwrap()
                .is_none());
        }
        assert_eq!(queue.delivered_unacked_bytes(), delivered);
        assert!(queue
            .ack(document(), "handle", "subscription", "batch:1", 1)
            .unwrap());
        assert_eq!(queue.delivered_unacked_bytes(), 0);
        let next = queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&next).unwrap()["sequence"], 2);
    }

    #[test]
    fn wrong_future_and_notification_only_ack_never_refund() {
        let mut queue = new_queue();
        queue.enqueue(&event("first")).unwrap();
        queue
            .take_notification(document(), "handle", "subscription")
            .unwrap();
        let notification_bytes = queue.delivered_unacked_bytes();
        assert_eq!(
            code(queue.ack(document(), "handle", "subscription", "batch:1", 1)),
            "invalid-request"
        );
        assert_eq!(queue.delivered_unacked_bytes(), notification_bytes);
        queue.pull(document(), "handle", "subscription").unwrap();
        let delivered = queue.delivered_unacked_bytes();
        for (batch, sequence) in [
            ("batch:0", 0),
            ("batch:2", 2),
            ("wrong:1", 1),
            ("batch:9007199254740992", MAX_SAFE_INTEGER + 1),
        ] {
            assert_eq!(
                code(queue.ack(document(), "handle", "subscription", batch, sequence)),
                "invalid-request"
            );
            assert_eq!(queue.delivered_unacked_bytes(), delivered);
        }
        assert_eq!(
            code(queue.ack(document(), "different", "subscription", "batch:1", 1)),
            "scope-changed"
        );
        assert_eq!(
            code(queue.pull(document(), "different", "subscription")),
            "scope-changed"
        );
        assert_eq!(queue.delivered_unacked_bytes(), delivered);
    }

    #[test]
    fn exact_historical_duplicates_are_idempotent_without_per_batch_metadata() {
        let mut queue = new_queue();
        for sequence in 1..=3 {
            queue.enqueue(&event("payload")).unwrap();
            notified_and_pulled(&mut queue);
            assert!(queue
                .ack(
                    document(),
                    "handle",
                    "subscription",
                    &format!("batch:{sequence}"),
                    sequence
                )
                .unwrap());
        }
        for sequence in 1..=3 {
            assert!(!queue
                .ack(
                    document(),
                    "handle",
                    "subscription",
                    &format!("batch:{sequence}"),
                    sequence
                )
                .unwrap());
        }
        assert_eq!(queue.delivered_unacked_bytes(), 0);
        assert_eq!(queue.scope_record_count(), 1);
        assert_eq!(
            code(queue.ack(document(), "handle", "subscription", "wrong:1", 1)),
            "invalid-request"
        );
    }

    #[test]
    fn retired_ack_releases_only_own_exact_debt_and_does_not_reactivate() {
        let mut queue = new_queue();
        queue.enqueue(&event("old body")).unwrap();
        let (_, old_debt) = notified_and_pulled(&mut queue);
        queue.enqueue(&event("never sent")).unwrap();
        queue.retire();
        assert_eq!(queue.native_queued_bytes(), 0);
        assert_eq!(queue.delivered_unacked_bytes(), old_debt);
        queue
            .activate(
                document(),
                "next-handle".into(),
                "next-subscription".into(),
                "next-batch".into(),
            )
            .unwrap();
        queue.enqueue(&event("new body")).unwrap();
        let notify = queue
            .take_notification(document(), "next-handle", "next-subscription")
            .unwrap()
            .unwrap();
        let body = queue
            .pull(document(), "next-handle", "next-subscription")
            .unwrap()
            .unwrap();
        let new_debt = notify.len() + body.len();
        assert!(!queue.retire_scope(document(), "handle", "subscription"));
        assert_eq!(
            code(queue.ack(document(), "next-handle", "subscription", "batch:1", 1)),
            "scope-changed"
        );
        assert_eq!(queue.delivered_unacked_bytes(), old_debt + new_debt);
        assert!(queue
            .ack(document(), "handle", "subscription", "batch:1", 1)
            .unwrap());
        assert_eq!(queue.delivered_unacked_bytes(), new_debt);
        assert_eq!(
            code(queue.pull(document(), "handle", "subscription")),
            "scope-changed"
        );
        assert!(queue
            .pull(document(), "next-handle", "next-subscription")
            .unwrap()
            .is_none());
    }

    #[test]
    fn reload_and_new_document_cannot_ack_or_reset_old_document_debt() {
        let mut queue = new_queue();
        queue.enqueue(&event("old body")).unwrap();
        let (_, debt) = notified_and_pulled(&mut queue);
        assert!(queue.revoke_document(instance()));
        assert_eq!(
            code(queue.ack(document(), "handle", "subscription", "batch:1", 1)),
            "scope-changed"
        );
        let next = DocumentId {
            instance: instance(),
            generation: 2,
        };
        queue
            .activate(
                next,
                "new-handle".into(),
                "new-subscription".into(),
                "new-batch".into(),
            )
            .unwrap();
        assert_eq!(queue.delivered_unacked_bytes(), debt);
        assert_eq!(
            code(queue.ack(next, "handle", "subscription", "batch:1", 1)),
            "scope-changed"
        );
        assert_eq!(
            code(queue.ack(document(), "handle", "subscription", "batch:1", 1)),
            "scope-changed"
        );
        assert_eq!(
            code(queue.activate(document(), "h".into(), "s".into(), "b".into())),
            "scope-changed"
        );
        assert!(!queue.destroy(InstanceToken::new(8)));
        assert_eq!(queue.delivered_unacked_bytes(), debt);
        assert!(queue.destroy(instance()));
        assert_eq!(queue.delivered_unacked_bytes(), 0);
        assert_eq!(queue.scope_record_count(), 0);
        assert_eq!(
            code(queue.activate(next, "h".into(), "s".into(), "b".into())),
            "scope-changed"
        );
    }

    fn reserve_retired_quarter(
        queue: &mut DeliveryQueue,
        index: usize,
        extra_body_byte: bool,
    ) -> Result<(), RoomError> {
        let handle = format!("h{index}");
        let subscription = format!("s{index}");
        let prefix = format!("b{index}");
        queue.activate(
            document(),
            handle.clone(),
            subscription.clone(),
            prefix.clone(),
        )?;
        let notification_len = bounded_json(
            &Notification {
                handle: &handle,
                subscription_id: &subscription,
                sequence: 1,
                notification_type: "available",
            },
            MAX_NOTIFICATION_BYTES,
        )
        .unwrap()
        .len();
        let body_len = MAX_DELIVERED_BYTES / 4 - notification_len + usize::from(extra_body_byte);
        queue.enqueue(&exact_body_size(
            &handle,
            &subscription,
            &prefix,
            1,
            body_len,
        ))?;
        queue.take_notification(document(), &handle, &subscription)?;
        queue.pull(document(), &handle, &subscription)?;
        queue.retire();
        Ok(())
    }

    #[test]
    fn cross_retirement_framework_budget_accepts_exact_limit_and_rejects_one_more_byte() {
        let mut exact = DeliveryQueue::new(instance());
        for index in 0..4 {
            reserve_retired_quarter(&mut exact, index, false).unwrap();
        }
        assert_eq!(exact.delivered_unacked_bytes(), MAX_DELIVERED_BYTES);
        assert_eq!(exact.native_queued_bytes(), 0);
        assert!(exact.ack(document(), "h1", "s1", "b1:1", 1).unwrap());
        assert_eq!(exact.delivered_unacked_bytes(), MAX_DELIVERED_BYTES * 3 / 4);

        let mut over = DeliveryQueue::new(instance());
        for index in 0..3 {
            reserve_retired_quarter(&mut over, index, false).unwrap();
        }
        assert_eq!(
            code(reserve_retired_quarter(&mut over, 3, true)),
            "backpressure"
        );
        assert!(over.is_backpressured());
        assert!(over.delivered_unacked_bytes() <= MAX_DELIVERED_BYTES);
        assert!(over.delivered_unacked_bytes() > MAX_DELIVERED_BYTES * 3 / 4);
        assert_eq!(over.native_queued_bytes(), 0);
        // Only the last notification crossed the framework boundary, not its body.
        assert_eq!(
            code(over.ack(document(), "h3", "s3", "b3:1", 1)),
            "invalid-request"
        );
    }

    #[test]
    fn slow_consumer_overflow_closes_scope_instead_of_silently_dropping_frames() {
        let mut queue = new_queue();
        queue.enqueue(&event("delivered")).unwrap();
        let (_, debt) = notified_and_pulled(&mut queue);
        for _ in 0..MAX_QUEUED_BATCHES {
            queue.enqueue(&event("buffered")).unwrap();
        }
        assert_eq!(code(queue.enqueue(&event("overflow"))), "backpressure");
        assert!(queue.is_backpressured());
        assert_eq!(queue.native_queued_bytes(), 0);
        assert_eq!(queue.delivered_unacked_bytes(), debt);
        assert!(queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .is_none());
        assert_eq!(
            code(queue.ack(document(), "handle", "subscription", "batch:1", 1)),
            "backpressure"
        );
        assert_eq!(queue.delivered_unacked_bytes(), 0);
    }

    #[test]
    fn small_notification_debts_hit_metadata_cap_before_byte_cap() {
        let mut queue = DeliveryQueue::new(instance());
        for index in 0..MAX_SCOPE_RECORDS {
            let handle = format!("h{index}");
            let subscription = format!("s{index}");
            queue
                .activate(
                    document(),
                    handle.clone(),
                    subscription.clone(),
                    format!("b{index}"),
                )
                .unwrap();
            queue.enqueue(&event("never pulled")).unwrap();
            queue
                .take_notification(document(), &handle, &subscription)
                .unwrap()
                .unwrap();
            queue.retire();
        }
        assert_eq!(queue.scope_record_count(), MAX_SCOPE_RECORDS);
        let debt = queue.delivered_unacked_bytes();
        assert!(debt < MAX_DELIVERED_BYTES);
        assert_eq!(
            code(queue.activate(
                document(),
                "last-h".into(),
                "last-s".into(),
                "last-b".into()
            )),
            "backpressure"
        );
        assert_eq!(queue.scope_record_count(), MAX_SCOPE_RECORDS);
        assert_eq!(queue.delivered_unacked_bytes(), debt);
        assert_eq!(queue.native_queued_bytes(), 0);
    }

    #[test]
    fn debtless_retired_metadata_can_be_pruned_without_refunding_any_delivery() {
        let mut queue = DeliveryQueue::new(instance());
        for index in 0..MAX_SCOPE_RECORDS * 3 {
            queue
                .activate(
                    document(),
                    format!("h{index}"),
                    format!("s{index}"),
                    format!("b{index}"),
                )
                .unwrap();
            assert!(queue.scope_record_count() <= MAX_SCOPE_RECORDS);
        }
        assert_eq!(queue.delivered_unacked_bytes(), 0);
        assert!(!queue.is_backpressured());
    }

    #[test]
    fn ambiguous_notification_or_pull_send_keeps_precharged_debt_after_detach() {
        let mut queue = new_queue();
        queue.enqueue(&event("ambiguous")).unwrap();
        let notification = queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        // Dropping an output simulates a framework call with an unknown delivery outcome.
        let notification_bytes = notification.len();
        drop(notification);
        let body = queue
            .pull(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        let all_bytes = notification_bytes + body.len();
        drop(body);
        assert!(queue.retire_scope(document(), "handle", "subscription"));
        assert_eq!(queue.delivered_unacked_bytes(), all_bytes);
        assert_eq!(queue.native_queued_bytes(), 0);
        assert!(!queue.destroy(InstanceToken::new(999)));
        assert_eq!(queue.delivered_unacked_bytes(), all_bytes);
    }
    fn http_success(
        text: impl Into<String>,
        operation: crate::arena_room_protocol::Operation,
    ) -> Value {
        json!({"kind":"http-result","requestId":"http-request","operation":operation.as_str(),
            "response":{"syntheticPayload":text.into()}})
    }

    fn reserve_http(queue: &mut DeliveryQueue, operation: crate::arena_room_protocol::Operation) {
        queue
            .reserve_http_terminal("http-request", operation)
            .unwrap();
    }

    #[test]
    fn accepted_http_has_native_framework_and_item_reserves_before_dispatch() {
        use crate::arena_room_protocol::Operation;
        let mut queue = new_queue();
        reserve_http(&mut queue, Operation::Create);
        assert_eq!(queue.reserved_native_bytes(), HTTP_TERMINAL_NATIVE_RESERVE);
        assert_eq!(
            queue.reserved_framework_bytes(),
            HTTP_TERMINAL_FRAMEWORK_RESERVE
        );
        assert_eq!(queue.reserved_queue_slots(), 1);
        assert_eq!(
            code(queue.reserve_http_terminal("other", Operation::Join)),
            "busy"
        );
        for _ in 0..MAX_QUEUED_BATCHES - 1 {
            queue.enqueue(&event("WS")).unwrap();
        }
        assert_eq!(
            code(queue.enqueue(&event("must not steal HTTP item"))),
            "backpressure"
        );
        assert!(queue.is_backpressured());
        assert_eq!(queue.native_queued_bytes(), 0);
        assert_eq!(queue.reserved_native_bytes(), HTTP_TERMINAL_NATIVE_RESERVE);
        assert!(!queue
            .finish_http_terminal(&http_success("late success", Operation::Create))
            .unwrap());
        let (body, _) = notified_and_pulled(&mut queue);
        assert_eq!(body["batch"]["event"]["kind"], "request-error");
        assert_eq!(body["batch"]["event"]["requestId"], "http-request");
        assert_eq!(body["batch"]["event"]["operation"], "create");
        assert_eq!(body["batch"]["event"]["error"]["code"], "backpressure");
        assert_eq!(body["batch"]["event"]["error"]["outcome"], "unknown");
        assert!(queue.http_terminal.is_none());
        assert_eq!(
            code(queue.pull(document(), "handle", "subscription")),
            "backpressure"
        );
    }

    #[test]
    fn ws_cannot_consume_reserved_native_bytes_and_get_fallback_is_not_applicable() {
        use crate::arena_room_protocol::Operation;
        let mut queue = new_queue();
        reserve_http(&mut queue, Operation::Discover);
        let free = MAX_NATIVE_QUEUED_BYTES - HTTP_TERMINAL_NATIVE_RESERVE;
        queue
            .enqueue(&exact_body_size("handle", "subscription", "batch", 1, free))
            .unwrap();
        assert_eq!(queue.native_queued_bytes(), free);
        assert!(!queue
            .finish_http_terminal(&http_success(
                "x".repeat(HTTP_TERMINAL_NATIVE_RESERVE),
                Operation::Discover
            ))
            .unwrap());
        assert!(queue.native_queued_bytes() <= HTTP_TERMINAL_NATIVE_RESERVE);
        let (body, _) = notified_and_pulled(&mut queue);
        assert_eq!(body["batch"]["event"]["error"]["outcome"], "not-applicable");
    }

    #[test]
    fn exact_service_error_outcome_survives_http_completion_during_backpressure() {
        use crate::arena_room_protocol::Operation;
        let mut queue = new_queue();
        reserve_http(&mut queue, Operation::Join);
        assert_eq!(
            code(queue.enqueue(&event("x".repeat(MAX_BATCH_BYTES)))),
            "backpressure"
        );
        let original = json!({"kind":"request-error","requestId":"http-request","operation":"join",
            "error":RoomError::new("not-authenticated","not-applied")});
        assert!(queue.finish_http_terminal(&original).unwrap());
        let (body, _) = notified_and_pulled(&mut queue);
        assert_eq!(body["batch"]["event"], original);
    }

    #[test]
    fn http_upgrade_is_fully_serialized_and_reservation_lives_until_actual_pull() {
        use crate::arena_room_protocol::Operation;
        let mut queue = new_queue();
        reserve_http(&mut queue, Operation::Create);
        let event = http_success("中文😀\n\"".repeat(2000), Operation::Create);
        assert!(queue.finish_http_terminal(&event).unwrap());
        let (batch, sequence) = queue.http_terminal_batch().unwrap();
        assert_eq!((batch.as_str(), sequence), ("batch:1", 1));
        assert!(queue.peek_batch_id().is_none());
        let body_bytes = queue.native_queued_bytes();
        assert!(body_bytes > HTTP_TERMINAL_NATIVE_RESERVE);
        assert_eq!(
            queue.reserved_framework_bytes(),
            body_bytes + MAX_NOTIFICATION_BYTES
        );
        assert!(!queue.cancel_http_terminal());
        let notification = queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        assert_eq!(queue.peek_batch_id(), Some((batch.clone(), sequence)));
        assert_eq!(
            queue.reserved_framework_bytes(),
            body_bytes + MAX_NOTIFICATION_BYTES - notification.len()
        );
        assert_eq!(queue.http_terminal_batch(), Some((batch, sequence)));
        let body = queue
            .pull(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        assert_eq!(body.len(), body_bytes);
        assert!(queue.http_terminal_batch().is_none());
        assert!(queue.peek_batch_id().is_none());
        assert_eq!(queue.reserved_framework_bytes(), 0);
        assert_eq!(
            queue.delivered_unacked_bytes(),
            notification.len() + body_bytes
        );
        assert!(queue
            .ack(document(), "handle", "subscription", "batch:1", 1)
            .unwrap());
        assert_eq!(queue.delivered_unacked_bytes(), 0);
    }

    #[test]
    fn later_ws_overflow_shrinks_unpulled_http_success_without_releasing_its_notification() {
        use crate::arena_room_protocol::Operation;
        let mut queue = new_queue();
        reserve_http(&mut queue, Operation::Create);
        assert!(queue
            .finish_http_terminal(&http_success("x".repeat(100_000), Operation::Create))
            .unwrap());
        let receipt = queue.http_terminal_batch();
        let notification = queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        assert_eq!(
            code(queue.enqueue(&event("x".repeat(MAX_BATCH_BYTES)))),
            "backpressure"
        );
        assert_eq!(queue.http_terminal_batch(), receipt);
        assert_eq!(queue.delivered_unacked_bytes(), notification.len());
        assert!(queue.native_queued_bytes() <= HTTP_TERMINAL_NATIVE_RESERVE);
        assert!(queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .is_none());
        let body = queue
            .pull(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["batch"]["sequence"], 1);
        assert_eq!(body["batch"]["event"]["error"]["outcome"], "unknown");
        assert_eq!(
            code(queue.ack(document(), "handle", "subscription", "batch:1", 1)),
            "backpressure"
        );
        assert_eq!(queue.delivered_unacked_bytes(), 0);
        assert!(queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .is_none());
    }

    #[test]
    fn backpressure_latch_wakes_once_and_never_returns_empty_for_a_terminal_scope() {
        let mut queue = new_queue();
        assert_eq!(
            code(queue.enqueue(&event("x".repeat(MAX_BATCH_BYTES)))),
            "backpressure"
        );
        assert_eq!(
            code(queue.pull(document(), "handle", "subscription")),
            "backpressure"
        );
        let notification = queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        let debt = queue.delivered_unacked_bytes();
        assert_eq!(debt, notification.len());
        for _ in 0..10 {
            assert!(queue
                .take_notification(document(), "handle", "subscription")
                .unwrap()
                .is_none());
            assert_eq!(
                code(queue.pull(document(), "handle", "subscription")),
                "backpressure"
            );
        }
        assert_eq!(queue.delivered_unacked_bytes(), debt);
        queue.retire();
        assert_eq!(queue.delivered_unacked_bytes(), debt);
    }

    #[test]
    fn old_notification_is_not_rebound_to_new_http_terminal_or_refunded_on_overflow() {
        use crate::arena_room_protocol::Operation;
        let mut queue = new_queue();
        queue.enqueue(&event("old body")).unwrap();
        queue
            .take_notification(document(), "handle", "subscription")
            .unwrap();
        let old_debt = queue.delivered_unacked_bytes();
        reserve_http(&mut queue, Operation::Create);
        assert_eq!(
            code(queue.enqueue(&event("x".repeat(MAX_BATCH_BYTES)))),
            "backpressure"
        );
        assert!(!queue
            .finish_http_terminal(&http_success("late", Operation::Create))
            .unwrap());
        assert!(queue.peek_batch_id().is_none());
        assert_eq!(queue.http_terminal_batch(), Some(("batch:2".into(), 2)));
        assert!(queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .is_none());
        assert_eq!(
            code(queue.pull(document(), "handle", "subscription")),
            "backpressure"
        );
        assert_eq!(queue.delivered_unacked_bytes(), old_debt);
    }

    #[test]
    fn no_framework_room_means_no_http_acceptance_and_no_unbudgeted_terminal_notice() {
        use crate::arena_room_protocol::Operation;
        let mut queue = DeliveryQueue::new(instance());
        for index in 0..4 {
            reserve_retired_quarter(&mut queue, index, false).unwrap();
        }
        assert_eq!(queue.delivered_unacked_bytes(), MAX_DELIVERED_BYTES);
        queue
            .activate(
                document(),
                "new".into(),
                "new-sub".into(),
                "new-batch".into(),
            )
            .unwrap();
        let failure = queue
            .reserve_http_terminal("http-request", Operation::Join)
            .unwrap_err();
        assert_eq!(
            (failure.code, failure.outcome),
            ("backpressure", "not-applied")
        );
        assert!(queue.http_terminal.is_none());
        assert_eq!(
            code(queue.take_notification(document(), "new", "new-sub")),
            "backpressure"
        );
        assert_eq!(
            code(queue.pull(document(), "new", "new-sub")),
            "backpressure"
        );
        assert_eq!(queue.delivered_unacked_bytes(), MAX_DELIVERED_BYTES);
        assert!(queue.ack(document(), "h0", "s0", "b0:1", 1).unwrap());
        assert!(queue
            .take_notification(document(), "new", "new-sub")
            .unwrap()
            .is_some());
        assert!(queue.delivered_unacked_bytes() <= MAX_DELIVERED_BYTES);
    }

    #[test]
    fn cancel_and_retire_release_only_unused_http_reservation() {
        use crate::arena_room_protocol::Operation;
        let mut queue = new_queue();
        reserve_http(&mut queue, Operation::Create);
        assert!(queue.cancel_http_terminal());
        assert!(!queue.cancel_http_terminal());
        reserve_http(&mut queue, Operation::Create);
        assert!(queue
            .finish_http_terminal(&http_success("body", Operation::Create))
            .unwrap());
        assert!(!queue.cancel_http_terminal());
        queue
            .take_notification(document(), "handle", "subscription")
            .unwrap();
        let debt = queue.delivered_unacked_bytes();
        queue.retire();
        assert_eq!(queue.delivered_unacked_bytes(), debt);
        assert_eq!(queue.native_queued_bytes(), 0);
        assert!(queue.http_terminal.is_none());
        assert!(!queue.destroy(InstanceToken::new(88)));
        assert_eq!(queue.delivered_unacked_bytes(), debt);
    }

    #[test]
    fn ws_pull_cannot_spend_framework_bytes_reserved_for_an_accepted_http_terminal() {
        use crate::arena_room_protocol::Operation;
        let mut queue = DeliveryQueue::new(instance());
        for index in 0..3 {
            reserve_retired_quarter(&mut queue, index, false).unwrap();
        }
        let debt = queue.delivered_unacked_bytes();
        queue
            .activate(
                document(),
                "handle".into(),
                "subscription".into(),
                "batch".into(),
            )
            .unwrap();
        reserve_http(&mut queue, Operation::Create);
        queue
            .enqueue(&exact_body_size(
                "handle",
                "subscription",
                "batch",
                1,
                MAX_NATIVE_QUEUED_BYTES - HTTP_TERMINAL_NATIVE_RESERVE,
            ))
            .unwrap();
        assert!(queue
            .finish_http_terminal(&http_success("small", Operation::Create))
            .unwrap());
        assert_eq!(
            queue.reserved_framework_bytes(),
            HTTP_TERMINAL_FRAMEWORK_RESERVE
        );
        let notification = queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        assert_eq!(
            code(queue.pull(document(), "handle", "subscription")),
            "backpressure"
        );
        assert_eq!(queue.delivered_unacked_bytes(), debt + notification.len());
        assert_eq!(
            queue.reserved_framework_bytes(),
            HTTP_TERMINAL_FRAMEWORK_RESERVE
        );
        assert!(queue.native_queued_bytes() <= HTTP_TERMINAL_NATIVE_RESERVE);
        assert_eq!(queue.http_terminal_batch(), Some(("batch:2".into(), 2)));
        assert!(
            queue.delivered_unacked_bytes() + queue.reserved_framework_bytes()
                <= MAX_DELIVERED_BYTES
        );
    }

    #[test]
    fn a_small_success_does_not_refund_http_guarantee_before_pull() {
        use crate::arena_room_protocol::Operation;
        let mut queue = new_queue();
        reserve_http(&mut queue, Operation::Create);
        assert!(queue
            .finish_http_terminal(&http_success("small", Operation::Create))
            .unwrap());
        assert_eq!(
            queue.native_queued_bytes() + queue.reserved_native_bytes(),
            HTTP_TERMINAL_NATIVE_RESERVE
        );
        assert_eq!(
            queue.reserved_framework_bytes(),
            HTTP_TERMINAL_FRAMEWORK_RESERVE
        );
        let notification = queue
            .take_notification(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        assert_eq!(
            queue.reserved_framework_bytes() + notification.len(),
            HTTP_TERMINAL_FRAMEWORK_RESERVE
        );
        queue
            .pull(document(), "handle", "subscription")
            .unwrap()
            .unwrap();
        assert_eq!(queue.reserved_native_bytes(), 0);
        assert_eq!(queue.reserved_framework_bytes(), 0);
    }
    #[test]
    fn revoked_notification_has_independent_exact_debt_while_body_is_unacked() {
        let mut queue = new_queue();
        queue.enqueue(&event("old body")).unwrap();
        let (_, old_debt) = notified_and_pulled(&mut queue);
        queue
            .reserve_http_terminal(
                "auth-request",
                crate::arena_room_protocol::Operation::Discover,
            )
            .unwrap();
        let raw = queue
            .take_http_revoked(&RoomError::new("not-authenticated", "not-applicable"))
            .unwrap();
        assert!(raw.len() <= MAX_NOTIFICATION_BYTES);
        let revoked: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(revoked["type"], "revoked");
        assert_eq!(revoked["sequence"], 2);
        assert_eq!(queue.delivered_unacked_bytes(), old_debt + raw.len());
        assert!(queue
            .take_http_revoked(&RoomError::new("not-authenticated", "not-applicable"))
            .is_err());
        queue.retire();
        let charged = queue.delivered_unacked_bytes();
        assert!(queue
            .ack(document(), "handle", "subscription", "wrong:2", 2)
            .is_err());
        assert!(queue
            .ack(document(), "handle", "subscription", "batch:3", 3)
            .is_err());
        assert_eq!(queue.delivered_unacked_bytes(), charged);
        assert!(queue
            .ack(document(), "handle", "subscription", "batch:2", 2)
            .unwrap());
        assert_eq!(queue.delivered_unacked_bytes(), old_debt);
        assert!(!queue
            .ack(document(), "handle", "subscription", "batch:2", 2)
            .unwrap());
        assert!(queue
            .ack(document(), "handle", "subscription", "batch:1", 1)
            .unwrap());
        assert_eq!(queue.delivered_unacked_bytes(), 0);
    }

    #[test]
    fn revoked_unknown_send_and_reload_never_refund_framework_debt() {
        let mut queue = new_queue();
        queue
            .reserve_http_terminal(
                "auth-request",
                crate::arena_room_protocol::Operation::Create,
            )
            .unwrap();
        let raw = queue
            .take_http_revoked(&RoomError::new("not-authenticated", "not-applied"))
            .unwrap();
        let bytes = raw.len();
        drop(raw);
        queue.retire();
        assert_eq!(queue.delivered_unacked_bytes(), bytes);
        queue.revoke_document(instance());
        queue
            .activate(
                DocumentId {
                    instance: instance(),
                    generation: 2,
                },
                "next".into(),
                "new".into(),
                "next-batch".into(),
            )
            .unwrap();
        assert!(queue
            .ack(document(), "handle", "subscription", "batch:1", 1)
            .is_err());
        assert_eq!(queue.delivered_unacked_bytes(), bytes);
        assert!(!queue.destroy(InstanceToken::new(888)));
        assert_eq!(queue.delivered_unacked_bytes(), bytes);
        assert!(queue.destroy(instance()));
        assert_eq!(queue.delivered_unacked_bytes(), 0);
    }
    #[test]
    fn subscription_revocation_is_public_subscribe_metadata_never_ticket_body() {
        let mut queue = new_queue();
        queue.reserve_subscription_terminal().unwrap();
        assert!(queue.finish_http_terminal(&json!({"kind":"http-result","requestId":"","operation":"ticket","response":{"ticket":"secret-canary"}})).is_err());
        let raw = queue
            .take_subscription_revoked(&RoomError::new("not-authenticated", "not-applied"))
            .unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["operation"], "subscribe");
        assert!(value["requestId"].is_null());
        assert_eq!(value["error"]["outcome"], "not-applicable");
        assert!(!raw.contains("ticket"));
        assert!(!raw.contains("secret-canary"));
        assert!(raw.len() <= MAX_NOTIFICATION_BYTES);
        assert!(queue
            .ack(document(), "handle", "subscription", "batch:1", 1)
            .unwrap());
        assert_eq!(queue.delivered_unacked_bytes(), 0);
    }

    #[test]
    fn revoked_notifications_match_shared_ipc_golden() {
        use crate::arena_room_protocol::Operation;

        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/desktop-room-ipc.json"
        ))
        .unwrap();
        let expected = fixture["revokedNotifications"].as_array().unwrap();
        assert_eq!(expected.len(), 4);
        for golden in expected {
            let handle = golden["handle"].as_str().unwrap();
            let subscription = golden["subscriptionId"].as_str().unwrap();
            let mut queue = DeliveryQueue::new(instance());
            queue
                .activate(
                    document(),
                    handle.into(),
                    subscription.into(),
                    "native-revoked".into(),
                )
                .unwrap();
            match golden["operation"].as_str().unwrap() {
                "subscribe" => queue.reserve_subscription_terminal().unwrap(),
                operation => {
                    let operation = match operation {
                        "create" => Operation::Create,
                        "session" => Operation::Session,
                        "join" => Operation::Join,
                        _ => panic!("unexpected shared revocation operation"),
                    };
                    queue
                        .reserve_http_terminal(golden["requestId"].as_str().unwrap(), operation)
                        .unwrap();
                }
            }
            let mut failure = RoomError::new(
                golden["error"]["code"].as_str().unwrap(),
                golden["error"]["outcome"].as_str().unwrap(),
            );
            if let Some(code) = golden["error"]["serverCode"].as_str() {
                failure = failure.with_server_code(code);
            }
            let raw = if golden["operation"] == "subscribe" {
                queue.take_subscription_revoked(&failure)
            } else {
                queue.take_http_revoked(&failure)
            }
            .unwrap();
            assert!(raw.len() <= MAX_NOTIFICATION_BYTES);
            assert_eq!(queue.delivered_unacked_bytes(), raw.len());
            let actual: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(actual["batchId"], "native-revoked:1");
            assert_eq!(actual["sequence"], 1);
            // Only Native-minted identity differs; every business/error field must
            // equal the same golden consumed by the TypeScript contract and bridge.
            let mut normalized = actual.clone();
            normalized["batchId"] = golden["batchId"].clone();
            normalized["sequence"] = golden["sequence"].clone();
            assert_eq!(&normalized, golden);
            assert!(queue
                .ack(document(), handle, subscription, "native-revoked:1", 1)
                .unwrap());
            assert_eq!(queue.delivered_unacked_bytes(), 0);
        }
    }
    #[test]
    fn dual_terminal_reservations_share_caps_and_only_one_revocation_wins() {
        use crate::arena_room_protocol::Operation;
        for subscription_wins in [false, true] {
            let mut queue = new_queue();
            queue.enqueue(&event("old body")).unwrap();
            let (_, old_debt) = notified_and_pulled(&mut queue);
            queue.reserve_subscription_terminal().unwrap();
            reserve_http(&mut queue, Operation::Create);
            assert_eq!(
                queue.reserved_native_bytes(),
                MAX_NOTIFICATION_BYTES + HTTP_TERMINAL_NATIVE_RESERVE
            );
            assert_eq!(
                queue.reserved_framework_bytes(),
                MAX_NOTIFICATION_BYTES + HTTP_TERMINAL_FRAMEWORK_RESERVE
            );
            // Ticket retries reuse the same bounded reservation, not a new slot.
            queue.reserve_subscription_terminal().unwrap();
            let failure = RoomError::new("storage-unavailable", "unknown");
            let raw = if subscription_wins {
                queue.take_subscription_revoked(&failure)
            } else {
                queue.take_http_revoked(&failure)
            }
            .unwrap();
            assert!(queue.take_subscription_revoked(&failure).is_err());
            assert!(queue.take_http_revoked(&failure).is_err());
            assert_eq!(queue.reserved_native_bytes(), 0);
            assert_eq!(queue.reserved_framework_bytes(), 0);
            assert_eq!(queue.delivered_unacked_bytes(), old_debt + raw.len());
            queue.retire();
            assert_eq!(queue.delivered_unacked_bytes(), old_debt + raw.len());
            assert!(queue
                .ack(document(), "handle", "subscription", "batch:2", 2)
                .unwrap());
            assert!(!queue
                .ack(document(), "handle", "subscription", "batch:2", 2)
                .unwrap());
            assert_eq!(queue.delivered_unacked_bytes(), old_debt);
            assert!(queue
                .ack(document(), "handle", "subscription", "batch:1", 1)
                .unwrap());
            assert_eq!(queue.delivered_unacked_bytes(), 0);
        }
    }

    #[test]
    fn subscription_reserve_survives_business_http_delivery_and_does_not_block_next_request() {
        use crate::arena_room_protocol::Operation;
        let mut queue = new_queue();
        queue.reserve_subscription_terminal().unwrap();
        for sequence in 1..=2 {
            reserve_http(&mut queue, Operation::Leave);
            queue
                .finish_http_terminal(&http_success("left", Operation::Leave))
                .unwrap();
            queue
                .take_notification(document(), "handle", "subscription")
                .unwrap()
                .unwrap();
            queue
                .pull(document(), "handle", "subscription")
                .unwrap()
                .unwrap();
            assert_eq!(queue.reserved_native_bytes(), MAX_NOTIFICATION_BYTES);
            assert_eq!(queue.reserved_framework_bytes(), MAX_NOTIFICATION_BYTES);
            assert!(queue
                .ack(
                    document(),
                    "handle",
                    "subscription",
                    &format!("batch:{sequence}"),
                    sequence
                )
                .unwrap());
        }
        let raw = queue
            .take_subscription_revoked(&RoomError::new("storage-unavailable", "not-applicable"))
            .unwrap();
        assert_eq!(queue.delivered_unacked_bytes(), raw.len());
    }

    #[test]
    fn dual_reserve_native_boundary_and_full_framework_reject_without_overcommit() {
        use crate::arena_room_protocol::Operation;
        for extra in [0, 1] {
            let mut queue = new_queue();
            queue.reserve_subscription_terminal().unwrap();
            reserve_http(&mut queue, Operation::Create);
            let capacity =
                MAX_NATIVE_QUEUED_BYTES - MAX_NOTIFICATION_BYTES - HTTP_TERMINAL_NATIVE_RESERVE;
            let result = queue.enqueue(&exact_body_size(
                "handle",
                "subscription",
                "batch",
                1,
                capacity + extra,
            ));
            assert_eq!(result.is_ok(), extra == 0);
            assert!(
                queue.native_queued_bytes() + queue.reserved_native_bytes()
                    <= MAX_NATIVE_QUEUED_BYTES
            );
            assert!(
                queue.delivered_unacked_bytes() + queue.reserved_framework_bytes()
                    <= MAX_DELIVERED_BYTES
            );
            queue
                .take_subscription_revoked(&RoomError::new("storage-unavailable", "not-applicable"))
                .unwrap();
        }
        let mut queue = DeliveryQueue::new(instance());
        for index in 0..4 {
            reserve_retired_quarter(&mut queue, index, false).unwrap();
        }
        queue
            .activate(
                document(),
                "full".into(),
                "full-sub".into(),
                "full-batch".into(),
            )
            .unwrap();
        assert_eq!(code(queue.reserve_subscription_terminal()), "backpressure");
        assert_eq!(queue.delivered_unacked_bytes(), MAX_DELIVERED_BYTES);
        assert_eq!(queue.reserved_framework_bytes(), 0);
    }
}
