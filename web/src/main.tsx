import { createRoot } from "react-dom/client";
import { App } from "./App";
import { captureSetupToken } from "./passkeys";
import "./styles.css";

captureSetupToken(); // before anything renders: take the setup token out of the address bar
createRoot(document.getElementById("root")!).render(<App />);
