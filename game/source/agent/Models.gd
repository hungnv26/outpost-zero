extends RefCounted

# Where every model name used in the base layout comes from, and how to load it. Names
# mirror BUILDING_MODELS / VEHICLE_MODELS in adapter/src/layout.ts.
#   Kenney Space Kit (CC0)          assets/models/kenney-spacekit/<name>.glb
#   KayKit Space Base Bits (CC0)    assets/models/kaykit-spacebase/<name>.gltf
#   Quaternius Ultimate Space Kit   assets/models/quaternius-space/<name>.glb (CC0)
#   Open RTS geometry / composites  see Composites.gd

const KENNEY = "res://assets/models/kenney-spacekit/"
const KAYKIT = "res://assets/models/kaykit-spacebase/"
const QUATERNIUS = "res://assets/models/quaternius-space/"
const COMMAND_CENTRE_SCENE = "res://source/match/units/structure-geometries/CommandCenter.tscn"

const KAYKIT_BUILDINGS = [
	"basemodule_A", "basemodule_B", "basemodule_C", "basemodule_D", "basemodule_E", "basemodule_garage",
	"cargodepot_A", "cargodepot_B", "cargodepot_C", "drill_structure", "lander_A", "lander_B",
	"landingpad_large", "structure_low", "structure_tall", "windturbine_tall", "containers_A", "solarpanel",
]
const QUATERNIUS_BUILDINGS = [
	"GeodesicDome", "BaseLarge", "BuildingL", "HouseCylinder", "HouseLong", "HouseSingle", "SolarPanelStructure",
]
# Animated characters (they walk, work and wave instead of driving).
const CHARACTERS = [
	"Astronaut_A", "Astronaut_B", "Astronaut_C", "Mech_A", "Mech_B", "Mech_C", "Mech_D",
	"EnemyLarge", "EnemySmall", "EnemyFlying",
]
const QUATERNIUS_VEHICLES = ["Rover_A", "RoundRover"]
const COMPOSITES = {
	"VehicleFactory": "composite:vehicle_factory",
	"AircraftFactory": "composite:aircraft_factory",
	"AntiGroundTurret": "composite:anti_ground_turret",
	"AntiAirTurret": "composite:anti_air_turret",
	"Rocket": "composite:rocket",
	"Tank": "composite:tank",
	"MonorailTrain": "composite:monorail_train",
}


static func path(model_name: String) -> String:
	if model_name == "CommandCenter":
		return COMMAND_CENTRE_SCENE
	if COMPOSITES.has(model_name):
		return COMPOSITES[model_name]
	if model_name in KAYKIT_BUILDINGS:
		return KAYKIT + model_name + ".gltf"
	if model_name in QUATERNIUS_BUILDINGS or model_name in CHARACTERS or model_name in QUATERNIUS_VEHICLES:
		return QUATERNIUS + model_name + ".glb"
	return KENNEY + model_name + ".glb"


static func is_character(model_name: String) -> bool:
	return model_name in CHARACTERS


# Display name in the Build menu.
static func label(model_name: String) -> String:
	return model_name.replace("craft_", "").replace("_", " ")
