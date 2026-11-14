"""Real file-lock lifecycle tests; no Harbor environment or provider is started."""
import asyncio
import fcntl
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from scripts.evals.harbor import biny_agent as adapter


class RuntimeCacheLockTests(unittest.IsolatedAsyncioTestCase):
    async def test_exception_and_cancellation_release_acquired_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.multiple(adapter, PACKAGE_CACHE=root,
                                RUNTIME_CACHE_FILE_LOCK=root / "lock",
                                RUNTIME_CACHE_LOCK=asyncio.Lock()):
                with self.assertRaisesRegex(RuntimeError, "fixture"):
                    async with adapter.runtime_cache_guard():
                        raise RuntimeError("fixture")
                entered = asyncio.Event()
                async def hold():
                    async with adapter.runtime_cache_guard():
                        entered.set()
                        await asyncio.Future()
                task = asyncio.create_task(hold())
                await asyncio.wait_for(entered.wait(), 2)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                # A separate file description proves the OS lock was released.
                with (root / "lock").open("a+") as probe:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.flock(probe, fcntl.LOCK_UN)
                async with adapter.runtime_cache_guard():
                    pass

    async def test_unexpected_lock_error_propagates_and_releases_local_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local = asyncio.Lock()
            with patch.multiple(adapter, PACKAGE_CACHE=root,
                                RUNTIME_CACHE_FILE_LOCK=root / "lock",
                                RUNTIME_CACHE_LOCK=local), patch.object(
                                    adapter.fcntl, "flock", side_effect=OSError("fixture failure")):
                with self.assertRaisesRegex(OSError, "fixture failure"):
                    async with adapter.runtime_cache_guard():
                        self.fail("unacquired lock must not enter")
                self.assertFalse(local.locked())


class RuntimeCacheLockProcessTests(unittest.TestCase):
    def test_cancelled_waiter_exits_while_peer_still_holds_lock(self):
        self.run_waiter(cancel=True)

    def test_waiter_enters_only_after_peer_releases_lock(self):
        self.run_waiter(cancel=False)

    def run_waiter(self, cancel):
        script = r'''
import asyncio, fcntl, pathlib, sys
from scripts.evals.harbor import biny_agent as adapter
root = pathlib.Path(sys.argv[1])
adapter.PACKAGE_CACHE = root
adapter.RUNTIME_CACHE_FILE_LOCK = root / "lock"
adapter.RUNTIME_CACHE_LOCK = asyncio.Lock()
real_flock = fcntl.flock
attempted = False
def observed(fd, flags):
    global attempted
    if flags & fcntl.LOCK_EX and not attempted:
        attempted = True
        (root / "attempted").write_text("waiting")
    return real_flock(fd, flags)
adapter.fcntl.flock = observed
async def enter():
    async with adapter.runtime_cache_guard():
        print("entered", flush=True)
async def main():
    task = asyncio.create_task(enter())
    while not attempted:
        await asyncio.sleep(.01)
    if sys.argv[2] == "cancel":
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            print("cancelled", flush=True)
    else:
        await task
asyncio.run(main())
print("exited", flush=True)
'''
        with tempfile.TemporaryDirectory() as directory:
            with (Path(directory) / "lock").open("a+") as owner:
                fcntl.flock(owner, fcntl.LOCK_EX)
                child = subprocess.Popen(
                    [sys.executable, "-c", script, directory, "cancel" if cancel else "wait"],
                    cwd=Path(__file__).resolve().parents[1],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    deadline = time.monotonic() + 10
                    while not (Path(directory) / "attempted").exists():
                        if child.poll() is not None or time.monotonic() >= deadline:
                            self.fail("waiter did not attempt the lock within 10 seconds")
                        time.sleep(.01)
                    if cancel:
                        # The owner remains locked through process exit. A blocked
                        # executor thread would keep asyncio.run alive here.
                        output, errors = child.communicate(timeout=3)
                        self.assertIn("cancelled", output)
                        self.assertNotIn("entered", output)
                    else:
                        with self.assertRaises(subprocess.TimeoutExpired):
                            child.wait(timeout=.2)
                        fcntl.flock(owner, fcntl.LOCK_UN)
                        output, errors = child.communicate(timeout=3)
                        self.assertIn("entered", output)
                    self.assertEqual(child.returncode, 0, errors)
                    self.assertIn("exited", output)
                finally:
                    fcntl.flock(owner, fcntl.LOCK_UN)
                    if child.poll() is None:
                        child.kill()
                    child.communicate(timeout=3)


if __name__ == "__main__":
    unittest.main()
