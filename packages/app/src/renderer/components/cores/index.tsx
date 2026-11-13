import { render } from "preact";
import { CoresWindow } from "./CoresWindow.js";

const root = document.getElementById("root");
if (root) render(<CoresWindow />, root);
