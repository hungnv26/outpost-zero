extends RefCounted

# Sectors on screen, departments in the code: they organise the base: every building belongs to one (its capability; Human
# Approval sits with Command) and every character to its home building's. The map is a
# 3x3 grid of districts split by streets. Mirrors DEPARTMENTS/DISTRICTS in adapter/src/layout.ts.
#
#   Science       | Quarters (Rally Point) | Industry
#   Science       | Command + Oversight    | Industry
#   Life Support  | Life Support           | Quarters (Repair Bay)
# The keys (command, research, code, knowledge, meeting) are the Hermes capabilities and stay;
# only the names on screen are the colony's sectors.

const ORDER = ["command", "research", "code", "knowledge", "meeting"]
const NAMES = {"command": "Command", "research": "Science", "code": "Industry", "knowledge": "Life Support", "meeting": "Quarters"}
const COLORS = {
	"command": Color("#b48cff"), "research": Color("#4fb3ff"), "code": Color("#ff9940"),
	"knowledge": Color("#5fd98a"), "meeting": Color("#ff7fae"),
}
const WORK = {
	"command": "MOTHER's core; the Warden waits for your decisions here",
	"research": "The lab, the dish and the dig: expeditions and research",
	"code": "Power, water, salvage and parts: the colony's machinery",
	"knowledge": "Hydroponics and medicine: what keeps the colonists alive",
	"meeting": "The lander, the cryo pods, habitats, storage, the muster and repair spots",
}
const DISTRICTS = [
	["research", "meeting", "code"],
	["research", "command", "code"],
	["knowledge", "knowledge", "meeting"],
]
const MAP_SIZE = 44.0
const CELL = 14.0  # 2x2 building slots, 7 apart
const STREETS = [15.0, 29.0]  # x and z of the streets between districts


static func of(capability: String) -> String:
	return "command" if capability == "approval" else capability


static func of_building(layout: Dictionary, building_id: String) -> String:
	for b in layout.get("buildings", []):
		if b["id"] == building_id:
			return of(b["capability"])
	return "command"


static func cell_centre(col: int, row: int) -> Vector3:
	return Vector3(1.0 + CELL * 0.5 + col * CELL, 0, 1.0 + CELL * 0.5 + row * CELL)


static func centre(dept: String) -> Vector3:
	var sum = Vector3.ZERO
	var n = 0
	for r in 3:
		for c in 3:
			if DISTRICTS[r][c] == dept:
				sum += cell_centre(c, r)
				n += 1
	return sum / max(1, n)
