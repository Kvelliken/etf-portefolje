"""Rule-based classification of ETFs for the explorer filters.

Nordnet gives a Morningstar-style category (e.g. "Technology Sector Equity", "Global Equity Large Cap")
and a fund type (Aksje/Rente/Kombi/Øvrig). From these and the fund name we derive:

  asset_class  Aksjer, Renter, Pengemarked, Råvarer, Blandet, Opsjonsstrategi, Giret/invers, Alternativ
  region       Global, USA, Europa, Norden, UK, Japan, Fremvoksende, Asia, Kina, India, ...
  sector       Teknologi, Helse, Finans, ... (equities); Stat, Selskap, High yield, ... (bonds); Bred (no sector)
  theme        finer theme from the name (Biotek, Halvledere, Ren energi, Forsvar, ...), or None
  style        Markedsvektet, Utbytte, Verdi, Vekst, Kvalitet, Momentum, Lav volatilitet, Likevektet,
               Multifaktor, Små/mellomstore, Aktiv, Opsjonsinntekt
  esg          True when the name signals an ESG/climate/screened index

Names are only used for labels that the category does not carry; the rules are deliberately simple
and listed in order (first match wins), so they are easy to audit and extend.
"""
import re

SECTOR_FROM_CATEGORY = {
    "Technology Sector Equity": "Teknologi",
    "Healthcare Sector Equity": "Helse",
    "Financials Sector Equity": "Finans",
    "Energy Sector Equity": "Energi",
    "Industrials Sector Equity": "Industri",
    "Consumer Goods & Services Sector Equity": "Forbruk",
    "Communications Sector Equity": "Kommunikasjon",
    "Utilities Sector Equity": "Forsyning",
    "Real Estate Sector Equity": "Eiendom",
    "Natural Resources Sector Equity": "Råvarer og materialer",
    "Precious Metals Sector Equity": "Edelmetaller (gruver)",
    "Infrastructure Sector Equity": "Infrastruktur",
}

# Sector from the name, for broad categories (e.g. "Global Equity Large Cap" holding a sector index).
SECTOR_FROM_NAME = [
    (r"health ?care|pharma|biotech|genomic|medical|healthcare|bio ?revolution|bionic", "Helse"),
    (r"information tech|\btech(nology)?\b|semiconductor|software|cyber|internet|robot|cloud|quantum|blockchain|metaverse|data cent", "Teknologi"),
    (r"\bbanks?\b|financ|insurance|fintech", "Finans"),
    (r"oil|\bgas\b|energy(?! transition)|uranium|nuclear", "Energi"),
    (r"industrials?\b(?! average)|aerospace|defen[cs]e|transport", "Industri"),
    (r"consumer|retail|luxury|food|agri|beverage", "Forbruk"),
    (r"communication|media|telecom", "Kommunikasjon"),
    (r"utilit|water", "Forsyning"),
    (r"real estate|reit|property|propert", "Eiendom"),
    (r"materials|mining|miners|metals|natural resources|timber|lithium", "Råvarer og materialer"),
    (r"infrastructure", "Infrastruktur"),
    (r"private equity", "Private equity"),
]

THEMES = [
    (r"biotech|genomic|bio ?revolution", "Biotek"),
    (r"medical device|medtech|healthcare innovation|digital health|telemedicine|bionic|health ?tech", "Medisinsk teknologi"),
    (r"semiconductor|\bchips?\b|memory|photonic", "Halvledere"),
    (r"cyber ?security|cyber", "Cybersikkerhet"),
    (r"quantum", "Kvantedata"),
    (r"^(?!.*(enhanced|optimi[sz]ed)).*(\bai\b|artificial intelligence|machine learning)", "Kunstig intelligens"),
    (r"robot|automation|humanoid|drone", "Robotikk og automatisering"),
    (r"cloud|data cent|software|saas|internet|e-?commerce|digital (econ|transf|infra)", "Sky, programvare og internett"),
    (r"blockchain|bitcoin|crypto|digital assets", "Blokkjede og krypto"),
    (r"defen[cs]e|aerospace|military", "Forsvar"),
    (r"\bspace\b|new space", "Romfart"),
    (r"uranium|nuclear", "Uran og kjernekraft"),
    (r"hydrogen", "Hydrogen"),
    (r"clean energy|renewable|solar|wind|cleantech|clean tech|new energy|alternative energy|energy transition|green energy", "Ren energi"),
    (r"battery|lithium|electric vehicle|\bev\b|mobility|autonomous", "Batteri og elbil"),
    (r"water", "Vann"),
    (r"food|agri|agtech", "Mat og landbruk"),
    (r"gaming|esports|metaverse|entertainment", "Spill og underholdning"),
    (r"fintech|digital payment|payments", "Fintech"),
    (r"gold miner|gold producer|junior gold|silver miner|precious metal", "Gull- og sølvgruver"),
    (r"ageing|aging|longevity|demograph", "Aldrende befolkning"),
    (r"luxury", "Luksus"),
    (r"\bbanks?\b", "Banker"),
    (r"oil|\bgas\b", "Olje og gass"),
    (r"innovation|megatrend|disrupt|future|next gen|transformational", "Innovasjon og megatrender"),
]

STYLES = [
    (r"premium income|covered call|option income|buy ?write|yieldmax|income & growth", "Opsjonsinntekt"),
    (r"equal weight|equal-weight|\bew\b", "Likevektet"),
    (r"min(imum)? ?vol|low vol", "Lav volatilitet"),
    (r"multi-?factor|factor", "Multifaktor"),
    (r"momentum", "Momentum"),
    (r"quality", "Kvalitet"),
    (r"dividend|high yield equity|income|aristocrat", "Utbytte"),
    (r"\bvalue\b", "Verdi"),
    (r"\bgrowth\b", "Vekst"),
    (r"small ?cap|small-cap|smallcap|mid ?cap|mid-cap|midcap|small & mid|\bsmid\b|\bmid\b|\bsmall\b", "Små/mellomstore"),
    (r"\bactive\b|enhanced|research enhanced", "Aktiv"),
]

ESG_RE = re.compile(r"\besg\b|\bsri\b|paris|\bpab\b|\bctb\b|climate|sustainab|screened|responsible|"
                    r"esg leaders|transition|low carbon|ex fossil|fossil fuel|\bsdg\b|green|impact", re.I)

# Region from category (exact) and from name (ordered: specific before general).
REGION_FROM_CATEGORY = {
    "Global Equity Large Cap": "Global", "Global Equity Mid/Small Cap": "Global", "Global Fixed Income": "Global",
    "Europe Equity Large Cap": "Europa", "Europe Equity Mid/Small Cap": "Europa", "Europe Fixed Income": "Europa",
    "Euro Money Market": "Europa",
    "US Equity Large Cap Blend": "USA", "US Equity Large Cap Growth": "USA", "US Equity Large Cap Value": "USA",
    "US Equity Small Cap": "USA", "US Equity Mid Cap": "USA", "US Fixed Income": "USA",
    "UK Equity Large Cap": "UK", "UK Equity Mid/Small Cap": "UK", "Sterling Fixed Income": "UK",
    "Japan Equity": "Japan", "Japan Fixed Income": "Japan",
    "Global Emerging Markets Equity": "Fremvoksende", "Emerging Markets Fixed Income": "Fremvoksende",
    "Europe Emerging Markets Equity": "Fremvoksende",
    "Asia ex-Japan Equity": "Asia", "Asia Equity": "Asia", "Asia Fixed Income": "Asia",
    "Greater China Equity": "Kina", "India Equity": "India", "India Fixed Income": "India",
    "Korea Equity": "Korea", "Latin America Equity": "Latin-Amerika", "Mexico Equity": "Latin-Amerika",
    "Africa Equity": "Midtøsten og Afrika", "Thailand Equity": "Asia",
    "Australia & New Zealand Equity": "Australia/NZ", "Australia & New Zealand Fixed Income": "Australia/NZ",
    "Canadian Equity Large Cap": "Canada",
}
REGION_FROM_NAME = [
    (r"emerging|\bem\b|frontier", "Fremvoksende"),
    (r"nordic|norway|norge|\bobx\b|sweden|omx|denmark|finland", "Norden"),
    (r"ex[- ]?(usa?|u\.s\.)\b", "Global"),
    (r"ex[- ]?japan", "Asia"),
    (r"indo-?pac", "Asia"),
    (r"europe.*ex[- ]?uk", "Europa"),
    (r"(?<!ex-)(?<!ex )china|chinese|hang seng|\bcsi\b", "Kina"),
    (r"india|nifty", "India"),
    (r"korea", "Korea"),
    (r"taiwan", "Taiwan"),
    (r"japan|topix|nikkei", "Japan"),
    (r"saudi|turkey|pakistan|israel|middle east|africa|gcc|uae|qatar|kuwait", "Midtøsten og Afrika"),
    (r"brazil|\blatin|mexico|\bchile\b|argentin", "Latin-Amerika"),
    (r"asia|pacific|asean|vietnam|indonesia|thailand|singapore|malaysia|philippin", "Asia"),
    (r"\buk\b|ftse 100|ftse 250|united kingdom|britain|gilt|sterling", "UK"),
    (r"canada|canadian|tsx", "Canada"),
    (r"australia", "Australia/NZ"),
    (r"world|global|acwi|all[- ]world|all country|international|\bgbl\b", "Global"),
    (r"europe|euro ?stoxx|stoxx 600|\bemu\b|eurozone|euro area|germany|\bdax\b|france|\bcac\b|"
     r"italy|spain|ibex|netherlands|switzerland|\bsmi\b|greece|poland|austria|belgium|portugal|ireland", "Europa"),
    (r"s&p ?500|\busa?\b|u\.s\.|nasdaq|russell|dow jones (us|industrial)|america|\bspdr s&p\b|\bselect sector\b", "USA"),
]

BOND_SEGMENTS = [
    (r"high yield|\bhy\b|fallen angel", "High yield"),
    (r"inflation|linker|\btips\b|\bilb\b", "Inflasjonssikret"),
    (r"corporate|corp\b|\bcorp |credit|\bibonds?\b.*corp", "Selskapsobligasjoner"),
    (r"treasury|treasuries|government|govt|gilt|bund|sovereign|\bbtp\b|\boat\b|state|t-bill|bills", "Statsobligasjoner"),
    (r"covered|pfandbrief", "OMF/covered bonds"),
    (r"floating|frn|float", "Flytende rente"),
    (r"aggregate|\bagg\b|core bond|broad|universal", "Bred rente"),
]


def _first(rules, text, default=None):
    for pat, lab in rules:
        if re.search(pat, text, re.I):
            return lab
    return default


def asset_class(category, fund_type, name=""):
    c = category or ""
    if c == "Trading Tools":
        return "Giret/invers"
    if c == "Options Trading":
        return "Opsjonsstrategi"
    if "Money Market" in c:
        return "Pengemarked"
    if c.startswith("Commodities"):
        return "Råvarer"
    if "Fixed Income" in c or c == "Convertibles":
        return "Renter"
    if "Allocation" in c or c == "Target Date":
        return "Blandet"
    if c in ("Market Neutral", "Alternative Miscellaneous"):
        return "Alternativ"
    if "Equity" in c:
        return "Aksjer"
    ft = (fund_type or "").lower()
    return {"aksje": "Aksjer", "rente": "Renter", "kombi": "Blandet"}.get(ft, "Alternativ")


def region(category, name):
    reg = REGION_FROM_CATEGORY.get(category or "")
    # Global categories still contain country funds etc. only via the name, so check the name first
    # for the categories that are not regional (sector, misc, commodities, options, allocation).
    by_name = _first(REGION_FROM_NAME, name or "")
    if reg is None:
        return by_name or "Global"
    if reg == "Global" and by_name in ("Fremvoksende",):   # e.g. "Global Emerging ..." in a global category
        return by_name
    return reg


def sector(category, name, aclass):
    if aclass == "Renter":
        if "Emerging" in (category or ""):
            return "Fremvoksende markeder (rente)"
        return _first(BOND_SEGMENTS, name or "", "Annen rente")
    if aclass != "Aksjer":
        return aclass
    s = SECTOR_FROM_CATEGORY.get(category or "")
    if s:
        return s
    return _first(SECTOR_FROM_NAME, name or "", "Bred")


def theme(name, aclass):
    if aclass not in ("Aksjer",):
        return None
    return _first(THEMES, name or "")


def style(name, category, aclass):
    if aclass not in ("Aksjer", "Opsjonsstrategi"):
        return None
    s = _first(STYLES, name or "")
    c = category or ""
    if s is None:
        if "Growth" in c:
            s = "Vekst"
        elif "Value" in c:
            s = "Verdi"
        elif "Mid/Small" in c or "Small Cap" in c or "Mid Cap" in c:
            s = "Små/mellomstore"
    if aclass == "Opsjonsstrategi" and s is None:
        s = "Opsjonsinntekt"
    return s or "Markedsvektet"


def is_esg(name):
    return bool(ESG_RE.search(name or ""))


def classify(name, category, fund_type):
    """dict with asset_class, region, sector, theme, style, esg."""
    ac = asset_class(category, fund_type, name)
    return {"asset_class": ac, "region": region(category, name), "sector": sector(category, name, ac),
            "theme": theme(name, ac), "style": style(name, category, ac), "esg": is_esg(name)}
