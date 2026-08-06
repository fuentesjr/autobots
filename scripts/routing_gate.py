#!/usr/bin/env python3
"""Static role-routing gate for agent frontmatter example deletion.

skill-tester materializes only skill packages, not .claude/agents or
.grok/agents, so role selection cannot be gated there. This script presents
the agent roster (name + description, optionally with <example> blocks
stripped) and asks a model to pick one role name or "none".

Usage:
  routing_gate.py --agents-dir DIR --scenarios YAML --provider claude|grok \
                  [--strip-examples] [--n N] [--out PATH]
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

def parse_frontmatter(text: str) -> dict[str, str]:
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        raise ValueError("missing frontmatter")
    block = m.group(1)
    # Minimal YAML-ish parse for name + description folded block
    name_m = re.search(r"^name:\s*(\S+)\s*$", block, re.M)
    if not name_m:
        raise ValueError("missing name")
    desc_m = re.search(r"^description:\s*>-\n((?:  .*\n)+)", block, re.M)
    if not desc_m:
        # try plain description
        desc_m = re.search(r"^description:\s*(.+)$", block, re.M)
        if not desc_m:
            raise ValueError("missing description")
        desc = desc_m.group(1).strip()
    else:
        lines = [ln[2:] if ln.startswith("  ") else ln for ln in desc_m.group(1).splitlines()]
        desc = "\n".join(lines).strip()
    return {"name": name_m.group(1), "description": desc}


def strip_examples(desc: str) -> str:
    return re.sub(r"\n?\s*<example>.*?</example>", "", desc, flags=re.S).strip()


def load_agents(agents_dir: Path, strip: bool) -> list[dict[str, str]]:
    agents = []
    for path in sorted(agents_dir.glob("*.md")):
        meta = parse_frontmatter(path.read_text())
        if strip:
            meta["description"] = strip_examples(meta["description"])
        agents.append(meta)
    return agents


def load_scenarios(path: Path) -> dict:
    text = path.read_text()
    if path.suffix == ".json":
        return json.loads(text)
    # Prefer JSON (no PyYAML dependency). YAML files are frozen mirrors only.
    raise SystemExit(f"use routing-scenarios.json (got {path})")


def build_prompt(agents: list[dict[str, str]], user_prompt: str, valid_names: list[str]) -> str:
    roster_lines = []
    for a in agents:
        roster_lines.append(f"### {a['name']}\n{a['description']}\n")
    roster = "\n".join(roster_lines)
    names = ", ".join(valid_names + ["none"])
    return f"""You are a dispatcher. Given the agent roster below, pick exactly one agent
to handle the user request, or "none" if the request says to handle locally /
escape hatches / no subagents.

Reply with ONLY the agent name (or none). No punctuation, no explanation.
Valid answers: {names}

## Roster

{roster}

## User request

{user_prompt}
"""


def run_claude(prompt: str, model: str) -> str:
    cmd = [
        "claude",
        "--safe-mode",
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "-p",
        "--model",
        model,
        prompt,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return f"ERROR:{r.returncode}:{r.stderr[:200]}"
    return r.stdout.strip()


def run_grok(prompt: str, model: str) -> str:
    # Headless single-turn: -p/--single prints response and exits.
    cmd = [
        "grok",
        "-p",
        prompt,
        "-m",
        model,
        "--tools",
        "",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return f"ERROR:{r.returncode}:{(r.stderr or r.stdout)[:200]}"
    return r.stdout.strip()


def normalize_answer(raw: str, valid: set[str]) -> str:
    line = raw.strip().splitlines()[0] if raw.strip() else ""
    # strip quotes/backticks
    line = line.strip("`'\" .")
    lower = line.lower()
    if lower in valid:
        return lower
    # find any valid name mentioned
    for name in sorted(valid, key=len, reverse=True):
        if name in lower:
            return name
    return f"INVALID:{line[:80]}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agents-dir", type=Path, required=True)
    ap.add_argument("--scenarios", type=Path, required=True)
    ap.add_argument("--provider", choices=["claude", "grok"], required=True)
    ap.add_argument("--strip-examples", action="store_true")
    ap.add_argument("--n", type=int, default=None)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--model", default=None)
    args = ap.parse_args()

    scenarios = load_scenarios(args.scenarios)
    n = args.n or int(scenarios.get("n_trials", 1))
    model = args.model or scenarios.get("model") or ("sonnet" if args.provider == "claude" else "grok-4.5")
    agents = load_agents(args.agents_dir, strip=args.strip_examples)
    valid = {a["name"] for a in agents} | {"none"}

    results = {
        "provider": args.provider,
        "model": model,
        "strip_examples": args.strip_examples,
        "n": n,
        "cases": [],
        "pass_rate": 0.0,
        "n_pass": 0,
        "n_total": 0,
    }

    for case in scenarios["cases"]:
        case_pass = 0
        trials = []
        for i in range(n):
            prompt = build_prompt(agents, case["prompt"].strip(), sorted(valid - {"none"}) + (["none"]))
            if args.provider == "claude":
                raw = run_claude(prompt, model)
            else:
                raw = run_grok(prompt, model)
            ans = normalize_answer(raw, valid)
            ok = ans == case["expected"]
            if ok:
                case_pass += 1
            trials.append({"trial": i + 1, "raw": raw[:200], "answer": ans, "ok": ok})
            time.sleep(0.3)
        results["cases"].append(
            {
                "id": case["id"],
                "expected": case["expected"],
                "pass": case_pass,
                "n": n,
                "rate": case_pass / n,
                "trials": trials,
            }
        )
        results["n_pass"] += case_pass
        results["n_total"] += n
        print(f"{case['id']}: {case_pass}/{n} expected={case['expected']}", flush=True)

    results["pass_rate"] = results["n_pass"] / results["n_total"] if results["n_total"] else 0.0
    print(f"OVERALL: {results['n_pass']}/{results['n_total']} ({results['pass_rate']:.1%})", flush=True)

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(results, indent=2))
        print(f"wrote {args.out}", flush=True)
    return 0 if results["pass_rate"] >= 0.8 else 1


if __name__ == "__main__":
    sys.exit(main())
