"""Automatic process and asyncio telemetry with durable, bounded buffering."""

from __future__ import annotations

import atexit
import asyncio
import json
import os
import platform
import sys
import threading
import time
import traceback
import uuid
from contextlib import contextmanager
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Iterator

from .client import GoodbaseClient


class GoodbaseConsent(str, Enum):
    GRANTED = "granted"
    ESSENTIAL = "essential"
    DENIED = "denied"


class GoodbaseTelemetry:
    def __init__(self, client: GoodbaseClient, app_id: str, release: str, build_number: str, *, consent: GoodbaseConsent = GoodbaseConsent.DENIED, spool_dir: str | os.PathLike[str] | None = None):
        self.client, self.app_id, self.release, self.build_number = client, app_id, release, build_number
        self.consent, self.session_id = consent, str(uuid.uuid4())
        root = Path(spool_dir or Path.home() / ".goodbase" / "telemetry")
        self.spool = root / ("".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in app_id) + ".jsonl")
        self._lock, self._breadcrumbs, self._keys, self._started = threading.RLock(), [], {}, False
        self._previous_hook = sys.excepthook
        self._previous_thread_hook = getattr(threading, "excepthook", None)

    def start(self, loop: asyncio.AbstractEventLoop | None = None) -> None:
        if self._started or self.consent == GoodbaseConsent.DENIED:
            return
        self._started = True
        sys.excepthook = self._exception_hook
        if self._previous_thread_hook is not None:
            threading.excepthook = self._thread_exception_hook
        if loop is not None:
            previous = loop.get_exception_handler()
            def handler(event_loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
                error = context.get("exception") or RuntimeError(context.get("message", "asyncio error"))
                self.capture_exception(error, fatal=False, exception_type="AsyncioError")
                (previous or event_loop.default_exception_handler)(event_loop, context) if previous else event_loop.default_exception_handler(context)
            loop.set_exception_handler(handler)
        atexit.register(self.stop)
        self._session("start")
        self.flush()

    def stop(self) -> None:
        if not self._started:
            return
        self._session("end", "normal")
        sys.excepthook = self._previous_hook
        if self._previous_thread_hook is not None:
            threading.excepthook = self._previous_thread_hook
        self._started = False

    def set_consent(self, value: GoodbaseConsent) -> None:
        self.consent = value
        if value == GoodbaseConsent.DENIED:
            self.spool.unlink(missing_ok=True)
            self.stop()
        else:
            self.start()

    def breadcrumb(self, message: str, **data: Any) -> None:
        with self._lock:
            self._breadcrumbs.append({"message": message[:500], "data": data, "at": self._now()})
            self._breadcrumbs[:] = self._breadcrumbs[-50:]

    def set_custom_key(self, key: str, value: Any) -> None:
        with self._lock:
            if key in self._keys or len(self._keys) < 64:
                self._keys[key[:100]] = str(value)[:1000]

    def capture_exception(self, error: BaseException, *, fatal: bool = False, exception_type: str | None = None) -> None:
        with self._lock:
            crumbs, keys = list(self._breadcrumbs), dict(self._keys)
        self._send("crash", {"appId": self.app_id, "platform": "python", "occurredAt": self._now(), "title": str(error)[:300], "stackTrace": "".join(traceback.format_exception(type(error), error, error.__traceback__))[-32000:], "sessionId": self.session_id, "release": self.release, "buildNumber": self.build_number, "fatal": fatal, "exceptionType": exception_type or type(error).__name__, "breadcrumbs": crumbs, "customKeys": keys, "device": {"python": platform.python_version(), "os": platform.platform()}})

    @contextmanager
    def trace(self, name: str, trace_type: str = "custom") -> Iterator[None]:
        started = time.perf_counter()
        try:
            yield
        except BaseException as error:
            self.capture_exception(error)
            raise
        finally:
            self._send("trace", {"appId": self.app_id, "type": trace_type, "name": name[:200], "durationMs": (time.perf_counter() - started) * 1000, "occurredAt": self._now()})

    def flush(self) -> None:
        if self.consent == GoodbaseConsent.DENIED or not self.spool.exists():
            return
        with self._lock:
            events = [json.loads(line) for line in self.spool.read_text(encoding="utf-8").splitlines() if line.strip()]
            remaining = []
            for event in events:
                try:
                    self._upload(event)
                except Exception:
                    remaining.append(event)
            self._replace(remaining[-100:])

    def _session(self, action: str, ended_reason: str | None = None) -> None:
        self._send("session", {"appId": self.app_id, "sessionId": self.session_id, "action": action, "consentState": self.consent.value, "occurredAt": self._now(), "release": self.release, "buildNumber": self.build_number, "endedReason": ended_reason})

    def _send(self, kind: str, payload: dict[str, Any]) -> None:
        if self.consent == GoodbaseConsent.DENIED:
            return
        event = {"kind": kind, "payload": payload}
        try:
            self._upload(event)
        except Exception:
            with self._lock:
                events = []
                if self.spool.exists():
                    events = [json.loads(line) for line in self.spool.read_text(encoding="utf-8").splitlines() if line.strip()]
                self._replace((events + [event])[-100:])

    def _upload(self, event: dict[str, Any]) -> None:
        path = {"crash": "/api/goodbase/v1/product/telemetry/crashes", "session": "/api/goodbase/v1/product/telemetry/sessions", "trace": "/api/goodbase/v1/product/telemetry/traces"}[event["kind"]]
        self.client.request(path, "POST", event["payload"], retries=0)

    def _replace(self, events: list[dict[str, Any]]) -> None:
        self.spool.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.spool.with_suffix(".tmp")
        temporary.write_text("".join(json.dumps(event, separators=(",", ":")) + "\n" for event in events), encoding="utf-8")
        os.replace(temporary, self.spool)

    def _exception_hook(self, error_type: type[BaseException], error: BaseException, tb: Any) -> None:
        error.__traceback__ = tb
        self.capture_exception(error, fatal=True)
        self._previous_hook(error_type, error, tb)

    def _thread_exception_hook(self, args: Any) -> None:
        self.capture_exception(args.exc_value, fatal=True, exception_type="ThreadException")
        self._previous_thread_hook(args)

    @staticmethod
    def _now() -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
