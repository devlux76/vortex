#!/usr/bin/env python3
"""Small local kanban interface to git-bug. No model or network dependency."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys


def git(repo, *args):
    p = subprocess.run(["git", "-C", str(repo), "bug", *args], capture_output=True, text=True)
    if p.returncode:
        raise ValueError(p.stderr.strip() or p.stdout.strip() or "git-bug failed")
    return p.stdout.strip()


def repositories(file):
    result = {}
    for line in file.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        path = Path(line.strip()).expanduser().resolve()
        name = "shared" if path.name == ".bugs" else path.name
        if name in result:
            raise ValueError(f"duplicate repository name: {name}")
        result[name] = path
    return result


def column(bug):
    labels = bug["labels"] or []
    if bug["status"] == "closed" or "status:done" in labels:
        return "done"
    if "board:blocked" in labels:
        return "blocked"
    return "doing" if "status:doing" in labels else "todo"


def show(repo, bug):
    return json.loads(git(repo, "bug", "show", bug, "-f", "json"))


def labels(repo, bug, old, state, blocked=False):
    desired = {f"status:{state}"}
    if blocked:
        desired.add("board:blocked")
    present = {x for x in (old or []) if x.startswith("status:") or x == "board:blocked"}
    for label in sorted(present - desired):
        git(repo, "bug", "label", "rm", bug, label)
    for label in sorted(desired - present):
        git(repo, "bug", "label", "new", bug, label)


def mirror(repo, bug, card, claim):
    note = json.loads(claim["notes"])[-1]
    text = f'planner {note["action"]} ({claim["actor"]}) #{note["n"]}: {note["text"]}'
    if not any(c["message"] == text for c in card["comments"]):
        git(repo, "bug", "comment", "new", bug, "-m", text, "--non-interactive")
    state = claim["state"]
    labels(repo, bug, card["labels"], "doing" if state == "blocked" else state, state == "blocked")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--actor", default=os.environ.get("PLANNER_ACTOR", "glm"))
    p.add_argument("--repos-file", type=Path, default=Path.home()/".config/bug-watch/repos")
    p.add_argument("--state-dir", type=Path, default=Path.home()/".local/state/planner")
    sub = p.add_subparsers(dest="command", required=True)
    board = sub.add_parser("board")
    board.add_argument("--repo")
    board.add_argument("--column", choices=["todo", "doing", "blocked", "done"])
    board.add_argument("--limit", type=int, default=12)
    sub.add_parser("resume")
    add = sub.add_parser("add")
    add.add_argument("repo")
    add.add_argument("--title", required=True)
    add.add_argument("--plan", required=True)
    add.add_argument("--priority", choices=["p0", "p1", "p2", "p3"], default="p2")
    for command in ["show", "start", "note", "block", "release", "done", "sync"]:
        action = sub.add_parser(command)
        action.add_argument("ref", help="repository:bug-id (shared for the cross-repo tracker)")
        if command == "start":
            action.add_argument("--plan", required=True)
        elif command == "done":
            action.add_argument("--evidence", required=True)
        elif command not in ("show", "sync"):
            action.add_argument("text", help="checkpoint, blocker or release reason")
    a = p.parse_args()
    if not 1 <= len(a.actor) <= 32 or not all(c.isalnum() or c in "_-" for c in a.actor):
        raise ValueError("actor must be a short name, not a session id")
    repos = repositories(a.repos_file)
    a.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (a.state_dir/"lock").open("a") as lock, contextlib.closing(sqlite3.connect(a.state_dir/"board.sqlite3")) as db:
        fcntl.flock(lock, fcntl.LOCK_EX)
        db.row_factory = sqlite3.Row
        db.execute("CREATE TABLE IF NOT EXISTS claims (ref TEXT PRIMARY KEY, actor TEXT, state TEXT, plan TEXT, notes TEXT)")
        claims = {r["ref"]: dict(r) for r in db.execute("SELECT * FROM claims")}
        if a.command == "resume":
            return {"actor": a.actor, "cards": [{"ref": r["ref"], "state": r["state"], "plan": r["plan"],
                    "notes": [n for n in json.loads(r["notes"]) if n["action"] != "start"][-3:]} for r in claims.values()
                    if r["actor"] == a.actor and r["state"] in ("doing", "blocked")]}
        if a.command == "board":
            if a.repo and a.repo not in repos:
                raise ValueError("unknown repository; use a name from the watched repositories")
            cards = []
            counts = {c: 0 for c in ("todo", "doing", "blocked", "done")}
            for name, repo in repos.items():
                if a.repo and name != a.repo:
                    continue
                for b in (json.loads(git(repo, "bug", "-f", "json")) or []):
                    col = column(b)
                    counts[col] += 1
                    if (a.column and col != a.column) or (not a.column and col == "done"):
                        continue
                    ref = f'{name}:{b["human_id"]}'
                    cards.append({"ref": ref, "column": col, "actor": claims.get(ref, {}).get("actor"),
                                  "priority": next((x[9:] for x in sorted(b["labels"] or []) if x.startswith("priority:")), "p2"),
                                  "title": b["title"][:140]})
            cards.sort(key=lambda c: ({"doing": 0, "blocked": 1, "todo": 2, "done": 3}[c["column"]], c["priority"], c["ref"]))
            limit = max(1, min(a.limit, 100))
            return {"counts": counts, "cards": cards[:limit], "more": max(0, len(cards)-limit)}
        if a.command == "add":
            if a.repo not in repos:
                raise ValueError("unknown repository")
            if not a.title.strip() or not a.plan.strip():
                raise ValueError("title and plan must not be empty")
            repo = repos[a.repo]
            result = git(repo, "bug", "new", "-t", a.title, "-m", a.plan, "--non-interactive")
            ref = result.split()[0]
            git(repo, "bug", "label", "new", ref, "status:todo", "kind:task", "priority:"+a.priority)
            return {"ref": a.repo+":"+ref, "column": "todo"}
        name, sep, bug = a.ref.partition(":")
        if not sep or name not in repos or not bug:
            raise ValueError("expected known-repository:bug-id")
        repo = repos[name]
        b = show(repo, bug)
        ref = name+":"+b["human_id"]
        claim = claims.get(ref)
        if a.command == "show":
            comments = b["comments"]
            return {"ref": ref, "column": column(b), "title": b["title"], "labels": b["labels"],
                    "body": comments[0]["message"][:1800] if comments else "",
                    "recent": [c["message"][:900] for c in comments[1:][-3:]],
                    "claim": {**claim, "notes": json.loads(claim["notes"])[-3:]} if claim else None}
        if b["status"] == "closed":
            raise ValueError("closed issue; do not revive old work")
        if a.command == "sync":
            if not claim or claim["actor"] != a.actor:
                raise ValueError("only the recorded actor can repair its issue mirror")
            mirror(repo, bug, b, claim)
            return {"ref": ref, "column": claim["state"], "recorded": "sync"}
        if a.command == "start":
            if not a.plan.strip():
                raise ValueError("plan must not be empty")
            if claim and claim["state"] in ("doing", "blocked") and claim["actor"] != a.actor:
                raise ValueError(f'already owned by {claim["actor"]}; reconcile with that owner')
            if not claim and column(b) == "doing":
                raise ValueError("already doing outside planner; reconcile the existing assignment first")
            if column(b) == "done":
                raise ValueError("verified task; do not restart")
            if any(r["actor"] == a.actor and r["state"] == "doing" and r["ref"] != ref for r in claims.values()):
                raise ValueError("actor already has active work; finish, block or release it first")
            state, plan, text = "doing", a.plan, "plan: "+a.plan
        else:
            if not claim or claim["actor"] != a.actor or claim["state"] not in ("doing", "blocked"):
                raise ValueError("start this card first; only its current actor may update it")
            plan = claim["plan"]
            text = a.evidence if a.command == "done" else a.text
            if not text.strip():
                raise ValueError("checkpoint, reason or evidence must not be empty")
            state = {"note": claim["state"], "block": "blocked", "release": "todo", "done": "done"}[a.command]
        notes = json.loads(claim["notes"]) if claim else []
        notes.append({"n": len(notes)+1, "action": a.command, "text": text})
        # Claim is durable before touching the issue. A failed mirror is visible
        # on resume and is repaired by repeating the command; never auto-take over.
        with db:
            db.execute("INSERT OR REPLACE INTO claims VALUES (?,?,?,?,?)", (ref, a.actor, state, plan, json.dumps(notes)))
        mirror(repo, bug, b, {"state": state, "actor": a.actor, "notes": json.dumps(notes)})
        return {"ref": ref, "column": state, "actor": a.actor, "recorded": a.command}


if __name__ == "__main__":
    try:
        print(json.dumps(main(), separators=(",", ":")))
    except (ValueError, OSError, sqlite3.Error) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
