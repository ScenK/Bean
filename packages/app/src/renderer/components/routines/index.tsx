import { render } from "preact";
import { RoutinesWindow } from "./RoutinesWindow.js";

const root = document.getElementById("root");
if (root) render(<RoutinesWindow />, root);
