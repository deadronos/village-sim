"""Static village content: places, roles, prices, production."""

KEV_URL = "http://127.0.0.1:8009/v1/systemone"
KEV_MODEL = "kev-latest"

TICK_MINUTES = 20
DAY_START = 6 * 60
DAY_END = 22 * 60

PLACES = {
    "well": "the well",
    "bakery": "the bakery",
    "tavern": "the tavern",
    "market": "the market square",
    "fields": "the wheat fields",
    "woods": "the woods",
    "smithy": "the smithy",
    "garden": "the herb garden",
}

PRICES = {"wheat": 4, "bread": 4, "stew": 7, "wood": 4, "herbs": 3, "water": 0}

FOOD_VALUE = {"bread": 0.5, "stew": 0.7}

ROSTER = [
    {"name": "anna", "title": "baker", "workplace": "bakery", "sells": "bread", "wage": 0},
    {"name": "bram", "title": "blacksmith", "workplace": "smithy", "sells": None, "wage": 5},
    {"name": "cilla", "title": "guard", "workplace": "market", "sells": None, "wage": 8},
    {"name": "dorn", "title": "farmer", "workplace": "fields", "sells": "wheat", "wage": 0},
    {"name": "elin", "title": "child", "workplace": None, "sells": None, "wage": 0},
    {"name": "fenn", "title": "innkeeper", "workplace": "tavern", "sells": "stew", "wage": 0},
    {"name": "gus", "title": "woodcutter", "workplace": "woods", "sells": "wood", "wage": 0},
    {"name": "hale", "title": "herbalist", "workplace": "garden", "sells": "herbs", "wage": 0},
]


def home_of(name: str) -> str:
    return f"home_{name}"


def place_name(place: str) -> str:
    if place in PLACES:
        return PLACES[place]
    if place.startswith("home_"):
        return f"home of {place[5:]}"
    return place
