// packages/app/src/renderer/components/plan/index.tsx
import { render } from "preact";
import { PlanWindow } from "./PlanWindow.js";

const root = document.getElementById("root");
if (root) render(<PlanWindow />, root);
