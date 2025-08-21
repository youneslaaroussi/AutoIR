#!/usr/bin/env python3

"""
Generate an LLM flow diagram (alerts loop, tool usage, providers).

Outputs: diagrams/out/llm_flow.svg
"""

from pathlib import Path
from graphviz import Digraph


def ensure_out_dir() -> Path:
    out_dir = Path(__file__).parent / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def generate(path: Path) -> Path:
    dot = Digraph("autoir_llm_flow", filename=str(path / "llm_flow"), format="svg")
    dot.attr(rankdir="LR")

    dot.node("events", "Recent Events\n(TiDB)", shape="cylinder")
    dot.node("heur", "Heuristics\n(error/timeouts/...)", shape="box")
    dot.node("prompt", "Prompt Builder\n(system + context)", shape="box")
    dot.node("llm", "LLM Client\n(Kimi K2 / OpenAI)", shape="box")
    dot.node("incidents", "Incidents JSON\n(title, severity, confidence, dedupe_key)", shape="box")
    dot.node("store", "Incident Store\n(TiDB)", shape="cylinder")
    dot.node("notify", "Notify\n(Slack/SNS)", shape="box")

    dot.edge("events", "heur")
    dot.edge("heur", "prompt")
    dot.edge("prompt", "llm")
    dot.edge("llm", "incidents")
    dot.edge("incidents", "store")
    dot.edge("incidents", "notify")

    return Path(dot.render(cleanup=True))


if __name__ == "__main__":
    out = ensure_out_dir()
    out_file = generate(out)
    print(f"Wrote {out_file}")

