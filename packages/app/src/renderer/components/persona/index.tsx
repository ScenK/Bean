// packages/app/src/renderer/components/persona/index.tsx
import { render } from "preact";
import { PersonaWindow } from "./PersonaWindow.js";

const root = document.getElementById("root");
if (root) render(<PersonaWindow />, root);
