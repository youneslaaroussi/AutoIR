# AutoIR Diagrams

Python scripts using Graphviz to generate diagrams used in the main README.

## Scripts
- `overview.py`: Major system overview
- `pipeline.py`: Ingestion → embeddings → storage → analysis → alerts
- `deployment.py`: ECS Fargate deployment via CloudFormation
- `search_ui.py`: Combined Dashboard + Search TUI layout
- `llm_flow.py`: LLM analysis loop and notifications

## Usage
1) Install dependencies:
```bash
python3 -m venv .venv && . .venv/bin/activate
pip install graphviz
```

2) Ensure Graphviz binaries are installed (dot):
```bash
# macOS (brew)
brew install graphviz
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y graphviz
```

3) Generate:
```bash
python diagrams/overview.py
python diagrams/pipeline.py
python diagrams/deployment.py
python diagrams/search_ui.py
python diagrams/llm_flow.py
```

SVGs are written to `diagrams/out/*.svg`.

