import type { World } from "./world.ts";

// A source drives the World from some agent backend (scripted fake, Hermes, ...).
export interface Source {
  readonly name: string;
  start(world: World): Promise<void>;
  createMission(title: string): Promise<void>;
  resolveApproval(id: string, approved: boolean): Promise<void>;
  cancelMission(): Promise<void>;
  stop(): Promise<void>;
  layoutChanged?(layout: import("./layout.ts").BaseLayout): Promise<void>;
}
