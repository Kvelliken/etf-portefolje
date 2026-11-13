# Lokale kommandoer. Krever Python 3.11+ og `pip install -r requirements.txt`.
PY ?= python

.PHONY: install test nordnet nordnet-test prices universe site all serve local-nordnet fond fond-risk fond-test fond-probe

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

site:               ## sidedata: ETF-liste med sektor/tema, månedsavkastning og risikofri rente
	$(PY) scripts/build_site.py

all: nordnet prices universe site

serve:              ## vis siden på http://localhost:8000
	$(PY) -m http.server -d site 8000

local-nordnet:      ## fallback: hent Nordnet lokalt, push databasen og start Actions med skip_nordnet
	./scripts/local_nordnet.sh

fond:               ## hent fondslisten fra Nordnet til data/fond.db
	$(PY) scripts/fetch_nordnet.py --fond

fond-risk:          ## risikotall per fond (volatilitet, Sharpe, alfa, beta, R²) til data/fond.db
	$(PY) scripts/fetch_fund_details.py

fond-test:          ## én side av fondslisten til en midlertidig database, med feltrapport
	$(PY) scripts/fetch_nordnet.py --fond --max-pages 1 --db /tmp/fond-test.db
	$(PY) scripts/fetch_nordnet.py --fond --from-file $$(ls -d data/raw_fond/*/ | tail -1)page_001.html.gz

fond-probe:         ## mål Yahoo-dekning og andelsklassekontroll for et utvalg fond
	$(PY) scripts/probe_fund_history.py
