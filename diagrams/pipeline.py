#!/usr/bin/env python3

"""
Generate a pipeline diagram (ingestion -> embeddings -> storage -> analysis -> alerts).

Outputs: diagrams/out/pipeline.svg
"""

from pathlib import Path
from graphviz import Digraph


def ensure_out_dir() -> Path:
    out_dir = Path(__file__).parent / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def generate(path: Path) -> Path:
    dot = Digraph("autoir_pipeline", filename=str(path / "pipeline"), format="svg")
    dot.attr(rankdir="LR")

    dot.node("ingest", "Ingest\n(CloudWatch tail)", shape="box")
    dot.node("embed", "Embeddings\n(SageMaker)", shape="box")
    dot.node("store", "Store\nTiDB VECTOR(384)", shape="cylinder")
    dot.node("search", "Search\n(Log Search TUI)", shape="box")
    dot.node("analysis", "Analysis\n(LLM: Kimi K2/OpenAI)", shape="box")
    dot.node("alerts", "Alerts\n(Slack/SNS)", shape="box")

    dot.edge("ingest", "embed", label="messages")
    dot.edge("embed", "store", label="vector(384)")
    dot.edge("search", "store", label="query vectors", dir="both")
    dot.edge("analysis", "store", label="context", dir="both")
    dot.edge("analysis", "alerts", label="incidents")

    return Path(dot.render(cleanup=True))


if __name__ == "__main__":
    out = ensure_out_dir()
    out_file = generate(out)
    print(f"Wrote {out_file}")

