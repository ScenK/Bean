import { render } from "preact";
import { NotesWindow } from "./NotesWindow.js";

const root = document.getElementById("root");
if (root) render(<NotesWindow />, root);
