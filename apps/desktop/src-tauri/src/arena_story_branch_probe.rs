//! Test-only, opt-in boundary observations. No I/O or growing buffers while locked.
use std::cell::{Cell, RefCell};
use std::time::Instant;

const CAPACITY: usize = 64;
#[derive(Clone, Copy, Debug, serde::Serialize)]
pub(super) struct Event {
    pub name: &'static str,
    pub nanos: u64,
    pub primary: Option<i32>,
    pub disk_full: bool,
    pub extended: Option<i32>,
    pub autocommit: Option<bool>,
    pub index: Option<u64>,
}
struct State {
    start: Option<Instant>,
    slots: [Option<Event>; CAPACITY],
    len: usize,
    acquired: [bool; 3],
}
impl State {
    const fn new() -> Self {
        Self {
            start: None,
            slots: [None; CAPACITY],
            len: 0,
            acquired: [false; 3],
        }
    }
}
thread_local! {
    static STATE: RefCell<State> = const { RefCell::new(State::new()) };
    static INVALID: Cell<bool> = const { Cell::new(false) };
}
fn invalidate() {
    let _ = INVALID.try_with(|v| v.set(true));
}
fn visit(f: impl FnOnce(&mut State)) {
    if STATE
        .try_with(|cell| {
            if let Ok(mut state) = cell.try_borrow_mut() {
                f(&mut state);
            } else {
                invalidate();
            }
        })
        .is_err()
    {
        invalidate();
    }
}
fn push(state: &mut State, name: &'static str, raw: Option<(&rusqlite::Error, bool, Option<u64>)>) {
    let Some(start) = state.start else {
        return;
    };
    if state.len == CAPACITY {
        invalidate();
        return;
    }
    let (primary, extended, autocommit, index) = match raw {
        Some((rusqlite::Error::SqliteFailure(code, _), autocommit, index)) => (
            Some(code.extended_code & 255),
            Some(code.extended_code),
            Some(autocommit),
            index,
        ),
        Some((_, autocommit, index)) => (None, None, Some(autocommit), index),
        None => (None, None, None, None),
    };
    state.slots[state.len] = Some(Event {
        name,
        nanos: start.elapsed().as_nanos().try_into().unwrap_or(u64::MAX),
        primary,
        disk_full: matches!(raw, Some((rusqlite::Error::SqliteFailure(code, _), _, _)) if code.code == rusqlite::ErrorCode::DiskFull),
        extended,
        autocommit,
        index,
    });
    state.len += 1;
}
pub(super) fn mark(name: &'static str) {
    visit(|s| push(s, name, None));
}
pub(super) fn sqlite_error(
    name: &'static str,
    error: &rusqlite::Error,
    autocommit: bool,
    index: Option<u64>,
) {
    visit(|s| push(s, name, Some((error, autocommit, index))));
}
#[derive(Clone, Copy)]
pub(super) enum Guard {
    Stages = 0,
    Permit = 1,
    Connection = 2,
}
impl Guard {
    fn event(self, boundary: usize) -> &'static str {
        [
            [
                "stages.before-acquire",
                "stages.acquired",
                "stages.before-release",
                "stages.after-release",
            ],
            [
                "permit.before-admission",
                "permit.acquired",
                "permit.before-release",
                "permit.after-release",
            ],
            [
                "connection.before-acquire",
                "connection.acquired",
                "connection.before-release",
                "connection.after-release",
            ],
        ][self as usize][boundary]
    }
}
// These sentinels never own or borrow the actual guard. Declare After, guard,
// acquired, Before, in that order. Rust's natural reverse drop brackets release.
pub(super) struct Release {
    guard: Guard,
    boundary: usize,
}
impl Release {
    pub(super) fn after(guard: Guard) -> Self {
        mark(guard.event(0));
        Self { guard, boundary: 3 }
    }
    pub(super) fn before(guard: Guard) -> Self {
        visit(|s| {
            if s.start.is_some() {
                s.acquired[guard as usize] = true;
                push(s, guard.event(1), None);
            }
        });
        Self { guard, boundary: 2 }
    }
}
impl Drop for Release {
    fn drop(&mut self) {
        visit(|s| {
            if s.acquired[self.guard as usize] {
                push(s, self.guard.event(self.boundary), None);
            }
        });
    }
}
pub(super) fn enable() {
    INVALID.with(|v| v.set(false));
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        assert!(s.start.is_none());
        *s = State::new();
        s.start = Some(Instant::now());
    });
}
pub(super) fn take() -> Vec<Event> {
    assert!(
        !INVALID.with(Cell::get),
        "invalid/overflowed boundary observation"
    );
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        assert!(s.start.is_some());
        let result = s.slots[..s.len].iter().map(|e| e.unwrap()).collect();
        *s = State::new();
        result
    })
}
pub(super) fn validate(events: &[Event], transaction: &str) {
    assert!(events.windows(2).all(|w| w[0].nanos <= w[1].nanos));
    let pos = |name| {
        let found: Vec<_> = events
            .iter()
            .enumerate()
            .filter(|(_, e)| e.name == name)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(found.len(), 1, "missing/duplicate {name}");
        found[0]
    };
    for guard in [Guard::Stages, Guard::Permit, Guard::Connection] {
        let p = [0, 1, 2, 3].map(|b| pos(guard.event(b)));
        assert!(p.windows(2).all(|w| w[0] < w[1]));
    }
    assert!(pos("connection.after-release") < pos("permit.before-release"));
    assert!(pos("permit.after-release") < pos("stages.before-release"));
    assert!(pos("sqlite.begin.before") < pos("sqlite.begin.after"));
    let (before, after) = match transaction {
        "commit" => ("sqlite.commit.before", "sqlite.commit.after"),
        "rollback" => ("sqlite.rollback.before", "sqlite.rollback.after"),
        _ => panic!("unexpected transaction"),
    };
    assert!(pos("sqlite.begin.after") < pos(before));
    assert!(pos(before) < pos(after));
    assert!(pos(after) < pos("connection.before-release"));
}
#[test]
fn paired_sentinels_bracket_natural_release_and_early_return() {
    struct RealGuard;
    impl Drop for RealGuard {
        fn drop(&mut self) {
            mark("actual-drop");
        }
    }
    fn early() -> Result<(), ()> {
        let _after = Release::after(Guard::Stages);
        let _guard = RealGuard;
        let _before = Release::before(Guard::Stages);
        Err(())
    }
    enable();
    assert!(early().is_err());
    let e = take();
    assert_eq!(
        e.iter().map(|e| e.name).collect::<Vec<_>>(),
        [
            "stages.before-acquire",
            "stages.acquired",
            "stages.before-release",
            "actual-drop",
            "stages.after-release"
        ]
    );
    // No accumulation while disabled, including Drop and error callbacks.
    for _ in 0..100 {
        mark("disabled");
    }
    enable();
    assert!(take().is_empty());
}

#[test]
fn failed_acquisition_and_overflow_are_not_successful_observations() {
    enable();
    {
        let _after = Release::after(Guard::Stages);
    }
    assert_eq!(
        take().iter().map(|e| e.name).collect::<Vec<_>>(),
        ["stages.before-acquire"]
    );
    enable();
    for _ in 0..=CAPACITY {
        mark("overflow");
    }
    assert!(std::panic::catch_unwind(take).is_err());
    // Reset the intentionally invalid test observer without invoking Drop I/O.
    STATE.with(|s| *s.borrow_mut() = State::new());
    INVALID.with(|v| v.set(false));
    enable();
    STATE.with(|s| {
        let _borrow = s.borrow_mut();
        mark("borrow-conflict");
    });
    assert!(std::panic::catch_unwind(take).is_err());
    STATE.with(|s| *s.borrow_mut() = State::new());
    INVALID.with(|v| v.set(false));
}
