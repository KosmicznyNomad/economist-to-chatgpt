from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class Mode(str, Enum):
    OWNED = "OWNED"
    WATCH = "WATCH"


class State(str, Enum):
    NORMAL_RUN = "NORMAL_RUN"
    SPIKE_LOCK = "SPIKE_LOCK"
    EXITED_COOLDOWN = "EXITED_COOLDOWN"
    REENTRY_WINDOW = "REENTRY_WINDOW"


class Action(str, Enum):
    HOLD = "HOLD"
    SELL_PARTIAL = "SELL_PARTIAL"
    SELL_ALL = "SELL_ALL"
    WAIT = "WAIT"
    BUY_REENTER = "BUY_REENTER"
    BUY_ALERT = "BUY_ALERT"


class Trigger(str, Enum):
    NONE = "none"
    WARN = "warn"
    FALSIFIER = "falsifier"
    CONFIRM = "confirm"


class ReasonCode(str, Enum):
    NO_NEW_BAR = "NO_NEW_BAR"
    NO_TRIGGER = "NO_TRIGGER"
    ENTRY_WAIT_DATA = "ENTRY_WAIT_DATA"
    ENTRY_WATCH = "ENTRY_WATCH"
    ENTRY_SETUP = "ENTRY_SETUP"
    ENTRY_NO_BUY_TREND = "ENTRY_NO_BUY_TREND"
    ENTRY_NO_BUY_OVERHEAT = "ENTRY_NO_BUY_OVERHEAT"
    BUY_TRIGGER = "BUY_TRIGGER"
    FALSIFIER = "FALSIFIER"
    WARN = "WARN"
    STOP_HIT = "STOP_HIT"
    TREND_BREAK = "TREND_BREAK"
    SPIKE_DETECTED = "SPIKE_DETECTED"
    SPIKE_ABSORBED = "SPIKE_ABSORBED"
    SPIKE_LOCK_TIMEOUT = "SPIKE_LOCK_TIMEOUT"
    BASE_HIT = "BASE_HIT"
    BULL_HIT = "BULL_HIT"
    COOLDOWN_ACTIVE = "COOLDOWN_ACTIVE"
    OPEN_REENTRY_WINDOW = "OPEN_REENTRY_WINDOW"
    REENTRY_TRIGGERED = "REENTRY_TRIGGERED"
    REENTRY_EXPIRED = "REENTRY_EXPIRED"
    PERMANENT_EXIT = "PERMANENT_EXIT"
    DATA_FETCH_ERROR = "DATA_FETCH_ERROR"
    DATA_SUSPECTED = "DATA_SUSPECTED"
    DUPLICATE_ACTION_BLOCKED = "DUPLICATE_ACTION_BLOCKED"


class AnomalyCode(str, Enum):
    MOMENTUM_WARN = "MOMENTUM_WARN"
    TREND_DETERIORATION = "TREND_DETERIORATION"
    ABNORMAL_DRAWDOWN = "ABNORMAL_DRAWDOWN"
    EXTREME_DRAWDOWN = "EXTREME_DRAWDOWN"
    FIXED_DAILY_DROP = "FIXED_DAILY_DROP"
    MULTIDAY_DROP = "MULTIDAY_DROP"
    RECENT_ABNORMAL_TREND = "RECENT_ABNORMAL_TREND"
    STD_PULLBACK = "STD_PULLBACK"


class AnomalySeverity(str, Enum):
    INFO = "INFO"
    HIGH = "HIGH"


Bar = Dict[str, Any]
PositionRecord = Dict[str, Any]
ComputedSnapshot = Dict[str, Any]


@dataclass
class ActionPayload:
    type: Action
    sell_pct: Optional[float] = None
    buy_pct_of_target: Optional[float] = None
    price_hint: Optional[float] = None


@dataclass
class ReasonPayload:
    code: ReasonCode
    text: str


@dataclass
class DecisionOfDay:
    bar_date: str
    key: str
    symbol: Dict[str, Any]
    mode: Mode
    state_before: State
    state_after: State
    action: ActionPayload
    reason: ReasonPayload
    levels: ComputedSnapshot
    targets: Dict[str, Any]
    kpi: Dict[str, Any] = field(default_factory=dict)
    transitions: Dict[str, Any] = field(default_factory=dict)
    schema: str = "psm_v4.decision.v1"

    def to_dict(self) -> Dict[str, Any]:
        blob = asdict(self)
        blob["mode"] = self.mode.value
        blob["state_before"] = self.state_before.value
        blob["state_after"] = self.state_after.value
        blob["action"]["type"] = self.action.type.value
        blob["reason"]["code"] = self.reason.code.value
        return blob


@dataclass
class AnomalyEvent:
    bar_date: str
    key: str
    symbol: Dict[str, Any]
    code: AnomalyCode
    severity: AnomalySeverity
    metrics: Dict[str, Any]
    text: str
    schema: str = "psm_v4.anomaly.v1"

    def to_dict(self) -> Dict[str, Any]:
        blob = asdict(self)
        blob["code"] = self.code.value
        blob["severity"] = self.severity.value
        return blob


@dataclass
class DailyRunResult:
    bar_date: Optional[str]
    decisions: List[DecisionOfDay]
    telegram_message: str
    summary: Dict[str, Any]
    telegram_messages: List[str] = field(default_factory=list)
    anomaly_events: List[AnomalyEvent] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "bar_date": self.bar_date,
            "decisions": [item.to_dict() for item in self.decisions],
            "telegram_message": self.telegram_message,
            "telegram_messages": list(self.telegram_messages),
            "summary": self.summary,
            "anomaly_events": [item.to_dict() for item in self.anomaly_events],
        }
