// packages/app/src/renderer/components/skills/index.tsx
import { render } from "preact";
import { SkillsWindow } from "./SkillsWindow.js";

const root = document.getElementById("root");
if (root) render(<SkillsWindow />, root);
