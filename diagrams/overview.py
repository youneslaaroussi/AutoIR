#!/usr/bin/env python3

"""
Generate the major system overview diagram for AutoIR using Graphviz.

Outputs: diagrams/out/overview.svg
"""

from pathlib import Path
from graphviz import Digraph


def ensure_out_dir() -> Path:
    out_dir = Path(__file__).parent / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def generate(path: Path) -> Path:
    dot = Digraph("autoir_overview", filename=str(path / "overview"), format="svg")
    dot.attr(rankdir="LR", fontsize="10", fontname="Inter,Helvetica,Arial,sans-serif")

    # Clusters
    with dot.subgraph(name="cluster_aws") as aws:
        aws.attr(label="AWS", color="#FF9900", style="rounded")
        aws.node("cw", "CloudWatch Logs", shape="component")
        aws.node("sagemaker", "SageMaker\n(Serverless Embeddings)", shape="box")
        aws.node("ecs", "ECS Fargate\n(AutoIR Daemon)", shape="box")
        aws.node("cf", "CloudFormation", shape="folder")
        aws.node("ecr", "ECR", shape="cylinder")
        aws.node("iam", "IAM", shape="tab")

    with dot.subgraph(name="cluster_autoir") as autoir:
        autoir.attr(label="AutoIR", color="#00B3E6", style="rounded")
        autoir.node("cli", "CLI / TUI\n(Combined Dashboard + Search)", shape="box")
        autoir.node("daemon", "Daemon\n(ingest, analyze, alert)", shape="box")
        autoir.node("llmclient", "LLM Client\n(Kimi K2 / OpenAI)", shape="box")

    with dot.subgraph(name="cluster_data") as data:
        data.attr(label="Data", color="#33AA55", style="rounded")
        data.node("tidb", "TiDB\nVECTOR(384) log store\n+ incidents", shape="cylinder")

    with dot.subgraph(name="cluster_alerts") as alerts:
        alerts.attr(label="Alerts", color="#DD4477", style="rounded")
        alerts.node("slack", "Slack Webhook", shape="box")
        alerts.node("sns", "Amazon SNS", shape="box")

    with dot.subgraph(name="cluster_llm") as llm:
        llm.attr(label="LLM Providers", color="#6666FF", style="rounded")
        llm.node("kimi", "Kimi K2\n(EC2 endpoint)", shape="box")
        llm.node("openai", "OpenAI", shape="box")

    # Flows
    dot.edge("cw", "daemon", label="tail /aws/...", color="#555555")
    dot.edge("daemon", "sagemaker", label="embed text", color="#555555")
    dot.edge("sagemaker", "daemon", label="vector(384)")
    dot.edge("daemon", "tidb", label="INSERT logs + embeddings")
    dot.edge("cli", "tidb", label="search/query")
    dot.edge("cli", "ecs", label="deploy/manage", style="dashed")
    dot.edge("cf", "ecs", label="stack", style="dashed")
    dot.edge("ecr", "ecs", label="image", style="dashed")
    dot.edge("iam", "ecs", style="dashed")
    dot.edge("daemon", "llmclient", label="incident analysis")
    dot.edge("llmclient", "kimi", style="dashed")
    dot.edge("llmclient", "openai", style="dashed")
    dot.edge("daemon", "slack", label="alerts")
    dot.edge("daemon", "sns", label="alerts")
    dot.edge("cw", "cli", label="dashboard", style="dotted")

    return Path(dot.render(cleanup=True))


if __name__ == "__main__":
    out = ensure_out_dir()
    out_file = generate(out)
    print(f"Wrote {out_file}")

