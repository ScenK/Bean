import { render } from "preact";
import { ProjectsWindow } from "./ProjectsWindow.js";

const root = document.getElementById("root");
if (root) render(<ProjectsWindow />, root);
