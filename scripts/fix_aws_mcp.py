"""
Required fix from the AWS Agent Toolkit setup guide (Step 5):
the generated "aws-mcp" MCP server uses the "default" AWS profile, which fails for a named profile.
This adds  "env": {"AWS_MCP_PROXY_PROFILES": "<profile>"}  to every "aws-mcp" entry under "mcpServers"
in Claude Code's config files. Nothing else is changed. A backup is written next to each file first.

Run from E:\\Nordwind:   uv run --no-project python scripts\\fix_aws_mcp.py
"""
import json
import shutil
import sys
from pathlib import Path

PROFILE = sys.argv[1] if len(sys.argv) > 1 else "nordwind"

candidates = [
    Path.home() / ".claude.json",  # Claude Code user + per-project settings
    Path.cwd() / ".mcp.json",  # project-scoped MCP servers
]


def fix(node, where, found):
    """Walks the JSON; fixes every mcpServers["aws-mcp"] entry it finds."""
    if isinstance(node, dict):
        servers = node.get("mcpServers")
        if isinstance(servers, dict) and isinstance(servers.get("aws-mcp"), dict):
            entry = servers["aws-mcp"]
            env = entry.setdefault("env", {})
            before = env.get("AWS_MCP_PROXY_PROFILES")
            env["AWS_MCP_PROXY_PROFILES"] = PROFILE
            found.append((where or "(top level)", before))
        for key, value in node.items():
            if key != "mcpServers":
                fix(value, f"{where}/{key}" if where else key, found)
    elif isinstance(node, list):
        for i, value in enumerate(node):
            fix(value, f"{where}[{i}]", found)


total = 0
for path in candidates:
    if not path.exists():
        print(f"- {path}: not present")
        continue
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    found = []
    fix(data, "", found)
    if not found:
        print(f"- {path}: no aws-mcp entry")
        continue
    backup = path.with_name(path.name + ".bak-aws-toolkit")
    shutil.copy2(path, backup)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for where, before in found:
        note = "" if before in (None, PROFILE) else f" (was: {before})"
        print(f"+ {path} -> {where}: AWS_MCP_PROXY_PROFILES={PROFILE}{note}")
    print(f"  backup: {backup}")
    total += len(found)

if total == 0:
    print("\nNo aws-mcp entry found. Run `claude mcp list` to see where it is, and tell Claude.")
    sys.exit(1)
print(f"\nDone: {total} aws-mcp entr{'y' if total == 1 else 'ies'} fixed. Restart Claude Code.")
