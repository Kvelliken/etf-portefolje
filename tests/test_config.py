from etfpf.config import load_config


def test_country_codes_are_strings():
    """YAML 1.1 reads an unquoted NO as false ("the Norway problem")."""
    countries = load_config()["account"]["ask_countries"]
    assert all(isinstance(c, str) and len(c) == 2 for c in countries)
    assert "NO" in countries and "SE" in countries
