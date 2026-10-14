import type { ClientCommand } from "./contract.ts";
import {
  type BaseLayout,
  cloneLayout,
  DEFAULT_LAYOUT,
  LayoutError,
  moveSpot,
  organiseLayout,
  removeAgent,
  removeBuilding,
  saveLayout,
  setTerrain,
  upsertAgent,
  upsertBuilding,
} from "./layout.ts";
import type { Source } from "./source.ts";
import type { World } from "./world.ts";

export type LayoutCommand = Extract<ClientCommand, { type: `layout.${string}` }>;

export function isLayoutCommand(cmd: ClientCommand): cmd is LayoutCommand {
  return cmd.type.startsWith("layout.");
}

// Applies Build-mode edits: validate on a copy, then adopt it in the world, save it to
// disk and let the source sync (Hermes creates/removes the matching sub-agents).
export class Base {
  private world: World;
  private source: Source;
  private path: string | null;

  constructor(world: World, source: Source, path: string | null) {
    this.world = world;
    this.source = source;
    this.path = path;
  }

  async apply(cmd: LayoutCommand): Promise<void> {
    const status = this.world.getMission()?.status;
    // Terrain is only looks, so it may change mid-mission; structural edits may not.
    if ((status === "planning" || status === "running") && cmd.type !== "layout.terrain") {
      throw new LayoutError("Finish or abort the current mission before changing the base.");
    }
    const next: BaseLayout = cmd.type === "layout.reset" ? cloneLayout(DEFAULT_LAYOUT) : cloneLayout(this.world.layout);
    switch (cmd.type) {
      case "layout.building.upsert":
        upsertBuilding(next, cmd.building);
        break;
      case "layout.building.remove":
        removeBuilding(next, cmd.id);
        break;
      case "layout.spot.move":
        moveSpot(next, cmd.id, cmd.x, cmd.z);
        break;
      case "layout.agent.upsert":
        upsertAgent(next, cmd.agent);
        break;
      case "layout.agent.remove":
        removeAgent(next, cmd.id);
        break;
      case "layout.terrain":
        setTerrain(next, cmd.terrain);
        break;
      case "layout.organise":
        organiseLayout(next);
        break;
      case "layout.reset":
        break;
    }
    this.world.applyLayout(next);
    if (this.path) saveLayout(this.path, next);
    await this.source.layoutChanged?.(next);
  }
}
