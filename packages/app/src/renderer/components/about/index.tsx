import { render } from "preact";
import { AboutWindow } from "./AboutWindow.js";

const root = document.getElementById("root");
if (root) render(<AboutWindow />, root);
