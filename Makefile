# Lokale kommandoer. Krever Python 3.11+ og `pip install -r requirements.txt`.
PY ?= python

.PHONY: install test nordnet nordnet-test prices universe site all serve local-nordnet

install:
	$(PY) -m pip install -r requirements.txt

test:
	$(PY) -m pytest -q

nordnet:            ## hent hele ETF-listen fra Nordnet til data/etf.db
	$(PY) scripts/fetch_nordnet.py

nordnet-test:       ## én side (100 ETF-er) til en midlertidig database
	$(PY) scripts/fetch_nordnet.py --max-pages 1 --db /tmp/etf-test.db --no-raw

prices:             ## ticker-mapping og priser i NOK
	$(PY) scripts/build_prices.py

universe:           ## dedup, TE-klynging og representantvalg
	$(PY) scripts/build_universe.py

site:               ## optimering, bootstrap, backtest og site/data/*.json
	$(PY) scripts/build_site.py

all: nordnet prices universe site

serve:              ## vis siden på http://localhost:8000
	$(PY) -m http.server -d site 8000

local-nordnet:      ## fallback: hent Nordnet lokalt, push databasen og start Actions med skip_nordnet
	./scripts/local_nordnet.sh
