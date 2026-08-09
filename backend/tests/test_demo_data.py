from scripts.generate_demo_data import is_injected_anomaly


def test_small_profiles_always_include_a_latest_day_anomaly():
    assert is_injected_anomaly(store_index=1, day_offset=0)
    assert not is_injected_anomaly(store_index=1, day_offset=1)
