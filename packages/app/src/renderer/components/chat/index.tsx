import { render } from "preact";
import { ChatWindow } from "./ChatWindow.js";

const root = document.getElementById("root");
if (root) render(<ChatWindow />, root);
