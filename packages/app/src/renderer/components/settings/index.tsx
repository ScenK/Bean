import { render } from "preact";
import { SettingsWindow } from "./SettingsWindow.js";

const root = document.getElementById("root");
if (root) render(<SettingsWindow />, root);
