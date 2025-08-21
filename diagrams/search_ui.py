#!/usr/bin/env python3

"""
Generate a UI layout diagram for the combined Dashboard + Search TUI.

Outputs: diagrams/out/search_ui.svg
"""

from pathlib import Path
from graphviz import Digraph


def ensure_out_dir() -> Path:
    out_dir = Path(__file__).parent / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def generate(path: Path) -> Path:
    dot = Digraph("autoir_search_ui", filename=str(path / "search_ui"), format="svg")
    dot.attr(rankdir="LR")

    dot.node("title", "Title Bar", shape="box")
    dot.node("searchbox", "Search Box", shape="box")
    dot.node("results", "Results Table", shape="box")
    dot.node("status", "Service Status Cards", shape="box")
    dot.node("charts", "Charts (tasks/cpu/mem)", shape="box")
    dot.node("tasks", "Tasks Table", shape="box")
    dot.node("help", "Hotkeys: Enter/r/d/q", shape="box")

    # Layout connections (not functional, just illustrative)
    dot.edges([("title","searchbox"),("searchbox","results"),("title","status"),("status","charts"),("charts","tasks"),("results","help"),("tasks","help")])

    return Path(dot.render(cleanup=True))


if __name__ == "__main__":
    out = ensure_out_dir()
    out_file = generate(out)
    print(f"Wrote {out_file}")

