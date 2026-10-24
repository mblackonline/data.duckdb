# /// script
# requires-python = ">=3.13"
# dependencies = [
#     "duckdb>=1.5.6",
# ]
# ///
import csv
import hashlib
import os
from pathlib import Path
import re
import shutil
import tempfile

import duckdb


def read_datasets(csv_file):
    with Path(csv_file).open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source, strict=True)
        if reader.fieldnames != ["name", "url"]:
            raise ValueError("Dataset CSV must have exactly the columns name,url.")
        datasets = []
        names = set()
        for line, row in enumerate(reader, start=2):
            name = (row.get("name") or "").strip()
            url = (row.get("url") or "").strip()
            if set(row) != {"name", "url"} or not re.fullmatch(r"[a-z_][a-z0-9_]*", name):
                raise ValueError(f"Invalid dataset name or CSV fields on line {line}.")
            if name in names or not url or "\0" in url:
                raise ValueError(f"Duplicate dataset name or missing/invalid URL on line {line}.")
            names.add(name)
            datasets.append((name, url))
    if not datasets:
        raise ValueError("Dataset CSV must contain at least one dataset.")
    return datasets


def fingerprint(path):
    if not path.exists():
        return None
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def require_checkpointed(path):
    if Path(f"{path}.wal").exists():
        raise RuntimeError(f"WAL file exists for {path}; close DuckDB and checkpoint it before rebuilding.")


def validate_catalog(conn, expected_names):
    actual_names = {
        row[0] for row in conn.execute(
            "SELECT view_name FROM duckdb_views() "
            "WHERE database_name = current_database() AND schema_name = 'main' AND NOT internal"
        ).fetchall()
    }
    if actual_names != set(expected_names):
        raise RuntimeError("Generated catalog does not contain exactly the expected views.")
    for name in expected_names:
        # Bind every view against its source without downloading all source rows.
        conn.execute(f'SELECT * FROM "{name}" LIMIT 0')


def build_catalog(csv_file="datasets.csv", db_file="data.duckdb"):
    datasets = read_datasets(csv_file)
    target = Path(db_file).absolute()
    if target.is_symlink():
        raise ValueError("Refusing to replace a catalog through a symbolic link.")
    require_checkpointed(target)
    original = fingerprint(target)
    # Use the same filesystem as the target so the final replacement is atomic.
    build_dir = Path(tempfile.mkdtemp(prefix=f".{target.name}-build-", dir=target.parent))
    candidate = build_dir / "candidate.duckdb"
    backup = None
    try:
        with duckdb.connect(str(candidate)) as conn:
            for name, url in datasets:
                escaped_url = url.replace("'", "''")
                conn.execute(f'CREATE VIEW "{name}" AS SELECT * FROM \'{escaped_url}\'')
            conn.execute("CHECKPOINT")
        # Reopen the fully closed file to verify what will actually be published.
        with duckdb.connect(str(candidate), read_only=True) as conn:
            validate_catalog(conn, [name for name, _ in datasets])
        require_checkpointed(candidate)
        require_checkpointed(target)
        if fingerprint(target) != original:
            raise RuntimeError("Working catalog changed during generation; refusing to replace it.")
        if original is not None:
            backup = build_dir / "previous.duckdb"
            shutil.copy2(target, backup)
            if fingerprint(backup) != original or fingerprint(target) != original:
                raise RuntimeError("Could not verify the previous catalog backup.")
        require_checkpointed(target)
        os.replace(candidate, target)
    except Exception as error:
        raise RuntimeError(
            f"Catalog was not replaced. Build files retained at {build_dir}. {error}"
        ) from error
    return target, build_dir, backup


def main():
    try:
        target, build_dir, backup = build_catalog()
    except Exception as error:
        raise SystemExit(f"Catalog generation failed: {error}") from error
    print(f"Catalog validated and published: {target}")
    if backup is not None:
        print(f"Previous catalog retained: {backup}")
    print(f"Build directory retained: {build_dir}. No automatic cleanup deletion is performed.")


if __name__ == "__main__":
    main()
