"""Offline contract tests; these tests never connect to Kafka or StarRocks."""
import copy
from decimal import Decimal
import unittest

import cdc_fixture as fixture


class CdcFixtureTest(unittest.TestCase):
    def test_namespaces_reject_real_business_resources(self):
        fixture.validate_namespace("flink23-test-java_001", "flink23_test_java_001")
        for topic, database in (
            ("flink-food-lab-fake-data-260904-cdc", "flink23_test_x"),
            ("flink23-test-x", "flink_food_lab_warehouse"),
            ("flink23-test-x", "flink23_test_x`;DROP DATABASE x"),
        ):
            with self.assertRaises(ValueError):
                fixture.validate_namespace(topic, database)

    def test_duplicate_cdc_and_mutations_preserve_exact_expected_current_orders(self):
        phases = fixture.fixture()
        self.assertEqual(phases, fixture.fixture())
        expected = fixture.expected_state(phases, 3)
        self.assertEqual({"T01": "16.25", "T02": "7.00", "S01": "9.50", "S02": "12.50"},
                         expected["cumulative"])
        self.assertNotIn(3, {order["order_id"] for order in expected["orders"]})
        self.assertEqual(phases[0]["events"][0], phases[0]["events"][1])
        self.assertEqual(phases[1]["events"][0], phases[1]["events"][1])
        self.assertEqual(phases[1]["events"][-1], phases[1]["events"][-2])
        for phase in phases:
            for event in phase["events"]:
                if event["op"] == "u":
                    self.assertEqual(event["before"]["created_at"], event["after"]["created_at"])

    def test_advance_and_expiry_have_distinct_deterministic_window_expectations(self):
        advance = fixture.expected_state(fixture.fixture(), 3)
        self.assertEqual(fixture.BASE_MS + 15_000, advance["latest_window_end_ms"])
        active = fixture.window_values(advance["orders"], advance["latest_window_start_ms"], advance["latest_window_end_ms"])
        self.assertEqual({"order_count": 2, "total_amount": Decimal("16.25")}, active["T01"])
        self.assertEqual({"order_count": 1, "total_amount": Decimal("6.50")}, active["S02"])
        expired = fixture.expected_state(fixture.fixture(), 4)
        self.assertEqual(fixture.BASE_MS + 325_000, expired["latest_window_end_ms"])
        values = fixture.window_values(expired["orders"], expired["latest_window_start_ms"], expired["latest_window_end_ms"])
        self.assertTrue(all(value == {"order_count": 0, "total_amount": Decimal("0.00")} for value in values.values()))
        self.assertEqual("21.75", expired["cumulative"]["T01"])
        # At least one real CDC envelope must instantiate the final empty window.
        self.assertTrue(any(expired["latest_window_start_ms"] <= fixture.epoch_ms((event["after"] or event["before"])["created_at"])
                            < expired["latest_window_end_ms"] for event in fixture.fixture()[3]["events"]))

    def test_assertion_detects_stale_shop_window_and_duplicate_revenue(self):
        expected = fixture.expected_state(fixture.fixture(), 4)
        data = {"expected": expected, "topic": "flink23-test-x", "database": "flink23_test_x", "completed_phases": 4}
        cumulative = [{"shop_id": shop, "total_revenue": Decimal(amount)}
                      for shop, amount in expected["cumulative"].items()]
        recent = [{"shop_id": shop, "window_start_ms": expected["latest_window_start_ms"],
                   "window_end_ms": expected["latest_window_end_ms"], "order_count": 0,
                   "total_amount": Decimal("0.00")} for shop in fixture.SHOPS]
        self.assertEqual("PASS", fixture.compare(data, cumulative, recent)["result"])
        stale = copy.deepcopy(recent)
        stale[0]["window_end_ms"] -= 5000
        with self.assertRaises(AssertionError):
            fixture.compare(data, cumulative, stale)
        duplicate = copy.deepcopy(cumulative)
        duplicate[0]["total_revenue"] += Decimal("10.00")
        with self.assertRaises(AssertionError):
            fixture.compare(data, duplicate, recent)

    def test_late_phase_changes_cumulative_but_not_closed_window(self):
        before = fixture.expected_state(fixture.fixture(), 4)
        after = fixture.expected_state(fixture.fixture(), 5)
        self.assertEqual("15.25", after["cumulative"]["S01"])
        self.assertEqual(before["latest_window_end_ms"], after["latest_window_end_ms"])
        self.assertEqual(fixture.window_values(before["orders"], before["latest_window_start_ms"], before["latest_window_end_ms"]),
                         fixture.window_values(after["orders"], after["latest_window_start_ms"], after["latest_window_end_ms"]))


if __name__ == "__main__":
    unittest.main()
