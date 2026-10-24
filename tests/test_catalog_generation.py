"""Catalog preservation checks using real DuckDB files and local Parquet sources.

Run: uv run --python 3.13 --with "duckdb>=1.5.6" python -m unittest discover -s tests -p test_catalog_generation.py -v
Test files are retained in a printed temporary directory, with no cleanup deletion.
"""
import csv
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import duckdb
import main as catalog


class CatalogGenerationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="carta-catalog-tests-"))
        print(f"Catalog test files retained at {cls.root}", flush=True)

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="case-", dir=self.root))
        self.target = self.directory / "data.duckdb"
        self.csv_file = self.directory / "datasets.csv"
        self.parquet = self.directory / "stops.parquet"
        with duckdb.connect(str(self.target)) as conn:
            conn.execute("CREATE TABLE previous AS SELECT 42 AS total")
        with duckdb.connect() as conn:
            literal = str(self.parquet).replace("'", "''")
            conn.execute(f"COPY (SELECT 4 AS route_id, 'Market' AS stop_name) TO '{literal}' (FORMAT PARQUET)")
        self.original = self.target.read_bytes()
        self.write_datasets([("stops", str(self.parquet))])

    def write_datasets(self, rows):
        with self.csv_file.open("w", encoding="utf-8", newline="") as output:
            writer = csv.writer(output)
            writer.writerow(["name", "url"])
            writer.writerows(rows)

    def assert_original_usable(self):
        self.assertEqual(self.target.read_bytes(), self.original)
        with duckdb.connect(str(self.target), read_only=True) as conn:
            self.assertEqual(conn.execute("SELECT total FROM previous").fetchone(), (42,))

    def test_success_replaces_only_after_retaining_a_verified_usable_backup(self):
        target, build_dir, backup = catalog.build_catalog(self.csv_file, self.target)
        self.assertEqual(target, self.target)
        self.assertEqual(backup.read_bytes(), self.original)
        self.assertTrue(build_dir.is_dir())
        with duckdb.connect(str(backup), read_only=True) as conn:
            self.assertEqual(conn.execute("SELECT * FROM previous").fetchone(), (42,))
        with duckdb.connect(str(target), read_only=True) as conn:
            self.assertEqual(conn.execute("SELECT * FROM stops").fetchone(), (4, "Market"))
            self.assertEqual(conn.execute("SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall(), [("stops",)])

    def test_first_build_creates_a_catalog_without_an_old_backup(self):
        target = self.directory / "first.duckdb"
        published, build_dir, backup = catalog.build_catalog(self.csv_file, target)
        self.assertIsNone(backup)
        self.assertTrue(build_dir.is_dir())
        with duckdb.connect(str(published), read_only=True) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM stops").fetchone(), (1,))
        self.assert_original_usable()

    def test_missing_dataset_list_preserves_the_prior_catalog(self):
        with self.assertRaises(FileNotFoundError):
            catalog.build_catalog(self.directory / "missing.csv", self.target)
        self.assert_original_usable()

    def test_command_line_failure_returns_nonzero_and_preserves_the_catalog(self):
        self.write_datasets([("stops", str(self.directory / "missing.parquet"))])
        result = subprocess.run(
            [sys.executable, str(Path(catalog.__file__).resolve())],
            cwd=self.directory, capture_output=True, text=True, timeout=30,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Catalog generation failed:", result.stderr)
        self.assertIn("Build files retained", result.stderr)
        self.assert_original_usable()

    def test_empty_list_invalid_headers_names_urls_and_duplicates_fail_before_build(self):
        cases = [
            "name,url\n",
            "name,wrong\nstops,somewhere\n",
            "name,url\ninvalid-name,somewhere\n",
            "name,url\nstops,\n",
            "name,url\nstops,somewhere\nstops,elsewhere\n",
            "name,url\nstops,somewhere,extra\n",
            "name,url\n\"x; DROP TABLE previous\",somewhere\n",
        ]
        for text in cases:
            with self.subTest(csv=text):
                self.csv_file.write_text(text, encoding="utf-8")
                with self.assertRaises(ValueError):
                    catalog.build_catalog(self.csv_file, self.target)
                self.assert_original_usable()
        self.assertEqual(list(self.directory.glob(".data.duckdb-build-*")), [])

    def test_failure_after_one_view_keeps_the_original_and_partial_candidate(self):
        self.write_datasets([("stops", str(self.parquet)), ("missing", str(self.directory / "missing.parquet"))])
        with self.assertRaisesRegex(RuntimeError, "Catalog was not replaced.*Build files retained"):
            catalog.build_catalog(self.csv_file, self.target)
        self.assert_original_usable()
        candidate = next(self.directory.glob(".data.duckdb-build-*/candidate.duckdb"))
        with duckdb.connect(str(candidate), read_only=True) as conn:
            self.assertEqual(conn.execute("SELECT * FROM stops").fetchone(), (4, "Market"))

    def test_invalid_parquet_preserves_the_original(self):
        bad_source = self.directory / "invalid.parquet"
        bad_source.write_text("not a parquet file", encoding="utf-8")
        self.write_datasets([("stops", str(bad_source))])
        with self.assertRaisesRegex(RuntimeError, "Catalog was not replaced"):
            catalog.build_catalog(self.csv_file, self.target)
        self.assert_original_usable()

    def test_reopened_catalog_validation_rejects_a_missing_view(self):
        validate = catalog.validate_catalog

        def remove_expected_view(conn, expected):
            conn.close()
            candidate = next(self.directory.glob(".data.duckdb-build-*/candidate.duckdb"))
            with duckdb.connect(str(candidate)) as altered:
                altered.execute('DROP VIEW "stops"')
            with duckdb.connect(str(candidate), read_only=True) as reopened:
                validate(reopened, expected)

        with patch.object(catalog, "validate_catalog", side_effect=remove_expected_view):
            with self.assertRaisesRegex(RuntimeError, "exactly the expected views"):
                catalog.build_catalog(self.csv_file, self.target)
        self.assert_original_usable()

    def test_reopened_catalog_validation_binds_each_view_against_its_source(self):
        validate = catalog.validate_catalog

        def break_view_source(conn, expected):
            # Corrupt a source without deleting it after CREATE VIEW has already succeeded.
            self.parquet.write_text("source changed during generation", encoding="utf-8")
            validate(conn, expected)

        with patch.object(catalog, "validate_catalog", side_effect=break_view_source):
            with self.assertRaisesRegex(RuntimeError, "Catalog was not replaced"):
                catalog.build_catalog(self.csv_file, self.target)
        self.assert_original_usable()

    def test_backup_failure_never_attempts_replacement(self):
        with patch.object(catalog.shutil, "copy2", side_effect=OSError("backup disk full")), patch.object(catalog.os, "replace") as replace:
            with self.assertRaisesRegex(RuntimeError, "backup disk full"):
                catalog.build_catalog(self.csv_file, self.target)
            replace.assert_not_called()
        self.assert_original_usable()

    def test_incorrect_backup_is_rejected_before_replacement(self):
        def corrupt_backup(source, destination):
            destination.write_bytes(b"incomplete backup")

        with patch.object(catalog.shutil, "copy2", side_effect=corrupt_backup), patch.object(catalog.os, "replace") as replace:
            with self.assertRaisesRegex(RuntimeError, "verify the previous catalog backup"):
                catalog.build_catalog(self.csv_file, self.target)
            replace.assert_not_called()
        self.assert_original_usable()

    def test_failed_atomic_replacement_preserves_original_backup_and_candidate(self):
        with patch.object(catalog.os, "replace", side_effect=PermissionError("catalog locked")):
            with self.assertRaisesRegex(RuntimeError, "catalog locked"):
                catalog.build_catalog(self.csv_file, self.target)
        self.assert_original_usable()
        backup = next(self.directory.glob(".data.duckdb-build-*/previous.duckdb"))
        candidate = backup.with_name("candidate.duckdb")
        self.assertEqual(backup.read_bytes(), self.original)
        with duckdb.connect(str(candidate), read_only=True) as conn:
            self.assertEqual(conn.execute("SELECT * FROM stops").fetchone(), (4, "Market"))

    def test_working_catalog_changes_during_build_are_not_overwritten(self):
        validate = catalog.validate_catalog

        def change_working_catalog(conn, expected):
            validate(conn, expected)
            with duckdb.connect(str(self.target)) as updated:
                updated.execute("UPDATE previous SET total = 71")

        with patch.object(catalog, "validate_catalog", side_effect=change_working_catalog):
            with self.assertRaisesRegex(RuntimeError, "changed during generation"):
                catalog.build_catalog(self.csv_file, self.target)
        with duckdb.connect(str(self.target), read_only=True) as conn:
            self.assertEqual(conn.execute("SELECT total FROM previous").fetchone(), (71,))

    def test_existing_wal_refuses_generation_without_touching_the_original(self):
        exists = Path.exists

        def wal_exists(path):
            return str(path) == f"{self.target}.wal" or exists(path)

        with patch.object(Path, "exists", wal_exists):
            with self.assertRaisesRegex(RuntimeError, "WAL file exists"):
                catalog.build_catalog(self.csv_file, self.target)
        self.assert_original_usable()
        self.assertEqual(list(self.directory.glob(".data.duckdb-build-*")), [])

    def test_quoted_source_paths_are_literal_and_remain_queryable(self):
        quoted_source = self.directory / "stop's.parquet"
        quoted_source.write_bytes(self.parquet.read_bytes())
        self.write_datasets([("stops", str(quoted_source))])
        target, _, _ = catalog.build_catalog(self.csv_file, self.target)
        with duckdb.connect(str(target), read_only=True) as conn:
            self.assertEqual(conn.execute("SELECT stop_name FROM stops").fetchone(), ("Market",))

    def test_repeated_builds_retain_separate_backups(self):
        _, first_dir, first_backup = catalog.build_catalog(self.csv_file, self.target)
        first_published = self.target.read_bytes()
        _, second_dir, second_backup = catalog.build_catalog(self.csv_file, self.target)
        self.assertNotEqual(first_dir, second_dir)
        self.assertEqual(first_backup.read_bytes(), self.original)
        self.assertEqual(second_backup.read_bytes(), first_published)
        self.assertTrue(first_dir.is_dir() and second_dir.is_dir())


if __name__ == "__main__":
    unittest.main()
