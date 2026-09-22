import { render } from "preact";
import { DashboardWindow } from "./DashboardWindow.js";

const root = document.getElementById("root");
if (root) render(<DashboardWindow />, root);
