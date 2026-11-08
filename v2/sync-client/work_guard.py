"""Pause new work during an update; let existing, nested work finish first."""
import threading
import time
from contextlib import contextmanager
from functools import wraps


class ActivityGate:
    def __init__(self):
        self._condition = threading.Condition()
        self._local = threading.local()
        self._active = 0
        self._paused = False

    @contextmanager
    def activity(self):
        depth = getattr(self._local, "depth", 0)
        with self._condition:
            if not depth:
                while self._paused:
                    self._condition.wait()
                self._active += 1
            self._local.depth = depth + 1
        try:
            yield
        finally:
            with self._condition:
                self._local.depth -= 1
                if not self._local.depth:
                    self._active -= 1
                    self._condition.notify_all()

    def pause(self, timeout=600):
        deadline = time.monotonic() + timeout
        with self._condition:
            self._paused = True
            while self._active:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._paused = False
                    self._condition.notify_all()
                    return False
                self._condition.wait(remaining)
            return True

    def resume(self):
        with self._condition:
            self._paused = False
            self._condition.notify_all()

    def start_thread(self, target, args=(), daemon=True):
        # Reserve before acknowledging an HTTP request: an update must not discard an accepted task.
        with self._condition:
            while self._paused and not getattr(self._local, "depth", 0):
                self._condition.wait()
            self._active += 1

        def run():
            self._local.depth = getattr(self._local, "depth", 0) + 1
            try:
                target(*args)
            finally:
                with self._condition:
                    self._local.depth -= 1
                    self._active -= 1
                    self._condition.notify_all()
        thread = threading.Thread(target=run, daemon=daemon)
        try:
            thread.start()
        except Exception:
            with self._condition:
                self._active -= 1
                self._condition.notify_all()
            raise
        return thread

    @property
    def active(self):
        with self._condition:
            return self._active


ACTIVITY = ActivityGate()


def collection_activity(function):
    @wraps(function)
    def guarded(*args, **kwargs):
        with ACTIVITY.activity():
            return function(*args, **kwargs)
    return guarded
