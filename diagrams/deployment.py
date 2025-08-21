#!/usr/bin/env python3

"""
Generate a deployment diagram focusing on ECS Fargate stack (CFN, ECR, IAM).

Outputs: diagrams/out/deployment.svg
"""

from pathlib import Path
from graphviz import Digraph


def ensure_out_dir() -> Path:
    out_dir = Path(__file__).parent / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def generate(path: Path) -> Path:
    dot = Digraph("autoir_deployment", filename=str(path / "deployment"), format="svg")
    dot.attr(rankdir="TB")

    with dot.subgraph(name="cluster_cfn") as cfn:
        cfn.attr(label="CloudFormation Stack: AutoIR-Fargate", style="rounded")
        cfn.node("ecs", "ECS Service: autoir", shape="box")
        cfn.node("task", "Task Definition", shape="box")
        cfn.node("logs", "CloudWatch Logs: /autoir/daemon", shape="component")
        cfn.node("role", "IAM Roles (task/execution)", shape="tab")

    dot.node("ecr", "ECR: autoir:latest", shape="cylinder")
    dot.node("sg", "VPC + Subnets + SG", shape="box")

    dot.edge("ecr", "task", label="Image")
    dot.edge("task", "ecs", label="Run")
    dot.edge("role", "task")
    dot.edge("ecs", "logs", label="awslogs")
    dot.edge("sg", "ecs")

    return Path(dot.render(cleanup=True))


if __name__ == "__main__":
    out = ensure_out_dir()
    out_file = generate(out)
    print(f"Wrote {out_file}")

