#!/usr/bin/env python3
"""The Cloud half of the comparison: a ClickHouse Cloud service, created and run with clickhousectl.

    python3 cloud/service.py up [name]        create the service (or reuse it), load cloud/site.sql, embed the site
    python3 cloud/service.py search "words"   run site.search on it, with the time it took and the model calls it made
    python3 cloud/service.py down             delete the service (asks first; deleting is immediate and final)

The local half is cloud/test.sh: the same site.sql on clickhouse local. Both print how long the embedding took.

Needs clickhousectl logged in with an API key (OAuth is read-only):
    clickhousectl cloud auth login --api-key … --api-secret …
and an org with the AI functions private preview turned on. The service's id, host and default password are kept
in internal/cloud-service.json (gitignored, readable only by you); the password is shown once at creation, and
cloud/refresh.sh needs it as a build secret. Stdlib only.
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "internal" / "cloud-service.json"
SQL = ROOT / "cloud" / "site.sql"
CTL = os.environ.get("CLICKHOUSECTL", "clickhousectl")


def ctl(*args, check=True):
    r = subprocess.run([CTL, "cloud", *args], capture_output=True, text=True)
    if check and r.returncode:
        sys.exit(f"clickhousectl cloud {' '.join(args[:3])}… failed:\n{r.stderr.strip() or r.stdout.strip()}")
    return r


def ctl_json(*args):
    out = ctl(*args, "--json").stdout
    return json.loads(out[out.index("{"):] if "{" in out else out)


def find(obj, test):
    """The first value anywhere in a JSON document for which test(value) holds (the output's exact shape may vary)."""
    if test(obj):
        return obj
    for v in (obj.values() if isinstance(obj, dict) else obj if isinstance(obj, list) else ()):
        hit = find(v, test)
        if hit is not None:
            return hit
    return None


def key(obj, name):
    d = find(obj, lambda v: isinstance(v, dict) and name in v)
    return d[name] if d else None


def sq(s):
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def query(sid, sql, fmt="TabSeparated"):
    r = ctl("service", "query", sid, "--query", sql, "--format", fmt, check=False)
    if r.returncode:
        sys.exit(f"Query failed:\n{sql[:300]}\n\n{r.stderr.strip() or r.stdout.strip()}")
    return r.stdout.strip()


def statements(sql):
    """site.sql as single statements (the Query API takes one at a time). No statement has a ';' at a line end inside it."""
    for chunk in re.split(r";[ \t]*$", sql, flags=re.M):
        if any(line.strip() and not line.strip().startswith("--") for line in chunk.splitlines()):
            yield chunk.strip()


def load():
    if not STATE.exists():
        sys.exit("No service yet: python3 cloud/service.py up")
    return json.loads(STATE.read_text())


def save(state):
    STATE.parent.mkdir(exist_ok=True)
    STATE.write_text(json.dumps(state, indent=2) + "\n")
    STATE.chmod(0o600)


def wait_running(sid):
    t0 = time.time()
    while True:
        state = str(key(ctl_json("service", "get", sid), "state") or "").lower()
        if state == "running":
            return time.time() - t0
        if state in ("stopped", "idle"):
            ctl("service", "start", sid, check=False)
        if time.time() - t0 > 1200:
            sys.exit(f"Service still '{state}' after 20 minutes")
        print(f"  {state or '?'}… ({time.time() - t0:.0f}s)", flush=True)
        time.sleep(15)


def refresh(sid, view, since=None):
    """Waits for a refresh of the view that started after `since` (server time), starting one if `since` is None;
    returns (ms the refresh took, rows written)."""
    t0 = since or query(sid, "SELECT now()")
    if since is None:
        query(sid, f"SYSTEM REFRESH VIEW site.{view}")
    where = f"database = 'site' AND view = '{view}'"
    while True:
        time.sleep(5)
        row = query(sid, f"SELECT max(last_success_time) >= {sq(t0)}, max(last_success_duration_ms), max(written_rows), "
                         f"anyIf(exception, exception != '' AND last_refresh_time >= {sq(t0)}) "
                         f"FROM clusterAllReplicas(default, system.view_refreshes) WHERE {where}").split("\t")
        if row[3]:
            sys.exit(f"site.{view} refresh failed: {row[3]}")
        if row[0] == "1":
            return int(row[1] or 0), int(row[2] or 0)


def up(name):
    state = json.loads(STATE.read_text()) if STATE.exists() else None
    if state:
        print(f"Reusing {state['name']} ({state['id']})")
    else:
        print(f"Creating service {name}…", flush=True)
        t0 = time.time()
        made = ctl_json("service", "create", "--name", name, "--private-preview-terms-checked")
        https = find(made, lambda v: isinstance(v, dict) and str(v.get("protocol", "")).lower() == "https")
        state = {"name": name, "id": key(made, "id"), "host": https and https.get("host"),
                 "password": key(made, "password"), "created": time.strftime("%Y-%m-%d %H:%M")}
        if not state["id"]:
            sys.exit("Couldn't find the service id in clickhousectl's output:\n" + json.dumps(made, indent=2)[:2000])
        save(state)  # before anything else can fail: the password is only shown now
        print(f"  created in {time.time() - t0:.0f}s; id, host and password saved to {STATE.relative_to(ROOT)}")
    sid = state["id"]
    print(f"Running after {wait_running(sid):.0f}s more")
    if not state.get("host"):
        https = find(ctl_json("service", "get", sid), lambda v: isinstance(v, dict) and str(v.get("protocol", "")).lower() == "https")
        state["host"] = https and https.get("host")
        save(state)

    print(query(sid, "SELECT 'ClickHouse ' || version() || ', aiEmbed: ' || if(count() > 0, 'yes', 'NO') "
                     "FROM system.functions WHERE name = 'aiEmbed'"))
    # creating the views runs their first refresh by itself; on a service that already has them, start one
    fresh = query(sid, "EXISTS TABLE site.embed") != "1"
    since = query(sid, "SELECT now()") if fresh else None
    t0 = time.time()
    for s in statements(SQL.read_text(encoding="utf-8")):
        query(sid, s)
    print(f"Loaded cloud/site.sql in {time.time() - t0:.1f}s")
    ms, rows = refresh(sid, "pages", since)
    print(f"Read the site: {rows} rows in {ms / 1000:.1f}s")
    ms, rows = refresh(sid, "embed", since)
    print(f"Embedded {rows} rows in {ms / 1000:.1f}s (rows already embedded are skipped)")
    print(query(sid, "SELECT 'Vectors: ' || toString(count()) || ' × ' || toString(any(length(v))) || ' dims' FROM site.vectors"))
    print(f"\nFor cloud/refresh.sh (Workers Build secrets): CLICKHOUSE_URL=https://{state['host']}:8443, "
          f"CLICKHOUSE_USER=default, CLICKHOUSE_PASSWORD from {STATE.relative_to(ROOT)} (better: a user with only "
          "GRANT SYSTEM VIEWS, SELECT ON site.*)")


def search(words):
    sid = load()["id"]
    t0 = time.time()
    print(query(sid, f"SELECT * FROM site.search(q = {sq(words)}) SETTINGS log_comment = 'site.search'", "PrettyCompactMonoBlock"))
    print(f"{time.time() - t0:.2f}s round trip, from here through the Query API")
    query(sid, "SYSTEM FLUSH LOGS")
    print(query(sid, "SELECT 'Last search: ' || toString(query_duration_ms) || ' ms on the server, '"
                     " || toString(ProfileEvents['AIAPICalls']) || ' model call(s)' "
                     "FROM clusterAllReplicas(default, system.query_log) "
                     "WHERE log_comment = 'site.search' AND type = 'QueryFinish' ORDER BY event_time_microseconds DESC LIMIT 1"))


def down():
    state = load()
    if input(f"Delete {state['name']} ({state['id']}) and everything in it? Type its name: ").strip() != state["name"]:
        sys.exit("Not deleted.")
    ctl("service", "delete", state["id"], "--force")
    STATE.unlink()
    print("Deleted.")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "up":
        up(sys.argv[2] if len(sys.argv) > 2 else "tylerhannan-search")
    elif cmd == "search" and len(sys.argv) > 2:
        search(" ".join(sys.argv[2:]))
    elif cmd == "down":
        down()
    else:
        sys.exit(__doc__)
