import type { InteractionDockController, ScreenController } from "../shell";

export function createThreadScreen(dock: InteractionDockController): ScreenController {
  return {
    id: "thread",
    activate(): void {
      dock.setState({
        surface: "text-composer",
        mode: "thread",
        supportsPicker: true,
      });
    },
    deactivate(): void {},
    close(): void {},
    requestRender(): void {
      dock.refresh();
    },
  };
}
