"""Behavioral checks against real temporary git-bug repositories."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CLI = Path(__file__).with_name("planner.py")


class PlannerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.repo = self.root/"repo"
        self.repo.mkdir()
        self.run_git("init", "-q")
        self.run_git("config", "user.name", "fixture")
        self.run_git("config", "user.email", "fixture@example.invalid")
        self.run_git("bug", "user", "new", "-n", "fixture", "-e", "fixture@example.invalid", "--non-interactive")
        self.repos = self.root/"repos"
        self.repos.write_text(str(self.repo)+"\n")
        self.base = [sys.executable, str(CLI), "--repos-file", str(self.repos), "--state-dir", str(self.root/"state")]

    def tearDown(self):
        self.tmp.cleanup()

    def run_git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True, text=True).stdout

    def call(self, *args, actor="glm", ok=True):
        p = subprocess.run(self.base+["--actor", actor, *args], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0 if ok else 1, p.stdout+p.stderr)
        return json.loads(p.stdout if ok else p.stderr)

    def card(self, title="fixture task"):
        return self.call("add", "repo", "--title", title, "--plan", "verify the result")["ref"]

    def test_workflow_survives_new_process_and_separates_completion_from_closure(self):
        ref = self.card()
        self.call("start", ref, "--plan", "one bounded task")
        self.call("note", ref, "intent: write marker")
        self.call("note", ref, "result: marker exists; next: verify")
        self.call("block", ref, "quota; wait for operator")
        resumed = self.call("resume")["cards"][0]
        self.assertEqual(resumed["state"], "blocked")
        self.assertIn("marker exists", resumed["notes"][-2]["text"])
        self.call("start", ref, "--plan", "verify marker")
        self.call("done", ref, "--evidence", "marker inspected; focused checks pass")
        self.assertEqual(self.call("show", ref)["column"], "done")
        raw = json.loads(self.run_git("bug", "bug", "show", ref.split(":")[1], "-f", "json"))
        self.assertEqual(raw["status"], "open")
        self.assertEqual(self.call("resume")["cards"], [])

    def test_two_claimants_have_exactly_one_winner(self):
        ref = self.card()
        workers = [subprocess.Popen(self.base+["--actor", actor, "start", ref, "--plan", "claim"],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                   for actor in ("worker-a", "worker-b")]
        results = [p.communicate() for p in workers]
        self.assertEqual(sorted(p.returncode for p in workers), [0, 1], results)
        self.assertIn("already owned", "".join(err for _, err in results))

    def test_serial_work_and_explicit_release(self):
        first, second = self.card("first"), self.card("second")
        self.call("start", first, "--plan", "first")
        self.assertIn("active work", self.call("start", second, "--plan", "second", ok=False)["error"])
        self.call("release", first, "handoff: remaining check")
        self.call("start", second, "--plan", "second")
        self.assertEqual(self.call("show", first)["column"], "todo")

    def test_sync_repairs_labels_without_duplicate_comment(self):
        ref = self.card()
        self.call("start", ref, "--plan", "claim")
        before = self.call("show", ref)
        self.run_git("bug", "bug", "label", "rm", ref.split(":")[1], "status:doing")
        self.call("sync", ref)
        after = self.call("show", ref)
        self.assertEqual(after["column"], "doing")
        self.assertEqual(before["recent"], after["recent"])

    def test_completion_requires_nonempty_evidence_and_current_actor(self):
        ref = self.card()
        self.call("start", ref, "--plan", "claim")
        self.call("done", ref, "--evidence", " ", ok=False)
        self.call("done", ref, "--evidence", "claimed result", actor="other", ok=False)
        self.assertEqual(self.call("show", ref)["column"], "doing")

    def test_board_is_bounded_and_closed_work_cannot_restart(self):
        ref = self.card()
        self.card("another")
        board = self.call("board", "--limit", "1")
        self.assertEqual(len(board["cards"]), 1)
        self.assertEqual(board["more"], 1)
        self.run_git("bug", "bug", "status", "close", ref.split(":")[1])
        self.assertIn("closed issue", self.call("start", ref, "--plan", "revive", ok=False)["error"])

    def test_unlabelled_bug_and_empty_store_are_supported(self):
        self.assertEqual(self.call("board")["cards"], [])
        ref = self.card()
        for label in ("status:todo", "kind:task", "priority:p2"):
            self.run_git("bug", "bug", "label", "rm", ref.split(":")[1], label)
        self.assertEqual(self.call("board")["cards"][0]["column"], "todo")
        self.call("start", ref, "--plan", "labelled on claim")


if __name__ == "__main__":
    unittest.main()
